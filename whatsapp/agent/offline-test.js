#!/usr/bin/env node
// ============================================================
// whatsapp/agent/offline-test.js — run the pipeline against the archive test set
// and the red-team set. Nothing is sent, nothing is queued. Every run is stored
// in wa_drafts with mode='offline' (unless --dry-run), and a report is printed.
//
//   node whatsapp/agent/offline-test.js --pairs path/to/pairs_test.json [--redteam whatsapp/agent/redteam.json] [--limit N] [--dry-run] [--include-drafts] [--out report.json]
//
//   --include-drafts  lets the run use Answer Bank rows still in 'draft' status. Offline only —
//                     the live pipeline never does this. Useful before Yaacov has approved the bank.
//
// pairs_test.json rows: { chat, q, a, q_lang, a_by }   (from the archive mining)
// redteam.json rows:    { text, lang, must_not: ['draft'] }
//
// Offline, deal facts are unknown for archive chats, so the resolver is stubbed:
// only responsible_staff is filled. That is deliberate — it tests that the agent
// REFUSES to invent deal facts, and that procedure questions still get answered
// from the Answer Bank.
// ============================================================
require('dotenv').config();
const fs = require('fs');
const { runMessage } = require('./pipeline');
const db = require('./db');

function arg(name, dflt) { const i = process.argv.indexOf(name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
const PAIRS = arg('--pairs', null);
const REDTEAM = arg('--redteam', null);
const LIMIT = parseInt(arg('--limit', '50'), 10);
const DRY = process.argv.includes('--dry-run');
const INCLUDE_DRAFTS = process.argv.includes('--include-drafts'); // offline only: test against draft Answer Bank entries too

function stubFacts(input, wanted) {
  const slots = {};
  if (wanted.includes('responsible_staff')) slots.responsible_staff = { value: 'Yaakov Hershkovitz', source: 'stub' };
  const unfillable = wanted.filter((s) => !(s in slots));
  return { slots, unfillable, context: {} };
}

async function main() {
  const skills = await db.loadActiveSkills();
  if (!skills) { console.error('No DATABASE_URL / skills not loaded'); process.exit(1); }
  const bank = (await db.listAnswerBank({ activeOnly: !INCLUDE_DRAFTS })).filter((e) => e.status !== 'retired');
  console.log(`skills: ${Object.keys(skills).map((k) => k + ' v' + skills[k].version).join(', ')} · answer bank active entries: ${bank.length}`);

  const results = [];
  if (PAIRS) {
    const pairs = JSON.parse(fs.readFileSync(PAIRS, 'utf8')).slice(0, LIMIT);
    for (const p of pairs) {
      const r = await runMessage({ text: p.q, turns: [], direction: 'in', dealId: 'offline-deal', chatJid: p.chat, referenceText: p.a }, { mode: 'offline', skills, bank, stubFacts, dryRun: DRY });
      results.push({ set: 'pairs', q: p.q, ref: p.a, ...r });
      process.stdout.write('.');
    }
  }
  if (REDTEAM) {
    const rt = JSON.parse(fs.readFileSync(REDTEAM, 'utf8'));
    for (const p of rt) {
      const r = await runMessage({ text: p.text, turns: [], direction: 'in', dealId: 'offline-deal', chatJid: 'redteam' }, { mode: 'offline', skills, bank, stubFacts, dryRun: DRY });
      results.push({ set: 'redteam', q: p.text, must_not: p.must_not || ['draft'], ...r });
      process.stdout.write('!');
    }
  }
  console.log('\n');

  // ---- report ----
  const byOutcome = {};
  for (const r of results) { const k = r.set + ':' + r.outcome; byOutcome[k] = (byOutcome[k] || 0) + 1; }
  console.log('OUTCOMES'); for (const [k, n] of Object.entries(byOutcome).sort()) console.log(`  ${k.padEnd(24)} ${n}`);
  const byType = {};
  for (const r of results) if (r.classification && r.classification.type) { const k = r.classification.type; byType[k] = (byType[k] || 0) + 1; }
  console.log('\nTYPES'); for (const [k, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${n}`);

  const rtFail = results.filter((r) => r.set === 'redteam' && r.must_not.includes(r.outcome));
  console.log(`\nRED TEAM: ${results.filter((r) => r.set === 'redteam').length} run, ${rtFail.length} FAILED`);
  for (const r of rtFail) console.log(`  ✗ "${r.q}" → ${r.outcome}: ${r.draft_text}`);

  console.log('\nDRAFTS (draft vs what staff sent):');
  for (const r of results.filter((r) => r.set === 'pairs' && r.outcome === 'draft')) {
    console.log(`\nQ: ${r.q.slice(0, 200).replace(/\n/g, ' / ')}\n  AGENT [${r.answer_bank_code || '-'}]: ${r.draft_text.replace(/\n/g, ' / ')}\n  STAFF: ${String(r.ref).slice(0, 300).replace(/\n/g, ' / ')}`);
  }
  console.log('\nBLOCKED:');
  for (const r of results.filter((r) => r.outcome === 'blocked')) console.log(`  "${r.q.slice(0, 80)}" → ${r.outcome_reason}: ${r.draft_text}`);

  const out = arg('--out', null);
  if (out) { fs.writeFileSync(out, JSON.stringify(results, null, 1)); console.log('\nwritten', out); }
  process.exit(rtFail.length ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
