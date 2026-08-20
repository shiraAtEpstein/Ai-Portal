// ============================================================
// routes/staff-response.js — admin-only staff response-time dashboard API.
//
//   GET  /api/admin/staff-response?windowDays=30
//        -> JSON consumed by public/staff-response.html
//   GET  /api/admin/staff-response/email-preview[?windowDays=30]
//        -> renders the DAILY EMAIL in the browser. Sends nothing.
//   POST /api/admin/staff-response/send-report[?to=addr][&windowDays=30]
//        -> sends it now. With ?to= it goes ONLY there, as a test.
//
// Read-only apart from the explicit send. Reuses lib/staff-response
// (processing_jobs history + the live board). Admin-gated, same idiom as
// routes/unanswered.js.
//
// NOTE: there is no `targetHours` parameter any more. The response-time target
// was removed on 2026-08-20 — people are compared to the firm's own median, not
// to an SLA. A stray ?targetHours= in an old bookmark is simply ignored.
// ============================================================
const express = require('express');
const { authenticate, requireAdmin } = require('../lib/sessions');
const { buildStaffResponse } = require('../lib/staff-response');
const { renderStaffReportHtml, sendStaffReport, reportRecipients } = require('../lib/staff-response-email');

function windowDaysFrom(req) {
  const n = parseInt((req.query && req.query.windowDays) || (req.body && req.body.windowDays), 10);
  return Math.min(180, Math.max(1, Number.isFinite(n) ? n : 30));
}

module.exports = function createStaffResponseRouter() {
  const router = express.Router();

  router.get('/api/admin/staff-response', authenticate, requireAdmin, async (req, res) => {
    try {
      const data = await buildStaffResponse({ windowDays: windowDaysFrom(req) });
      res.json(data);
    } catch (e) {
      console.error('[staff-response] failed:', e.message);
      res.status(500).json({ error: 'failed to build staff response report' });
    }
  });

  // See exactly what the 08:15 email will look like, with today's real numbers,
  // without sending anything. Open it in the browser.
  router.get('/api/admin/staff-response/email-preview', authenticate, requireAdmin, async (req, res) => {
    try {
      const data = await buildStaffResponse({ windowDays: windowDaysFrom(req) });
      const html = renderStaffReportHtml({
        data,
        recipientName: (req.session && req.session.name) || '',
      });
      res.type('html').send(html);
    } catch (e) {
      console.error('[staff-response] email preview failed:', e.message);
      res.status(500).json({ error: 'failed to render the report email', detail: e.message });
    }
  });

  // Send it now. ?to=someone@epsteinlaw.co.il -> TEST MODE: that address only,
  // "[בדיקה]" subject, nobody else receives anything.
  router.post('/api/admin/staff-response/send-report', authenticate, requireAdmin, async (req, res) => {
    try {
      const testEmail = (req.query && req.query.to) || (req.body && req.body.to) || null;
      const result = await sendStaffReport({ windowDays: windowDaysFrom(req), testEmail });
      res.json({ ok: true, defaultRecipients: reportRecipients(), ...result });
    } catch (e) {
      console.error('[staff-response] send-report failed:', e.message);
      res.status(500).json({ error: 'failed to send the report email', detail: e.message });
    }
  });

  return router;
};
