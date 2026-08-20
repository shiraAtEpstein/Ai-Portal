// ============================================================
// lib/scheduler.js — tiny daily scheduler for the unanswered-chat digest.
//
// No cron dependency: a 60s interval checks the wall clock in Asia/Jerusalem
// and fires once per configured slot per day (tracked in memory, same idiom as
// whatsapp/groups/bootstrap.js's processor schedule).
//
//   UNANSWERED_DIGEST_TIMES  comma-separated HH:MM (default "08:00")
//   UNANSWERED_HOURS         threshold hours passed to the digest (default 3)
//
// SECOND SLOT — the daily staff-response board email (Yaakov Epstein):
//   STAFF_REPORT_TIMES       comma-separated HH:MM (default "08:15")
//   STAFF_REPORT_TO          comma-separated recipients — EMPTY BY DEFAULT, so
//                            the daily send stays OFF until someone turns it on
//   STAFF_REPORT_WINDOW_DAYS median window in days (default 30)
//   STAFF_REPORT_TEST_EMAIL  if set, the daily run goes ONLY there, "[בדיקה]" subject
//
// 08:15 and not 08:00 on purpose: the unanswered digest already fires at 08:00
// and Yaakov Epstein (inAllGroups) receives the full firm list then. Two emails
// in the same minute collide in the inbox and the second one gets ignored.
//
// The two slots are tracked SEPARATELY (_lastFiredSlot / _lastFiredReportSlot)
// and checked independently. The tick used to early-return on any minute that
// wasn't a digest time, which would have swallowed the report slot entirely.
//
// TEST MODE (for a dry run before going live):
//   UNANSWERED_TEST_EMAIL    if set, the daily run emails ONLY this address
//                            (full list, "[TEST]" subject) and no staff — so you
//                            can watch the SCHEDULED send work each morning first.
//   UNANSWERED_TEST_HOURS    threshold used only in test mode (default 0 = show
//                            everything, even messages waiting < the live 3h).
//   Remove UNANSWERED_TEST_EMAIL to switch to the real staff-wide send.
//
// NOTE: this runs in-process. On a sleeping/idle host (e.g. Render free tier)
// the interval is suspended, so a slot that falls while the instance is asleep
// won't fire until it next wakes — acceptable for a daily nudge. The live
// WhatsApp socket keeps this instance awake, so 08:00 fires on time in practice.
// ============================================================
const { sendDigests } = require('./unanswered-digest');
const { sendStaffReport } = require('./staff-response-email');
const { classifyPending } = require('./message-classifier');
const ingestDb = require('../whatsapp/ingest/db');

const TZ = 'Asia/Jerusalem';
let _timer = null;
let _lastFiredSlot = null;
let _lastFiredReportSlot = null;
let _classifyTimer = null;
let _classifying = false;

function digestTimes() {
  return (process.env.UNANSWERED_DIGEST_TIMES || '08:00')
    .split(',').map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s));
}

function staffReportTimes() {
  return (process.env.STAFF_REPORT_TIMES || '08:15')
    .split(',').map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s));
}

