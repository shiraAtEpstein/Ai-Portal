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
const { getPool } = require('../db');
const { jidUser, normalizePhone } = require('../whatsapp/ingest/phone');

function isAdmin(req) {
  const roles = (req.session && req.session.roles) || [];
  return roles.some((r) => String(r).toLowerCase() === 'admin');
}
function sameEmail(a, b) { return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }

const OUTCOME_LABELS = {
  draft: 'טיוטה מוכנה', blocked: 'נחסם — יש בעיה בתשובה', escalate: 'הועבר לאדם (ללא טיוטה)',
  silence: 'אין צורך במענה', dropped: 'סונן מראש', error: 'שגיאה בהרצה',
};

// Every code the pipeline can hand back as an outcome_reason, in plain Hebrew.
// Unmapped tokens fall back to themselves rather than disappearing, so a new
// reason added later in classify.js/validate.js/prefilter.js is still readable
// (just untranslated) instead of silently blank.
const REASON_LABELS = {
  // escalate (classify.js ESCALATE_REASONS + pipeline outcome_reason)
  frustration: 'לקוח מתוסכל', anger: 'כעס', urgent_consequence: 'השלכה דחופה',
  dispute: 'מחלוקת בין הצדדים', legal_opinion: 'דורש חוות דעת משפטית',
  money_trouble: 'סוגיה כספית רגישה', sensitive: 'תוכן רגיש',
  named_lawyer: 'הלקוח פנה במפורש לעו"ד', litigation_chat: 'שיחה בהליך משפטי',
  unlinked: 'שיחה לא מקושרת לתיק', unreadable: 'לא ניתן לפענח את ההודעה',
  injection_suspect: 'ניסיון הטעיה של הסוכן', third_party_data: 'בקשה למידע על צד שלישי',
  nothing_to_answer_with: 'לסוכן אין מידע לענות איתו', abstained: 'הסוכן נמנע מלענות',
  classifier_unavailable: 'שגיאה בסיווג ההודעה', model: 'הועבר לפי שיקול הסוכן',
  // route_only:<type> — types that are ALWAYS routed to a human, never drafted
  status_nudge: 'תזכורת/בדיקת סטטוס בלבד', complaint: 'תלונה', meta: 'שאלה על הסוכן עצמו', unknown: 'סוג לא מזוהה',
  // unfillable:<slot,slot,...> — a fact the draft needed but couldn't get
  // partial:<slot,slot,...> — draft WAS produced (outcome stays 'draft'), but
  // it contains a placeholder for these because the fact wasn't available —
  // added 7 Sept alongside pipeline.js's placeholder-drafting change.
  waiting_on: 'ממתין ל...', last_firm_action: 'הפעולה האחרונה של המשרד', responsible_staff: 'איש/אשת קשר אחראי/ת',
  next_payment_amount: 'סכום התשלום הבא', next_payment_due: 'מועד התשלום הבא', payment_schedule: 'לוח תשלומים',
  balance: 'יתרה', delivery_date: 'מועד מסירה', signing_date: 'מועד חתימה', meeting_time: 'שעת פגישה',
  meeting_link: 'קישור לפגישה', office_address: 'כתובת המשרד', apartment_id: 'פרטי הדירה',
  document_status: 'סטטוס מסמך', registration_status: 'סטטוס רישום', tax_status: 'סטטוס מס',
  contact_person: 'איש קשר', client_display: 'פרטי הלקוח',
  // blocked (validate.js)
  unverified_figure: 'מספר/תאריך שלא אומת מול המקור', identifier_leak: 'חשש לחשיפת פרט מזהה',
  unknown_name: 'שם לא מוכר בטיוטה', language_mismatch: 'שפת התשובה לא תואמת את שפת הלקוח', too_long: 'התשובה ארוכה מדי',
  // dropped (prefilter.js)
  firm_sent: 'הודעה שנשלחה ע"י המשרד', media_no_text: 'מדיה ללא טקסט', emoji_only: 'אימוג\'י בלבד',
  ack: 'אישור/תודה קצרה', unlinked_chat: 'שיחה לא מקושרת לתיק', already_answered: 'כבר נענה', no_message: 'הודעה ריקה',
};
function prettyReason(raw) {
  if (!raw) return '';
  // "route_only:status_nudge" / "unfillable:document_status,signing_date"
  return String(raw).split(',').map((part) => {
    const [prefix, rest] = part.includes(':') ? part.split(':') : [null, part];
    const prefixLabel = prefix === 'route_only' ? 'תמיד מועבר לאדם — ' : prefix === 'unfillable' ? 'חסר: ' : prefix === 'partial' ? 'טיוטה עם מקום פנוי למילוי — ' : (prefix ? prefix + ': ' : '');
    const tokens = String(rest).split(',').map((t) => REASON_LABELS[t.trim()] || t.trim()).join(', ');
    return prefixLabel + tokens;
  }).join(' · ');
}

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

