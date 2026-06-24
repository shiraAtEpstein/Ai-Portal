// ============================================================
// lib/sessions.js — who is logged in (Day 5).
// Google logins use DATABASE sessions (revocable, survive restarts).
// Legacy email/password logins still use in-memory sessions for now.
// authenticate() accepts either; requireAdmin() gates admin-only routes.
// ============================================================
const crypto = require('crypto');
const db = require('../db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// In-memory store for legacy password logins only.
const memSessions = {};
const sweep = setInterval(() => {
  const now = Date.now();
  for (const t in memSessions) if (memSessions[t].expiresAt < now) delete memSessions[t];
}, 60 * 60 * 1000);
if (sweep.unref) sweep.unref();

// Legacy: in-memory session for email/password login.
function createMemorySession({ userId, name, roles }) {
  const token = crypto.randomBytes(32).toString('hex');
  memSessions[token] = { userId, name, roles: roles || [], expiresAt: Date.now() + 8 * 60 * 60 * 1000 };
  return token;
}

// Day 5: database session for Google login. Returns the token (uuid).
async function createDbSession(userId, meta = {}) {
  return db.createSession(userId, meta);
}

// Resolve a token to a live session, or null. Checks the database first
// (uuid tokens), then the in-memory legacy store.
async function resolveSession(token) {
  if (!token) return null;
  if (UUID_RE.test(token)) {
    const s = await db.getSession(token);
    if (s) return { userId: s.userId, name: s.name, roles: s.roles, source: 'db', token };
  }
  const m = memSessions[token];
  if (m) {
    if (m.expiresAt < Date.now()) { delete memSessions[token]; return null; }
    return { userId: m.userId, name: m.name, roles: m.roles, source: 'mem', token };
  }
  return null;
}

async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No session token provided.' });
  let session;
  try {
    session = await resolveSession(token);
  } catch (e) {
    console.error('[AUTH] session lookup failed:', e.message);
    return res.status(401).json({ error: 'Session check failed. Please log in again.' });
  }
  if (!session) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.roles || !req.session.roles.includes('admin')) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// Logout: revoke a database session and/or drop the in-memory one.
async function endSession(token) {
  if (!token) return;
  if (UUID_RE.test(token)) { try { await db.revokeSession(token); } catch (e) { /* ignore */ } }
  delete memSessions[token];
}

module.exports = {
  createMemorySession, createDbSession, resolveSession,
  authenticate, requireAdmin, endSession, memSessions,
};
