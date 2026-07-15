// ============================================================
// routes/account.js — Phase 4: Sign-in & security (self-service).
// Scoped strictly to the signed-in user (req.session.userId).
//
//   GET  /api/me/sessions                 -> { sessions:[{id,current,device,lastSeen}] }
//   POST /api/me/sessions/signout-others  -> revoke all sessions except the current one
//   POST /api/me/sessions/revoke  {id}    -> revoke one other session
//   GET  /api/me/export                   -> download the user's own data (JSON)
//   POST /api/me/close-request            -> ask admins to close the account (audited)
//
// NOTE: these are sub-paths of /api/me, so they do NOT collide with the
// exact-match GET /api/me defined in routes/auth.js.
// ============================================================
const express = require('express');
const { authenticate, tokenFromReq } = require('../lib/sessions');
const acct = require('../lib/account-store');
const store = require('../lib/settings-store');
const memory = require('../lib/memory');
const db = require('../db');

// A short, human label from a User-Agent string (no exact fingerprinting).
function deviceLabel(ua) {
  ua = String(ua || '');
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return browser + (os ? ' · ' + os : '');
}

module.exports = function createAccountRouter() {
  const router = express.Router();

  // List the user's active sessions, flagging the current one.
  router.get('/api/me/sessions', authenticate, async (req, res) => {
    try {
      const current = tokenFromReq(req);
      const rows = await acct.listSessions(req.session.userId);
      res.json({
        sessions: rows.map((s) => ({
          id: s.id,
          current: s.id === current,
          device: deviceLabel(s.userAgent),
          lastSeen: s.lastSeen,
        })),
      });
    } catch (e) {
      console.error('[ACCOUNT] sessions failed:', e.message);
      res.status(500).json({ error: 'Could not load your sessions.' });
    }
  });

  // Sign out everywhere else (keep this session).
  router.post('/api/me/sessions/signout-others', authenticate, async (req, res) => {
    try {
      const n = await acct.revokeOtherSessions(req.session.userId, tokenFromReq(req));
      db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'auth.signout_others', targetType: 'user', targetName: req.session.name, metadata: { count: n } }).catch(function () {});
      res.json({ ok: true, revoked: n });
    } catch (e) {
      console.error('[ACCOUNT] signout-others failed:', e.message);
      res.status(500).json({ error: 'Could not sign out your other devices.' });
    }
  });

  // Sign out one specific other session.
  router.post('/api/me/sessions/revoke', authenticate, async (req, res) => {
    const id = String((req.body && req.body.id) || '');
    if (!acct.UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid session id.' });
    if (id === tokenFromReq(req)) return res.status(400).json({ error: 'Use Sign out to end your current session.' });
    try {
      const ok = await acct.revokeOneSession(req.session.userId, id);
      res.json({ ok });
    } catch (e) {
      console.error('[ACCOUNT] revoke failed:', e.message);
      res.status(500).json({ error: 'Could not sign out that device.' });
    }
  });

  // Export the user's OWN data as a JSON download.
  router.get('/api/me/export', authenticate, async (req, res) => {
    try {
      let settings = {};
      try { settings = await store.getSettings(req.session.userId); } catch (e) { settings = {}; }
      let preferences = [], matterNotes = [];
      try {
        const mem = await memory.listForUser(req.session.userId);
        preferences = (mem.trusted || []).filter((p) => !p.revoked).map((p) => ({ text: p.text, source: p.source, createdAt: p.createdAt, lastReaffirmed: p.lastReaffirmed }));
      } catch (e) { /* ignore */ }
      try {
        const facts = await memory.listFactsForAdmin(req.session.userId);
        matterNotes = (facts || []).filter((f) => !f.revoked).map((f) => ({ agentId: f.agentId, text: f.text, createdAt: f.createdAt, lastReaffirmed: f.lastReaffirmed }));
      } catch (e) { /* ignore */ }
      const data = {
        exportedAt: new Date().toISOString(),
        account: { name: req.session.name || null, email: req.session.email || null, roles: req.session.roles || [] },
        settings,
        memory: { preferences, matterNotes },
      };
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="my-lawly-data.json"');
      res.send(JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[ACCOUNT] export failed:', e.message);
      res.status(500).json({ error: 'Could not export your data.' });
    }
  });

  // Ask administrators to close/remove this account. Recorded in the audit log
  // (visible to admins under Settings -> Activity log). Does NOT delete anything.
  router.post('/api/me/close-request', authenticate, async (req, res) => {
    try {
      db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'user.removal_requested', targetType: 'user', targetName: req.session.name, metadata: {} }).catch(function () {});
      res.json({ ok: true });
    } catch (e) {
      console.error('[ACCOUNT] close-request failed:', e.message);
      res.status(500).json({ error: 'Could not send your request.' });
    }
  });

  return router;
};

module.exports.deviceLabel = deviceLabel;
