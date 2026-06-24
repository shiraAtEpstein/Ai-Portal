// ============================================================
// db.js — PostgreSQL (Neon) connection + helpers
// Phase 2 (auth & connections) + Day 5 (database-backed sessions).
// Safe to load even when DATABASE_URL is unset: every helper degrades
// gracefully so the app keeps running with no database.
// ============================================================
const { Pool } = require('pg');

let pool = null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sslFor(url) {
  if (!url) return false;
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// Strip sslmode / channel_binding so newer pg versions don't print the
// "SSL modes ... treated as aliases" deprecation warning. SSL is set
// explicitly via the `ssl` option instead.
function stripSslParams(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('channel_binding');
    return u.toString();
  } catch (_) {
    return url;
  }
}

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[DB] DATABASE_URL not set — database features are disabled.');
    return null;
  }
  pool = new Pool({ connectionString: stripSslParams(url), ssl: sslFor(url) });
  pool.on('error', (e) => console.error('[DB] idle client error:', e.message));
  return pool;
}

async function ping() {
  const p = getPool();
  if (!p) return false;
  await p.query('SELECT 1');
  return true;
}

// Insert or update the canonical identity row on each Google login.
async function upsertUserOnLogin({ googleSub, email, name }) {
  const p = getPool();
  if (!p) return null;
  const sql = `
    INSERT INTO users (google_sub, email, display_name, status, last_login_at)
    VALUES ($1, $2, $3, 'active', now())
    ON CONFLICT (google_sub) DO UPDATE
      SET email         = EXCLUDED.email,
          display_name  = EXCLUDED.display_name,
          last_login_at = now()
    RETURNING id;`;
  const r = await p.query(sql, [googleSub, email, name]);
  return r.rows[0] ? r.rows[0].id : null;
}

// All role names assigned to a user (by email). Empty array if none.
async function getUserRolesByEmail(email) {
  const p = getPool();
  if (!p) return [];
  const sql = `
    SELECT r.name
    FROM users u
    JOIN role_assignments ra ON ra.user_id = u.id
    JOIN roles r             ON r.id = ra.role_id
    WHERE u.email = $1
    ORDER BY r.id;`;
  const r = await p.query(sql, [email]);
  return r.rows.map((row) => row.name);
}

// Day 5: full auth picture for a user by email — id, name, status, roles.
// Returns null if the user isn't in the database. Used at login.
async function getUserAuthByEmail(email) {
  const p = getPool();
  if (!p) return null;
  const sql = `
    SELECT u.id, u.display_name AS name, u.status,
      COALESCE(array_agg(r.name ORDER BY r.id) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles
    FROM users u
    LEFT JOIN role_assignments ra ON ra.user_id = u.id
    LEFT JOIN roles r             ON r.id = ra.role_id
    WHERE u.email = $1
    GROUP BY u.id, u.display_name, u.status;`;
  const r = await p.query(sql, [email]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return { id: row.id, name: row.name, status: row.status, roles: row.roles || [] };
}

// Day 5: create a database session for a user. Returns the session token
// (the row's uuid) or null if no database.
async function createSession(userId, { userAgent = null } = {}) {
  const p = getPool();
  if (!p) return null;
  const sql = `
    INSERT INTO sessions (user_id, expires_at, user_agent)
    VALUES ($1, now() + interval '8 hours', $2)
    RETURNING id;`;
  const r = await p.query(sql, [userId, userAgent]);
  return r.rows[0] ? r.rows[0].id : null;
}

// Day 5: validate a session token. Returns { userId, name, roles } if the
// session is live AND the user is still active; otherwise null. This is the
// live check that makes role changes and disables take effect immediately.
async function getSession(token) {
  const p = getPool();
  if (!p || !token || !UUID_RE.test(token)) return null;
  const sql = `
    SELECT u.id AS user_id, u.display_name AS name, u.status,
      COALESCE(array_agg(r.name ORDER BY r.id) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN role_assignments ra ON ra.user_id = u.id
    LEFT JOIN roles r             ON r.id = ra.role_id
    WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
    GROUP BY u.id, u.display_name, u.status;`;
  const r = await p.query(sql, [token]);
  const row = r.rows[0];
  if (!row || row.status !== 'active') return null;
  // Touch last_seen_at (fire-and-forget; never blocks the request).
  p.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [token]).catch(() => {});
  return { userId: row.user_id, name: row.name, roles: row.roles || [] };
}

// Day 5: revoke one session (used on logout).
async function revokeSession(token) {
  const p = getPool();
  if (!p || !token || !UUID_RE.test(token)) return;
  await p.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [token]);
}

// Day 5: revoke ALL of a user's live sessions (used when disabling a user) —
// signs them out everywhere on their next request.
async function revokeUserSessions(userId) {
  const p = getPool();
  if (!p) return 0;
  const r = await p.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  return r.rowCount || 0;
}

// Day 5: set a user's status (must be 'pending' | 'active' | 'disabled').
async function setUserStatus(userId, status) {
  const p = getPool();
  if (!p) return null;
  const allowed = ['pending', 'active', 'disabled'];
  if (!allowed.includes(status)) throw new Error('invalid status: ' + status);
  const r = await p.query('UPDATE users SET status = $2 WHERE id = $1 RETURNING id, status', [userId, status]);
  return r.rows[0] || null;
}

// Append-only audit log writer. Never throws into the request path.
async function writeAudit({ actorId = null, action, targetType = null, targetId = null, metadata = {} }) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO audit_events (actor_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [actorId, action, targetType, targetId, JSON.stringify(metadata)]
    );
  } catch (e) {
    console.error('[DB] audit write failed:', e.message);
  }
}

module.exports = {
  getPool, ping,
  upsertUserOnLogin, getUserRolesByEmail, getUserAuthByEmail,
  createSession, getSession, revokeSession, revokeUserSessions, setUserStatus,
  writeAudit,
};
