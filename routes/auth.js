// ============================================================
// routes/auth.js — email/password login, logout, password reset.
// (Legacy email/password uses in-memory sessions for now; Google
//  sign-in lives in google-auth.js and uses database sessions.)
// ============================================================
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { createMemorySession, authenticate, endSession } = require('../lib/sessions');

module.exports = function createAuthRouter({ loadUsers, saveUsers, transporter }) {
  const router = express.Router();

  // POST /api/login
  router.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const usersConfig = loadUsers();
    const user = usersConfig.users.find(u => u.email && u.email.toLowerCase() === email.trim().toLowerCase());
    const passwordToCheck = user ? user.password : '$2b$10$invalidhashfortimingprotection000000000000000000000000';
    const passwordMatch = await bcrypt.compare(password, passwordToCheck);
    if (!user || !passwordMatch) return res.status(401).json({ error: 'Invalid email or password.' });
    if (user.disabled) return res.status(403).json({ error: 'Your access has been disabled. Please contact your administrator.' });
    const token = createMemorySession({ userId: user.id, name: user.name, roles: [user.role] });
    console.log('[LOGIN] ' + user.name + ' (' + user.role + ') logged in at ' + new Date().toISOString());
    res.json({ token, name: user.name, role: user.role });
  });

  // POST /api/logout
  router.post('/api/logout', authenticate, async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    await endSession(token);
    res.json({ success: true });
  });

  // POST /api/forgot-password
  router.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email address is required.' });
    const successMsg = 'If that email is registered, a temporary password has been sent to it.';
    const usersConfig = loadUsers();
    const user = usersConfig.users.find(u => u.email && u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user || user.disabled) return res.json({ message: successMsg });
    const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) + '!1';
    try {
      const hashedPassword = await bcrypt.hash(tempPassword, 10);
      user.password = hashedPassword;
      saveUsers(usersConfig);
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || '"Firm AI Portal" <' + process.env.EMAIL_USER + '>',
        to: user.email,
        subject: 'Your temporary password - Firm AI Portal',
        html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#f8f9fa;border-radius:12px;">' +
          '<h2 style="color:#1a2744;margin-bottom:8px;">Firm AI Portal</h2>' +
          '<p style="color:#6c757d;margin-top:0;">Password Reset</p>' +
          '<hr style="border:none;border-top:1px solid #e9ecef;margin:24px 0;">' +
          '<p style="color:#343a40;">Hi <strong>' + user.name + '</strong>,</p>' +
          '<p style="color:#343a40;">Here is your temporary password:</p>' +
          '<div style="background:#1a2744;color:#c9a227;font-size:22px;font-weight:bold;letter-spacing:3px;text-align:center;padding:20px;border-radius:8px;margin:24px 0;">' + tempPassword + '</div>' +
          '<p style="color:#343a40;">Please log in with this password. We recommend changing it after your first login.</p>' +
          '<p style="color:#adb5bd;font-size:12px;margin-top:32px;">If you did not request this, please contact your system administrator immediately.</p>' +
          '</div>',
      });
      console.log('[RESET] Password reset for ' + user.name + ' (' + user.email + ')');
      res.json({ message: successMsg });
    } catch (err) {
      console.error('[ERROR] Password reset failed:', err.message);
      res.status(500).json({ error: 'Failed to send reset email. Please contact your administrator.' });
    }
  });

  return router;
};
