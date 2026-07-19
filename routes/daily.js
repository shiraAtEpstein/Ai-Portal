// ============================================================
// routes/daily.js — server-side state for the 'Today' panel.
//
// Per-user: the generated task list (cached per day), which tasks have been
// HANDLED (permanent), and which are snoozed. Scoped strictly to the signed-in
// user (req.session.userId). Tables are created lazily (idempotent).
//
//   GET  /api/daily/tasks?day=YYYY-MM-DD
//        -> { day, tasks: [...]|null, generatedAt, runs, remaining }
//   POST /api/daily/tasks/claim { day }   -> { ok, runs, remaining } | 429
//   POST /api/daily/tasks { day, tasks }  -> { ok, generatedAt }
//
//   GET  /api/daily/completions?day=YYYY-MM-DD
//        -> { day, keys: [done today], handled: [ever handled], snoozed: [...] }
//   POST /api/daily/complete  { key, done }   -> { ok:true }
//   POST /api/daily/snooze    { key, until }  -> { ok:true }
//
// HANDLED IS PERMANENT. Ticking a task means "I've taken care of this" — it must
// never come back, without the user having to also delete the email or move the
// monday item. So daily_handled is keyed by (user_id, task_key) with NO day
// column: once handled, always hidden. Un-ticking deletes the row, which is the
// undo. `keys` (handled today) drives the progress ring; `handled` drives
// suppression.
//
// Why the cache: generating the list runs the 'daily' agent across the user's
// email, calendar and monday boards — slow and expensive. It runs at most
// MAX_RUNS times per user per day, claimed BEFORE the call so the cap bites.
// ============================================================
const express = require('express');
const db = require('../db');
const { authenticate } = require('../lib/sessions');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_KEY = 500;
const MAX_RUNS = 30;
const MAX_PAYLOAD = 100000;

let _ready = null;
function ensureTables() {
  const p = db.getPool();
  if (!p) return Promise.resolve(false);
  if (_ready) return _ready;
  _ready = p.query(
    // Permanent "I've handled this" marker. No day column on purpose.
    'CREATE TABLE IF NOT EXISTS daily_handled (' +
    '  user_id    uuid        NOT NULL,' +
    '  task_key   text        NOT NULL,' +
    '  handled_at timestamptz NOT NULL DEFAULT now(),' +
    '  PRIMARY KEY (user_id, task_key)' +
    ')'
  ).then(function () {
    return p.query(
      'CREATE TABLE IF NOT EXISTS daily_snoozes (' +
      '  user_id    uuid        NOT NULL,' +
      '  task_key   text        NOT NULL,' +
      '  until      date        NOT NULL,' +
      '  created_at timestamptz NOT NULL DEFAULT now(),' +
      '  PRIMARY KEY (user_id, task_key)' +
      ')');
  }).then(function () {
    return p.query(
      'CREATE TABLE IF NOT EXISTS daily_tasks (' +
      '  user_id      uuid NOT NULL,' +
      '  day          date NOT NULL,' +
      '  payload      jsonb,' +
      '  runs         int  NOT NULL DEFAULT 0,' +
      '  generated_at timestamptz,' +
      '  PRIMARY KEY (user_id, day)' +
      ')');
  }).then(function () { return true; })
    .catch(function (e) { console.error('[DAILY] ensureTables failed:', e.message); _ready = null; return false; });
  return _ready;
}

