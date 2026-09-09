#!/usr/bin/env node
// ============================================================
// whatsapp/agent/replay-history.js — run the responder pipeline against REAL
// chats, in mode='shadow'. Nothing is sent, nothing is shown to a client —
// every run just becomes a wa_drafts row, same as offline-test.js, except the
// facts come from the real deal (monday + deal_items), not a stub, and the
// conversation context (`turns`) is the chat's real recent history.
//
// This is what feeds public/wa-review.html. Three entry points:
//
//   runQueueDrafts()  — the everyday one. Drafts ONLY for chats that are
//                        currently on the live "needs a reply" board
//                        (lib/unanswered-digest's buildBoard() — the exact
//                        same definition the unanswered board / staff
//                        dashboard use), one draft for each chat's current
//                        open message. This is what the review screen's main
//                        button runs — it never drafts for something that's
//                        already been answered.
//   runReplay()       — the backtest/QA one. Drafts for the last N days of
//                        ALL real client messages, answered or not, so the
//                        agent's output can be compared against what staff
//                        actually sent (the learning loop). Not the everyday
//                        tool — kept for review/tuning, not for "what needs
//                        a reply right now".
//   runReconcile()    — generates nothing. Re-checks existing wa_drafts rows
//                        with no reference_text yet and fills it in once a
//                        real staff reply exists — the "what was actually
//                        sent" half of the learning loop, for drafts from
//                        EITHER of the above. Safe to run repeatedly.
//
// Exported so routes/wa-review.js can trigger the same logic from the browser
// (same idiom as whatsapp/ingest/processor.js). Run directly for the CLI form:
//
//   node whatsapp/agent/replay-history.js --queue [--limit 200] [--dry-run]
//   node whatsapp/agent/replay-history.js --days 14 --limit 50 [--dry-run]
//   node whatsapp/agent/replay-history.js --reconcile [--limit 500] [--dry-run]
//
// All modes are read-only against WhatsApp/monday and additive against Neon.
// Idempotent: a message that already has a wa_drafts row (matched by job_id,
// the processing_jobs.id) is never re-run — so a chat with a NEW message since
// its last draft gets a fresh one automatically (new job_id), while an
// unchanged chat is a no-op to re-run.
// ============================================================
const { getPool } = require('../../db');
const enc = require('../../lib/crypto');
const { textPreview } = require('../ingest/phone');
const { runMessage } = require('./pipeline');
const db = require('./db');
const { NON_MESSAGE_KINDS } = require('../ingest/db');
const { buildBoard } = require('../../lib/unanswered-digest');
const { loadDirectory } = require('../../lib/routing');
const monday = require('../../lib/monday');
const { relinkOne } = require('../../lib/relink');

// textPreview() wants the INNER Baileys `.message` object (the same way
// whatsapp/ingest/phone.js's own senderFromMessage() calls it: textPreview(msg
// && msg.message)) — NOT the raw envelope ({key, message, messageTimestamp}).
// Passing the whole envelope silently returns '' for every real message: this
// was the actual cause of an earlier run reporting 50 "already exists" when
// none had ever been created — they were being skipped as textless, and that
// reason was wrongly folded into the same counter as "already drafted".
async function decryptedText(payloadEncrypted) {
  try {
    const obj = JSON.parse(enc.decrypt(payloadEncrypted || ''));
    return textPreview(obj && obj.message ? obj.message : obj);
  } catch (e) { return ''; }
}

// Last few messages in the chat before `before`, oldest first — the same
// shape compose.js expects: { who: 'firm'|'client', text }.
async function turnsBefore(p, chatJid, before) {
  const r = await p.query(
    `SELECT direction, payload_encrypted FROM processing_jobs
     WHERE chat_jid = $1 AND deleted_at IS NULL AND COALESCE(sent_at, created_at) < $2
       AND (msg_kind IS NULL OR msg_kind <> ALL($3::text[]))
     ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 6`,
    [chatJid, before, NON_MESSAGE_KINDS]
  );
  const out = [];
  for (const row of r.rows.reverse()) {
    const t = await decryptedText(row.payload_encrypted);
    if (t) out.push({ who: row.direction === 'out' ? 'firm' : 'client', text: t });
  }
  return out;
}