function staffReportWindowDays() {
  const n = parseInt(process.env.STAFF_REPORT_WINDOW_DAYS || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 180 ? n : 30;
}

function parseHoursEnv(name, dflt) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function thresholdHours() {
  return parseHoursEnv('UNANSWERED_HOURS', 3);
}

// While UNANSWERED_TEST_EMAIL is set, return { email, hours } for a test-only
// send; otherwise null (real staff-wide send).
function testConfig() {
  const email = String(process.env.UNANSWERED_TEST_EMAIL || '').trim();
  if (!email) return null;
  return { email, hours: parseHoursEnv('UNANSWERED_TEST_HOURS', 0) };
}

// HH:MM and YYYY-MM-DD in the firm timezone.
function localParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  return { hhmm: `${parts.hour}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

function start() {
  if (_timer) return; // already started
  // Slot 1 — the per-person "unanswered chats" digest.
  const maybeFireDigest = (hhmm, date) => {
    if (!digestTimes().includes(hhmm)) return;
    const slot = `${date} ${hhmm}`;
    if (_lastFiredSlot === slot) return; // already fired this slot today
    _lastFiredSlot = slot;
    const test = testConfig();
    const hours = test ? test.hours : thresholdHours();
    const mode = test ? `TEST -> ${test.email} only` : 'LIVE -> staff';
    console.log(`[unanswered/scheduler] firing digest at ${slot} (${TZ}), threshold=${hours}h, ${mode}`);
    sendDigests({ hours, testEmail: test ? test.email : null })
      .then((r) => console.log(`[unanswered/scheduler] digest done: ${r.counts.emailsSent} email(s), ${r.counts.totalChats} chat(s)`))
      .catch((e) => console.error('[unanswered/scheduler] digest failed:', e.message));
  };

  // Slot 2 — the daily staff-response board email (one link, to Yaakov).
  const maybeFireStaffReport = (hhmm, date) => {
    if (!staffReportTimes().includes(hhmm)) return;
    const slot = `${date} ${hhmm}`;
    if (_lastFiredReportSlot === slot) return;
    const testEmail = String(process.env.STAFF_REPORT_TEST_EMAIL || '').trim() || null;
    // Off until configured. Checked BEFORE the slot is marked fired, so simply
    // setting STAFF_REPORT_TO later starts it working with no restart needed.
    if (!testEmail && !String(process.env.STAFF_REPORT_TO || '').trim()) {
      console.log('[staff-report/scheduler] slot reached but STAFF_REPORT_TO is empty — daily report is OFF, nothing sent.');
      return;
    }
    const windowDays = staffReportWindowDays();
    _lastFiredReportSlot = slot;
    const mode = testEmail ? `TEST -> ${testEmail} only` : 'LIVE -> report recipients';
    console.log(`[staff-report/scheduler] firing report at ${slot} (${TZ}), window=${windowDays}d, ${mode}`);
    sendStaffReport({ windowDays, testEmail })
      .then((r) => console.log(`[staff-report/scheduler] report done: ${r.counts.emailsSent}/${r.counts.recipients} email(s), ${r.counts.openTotal} open chat(s)`))
      .catch((e) => console.error('[staff-report/scheduler] report failed:', e.message));
  };

  const tick = () => {
    try {
      const { hhmm, date } = localParts();
      // Two INDEPENDENT checks — never an early return, or the later slot in
      // the same tick would never be reached.
      maybeFireDigest(hhmm, date);
      maybeFireStaffReport(hhmm, date);
    } catch (e) {
      console.error('[unanswered/scheduler] tick failed:', e.message);
    }
  };
  _timer = setInterval(tick, 60 * 1000);
  if (_timer.unref) _timer.unref();
  console.log(`[unanswered/scheduler] armed for ${digestTimes().join(', ')} (${TZ})`);
  const reportTo = String(process.env.STAFF_REPORT_TO || '').trim();
  const reportTest = String(process.env.STAFF_REPORT_TEST_EMAIL || '').trim();
  console.log(`[staff-report/scheduler] armed for ${staffReportTimes().join(', ')} (${TZ}) — ` +
    (reportTest ? `TEST mode, only ${reportTest}`
      : reportTo ? `sending to ${reportTo}`
      : 'OFF (STAFF_REPORT_TO is empty; set it to switch the daily report on)'));

  // Backlog drain: classify a batch of unclassified client messages every few
  // minutes, so response-time metrics can count only 🔴 'required'. Skips a tick
  // if the previous pass is still running; leaves anything the AI can't reach as
  // pending for the next pass.
  if (!_classifyTimer) {
    const classifyEvery = Math.max(60, parseInt(process.env.CLASSIFY_INTERVAL_SECONDS || '300', 10)) * 1000;
    const batch = Math.min(Math.max(parseInt(process.env.CLASSIFY_BATCH || '50', 10), 1), 500);
    const classifyTick = () => {
      if (_classifying) return;
      _classifying = true;
      // Backfill real send-time for old rows first (cheap, self-completing),
      // then classify a batch. Both leave "done" rows out of future scans.
      Promise.resolve(ingestDb.backfillSentAt({ limit: 200 }))
        .catch((e) => console.error('[sent-at-backfill] pass failed:', e.message))
        .then(() => classifyPending({ limit: batch }))
        .catch((e) => console.error('[classifier] pass failed:', e.message))
        .then(() => { _classifying = false; });
    };
    _classifyTimer = setInterval(classifyTick, classifyEvery);
    if (_classifyTimer.unref) _classifyTimer.unref();
    console.log(`[classifier] armed: batch=${batch} every ${classifyEvery / 1000}s`);
  }
}

module.exports = { start };
