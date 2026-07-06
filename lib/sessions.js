// ============================================================
// lib/sessions.js — who is logged in.
// Day 8: Google sign-in only. Sessions are DATABASE-backed — revocable,
// they survive restarts, and they are re-checked live on every request
// (so disabling a user or changing roles takes effect immediately).
// The session token is read from the Authorization header OR an httpOnly
// cookie (the cookie is what keeps you logged in across a page refresh).
// ============================================================
const db = require('../db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COOKIE_NAME = 'portal_session';

// Pull the session token from a request: a valid Bearer header wins, else the cookie.
function tokenFromReq(req) {
  const hdr = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (UUID_RE.test(hdr)) return hdr;
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)portal_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// Build the Set-Cookie value for a session (httpOnly, 8h to match the session).
function sessionCookie(token) {
  return COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800';
}
function clearCookie() {
  return COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

// Google login: create a database session. Returns the token (a uuid).
async function createDbSession(userId, meta = {}) {
  return db.createSession(userId, meta);
}

// Resolve a token to a live session, or null. Only database (uuid) tokens.
async function resolveSession(token) {
  if (!token || !UUID_RE.test(token)) return null;
  const s = await db.getSession(token);
  if (s) return { userId: s.userId, name: s.name, email: s.email, roles: s.roles, source: 'db', token };
  return null;
}

async function authenticate(req, res, next) {
  const token = tokenFromReq(req);
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

// Logout: revoke the current database session.
async function endSession(token) {
  if (!token || !UUID_RE.test(token)) return;
  try { await db.revokeSession(token); } catch (e) { /* ignore */ }
}

module.exports = {
  createDbSession, resolveSession, authenticate, requireAdmin, endSession,
  tokenFromReq, sessionCookie, clearCookie,
};
