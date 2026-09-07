// ============================================================
// routes/wa-review.js — the "generated answers" review screen (public/wa-review.html).
//
//   GET  /api/wa-review                    -> drafts for the signed-in user
//        (admin sees everyone's; everyone else sees only chats routed to them)
//   POST /api/admin/wa-review/replay       -> run replay-history.js's replay now
//   POST /api/admin/wa-review/reconcile    -> re-check for real replies now
//
// Read-only apart from the two admin triggers, which only ever ADD wa_drafts
// rows or fill in a missing reference_text — never send, never touch a client,
// same ops posture as the rest of whatsapp/agent (no send path anywhere).
//
// "Who is this chat routed to" reuses buildBoard() from lib/unanswered-digest —
// the SAME function the unanswered board and staff-response dashboard use — so
// a chat can never be assigned to one person here and someone else there.
// ============================================================
const express = require('express');
const { authenticate, requireAdmin } = require('../lib/sessions');
const waDb = require('../whatsapp/agent/db');
const { buildBoard } = require('../lib/unanswered-digest');

function isAdmin(req) {
  const roles = (req.session && req.session.roles) || [];
  return roles.some((r) => String(r).toLowerCase() === 'admin');
}
function sameEmail(a, b) { return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }

const OUTCOME_LABELS = {
  draft: 'טיוטה מוכנה', blocked: 'נחסם — יש בעיה בתשובה', escalate: 'הועבר לאדם (ללא טיוטה)',
  silence: 'אין צורך במענה', dropped: 'סונן מראש', error: 'שגיאה בהרצה',
};

// chat_jid -> board item, so a wa_drafts row can show a real chat name instead
// of a jid and be filtered to the right person. A chat with no OPEN unanswered
// item right now (already handled, or simply not on the board) has no board
// entry — it still appears here (never hidden), just without a name or a
// responsible person to match, so only an admin sees that particular row.
async function boardMap() {
  const board = await buildBoard();
  const map = new Map();
  for (const item of board.items || []) map.set(item.chatJid, item);
  return map;
}

module.exports = function createWaReviewRouter() {
  const router = express.Router();

  router.get('/api/wa-review', authenticate, async (req, res) => {
    try {
      const admin = isAdmin(req);
      const myEmail = req.session && req.session.email;
      const [rows, board] = await Promise.all([waDb.listRecentDrafts({ limit: 300 }), boardMap()]);

      const out = [];
      for (const r of rows) {
        const b = board.get(r.chat_jid) || null;
        const responsibleEmails = (b && b.responsibleEmails) || [];
        const mine = responsibleEmails.some((e) => sameEmail(e, myEmail));
        if (!admin && !mine) continue;
        const classification = r.classification || {};
        out.push({
          id: r.id,
          chatJid: r.chat_jid,
          chatLabel: (b && b.label) || r.chat_jid || '(unlinked chat)',
          clientName: (b && b.clientName) || null,
          responsibleName: (b && b.responsibleName) || null,
          link: (b && b.link) || null,
          messageText: r.message_text,
          outcome: r.outcome,
          outcomeLabel: OUTCOME_LABELS[r.outcome] || r.outcome,
          outcomeReason: r.outcome_reason,
          type: classification.type || null,
          lang: classification.lang || null,
          answerBankCode: r.answer_bank_code,
          draftText: r.draft_text,
          referenceText: r.reference_text,
          createdAt: r.created_at,
        });
      }
      res.json({ scope: admin ? 'firm' : 'mine', me: myEmail, count: out.length, drafts: out });
    } catch (e) {
      console.error('[wa-review] failed:', e.message);
      res.status(500).json({ error: 'Failed to load the review list.' });
    }
  });

  // Manual trigger — same idiom as GET/POST /api/admin/whatsapp-groups/process:
  // runs exactly what the CLI (whatsapp/agent/replay-history.js) runs, from the
  // browser, so testing this doesn't require terminal access.
  router.post('/api/admin/wa-review/replay', authenticate, requireAdmin, async (req, res) => {
    try {
      const q = Object.assign({}, req.query, req.body);
      const days = Math.min(60, Math.max(1, parseInt(q.days || '14', 10)));
      const limit = Math.min(300, Math.max(1, parseInt(q.limit || '50', 10)));
      const { runReplay } = require('../whatsapp/agent/replay-history');
      const result = await runReplay({ days, limit });
      res.json({ ok: true, result });
    } catch (e) {
      console.error('[wa-review] replay failed:', e.message);
      res.status(500).json({ error: 'Replay failed.', detail: e.message });
    }
  });

  router.post('/api/admin/wa-review/reconcile', authenticate, requireAdmin, async (req, res) => {
    try {
      const q = Object.assign({}, req.query, req.body);
      const limit = Math.min(1000, Math.max(1, parseInt(q.limit || '500', 10)));
      const { runReconcile } = require('../whatsapp/agent/replay-history');
      const result = await runReconcile({ limit });
      res.json({ ok: true, result });
    } catch (e) {
      console.error('[wa-review] reconcile failed:', e.message);
      res.status(500).json({ error: 'Reconcile failed.', detail: e.message });
    }
  });

  return router;
};
