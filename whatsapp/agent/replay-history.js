#!/usr/bin/env node
// ============================================================
// whatsapp/agent/replay-history.js — run the responder pipeline against REAL
// recently-ingested chats, in mode='shadow'. Nothing is sent, nothing is shown
// to a client — every run just becomes a wa_drafts row, same as offline-test.js,
// except the facts come from the real deal (monday + deal_items), not a stub,
// and the conversation context (`turns`) is the chat's real recent history.
//
// This is what feeds public/wa-review.html: instead of (or before) reading a
// synthetic report in the terminal, real generated answers for real recent
// client messages show up on the actual review screen.
//
// Exports runReplay()/runReconcile() so routes/wa-review.js can trigger the
// same logic from the browser (same idiom as whatsapp/ingest/processor.js).
// Run directly for the CLI form:
//
//   node whatsapp/agent/replay-history.js --days 14 --limit 50 [--dry-run]
//   node whatsapp/agent/replay-history.js --reconcile [--limit 500] [--dry-run]
//
// --reconcile does NOT generate anything. It re-checks existing wa_drafts rows
// that have no reference_text yet, and fills it in if the chat now has a real
// staff reply after the draft's message — the "what was actually sent" half
// of the learning loop. Safe to run repeatedly (e.g. daily): it only ever
// fills a currently-empty reference_text, never overwrites one.
//
// Both modes are read-only against WhatsApp/monday and additive against Neon.
// Idempotent: a message that already has a wa_drafts row (matched by job_id,
// the processing_jobs.id) is never re-run.
// ============================================================
const { getPool } = require('../../db');
const enc = require('../../lib/crypto');
const { textPreview } = require('../ingest/phone');
const { runMessage } = require('./pipeline');
const db = require('./db');

async function decryptedText(payloadEncrypted) {
  try { return textPreview(JSON.parse(enc.decrypt(payloadEncrypted || ''))); }
  catch (e) { return ''; }
}

// Last few messages in the chat before `before`, oldest first — the same
// shape compose.js expects: { who: 'firm'|'client', text }.
async function turnsBefore(p, chatJid, before) {
  const r = await p.query(
    `SELECT direction, payload_encrypted FROM processing_jobs
     WHERE chat_jid = $1 AND deleted_at IS NULL AND COALESCE(sent_at, created_at) < $2
       AND (msg_kind IS NULL OR msg_kind = 'conversation')
     ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 6`,
    [chatJid, before]
  );
  const out = [];
  for (const row of r.rows.reverse()) {
    const t = await decryptedText(row.payload_encrypted);
    if (t) out.push({ who: row.direction === 'out' ? 'firm' : 'client', text: t });
  }
  return out;
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

async function runReplay({ days = 14, limit = 50, dryRun = false } = {}) {
  const p = getPool();
  if (!p) throw new Error('No DATABASE_URL — cannot reach Neon.');
  const skills = await db.loadActiveSkills();
  if (!skills) throw new Error('Skills not loaded (voice/rules/classify/compose must be active in wa_skills).');
  const bank = (await db.listAnswerBank({ activeOnly: true })).filter((e) => e.status !== 'retired');

  const cand = await p.query(
    `SELECT pj.id, pj.chat_jid, pj.deal_id, pj.payload_encrypted, pj.is_group,
            COALESCE(pj.sent_at, pj.created_at) AS at,
            d.monday_board_id, d.monday_item_id
     FROM processing_jobs pj
     JOIN deals d ON d.id = pj.deal_id
     WHERE pj.source = 'whatsapp' AND pj.direction = 'in' AND pj.deleted_at IS NULL
       AND (pj.msg_kind IS NULL OR pj.msg_kind = 'conversation')
       AND COALESCE(pj.sent_at, pj.created_at) > now() - make_interval(days => $1)
     ORDER BY COALESCE(pj.sent_at, pj.created_at) DESC
     LIMIT $2`,
    [days, limit]
  );

  const counts = {};
  const rows = [];
  let ran = 0, skipped = 0;
  for (const row of cand.rows) {
    if (await db.hasDraftForJob(row.id)) { skipped++; continue; }
    const text = await decryptedText(row.payload_encrypted);
    if (!text) { skipped++; continue; }
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
  return { candidates: cand.rows.length, ran, skipped, counts, rows };
}

module.exports = { runReplay, runReconcile };

// ---- CLI form ---------------------------------------------------------
if (require.main === module) {
  require('dotenv').config();
  const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
  const days = parseInt(arg('--days', '14'), 10);
  const limit = parseInt(arg('--limit', '50'), 10);
  const dryRun = process.argv.includes('--dry-run');
  const reconcile = process.argv.includes('--reconcile');

  (reconcile ? runReconcile({ limit: arg('--limit', null) ? limit : 500, dryRun }) : runReplay({ days, limit, dryRun }))
    .then((r) => {
      if (reconcile) {
        console.log(`Reconcile: ${r.checked} draft(s) checked, ${r.filled} matched to a real reply${dryRun ? ' (dry-run, not saved)' : ''}.`);
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
