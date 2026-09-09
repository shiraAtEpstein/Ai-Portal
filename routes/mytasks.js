'use strict';

var express = require('express');
var router = express.Router();
var taskHub = require('../lib/task-hub');
var { authenticate } = require('../lib/sessions');

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
