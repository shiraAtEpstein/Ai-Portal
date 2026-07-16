// ============================================================
// routes/calendar.js — connect / disconnect a user's own Google Calendar.
//
// Mirrors routes/gmail.js. Endpoints:
//   GET  /api/calendar/status      -> { configured, connected, email, canWrite }
//   GET  /api/calendar/connect     -> redirect to Google's consent screen
//   GET  /auth/calendar/callback   -> Google returns here; we save the token
//   GET  /api/calendar/preview     -> read YOUR OWN upcoming events (self test)
//   POST /api/calendar/disconnect  -> forget this user's Calendar permission
//
// The connect/disconnect/status endpoints require a logged-in session.
// The callback is matched to the right user via a short-lived `state`
// value created at connect time (not by trusting the request).
// ============================================================
const express = require('express');
const crypto = require('crypto');
const { authenticate } = require('../lib/sessions');
const calendar = require('../lib/calendar');
const db = require('../db');

module.exports = function createCalendarRouter() {
  const router = express.Router();

  // state -> { userId, name, email, exp }. Ties Google's callback back to the
  // user who started the flow. Entries expire after 10 minutes.
  const stateStore = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of stateStore) if (v.exp < now) stateStore.delete(k);
  }, 5 * 60 * 1000);
  if (sweep.unref) sweep.unref();

  // Is the current user connected?
  router.get('/api/calendar/status', authenticate, async (req, res) => {
    if (!calendar.configured()) return res.json({ configured: false, connected: false });
    try {
      const st = await calendar.connectionStatus(req.session.userId);
      res.json({ configured: true, connected: st.connected, email: st.email, canWrite: st.canWrite });
    } catch (e) {
      console.error('[CALENDAR] status failed:', e.message);
      res.json({ configured: true, connected: false, canWrite: false });
    }
  });

  // Begin the connect flow.
  router.get('/api/calendar/connect', authenticate, async (req, res) => {
    if (!calendar.configured()) return res.status(503).send('Calendar connection is not configured.');
    let email = null;
    try { email = await calendar.getUserEmail(req.session.userId); } catch (e) { /* ignore */ }
    const state = crypto.randomBytes(16).toString('hex');
    stateStore.set(state, { userId: req.session.userId, name: req.session.name, email: email, exp: Date.now() + 10 * 60 * 1000 });
    res.redirect(calendar.consentUrl(state));
  });

  // Google redirects here after the user approves (or denies).
  router.get('/auth/calendar/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const done = (status) => res.redirect('/#calendar=' + encodeURIComponent(status));
    if (error) return done('denied');
    const entry = state && stateStore.get(state);
    if (!code || !entry) return done('expired');
    stateStore.delete(state);
    try {
      const result = await calendar.exchangeCode(code);
      if (!result.refreshToken) return done('noRefresh');
      // Safety: you may only connect YOUR OWN calendar. The Google account
      // approved must match your portal email, or we refuse to store it.
      if (entry.email && result.email && result.email.toLowerCase() !== entry.email.toLowerCase()) {
        db.writeAudit({ actorId: entry.userId, actorName: entry.name, action: 'calendar.connect.rejected', targetType: 'calendar', targetName: entry.name, metadata: { tried: result.email, expected: entry.email } }).catch(function () {});
        console.warn('[CALENDAR] rejected mismatched connect: portal=' + entry.email + ' google=' + result.email);
        return done('wrongaccount');
      }
      await calendar.saveConnection(entry.userId, result);
      db.writeAudit({ actorId: entry.userId, actorName: entry.name, action: 'calendar.connected', targetType: 'calendar', targetName: entry.name, metadata: { calendar: result.email || null } }).catch(function () {});
      console.log('[CALENDAR] connected for ' + (entry.name || entry.userId));
      done('connected');
    } catch (e) {
      console.error('[CALENDAR] connect failed:', e.message);
      done('failed');
    }
  });

  // Self test: read YOUR OWN upcoming events (read-only, self only).
  // Example: /api/calendar/preview
  router.get('/api/calendar/preview', authenticate, async (req, res) => {
    try {
      const result = await calendar.listEvents(req.session.userId, {
        query: String(req.query.q || ''),
        maxResults: 8,
      });
      res.json(result);
    } catch (e) {
      console.error('[CALENDAR] preview failed:', e.message);
      res.status(500).json({ error: 'Could not read calendar.' });
    }
  });

  // Forget this user's Calendar permission.
  router.post('/api/calendar/disconnect', authenticate, async (req, res) => {
    try {
      await calendar.deleteConnection(req.session.userId);
      db.writeAudit({ actorId: req.session.userId, actorName: req.session.name, action: 'calendar.disconnected', targetType: 'calendar', targetName: req.session.name, metadata: {} }).catch(function () {});
      res.json({ ok: true });
    } catch (e) {
      console.error('[CALENDAR] disconnect failed:', e.message);
      res.status(500).json({ error: 'Could not disconnect Calendar.' });
    }
  });

  return router;
};
