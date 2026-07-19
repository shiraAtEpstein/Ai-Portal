// ============================================================
// routes/gmail.js — connect / disconnect a user's own Gmail (read-only).
//
// Phase 2, Stage 2. Endpoints:
//   GET  /api/gmail/status      -> { configured, connected, email, canDraft, needsReconnect }
//   GET  /api/gmail/connect     -> redirect to Google's consent screen
//   GET  /auth/gmail/callback   -> Google returns here; we save the token
//   POST /api/gmail/disconnect  -> forget this user's Gmail permission
//
// The connect/disconnect/status endpoints require a logged-in session.
// The callback is matched to the right user via a short-lived `state`
// value created at connect time (not by trusting the request).
// ============================================================
const express = require('express');
const crypto = require('crypto');
const { authenticate } = require('../lib/sessions');
const gmail = require('../lib/gmail');
const db = require('../db');

module.exports = function createGmailRouter() {
  const router = express.Router();

  // state -> { userId, name, exp }. Ties Google's callback back to the
  // user who started the flow. Entries expire after 10 minutes.
  const stateStore = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of stateStore) if (v.exp < now) stateStore.delete(k);
  }, 5 * 60 * 1000);
  if (sweep.unref) sweep.unref();

  // Is the current user connected? This VERIFIES the stored token (see
  // lib/gmail.connectionStatus), so a connection whose token has expired is
  // reported connected:false with needsReconnect:true instead of a false
  // green "connected".
  router.get('/api/gmail/status', authenticate, async (req, res) => {
    if (!gmail.configured()) return res.json({ configured: false, connected: false });
    try {
      const st = await gmail.connectionStatus(req.session.userId);
      res.json({ configured: true, connected: st.connected, email: st.email, canDraft: st.canDraft, needsReconnect: !!st.needsReconnect });
    } catch (e) {
      console.error('[GMAIL] status failed:', e.message);
      res.json({ configured: true, connected: false, canDraft: false });
    }
  });

  // Begin the connect flow.
  router.get('/api/gmail/connect', authenticate, async (req, res) => {
    if (!gmail.configured()) return res.status(503).send('Gmail connection is not configured.');
    let email = null;
    try { email = await gmail.getUserEmail(req.session.userId); } catch (e) { /* ignore */ }
    const state = crypto.randomBytes(16).toString('hex');
    stateStore.set(state, { userId: req.session.userId, name: req.session.name, email: email, exp: Date.now() + 10 * 60 * 1000 });
    res.redirect(gmail.consentUrl(state));
  });

  // Google redirects here after the user approves (or denies).
  router.get('/auth/gmail/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const done = (status) => res.redirect('/#gmail=' + encodeURIComponent(status));
    if (error) return done('denied');
    const entry = state && stateStore.get(state);
    if (!code || !entry) return done('expired');
    stateStore.delete(state);
    try {
      const result = await gmail.exchangeCode(code);
      if (!result.refreshToken) return done('noRefresh');
      // Safety: you may only connect YOUR OWN mailbox. The Google account
      // approved must match your portal email, or we refuse to store it.
      if (entry.email && result.email && result.email.toLowerCase() !== entry.email.toLowerCase()) {
        db.writeAudit({ actorId: entry.userId, actorName: entry.name, action: 'gmail.connect.rejected', targetType: 'gmail', targetName: entry.name, metadata: { tried: result.email, expected: entry.email } }).catch(function () {});
        console.warn('[GMAIL] rejected mismatched connect: portal=' + entry.email + ' google=' + result.email);
        return done('wrongaccount');
      }
      await gmail.saveConnection(entry.userId, result);
      db.writeAudit({ actorId: entry.userId, actorName: entry.name, action: 'gmail.connected', targetType: 'gmail', targetName: entry.name, metadata: { mailbox: result.email || null } }).catch(function () {});
      console.log('[GMAIL] connected for ' + (entry.name || entry.userId));
      done('connected');
    } catch (e) {
      console.error('[GMAIL] connect failed:', e.message);
      done('failed');
    }
  });

  // Stage 3 verification: read YOUR OWN recent mail (read-only, self only).
  // Lets you confirm the Gmail tool works before any agent uses it.
  // Example: /api/gmail/preview?q=newer_than:7d
  router.get('/api/gmail/preview', authenticate, async (req, res) => {
    try {
      const result = await gmail.searchMail(req.session.userId, {
        query: String(req.query.q || ''),
        maxResults: 8,
        includeBody: false,
      });
      res.json(result);
    } catch (e) {
      console.error('[GMAIL] preview failed:', e.message);
      res.status(500).json({ error: 'Could not read mail.' });
    }
  });

  // Forget this user's Gmail permission.
  router.post('/api/gmail/disconnect', authenticate, async (req, res) => {
    try {
      await gmail.deleteConnection(req.session.userId);
      db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'gmail.disconnected', targetType: 'gmail', targetName: req.session.name, metadata: {} }).catch(function () {});
      res.json({ ok: true });
    } catch (e) {
      console.error('[GMAIL] disconnect failed:', e.message);
      res.status(500).json({ error: 'Could not disconnect Gmail.' });
    }
  });

  return router;
};
