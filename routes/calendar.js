const express = require('express');
const crypto = require('crypto');
const { authenticate } = require('../lib/sessions');
const calendar = require('../lib/calendar');
const db = require('../db');

module.exports = function createCalendarRouter() {
  const router = express.Router();

  const stateStore = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of stateStore) if (v.exp < now) stateStore.delete(k);
  }, 5 * 60 * 1000);
  if (sweep.unref) sweep.unref();

  router.get('/api/calendar/status', authenticate, async (req, res) => {
    if (!calendar.configured()) return res.json({ configured: false, connected: false });
    try {
      const conn = await calendar.getConnection(req.session.userId);
      res.json({ configured: true, connected: !!conn, email: conn ? conn.email : null });
    } catch (e) {
      console.error('[CALENDAR] status failed:', e.message);
      res.json({ configured: true, connected: false });
    }
  });

  router.get('/api/calendar/connect', authenticate, async (req, res) => {
    if (!calendar.configured()) return res.status(503).send('Calendar connection is not configured.');
    let email = null;
    try { email = await calendar.getUserEmail(req.session.userId); } catch (e) { /* ignore */ }
    const state = crypto.randomBytes(16).toString('hex');
    stateStore.set(state, { userId: req.session.userId, name: req.session.name, email: email, exp: Date.now() + 10 * 60 * 1000 });
    res.redirect(calendar.consentUrl(state));
  });

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

  router.get('/api/calendar/preview', authenticate, async (req, res) => {
    try {
      const result = await calendar.listEvents(req.session.userId, { maxResults: 8 });
      res.json(result);
    } catch (e) {
      console.error('[CALENDAR] preview failed:', e.message);
      res.status(500).json({ error: 'Could not read calendar.' });
    }
  });

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