// Fallback for a chat that ISN'T on the live unanswered board right now (most
// replayed history: already answered, so it dropped off that board) — looked
// up directly instead, so it still gets a real name and a responsible person
// rather than falling back to the raw WhatsApp jid.
async function chatDirectory(chatJids) {
  const out = new Map();
  const p = getPool();
  const jids = [...new Set((chatJids || []).filter(Boolean))];
  if (!p || !jids.length) return out;

  const groupJids = jids.filter((j) => j.endsWith('@g.us'));
  const dmJids = jids.filter((j) => !j.endsWith('@g.us'));

  if (groupJids.length) {
    try {
      const r = await p.query(
        `SELECT provider_group_jid, name, responsible_name, responsible_email
         FROM whatsapp_groups WHERE provider_group_jid = ANY($1)`,
        [groupJids]
      );
      for (const row of r.rows) {
        out.set(row.provider_group_jid, {
          name: row.name || null,
          responsibleName: row.responsible_name || null,
          responsibleEmail: row.responsible_email || null,
        });
      }
    } catch (e) { console.error('[wa-review] group directory lookup failed:', e.message); }
  }
  if (dmJids.length) {
    try {
      const byPhone = new Map(dmJids.map((j) => [normalizePhone(jidUser(j)), j]).filter(([ph]) => ph));
      const phones = [...byPhone.keys()];
      if (phones.length) {
        const r = await p.query(
          `SELECT phone_normalized, display_name, monday_client_name FROM wa_contacts WHERE phone_normalized = ANY($1)`,
          [phones]
        );
        for (const row of r.rows) {
          const j = byPhone.get(row.phone_normalized);
          if (!j) continue;
          const name = row.display_name || row.monday_client_name || null;
          out.set(j, { name, clientName: name });
        }
      }
    } catch (e) { console.error('[wa-review] contact directory lookup failed:', e.message); }
  }
  return out;
}

