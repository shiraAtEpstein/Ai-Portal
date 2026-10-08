'use strict';
// ============================================================
// routes/task-agents.js — the agent cards and the learning log (8 Oct 2026).
// Admin only. Every admin can change a card, approve / reject a lesson, or run
// the learning now (TASK_LEARNING_APPROVERS can narrow that to named people).
// ============================================================
var express = require('express');
var router = express.Router();
var { authenticate, requireAdmin } = require('../lib/sessions');
var learning = require('../lib/task-learning');

router.use(authenticate, requireAdmin);

function approverOnly(req, res, next) {
  if (!learning.canApprove(req.session.email, true)) return res.status(403).json({ error: 'אין לך הרשאה לשנות (TASK_LEARNING_APPROVERS)' });
  next();
}
function wrap(fn) {
  return async function (req, res) {
    try { res.json(await fn(req)); }
    catch (e) { console.error('[task-agents]', req.method, req.path, e); res.status(500).json({ error: 'failed' }); }
  };
}

router.get('/me', wrap(async function (req) {
  return { canApprove: learning.canApprove(req.session.email, true), categories: learning.CATEGORIES, sources: learning.SOURCES, state: await learning.state() };
}));
router.get('/agents', wrap(async function () { return { agents: await learning.listAgents() }; }));
router.put('/agents/:key', approverOnly, wrap(async function (req) {
  return learning.saveAgent(req.params.key, req.body || {}, req.session.email);
}));
router.get('/lessons', wrap(async function (req) {
  var st = ['proposed', 'approved', 'rejected', 'retired'].indexOf(req.query.status) !== -1 ? req.query.status : null;
  return { lessons: await learning.listLessons(st) };
}));
router.post('/lessons/:id/:action', approverOnly, wrap(async function (req) {
  return learning.decideLesson(parseInt(req.params.id, 10), req.params.action, req.body || {}, req.session.email);
}));
router.get('/feedback', wrap(async function (req) { return { feedback: await learning.listFeedback(req.query.limit) }; }));
var _running = false;
router.post('/run', approverOnly, wrap(async function (req) {
  if (_running) return { ok: false, error: 'כבר רץ' };
  _running = true;
  try { return Object.assign({ ok: true }, await learning.runNow(req.session.email)); } finally { _running = false; }
}));

module.exports = router;
