'use strict';

var express = require('express');
var router = express.Router();
var taskHub = require('../lib/task-hub');
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
//
// 2026-09-15 (Shira): mytasks.html now calls POST /refresh on its own every
// 45s in the background (so new WhatsApp/email candidates show up without a
// manual click, matching the shared Board's live feel) instead of only on an
// explicit button press. The old 2-minute cooldown was sized for "a person
// mashing the button" and would have silently blocked most of those
// automatic calls with a 429. Lowered to comfortably clear one 45s tick
// (with margin for multiple open tabs / a manual click landing between
// ticks) while still stopping a runaway loop from hammering this every
// request. isNewCandidate() inside refreshTasks() already skips anything
// already triaged, so a poll that finds nothing new is cheap — the cost that
// matters (the AI triage call) only happens for genuinely new messages.
var lastRefresh = {};
var REFRESH_COOLDOWN_MS = 30 * 1000;

router.get('/', async function (req, res) {
  try {
    var tasks = await taskHub.listTasks(req.session.userId);
    res.json({ tasks: tasks });
  } catch (e) {
    console.error('[mytasks] GET / failed', e);
    res.status(500).json({ error: 'failed to load tasks' });
  }
});

// 2026-09-15 (Shira): the "Team view" toggle used to call GET /admin/all
// the instant it was opened — every open task from every user in one
// request — just to draw the person-chips row. Slow, and gave no loading
// feedback, so admins would click the toggle repeatedly thinking it hadn't
// registered. Replaced with a dropdown: GET /admin/roster loads a cheap
// roster+count first (this is what opening Team view now fetches), then
// GET /admin/user/:id loads just the ONE person picked from the dropdown.
// GET /admin/all itself is kept, unchanged, for the dropdown's explicit
// "everyone" choice — still available, just no longer automatic.

// GET /api/mytasks/admin/roster — admin-only, cheap. Active staff with an
// open-task COUNT per person (one aggregate query — no task rows), so the
// Team view dropdown can populate instantly without loading anyone's actual
// tasks until a specific person is chosen.
router.get('/admin/roster', authenticate, requireAdmin, async function (req, res) {
  try {
    var users = await taskHub.listTeamRoster();
    res.json({ users: users });
  } catch (e) {
    console.error('[mytasks] GET /admin/roster failed', e);
    res.status(500).json({ error: 'failed to load team roster' });
  }
});

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/mytasks/admin/user/:id — admin-only. Just the one person's open
// tasks (what the dropdown fetches on selection), reusing the exact same
// query the owner-scoped GET / already runs (taskHub.listTasks) for an
// admin-chosen id instead of req.session.userId. Rows carry no
// user_name/user_email — the dropdown already has that from the roster it
// loaded, and adds it back on the client before rendering.
router.get('/admin/user/:id', authenticate, requireAdmin, async function (req, res) {
  var id = req.params.id;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  try {
    var tasks = await taskHub.listTasks(id);
    res.json({ tasks: tasks });
  } catch (e) {
    console.error('[mytasks] GET /admin/user/:id failed', e);
    res.status(500).json({ error: 'failed to load tasks for user' });
  }
});

// GET /api/mytasks/admin/all — admin-only. Every open task from every user,
// plus the active staff roster. Kept for the Team view dropdown's explicit
// "everyone" option — no longer fetched automatically just from opening
// Team view (see GET /admin/roster above for that). An admin can mutate
// another user's task (edit/reprioritize, never mark done) via
// PATCH /admin/:id below, regardless of which of these three GET routes
// loaded it.
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
