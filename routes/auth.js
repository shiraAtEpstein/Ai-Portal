// ============================================================
// routes/auth.js — Day 8: logout only.
// The email/password login and password-reset flows have been retired.
// Sign-in is now Google-only (see google-auth.js), which is database-backed,
// domain-restricted and invite-gated. The old endpoints return 410 Gone so
// nothing silently half-works if something still calls them.
// (Accepts and ignores any wiring args from server.js, so server.js is unchanged.)
// ============================================================
const express = require('express');
const { authenticate, endSession } = require('../lib/sessions');

module.exports = function createAuthRouter() {
  const router = express.Router();

  // POST /api/logout — revoke the current database session.
  router.post('/api/logout', authenticate, async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    await endSession(token);
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
