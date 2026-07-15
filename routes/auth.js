// ============================================================
// routes/auth.js — Day 8: session helpers (no password login).
// Email/password login + reset are retired; sign-in is Google-only.
//  - GET  /api/me      → who am I (used to restore the session after a refresh)
//  - POST /api/logout  → revoke the session and clear the cookie
// (Accepts and ignores any wiring args from server.js, so server.js is unchanged.)
// ============================================================
const express = require('express');
const { authenticate, endSession, tokenFromReq, clearCookie } = require('../lib/sessions');

module.exports = function createAuthRouter() {
  const router = express.Router();

  // GET /api/me — current user, based on the session cookie or header.
  // This handler is registered before routes/me.js, so it is the one that
  // actually answers /api/me. It must return everything the UI needs:
  // name + email (Settings → Profile) and roles + isAdmin (admin gating).
  router.get('/api/me', authenticate, (req, res) => {
    const roles = req.session.roles || [];
    res.json({
      name: req.session.name,
      email: req.session.email || null,
      roles,
      // Case-insensitive so a capitalised "Admin" role still counts as admin.
      isAdmin: roles.some((r) => String(r).toLowerCase() === 'admin'),
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