module.exports = function createWaReviewRouter() {
  const router = express.Router();

  router.get('/api/wa-review', authenticate, async (req, res) => {
    try {
      const admin = isAdmin(req);
      const myEmail = req.session && req.session.email;
      const rows = await waDb.listRecentDrafts({ limit: 300 });
      const [board, dir] = await Promise.all([boardMap(), chatDirectory(rows.map((r) => r.chat_jid))]);

      const out = [];
      for (const r of rows) {
        const b = board.get(r.chat_jid) || null;
        const d = dir.get(r.chat_jid) || null;
        const responsibleEmails = (b && b.responsibleEmails) || (d && d.responsibleEmail ? [d.responsibleEmail] : []);
        const mine = responsibleEmails.some((e) => sameEmail(e, myEmail));
        if (!admin && !mine) continue;
        const classification = r.classification || {};
        out.push({
          id: r.id,
          chatJid: r.chat_jid,
          chatLabel: (b && b.label) || (d && d.name) || r.chat_jid || '(unlinked chat)',
          clientName: (b && b.clientName) || (d && d.clientName) || null,
          responsibleName: (b && b.responsibleName) || (d && d.responsibleName) || null,
          link: (b && b.link) || null,
          // isQueued: this chat is on the LIVE unanswered board right now — i.e.
          // it genuinely still needs a reply, not just "was drafted at some
          // point". status/waitedLabel/waitedTone come straight from buildBoard(),
          // the one place "does this chat need a reply" is decided anywhere in
          // the app, so this can never disagree with the unanswered board itself.
          isQueued: !!b,
          status: b ? b.status : null,
          waitedLabel: b ? b.waitedLabel : null,
          waitedSince: b ? b.waitedSince : null,
          waitedTone: b ? b.waitedTone : null,
          // No monday deal matched to this chat at all -- the review screen uses
          // this to offer the group's raw WhatsApp id for pasting into monday's
          // group-id column (the one reliable auto-link path; see lib/monday.js
          // resolveDealForGroupId / whatsapp/groups/provider.js _resolveDealForMessage).
          dealLinked: !!r.deal_id,
          // When this chat is on the live board, its actual last-inbound time
          // (not when the draft row was generated) — what the message bubble's
          // timestamp should show. Falls back to the draft's own createdAt for
          // history rows, where the board no longer has the chat.
          messageAt: (b && b.lastInboundAt) || r.created_at,
          messageText: r.message_text,
          outcome: r.outcome,
          outcomeLabel: OUTCOME_LABELS[r.outcome] || r.outcome,
          outcomeReason: r.outcome_reason,
          outcomeReasonLabel: prettyReason(r.outcome_reason),
          type: classification.type || null,
          lang: classification.lang || null,
          answerBankCode: r.answer_bank_code,
          draftText: r.draft_text,
          referenceText: r.reference_text,
          createdAt: r.created_at,
        });
      }
      // Only chats that still need a reply — Shira's call (7 Sept): drop
      // "history" (already-answered / backtest rows) from this screen
      // entirely instead of showing it as a third tab. The /replay endpoint
      // below is untouched and still there for QA — it just has no button on
      // this screen anymore. Oldest wait first, same order the unanswered
      // board itself uses.
      //
      // ONE CARD PER CHAT (8 Sept, Shira): a chat gets a NEW wa_drafts row for
      // every new unanswered client message (replay-history.js dedups by
      // job_id, not by chat_jid — see its own comment on runQueueDrafts), so a
      // chat with three unanswered messages in a row had three old rows, and
      // every one of them has isQueued=true for as long as the chat stays
      // open — all three showed up here as separate cards for the same chat.
      // Collapsing to the single most recently created row per chat_jid fixes
      // the display without touching how drafts are generated or deleting any
      // history (older rows stay in wa_drafts for reconcile/audit, they just
      // aren't shown here anymore once superseded).
      const byChat = new Map();
      for (const x of out) {
        if (!x.isQueued) continue;
        const prev = byChat.get(x.chatJid);
        if (!prev || new Date(x.createdAt) > new Date(prev.createdAt)) byChat.set(x.chatJid, x);
      }
      const queued = [...byChat.values()];
      queued.sort((a, b2) => new Date(a.waitedSince || 0) - new Date(b2.waitedSince || 0));
      res.json({ scope: admin ? 'firm' : 'mine', me: myEmail, count: queued.length, queuedCount: queued.length, drafts: queued });
    } catch (e) {
      console.error('[wa-review] failed:', e.message);
      res.status(500).json({ error: 'Failed to load the review list.' });
    }
  });

  // Manual trigger — same idiom as GET/POST /api/admin/whatsapp-groups/process:
  // runs exactly what the CLI (whatsapp/agent/replay-history.js) runs, from the
  // browser, so testing this doesn't require terminal access.
  // Primary trigger — the everyday one. Drafts ONLY for chats currently on the
  // live unanswered board, one per open chat. This is what "it should only
  // answer unanswered ones" means in practice: nothing here ever drafts for a
  // message that's already been handled.
  router.post('/api/admin/wa-review/queue', authenticate, requireAdmin, async (req, res) => {
    try {
      const q = Object.assign({}, req.query, req.body);
      const limit = Math.min(500, Math.max(1, parseInt(q.limit || '200', 10)));
      // chatJid + force: the review screen's "כתוב טיוטה בכל זאת" / "נסח מחדש"
      // buttons target ONE chat and bypass the "already has a draft" skip so a
      // person can explicitly ask for a fresh attempt. Omitted for the everyday
      // bulk button, which behaves exactly as before.
      const onlyChatJid = q.chatJid ? String(q.chatJid) : null;
      const force = !!(q.force === true || q.force === 'true' || q.force === '1');
      const { runQueueDrafts } = require('../whatsapp/agent/replay-history');
      const result = await runQueueDrafts({ limit, onlyChatJid, force });
      res.json({ ok: true, result });
    } catch (e) {
      console.error('[wa-review] queue draft run failed:', e.message);
      res.status(500).json({ error: 'Queue draft run failed.', detail: e.message });
    }
  });

  // Backtest/QA trigger — drafts against recent HISTORY (answered or not), so
  // the agent's output can be compared against what staff actually sent. Not
  // the everyday tool; kept for review and tuning the skills/answer bank.
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

  // One-off diagnostic: which database is THIS RUNNING APP actually talking
  // to, and what does wa_drafts really hold from its own connection right now.
  // Added because a replay run reported rows as "already exists" that a
  // Neon SQL-editor query couldn't find — the fastest way to tell "wrong
  // database" apart from "real bug" is to ask the app itself, not to keep
  // guessing. Never exposes the connection string, only its host.
  router.get('/api/admin/wa-review/debug', authenticate, requireAdmin, async (req, res) => {
    try {
      const { getPool } = require('../db');
      const p = getPool();
      if (!p) return res.json({ ok: false, error: 'getPool() returned nothing — DATABASE_URL not set for this app.' });
      let dbHost = null, dbName = null;
      try { const u = new URL(process.env.DATABASE_URL || ''); dbHost = u.host; dbName = (u.pathname || '').replace(/^\//, ''); } catch (e) { /* leave null */ }
      const totals = await p.query(`SELECT mode, count(*)::int AS n FROM wa_drafts GROUP BY mode ORDER BY mode`);
      const withJob = await p.query(`SELECT count(*)::int AS n FROM wa_drafts WHERE job_id IS NOT NULL`);
      const recent = await p.query(`SELECT id, mode, outcome, job_id, chat_jid, created_at FROM wa_drafts ORDER BY created_at DESC LIMIT 5`);
      res.json({ ok: true, dbHost, dbName, wa_drafts_by_mode: totals.rows, wa_drafts_with_job_id: withJob.rows[0].n, mostRecent: recent.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