// The FULL unanswered block for a chat: every real client message since the
// firm's last reply, oldest first -- not just the newest one. Mirrors the
// block/block_agg CTEs in whatsapp/ingest/db.js's listUnansweredChats(), the
// same computation that decides a chat belongs on the board in the first
// place. Using only the single latest message was a real bug: a chat with a
// real unanswered question followed by a later, unrelated "Ty" (itself a pure
// closer, needing nothing) had the agent draft against "Ty" alone -- reading
// as "nothing to answer" when a genuine question was sitting right above it.
//
// client_category <> 'none' (9 Sept, Shira): the board (listUnansweredChats)
// and the staff-response medians (lib/staff-metrics.js) both already exclude
// messages the per-message triage (lib/message-classifier.js, backed by
// lib/needs-reply.js) tagged 'none' -- a closer/acknowledgement/FYI that
// doesn't need a reply, even a longer one ("No problem, we already have the
// email drafted, we'll send it to them"). This function never applied that
// filter, so a message the rest of the app already knows is settled still
// got pulled into the block the agent drafts against, sitting right next to
// a genuinely new question. Same fail-safe as everywhere else this triage is
// used: NULL/not-yet-classified still counts as needing a reply -- only an
// explicit 'none' is dropped.
async function unansweredBlockText(p, chatJid, staffPhones) {
  const r = await p.query(
    `WITH staff AS (SELECT unnest($2::text[]) AS phone9),
     base AS (
       SELECT direction, sender_phone, sender_staff_phone9, payload_encrypted, client_category,
              COALESCE(sent_at, created_at) AS eff_at
       FROM processing_jobs
       WHERE chat_jid = $1 AND deleted_at IS NULL
         AND (msg_kind IS NULL OR msg_kind <> ALL($3::text[]))
     ),
     last_firm AS (
       SELECT MAX(eff_at) AS at FROM base
       WHERE direction = 'out' OR sender_staff_phone9 IS NOT NULL OR sender_phone IN (SELECT phone9 FROM staff)
     )
     SELECT b.payload_encrypted FROM base b, last_firm
     WHERE b.direction = 'in' AND b.sender_staff_phone9 IS NULL
       AND (b.sender_phone IS NULL OR b.sender_phone NOT IN (SELECT phone9 FROM staff))
       AND (last_firm.at IS NULL OR b.eff_at > last_firm.at)
       AND b.client_category IS DISTINCT FROM 'none'
     ORDER BY b.eff_at ASC
     LIMIT 25`,
    [chatJid, staffPhones, NON_MESSAGE_KINDS]
  );
  const parts = [];
  for (const row of r.rows) {
    const t = await decryptedText(row.payload_encrypted);
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

// The real firm reply that followed, if one exists yet. This is `referenceText`
// on the way in (offline-test.js's --pairs does the same thing with archive
// data) and what reconcile backfills later once the reply actually happens.
async function nextReplyAfter(p, chatJid, after) {
  const r = await p.query(
    `SELECT payload_encrypted FROM processing_jobs
     WHERE chat_jid = $1 AND direction = 'out' AND deleted_at IS NULL
       AND COALESCE(sent_at, created_at) > $2
     ORDER BY COALESCE(sent_at, created_at) ASC LIMIT 1`,
    [chatJid, after]
  );
  if (!r.rows[0]) return null;
  const t = await decryptedText(r.rows[0].payload_encrypted);
  return t || null;
}

async function runReconcile({ limit = 500, dryRun = false } = {}) {
  const p = getPool();
  if (!p) throw new Error('No DATABASE_URL — cannot reach Neon.');
  const rows = await db.listRecentDrafts({ limit });
  let filled = 0, checked = 0;
  for (const r of rows) {
    if (r.reference_text || !r.chat_jid) continue;
    checked++;
    const txt = await nextReplyAfter(p, r.chat_jid, r.created_at);
    if (txt) { filled++; if (!dryRun) await db.setReferenceText(r.id, txt); }
  }
  return { checked, filled, dryRun };
}

// Draft only for chats ACTUALLY on the live "needs a reply" board right now —
// not an arbitrary lookback window. One candidate per open chat: its single
// most recent real inbound message. A chat with no linked deal yet is still
// included (LEFT JOIN) — the pipeline's own 'unlinked' escalate handling
// decides what, if anything, it can safely draft for it.
// onlyChatJid + force: the review screen's "כתוב טיוטה בכל זאת" / "נסח מחדש"
// buttons — draft (or redraft) exactly ONE chat on demand, bypassing the
// "already has a draft" skip (force) so a person can explicitly ask for a
// fresh attempt (e.g. after linking the deal in monday, or just to retry).
// Everyday bulk calls never pass these, so default behavior is unchanged.
async function runQueueDrafts({ limit = 200, dryRun = false, onlyChatJid = null, force = false } = {}) {
  const p = getPool();
  if (!p) throw new Error('No DATABASE_URL — cannot reach Neon.');
  const skills = await db.loadActiveSkills();
  if (!skills) throw new Error('Skills not loaded (voice/rules/classify/compose must be active in wa_skills).');
  const bank = (await db.listAnswerBank({ activeOnly: true })).filter((e) => e.status !== 'retired');

  // force=true is "כתוב טיוטה בכל זאת" / "נסח מחדש" on ONE chat — a person
  // sitting there watching, most likely because they just fixed something
  // (e.g. pasted the group id into monday). The deal<-group index below is
  // cached up to 30 minutes; without this it could silently ignore an edit
  // made seconds ago. Not done on every routine run — only worth the extra
  // monday round-trip when someone is actively forcing a re-check.
  if (force) monday.invalidateDealGroupIndex();

  const board = await buildBoard({ fresh: true });
  let items = (board.items || []).slice(0, limit);
  if (onlyChatJid) items = (board.items || []).filter((i) => i.chatJid === onlyChatJid);
  const jids = items.map((i) => i.chatJid).filter(Boolean);
  if (!jids.length) return { queued: 0, candidates: 0, ran: 0, alreadyDrafted: 0, noText: 0, counts: {}, rows: [] };

  // "The message to draft a reply to" must use the EXACT same "is this the
  // firm talking" test as lib/unanswered-digest's listUnansweredChats() /
  // buildBoard() (direction='out' OR a resolved staff sender OR a raw staff
  // phone) — otherwise a chat can end up on the board because of a genuine
  // unanswered client message, while THIS query's plain "most recent
  // direction='in' row" instead grabs a later message that was actually a
  // staffer replying from their own phone (not through the connected Lawly
  // line, so it still landed as direction='in'). Without this filter that
  // reads as the agent trying to draft a reply to a colleague's own message.
  const dir = loadDirectory();
  const staffPhones = (dir.staff || []).map((s) => s.phone9).filter(Boolean);

  const cand = await p.query(
    `SELECT DISTINCT ON (pj.chat_jid)
            pj.id, pj.chat_jid, pj.deal_id, pj.payload_encrypted, pj.is_group,
            COALESCE(pj.sent_at, pj.created_at) AS at,
            d.monday_board_id, d.monday_item_id, wg.name AS group_name
     FROM processing_jobs pj
     LEFT JOIN deals d ON d.id = pj.deal_id
     LEFT JOIN whatsapp_groups wg ON wg.provider_group_jid = pj.chat_jid
     WHERE pj.source = 'whatsapp' AND pj.direction = 'in' AND pj.deleted_at IS NULL
       AND pj.chat_jid = ANY($1)
       AND (pj.msg_kind IS NULL OR pj.msg_kind <> ALL($2::text[]))
       AND pj.sender_staff_phone9 IS NULL
       AND (pj.sender_phone IS NULL OR pj.sender_phone <> ALL($3::text[]))
     ORDER BY pj.chat_jid, COALESCE(pj.sent_at, pj.created_at) DESC`,
    [jids, NON_MESSAGE_KINDS, staffPhones]
  );

  const counts = {};
  const rows = [];
  let ran = 0, alreadyDrafted = 0, noText = 0;
  for (const row of cand.rows) {
    if (!force) {
      if (await db.hasDraftForJob(row.id)) { alreadyDrafted++; continue; }
    } else {
      // Regenerating: replace the old draft for this exact message instead of
      // piling a second one on top of it (the "duplicate card" bug).
      await db.deleteDraftsForJob(row.id);
    }
    // The WHOLE unanswered block, not just this one (latest) message — see
    // unansweredBlockText() above. row.id / row.deal_id / row.at (the dedup key,
    // deal link and "turns before" cutoff) still come from the single latest
    // real client message, which is exactly right: a NEW message changes which
    // row is latest, so it naturally redrafts when the block actually changes.
    const text = await unansweredBlockText(p, row.chat_jid, staffPhones);
    if (!text) { noText++; continue; }
    const turns = await turnsBefore(p, row.chat_jid, row.at);

    // A group chat with no cached deal link yet gets ONE live re-check against
    // monday before it's drafted as unlinked — cheap, and exactly what turns
    // "still not connected" into a real link the moment the group-id column in
    // monday is fixed, without waiting for a brand-new message to trigger the
    // normal ingest-time resolution. Never overwrites an existing link, only
    // fills in a missing one; failures here just fall back to unlinked, same
    // as before this existed.
    let dealId = row.deal_id, mondayBoardId = row.monday_board_id, mondayItemId = row.monday_item_id;
    if (!dealId && row.chat_jid && row.chat_jid.endsWith('@g.us')) {
      try {
        await relinkOne({ provider_group_jid: row.chat_jid, name: row.group_name || null }, dir);
        const fresh = await p.query(
          `SELECT wg.deal_id, d.monday_board_id, d.monday_item_id
           FROM whatsapp_groups wg LEFT JOIN deals d ON d.id = wg.deal_id
           WHERE wg.provider_group_jid = $1`,
          [row.chat_jid]
        );
        const f = fresh.rows[0];
        if (f && f.deal_id) { dealId = f.deal_id; mondayBoardId = f.monday_board_id; mondayItemId = f.monday_item_id; }
      } catch (e) { console.error('[wa-review] live relink failed for', row.chat_jid, e.message); }
    }

    const result = await runMessage(
      {
        text, turns, direction: 'in', isGroup: row.is_group, dealId,
        mondayBoardId, mondayItemId,
        chatJid: row.chat_jid, jobId: row.id, // referenceText intentionally omitted — nothing's been sent yet, by definition
      },
      { mode: 'shadow', skills, bank, dryRun }
    );
    ran++;
    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
    rows.push({ chatJid: row.chat_jid, text: text.slice(0, 120), outcome: result.outcome });
  }
  return { queued: items.length, candidates: cand.rows.length, ran, alreadyDrafted, noText, counts, rows };
}

async function runReplay({ days = 14, limit = 50, dryRun = false } = {}) {
  const p = getPool();
  if (!p) throw new Error('No DATABASE_URL — cannot reach Neon.');
  const skills = await db.loadActiveSkills();
  if (!skills) throw new Error('Skills not loaded (voice/rules/classify/compose must be active in wa_skills).');
  const bank = (await db.listAnswerBank({ activeOnly: true })).filter((e) => e.status !== 'retired');

  // "A real message" = not a reaction, not a system/stub event — the SAME
  // definition responseStats()/listUnansweredChats() use elsewhere (NON_MESSAGE_KINDS),
  // not a narrow allowlist. A first version of this filtered msg_kind = 'conversation'
  // only, which silently dropped extendedTextMessage/imageMessage/etc. — most real
  // client text — and is why an early run came back with 0 candidates.
  const dir = loadDirectory();
  const staffPhones = (dir.staff || []).map((s) => s.phone9).filter(Boolean);

  const cand = await p.query(
    `SELECT pj.id, pj.chat_jid, pj.deal_id, pj.payload_encrypted, pj.is_group,
            COALESCE(pj.sent_at, pj.created_at) AS at,
            d.monday_board_id, d.monday_item_id
     FROM processing_jobs pj
     LEFT JOIN deals d ON d.id = pj.deal_id
     WHERE pj.source = 'whatsapp' AND pj.direction = 'in' AND pj.deleted_at IS NULL
       AND (pj.msg_kind IS NULL OR pj.msg_kind <> ALL($3::text[]))
       AND COALESCE(pj.sent_at, pj.created_at) > now() - make_interval(days => $1)
       -- Same "is this actually the firm talking" test as runQueueDrafts() and
       -- buildBoard() -- a staffer replying from their own phone still lands
       -- with direction='in' here, and must never be read as a client message.
       AND pj.sender_staff_phone9 IS NULL
       AND (pj.sender_phone IS NULL OR pj.sender_phone <> ALL($4::text[]))
     ORDER BY COALESCE(pj.sent_at, pj.created_at) DESC
     LIMIT $2`,
    [days, limit, NON_MESSAGE_KINDS, staffPhones]
  );

  const counts = {};
  const rows = [];
  let ran = 0, alreadyDrafted = 0, noText = 0;
  for (const row of cand.rows) {
    if (await db.hasDraftForJob(row.id)) { alreadyDrafted++; continue; }
    const text = await decryptedText(row.payload_encrypted);
    if (!text) { noText++; continue; }
    const turns = await turnsBefore(p, row.chat_jid, row.at);
    const referenceText = await nextReplyAfter(p, row.chat_jid, row.at);

    const result = await runMessage(
      {
        text, turns, direction: 'in', isGroup: row.is_group, dealId: row.deal_id,
        mondayBoardId: row.monday_board_id, mondayItemId: row.monday_item_id,
        chatJid: row.chat_jid, jobId: row.id, referenceText: referenceText || undefined,
      },
      { mode: 'shadow', skills, bank, dryRun }
    );
    ran++;
    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
    rows.push({ chatJid: row.chat_jid, text: text.slice(0, 120), outcome: result.outcome });
  }
  const skipped = alreadyDrafted + noText; // kept for backward compatibility with old callers
  return { candidates: cand.rows.length, ran, skipped, alreadyDrafted, noText, counts, rows };
}

module.exports = { runReplay, runReconcile, runQueueDrafts };

// ---- CLI form ---------------------------------------------------------
if (require.main === module) {
  require('dotenv').config();
  const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
  const days = parseInt(arg('--days', '14'), 10);
  const limit = parseInt(arg('--limit', '50'), 10);
  const dryRun = process.argv.includes('--dry-run');
  const reconcile = process.argv.includes('--reconcile');
  const queue = process.argv.includes('--queue');

  const run = reconcile ? runReconcile({ limit: arg('--limit', null) ? limit : 500, dryRun })
    : queue ? runQueueDrafts({ limit: arg('--limit', null) ? limit : 200, dryRun })
    : runReplay({ days, limit, dryRun });

  run.then((r) => {
      if (reconcile) {
        console.log(`Reconcile: ${r.checked} draft(s) checked, ${r.filled} matched to a real reply${dryRun ? ' (dry-run, not saved)' : ''}.`);
      } else if (queue) {
        console.log(`${r.queued} chat(s) currently need a reply.`);
        for (const row of r.rows) console.log(`  [${row.outcome}] ${row.chatJid} :: ${row.text.replace(/\n/g, ' / ')}`);
        console.log(`\nDone. ${r.ran} drafted, ${r.alreadyDrafted} already had a draft, ${r.noText} had no readable text.`);
        console.log('OUTCOMES', r.counts);
        if (r.ran) console.log('\nOpen /wa-review.html to see the drafts.');
      } else {
        console.log(`${r.candidates} candidate client message(s) in the last ${days} day(s).`);
        for (const row of r.rows) console.log(`  [${row.outcome}] ${row.chatJid} :: ${row.text.replace(/\n/g, ' / ')}`);
        console.log(`\nDone. ${r.ran} replayed, ${r.skipped} skipped (already drafted or no text).`);
        console.log('OUTCOMES', r.counts);
        if (r.ran) console.log('\nOpen /wa-review.html to see the drafts.');
      }
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
