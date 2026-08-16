// ============================================================
// routes/staff-response.js — admin-only staff response-time dashboard API.
//
//   GET /api/admin/staff-response?windowDays=30&targetHours=3
//     -> JSON consumed by public/staff-response.html
//
// Read-only. Reuses lib/staff-response (processing_jobs history + the live
// board). Admin-gated, same idiom as routes/unanswered.js.
// ============================================================
const express = require('express');
const { authenticate, requireAdmin } = require('../lib/sessions');
const { buildStaffResponse } = require('../lib/staff-response');

module.exports = function createStaffResponseRouter() {
  const router = express.Router();

  router.get('/api/admin/staff-response', authenticate, requireAdmin, async (req, res) => {
    try {
      const windowDays = Math.min(180, Math.max(1, parseInt(req.query.windowDays, 10) || 30));
      const targetHours = Math.min(48, Math.max(1, parseInt(req.query.targetHours, 10) || 3));
      const data = await buildStaffResponse({ windowDays, targetHours });
      res.json(data);
    } catch (e) {
      console.error('[staff-response] failed:', e.message);
      res.status(500).json({ error: 'failed to build staff response report' });
    }
  });

  return router;
};
