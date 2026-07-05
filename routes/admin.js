// ============================================================
// routes/admin.js — admin-only endpoints.
// Day 5: disable / enable user (instant revocation).
// Day 6: invite a user (create pending user + email the invite link).
// Day 7: list all users (DB) + change a user's roles.
// Email: sent via the Gmail API using an OAuth refresh token (port 443).
//        No SMTP (blocked on host) and no service-account key needed.
// Branding: black & silver, firm logo from /logo.png.jpg.
// ============================================================
const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../lib/sessions');
const { agentsConfig } = require('../lib/access');
const agentRegistry = require('../lib/agents'); // Dropbox agent refresh

const ALLOWED_DOMAIN = (process.env.GOOGLE_ALLOWED_DOMAIN || 'epsteinlaw.co.il').toLowerCase();
const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://ai-portal-wf42.onrender.com').replace(/\/+$/, '');
const INVITE_FROM = process.env.EMAIL_FROM || 'Epstein & Co. Portal <noreply@epsteinlaw.co.il>';
const LOGO_URL = BASE_URL + '/logo.png.jpg';

// Gmail (OAuth) credentials — set these in Render.
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || '';

// The role names an admin is allowed to assign (the keys of agents.json > roles).
function assignableRoles() {
  return Object.keys(agentsConfig.roles || {});
}

// Escape values before they go into the HTML email (defence-in-depth).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inviteEmailHtml({ inviterName, roleLabel, link, email }) {
  return '' +
  '<div style="margin:0;padding:24px;background:#ececef;font-family:Arial,Helvetica,sans-serif;">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e2e3e7;">' +
  '<tr><td style="background:#000000;padding:30px 32px 26px 32px;text-align:center;"><img src="' + LOGO_URL + '" alt="Epstein &amp; Co. Law Firm" width="260" style="display:block;width:260px;max-width:80%;height:auto;margin:0 auto;border:0;outline:none;text-decoration:none;"></td></tr>' +
  '<tr><td style="padding:32px 44px 0 44px;text-align:center;"><h1 style="margin:0;font-size:21px;line-height:1.4;color:#15161a;font-weight:bold;">' + inviterName + ' invited you to the<br>Epstein &amp; Co. AI Portal</h1></td></tr>' +
  '<tr><td style="padding:16px 46px 0 46px;text-align:center;"><p style="margin:0;font-size:15px;line-height:1.65;color:#565a62;">The firm’s secure workspace for AI assistants. You’ve been added as <strong style="color:#15161a;">' + roleLabel + '</strong>. Click below to accept your invitation and sign in with your firm Google account.</p></td></tr>' +
  '<tr><td style="padding:30px 32px 6px 32px;text-align:center;"><a href="' + link + '" style="display:inline-block;background:#000000;color:#ececee;text-decoration:none;font-size:15px;font-weight:bold;letter-spacing:1px;padding:15px 44px;border:1px solid #b9bdc4;border-radius:4px;">Accept Invitation</a></td></tr>' +
  '<tr><td style="padding:14px 32px 0 32px;text-align:center;"><p style="margin:0;font-size:13px;color:#9aa0a8;">This invitation expires in 7 days.</p></td></tr>' +
  '<tr><td style="padding:28px 44px 0 44px;"><hr style="border:none;border-top:1px solid #ececee;margin:0 0 18px 0;"><p style="margin:0 0 6px 0;font-size:11px;color:#9aa0a8;text-transform:uppercase;letter-spacing:1.5px;">Your login email</p><p style="margin:0;font-size:15px;color:#15161a;font-weight:bold;">' + email + '</p></td></tr>' +
  '<tr><td style="padding:24px 44px 30px 44px;"><hr style="border:none;border-top:1px solid #ececee;margin:0 0 16px 0;"><p style="margin:0;font-size:12px;line-height:1.6;color:#aab0b8;">If you weren’t expecting this invitation, you can safely ignore this email. This link is unique to you &mdash; please don’t forward it.</p><p style="margin:12px 0 0 0;font-size:12px;color:#aab0b8;">&copy; Epstein &amp; Co. Law Firm</p></td></tr>' +
  '</table></div>';
}

// Exchange the long-lived refresh token for a short-lived access token.
async function gmailAccessToken(signal) {
  const body = new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    client_secret: GMAIL_CLIENT_SECRET,
    refresh_token: GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('auth: ' + (j.error_description || j.error || ('HTTP ' + resp.status)));
  return j.access_token;
}

