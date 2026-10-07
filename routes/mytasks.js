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
    var tasks = await taskHub.listTasks(req.session.userId, { doneToday: true });
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

// 6 Oct: admin — read everyone's sent mail now (Gmail only, no AI). Background.
router.post('/admin/read-sent-all', authenticate, requireAdmin, async function (req, res) {
  try {
    await taskHub.listTeamRoster(); // makes sure the tables exist
    res.json(taskHub.readSentForAll());
  } catch (e) {
    console.error('[mytasks] read-sent-all failed', e);
    res.status(500).json({ error: 'failed' });
  }
});

// 7 Oct (Shira): "does it only update when she refreshes, not me in her name?"
// Admin, Team view: run the same refresh for the person chosen in the dropdown
// (their Gmail, WhatsApp, monday — the same checks as their own Refresh).
// Waits up to TASK_HUB_REFRESH_WAIT_SECONDS; if longer, it keeps going in the
// background and the next load shows the rest.
router.post('/admin/user/:id/refresh', authenticate, requireAdmin, async function (req, res) {
  var id = req.params.id;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  var now = Date.now();
  if (lastRefresh[id] && now - lastRefresh[id] < REFRESH_COOLDOWN_MS) {
    return res.status(429).json({ error: 'refreshed too recently, try again shortly' });
  }
  lastRefresh[id] = now;
  try {
    var waitMs = Math.max(5, parseInt(process.env.TASK_HUB_REFRESH_WAIT_SECONDS || '25', 10)) * 1000;
    var run = taskHub.refreshTasks(id);
    run.catch(function (e) { console.error('[mytasks] admin refresh failed', id, e && e.message); });
    var timer;
    var outcome = await Promise.race([
      run.then(function () { return { done: true }; }),
      new Promise(function (resolve) { timer = setTimeout(function () { resolve({ done: false }); }, waitMs); })
    ]);
    clearTimeout(timer);
    res.json({ ok: true, done: outcome.done });
  } catch (e) {
    console.error('[mytasks] POST /admin/user/:id/refresh failed', e);
    res.status(500).json({ error: 'refresh failed' });
  }
});

// 7 Oct (Shira): "הצעה לביצוע". Made only when someone opens the task's
// details, then saved — one AI call per task. { fresh: true } makes a new one
// ("הצעה חדשה"). { cachedOnly: true } only reads a saved one. Owner, or an admin.
var taskSuggest = require('../lib/task-suggest');
function isAdminReq(req) {
  return ((req.session && req.session.roles) || []).some(function (r) { return String(r).toLowerCase() === 'admin'; });
}
var _suggesting = {};
router.post('/:id/suggest', async function (req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  var body = req.body || {};
  if (_suggesting[id] && !body.cachedOnly) return res.status(409).json({ error: 'already being made' });
  if (!body.cachedOnly) _suggesting[id] = true;
  try {
    var r = await taskSuggest.getSuggestion(id, req.session.userId, {
      fresh: !!body.fresh, cachedOnly: !!body.cachedOnly, isAdmin: isAdminReq(req), by: req.session.email || null });
    if (r.error) return res.status(r.status || 500).json({ error: r.error });
    res.json(r);
  } catch (e) {
    console.error('[mytasks] POST /:id/suggest failed', e);
    res.status(500).json({ error: 'suggestion failed' });
  } finally { delete _suggesting[id]; }
});
router.post('/:id/suggest/feedback', async function (req, res) {
  var id = parseInt(req.params.id, 10);
  try {
    var ok = await taskSuggest.setFeedback(id, req.session.userId, isAdminReq(req), (req.body || {}).vote);
    res.status(ok ? 200 : 404).json({ ok: ok });
  } catch (e) { res.status(500).json({ error: 'failed' }); }
});
// Saves the draft in the task owner's own Gmail Drafts (never sends).
router.post('/:id/suggest/gmail-draft', async function (req, res) {
  var id = parseInt(req.params.id, 10);
  try {
    var r = await taskSuggest.saveGmailDraft(id, req.session.userId, req.body || {});
    res.status(r.ok ? 200 : (r.status || (r.scope ? 403 : 500))).json(r);
  } catch (e) {
    console.error('[mytasks] gmail-draft failed', e);
    res.status(500).json({ ok: false, error: 'failed' });
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
    // 2026-10-04: the button used to wait for the whole pipeline (monday scan,
    // Gmail, WhatsApp, then every AI triage call). With a stuck Gmail socket
    // or many emails that took minutes. Now it waits at most
    // TASK_HUB_REFRESH_WAIT_SECONDS (default 25); if the pull isn't finished,
    // it answers with the tasks saved so far and the pull keeps going in the
    // background. Anything it finds appears on the next load or Refresh.
    var waitMs = Math.max(5, parseInt(process.env.TASK_HUB_REFRESH_WAIT_SECONDS || '25', 10)) * 1000;
    var run = taskHub.refreshTasks(userId);
    run.catch(function (e) { console.error('[mytasks] background refresh failed', e && e.message); });
    var timer;
    var outcome = await Promise.race([
      run.then(function (counts) { return { done: true, counts: counts }; }),
      new Promise(function (resolve) { timer = setTimeout(function () { resolve({ done: false }); }, waitMs); })
    ]);
    clearTimeout(timer);
    if (!outcome.done) console.log('[mytasks] refresh still running after ' + (waitMs / 1000) + 's for user ' + userId + ' — answering with saved tasks');
    var tasks = await taskHub.listTasks(userId);
    res.json({ pulled: outcome.done ? outcome.counts : null, stillPulling: !outcome.done, tasks: tasks });
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

// 6 Oct: "choose a deal" on a card — body { deal_id } (one of the task's
// candidates) or { deal_id: null } for "none of these".
// 6 Oct: link a task to a monday deal from the card (choose / search).
function dealHandler(asAdmin) {
  return async function (req, res) {
    var id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
    var dealId = req.body && req.body.deal_id ? String(req.body.deal_id) : null;
    var remove = !!(req.body && req.body.remove);
    try {
      var task = remove
        ? await taskHub.removeDealFromTask(req.session.userId, id, dealId, { asAdmin: asAdmin })
        : await taskHub.chooseDealForTask(req.session.userId, id, dealId, { asAdmin: asAdmin, add: !!(req.body && req.body.add) });
      if (!task) return res.status(404).json({ error: 'not found' });
      res.json({ task: task });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error('[mytasks] POST deal failed', e);
      res.status(500).json({ error: 'update failed' });
    }
  };
}
// 6 Oct: save a WhatsApp group's invite link from the card.
function groupLinkHandler(asAdmin) {
  return async function (req, res) {
    var id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
    try {
      var task = await taskHub.setGroupLink(req.session.userId, id, req.body && req.body.link, { asAdmin: asAdmin });
      if (!task) return res.status(404).json({ error: 'not found' });
      res.json({ task: task });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error('[mytasks] POST group-link failed', e);
      res.status(500).json({ error: 'update failed' });
    }
  };
}
router.get('/deals/search', async function (req, res) {
  try {
    res.json({ deals: await taskHub.searchDeals(String(req.query.q || '').slice(0, 80)) });
  } catch (e) {
    console.error('[mytasks] deal search failed', e.message);
    res.status(502).json({ error: 'monday search failed' });
  }
});
router.post('/admin/:id/deal', authenticate, requireAdmin, dealHandler(true));
router.post('/admin/:id/group-link', authenticate, requireAdmin, groupLinkHandler(true));
router.post('/:id/deal', dealHandler(false));
router.post('/:id/group-link', groupLinkHandler(false));

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
