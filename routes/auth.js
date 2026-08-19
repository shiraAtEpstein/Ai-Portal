// ============================================================
// routes/auth.js — Day 8: session helpers (no password login).
// Email/password login + reset are retired; sign-in is Google-only.
//  - GET  /api/me      → who am I (used to restore the session after a refresh)
//  - POST /api/logout  → revoke the session and clear the cookie
// (Accepts and ignores any wiring args from server.js, so server.js is unchanged.)
// ============================================================
const express = require('express');
const { capabilitiesFor } = require('../lib/permissions');
const { authenticate, endSession, tokenFromReq, clearCookie } = require('../lib/sessions');

module.exports = function createAuthRouter() {
  const router = express.Router();

  // GET /api/me — current user, based on the session cookie or header.
  //
  // THIS IS THE ONLY /api/me IN THE REPO. There used to be a second one in
  // routes/me.js; because this router mounts first, that one never ran, and a
  // field added there silently had no effect. A test now asserts there is
  // exactly one handler, so the trap cannot come back.
  //
  // It must return everything the UI needs: name + email (Settings → Profile),
  // roles + isAdmin (admin gating), and capabilities (which buttons exist).
  router.get('/api/me', authenticate, (req, res) => {
    const roles = req.session.roles || [];
    res.json({
      name: req.session.name,
      email: req.session.email || null,
      roles,
      // Case-insensitive so a capitalised "Admin" role still counts as admin.
      isAdmin: roles.some((r) => String(r).toLowerCase() === 'admin'),
      // What this person may actually do, per connection. Lets the UI leave out
      // controls a role cannot use, instead of showing them and returning 403.
      capabilities: Object.fromEntries(
        Object.entries(capabilitiesFor(roles)).map(([k, v]) => [k, [...v]])
      ),
    });
  });

  // POST /api/logout — revoke the database session and clear the cookie.
  router.post('/api/logout', authenticate, async (req, res) => {
    await endSession(tokenFromReq(req));
    res.setHeader('Set-Cookie', clearCookie());
    res.json({ success: true });
  });

  // Retired endpoints — kept only to return a clear message.
  const retired = (req, res) => res.status(410).json({
    error: 'Password login has been retired. Please sign in with Google.',
  });
  router.post('/api/login', retired);
  router.post('/api/forgot-password', retired);

  return router;
};
