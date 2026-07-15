// ============================================================
// lib/settings-store.js — Phase 2 (DB I/O for user settings).
// Kept separate from db.js so that file is untouched. Uses the pool that
// db.js already exports. The user_settings table CREATES ITSELF on first use
// (same convention as the memory tables), so there is no manual migration.
//
//   ensureTable()            -> idempotent CREATE TABLE IF NOT EXISTS
//   getSettings(userId)      -> stored jsonb (or {})
//   saveSettings(userId,obj) -> upsert, returns stored jsonb
//   updateDisplayName(id,nm) -> unique (case-insensitive), returns {id,name}
//   listAdminEmails()        -> [{id,email,name}] for active admins
// ============================================================
const db = require('../db');

let _ready = false;

async function ensureTable() {
  const p = db.getPool();
  if (!p) return false;
  if (_ready) return true;
  await p.query(
    `CREATE TABLE IF NOT EXISTS user_settings (
       user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       data       jsonb NOT NULL DEFAULT '{}'::jsonb,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`);
  _ready = true;
  return true;
}

async function getSettings(userId) {
  const p = db.getPool();
  if (!p || !userId) return {};
  await ensureTable();
  const r = await p.query('SELECT data FROM user_settings WHERE user_id = $1', [userId]);
  return (r.rows[0] && r.rows[0].data) || {};
}

async function saveSettings(userId, data) {
  const p = db.getPool();
  if (!p || !userId) return {};
  await ensureTable();
  const r = await p.query(
    `INSERT INTO user_settings (user_id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET data = $2::jsonb, updated_at = now()
     RETURNING data`,
    [userId, JSON.stringify(data || {})]);
  return (r.rows[0] && r.rows[0].data) || {};
}

// Change a user's display name. Enforces the same case-insensitive uniqueness
// the invite flow uses (excluding the user themselves). Throws with .code:
// NAME_REQUIRED | NAME_TOO_LONG | NAME_TAKEN | DB_UNAVAILABLE.
async function updateDisplayName(userId, name) {
  const p = db.getPool();
  if (!p) { const e = new Error('database unavailable'); e.code = 'DB_UNAVAILABLE'; throw e; }
  const nm = String(name == null ? '' : name).trim();
  if (!nm) { const e = new Error('name required'); e.code = 'NAME_REQUIRED'; throw e; }
  if (nm.length > 80) { const e = new Error('name too long'); e.code = 'NAME_TOO_LONG'; throw e; }
  const clash = await p.query(
    'SELECT id FROM users WHERE lower(display_name) = lower($1) AND id <> $2', [nm, userId]);
  if (clash.rows[0]) { const e = new Error('name taken'); e.code = 'NAME_TAKEN'; throw e; }
  const r = await p.query(
    'UPDATE users SET display_name = $2 WHERE id = $1 RETURNING id, display_name AS name',
    [userId, nm]);
  return r.rows[0] || null;
}

// Active admins with an email address — recipients for opt-in notifications.
async function listAdminEmails() {
  const p = db.getPool();
  if (!p) return [];
  const r = await p.query(
    `SELECT DISTINCT u.id, u.email, u.display_name AS name
       FROM users u
       JOIN role_assignments ra ON ra.user_id = u.id
       JOIN roles r ON r.id = ra.role_id
      WHERE r.name = 'admin' AND u.status = 'active' AND u.email IS NOT NULL`);
  return r.rows.map((row) => ({ id: row.id, email: row.email, name: row.name }));
}

module.exports = { ensureTable, getSettings, saveSettings, updateDisplayName, listAdminEmails };
