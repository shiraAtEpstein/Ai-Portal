// ============================================================
// lib/account-store.js — Phase 4 (Sign-in & security).
// Read/revoke a user's OWN database sessions. Kept separate from db.js
// (which is left untouched) and uses the pool db.js already exports.
// A "session id" IS the session token (the value stored in the cookie),
// so the current request's token identifies the current session.
// ============================================================
const db = require('../db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Active (not revoked, not expired) sessions for a user, newest first.
async function listSessions(userId) {
  const p = db.getPool();
  if (!p || !userId) return [];
  const r = await p.query(
    `SELECT id, user_agent, last_seen_at, expires_at
       FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC NULLS LAST`,
    [userId]);
  return r.rows.map((row) => ({
    id: row.id,
    userAgent: row.user_agent || null,
    lastSeen: row.last_seen_at || null,
    expires: row.expires_at || null,
  }));
}

// Revoke every active session for the user EXCEPT the one to keep (their
// current one). Returns how many were signed out.
async function revokeOtherSessions(userId, keepId) {
  const p = db.getPool();
  if (!p || !userId) return 0;
  if (!UUID_RE.test(String(keepId || ''))) return 0;
  const r = await p.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL',
    [userId, keepId]);
  return r.rowCount || 0;
}

// Revoke ONE specific session, scoped to this user (can't touch anyone else's).
async function revokeOneSession(userId, sessionId) {
  const p = db.getPool();
  if (!p || !userId) return false;
  if (!UUID_RE.test(String(sessionId || ''))) return false;
  const r = await p.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL',
    [userId, sessionId]);
  return (r.rowCount || 0) > 0;
}

module.exports = { listSessions, revokeOtherSessions, revokeOneSession, UUID_RE };
