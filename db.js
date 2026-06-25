// ============================================================
// db.js — PostgreSQL (Neon) connection + helpers
// Phase 2 (auth) + Day 5 (DB sessions) + Day 6 (invites / onboarding).
// Day 7: listAllUsers() for the admin management screen.
// Safe to load even when DATABASE_URL is unset.
// ============================================================
const { Pool } = require('pg');
const crypto = require('crypto');

let pool = null;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sslFor(url) {
  if (!url) return false;
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(url)) return false;
  return { rejectUnauthorized: false };
}
function stripSslParams(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('channel_binding');
    return u.toString();
  } catch (_) { return url; }
}
function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) { console.warn('[DB] DATABASE_URL not set — database features are disabled.'); return null; }
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

// All role names assigned to a user (by email).
async function getUserRolesByEmail(email) {
  const p = getPool();
  if (!p) return [];
  const r = await p.query(
    `SELECT r.name FROM users u
     JOIN role_assignments ra ON ra.user_id = u.id
     JOIN roles r ON r.id = ra.role_id
     WHERE u.email = $1 ORDER BY r.id;`, [email]);
  return r.rows.map((row) => row.name);
}

// Full auth picture for a user by email — id, name, status, roles. Null if absent.
async function getUserAuthByEmail(email) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    `SELECT u.id, u.display_name AS name, u.status,
        COALESCE(array_agg(r.name ORDER BY r.id) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles
     FROM users u
     LEFT JOIN role_assignments ra ON ra.user_id = u.id
     LEFT JOIN roles r ON r.id = ra.role_id
     WHERE u.email = $1
     GROUP BY u.id, u.display_name, u.status;`, [email]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return { id: row.id, name: row.name, status: row.status, roles: row.roles || [] };
}

// --- Day 7: list every user for the admin screen ----------------------
// Returns one row per user with status, roles, and useful timestamps.
async function listAllUsers() {
  const p = getPool();
  if (!p) return [];
  const r = await p.query(
    `SELECT u.id, u.email, u.display_name AS name, u.status,
        u.invited_at, u.invite_accepted_at, u.last_login_at,
        COALESCE(array_agg(r.name ORDER BY r.id) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles
     FROM users u
     LEFT JOIN role_assignments ra ON ra.user_id = u.id
     LEFT JOIN roles r ON r.id = ra.role_id
     GROUP BY u.id, u.email, u.display_name, u.status, u.invited_at, u.invite_accepted_at, u.last_login_at
     ORDER BY
       CASE u.status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
       lower(u.email);`);
  return r.rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    roles: row.roles || [],
    invitedAt: row.invited_at,
    inviteAcceptedAt: row.invite_accepted_at,
    lastLoginAt: row.last_login_at,
  }));
}

// --- Day 6: invites ---------------------------------------------------

// Create or refresh an invite for an email. Returns { id, token, reused }.
// Throws an error with code 'ALREADY_ACTIVE' if that email is already active.
async function createInvite({ email, name, invitedBy }) {
  const p = getPool();
  if (!p) throw new Error('database unavailable');
  const token = crypto.randomBytes(24).toString('hex');
  const existing = await p.query('SELECT id, status FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) {
    const u = existing.rows[0];
    if (u.status === 'active') { const e = new Error('already active'); e.code = 'ALREADY_ACTIVE'; throw e; }
    await p.query(
      `UPDATE users SET display_name = COALESCE($2, display_name), status = 'pending',
         invite_token = $3, invited_at = now(), invited_by = $4, invite_accepted_at = NULL
       WHERE id = $1`, [u.id, name || null, token, invitedBy || null]);
    return { id: u.id, token, reused: true };
  }
  const ins = await p.query(
    `INSERT INTO users (email, display_name, status, invite_token, invited_at, invited_by)
     VALUES ($1, $2, 'pending', $3, now(), $4) RETURNING id`,
    [email, name || null, token, invitedBy || null]);
  return { id: ins.rows[0].id, token, reused: false };
}

// Replace a user's role assignments with the given role names.
async function setUserRolesByName(userId, roleNames) {
  const p = getPool();
  if (!p) return;
  await p.query('DELETE FROM role_assignments WHERE user_id = $1', [userId]);
  if (!roleNames || !roleNames.length) return;
  await p.query(
    `INSERT INTO role_assignments (user_id, role_id)
     SELECT $1, r.id FROM roles r WHERE r.name = ANY($2::text[])
     ON CONFLICT DO NOTHING`, [userId, roleNames]);
}

