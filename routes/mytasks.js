'use strict';

var express = require('express');
var router = express.Router();
var taskHub = require('../lib/task-hub');
var taskEvents = require('../lib/task-events');
var db = require('../db');
var { authenticate, requireAdmin } = require('../lib/sessions');

/**
 * Auth-gated, per-user Task Hub endpoints. Generic — works for whoever is
 * signed in, not hardcoded to one person. Uses the same `authenticate`
 * middleware and req.session.userId shape as routes/daily.js. Mount in
 * server.js:
 *
 *   app.use('/api/mytasks', require('./routes/mytasks'));
 */

router.use(authenticate);

// simple in-process rate limit for refresh, per user — matches the portal's
// existing in-process (no separate job queue) style.
var lastRefresh = {};
var REFRESH_COOLDOWN_MS = 2 * 60 * 1000;

router.get('/', async function (req, res) {
  try {
    var tasks = await taskHub.listTasks(req.session.userId);
    res.json({ tasks: tasks });
  } catch (e) {
    console.error('[mytasks] GET / failed', e);
    res.status(500).json({ error: 'failed to load tasks' });
  }
});

// GET /api/mytasks/admin/all — admin-only. Every open task from every user,
// plus the active staff roster (so someone with zero open tasks still shows
// up as a name to click), for the "Team view" toggle inside mytasks.html.
// Read-only itself; an admin can mutate another user's task (edit/reprioritize,
// never mark done) via PATCH /admin/:id below.
router.get('/admin/all', authenticate, requireAdmin, async function (req, res) {
  try {
    var tasks = await taskHub.listAllTasks();
    var allUsers = await db.listAllUsers();
    var users = allUsers
      .filter(function (u) { return u.status === 'active'; })
      .map(function (u) { return { id: u.id, name: u.name, email: u.email }; });
    res.json({ tasks: tasks, users: users });
  } catch (e) {
    console.error('[mytasks] GET /admin/all failed', e);
    res.status(500).json({ error: 'failed to load team tasks' });
  }
});

// PATCH /api/mytasks/admin/:id — admin-only. Lets an admin edit a task's
// title/estimate or override its priority for ANY user's task, from the
// "Team view" in mytasks.html — same field whitelist as the owner-only
// PATCH /:id below. Deliberately has no admin equivalent for done/toggle:
// POST /:id/toggle (further down) stays scoped to req.session.userId only,
// so this route can never be used to mark someone else's task as done.
router.patch('/admin/:id', authenticate, requireAdmin, async function (req, res) {
  var id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  var fields = {};
  if (typeof req.body.title === 'string') fields.title = req.body.title;
  if (req.body.estimated_minutes !== undefined) fields.estimated_minutes = parseInt(req.body.estimated_minutes, 10);
  if (typeof req.body.priority === 'string') fields.priority = req.body.priority;
  try {
    var task = await taskHub.patchTaskAsAdmin(id, fields);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json({ task: task });
  } catch (e) {
    console.error('[mytasks] PATCH /admin/:id failed', e);
    res.status(500).json({ error: 'update failed' });
  }
});

// GET /api/mytasks/stream — Server-Sent Events (2026-09-14). Pushes a task
// the instant it's created by a real-time extraction (a message landing in
// a linked WhatsApp task-inbox group — see lib/task-hub.js's
// processRealtimeManualMessage and lib/task-events.js), instead of the
// signed-in user having to wait for the next 45s poll or click refresh.
// Protected by the same `authenticate` as every other route in this file
// (router.use(authenticate) above) — the browser's EventSource sends the
// portal_session cookie automatically on this same-origin request, no
// extra wiring needed.
// Additive only: if this connection never opens (older client, a proxy
// that kills long-lived responses) mytasks.html's existing 45s poll and
// refresh button keep working exactly as before.
router.get('/stream', function (req, res) {
  var userId = req.session.userId;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');

  var unsubscribe = taskEvents.subscribe(userId, function (task) {
    res.write('event: task\ndata: ' + JSON.stringify(task) + '\n\n');
  });

  // Idle-timeout insurance for whatever sits in front of this on Render —
  // a comment line, ignored by EventSource, just proof the connection is alive.
  var keepAlive = setInterval(function () { res.write(': ping\n\n'); }, 25000);

  req.on('close', function () {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

router.post('/refresh', async function (req, res) {
  var userId = req.session.userId;
  var now = Date.now();
  if (lastRefresh[userId] && now - lastRefresh[userId] < REFRESH_COOLDOWN_MS) {
    return res.status(429).json({ error: 'refreshed too recently, try again shortly' });
  }
  lastRefresh[userId] = now;
  try {
    var counts = await taskHub.refreshTasks(userId);
    var tasks = await taskHub.listTasks(userId);
    res.json({ pulled: counts, tasks: tasks });
  } catch (e) {
    console.error('[mytasks] POST /refresh failed', e);
    res.status(500).json({ error: 'refresh failed' });
  }
});

router.post('/chat', async function (req, res) {
  var text = ((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > 500) return res.status(400).json({ error: 'text too long' });
  try {
    var task = await taskHub.addManualTask(req.session.userId, text);
    res.json({ task: task });
  } catch (e) {
    console.error('[mytasks] POST /chat failed', e);
    res.status(500).json({ error: 'could not add task' });
  }
});

router.patch('/:id', async function (req, res) {
  var id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  var fields = {};
  if (typeof req.body.title === 'string') fields.title = req.body.title;
  if (req.body.estimated_minutes !== undefined) fields.estimated_minutes = parseInt(req.body.estimated_minutes, 10);
  if (typeof req.body.priority === 'string') fields.priority = req.body.priority;
  try {
    var task = await taskHub.patchTask(req.session.userId, id, fields);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json({ task: task });
  } catch (e) {
    console.error('[mytasks] PATCH /:id failed', e);
    res.status(500).json({ error: 'update failed' });
  }
});

router.post('/:id/toggle', async function (req, res) {
  var id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  try {
    var task = await taskHub.toggleTask(req.session.userId, id);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json({ task: task });
  } catch (e) {
    console.error('[mytasks] POST /:id/toggle failed', e);
    res.status(500).json({ error: 'toggle failed' });
  }
});

module.exports = router;
