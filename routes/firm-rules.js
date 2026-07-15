// ============================================================
// routes/firm-rules.js — §9 firm-rule change APPROVAL FLOW (API).
//
//   POST /api/firm-rules/request           (any signed-in user) { text }
//   GET  /api/admin/firm-rules/pending     (admin) -> pending requests
//   GET  /api/admin/firm-rules             (admin) -> { pending, recent, active }
//   POST /api/admin/firm-rules/approve     (admin) { id }
//   POST /api/admin/firm-rules/reject      (admin) { id }
//
// Submitting only STAGES a pending request — it changes nothing. An admin
// approves it, which writes a versioned, active firm rule that chat.js injects
// into every Firm-Core preamble (taking precedence over the Dropbox file).
//
// Phase 2: when a change is proposed, admins who have opted in (Settings →
// Notifications: email channel + "Rule proposal") get an email. This is
// best-effort and NEVER blocks or fails the request. Kill switch:
// RULE_PROPOSAL_EMAILS=0.
// ============================================================
const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../lib/sessions');
const firmRules = require('../lib/firm-rules');
const store = require('../lib/settings-store');
const userSettings = require('../lib/user-settings');

module.exports = function createFirmRulesRouter(opts) {
  const router = express.Router();
  const transporter = opts && opts.transporter;

  // Best-effort: email opted-in admins that a change was proposed. Fire-and-forget.
  async function notifyAdminsOfProposal({ text, proposerName, proposerId }) {
    try {
      if (process.env.RULE_PROPOSAL_EMAILS === '0') return;
      if (!transporter || !process.env.EMAIL_USER) return;
      const admins = await store.listAdminEmails();
      if (!admins.length) return;
      const base = process.env.PORTAL_URL || process.env.APP_URL || process.env.BASE_URL || '';
      const link = base ? (base.replace(/\/$/, '') + '/settings.html#approvals') : '';
      for (const admin of admins) {
        if (proposerId && admin.id === proposerId) continue; // don't email the proposer
        let stored = {};
        try { stored = await store.getSettings(admin.id); } catch (_) { stored = {}; }
        if (!userSettings.wantsRuleProposalEmail(stored)) continue;
        const body =
          'Hi ' + (admin.name || 'there') + ',\n\n' +
          (proposerName || 'A staff member') + ' proposed a change to the firm-wide house rules:\n\n' +
          '  "' + text + '"\n\n' +
          'Nothing has changed — it is waiting for an administrator to approve or reject it' +
          (link ? (' here:\n' + link) : ' in Settings → Approvals.') + '\n\n' +
          '— Lawly · Epstein & Co.\n\n' +
          '(You are receiving this because "Rule proposal" email notifications are on in your settings.)';
        transporter.sendMail({
          from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
          to: admin.email,
          subject: 'Firm-rule change proposed — review needed',
          text: body,
        }).catch((e) => console.warn('[FIRM-RULES] proposal email to ' + admin.email + ' failed:', e.message));
      }
    } catch (e) {
      console.warn('[FIRM-RULES] proposal notification skipped:', e.message);
    }
  }

  // Anyone signed in may PROPOSE a change (goes to the pending queue).
  router.post('/api/firm-rules/request', authenticate, async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'Please describe the rule change.' });
    if (text.length > 600) return res.status(400).json({ error: 'Keep the proposed rule under 600 characters.' });
    try {
      const r = await firmRules.submitRequest({
        text, source: 'form',
        userId: req.session.userId, name: req.session.name, email: req.session.email,
      });
      if (!r.ok) return res.status(500).json({ error: 'Could not submit the request.' });
      db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'firm_rule.requested', targetType: 'firm_rule', targetName: 'proposal', metadata: { source: 'form', duplicate: !!r.duplicate } }).catch(function () {});
      // Notify admins only for genuinely new proposals (not duplicates). Non-blocking.
      if (!r.duplicate) {
        notifyAdminsOfProposal({ text, proposerName: req.session.name, proposerId: req.session.userId });
      }
      res.json({ ok: true, status: 'pending', duplicate: !!r.duplicate });
    } catch (e) {
      console.error('[FIRM-RULES] request failed:', e.message);
      res.status(500).json({ error: 'Could not submit the request.' });
    }
  });

  // Admin — list just the pending queue.
  router.get('/api/admin/firm-rules/pending', authenticate, requireAdmin, async (req, res) => {
    try { res.json({ pending: await firmRules.listPending() }); }
    catch (e) { console.error('[FIRM-RULES] pending failed:', e.message); res.status(500).json({ error: 'Could not load pending requests.' }); }
  });

  // Admin — full picture: pending, recent decisions, and the active approved rules.
  router.get('/api/admin/firm-rules', authenticate, requireAdmin, async (req, res) => {
    try {
      const [pending, recent, active] = await Promise.all([
        firmRules.listPending(),
        firmRules.listRecent({ limit: 50 }),
        firmRules.loadActiveRules(),
      ]);
      res.json({ pending, recent, active: active.items });
    } catch (e) {
      console.error('[FIRM-RULES] list failed:', e.message);
      res.status(500).json({ error: 'Could not load firm rules.' });
    }
  });

  // Admin — approve a pending request (applies it to every chat).
  router.post('/api/admin/firm-rules/approve', authenticate, requireAdmin, async (req, res) => {
    const id = Number((req.body && req.body.id));
    if (!id) return res.status(400).json({ error: 'id is required.' });
    try {
      const r = await firmRules.approve(id, { adminId: req.session.userId, adminName: req.session.name });
      if (!r.ok) return res.status(409).json({ error: r.error === 'not_pending' ? 'That request is no longer pending.' : 'Could not approve.' });
      db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'firm_rule.approved', targetType: 'firm_rule', targetName: 'v' + r.version, metadata: { id, version: r.version } }).catch(function () {});
      res.json({ ok: true, version: r.version });
    } catch (e) {
      console.error('[FIRM-RULES] approve failed:', e.message);
      res.status(500).json({ error: 'Could not approve the request.' });
    }
  });

  // Admin — reject a pending request (discards it).
  router.post('/api/admin/firm-rules/reject', authenticate, requireAdmin, async (req, res) => {
    const id = Number((req.body && req.body.id));
    if (!id) return res.status(400).json({ error: 'id is required.' });
    try {
      const r = await firmRules.reject(id, { adminId: req.session.userId, adminName: req.session.name });
      if (!r.ok) return res.status(409).json({ error: 'That request is no longer pending.' });
      db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'firm_rule.rejected', targetType: 'firm_rule', targetName: 'proposal', metadata: { id } }).catch(function () {});
      res.json({ ok: true });
    } catch (e) {
      console.error('[FIRM-RULES] reject failed:', e.message);
      res.status(500).json({ error: 'Could not reject the request.' });
    }
  });

  return router;
};
