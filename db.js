// ============================================================
// db.js — PostgreSQL (Neon) connection + helpers
// Added for Phase 2 (auth & connections). Safe to load even when
// DATABASE_URL is unset: every helper degrades gracefully so the
// existing email/password login keeps working with no database.
// ============================================================
const { Pool } = require('pg');

let pool = null;

// Neon (and any non-local host) requires SSL. A local Postgres used
// for testing does not, so we switch SSL off for localhost/127.0.0.1.
function sslFor(url) {
  if (!url) return false;
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// Remove sslmode / channel_binding from the connection string. We set SSL
// explicitly via the `ssl` option below, so these query params are redundant
// — and leaving them in makes newer pg versions print a noisy deprecation
// warning ("SSL modes ... are treated as aliases for 'verify-full'").
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

// Simple connectivity check used at startup and by /healthz.
async function ping() {
  const p = getPool();
  if (!p) return false;
  await p.query('SELECT 1');
  return true;
}

// Insert or update the canonical identity row on each Google login.
// Keyed by google_sub (the stable Google user id). Returns the row's uuid.
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

// Day 4: return EVERY role name assigned to a user (looked up by email),
// ordered by role id (so 'admin' comes first). Empty array if none / no DB.
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

// Append-only audit log writer. Never throws into the request path —
// callers wrap it, but we also swallow here so logging can't block login.
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

module.exports = { getPool, ping, upsertUserOnLogin, getUserRolesByEmail, writeAudit };