module.exports = function createDailyRouter() {
  const router = express.Router();

  // --- cached task list -------------------------------------------------

  router.get('/api/daily/tasks', authenticate, async function (req, res) {
    const day = String((req.query && req.query.day) || '').trim();
    if (!DAY_RE.test(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    try {
      const ok = await ensureTables();
      if (!ok) return res.json({ day: day, tasks: null, generatedAt: null, runs: 0, remaining: MAX_RUNS });
      const p = db.getPool();
      const r = await p.query(
        'SELECT payload, runs, generated_at FROM daily_tasks WHERE user_id = $1 AND day = $2',
        [req.session.userId, day]);
      const row = r.rows[0];
      res.json({
        day: day,
        tasks: row && row.payload ? row.payload : null,
        generatedAt: row ? row.generated_at : null,
        runs: row ? row.runs : 0,
        remaining: Math.max(0, MAX_RUNS - (row ? row.runs : 0)),
      });
    } catch (e) {
      console.error('[DAILY] tasks load failed:', e.message);
      res.status(500).json({ error: 'Could not load your day.' });
    }
  });

  // Claim one agent run BEFORE the expensive call. 429 when the cap is hit.
  // Conditional upsert => check-and-increment is atomic across racing tabs.
  router.post('/api/daily/tasks/claim', authenticate, async function (req, res) {
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const day = String(b.day || '').trim();
    if (!DAY_RE.test(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    try {
      const ok = await ensureTables();
      if (!ok) return res.status(503).json({ error: 'Storage unavailable.' });
      const p = db.getPool();
      const r = await p.query(
        'INSERT INTO daily_tasks (user_id, day, runs) VALUES ($1, $2, 1) ' +
        'ON CONFLICT (user_id, day) DO UPDATE SET runs = daily_tasks.runs + 1 ' +
        'WHERE daily_tasks.runs < $3 ' +
        'RETURNING runs',
        [req.session.userId, day, MAX_RUNS]);
      if (!r.rows[0]) {
        return res.status(429).json({ error: 'Daily limit reached.', runs: MAX_RUNS, remaining: 0, max: MAX_RUNS });
      }
      const runs = r.rows[0].runs;
      res.json({ ok: true, runs: runs, remaining: Math.max(0, MAX_RUNS - runs), max: MAX_RUNS });
    } catch (e) {
      console.error('[DAILY] claim failed:', e.message);
      res.status(500).json({ error: 'Could not start a refresh.' });
    }
  });

  router.post('/api/daily/tasks', authenticate, async function (req, res) {
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const day = String(b.day || '').trim();
    const tasks = b.tasks;
    if (!DAY_RE.test(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be an array' });
    let payload;
    try { payload = JSON.stringify(tasks); } catch (_) { return res.status(400).json({ error: 'tasks not serializable' }); }
    if (payload.length > MAX_PAYLOAD) return res.status(413).json({ error: 'task list too large' });
    try {
      const ok = await ensureTables();
      if (!ok) return res.status(503).json({ error: 'Storage unavailable.' });
      const p = db.getPool();
      const r = await p.query(
        'INSERT INTO daily_tasks (user_id, day, payload, runs, generated_at) VALUES ($1, $2, $3::jsonb, 1, now()) ' +
        'ON CONFLICT (user_id, day) DO UPDATE SET payload = EXCLUDED.payload, generated_at = now() ' +
        'RETURNING generated_at, runs',
        [req.session.userId, day, payload]);
      const row = r.rows[0] || {};
      res.json({ ok: true, generatedAt: row.generated_at || null, runs: row.runs || 0,
        remaining: Math.max(0, MAX_RUNS - (row.runs || 0)) });
    } catch (e) {
      console.error('[DAILY] tasks save failed:', e.message);
      res.status(500).json({ error: 'Could not save your day.' });
    }
  });

  // --- handled (permanent) + snoozes ------------------------------------

  // `handled` = every key this user has ever ticked -> suppressed for good.
  // `keys`    = the subset handled today -> drives today's progress ring.
  router.get('/api/daily/completions', authenticate, async function (req, res) {
    const day = String((req.query && req.query.day) || '').trim();
    if (!DAY_RE.test(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    try {
      const ok = await ensureTables();
      if (!ok) return res.json({ day: day, keys: [], handled: [], snoozed: [] });
      const p = db.getPool();
      const allR = await p.query(
        'SELECT task_key, handled_at FROM daily_handled WHERE user_id = $1',
        [req.session.userId]);
      const snzR = await p.query(
        'SELECT task_key FROM daily_snoozes WHERE user_id = $1 AND until > $2',
        [req.session.userId, day]);
      const handled = [], today = [];
      allR.rows.forEach(function (r) {
        handled.push(r.task_key);
        try {
          const d = new Date(r.handled_at);
          const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
          if (local === day) today.push(r.task_key);
        } catch (_) { /* ignore */ }
      });
      res.json({ day: day, keys: today, handled: handled,
        snoozed: snzR.rows.map(function (r) { return r.task_key; }) });
    } catch (e) {
      console.error('[DAILY] load failed:', e.message);
      res.status(500).json({ error: 'Could not load your day.' });
    }
  });

  // Tick = handled forever. Un-tick deletes the row (the undo).
  router.post('/api/daily/complete', authenticate, async function (req, res) {
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const key = String(b.key || '').trim();
    const done = (b.done === true || b.done === 'true');
    if (!key || key.length > MAX_KEY) return res.status(400).json({ error: 'invalid task key' });
    try {
      const ok = await ensureTables();
      if (!ok) return res.status(503).json({ error: 'Storage unavailable.' });
      const p = db.getPool();
      if (done) {
        await p.query(
          'INSERT INTO daily_handled (user_id, task_key) VALUES ($1, $2) ' +
          'ON CONFLICT (user_id, task_key) DO NOTHING',
          [req.session.userId, key]);
      } else {
        await p.query(
          'DELETE FROM daily_handled WHERE user_id = $1 AND task_key = $2',
          [req.session.userId, key]);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[DAILY] save failed:', e.message);
      res.status(500).json({ error: 'Could not save.' });
    }
  });

  router.post('/api/daily/snooze', authenticate, async function (req, res) {
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const key = String(b.key || '').trim();
    const until = String(b.until || '').trim();
    if (!key || key.length > MAX_KEY) return res.status(400).json({ error: 'invalid task key' });
    if (!DAY_RE.test(until)) return res.status(400).json({ error: 'until must be YYYY-MM-DD' });
    try {
      const ok = await ensureTables();
      if (!ok) return res.status(503).json({ error: 'Storage unavailable.' });
      const p = db.getPool();
      await p.query(
        'INSERT INTO daily_snoozes (user_id, task_key, until) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (user_id, task_key) DO UPDATE SET until = EXCLUDED.until, created_at = now()',
        [req.session.userId, key, until]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[DAILY] snooze failed:', e.message);
      res.status(500).json({ error: 'Could not snooze.' });
    }
  });

  return router;
};