// Send the invite email through the Gmail API. Times out after 12s.
async function sendInvite({ to, inviterName, roleLabel, link }) {
  if (!GMAIL_CLIENT_ID || !GMAIL_REFRESH_TOKEN) return { sent: false, reason: 'email not configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const accessToken = await gmailAccessToken(controller.signal);
    const subject = '[Action required] ' + inviterName + ' invited you to the Epstein & Co. AI Portal';
    const html = inviteEmailHtml({ inviterName: esc(inviterName), roleLabel: esc(roleLabel), link: esc(link), email: esc(to) });
    const bodyB64 = Buffer.from(html, 'utf8').toString('base64');
    const mime =
      'From: ' + INVITE_FROM + '\r\n' +
      'To: ' + to + '\r\n' +
      'Subject: ' + subject + '\r\n' +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: text/html; charset="UTF-8"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      bodyB64;
    const raw = Buffer.from(mime, 'utf8').toString('base64url');
    const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      let detail = 'HTTP ' + resp.status;
      try { const j = await resp.json(); detail = (j.error && j.error.message) || detail; } catch (_) { /* keep status */ }
      console.error('[MAIL] invite send failed:', detail);
      return { sent: false, reason: detail };
    }
    return { sent: true };
  } catch (e) {
    const reason = (e && e.name === 'AbortError') ? 'timed out reaching Google' : (e && e.message) || 'unknown error';
    console.error('[MAIL] invite send failed:', reason);
    return { sent: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = function createAdminRouter({ loadUsers }) {
  const router = express.Router();

  // GET /api/admin/users — the users.json staff list (legacy view).
  router.get('/api/admin/users', authenticate, requireAdmin, (req, res) => {
    const usersConfig = loadUsers();
    res.json({ users: usersConfig.users.map(u => ({ id: u.id, name: u.name, role: u.role, email: u.email, disabled: u.disabled || false })) });
  });

  // GET /api/admin/all-users — Day 7: every user from the DATABASE, with the
  // list of role names an admin can assign. This is what the admin screen uses.
  router.get('/api/admin/all-users', authenticate, requireAdmin, async (req, res) => {
    try {
      const users = await db.listAllUsers();
      res.json({ users, roles: assignableRoles() });
    } catch (e) {
      console.error('[ADMIN] list users failed:', e.message);
      res.status(500).json({ error: 'Could not load the user list.' });
    }
  });

  // POST /api/admin/invite { email, name, roles[] } — invite a new user.
  router.post('/api/admin/invite', authenticate, requireAdmin, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = req.body.name ? String(req.body.name).trim() : '';
    let roles = req.body.roles;
    if (typeof roles === 'string') roles = [roles];
    roles = Array.isArray(roles) ? roles.filter(Boolean) : [];
    if (!email) return res.status(400).json({ error: 'email is required.' });
    if (!email.endsWith('@' + ALLOWED_DOMAIN)) return res.status(400).json({ error: 'Email must be a @' + ALLOWED_DOMAIN + ' address.' });
    if (!name) return res.status(400).json({ error: 'A name is required.' });

    // Only accept role names we actually know about.
    const known = new Set(assignableRoles());
    roles = roles.filter(r => known.has(r));

    let invite;
    try {
      invite = await db.createInvite({ email, name, invitedBy: req.session.userId });
    } catch (e) {
      if (e.code === 'ALREADY_ACTIVE') return res.status(409).json({ error: 'That person is already an active member.' });
      if (e.code === 'NAME_TAKEN') return res.status(409).json({ error: 'That name is already in use. Please use a different name.' });
      if (e.code === 'NAME_REQUIRED') return res.status(400).json({ error: 'A name is required.' });
      console.error('[INVITE] createInvite failed:', e.message);
      return res.status(500).json({ error: 'Could not create the invite.' });
    }
    try { await db.setUserRolesByName(invite.id, roles); } catch (e) { console.error('[INVITE] role assign failed:', e.message); }

    const link = BASE_URL + '/accept?token=' + invite.token;
    const inviterName = req.session.name || 'An administrator';
    const roleLabel = roles.length ? roles.join(', ') : 'a member';
    const mail = await sendInvite({ to: email, inviterName, roleLabel, link });

    await db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'user.invited', targetType: 'user', targetName: name, metadata: { roles, emailed: mail.sent } });
    res.json({ ok: true, email, status: 'pending', roles, inviteLink: link, emailed: mail.sent, emailError: mail.sent ? undefined : mail.reason });
  });

  // POST /api/admin/set-roles { email, roles[] } — Day 7: change a user's roles.
  // Role changes take effect on the user's next request (sessions read roles live).
  router.post('/api/admin/set-roles', authenticate, requireAdmin, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    let roles = req.body.roles;
    if (typeof roles === 'string') roles = [roles];
    roles = Array.isArray(roles) ? roles.filter(Boolean) : [];
    if (!email) return res.status(400).json({ error: 'email is required.' });

    // Only accept role names we actually know about.
    const known = new Set(assignableRoles());
    const unknown = roles.filter(r => !known.has(r));
    if (unknown.length) return res.status(400).json({ error: 'Unknown role(s): ' + unknown.join(', ') });

    const user = await db.getUserAuthByEmail(email);
    if (!user) return res.status(404).json({ error: 'No such user in the database.' });

    // Safety: don't let an admin remove their own admin access (avoids lockout).
    if (user.id === req.session.userId && !roles.includes('admin')) {
      return res.status(400).json({ error: "You can't remove your own admin access." });
    }

    await db.setUserRolesByName(user.id, roles);
    await db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'user.roles_changed', targetType: 'user', targetName: user.name, metadata: { roles } });
    res.json({ ok: true, email, roles });
  });

  // POST /api/admin/disable { email }
  router.post('/api/admin/disable', authenticate, requireAdmin, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required.' });
    const user = await db.getUserAuthByEmail(email);
    if (!user) return res.status(404).json({ error: 'No such user in the database.' });
    await db.setUserStatus(user.id, 'disabled');
    const revoked = await db.revokeUserSessions(user.id);
    await db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'user.disabled', targetType: 'user', targetName: user.name, metadata: { sessionsRevoked: revoked } });
    res.json({ ok: true, email, status: 'disabled', sessionsRevoked: revoked });
  });

  // POST /api/admin/enable { email }
  router.post('/api/admin/enable', authenticate, requireAdmin, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required.' });
    const user = await db.getUserAuthByEmail(email);
    if (!user) return res.status(404).json({ error: 'No such user in the database.' });
    await db.setUserStatus(user.id, 'active');
    await db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'user.enabled', targetType: 'user', targetName: user.name, metadata: {} });
    res.json({ ok: true, email, status: 'active' });
  });

  // POST /api/admin/delete-user { email } — permanently remove a user from the DB.
  router.post('/api/admin/delete-user', authenticate, requireAdmin, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required.' });
    const user = await db.getUserAuthByEmail(email);
    if (!user) return res.status(404).json({ error: 'No such user in the database.' });
    if (user.id === req.session.userId) return res.status(400).json({ error: "You can't delete your own account." });
    // Record the deletion first (the admin doing it stays in the system).
    await db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'user.deleted', targetType: 'user', targetName: user.name, metadata: { roles: user.roles, status: user.status } });
    try {
      const removed = await db.deleteUser(user.id);
      res.json({ ok: true, email, deleted: removed });
    } catch (e) {
      console.error('[ADMIN] delete user failed:', e.message);
      res.status(500).json({ error: 'Could not delete the user.' });
    }
  });

  // GET /api/admin/audit — Day 9: recent audit-log events (admin-only, read-only).
  router.get('/api/admin/audit', authenticate, requireAdmin, async (req, res) => {
    try {
      const events = await db.listAuditEvents(req.query.limit || 100);
      res.json({ events });
    } catch (e) {
      console.error('[ADMIN] audit fetch failed:', e.message);
      res.status(500).json({ error: 'Could not load the audit log.' });
    }
  });

  // POST /api/admin/resend-invite { email } — re-send a pending user's invite with a FRESH link.
  router.post('/api/admin/resend-invite', authenticate, requireAdmin, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required.' });
    const user = await db.getUserAuthByEmail(email);
    if (!user) return res.status(404).json({ error: 'No such user in the database.' });
    if (user.status === 'active') return res.status(409).json({ error: 'That person is already active — no invite needed.' });
    let invite;
    try {
      // Re-running createInvite rotates the token (old link stops working) and keeps their roles.
      invite = await db.createInvite({ email, name: user.name, invitedBy: req.session.userId });
    } catch (e) {
      console.error('[INVITE] resend failed:', e.message);
      return res.status(500).json({ error: 'Could not resend the invite.' });
    }
    const link = BASE_URL + '/accept?token=' + invite.token;
    const inviterName = req.session.name || 'An administrator';
    const roleLabel = (user.roles && user.roles.length) ? user.roles.join(', ') : 'a member';
    const mail = await sendInvite({ to: email, inviterName, roleLabel, link });
    await db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'user.invite_resent', targetType: 'user', targetName: user.name, metadata: { emailed: mail.sent } });
    res.json({ ok: true, email, inviteLink: link, emailed: mail.sent, emailError: mail.sent ? undefined : mail.reason });
  });

  // POST /api/admin/refresh-agents — pull the latest agent files from Dropbox
  // now (admin-only). Agents also auto-refresh on a timer.
  router.post('/api/admin/refresh-agents', authenticate, requireAdmin, async (req, res) => {
    const r = await agentRegistry.refreshFromDropbox();
    if (r.ok) {
      db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'agents.refreshed', targetType: 'config', targetName: 'portal-agents', metadata: { count: r.count } }).catch(function () {});
      return res.json({ ok: true, count: r.count });
    }
    console.error('[ADMIN] agents refresh failed:', r.reason);
    return res.status(502).json({ ok: false, error: 'Could not refresh agents from Dropbox: ' + r.reason });
  });

  return router;
};
