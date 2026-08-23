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

function isAdmin(req) {
  const roles = (req.session && req.session.roles) || [];
  return roles.some((r) => String(r).toLowerCase() === 'admin');
}

// Cut the full report down to what ONE person may see: their own row, plus the
// firm-wide baselines they are measured against. Everything that would name a
// colleague is dropped SERVER-SIDE — a page that merely hides other rows is not
// a permission, it is a suggestion, and the JSON is one devtools tab away.
//
// The firm aggregates stay: without the team median and the firm percentiles a
// personal number means nothing. They are counts and medians over the whole
// firm, never a per-colleague breakdown.
function scopeToSelf(data, email) {
  const me = String(email || '').trim().toLowerCase();
  const mine = (data.staff || []).filter((s) => String(s.email || '').trim().toLowerCase() === me);
  const firm = Object.assign({}, data.firm);
  // A per-person figure that happens to live on the firm object would leak the
  // roster, so only the aggregate fields survive.
  delete firm.excluded;
  return {
    generatedAt: data.generatedAt,
    windowDays: data.windowDays,
    trendWeeks: data.trendWeeks,
    consistencyDays: data.consistencyDays,
    scope: 'self',
    email: me,
    firm,
    staff: mine,
    firmLine: null,
    unassigned: null,
    crossCover: [],
  };
}

module.exports = function createStaffResponseRouter() {
  const router = express.Router();

  // The board. Open to ANY signed-in user now — an admin gets the whole firm,
  // everyone else gets their own row and the firm baselines, and the cut is made
  // here on the server. This is what lets the same page serve both audiences.
  const board = async (req, res) => {
    try {
      const data = await buildStaffResponse({ windowDays: windowDaysFrom(req) });
      if (isAdmin(req)) return res.json(Object.assign({ scope: 'firm' }, data));
      return res.json(scopeToSelf(data, req.session && req.session.email));
    } catch (e) {
      console.error('[staff-response] failed:', e.message);
      res.status(500).json({ error: 'failed to build staff response report' });
    }
  };

  router.get('/api/staff-response', authenticate, board);
  // Kept so existing links and bookmarks keep working; same handler, so an
  // admin sees the same thing at either path.
  router.get('/api/admin/staff-response', authenticate, board);

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
