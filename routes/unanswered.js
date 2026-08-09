// ============================================================
// routes/unanswered.js — admin-only "unanswered client chats" endpoints.
//
//   GET  /api/admin/unanswered/whatsapp     -> preview, grouped by responsible person
//   POST /api/admin/unanswered/send-digest  -> build + send the digests now
//
// Deterministic: reads ingested WhatsApp data + the staff directory only. No
// Dropbox, no Claude, no dependency on the (blocked) summary processor.
// Admin-gated, same idiom as routes/whatsapp-groups.js.
//
// Scope: WhatsApp only. The email side (unanswered Gmail threads) is a later PR.
// ============================================================
const express = require('express');
const { authenticate, requireAdmin } = require('../lib/sessions');
const { buildDigest, sendDigests } = require('../lib/unanswered-digest');

const DEFAULT_HOURS = parseInt(process.env.UNANSWERED_HOURS || '3', 10);

function hoursFrom(req) {
  const raw = (req.query && req.query.hours) || (req.body && req.body.hours);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_HOURS;
}

module.exports = function createUnansweredRouter() {
  const router = express.Router();

  // Preview Shira opens to see real results before any email goes out.
  router.get('/api/admin/unanswered/whatsapp', authenticate, requireAdmin, async (req, res) => {
    try {
      const hours = hoursFrom(req);
      const digest = await buildDigest({ hours });
      res.json({
        hours: digest.hours,
        generatedAt: digest.generatedAt,
        total: digest.all.length,
        byPerson: digest.byPerson,
        all: digest.all,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to build unanswered list.', detail: e.message });
    }
  });

  // Manual trigger: build + send the digests right now.
  router.post('/api/admin/unanswered/send-digest', authenticate, requireAdmin, async (req, res) => {
    try {
      const hours = hoursFrom(req);
      const result = await sendDigests({ hours });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: 'Failed to send digests.', detail: e.message });
    }
  });

  return router;
};
