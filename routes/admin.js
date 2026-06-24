// ============================================================
// routes/admin.js — admin-only endpoints, including Day 5's
// disable / enable user (instant revocation).
// ============================================================
const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../lib/sessions');

module.exports = function createAdminRouter({ loadUsers }) {
  const router = express.Router();

  // GET /api/admin/users — the users.json staff list (legacy view).
  router.get('/api/admin/users', authenticate, requireAdmin, (req, res) => {
    const usersConfig = loadUsers();
    res.json({ users: usersConfig.users.map(u => ({ id: u.id, name: u.name, role: u.role, email: u.email, disabled: u.disabled || false })) });
  });

  // POST /api/admin/disable { email } — disable a user and sign them out
  // everywhere on their next request.
  router.post('/api/admin/disable', authenticate, requireAdmin, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required.' });
    const user = await db.getUserAuthByEmail(email);
    if (!user) return res.status(404).json({ error: 'No such user in the database.' });
    await db.setUserStatus(user.id, 'disabled');
    const revoked = await db.revokeUserSessions(user.id);
    await db.writeAudit({ actorId: req.session.userId, action: 'user.disabled', targetType: 'user', targetId: email, metadata: { sessionsRevoked: revoked } });
    res.json({ ok: true, email, status: 'disabled', sessionsRevoked: revoked });
  });

  // POST /api/admin/enable { email } — re-enable a disabled user.
  router.post('/api/admin/enable', authenticate, requireAdmin, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required.' });
    const user = await db.getUserAuthByEmail(email);
    if (!user) return res.status(404).json({ error: 'No such user in the database.' });
    await db.setUserStatus(user.id, 'active');
    await db.writeAudit({ actorId: req.session.userId, action: 'user.enabled', targetType: 'user', targetId: email, metadata: {} });
    res.json({ ok: true, email, status: 'active' });
  });

  return router;
};
