// ============================================================
// routes/daily.js — server-side completion for the 'Today' panel.
// Stores which daily tasks each user has ticked, per day, so completion
// survives a refresh, a new device, and a browser-cache clear (localStorage
// on the client is now only a fast cache / offline fallback).
//
//   GET  /api/daily/completions?day=YYYY-MM-DD  -> { day, keys: [taskKey,...] }
//   POST /api/daily/complete { day, key, done }  -> { ok:true }
//
// Everything is scoped strictly to the signed-in user (req.session.userId).
// The table is created lazily on first use (idempotent) so this ships without
// a separate migration step. Uses the shared pool via db.getPool().
// ============================================================
const express = require('express');
const db = require('../db');
const { authenticate } = require('../lib/sessions');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_KEY = 500;

// Create the table once per process (best-effort, idempotent). If it fails we
// reset the promise so a later request can retry rather than caching failure.
let _ready = null;
function ensureTable() {
  const p = db.getPool();
  if (!p) return Promise.resolve(false);
  if (_ready) return _ready;
  _ready = p.query(
    'CREATE TABLE IF NOT EXISTS daily_completions (' +
    '  user_id  uuid        NOT NULL,' +
    '  day      date        NOT NULL,' +
    '  task_key text        NOT NULL,' +
    '  done_at  timestamptz NOT NULL DEFAULT now(),' +
    '  PRIMARY KEY (user_id, day, task_key)' +
    ')'
  ).then(function () { return true; })
   .catch(function (e) { console.error('[DAILY] ensureTable failed:', e.message); _ready = null; return false; });
  return _ready;
}

module.exports = function createDailyRouter() {
  const router = express.Router();

  // Which task keys has this user ticked for the given day?
  router.get('/api/daily/completions', authenticate, async function (req, res) {
    const day = String((req.query && req.query.day) || '').trim();
    if (!DAY_RE.test(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    try {
      const ok = await ensureTable();
      if (!ok) return res.json({ day: day, keys: [] }); // DB unavailable — client falls back to local cache
      const p = db.getPool();
      const r = await p.query(
        'SELECT task_key FROM daily_completions WHERE user_id = $1 AND day = $2',
        [req.session.userId, day]);
      res.json({ day: day, keys: r.rows.map(function (row) { return row.task_key; }) });
    } catch (e) {
      console.error('[DAILY] load failed:', e.message);
      res.status(500).json({ error: 'Could not load your completions.' });
    }
  });

  // Mark one task done / not-done for a day. Idempotent.
  router.post('/api/daily/complete', authenticate, async function (req, res) {
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const day = String(b.day || '').trim();
    const key = String(b.key || '').trim();
    const done = (b.done === true || b.done === 'true');
    if (!DAY_RE.test(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    if (!key || key.length > MAX_KEY) return res.status(400).json({ error: 'invalid task key' });
    try {
      const ok = await ensureTable();
      if (!ok) return res.status(503).json({ error: 'Storage unavailable.' });
      const p = db.getPool();
      if (done) {
        await p.query(
          'INSERT INTO daily_completions (user_id, day, task_key) VALUES ($1, $2, $3) ' +
          'ON CONFLICT (user_id, day, task_key) DO NOTHING',
          [req.session.userId, day, key]);
      } else {
        await p.query(
          'DELETE FROM daily_completions WHERE user_id = $1 AND day = $2 AND task_key = $3',
          [req.session.userId, day, key]);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[DAILY] save failed:', e.message);
      res.status(500).json({ error: 'Could not save.' });
    }
  });

  return router;
};
