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
const path = require('path');
const fs = require('fs');
const { sendDigests } = require('./unanswered-digest');
const { sendStaffReport } = require('./staff-response-email');
const { classifyPending } = require('./message-classifier');
const ingestDb = require('../whatsapp/ingest/db');
const db = require('../db');

const TZ = 'Asia/Jerusalem';
let _timer = null;
let _lastFiredSlot = null;
let _lastFiredReportSlot = null;
let _classifyTimer = null;
let _classifying = false;
let _autoRefreshTimer = null;
let _autoRefreshing = false;

// WHEN the digest goes out, and TO WHOM — config/digest-schedule.json.
//
// It used to be one env var listing times, and every time sent to everybody.
// That could not express "a second reminder at 13:15, for Yaakov Hershkovitz
// only", which is exactly what Shira asked for: adding 13:15 to the old list
// would have emailed the whole firm twice a day.
//
// Each slot is { at:"HH:MM", to:"everyone"|[emails], except:[emails] }. Every
// person still receives their OWN list — a slot narrows who is written to,
// never what they see.
//
// Falls back to the old env behaviour when the file is missing or unreadable,
// so a bad edit degrades to "08:00, everyone" instead of silencing the digest.
function digestSlots() {
  let slots = null;                 // null = the file could not be read at all
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'digest-schedule.json'), 'utf8'));
    if (Array.isArray(raw.slots)) slots = raw.slots;
  } catch (e) {
    console.warn('[unanswered/scheduler] config/digest-schedule.json unreadable, falling back to UNANSWERED_DIGEST_TIMES:', e.message);
  }

  // A file that PARSED is authoritative, even when its slots list is empty.
  // Falling back to "08:00, everyone" there would be the worst possible
  // behaviour: emptying the list is how you say "send nothing", and answering
  // that by emailing the whole firm is the exact opposite of the instruction.
  // The env fallback exists only for a file that is missing or corrupt.
  if (slots === null) {
    return (process.env.UNANSWERED_DIGEST_TIMES || '08:00')
      .split(',').map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s))
      .map((at) => ({ at, to: 'everyone', except: [] }));
  }

  return slots
    .filter((s) => s && /^\d{1,2}:\d{2}$/.test(String(s.at || '').trim()))
    .map((s) => ({
      at: String(s.at).trim(),
      to: Array.isArray(s.to) ? s.to.filter(Boolean) : 'everyone',
      except: Array.isArray(s.except) ? s.except.filter(Boolean) : [],
    }));
}
function digestTimes() {
  return digestSlots().map((s) => s.at);
}
function describeSlot(slot) {
  const who = slot.to === 'everyone'
    ? 'everyone' + (slot.except.length ? ` except ${slot.except.join(', ')}` : '')
    : slot.to.join(', ');
  return `${slot.at} -> ${who}`;
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
    // Every slot at this minute, not just the first — two slots could share a
    // time, and silently dropping one is the kind of thing nobody notices.
    for (const s of digestSlots().filter((x) => x.at === hhmm)) {
      const key = `${date} ${hhmm} ${s.to === 'everyone' ? 'all' : s.to.join('|')}`;
      if (_lastFiredSlot === key) continue;   // already fired this slot today
      _lastFiredSlot = key;
      const test = testConfig();
      const hours = test ? test.hours : thresholdHours();
      const mode = test ? `TEST -> ${test.email} only` : `LIVE -> ${describeSlot(s)}`;
      console.log(`[unanswered/scheduler] firing digest at ${date} ${hhmm} (${TZ}), threshold=${hours}h, ${mode}`);
      sendDigests({
        hours,
        testEmail: test ? test.email : null,
        onlyEmails: s.to === 'everyone' ? null : s.to,
        exceptEmails: s.except,
      })
        .then((r) => console.log(`[unanswered/scheduler] digest done (${describeSlot(s)}): ${r.counts.emailsSent} email(s), ${r.counts.totalChats} chat(s)`))
        .catch((e) => console.error('[unanswered/scheduler] digest failed:', e.message));
    }
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
  const armed = digestSlots();
  console.log(armed.length
    ? `[unanswered/scheduler] armed: ${armed.map(describeSlot).join('  |  ')}  (${TZ})`
    : '[unanswered/scheduler] no slots in config/digest-schedule.json — the daily digest is OFF. Nothing will be emailed.');
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
        // Then message KIND, for the same reason and in the same shape: until a
        // row is classified a reaction looks like a client question and holds a
        // wait open. Self-completing — it only ever touches NULLs.
        .then(() => ingestDb.backfillMsgKind({ limit: 200 }))
        .catch((e) => console.error('[msg-kind-backfill] pass failed:', e.message))
        .then(() => classifyPending({ limit: batch }))
        .catch((e) => console.error('[classifier] pass failed:', e.message))
        .then(() => { _classifying = false; });
    };
    _classifyTimer = setInterval(classifyTick, classifyEvery);
    if (_classifyTimer.unref) _classifyTimer.unref();
    console.log(`[classifier] armed: batch=${batch} every ${classifyEvery / 1000}s`);
  }

  // 2026-09-15 (Shira): "I don't want to have to refresh in order for
  // anything to click in — it should do it automatically." Ran the exact
  // same taskHub.refreshTasks(userId) the manual Refresh button on
  // mytasks.html calls (routes/mytasks.js POST /refresh) — same behavior,
  // just on a timer instead of gated behind someone opening the page and
  // clicking. This is what made a voice note actually turn into a task
  // without anyone visiting Task Hub at all: tick 1 (via
  // listTaskInboxMessages) downloads+transcribes it in the background;
  // once the transcript lands, the NEXT tick's refreshTasks() call is what
  // extracts it into a real task.
  //
  // 2026-09-17 (Shira): REVERSED — AI-credit cost control. This timer ran
  // refreshTasks() (real Claude triage calls, plus a Gmail/monday.com/
  // WhatsApp-DB scan) for EVERY active user, every 5 minutes by default,
  // 24/7, whether or not anyone had Task Hub open at all — separate from,
  // and bigger than, the per-tab polling that public/mytasks.html used to
  // do (that one's been removed too, see its own 2026-09-17 comment).
  // Off by default now, same "empty/unset = off" idiom as STAFF_REPORT_TO
  // above: set TASK_HUB_AUTO_REFRESH_ENABLED=true (env var, no code change)
  // to bring this back, e.g. per-environment while testing. The voice-note
  // auto-pickup behavior described above stops working while this is off —
  // a voice note still gets transcribed in the background, it just doesn't
  // turn into a task until someone opens Task Hub and clicks Refresh (or
  // the next scheduler-driven refreshTasks() call if this gets re-enabled).
  const _autoRefreshEnabled = /^(1|true|yes)$/i.test(process.env.TASK_HUB_AUTO_REFRESH_ENABLED || '');
  if (_autoRefreshEnabled && !_autoRefreshTimer) {
    const everySec = Math.max(60, parseInt(process.env.TASK_HUB_AUTO_REFRESH_SECONDS || '300', 10));
    const autoRefreshTick = () => {
      if (_autoRefreshing) return; // previous pass still running — skip, never pile up
      _autoRefreshing = true;
      // Lazy require: lib/task-hub.js itself requires ../db the same way
      // this file now does, and Node's require cache makes a same-process
      // late require cheap — kept lazy only to avoid a load-order surprise
      // with anything else that requires this module during startup.
      const taskHub = require('./task-hub');
      db.listAllUsers()
        .then((users) => (users || []).filter((u) => u.status === 'active'))
        .then((active) => {
          // Sequential, not Promise.all — a burst of simultaneous Gmail/
          // monday/Claude calls for every staff member at once is exactly
          // what the manual button's per-person cooldown was built to
          // avoid; one at a time keeps the same gentle shape automatically.
          return active.reduce((p, u) => p.then(() =>
            taskHub.refreshTasks(u.id).catch((e) =>
              console.warn('[task-hub/auto-refresh] failed for', u.email || u.id, e.message))
          ), Promise.resolve());
        })
        .catch((e) => console.error('[task-hub/auto-refresh] pass failed:', e.message))
        .then(() => { _autoRefreshing = false; });
    };
    _autoRefreshTimer = setInterval(autoRefreshTick, everySec * 1000);
    if (_autoRefreshTimer.unref) _autoRefreshTimer.unref();
    console.log(`[task-hub/auto-refresh] armed: every ${everySec}s for all active users`);
  } else if (!_autoRefreshEnabled) {
    console.log('[task-hub/auto-refresh] disabled (set TASK_HUB_AUTO_REFRESH_ENABLED=true to re-enable) — refreshTasks() now only runs from the manual Refresh button on mytasks.html');
  }
}

module.exports = { start, digestSlots };