// Look up an invite by token (must be within maxAgeDays). Returns row or null.
async function getInviteByToken(token, maxAgeDays = 7) {
  const p = getPool();
  if (!p || !token) return null;
  const r = await p.query(
    `SELECT id, email, display_name AS name, status, invite_accepted_at
     FROM users
     WHERE invite_token = $1 AND invited_at > now() - $2::interval`,
    [token, maxAgeDays + ' days']);
  return r.rows[0] || null;
}

// Mark an invite as accepted (clicked the link). Returns { id, email } or null.
async function markInviteAccepted(token) {
  const p = getPool();
  if (!p || !token) return null;
  const r = await p.query(
    `UPDATE users SET invite_accepted_at = COALESCE(invite_accepted_at, now())
     WHERE invite_token = $1 AND status = 'pending' RETURNING id, email`, [token]);
  return r.rows[0] || null;
}

// Complete a Google login. Handles: invited(pending+accepted)->active,
// returning user refresh, and brand-new (users.json fallback) insert.
// Returns { id, status }. A pending user who hasn't accepted stays 'pending'.
async function completeGoogleLogin({ googleSub, email, name }) {
  const p = getPool();
  if (!p) return null;
  const existing = await p.query('SELECT id, status, invite_accepted_at FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) {
    const u = existing.rows[0];
    let newStatus = u.status;
    if (u.status === 'pending' && u.invite_accepted_at) newStatus = 'active';
    await p.query(
      `UPDATE users SET google_sub = $2, display_name = COALESCE($3, display_name),
         status = $4, last_login_at = now(),
         invite_token = CASE WHEN $4 = 'active' THEN NULL ELSE invite_token END
       WHERE id = $1`, [u.id, googleSub, name || null, newStatus]);
    return { id: u.id, status: newStatus };
  }
  const ins = await p.query(
    `INSERT INTO users (google_sub, email, display_name, status, last_login_at)
     VALUES ($1, $2, $3, 'active', now()) RETURNING id`, [googleSub, email, name || null]);
  return { id: ins.rows[0].id, status: 'active' };
}

// --- Day 5: sessions --------------------------------------------------
async function createSession(userId, { userAgent = null } = {}) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    `INSERT INTO sessions (user_id, expires_at, user_agent)
     VALUES ($1, now() + interval '8 hours', $2) RETURNING id;`, [userId, userAgent]);
  return r.rows[0] ? r.rows[0].id : null;
}
async function getSession(token) {
  const p = getPool();
  if (!p || !token || !UUID_RE.test(token)) return null;
  const r = await p.query(
    `SELECT u.id AS user_id, u.display_name AS name, u.status,
        COALESCE(array_agg(r.name ORDER BY r.id) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN role_assignments ra ON ra.user_id = u.id
     LEFT JOIN roles r ON r.id = ra.role_id
     WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
     GROUP BY u.id, u.display_name, u.status;`, [token]);
  const row = r.rows[0];
  if (!row || row.status !== 'active') return null;
  p.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [token]).catch(() => {});
  return { userId: row.user_id, name: row.name, roles: row.roles || [] };
}
async function revokeSession(token) {
  const p = getPool();
  if (!p || !token || !UUID_RE.test(token)) return;
  await p.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [token]);
}
async function revokeUserSessions(userId) {
  const p = getPool();
  if (!p) return 0;
  const r = await p.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  return r.rowCount || 0;
}
async function setUserStatus(userId, status) {
  const p = getPool();
  if (!p) return null;
  const allowed = ['pending', 'active', 'disabled'];
  if (!allowed.includes(status)) throw new Error('invalid status: ' + status);
  const r = await p.query('UPDATE users SET status = $2 WHERE id = $1 RETURNING id, status', [userId, status]);
  return r.rows[0] || null;
}

async function writeAudit({ actorId = null, action, targetType = null, targetId = null, metadata = {} }) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO audit_events (actor_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [actorId, action, targetType, targetId, JSON.stringify(metadata)]);
  } catch (e) { console.error('[DB] audit write failed:', e.message); }
}

module.exports = {
  getPool, ping,
  getUserRolesByEmail, getUserAuthByEmail, listAllUsers,
  createInvite, setUserRolesByName, getInviteByToken, markInviteAccepted, completeGoogleLogin,
  createSession, getSession, revokeSession, revokeUserSessions, setUserStatus,
  writeAudit,
};
