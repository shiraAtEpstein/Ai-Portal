// ============================================================
// routes/dropbox.js — one-time connect + status for the firm's Dropbox.
//
//   GET  /api/dropbox/status      -> { configured, connected, account }
//   GET  /api/dropbox/connect     -> redirect to Dropbox consent (admin)
//   GET  /auth/dropbox/callback   -> Dropbox returns here; save refresh token
//   POST /api/dropbox/disconnect  -> forget the connection (admin)
//   GET  /api/dropbox/list        -> list files in the App folder (admin, test)
//
// Admin-only: connecting the firm Dropbox is a privileged, one-time action.
// The callback is tied to the admin who started it via a short-lived state.
// ============================================================
const express = require('express');
const crypto = require('crypto');
const { authenticate, requireAdmin } = require('../lib/sessions');
const dropbox = require('../lib/dropbox');
const db = require('../db');

module.exports = function createDropboxRouter() {
  const router = express.Router();

  const stateStore = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of stateStore) if (v.exp < now) stateStore.delete(k);
  }, 5 * 60 * 1000);
  if (sweep.unref) sweep.unref();

  router.get('/api/dropbox/status', authenticate, requireAdmin, async (req, res) => {
    if (!dropbox.configured()) return res.json({ configured: false, connected: false });
    try {
      const conn = await dropbox.getConnection();
      res.json({ configured: true, connected: !!conn, account: conn ? conn.account : null, connectedAt: conn ? conn.connectedAt : null });
    } catch (e) {
      console.error('[DROPBOX] status failed:', e.message);
      res.json({ configured: true, connected: false });
    }
  });

  router.get('/api/dropbox/connect', authenticate, requireAdmin, (req, res) => {
    if (!dropbox.configured()) return res.status(503).send('Dropbox connection is not configured.');
    const state = crypto.randomBytes(16).toString('hex');
    stateStore.set(state, { userId: req.session.userId, name: req.session.name, exp: Date.now() + 10 * 60 * 1000 });
    res.redirect(dropbox.consentUrl(state));
  });

  router.get('/auth/dropbox/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const done = (status) => res.redirect('/#dropbox=' + encodeURIComponent(status));
    if (error) return done('denied');
    const entry = state && stateStore.get(state);
    if (!code || !entry) return done('expired');
    stateStore.delete(state);
    try {
      const result = await dropbox.exchangeCode(code);
      if (!result.refresh_token) return done('noRefresh');
      await dropbox.saveConnection(result.refresh_token, result.account_id || null);
      db.writeAudit({ actorId: entry.userId, actorName: entry.name, action: 'dropbox.connected', targetType: 'dropbox', targetName: entry.name, metadata: {} }).catch(function () {});
      console.log('[DROPBOX] connected by ' + (entry.name || entry.userId));
      done('connected');
    } catch (e) {
      console.error('[DROPBOX] connect failed:', e.message);
      done('failed');
    }
  });

  router.post('/api/dropbox/disconnect', authenticate, requireAdmin, async (req, res) => {
    try {
      await dropbox.disconnect();
      db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'dropbox.disconnected', targetType: 'dropbox', targetName: req.session.name, metadata: {} }).catch(function () {});
      res.json({ ok: true });
    } catch (e) {
      console.error('[DROPBOX] disconnect failed:', e.message);
      res.status(500).json({ error: 'Could not disconnect Dropbox.' });
    }
  });

  // Verification helper: list what the portal can see in the App folder.
  router.get('/api/dropbox/list', authenticate, requireAdmin, async (req, res) => {
    try {
      const files = await dropbox.listFiles(String(req.query.path || ''));
      res.json({ files });
    } catch (e) {
      console.error('[DROPBOX] list failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
