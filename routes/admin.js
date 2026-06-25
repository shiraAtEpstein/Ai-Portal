// ============================================================
// routes/admin.js — admin-only endpoints.
// Day 5: disable / enable user (instant revocation).
// Day 6: invite a user (create pending user + email the invite link).
// Day 7: list all users (DB) + change a user's roles.
// Email: sent via the Resend HTTP API (port 443) instead of SMTP,
//        because the host blocks outbound SMTP ports. Fails fast.
// ============================================================
const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../lib/sessions');
const { agentsConfig } = require('../lib/access');

const ALLOWED_DOMAIN = (process.env.GOOGLE_ALLOWED_DOMAIN || 'epsteinlaw.co.il').toLowerCase();
const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://ai-portal-wf42.onrender.com').replace(/\/+$/, '');
const INVITE_FROM = process.env.EMAIL_FROM || 'Epstein & Co. Portal <onboarding@resend.dev>';
// The Resend API key. Prefer RESEND_API_KEY; fall back to EMAIL_PASS (already set).
const RESEND_API_KEY = process.env.RESEND_API_KEY || process.env.EMAIL_PASS || '';

// The role names an admin is allowed to assign (the keys of agents.json > roles).
function assignableRoles() {
  return Object.keys(agentsConfig.roles || {});
}

function inviteEmailHtml({ inviterName, roleLabel, link, email }) {
  return '' +
  '<div style="margin:0;padding:24px;background:#f1f3f6;font-family:Arial,Helvetica,sans-serif;">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8ec;">' +
  '<tr><td style="padding:28px 32px 0 32px;text-align:center;"><div style="display:inline-block;border-bottom:3px solid #C9A227;padding-bottom:6px;"><span style="font-size:22px;font-weight:bold;letter-spacing:3px;color:#1A2744;">EPSTEIN &amp; CO.</span></div></td></tr>' +
  '<tr><td style="padding:24px 40px 0 40px;text-align:center;"><h1 style="margin:0;font-size:22px;line-height:1.35;color:#1A2744;font-weight:bold;">' + inviterName + ' invited you to the<br>Epstein &amp; Co. AI Portal</h1></td></tr>' +
  '<tr><td style="padding:14px 48px 0 48px;text-align:center;"><p style="margin:0;font-size:15px;line-height:1.6;color:#5b6472;">The firm’s secure workspace for AI assistants. You’ve been added as <strong style="color:#1A2744;">' + roleLabel + '</strong>. Click below to accept your invitation and sign in with your firm Google account.</p></td></tr>' +
  '<tr><td style="padding:28px 32px 4px 32px;text-align:center;"><a href="' + link + '" style="display:inline-block;background:#1A8754;color:#ffffff;text-decoration:none;font-size:16px;font-weight:bold;padding:14px 38px;border-radius:8px;">Accept Invitation</a></td></tr>' +
  '<tr><td style="padding:14px 32px 0 32px;text-align:center;"><p style="margin:0;font-size:13px;color:#8a929e;">This invitation expires in 7 days.</p></td></tr>' +
  '<tr><td style="padding:26px 40px 0 40px;"><hr style="border:none;border-top:1px solid #e9ecef;margin:0 0 20px 0;"><p style="margin:0 0 6px 0;font-size:13px;color:#8a929e;text-transform:uppercase;letter-spacing:1px;">Your login email</p><p style="margin:0;font-size:15px;color:#1A2744;font-weight:bold;">' + email + '</p></td></tr>' +
  '<tr><td style="padding:24px 40px 30px 40px;"><hr style="border:none;border-top:1px solid #e9ecef;margin:0 0 16px 0;"><p style="margin:0;font-size:12px;line-height:1.6;color:#aab0ba;">If you weren’t expecting this invitation, you can safely ignore this email. This link is unique to you &mdash; please don’t forward it.</p><p style="margin:12px 0 0 0;font-size:12px;color:#aab0ba;">&copy; Epstein &amp; Co. Law Firm</p></td></tr>' +
  '</table></div>';
}

// Send the invite email through Resend's HTTPS API (port 443, not blocked).
// Times out after 10s so the request can never hang the way SMTP did.
async function sendInvite({ to, inviterName, roleLabel, link }) {
  if (!RESEND_API_KEY) return { sent: false, reason: 'email not configured (no API key)' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: INVITE_FROM,
        to: [to],
        subject: '[Action required] ' + inviterName + ' invited you to the Epstein & Co. AI Portal',
        html: inviteEmailHtml({ inviterName, roleLabel, link, email: to }),
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      let detail = 'HTTP ' + resp.status;
      try { const j = await resp.json(); detail = j.message || j.error || JSON.stringify(j); } catch (_) { /* keep status */ }
      console.error('[MAIL] invite send failed:', detail);
      return { sent: false, reason: detail };
    }
    return { sent: true };
  } catch (e) {
    const reason = (e && e.name === 'AbortError') ? 'timed out reaching Resend' : (e && e.message) || 'unknown error';
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
    const name = req.body.name ? String(req.body.name).trim() : null;
    let roles = req.body.roles;
    if (typeof roles === 'string') roles = [roles];
    roles = Array.isArray(roles) ? roles.filter(Boolean) : [];
    if (!email) return res.status(400).json({ error: 'email is required.' });
    if (!email.endsWith('@' + ALLOWED_DOMAIN)) return res.status(400).json({ error: 'Email must be a @' + ALLOWED_DOMAIN + ' address.' });

    // Only accept role names we actually know about.
    const known = new Set(assignableRoles());
    roles = roles.filter(r => known.has(r));

    let invite;
    try {
      invite = await db.createInvite({ email, name, invitedBy: req.session.userId });
    } catch (e) {
      if (e.code === 'ALREADY_ACTIVE') return res.status(409).json({ error: 'That person is already an active member.' });
      console.error('[INVITE] createInvite failed:', e.message);
      return res.status(500).json({ error: 'Could not create the invite.' });
    }
    try { await db.setUserRolesByName(invite.id, roles); } catch (e) { console.error('[INVITE] role assign failed:', e.message); }

    const link = BASE_URL + '/accept?token=' + invite.token;
    const inviterName = req.session.name || 'An administrator';
    const roleLabel = roles.length ? roles.join(', ') : 'a member';
    const mail = await sendInvite({ to: email, inviterName, roleLabel, link });

    await db.writeAudit({ actorId: req.session.userId, action: 'user.invited', targetType: 'user', targetId: email, metadata: { roles, emailed: mail.sent } });
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
    await db.writeAudit({ actorId: req.session.userId, action: 'user.roles_changed', targetType: 'user', targetId: email, metadata: { roles } });
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
    await db.writeAudit({ actorId: req.session.userId, action: 'user.disabled', targetType: 'user', targetId: email, metadata: { sessionsRevoked: revoked } });
    res.json({ ok: true, email, status: 'disabled', sessionsRevoked: revoked });
  });

  // POST /api/admin/enable { email }
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
