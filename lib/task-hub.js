/**
 * Task Hub — aggregation + prioritization engine.
 *
 * Pulls open items for ONE signed-in user (per-user, not hardcoded to
 * anyone) from three sources — email, WhatsApp, monday — plus tasks the
 * user typed to LAWLY on WhatsApp, runs each through a DB-stored Claude
 * prompt (task_hub_skills, same idea as wa_skills for the WhatsApp agent)
 * to get a title/summary/estimate/priority, and stores the result in
 * unified_tasks.
 *
 * DB access confirmed from routes/daily.js: require('../db') with a
 * getPool() method, called lazily inside each function (not cached at
 * module load, since the pool may not be ready yet when this file loads).
 *
 * Users are identified by req.session.userId (uuid) app-wide — see
 * lib/sessions.js's `authenticate` — NOT by email. unified_tasks is keyed
 * on user_id accordingly. Email is only needed for the Gmail/WhatsApp/
 * monday source lookups below, resolved from userId via getUserEmail().
 *
 * 2026-09-09: checked against the real repo (was built offline against
 * docs before this). Fixed three real bugs that were making every refresh
 * come back with 0 tasks from every source:
 *   - Claude access now goes through lib/claude.js instead of a hand-rolled
 *     client + the TASK_HUB_MODEL env var (which nothing else in the repo
 *     used — the house convention is CLAUDE_MODEL, read by lib/claude.js).
 *   - fetchEmailCandidates matched the wrong lib/gmail.searchMail(...)
 *     signature (real: (userId, {query, maxResults}) returning
 *     {connected, messages}, not a bare array) — every call was silently
 *     throwing and getting swallowed by Promise.allSettled in refreshTasks.
 *   - fetchWhatsappCandidates assumed the wrong config/staff-directory.json
 *     shape (real: {staff: [...]} with a `phone9` field, not a flat map
 *     with `.phone`/`.number`) — so it could never find the signed-in
 *     user's phone and always skipped the WhatsApp source.
 *   - fetchMondayCandidates is now wired to lib/monday.js's myDeals(email)
 *     (the same read-only per-person lookup routes/chat.js already uses)
 *     instead of the earlier stub that always returned [].
 *
 * 2026-09-10 (Shira): monday no longer produces its own tasks. It's
 * background/context only now — used to answer "where does this deal
 * stand" and attached to an email/WhatsApp task that's actually about that
 * deal, instead of showing up as its own separate to-do. See
 * fetchMondayContext() / dealBackgroundText() below.
 *
 * 2026-09-10 (Shira), second change: the 'manual' source (tasks sent to
 * LAWLY over real WhatsApp — the seeded 'manual-task-extract' skill already
 * existed for this, nothing was ever wired to call it) now reads a staff
 * member's own personal WhatsApp group with LAWLY/staff/Yaacov — e.g.
 * "Yaakov Hershkowitzes tasks משימות" — where every message is candidate
 * task text. See fetchManualCandidates() below and
 * whatsapp/ingest/db.js's listTaskInboxMessages(). REQUIRES a one-time SQL
 * step per staff member (adds whatsapp_groups.task_owner_email and links
 * their group) — delivered alongside this file, must be run before this
 * source will find anything.
 *
 * 2026-09-14 (Shira): real bug found in fetchWhatsappCandidates — it called
 * waDb.listUnansweredChats() (the SAME function that feeds the shared
 * control board, Board.html, and deliberately returns EVERY unanswered
 * WhatsApp chat firm-wide) and turned every single result into a task
 * candidate for whichever user's Task Hub happened to be refreshing,
 * completely ignoring each chat's own responsibleEmail. So any staff
 * member with a phone9 in config/staff-directory.json got everyone's
 * unanswered chats mixed into their personal Task Hub — confirmed live:
 * Talya's Task Hub was showing chats responsible to Shayna (and others,
 * and a large unresolved/no-owner bucket) alongside her own. Fixed by
 * filtering the chat list down to c.responsibleEmail === userEmail before
 * mapping to candidates. Chats with no resolved responsible_email (NULL =
 * not yet resolved, '' = resolved to a default/fallback owner) are
 * deliberately left OUT of every personal Task Hub for now — they still
 * surface on the shared Board.html, which is the right place for an
 * unowned chat until someone claims it. Revisit if that's not enough.
 */

var db = require('../db');


var claude = require('../lib/claude');
var taskTypes = require('./task-types');
var mondayCheck = require('./task-monday-check');

function pool() {
  var p = db.getPool();
  if (!p) throw new Error('task-hub: db.getPool() returned nothing — database not ready yet');
  return p;
}

var _tablesReady = null;
function ensureTables() {
  if (_tablesReady) return _tablesReady;
  var p = pool();
  _tablesReady = p.query(
    'CREATE TABLE IF NOT EXISTS unified_tasks (' +
    '  id SERIAL PRIMARY KEY,' +
    '  user_id uuid NOT NULL,' +
    '  source text NOT NULL,' +
    '  source_ref text,' +
    '  title text NOT NULL,' +
    '  summary text,' +
    '  estimated_minutes integer,' +
    "  priority text NOT NULL DEFAULT 'normal'," +
    '  priority_overridden_by_user boolean NOT NULL DEFAULT false,' +
    "  status text NOT NULL DEFAULT 'open'," +
    '  first_seen_at timestamptz NOT NULL DEFAULT now(),' +
    '  updated_at timestamptz NOT NULL DEFAULT now(),' +
    '  done_at timestamptz,' +
    '  UNIQUE (user_id, source, source_ref)' +
    ')'
  ).then(function () {
    return p.query(
      'CREATE INDEX IF NOT EXISTS unified_tasks_user_open_idx ON unified_tasks (user_id, status)'
    );
  }).then(function () {

    return p.query('ALTER TABLE unified_tasks ADD COLUMN IF NOT EXISTS link text');
  }).then(function () {
    // 2026-10-05 (Shira): the triage MEMORY. One row per (person, source,
    // item) the AI has ever been asked about — whatever it answered. Before
    // this, an email the AI judged "not a task" (or a call that failed) saved
    // nothing, so the same email went back to the AI on every single refresh.
    //   verdict: 'task' | 'skip' (not a task) | 'failed'
    //   content_hash: what the AI saw. For WhatsApp it's the unanswered
    //   messages, so a NEW client message in the same chat is asked about
    //   once more; the same messages never are.
    return p.query(
      'CREATE TABLE IF NOT EXISTS task_hub_triage (' +
      '  user_id uuid NOT NULL,' +
      '  source text NOT NULL,' +
      '  source_ref text NOT NULL,' +
      '  content_hash text NOT NULL,' +
      '  verdict text NOT NULL,' +
      '  attempts integer NOT NULL DEFAULT 1,' +
      '  last_attempt_at timestamptz NOT NULL DEFAULT now(),' +
      '  PRIMARY KEY (user_id, source, source_ref)' +
      ')'
    );
  }).then(function () {
    // 2026-10-06 (step 2): which thread an email task is in (to see a reply),
    // which task type it is, why it was closed automatically, and whether the
    // person re-opened it by hand (then it is never auto-closed again).
    return p.query(
      'ALTER TABLE unified_tasks ADD COLUMN IF NOT EXISTS thread_id text, ' +
      'ADD COLUMN IF NOT EXISTS task_type text, ' +
      'ADD COLUMN IF NOT EXISTS closed_reason text, ' +
      'ADD COLUMN IF NOT EXISTS keep_open boolean NOT NULL DEFAULT false'
    );
  }).then(function () {
    // 2026-10-05 (step 3): the monday deal a system reminder belongs to, and
    // when its monday column was last looked at.
    return p.query(
      'ALTER TABLE unified_tasks ADD COLUMN IF NOT EXISTS deal_id text, ' +
      'ADD COLUMN IF NOT EXISTS deal_board text, ' +
      'ADD COLUMN IF NOT EXISTS monday_checked_at timestamptz, ' +
      // step 4: monday already showed "done" when the task was linked, so
      // monday can't tell us anything new: the conversation decides.
      'ADD COLUMN IF NOT EXISTS monday_baseline_done boolean, ' +
      // deal linking (5 Oct): the deal's name for the card, and when an older
      // task was last tried (so each old task is looked up once, not forever).
      'ADD COLUMN IF NOT EXISTS deal_name text, ' +
      'ADD COLUMN IF NOT EXISTS deal_checked_at timestamptz, ' +
      // 6 Oct: the client's deals when the system couldn't tell which one
      // ([{id, board, name}]). Shown as a "choose a deal" menu on the card.
      'ADD COLUMN IF NOT EXISTS deal_candidates jsonb, ' +
      // 6 Oct: who the task is with, for the Clients / Office / Other tabs:
      // 'client' | 'office' (only firm people) | 'other' (lawyers, banks,
      // developers, systems) | 'unknown' (the email couldn't be read).
      'ADD COLUMN IF NOT EXISTS party text, ' +
      // 6 Oct (cards): who it's from — the email sender's name, or the
      // WhatsApp group / chat name.
      'ADD COLUMN IF NOT EXISTS source_name text, ' +
      // 6 Oct: more deals for the same task, chosen by hand ([{id, board, name}]).
      // deal_id stays the MAIN deal (the one monday can close the task by).
      'ADD COLUMN IF NOT EXISTS extra_deals jsonb, ' +
      // 6 Oct (finished tasks): the outside people on the email, its subject,
      // when the reply check last looked, and a short "why it closed" note.
      'ADD COLUMN IF NOT EXISTS contact_addrs text[], ' +
      'ADD COLUMN IF NOT EXISTS source_subject text, ' +
      'ADD COLUMN IF NOT EXISTS reply_checked_at timestamptz, ' +
      'ADD COLUMN IF NOT EXISTS closed_note text, ' +
      // up to when staff sent mail / WhatsApp was already looked at for this task
      'ADD COLUMN IF NOT EXISTS sent_checked_until timestamptz'
    );
  }).then(function () {
    // 6 Oct: every staff member's SENT mail (metadata + Gmail's short snippet),
    // read from each person's own Gmail on their refresh. Used to close
    // anyone's task that a colleague's email finished.
    return p.query(
      'CREATE TABLE IF NOT EXISTS staff_sent_mail (' +
      '  msg_id text PRIMARY KEY,' +
      '  user_id uuid NOT NULL,' +
      '  sender text, recipients text[], subject text, snippet text, thread_id text,' +
      '  deal_ids text[],' +
      '  sent_at timestamptz NOT NULL' +
      ')');
  }).then(function () {
    return p.query('CREATE INDEX IF NOT EXISTS staff_sent_mail_sent_idx ON staff_sent_mail (sent_at)');
  }).then(function () {
    return p.query('ALTER TABLE staff_sent_mail ADD COLUMN IF NOT EXISTS recipient_names text, ' +
      'ADD COLUMN IF NOT EXISTS inserted_at timestamptz NOT NULL DEFAULT now()');
  }).then(function () {
    // Every AI decision about sent mail / WhatsApp, with exactly what it saw —
    // for the accuracy report (sql/what-closed-and-why.sql).
    return p.query(
      'CREATE TABLE IF NOT EXISTS task_hub_sent_decisions (' +
      '  id serial PRIMARY KEY, task_id integer NOT NULL, user_id uuid NOT NULL,' +
      '  text_level text, items jsonb, answer text, item integer, reason text,' +
      '  closed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())');
  }).then(function () {
    return p.query('CREATE TABLE IF NOT EXISTS task_hub_sent_scan (user_id uuid PRIMARY KEY, last_sent_at timestamptz)');
  }).then(function () {
    // 6 Oct (Shira): the AI only judges messages sent AFTER this moment (set once,
    // at the first start of this version). Everything older was done one time in
    // Cowork, not through the API. Free checks (same-subject reply) still apply.
    return p.query('CREATE TABLE IF NOT EXISTS task_hub_settings (key text PRIMARY KEY, value text NOT NULL)');
  }).then(function () {
    return p.query("INSERT INTO task_hub_settings (key, value) VALUES ('sent_ai_from', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) ON CONFLICT (key) DO NOTHING");
  }).then(function () {
    // 6 Oct: reading in batches — an older stretch still to read (backfill_after..backfill_before),
    // and backfill_v2 = the first 14 days were re-read in full after the 100-email limit fix.
    return p.query('ALTER TABLE task_hub_sent_scan ADD COLUMN IF NOT EXISTS backfill_after timestamptz, ' +
      'ADD COLUMN IF NOT EXISTS backfill_before timestamptz, ADD COLUMN IF NOT EXISTS backfill_v2 boolean NOT NULL DEFAULT false');
  }).then(function () {
    // 6 Oct: automatic emails (Make etc.) known in advance — how to recognise each
    // (sender and/or subject) and what it does. The AI gets this one line instead
    // of the email. Filled in Neon (sql/auto-emails-*.sql); empty = no effect.
    return p.query(
      'CREATE TABLE IF NOT EXISTS task_hub_auto_emails (' +
      '  id serial PRIMARY KEY, name_he text NOT NULL, what_it_does text,' +
      '  sender text, subject_regex text, make_scenario_id text,' +
      '  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now())');
  }).then(function () {
    // One row per (task, sent email) the system already judged — never asked twice.
    return p.query(
      'CREATE TABLE IF NOT EXISTS task_hub_sent_checks (' +
      '  task_id integer NOT NULL, msg_id text NOT NULL, verdict text NOT NULL,' +
      '  attempts integer NOT NULL DEFAULT 1, checked_at timestamptz NOT NULL DEFAULT now(),' +
      '  PRIMARY KEY (task_id, msg_id))');
  }).then(function () {
    // 7 Oct (Shira, duplicate tasks): one task per matter, not per message.
    //   sender_addr  - who the task's first message came from (to find "same sender")
    //   merged_refs  - later messages folded into this task instead of new tasks
    //   last_msg_ref / last_msg_at - the newest of them (the reply check and the
    //                  sent-mail check look AFTER this, not after the first message)
    return p.query('ALTER TABLE unified_tasks ADD COLUMN IF NOT EXISTS sender_addr text, ' +
      'ADD COLUMN IF NOT EXISTS merged_refs text[], ' +
      'ADD COLUMN IF NOT EXISTS last_msg_ref text, ' +
      'ADD COLUMN IF NOT EXISTS last_msg_at timestamptz, ' +
      // 8 Oct: the people were read from the whole conversation (once per task),
      // and "look again at everything since the task" — also before the 6 Oct
      // AI start — because the task's people / deal were only found now.
      'ADD COLUMN IF NOT EXISTS people_checked_at timestamptz, ' +
      'ADD COLUMN IF NOT EXISTS recheck_old boolean NOT NULL DEFAULT false, ' +
      // 8 Oct (Shira: expired tasks): the date/time the task depends on, read by
      // the same triage call. 'schedule' = arranging a time (a call, a meeting):
      // once it passed the task goes under "המועד עבר". 'deadline' = must be done
      // by then: once it passed the task is urgent and marked overdue.
      'ADD COLUMN IF NOT EXISTS event_at timestamptz, ' +
      'ADD COLUMN IF NOT EXISTS event_kind text');
  }).then(function () {
    // 8 Oct (Shira): a known automatic email of the firm can be marked "not a
    // task": the email itself never becomes a task (a reply to it still can),
    // and for the people in skip_for nothing in its conversation does.
    return p.query('ALTER TABLE task_hub_auto_emails ADD COLUMN IF NOT EXISTS not_a_task boolean NOT NULL DEFAULT false, ' +
      'ADD COLUMN IF NOT EXISTS skip_for text[]');
  }).then(function () { return true; })
    .catch(function (e) { console.error('[task-hub] ensureTables failed:', e.message); _tablesReady = null; return false; });
  return _tablesReady;
}

async function getUserEmail(userId) {
  var r = await pool().query('SELECT email FROM users WHERE id = $1', [userId]);
  if (!r.rows.length) throw new Error('task-hub: no user found for id ' + userId);
  return r.rows[0].email;
}


var TZ = process.env.FIRM_TZ || 'Asia/Jerusalem';
var BIZ_START_HOUR = 8, BIZ_END_HOUR = 22; // 08:00-22:00
var BIZ_DAYS = [0, 1, 2, 3, 4]; // Sun(0)-Thu(4); Fri/Sat excluded

// 2026-10-05: rewritten for speed. The old version walked the whole time
// span in 15-minute steps and built a NEW Intl.DateTimeFormat on every step:
// a task first seen 50 days ago cost ~4,800 formatter builds, about 0.3s of
// pure CPU per task. listTasks() runs this for every open task, so anyone
// with a few dozen older tasks waited tens of seconds for their Task Hub, and
// the whole server (WhatsApp included) froze meanwhile. Now: one cached
// formatter, and the span is walked one DAY at a time, adding the overlap of
// each Sun-Thu 08:00-22:00 window. Same answer, a few microseconds per task.
var _tzFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
});
function localParts(date) {
  var map = {};
  _tzFmt.formatToParts(date).forEach(function (p) { map[p.type] = p.value; });
  return {
    y: parseInt(map.year, 10), m: parseInt(map.month, 10) - 1, d: parseInt(map.day, 10),
    h: parseInt(map.hour, 10) % 24, mi: parseInt(map.minute, 10), s: parseInt(map.second, 10)
  };
}
// How far the firm's clock is ahead of UTC at this moment, in ms.
function tzOffsetMs(date) {
  var p = localParts(date);
  return Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}
function businessHoursElapsedMs(fromDate, toDate) {
  var from = fromDate.getTime(), to = toDate.getTime();
  if (!(to > from)) return 0;
  var lp = localParts(fromDate);
  var counted = 0;
  // Walk local calendar days, at most ~13 months (same cap as before).
  for (var i = 0; i < 400; i++) {
    var dayUtcMidnight = Date.UTC(lp.y, lp.m, lp.d + i);
    var probe = new Date(dayUtcMidnight + 12 * 3600 * 1000); // local noon-ish: safe from DST edges
    var off = tzOffsetMs(probe);
    var dayStartUtc = dayUtcMidnight - off; // local 00:00 of that day, in real time
    if (dayStartUtc >= to) break;
    var weekday = new Date(dayUtcMidnight).getUTCDay();
    if (BIZ_DAYS.indexOf(weekday) === -1) continue;
    var winStart = dayStartUtc + BIZ_START_HOUR * 3600 * 1000;
    var winEnd = dayStartUtc + BIZ_END_HOUR * 3600 * 1000;
    var a = Math.max(winStart, from), b = Math.min(winEnd, to);
    if (b > a) counted += b - a;
  }
  return counted;
}

var AGE_THRESHOLD_MS = {
  whatsapp: 24 * 60 * 60 * 1000, // 1 business day
  email: 48 * 60 * 60 * 1000,    // 2 business days
  monday: 48 * 60 * 60 * 1000,
  manual: 72 * 60 * 60 * 1000
};
var PORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

var EXPIRE_AFTER_MS = 12 * 60 * 60 * 1000; // a "schedule" task is expired 12h after its time
function dateState(task) {
  if (!task || task.status !== 'open' || !task.event_at || !task.event_kind) return { expired: false, overdue: false };
  var at = new Date(task.event_at).getTime();
  if (isNaN(at)) return { expired: false, overdue: false };
  return { expired: task.event_kind === 'schedule' && Date.now() - at > EXPIRE_AFTER_MS,
           overdue: task.event_kind === 'deadline' && Date.now() > at };
}

function effectivePriority(task) {
  if (task.priority_overridden_by_user) return task.priority;
  if (dateState(task).overdue) return 'urgent';
  var threshold = AGE_THRESHOLD_MS[task.source] || 72 * 60 * 60 * 1000;
  var elapsed = businessHoursElapsedMs(new Date(task.first_seen_at), new Date());
  if (elapsed >= threshold && PORDER[task.priority] > PORDER.urgent) return 'urgent';
  return task.priority;
}


async function getActiveSkill(key) {
  var res = await pool().query(
    'SELECT s.body_md, s.model FROM task_hub_skill_active a ' +
    'JOIN task_hub_skills s ON s.id = a.skill_id WHERE a.key = $1',
    [key]
  );
  if (!res.rows.length) throw new Error('task-hub: no active skill for key "' + key + '" — run sql/2026-09-task-hub.sql');
  return res.rows[0];
}

// ---------------------------------------------------------------------------
// 2026-10-05 — the triage memory (see task_hub_triage in ensureTables).
//   never asked                      -> ask the AI
//   asked, content changed since     -> ask once more (new WA messages, a
//                                       voice note whose transcript arrived)
//   asked, answer 'task' or 'skip'   -> never ask again for this content
//   asked, the call failed           -> retry after 15 min, then after 2 h,
//                                       then stop until the content changes
// ---------------------------------------------------------------------------
var nodeCrypto = require('crypto');
function hashOf(s) {
  return nodeCrypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex').slice(0, 32);
}
var FAILED_RETRY_AFTER_MS = [15 * 60 * 1000, 2 * 60 * 60 * 1000];

// Task types from the table (cached 5 min; edits apply without a deploy).
var _typesCache = null, _typesAt = 0;
async function loadTaskTypes() {
  if (_typesCache && Date.now() - _typesAt < 5 * 60 * 1000) return _typesCache;
  // The types live only in the table (sql/2026-10-task-hub-types.sql).
  // Missing table or a read error: no rules this time — every email goes to
  // the AI exactly as before step 2, so nothing is lost.
  try {
    var r = await pool().query('SELECT * FROM task_hub_types WHERE active');
    _typesCache = r.rows; _typesAt = Date.now();
    if (!r.rows.length) console.warn('[task-hub] task_hub_types is empty — run sql/2026-10-task-hub-types.sql in Neon');
  } catch (e) {
    console.warn('[task-hub] could not load task_hub_types (run sql/2026-10-task-hub-types.sql in Neon); system reminders go to the AI this time:', e.message);
    _typesCache = _typesCache || [];
    _typesAt = Date.now(); // don't retry on every refresh; try again in 5 min
  }
  return _typesCache;
}

function triageKey(source, ref) { return source + ' ' + ref; }

async function loadTriageMemory(userId) {
  var res = await pool().query(
    'SELECT source, source_ref, content_hash, verdict, attempts, last_attempt_at FROM task_hub_triage WHERE user_id = $1',
    [userId]
  );
  var map = {};
  res.rows.forEach(function (r) { map[triageKey(r.source, r.source_ref)] = r; });
  return map;
}

function needsTriage(row, contentHash, nowMs) {
  if (!row) return true;
  if (row.content_hash !== contentHash) return true;
  if (row.verdict === 'task' || row.verdict === 'skip' || row.verdict === 'merged') return false;
  var wait = FAILED_RETRY_AFTER_MS[(row.attempts || 1) - 1];
  if (wait == null) return false; // tried 3 times — give up until the content changes
  return nowMs - new Date(row.last_attempt_at).getTime() >= wait;
}

function rememberTriage(userId, source, ref, contentHash, verdict) {
  // attempts counts tries on the SAME content; new content starts again at 1.
  return pool().query(
    `INSERT INTO task_hub_triage (user_id, source, source_ref, content_hash, verdict, attempts, last_attempt_at)
     VALUES ($1,$2,$3,$4,$5,1,now())
     ON CONFLICT (user_id, source, source_ref) DO UPDATE SET
       attempts = CASE WHEN task_hub_triage.content_hash = EXCLUDED.content_hash
                       THEN task_hub_triage.attempts + 1 ELSE 1 END,
       content_hash = EXCLUDED.content_hash,
       verdict = EXCLUDED.verdict,
       last_attempt_at = now()`,
    [userId, source, ref, contentHash, verdict]
  ).catch(function (e) { console.warn('[task-hub] triage memory write failed (non-fatal):', e.message); });
}

// At most `limit` AI calls in flight at once (the first refresh after deploy
// can have a dozen new items; they shouldn't all fire in the same instant).
async function runLimited(items, limit, fn) {
  var i = 0;
  async function worker() { while (i < items.length) { var it = items[i++]; await fn(it); } }
  var workers = [];
  for (var k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// 2026-10-05 (step 4): the triage call also names the task type and the
// client. Same single AI call — the type list is appended to what the AI
// already reads, built from task_hub_types (so a type added in Neon is used
// without a deploy). The memory's content hash is unchanged, so nothing
// already triaged is asked again because of this.
// ---------------------------------------------------------------------------
var _typeBlockCache = { src: null, text: '' };
function taskTypeInstructions(types) {
  var usable = (types || []).filter(function (t) { return t.active && t.approved; });
  if (!usable.length) return '';
  if (_typeBlockCache.src === types) return _typeBlockCache.text;
  var lines = usable.map(function (t) {
    return '- ' + t.key + ': ' + (t.name_en || '') + ' / ' + (t.name_he || '') + (t.hints ? ' — e.g. ' + t.hints : '');
  });
  var text = '\n\n---\nIn the same JSON, also return:\n' +
    '"task_type": exactly one key from this list (use "other" if none fits):\n' + lines.join('\n') + '\n' +
    '"client_name": the client or deal name exactly as written in the message (null if none is named). ' +
    'Never invent a name.';
  _typeBlockCache = { src: types, text: text };
  return text;
}
function pickType(types, key) {
  var k = String(key || '').trim().toLowerCase();
  if (!k) return null;
  return (types || []).find(function (t) { return t.active && t.approved && String(t.key).toLowerCase() === k; }) ||
    (types || []).find(function (t) { return t.key === 'other'; }) || null;
}

// Link a typed task to its monday deal (only for types that monday can close).
// WhatsApp: the group's own monday link. Email / task-inbox: the client name
// the AI read, which must match exactly ONE deal — otherwise no link.
// If monday ALREADY shows the thing as done at this moment, the client is
// asking about something finished, so monday can't close it: the
// conversation decides (monday_baseline_done = true).
// ---------------------------------------------------------------------------
// Deal linking (5 Oct 2026). Every task gets linked to its monday deal when
// that can be told for sure — no AI, no guessing. In order:
//   1. WhatsApp: the group's own monday link.
//   2. Email: the people on the email (From/To/Cc, the firm's own addresses
//      excluded) looked up on the clients board (לקוחות). One deal -> linked.
//      Several deals for that client -> only if the subject/text names one of
//      them (e.g. "דירה 116"). Otherwise not linked.
//   3. The client name the AI read from the message, matched to deal names.
// For types monday can close, the current state is saved as the baseline:
// already "done" when the message came in -> the conversation decides.
// ---------------------------------------------------------------------------
// 8 Oct: will tasks link only to will files (the צוואות board), apartment
// tasks prefer apartment deals; other types look at every deal as before.
var REAL_ESTATE_TYPES = ['make_payment', 'account_statement', 'contract_synopsis_review', 'complete_kyc',
  'engagement_kyc_esign', 'oleh_tax_benefit', 'purchase_tax', 'notary_poa', 'arnona_utilities', 'post_contract',
  'send_66', 'delivery_7_days', 'explain_developer_notice', 'defects_complaint', 'counterparty_request',
  'land_registry', 'foreign_resident_tax_reg'];
function dealKind(typeKey) {
  var k = String(typeKey || '');
  if (k === 'wills') return 'wills';
  return REAL_ESTATE_TYPES.indexOf(k) !== -1 ? 'realestate' : null;
}

async function resolveDeal(c, extracted, out, kind) {
  if (c.monday_item_id) {
    var board = await mondayCheck.boardOf(c.monday_item_id);
    if (!board) return null;
    var names = await mondayCheck.dealNames([String(c.monday_item_id)]);
    return { id: String(c.monday_item_id), board: board, name: names.get(String(c.monday_item_id)) || null, via: 'whatsapp group' };
  }
  var m = c.msg || {};
  var hint = [m.subject, m.snippet, extracted && extracted.title, extracted && extracted.client_name].filter(Boolean).join(' ');
  var addrs = mondayCheck.outsideAddresses(m.from, m.to, m.cc);
  if (addrs.length) {
    var byEmail = await mondayCheck.findDealByAddresses(addrs, hint, out, kind);
    if (byEmail) { byEmail.via = 'email address'; return byEmail; }
  }
  if (extracted && extracted.client_name) {
    var byName = await mondayCheck.findDeal(String(extracted.client_name), hint, out, kind);
    if (byName) { byName.via = 'client name'; return byName; }
  }
  // 8 Oct: a will task with no client email (staff write "חתימת צוואה - לוקסנבורג"):
  // the name in the text, matched to the will files and their clients' names.
  if (kind === 'wills' && typeof mondayCheck.findWillByText === 'function') {
    var willOut = {};
    var byText = await mondayCheck.findWillByText([extracted && extracted.client_name, extracted && extracted.title, m.subject].filter(Boolean).join(' '), willOut);
    if (byText) { byText.via = 'name in the task'; return byText; }
    if (willOut.candidates && !(out.candidates && out.candidates.length)) out.candidates = willOut.candidates;
  }
  return null;
}

async function saveDealLink(rowId, deal, type, opts) {
  var baseline = null;
  if (type && mondayCheck.hasRules(type)) {
    var res = (await mondayCheck.checkDeals([deal], function () { return type.monday_rules; })).get(deal.id);
    if (res) {
      // Older tasks found by the background pass: a reminder-type (group A)
      // task closes if monday already shows it done; a conversation task
      // (group C) only on a later change — same rule as the 5 Oct backfill.
      baseline = (opts && opts.oldTask && type.grp === 'A') ? false : !!res.done;
    }
  }
  if (!deal.name) {
    var n = await mondayCheck.dealNames([deal.id]).catch(function () { return new Map(); });
    deal.name = n.get(deal.id) || null;
  }
  await pool().query(
    'UPDATE unified_tasks SET deal_id = $1, deal_board = $2, deal_name = $3, deal_candidates = NULL, ' +
    'monday_baseline_done = COALESCE($4, monday_baseline_done), deal_checked_at = now() WHERE id = $5',
    [deal.id, deal.board, deal.name, baseline, rowId]);
}

// Tabs (6 Oct): who a task is with — no AI. A linked task (or one with deal
// options) is always a client task; the page checks that first.
async function partyFor(source, c, linked) {
  if (linked) return 'client';
  if (source === 'whatsapp') return 'client';   // the firm's WhatsApp groups are client groups
  if (source === 'manual') return 'office';     // notes from the task-inbox group
  if (/^sys:/.test(String(c.source_ref || ''))) return 'client';
  var m = c.msg || {};
  var addrs = mondayCheck.outsideAddresses(m.from, m.to, m.cc);
  if (!addrs.length) return 'office';           // only firm people on the email
  return (await mondayCheck.anyClientAddress(addrs).catch(function () { return false; })) ? 'client' : 'other';
}
async function saveParty(rowId, party) {
  if (party) await pool().query('UPDATE unified_tasks SET party = $2 WHERE id = $1', [rowId, party]);
}

async function saveCandidates(rowId, candidates) {
  var list = (candidates || []).map(function (d) { return { id: String(d.id), board: String(d.board), name: d.name || null }; });
  await pool().query(
    'UPDATE unified_tasks SET deal_checked_at = now(), deal_candidates = $2 WHERE id = $1',
    [rowId, list.length > 1 ? JSON.stringify(list) : null]);
}

// 6 Oct: the person links the deal from the card. Either one of the task's
// own candidates ("choose a deal"), or any deal found with the search box —
// that one must really be an item on one of the two deal boards.
// dealId null = "none of these". asAdmin: an admin in Team view (any task).
// For types monday can close, the current state is the baseline, so a deal
// that is already "done" doesn't close the task the moment it's chosen.
async function chooseDealForTask(userId, id, dealId, opts) {
  await ensureTables();
  var asAdmin = !!(opts && opts.asAdmin);
  var add = !!(opts && opts.add);
  var r = await pool().query(
    'SELECT id, task_type, deal_id, deal_candidates, extra_deals FROM unified_tasks WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)',
    [id, asAdmin ? null : userId]);
  var row = r.rows[0];
  if (!row) return null;
  if (!dealId) {
    await pool().query('UPDATE unified_tasks SET deal_candidates = NULL, updated_at = now() WHERE id = $1', [id]);
  } else {
    var cands = Array.isArray(row.deal_candidates) ? row.deal_candidates : [];
    var pick = cands.find(function (d) { return String(d.id) === String(dealId); });
    if (!pick) pick = await mondayCheck.verifyDeal(String(dealId));
    if (!pick) { var err = new Error('not a deal on the deal boards'); err.status = 400; throw err; }
    pick = { id: String(pick.id), board: String(pick.board), name: pick.name || null };
    if (row.deal_id && (add || String(row.deal_id) !== pick.id)) {
      // 6 Oct: the task already has a deal -> this one is added next to it
      // (more than one deal per task). The main deal is not changed.
      if (String(row.deal_id) !== pick.id) {
        var extras = (Array.isArray(row.extra_deals) ? row.extra_deals : []).filter(function (d) { return String(d.id) !== pick.id; });
        extras.push(pick);
        await pool().query('UPDATE unified_tasks SET extra_deals = $2, deal_candidates = NULL, updated_at = now() WHERE id = $1',
          [id, JSON.stringify(extras)]);
      }
    } else {
      var types = await loadTaskTypes();
      var type = types.find(function (t) { return t.key === row.task_type; }) || null;
      await saveDealLink(row.id, pick, type);
    }
    await pool().query("UPDATE unified_tasks SET party = 'client', updated_at = now() WHERE id = $1", [id]);
  }
  return (await pool().query('SELECT * FROM unified_tasks WHERE id = $1', [id])).rows[0];
}

// 6 Oct: take one deal off a task. Removing the main deal makes the next
// added deal the main one (or leaves the task with no deal).
async function removeDealFromTask(userId, id, dealId, opts) {
  await ensureTables();
  var asAdmin = !!(opts && opts.asAdmin);
  var r = await pool().query(
    'SELECT id, task_type, deal_id, extra_deals FROM unified_tasks WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)',
    [id, asAdmin ? null : userId]);
  var row = r.rows[0];
  if (!row) return null;
  var extras = Array.isArray(row.extra_deals) ? row.extra_deals : [];
  var rest = extras.filter(function (d) { return String(d.id) !== String(dealId); });
  if (row.deal_id && String(row.deal_id) === String(dealId)) {
    var next = rest.shift();
    if (next) {
      var types = await loadTaskTypes();
      var type = types.find(function (t) { return t.key === row.task_type; }) || null;
      await saveDealLink(row.id, { id: String(next.id), board: String(next.board), name: next.name || null }, type);
    } else {
      await pool().query(
        'UPDATE unified_tasks SET deal_id = NULL, deal_board = NULL, deal_name = NULL, monday_baseline_done = NULL WHERE id = $1', [id]);
    }
  }
  await pool().query('UPDATE unified_tasks SET extra_deals = $2, updated_at = now() WHERE id = $1',
    [id, rest.length ? JSON.stringify(rest) : null]);
  return (await pool().query('SELECT * FROM unified_tasks WHERE id = $1', [id])).rows[0];
}

async function searchDeals(q) {
  return mondayCheck.searchDeals(String(q || ''));
}

// 8 Oct: a deal found later (e.g. by "הצעה לביצוע" from the people in the whole
// email conversation). Only for a task that has no deal yet — never replaces one.
async function attachFoundDeal(taskId, deal) {
  await ensureTables();
  var row = (await pool().query('SELECT id, task_type, deal_id FROM unified_tasks WHERE id = $1', [taskId])).rows[0];
  if (!row || row.deal_id || !deal || !deal.id) return false;
  var types = await loadTaskTypes();
  var type = types.find(function (t) { return t.key === row.task_type; }) || null;
  await saveDealLink(row.id, { id: String(deal.id), board: String(deal.board), name: deal.name || null }, type);
  await pool().query("UPDATE unified_tasks SET party = 'client' WHERE id = $1", [row.id]);
  return true;
}

// Sender name, outside addresses and subject of an older email task (from one
// Gmail metadata read). msg null = unreadable: empty values, never retried.
async function saveHeaders(rowId, msg) {
  await pool().query(
    `UPDATE unified_tasks SET source_name = COALESCE(source_name, $2), contact_addrs = COALESCE(contact_addrs, $3),
            source_subject = COALESCE(source_subject, $4) WHERE id = $1`,
    [rowId, (msg && senderName(msg.from)) || '', msg ? mondayCheck.outsideAddresses(msg.from, msg.to, msg.cc) : [],
     (msg && msg.subject) || null]);
}

// "Name <a@b.com>" -> "Name". No name -> the address.
function senderName(from) {
  var f = String(from || '').trim();
  if (!f) return null;
  var m = f.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return (m[1].trim() || m[2].trim()).slice(0, 120);
  return f.slice(0, 120);
}

// 6 Oct: a WhatsApp group with no link — the person pastes the group's invite
// link on the card. Saved on the group (whatsapp_groups.invite_link), so the
// board and every task of that group get it. A link already saved for ANOTHER
// group is refused (it would open the wrong client's group).
var INVITE_RE = /^https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})$/;
async function setGroupLink(userId, id, link, opts) {
  await ensureTables();
  var asAdmin = !!(opts && opts.asAdmin);
  var clean = String(link || '').trim().split(/[?#\s]/)[0].replace(/\/+$/, '');
  if (!INVITE_RE.test(clean)) { var e1 = new Error('not a WhatsApp group link (https://chat.whatsapp.com/...)'); e1.status = 400; throw e1; }
  var r = await pool().query(
    "SELECT id, source, source_ref FROM unified_tasks WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)",
    [id, asAdmin ? null : userId]);
  var row = r.rows[0];
  if (!row) return null;
  if (row.source !== 'whatsapp' || !/@g\.us$/.test(String(row.source_ref || ''))) {
    var e2 = new Error('only for WhatsApp group tasks'); e2.status = 400; throw e2;
  }
  await pool().query('ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS invite_link text').catch(function () {});
  var other = await pool().query(
    'SELECT provider_group_jid FROM whatsapp_groups WHERE invite_link = $1 AND provider_group_jid <> $2 AND removed_at IS NULL LIMIT 1',
    [clean, row.source_ref]);
  if (other.rows.length) { var e3 = new Error('this link is already saved for another group'); e3.status = 400; throw e3; }
  await pool().query('UPDATE whatsapp_groups SET invite_link = $2 WHERE provider_group_jid = $1', [row.source_ref, clean]);
  await pool().query("UPDATE unified_tasks SET link = $2, updated_at = now() WHERE source = 'whatsapp' AND source_ref = $1", [row.source_ref, clean]);
  return (await pool().query('SELECT * FROM unified_tasks WHERE id = $1', [id])).rows[0];
}

// 6 Oct: fill what the cards show, no AI, a little each refresh:
//   - deal names for linked tasks that only had the id ("monday" on the card)
//   - WhatsApp: the group / chat name and the group's invite link
//   - email: the sender's name (one Gmail metadata read per older task)
var FILL_MAX = Math.max(1, parseInt(process.env.TASK_HUB_OLD_LINK_PER_REFRESH || '25', 10));
async function fillCardDetails(userId, waC) {
  var noName = (await pool().query(
    `SELECT id, deal_id FROM unified_tasks WHERE user_id = $1 AND status = 'open'
       AND deal_id IS NOT NULL AND (deal_name IS NULL OR deal_name = '') LIMIT 200`, [userId])).rows;
  if (noName.length) {
    var names = await mondayCheck.dealNames(noName.map(function (r) { return String(r.deal_id); }));
    for (var i = 0; i < noName.length; i++) {
      var n = names.get(String(noName[i].deal_id));
      if (n) await pool().query('UPDATE unified_tasks SET deal_name = $2 WHERE id = $1', [noName[i].id, n]);
    }
  }

  // WhatsApp chats on this refresh's list: name + link for tasks that lack them.
  for (var j = 0; j < (waC || []).length; j++) {
    var c = waC[j];
    if (!c.source_name && !c.link) continue;
    await pool().query(
      `UPDATE unified_tasks SET source_name = COALESCE(source_name, $3), link = COALESCE(link, $4)
        WHERE user_id = $1 AND source = 'whatsapp' AND source_ref = $2 AND status = 'open'
          AND (source_name IS NULL OR link IS NULL)`,
      [userId, c.source_ref, c.source_name || null, c.link || null]);
  }
  // Older WhatsApp group tasks: from the groups table.
  await pool().query(
    `UPDATE unified_tasks t SET source_name = COALESCE(t.source_name, g.name),
            link = COALESCE(t.link, CASE WHEN g.invite_link ~ '^https://chat\\.whatsapp\\.com/' THEN g.invite_link END)
       FROM whatsapp_groups g
      WHERE t.user_id = $1 AND t.source = 'whatsapp' AND t.status = 'open' AND g.provider_group_jid = t.source_ref
        AND (t.source_name IS NULL OR (t.link IS NULL AND g.invite_link IS NOT NULL))`, [userId]
  ).catch(function () { /* no whatsapp_groups / invite_link on this DB */ });

  var gmail = null;
  try { gmail = require('../lib/gmail'); } catch (e) { return; }
  if (!gmail || typeof gmail.getMessageAddresses !== 'function') return;
  var rows = (await pool().query(
    `SELECT id, source_ref FROM unified_tasks WHERE user_id = $1 AND status = 'open' AND source = 'email'
       AND (source_name IS NULL OR contact_addrs IS NULL) AND source_ref NOT LIKE 'sys:%' ORDER BY first_seen_at DESC LIMIT $2`,
    [userId, FILL_MAX])).rows;
  for (var k = 0; k < rows.length; k++) {
    var msg = await gmail.getMessageAddresses(userId, rows[k].source_ref).catch(function () { return null; });
    await saveHeaders(rows[k].id, msg);
  }
}

async function linkTaskToDeal(userId, source, c, extracted, type, ctx) {
  var existing = await pool().query(
    'SELECT id, deal_id, deal_board, deal_name FROM unified_tasks WHERE user_id = $1 AND source = $2 AND source_ref = $3',
    [userId, source, c.source_ref]);
  var row = existing.rows[0];
  if (!row) return;
  // Every triage means new content (a new client message re-opens a WhatsApp
  // task), so the baseline is taken again now: if monday is already "done",
  // this new message isn't answered by it.
  var deal = (row.deal_id && row.deal_board) ? { id: String(row.deal_id), board: String(row.deal_board), name: row.deal_name } : null;
  var out = {};
  if (!deal) deal = await resolveDeal(c, extracted, out, dealKind(type && type.key));
  await saveParty(row.id, await partyFor(source, c, !!deal || !!(out.candidates && out.candidates.length > 1)));
  if (!deal) {
    await saveCandidates(row.id, out.candidates);
    return;
  }
  await saveDealLink(row.id, deal, type);
  if (!row.deal_id) ctx.stats.linked_deal++;
}

// Older open tasks with no deal (created before deal linking): each is looked
// up ONCE, a few per refresh — email tasks by the people on the email (one
// cheap Gmail metadata read, no AI), WhatsApp tasks by the group's link.
var OLD_LINK_MAX = Math.max(1, parseInt(process.env.TASK_HUB_OLD_LINK_PER_REFRESH || '25', 10));
async function linkOldTasks(userId, ctx, mondayCtx) {
  // Party for tasks that need no lookup: linked to a deal / WhatsApp / system
  // reminders -> client, typed by hand -> office.
  await pool().query(
    `UPDATE unified_tasks SET party = CASE
        WHEN deal_id IS NOT NULL OR source = 'whatsapp' OR source_ref LIKE 'sys:%' THEN 'client'
        WHEN source = 'manual' THEN 'office' END
      WHERE user_id = $1 AND party IS NULL
        AND (deal_id IS NOT NULL OR source IN ('whatsapp', 'manual') OR source_ref LIKE 'sys:%')`, [userId]);
  var rows = (await pool().query(
    `SELECT id, source, source_ref, title, summary, task_type FROM unified_tasks
      WHERE user_id = $1 AND status = 'open' AND deal_id IS NULL
        AND (deal_checked_at IS NULL OR party IS NULL)
        AND (source IN ('email', 'whatsapp') OR (source = 'manual' AND task_type = 'wills')) AND source_ref NOT LIKE 'sys:%'
      ORDER BY first_seen_at DESC LIMIT $2`, [userId, OLD_LINK_MAX])).rows;
  if (!rows.length) return;
  var types = await loadTaskTypes();
  var gmail = null;
  try { gmail = require('../lib/gmail'); } catch (e) { /* no email lookups */ }
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    ctx.stats.old_checked++;
    var c = { source_ref: r.source_ref };
    try {
      if (r.source === 'whatsapp') {
        var mon = mondayCtx && mondayCtx.monday;
        if (mon && typeof mon.resolveDealForGroupId === 'function') {
          var link = await mon.resolveDealForGroupId(r.source_ref).catch(function () { return null; });
          if (link && link.monday_item_id) c.monday_item_id = String(link.monday_item_id);
        }
      } else if (r.source === 'email' && gmail && typeof gmail.getMessageAddresses === 'function') {
        var msg = await gmail.getMessageAddresses(userId, r.source_ref);
        if (!msg) {
          // The email can't be read (deleted, or Gmail not connected). Mark it
          // so it isn't retried forever and doesn't block the others.
          await pool().query("UPDATE unified_tasks SET deal_checked_at = now(), party = COALESCE(party, 'unknown'), source_name = COALESCE(source_name, ''), contact_addrs = COALESCE(contact_addrs, '{}') WHERE id = $1", [r.id]);
          // 8 Oct: a will task can still be linked by the name in its title.
          if (dealKind(r.task_type) !== 'wills') continue;
        } else {
          c.msg = msg;
          await saveHeaders(r.id, msg);
        }
      }
      var out = {};
      var deal = await resolveDeal(c, { title: r.title + ' ' + (r.summary || '') }, out, dealKind(r.task_type));
      await saveParty(r.id, await partyFor(r.source, c, !!deal || !!(out.candidates && out.candidates.length > 1)));
      if (deal) {
        var type = types.find(function (t) { return t.key === r.task_type; }) || null;
        await saveDealLink(r.id, deal, type, { oldTask: true });
        ctx.stats.old_linked++;
      } else {
        await saveCandidates(r.id, out.candidates);
      }
    } catch (e) {
      console.warn('[task-hub] old-task deal link failed (will retry later):', r.id, e.message);
    }
  }
}

// Decide, for one source, which candidates actually go to the AI, then run
// them and remember every answer. Shared by refreshTasks and the voice-note
// fast path, so the two can never double-ask about the same item.
async function triageWithMemory(userId, source, skillKey, candidates, ctx) {
  var types = await loadTaskTypes();
  var typeBlock = taskTypeInstructions(types);
  var todo = [];
  candidates.forEach(function (c) {
    ctx.stats.candidates++;
    var key = triageKey(source, c.source_ref);
    var row = ctx.memory[key];
    if (!row && ctx.taskKeys[key]) {
      // A task created before this memory existed — it WAS triaged once.
      // Record that instead of paying for it again. (A WhatsApp task someone
      // closed by hand stays closed; if the client writes again the content
      // changes and it's asked about normally.)
      ctx.stats.recorded_existing++;
      ctx.memory[key] = { content_hash: c.content_hash, verdict: 'task', attempts: 1, last_attempt_at: new Date() };
      ctx.writes.push(rememberTriage(userId, source, c.source_ref, c.content_hash, 'task'));
      return;
    }
    if (!needsTriage(row, c.content_hash, ctx.nowMs)) { ctx.stats.already_checked++; return; }
    todo.push(c);
  });

  // 7 Oct (duplicates): email and task-inbox messages are handled one at a
  // time, oldest first, and never at the same moment as another refresh for
  // the same person — so a second message about the same matter sees the task
  // the first one just made, and joins it instead of opening another.
  var oneByOne = source === 'email' || source === 'manual';
  if (oneByOne) todo.sort(function (a, b) { return new Date(a.first_seen_at) - new Date(b.first_seen_at); });
  var work = async function () {
    if (oneByOne && todo.length) {
      // Waited for another refresh of the same person: it may have just handled
      // some of these — read the memory again and drop what it did.
      var fresh = await loadTriageMemory(userId);
      var nowMs = Date.now();
      todo = todo.filter(function (c) {
        var row = fresh[triageKey(source, c.source_ref)];
        if (row && new Date(row.last_attempt_at).getTime() >= ctx.nowMs) return false; // handled meanwhile
        return needsTriage(row, c.content_hash, nowMs);
      });
    }
    return runLimited(todo, oneByOne ? 1 : 3, async function (c) {
    // 7 Oct: a new message in a conversation that already has an OPEN task for
    // this person joins that task — no AI call, no new task.
    if (source === 'email' && c.thread_id) {
      var host = await openTaskInThread(userId, c.thread_id, c.source_ref);
      if (host && canJoinThread(host, c)) {
        await mergeIntoTask(host.id, c, null);
        ctx.stats.merged_thread++;
        await rememberTriage(userId, source, c.source_ref, c.content_hash, 'merged');
        return;
      }
    }
    // 6 Oct: an email someone at the firm already answered (a later message in
    // the same conversation from us) is not a task — no AI call, remembered.
    if (source === 'email' && await answeredByFirm(userId, c.thread_id, c.source_ref)) {
      ctx.stats.skipped_answered++;
      await rememberTriage(userId, source, c.source_ref, c.content_hash, 'skip');
      return;
    }
    ctx.stats.ai_calls++;
    // 7 Oct: the person's open tasks from the same sender (email) or their own
    // recent task-inbox notes (manual), so the SAME call can say "this is the
    // same matter as task #N". Nothing extra is asked when there are none.
    var near = oneByOne ? await nearbyOpenTasks(userId, source, c).catch(function () { return []; }) : [];
    var extracted;
    try {
      extracted = await runSkill(skillKey, c.claudeInput + typeBlock + eventInstructions(c.first_seen_at) + sameAsInstructions(near));
    } catch (e) {
      ctx.stats.ai_failed++;
      console.warn('[task-hub] failed to triage', source, c.source_ref, e.message);
      await rememberTriage(userId, source, c.source_ref, c.content_hash, 'failed');
      return;
    }
    if (extracted.skip) {
      // Logged so a "board says X needs a reply, task hub never got one"
      // report can be traced to a deliberate AI skip.
      ctx.stats.ai_not_a_task++;
      console.log('[task-hub] ' + skillKey + ' skipped', source, c.source_ref, '(remembered — will not be re-asked)');
      await rememberTriage(userId, source, c.source_ref, c.content_hash, 'skip');
      return;
    }
    var sameId = parseInt(extracted.same_as, 10);
    if (sameId && near.some(function (t) { return t.id === sameId; })) {
      try {
        if (await mergeIntoTask(sameId, c, extracted)) {
          ctx.stats.merged_same++;
          await rememberTriage(userId, source, c.source_ref, c.content_hash, 'merged');
          return;
        }
      } catch (e) {
        console.warn('[task-hub] merge into #' + sameId + ' failed — saving as its own task:', e.message);
      }
    }
    var type = pickType(types, extracted.task_type);
    try {
      await upsertTask(userId, source, c.source_ref, extracted, c.first_seen_at, c.link,
        { reopenIfDone: source === 'whatsapp', threadId: c.thread_id || null, taskType: type ? type.key : null,
          sourceName: c.source_name || null, contactAddrs: c.contact_addrs || null, sourceSubject: c.source_subject || null,
          senderAddr: c.sender_addr || null, event: eventOf(extracted) });
      ctx.stats.tasks_written++;
      if (type) ctx.stats.typed++;
      if (source !== 'manual' || extracted.client_name || (type && type.key === 'wills')) {
        await linkTaskToDeal(userId, source, c, extracted, type, ctx).catch(function (e) {
          console.warn('[task-hub] deal link failed (non-fatal):', source, c.source_ref, e.message);
        });
      }
      await rememberTriage(userId, source, c.source_ref, c.content_hash, 'task');
    } catch (e) {
      // Saving failed (DB hiccup) — 'failed' so it retries on the schedule
      // above rather than on every refresh.
      console.warn('[task-hub] failed to save task', source, c.source_ref, e.message);
      await rememberTriage(userId, source, c.source_ref, c.content_hash, 'failed');
    }
  }); };
  if (oneByOne) return inTurn(userId + ' ' + source, work);
  return work();
}

// ---------------------------------------------------------------------------
// 7 Oct (Shira: "why are there duplicated tasks?"). Three ways the same matter
// became 2-3 tasks for the same person, and what happens now:
//   1. A new email in a conversation that already has an OPEN task for this
//      person -> joins that task (no AI). Closed task -> asked as before.
//   2./3. A new email from the same sender, or a task-inbox note, about the
//      same matter as an open task from the last 3 days -> the triage call
//      (the same single call) is shown those tasks and may answer
//      "same_as": N -> joins task N instead of opening a new one.
// Joining = the task stays one row: an "עדכון" line is added to its summary,
// the link points to the newest message, the saved suggestion is cleared (it
// was made before the new message), and the reply / sent-mail checks look
// after the newest message.
// ---------------------------------------------------------------------------
var _turns = {};
function inTurn(key, fn) {
  var prev = _turns[key] || Promise.resolve();
  var p = prev.catch(function () {}).then(fn);
  _turns[key] = p.catch(function () {});
  return p;
}

var SAME_AS_DAYS = 3;
var FIRM_SENDER = /@epsteinlaw\.co\.il$/i;

async function openTaskInThread(userId, threadId, sourceRef) {
  var r = await pool().query(
    `SELECT id, sender_addr FROM unified_tasks
      WHERE user_id = $1 AND source = 'email' AND thread_id = $2 AND status = 'open'
        AND source_ref NOT LIKE 'sys:%' AND source_ref <> $3
        AND NOT ($3 = ANY(COALESCE(merged_refs, '{}')))
      ORDER BY first_seen_at LIMIT 1`, [userId, threadId, sourceRef]);
  return r.rows[0] || null;
}

// A colleague's message in a CLIENT conversation is the firm answering — the
// reply check deals with it (it may finish the task), so it doesn't join.
// In an internal conversation (the task came from someone at the firm) every
// message is from the firm, so it joins.
function canJoinThread(host, c) {
  if (!FIRM_SENDER.test(String(c.sender_addr || ''))) return true;
  return FIRM_SENDER.test(String(host.sender_addr || ''));
}

async function nearbyOpenTasks(userId, source, c) {
  var since = new Date(Date.now() - SAME_AS_DAYS * 864e5).toISOString();
  var r;
  if (source === 'email') {
    if (!c.sender_addr && !c.source_name) return [];
    r = await pool().query(
      `SELECT id, title, summary FROM unified_tasks
        WHERE user_id = $1 AND source = 'email' AND status = 'open' AND source_ref NOT LIKE 'sys:%'
          AND COALESCE(last_msg_at, first_seen_at) > $2
          AND (sender_addr = $3 OR (sender_addr IS NULL AND source_name = $4))
        ORDER BY COALESCE(last_msg_at, first_seen_at) DESC LIMIT 6`,
      [userId, since, c.sender_addr || '', c.source_name || '']);
  } else {
    r = await pool().query(
      `SELECT id, title, summary FROM unified_tasks
        WHERE user_id = $1 AND source = 'manual' AND status = 'open'
          AND COALESCE(last_msg_at, first_seen_at) > $2
        ORDER BY COALESCE(last_msg_at, first_seen_at) DESC LIMIT 8`, [userId, since]);
  }
  return r.rows;
}

// 8 Oct (Shira: expired tasks) — the same triage call also names the date the
// task depends on. Relative dates are read from when the message arrived.
function eventInstructions(receivedAt) {
  var d = new Date(receivedAt || Date.now());
  var local = isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return '\n\n---\nThe message arrived on ' + local + ' (Israel time). In the same JSON also return:\n' +
    '"event_at": the date and time this task depends on, as "YYYY-MM-DDTHH:MM" in Israel time, resolving words like ' +
    '"tomorrow", "Sunday", "after 9:35" from the arrival date — or null if the task has no specific date/time;\n' +
    '"event_kind": "schedule" when the task is about arranging or confirming a time (a call, a meeting, a signing slot, ' +
    'availability), "deadline" when something must be done or paid by that date, or null.';
}
function parseEventAt(v) {
  var s = String(v || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  // Israel time -> UTC (Asia/Jerusalem offset on that day)
  var guess = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59);
  var off = tzOffsetMs(new Date(guess));
  var d = new Date(guess - off);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function eventOf(extracted) {
  if (!extracted) return { at: null, kind: null };
  var kind = ['schedule', 'deadline'].indexOf(extracted.event_kind) !== -1 ? extracted.event_kind : null;
  var at = kind ? parseEventAt(extracted.event_at) : null;
  return at ? { at: at, kind: kind } : { at: null, kind: null };
}

function sameAsInstructions(near) {
  if (!near || !near.length) return '';
  return '\n\n---\nThis person ALREADY has these open tasks ' +
    '(from the same sender / their own recent notes, last ' + SAME_AS_DAYS + ' days):\n' +
    near.map(function (t) {
      return '[#' + t.id + '] ' + t.title + (t.summary ? ' — ' + String(t.summary).replace(/\s+/g, ' ').slice(0, 220) : '');
    }).join('\n') +
    '\nIn the same JSON also return "same_as": the number of the task above that this message is about ' +
    'when it is the SAME matter and asks for no different action (a reminder, a repeat, a follow-up, a ' +
    'second copy, the same system error again). Otherwise "same_as": null. A different request, a ' +
    'different client or a different apartment is never same_as.';
}

// Fold message `c` into open task `taskId`. `extracted` (the AI's reading of
// the new message) is used for the update line when there is one. Returns
// true when the task was updated.
async function mergeIntoTask(taskId, c, extracted) {
  var text = extracted && extracted.title ? extracted.title
    : [c.source_name, c.msg && c.msg.snippet].filter(Boolean).join(' — ');
  var line = 'עדכון: ' + heDateTime(c.first_seen_at || new Date()) + ' — ' + String(text || 'הודעה חדשה').replace(/\s+/g, ' ').slice(0, 200);
  var r = await pool().query(
    `UPDATE unified_tasks SET
        summary = left(COALESCE(summary, '') || CASE WHEN COALESCE(summary, '') = '' THEN '' ELSE E'\\n' END || $2, 3000),
        merged_refs = array_append(COALESCE(merged_refs, '{}'), $3),
        last_msg_ref = CASE WHEN source = 'email' AND $4::text IS NOT NULL THEN $3 ELSE last_msg_ref END,
        thread_id = CASE WHEN source = 'email' AND $4::text IS NOT NULL THEN $4 ELSE thread_id END,
        last_msg_at = GREATEST(COALESCE(last_msg_at, first_seen_at), $5::timestamptz),
        link = COALESCE($6, link),
        priority = CASE WHEN priority_overridden_by_user THEN priority WHEN $7 = 'high' THEN 'high' ELSE priority END,
        event_at = CASE WHEN $9::text IS NOT NULL THEN $8::timestamptz ELSE event_at END,
        event_kind = COALESCE($9::text, event_kind),
        updated_at = now()
      WHERE id = $1 AND status = 'open'`,
    [taskId, line, c.source_ref, c.thread_id || null, c.first_seen_at || new Date().toISOString(), c.link || null,
     (extracted && extracted.priority) || '', eventOf(extracted).at, eventOf(extracted).kind]);
  if (!r.rowCount) return false;
  // The saved "הצעה לביצוע" was made before this message — the next open makes a new one.
  await pool().query('DELETE FROM task_hub_suggestions WHERE task_id = $1', [taskId]).catch(function () {});
  console.log('[task-hub] joined', c.source_ref, 'into task #' + taskId + (extracted ? ' (AI: same matter)' : ' (same conversation)'));
  return true;
}

function newTriageCtx(userId, taskRows, memory) {
  var taskKeys = {};
  taskRows.forEach(function (r) { taskKeys[triageKey(r.source, r.source_ref)] = true; });
  return {
    nowMs: Date.now(), memory: memory, taskKeys: taskKeys, writes: [],
    stats: { candidates: 0, already_checked: 0, recorded_existing: 0, ai_calls: 0,
             ai_not_a_task: 0, ai_failed: 0, tasks_written: 0,
             system_rule: 0, closed_replied: 0, system_already_done: 0, closed_monday: 0,
             typed: 0, linked_deal: 0, old_linked: 0, old_checked: 0,
             skipped_answered: 0, merged_thread: 0, merged_same: 0, people_found: 0, own_auto_skipped: 0, sent_scanned: 0, closed_monday_change: 0, closed_sent_same: 0, closed_sent_ai: 0, closed_sent_wa: 0, sent_ai_calls: 0 }
  };
}

async function runSkill(key, userContent) {
  var skill = await getActiveSkill(key);
  var extracted = await claude.askJSON({
    system: skill.body_md,
    user: userContent,
    model: skill.model || undefined, // falls back to CLAUDE_MODEL / the built-in default
    maxTokens: 500
  });
  if (!extracted) {
    throw new Error('task-hub: skill "' + key + '" got no usable JSON back (Claude not ' +
      'configured, or the reply wasn\'t valid JSON) — see [claude] askJSON logs above');
  }
  return extracted;
}


// 2026-10-05: Gmail's Date header can carry a trailing comment, e.g.
// "Mon, 05 Oct 2026 13:44:17 +0000 (UTC)". Postgres rejects that, so the task
// failed to save. Parse it in JS (drop any "(...)" comment); if it still
// can't be read, use now.
function toIsoDate(raw) {
  if (!raw) return new Date().toISOString();
  var d = new Date(String(raw).replace(/\s*\([^)]*\)\s*$/, ''));
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function fetchEmailCandidates(userId) {
  var gmail;
  try { gmail = require('../lib/gmail'); }
  catch (e) { console.warn('[task-hub] lib/gmail not found — skipping email source:', e.message); return []; }
  if (typeof gmail.searchMail !== 'function') {
    console.warn('[task-hub] lib/gmail.searchMail not found — skipping email source');
    return [];
  }

  var result;
  try {
    result = await gmail.searchMail(userId, {
      query: 'is:unread newer_than:14d -category:promotions',
      maxResults: 15
    });
  } catch (e) {
    console.warn('[task-hub] gmail.searchMail failed for', userId, e.message);
    return [];
  }
  if (!result || result.connected === false) {
    return [];
  }

  // 2026-09-16 (Shira): "if I'm CC'd on an email and someone responds there
  // but it's not to me, no need to surface it." A message where the signed-in
  // user is only in Cc (not To) whose thread already has a later message —
  // from anyone, on any side — means whoever it was actually addressed to is
  // already handling it, so it's skipped as a candidate entirely. A CC'd
  // message on a thread with nothing after it yet still becomes a candidate
  // as before, since nobody may be handling it. This fails OPEN on any
  // lookup error (gmail.getThreadActivity returns null) — an unknown thread
  // state never suppresses a real task, only a confirmed "someone already
  // replied" does.
  var mailbox = String(result.mailbox || '').toLowerCase();
  var out = [];
  var msgs = result.messages || [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    var addressedToMe = mailbox ? gmail.headerHasAddress(m.to, mailbox) : true; // unknown mailbox -> don't guess, treat as normal
    var ccOnly = !addressedToMe && mailbox && gmail.headerHasAddress(m.cc, mailbox);

    if (ccOnly && m.threadId && typeof gmail.getThreadActivity === 'function') {
      var activity = await gmail.getThreadActivity(userId, m.threadId);
      if (activity && activity.messageCount > 1) {
        console.log('[task-hub] email', m.id, 'skipped — CC-only, thread already has', activity.messageCount, 'message(s)');
        continue;
      }
    }

    out.push({
      msg: m,
      thread_id: m.threadId || null,
      source_ref: m.id,
      content_hash: hashOf('email:' + m.id), // a Gmail message never changes
      first_seen_at: toIsoDate(m.date),
      link: m.id ? gmailLink(mailbox, m.threadId || m.id) : null,
      source_name: senderName(m.from),
      sender_addr: taskTypes.senderAddress(m.from) || null,
      contact_addrs: mondayCheck.outsideAddresses(m.from, m.to, m.cc),
      source_subject: m.subject || null,
      claudeInput: 'Subject: ' + (m.subject || '') + '\nFrom: ' + (m.from || '') +
        (ccOnly ? '\n(You were CC\'d on this, not a direct recipient)' : '') +
        '\nSnippet: ' + (m.snippet || '')
    });
  }
  return out;
}

// 2026-10-04: myDeals() scans whole monday boards. It used to run on every
// refresh for every user, before anything else could start. Cached per person
// for TASK_HUB_MONDAY_TTL_SECONDS (default 20 minutes). Failures aren't cached.
var _mondayCache = {};
var MONDAY_TTL_MS = Math.max(60, parseInt(process.env.TASK_HUB_MONDAY_TTL_SECONDS || '1200', 10)) * 1000;
async function cachedMyDeals(monday, userEmail) {
  var key = String(userEmail || '').toLowerCase();
  var hit = _mondayCache[key];
  if (hit && Date.now() - hit.at < MONDAY_TTL_MS) return hit.value;
  var value = await monday.myDeals(userEmail);
  _mondayCache[key] = { at: Date.now(), value: value };
  return value;
}

async function fetchMondayContext(userEmail) {
  var monday;
  try { monday = require('../lib/monday'); }
  catch (e) { console.warn('[task-hub] lib/monday not found — no monday context:', e.message); return { monday: null, byItemId: {}, count: 0 }; }
  if (!monday.isConfigured || !monday.isConfigured()) {
    console.warn('[task-hub] MONDAY_API_TOKEN not set — no monday context');
    return { monday: null, byItemId: {}, count: 0 };
  }
  var res;
  try {
    res = await cachedMyDeals(monday, userEmail);
  } catch (e) {
    console.warn('[task-hub] monday.myDeals failed for', userEmail, e.message);
    return { monday: monday, byItemId: {}, count: 0 };
  }
  var byItemId = {};
  (res && res.deals || []).forEach(function (d) { byItemId[String(d.id)] = d; });
  return { monday: monday, byItemId: byItemId, count: Object.keys(byItemId).length };
}

// 2026-09-17 (Shira): "give a link to the deal in monday" — myDeals() has
// carried a real monday item URL (d.url) on every deal all along, this just
// never got passed into the text the wa-triage skill actually reads. Adding
// it here, as its own clearly-labeled line, is the only code change needed
// for the wa-triage skill to be able to put a real, never-invented link in
// a task's summary — the skill prompt (task_hub_skills, DB-only, see the
// 2026-09-17 SQL) does the rest. No other deal data changes here: the field
// set already excludes payment amounts/balances (those live only on the
// separate תשלומים board, not in config/monday-boards.json), so nothing new
// is being exposed.
function dealBackgroundText(d) {
  if (!d) return '';
  var fieldLines = Object.keys(d.fields || {})
    .filter(function (k) { return d.fields[k]; })
    .map(function (k) { return '  ' + k + ': ' + d.fields[k]; })
    .join('\n');
  return 'Deal background (from monday, for context only, not the task itself) - ' +
    d.name + ' [board: ' + d.board + ', your role: ' + d.role + ']:\n' + fieldLines +
    (d.url ? '\n  monday link: ' + d.url : '');
}

async function waLinkFor(chat) {
  if (!chat) return null;
  if (!chat.isGroup) {
    var digits = String(chat.lastClientPhone || '').replace(/\D/g, '');
    return digits.length >= 9 ? ('https://wa.me/972' + digits.slice(-9)) : null;
  }
  if (!chat.chat_jid) return null;
  try {
    var r = await pool().query(
      'SELECT invite_link FROM whatsapp_groups WHERE provider_group_jid = $1 AND removed_at IS NULL LIMIT 1',
      [chat.chat_jid]
    );
    var link = r.rows[0] && r.rows[0].invite_link;
    return (link && /^https:\/\/chat\.whatsapp\.com\//.test(link)) ? link : null;
  } catch (e) {
    return null; // column may not exist on this DB yet — non-fatal
  }
}

// 2026-09-16 (Shira): "a WA chat that was already answered still shows up as
// a task since it wasn't marked done." Every 5 minutes (and on every manual
// refresh) refreshTasks() already re-fetches exactly which of this user's
// chats are STILL unanswered right now — but that was only ever used to
// decide whether to CREATE a new task (isNewCandidate), never to close an
// existing open one. See the auto-close block in refreshTasks() below.
// That block needs to tell "genuinely queried WhatsApp and got zero results
// still needing this user" apart from "couldn't even check" (no staffPhone
// on file, or the wa db module failed to load) — closing real open tasks on
// an ambiguous/failed check would be a real regression (this file has
// already had a same-shaped bug: a silent fetch failure once looked
// identical to "nothing to do" and made real chats vanish, see the
// 2026-09-14/15 notes above). So this now returns { ok, candidates }
// instead of a bare array: ok is only true once listUnansweredChats() has
// actually run and returned a real (possibly empty) answer for this user —
// never on the early-return skips below. If listUnansweredChats() itself
// throws, this function throws too (no try/catch around that call, by
// design), which Promise.allSettled in refreshTasks() correctly surfaces
// as ok:false rather than a false "all resolved".
async function fetchWhatsappCandidates(userEmail, mondayCtx) {
  var waDb;
  try { waDb = require('../whatsapp/ingest/db'); }
  catch (e) { console.warn('[task-hub] whatsapp/ingest/db not found — skipping WhatsApp source:', e.message); return { ok: false, candidates: [] }; }

  var staffDir;
  try { staffDir = require('../config/staff-directory.json'); } catch (e) { staffDir = null; }
  var staffPhone = null;
  if (staffDir && Array.isArray(staffDir.staff)) {
    var entry = staffDir.staff.find(function (s) { return s && s.email === userEmail; });
    staffPhone = entry && entry.phone9;
  }
  if (!staffPhone) {
    console.warn('[task-hub] no phone9 found in config/staff-directory.json for', userEmail, '— skipping WhatsApp source');
    return { ok: false, candidates: [] };
  }

  // listUnansweredChats() also powers the shared control board (Board.html)
  // and deliberately returns EVERY unanswered chat firm-wide — it is NOT
  // scoped to one person. Each chat it returns carries its own resolved
  // responsibleEmail (NULL = not yet resolved, '' = resolved to a default/
  // fallback owner, an address = resolved to a specific staff member).
  //
  // 2026-09-14 (Shira): this used to feed EVERY result straight into the
  // signed-in user's Task Hub with no filtering at all — so any staff
  // member with a phone9 on file got every other staff member's unanswered
  // chats mixed into their own personal list (confirmed live: Talya's Task
  // Hub was showing chats responsible to Shayna, to other staff, and a
  // large not-yet-resolved bucket, alongside her own 20). Filter to this
  // user's own chats before turning them into candidates.
  //
  // Chats with no resolved owner (NULL or '') are intentionally left out of
  // every personal Task Hub — they still show on the shared Board.html,
  // which stays the right place for an unowned chat until someone claims
  // it or the resolver assigns it.
  var allChats = await waDb.listUnansweredChats({ hours: 0, staffPhones: [staffPhone] });
  // 2026-10-07 (Shira): who answers NOW = the latest signal in the chat: an
  // @tag (by the client or by staff), the client addressing someone by name,
  // the last staff member who replied (not the partner), or a newer Board
  // choice — and it stays with them until a newer signal. Nothing at all ->
  // the group's owner (which never changes). Same rule as the Board.
  var dir = staffDir || { staff: [] };
  var overrides = new Map(), lidMap = new Map(), resp = null;
  try { resp = require('./responsible'); } catch (e) { resp = null; }
  try { overrides = await waDb.getResponsibleOverrides(allChats.map(function (c) { return c.chat_jid; })); } catch (e) { /* none */ }
  try { if (typeof waDb.staffLidMap === 'function') lidMap = await waDb.staffLidMap(); } catch (e) { /* none */ }
  var answerer = function (c) {
    var now = resp && typeof resp.currentAnswerer === 'function' ? resp.currentAnswerer(c, dir, lidMap, overrides.get(c.chat_jid)) : null;
    if (now && now.email) return { email: now.email, why: now.why };
    if (c.responsibleEmail) return { email: c.responsibleEmail, why: 'owner' };
    // 2026-10-07 (Shira): no owner and no recent signal -> the last staff
    // member who ever replied in the chat (not the partner).
    var last = resp && typeof resp.lastReplierEver === 'function' ? resp.lastReplierEver(c, dir) : null;
    if (last) return { email: last.email, why: 'last_ever' };
    return { email: '', why: 'owner' };
  };
  var chats = allChats.filter(function (c) {
    var a = answerer(c);
    c.answerWhy = a.why;
    c.answerEmail = a.email;
    return a.email === userEmail;
  });
  // 7 Oct: who has each waiting chat now (firm-wide), so a task that leaves this
  // person's list can say "moved to X" instead of "answered".
  var waitingWith = {};
  allChats.forEach(function (c) { waitingWith[c.chat_jid] = { email: c.answerEmail || '', why: c.answerWhy }; });
  // 2026-10-07 (Shira): "messages in and I don't see tasks". A chat whose
  // answerer is nobody (no owner on monday and no staff signal in the chat)
  // lands in no one's list — name them in the log so they can be found.
  var nobody = allChats.filter(function (c) { return !answerer(c).email; });
  if (nobody.length) {
    console.log('[task-hub] whatsapp: ' + nobody.length + ' waiting chat(s) belong to no one — no owner and no staff member (other than the partner) ever replied (only on the Board): ' +
      nobody.map(function (c) { return (c.groupName || c.clientName || c.chat_jid); }).slice(0, 20).join(' | '));
  }
  // 2026-09-15 (Shira): visibility only — so "0 candidates" is distinguishable
  // in the logs from "this call never even ran" (see the rejection logging
  // added in refreshTasks above) and from "found some, all filtered out by
  // wa-triage/isNewCandidate downstream".
  console.log('[task-hub] whatsapp: listUnansweredChats returned', allChats.length,
    'firm-wide,', chats.length, 'for', userEmail,
    '(' + ['tagged', 'addressed', 'last_replied', 'board', 'owner', 'last_ever'].map(function (w) {
      return w + ' ' + chats.filter(function (c) { return c.answerWhy === w; }).length; }).join(', ') + ')');

  var activeVoiceRules = '';
  try {
    var skillsRes = await pool().query(
      "SELECT s.body_md FROM wa_skill_active a JOIN wa_skills s ON s.id = a.skill_id " +
      "WHERE a.key IN ('voice','rules')"
    );
    activeVoiceRules = skillsRes.rows.map(function (r) { return r.body_md; }).join('\n\n');
  } catch (e) {
    console.warn('[task-hub] could not read wa_skills for grounding (non-fatal):', e.message);
  }

  var out = [];
  for (var i = 0; i < (chats || []).length; i++) {
    var c = chats[i];
    var dealText = '';
    var mondayItemId = null;

    if (mondayCtx && mondayCtx.monday && typeof mondayCtx.monday.resolveDealForGroupId === 'function') {
      try {
        var link = await mondayCtx.monday.resolveDealForGroupId(c.chat_jid);
        if (link && link.monday_item_id) mondayItemId = String(link.monday_item_id);
        if (link && mondayCtx.byItemId[String(link.monday_item_id)]) {
          dealText = dealBackgroundText(mondayCtx.byItemId[String(link.monday_item_id)]);
        }
      } catch (e) { /* best-effort, ignore */ }
    }
    out.push({
      source_ref: c.chat_jid,
      monday_item_id: mondayItemId,
      // The unanswered messages themselves: a new client message in the same
      // chat changes this, which is exactly when it should be asked again.
      content_hash: hashOf('wa:' + (c.blockText || '')),
      first_seen_at: c.firstUnansweredAt || new Date().toISOString(),
      link: await waLinkFor(c),
      source_name: c.label || null,
      claudeInput:
        'Chat: ' + (c.label || c.chat_jid) + '\n' +
        'Waited: ' + (c.calendarHoursWaiting != null ? c.calendarHoursWaiting + 'h' : 'unknown') + '\n' +
        'Unanswered messages:\n' + (c.blockText || '') +
        (dealText ? ('\n\n' + dealText) : '') +
        (activeVoiceRules ? ('\n\nFirm WhatsApp voice/rules knowledge:\n' + activeVoiceRules) : '')
    });
  }
  return { ok: true, candidates: out, waitingWith: waitingWith };
}


async function fetchManualCandidates(userId, userEmail) {
  var waDb;
  try { waDb = require('../whatsapp/ingest/db'); }
  catch (e) { console.warn('[task-hub] whatsapp/ingest/db not found — skipping manual-task-inbox source:', e.message); return []; }

  var jid;
  try {
    var groupRow = await pool().query(
      'SELECT provider_group_jid FROM whatsapp_groups WHERE task_owner_email = $1 AND removed_at IS NULL LIMIT 1',
      [userEmail]
    );
    jid = groupRow.rows[0] && groupRow.rows[0].provider_group_jid;
  } catch (e) {
    console.warn('[task-hub] could not look up personal task-inbox group for', userEmail, e.message);
    return [];
  }

  if (!jid) return [];

  // 2026-10-05: was "only messages newer than my newest task-inbox task",
  // which silently dropped a voice note whose transcript finished AFTER a
  // later typed message had already become a task. The triage memory now
  // does the dedup (each message is asked about once), so this is just a
  // 14-day window.
  var sinceMs = Date.now() - 14 * 24 * 60 * 60 * 1000;

  var msgs;
  try {
    msgs = await waDb.listTaskInboxMessages(jid, { limit: 20 });
  } catch (e) {
    console.warn('[task-hub] listTaskInboxMessages failed for', jid, e.message);
    return [];
  }
  msgs = (msgs || []).filter(function (m) { return new Date(m.eff_at).getTime() > sinceMs; });
  return (msgs || []).map(function (m) {
    return {
      source_ref: m.source_item_id,
      content_hash: hashOf('manual:' + m.source_item_id + ':' + (m.text || '')),
      first_seen_at: m.eff_at || new Date().toISOString(),
      claudeInput: m.text
    };
  });
}



// 2026-09-15 (Shira): a WhatsApp chat_jid isn't like an email id — it's the
// same identifier for an entire ongoing conversation. Marking a WhatsApp
// task "done" should only mean "nothing owed right now", not "never surface
// this chat again" — but the original WHERE status='open' guard made ANY
// done row permanently inert: a staff member could mark a chat done, the
// client could send a brand-new message the next day, and refreshTasks()
// would silently do nothing (confirmed live: a chat resolved to a staff
// member who HAD opened Task Hub still never became a task, because an old
// done row for that same chat_jid was blocking it both here and in
// isNewCandidate() below). reopenIfDone lets the whatsapp call site opt into
// reopening a done row when the chat is genuinely back with something
// unanswered; email/manual keep the original guard (a still-"unread" email
// resurfacing from Gmail's own query shouldn't undo someone's done mark).
async function upsertTask(userId, source, sourceRef, extracted, firstSeenAt, link, opts) {
  var reopenIfDone = !!(opts && opts.reopenIfDone);
  var threadId = (opts && opts.threadId) || null;
  var taskType = (opts && opts.taskType) || null;
  var sourceName = (opts && opts.sourceName) || null;
  var contactAddrs = (opts && Array.isArray(opts.contactAddrs)) ? opts.contactAddrs : null;
  var sourceSubject = (opts && opts.sourceSubject) || null;
  var senderAddr = (opts && opts.senderAddr) || null;
  var ev = (opts && opts.event) || { at: null, kind: null };
  await pool().query(
    `INSERT INTO unified_tasks (user_id, source, source_ref, title, summary, estimated_minutes, priority, first_seen_at, link, thread_id, task_type, source_name, contact_addrs, source_subject, sender_addr, event_at, event_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (user_id, source, source_ref) DO UPDATE SET
       event_at = CASE WHEN EXCLUDED.event_kind IS NOT NULL THEN EXCLUDED.event_at ELSE unified_tasks.event_at END,
       event_kind = COALESCE(EXCLUDED.event_kind, unified_tasks.event_kind),
       sender_addr = COALESCE(EXCLUDED.sender_addr, unified_tasks.sender_addr),
       source_name = COALESCE(EXCLUDED.source_name, unified_tasks.source_name),
       contact_addrs = COALESCE(EXCLUDED.contact_addrs, unified_tasks.contact_addrs),
       source_subject = COALESCE(EXCLUDED.source_subject, unified_tasks.source_subject),
       thread_id = COALESCE(EXCLUDED.thread_id, unified_tasks.thread_id),
       task_type = COALESCE(EXCLUDED.task_type, unified_tasks.task_type),
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       estimated_minutes = EXCLUDED.estimated_minutes,
       priority = CASE WHEN unified_tasks.priority_overridden_by_user THEN unified_tasks.priority ELSE EXCLUDED.priority END,
       link = COALESCE(EXCLUDED.link, unified_tasks.link),
       status = CASE WHEN unified_tasks.status = 'done' AND $10 THEN 'open' ELSE unified_tasks.status END,
       done_at = CASE WHEN unified_tasks.status = 'done' AND $10 THEN NULL ELSE unified_tasks.done_at END,
       first_seen_at = CASE WHEN unified_tasks.status = 'done' AND $10 THEN EXCLUDED.first_seen_at ELSE unified_tasks.first_seen_at END,
       updated_at = now()
     WHERE unified_tasks.status = 'open' OR ($10 AND unified_tasks.status = 'done')`,
    [userId, source, sourceRef, extracted.title, extracted.summary || null,
     extracted.estimated_minutes || null, extracted.priority || 'normal', firstSeenAt, link || null, reopenIfDone,
     threadId, taskType, sourceName, contactAddrs, sourceSubject, senderAddr, ev.at, ev.kind]
  );
}

// ---------------------------------------------------------------------------
// 2026-10-06 (step 2): the automatic reminder emails Make sends from tzkk@
// (7 days to delivery, Post Contract, 66, KYC, notary POA). Recognised by
// sender + subject (lib/task-types.js) and turned into a task with NO AI.
// One task per type + client: the weekly 66 reminder for the same client
// updates the same task instead of adding a new one each week. If the
// subject names no client, each email is its own task.
// These are group A: a reply does NOT close them — the monday column will
// (step 3) — and a task someone closed by hand stays closed.
// ---------------------------------------------------------------------------
var _preDone = new Map(); // user+ref -> when monday showed it done (skip re-asking monday for an hour)
async function handleSystemEmails(userId, matches, ctx) {
  for (var i = 0; i < matches.length; i++) {
    var c = matches[i].candidate, hit = matches[i].hit, t = hit.type;
    var ref = 'sys:' + t.key + ':' + (hit.clientKey || c.source_ref);
    var title = t.name_he + (hit.clientText ? ' – ' + hit.clientText : '');
    var summary = 'Automatic reminder (' + (t.name_en || t.key) + ').' +
      (t.done_text ? '\nDone when: ' + t.done_text : '') +
      (t.monday_check ? '\nCheck in monday: ' + t.monday_check : '');
    // Step 3: if monday already shows this as done, don't create the task.
    // Any monday error or no clear deal: create it exactly as before. Only
    // asked for reminders that aren't a task yet; open tasks are handled by
    // closeMondayDoneTasks below.
    var deal = null;
    var preKey = userId + ' ' + ref;
    if (_preDone.has(preKey) && Date.now() - _preDone.get(preKey) < 60 * 60 * 1000) continue; // seen as done within the hour
    if (mondayCheck.hasRules(t) && hit.clientText && !ctx.taskKeys[triageKey('email', ref)]) {
      try {
        deal = await mondayCheck.findDeal(hit.clientText);
        if (deal) {
          var res = (await mondayCheck.checkDeals([deal], function () { return t.monday_rules; })).get(deal.id);
          if (res && res.done) {
            ctx.stats.system_already_done++;
            _preDone.set(preKey, Date.now());
            console.log('[task-hub] system reminder already done in monday, no task:', ref, '—', res.evidence);
            continue;
          }
        }
      } catch (e) {
        console.warn('[task-hub] monday pre-check failed (task created anyway):', ref, e.message);
      }
    }
    try {
      await upsertTask(userId, 'email', ref, { title: title, summary: summary, priority: 'normal' },
        c.first_seen_at, c.link, { threadId: c.thread_id, taskType: t.key, sourceName: c.source_name || null,
          contactAddrs: c.contact_addrs || null, sourceSubject: c.source_subject || null });
      if (deal) {
        await pool().query(
          'UPDATE unified_tasks SET deal_id = $1, deal_board = $2, deal_name = $3, deal_checked_at = now() ' +
          'WHERE user_id = $4 AND source = $5 AND source_ref = $6',
          [deal.id, deal.board, deal.name || null, userId, 'email', ref]);
      }
      ctx.stats.system_rule++;
    } catch (e) {
      console.warn('[task-hub] failed to save system-reminder task', ref, e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 2026-10-05 (step 3): close open system-reminder tasks once monday says the
// thing is done (closed_reason 'monday'). No AI. Each task is looked at most
// every TASK_HUB_MONDAY_RECHECK_MINUTES (default 10), up to 30 per refresh,
// with one monday query per board. Unknown (no deal found, monday error, item
// not readable) never closes anything. A task re-opened by hand (keep_open)
// is left alone.
// ---------------------------------------------------------------------------
var MONDAY_CHECK_MAX = 30;
var MONDAY_RECHECK_MIN = Math.max(1, parseInt(process.env.TASK_HUB_MONDAY_RECHECK_MINUTES || '10', 10));
async function closeMondayDoneTasks(userId, ctx) {
  var types = await loadTaskTypes();
  var byKey = {};
  types.forEach(function (t) { if (mondayCheck.hasRules(t)) byKey[t.key] = t; });
  if (!Object.keys(byKey).length) return;
  var rows = (await pool().query(
    `SELECT id, source_ref, title, task_type, deal_id, deal_board FROM unified_tasks
      WHERE user_id = $1 AND status = 'open' AND NOT keep_open AND task_type = ANY($2)
        AND ((source = 'email' AND source_ref LIKE 'sys:%')
             OR (deal_id IS NOT NULL AND monday_baseline_done = false))
        AND (monday_checked_at IS NULL OR monday_checked_at < now() - ($3 || ' minutes')::interval)
      ORDER BY monday_checked_at NULLS FIRST LIMIT $4`,
    [userId, Object.keys(byKey), String(MONDAY_RECHECK_MIN), MONDAY_CHECK_MAX]
  )).rows;
  if (!rows.length) return;
  var withDeal = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.deal_id && /^sys:/.test(r.source_ref)) {
      // Older reminder task: the client/deal name is what follows the dash in the title.
      var m = String(r.title || '').match(/\s[–—-]\s(.+)$/);
      var deal = m ? await mondayCheck.findDeal(m[1]).catch(function () { return null; }) : null;
      if (deal) {
        r.deal_id = deal.id; r.deal_board = deal.board;
        await pool().query('UPDATE unified_tasks SET deal_id = $1, deal_board = $2, deal_name = COALESCE($4, deal_name) WHERE id = $3',
          [deal.id, deal.board, r.id, deal.name || null]);
      }
    }
    if (r.deal_id) withDeal.push(r);
  }
  var ids = rows.map(function (r) { return r.id; });
  await pool().query('UPDATE unified_tasks SET monday_checked_at = now() WHERE id = ANY($1)', [ids]);
  if (!withDeal.length) return;
  // One deal can carry several reminder types; check each type's deals together.
  var results = {};
  var groups = {};
  withDeal.forEach(function (r) { (groups[r.task_type] = groups[r.task_type] || []).push(r); });
  for (var key in groups) {
    var deals = groups[key].map(function (r) { return { id: String(r.deal_id), board: String(r.deal_board) }; });
    var t = byKey[key];
    results[key] = await mondayCheck.checkDeals(deals, function () { return t.monday_rules; });
  }
  for (var j = 0; j < withDeal.length; j++) {
    var row = withDeal[j];
    var res = results[row.task_type] && results[row.task_type].get(String(row.deal_id));
    if (!res || !res.done) continue;
    try {
      await pool().query(
        `UPDATE unified_tasks SET status = 'done', done_at = now(), updated_at = now(), closed_reason = 'monday',
                summary = COALESCE(summary, '') || $2
          WHERE id = $1 AND status = 'open' AND NOT keep_open`,
        [row.id, '\nClosed — monday: ' + res.evidence]);
      ctx.stats.closed_monday++;
      console.log('[task-hub] system reminder closed (monday):', row.id, row.task_type, '—', res.evidence);
    } catch (e) {
      console.warn('[task-hub] failed to close task', row.id, e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 2026-10-06 (Shira): "emails that were responded to already after created
// as a task should also disappear". For every OPEN email task that came from
// a person (not a system reminder): if the task's owner sent a message in the
// same thread AFTER the email the task came from, the task closes
// (closed_reason 'replied'). No AI — one cheap Gmail metadata call per open
// email task. Fails open: any Gmail error leaves the task as it is.
// A task the person re-opened by hand (keep_open) is never auto-closed again.
// If the other side writes back, that new email is a new candidate and is
// triaged once as usual.
// WhatsApp already works this way: a task closes when the chat is no longer
// waiting for the firm, and re-opens when the client writes again.
// ---------------------------------------------------------------------------
var REPLY_CHECK_MAX = Math.max(10, parseInt(process.env.TASK_HUB_REPLY_CHECK_PER_REFRESH || '90', 10));
async function closeRepliedEmailTasks(userId, userEmail, ctx) {
  var gmail;
  try { gmail = require('../lib/gmail'); } catch (e) { return; }
  if (typeof gmail.getThreadActivity !== 'function') return;
  // 6 Oct: every open email task gets its turn — never checked first, then the
  // ones checked longest ago (before: only the newest 40, forever).
  var rows = (await pool().query(
    `SELECT id, COALESCE(last_msg_ref, source_ref) AS source_ref, thread_id FROM unified_tasks
      WHERE user_id = $1 AND source = 'email' AND status = 'open' AND NOT keep_open
        AND source_ref NOT LIKE 'sys:%'
      ORDER BY reply_checked_at NULLS FIRST, first_seen_at DESC LIMIT $2`, [userId, REPLY_CHECK_MAX]
  )).rows;
  if (!rows.length) return;
  await pool().query('UPDATE unified_tasks SET reply_checked_at = now() WHERE id = ANY($1)', [rows.map(function (r) { return r.id; })]);
  var me = String(userEmail || '').toLowerCase();
  await runLimited(rows, 4, async function (r) {
    var threadId = r.thread_id;
    if (!threadId && typeof gmail.getMessageThreadId === 'function') {
      threadId = await gmail.getMessageThreadId(userId, r.source_ref);
      if (threadId) {
        pool().query('UPDATE unified_tasks SET thread_id = $1 WHERE id = $2', [threadId, r.id]).catch(function () {});
      }
    }
    if (!threadId) return;
    var later = await firmMessagesAfter(gmail, userId, threadId, r.source_ref, me);
    if (!later || !later.length) return;
    var who = later[later.length - 1];
    try {
      await pool().query(
        `UPDATE unified_tasks SET status = 'done', done_at = now(), updated_at = now(), closed_reason = 'replied',
                closed_note = $2
          WHERE id = $1 AND status = 'open' AND NOT keep_open`,
        [r.id, 'ענה/תה בשרשור: ' + (senderName(who.from) || 'המשרד')]);
      ctx.stats.closed_replied++;
    } catch (e) {
      console.warn('[task-hub] failed to close replied email task', r.id, e.message);
    }
  });
}

// Messages in the conversation AFTER the task's email, written by the firm:
// sent from this mailbox, or from any @epsteinlaw.co.il address (a colleague
// who replied with this person copied). null = can't tell.
var FIRM_ADDR = /@epsteinlaw\.co\.il$/i;
async function firmMessagesAfter(gmail, userId, threadId, messageId, me) {
  var act = await gmail.getThreadActivity(userId, threadId);
  if (!act || !act.messages || !act.messages.length) return null;
  var msgs = act.messages.slice().sort(function (a, b) { return a.internalDate - b.internalDate; });
  var idx = msgs.findIndex(function (m) { return m.id === messageId; });
  if (idx < 0) return null; // the email itself is gone — don't guess
  // An internal request (the email came from someone at the firm, e.g. Yaakov
  // asking Shayna): every message in it is "from the firm", so only the task
  // owner's own message counts — another note from Yaakov doesn't finish it.
  var origin = taskTypes.senderAddress(msgs[idx].from);
  var internal = FIRM_ADDR.test(origin);
  return msgs.slice(idx + 1).filter(function (m) {
    var from = taskTypes.senderAddress(m.from);
    var mine = (m.labelIds || []).indexOf('SENT') !== -1 || (me && from === me);
    if (internal) return mine && from !== origin;
    return mine || FIRM_ADDR.test(from);
  });
}

async function answeredByFirm(userId, threadId, messageId) {
  if (!threadId) return false;
  var gmail;
  try { gmail = require('../lib/gmail'); } catch (e) { return false; }
  if (typeof gmail.getThreadActivity !== 'function') return false;
  var me = String((await getUserEmail(userId).catch(function () { return ''; })) || '').toLowerCase();
  var later = await firmMessagesAfter(gmail, userId, threadId, messageId, me).catch(function () { return null; });
  return !!(later && later.length);
}

// ---------------------------------------------------------------------------
// 6 Oct: staff SENT mail finishes tasks — anyone's, not only the sender's own.
// 1. Each refresh reads that person's new sent mail (metadata + snippet) into
//    staff_sent_mail. Only people whose Gmail is connected to LAWLY.
// 2. For this person's open tasks, a sent email AFTER the task, to the same
//    outside person (or to a client of the task's deal):
//      - same subject (Re: ...) to the person who wrote -> closed, no AI
//        (a colleague answered from their own mailbox)
//      - otherwise ONE short AI question: "did this email finish the task?"
//        Every (task, email) pair is asked once and remembered.
// ---------------------------------------------------------------------------
var SENT_SCAN_MAX = Math.max(10, parseInt(process.env.TASK_HUB_SENT_SCAN_MAX || '100', 10));
var SENT_AI_MAX = Math.max(0, parseInt(process.env.TASK_HUB_SENT_AI_PER_REFRESH || '10', 10));
var SENT_FIRST_DAYS = 14;

// Reads the person's sent mail in batches of TASK_HUB_SENT_SCAN_MAX (100), so a
// busy mailbox is read in full over a few refreshes instead of only the newest
// 100: new mail first, then any older stretch still unread (backfill).
async function scanSentMail(userId, ctx) {
  var gmail;
  try { gmail = require('../lib/gmail'); } catch (e) { return; }
  if (typeof gmail.listSentSince !== 'function') return;
  var cur = (await pool().query('SELECT * FROM task_hub_sent_scan WHERE user_id = $1', [userId])).rows[0] || null;
  var ms = function (d) { return d ? new Date(d).getTime() : null; };
  // 6 Oct (Shira): the FIRST read of each person's sent mail goes back to the
  // earliest open task in the firm (max a year), so every open task is covered.
  // After that, only new mail is read.
  var firstDay = Date.now() - SENT_FIRST_DAYS * 24 * 3600 * 1000;
  if (!cur || !cur.backfill_v2) {
    var early = (await pool().query("SELECT min(first_seen_at) AS t FROM unified_tasks WHERE status = 'open'")).rows[0];
    if (early && early.t) firstDay = Math.max(Date.now() - 365 * 24 * 3600 * 1000, Math.min(firstDay, new Date(early.t).getTime() - 24 * 3600 * 1000));
  }
  var last = cur && ms(cur.last_sent_at);
  var bfAfter = cur && ms(cur.backfill_after), bfBefore = cur && ms(cur.backfill_before);
  if (cur && !cur.backfill_v2) { bfAfter = firstDay; bfBefore = last || Date.now(); } // read before the batch fix

  // 1. New mail since the last read (or the first 14 days).
  var newAfter = last ? last - 60 * 1000 : firstDay;
  var a = await readSentBatch(gmail, userId, newAfter, null, ctx);
  if (!a) return;
  var nextLast = a.newest || last || Date.now();
  if (a.full) {
    // More than one batch of new mail: the rest is read as a backfill stretch.
    if (bfBefore) bfBefore = Math.max(bfBefore, a.oldest); else { bfAfter = newAfter; bfBefore = a.oldest; }
  }
  // 2. One batch of an older stretch still unread.
  if (bfBefore && !(a.full && !cur)) {
    var b2 = await readSentBatch(gmail, userId, bfAfter || firstDay, bfBefore, ctx);
    if (b2) { if (b2.full && b2.oldest) bfBefore = b2.oldest; else { bfAfter = null; bfBefore = null; } }
  }
  await pool().query(
    `INSERT INTO task_hub_sent_scan (user_id, last_sent_at, backfill_after, backfill_before, backfill_v2)
     VALUES ($1, to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0), true)
     ON CONFLICT (user_id) DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at, backfill_after = EXCLUDED.backfill_after,
       backfill_before = EXCLUDED.backfill_before, backfill_v2 = true`,
    [userId, nextLast, bfBefore ? (bfAfter || firstDay) : null, bfBefore || null]);
}

async function readSentBatch(gmail, userId, afterMs, beforeMs, ctx) {
  var res = await gmail.listSentSince(userId, afterMs, SENT_SCAN_MAX, beforeMs);
  if (!res || !res.messages) return null;
  var newest = null, oldest = null;
  for (var i = 0; i < res.messages.length; i++) {
    var m = res.messages[i];
    if (m.sentAt && (newest === null || m.sentAt > newest)) newest = m.sentAt;
    if (m.sentAt && (oldest === null || m.sentAt < oldest)) oldest = m.sentAt;
    var recips = mondayCheck.outsideAddresses('', m.to, m.cc);
    if (!recips.length) continue; // only firm people — can't finish a client task
    var deals = await mondayCheck.dealsForAddresses(recips).catch(function () { return []; });
    var ins = await pool().query(
      `INSERT INTO staff_sent_mail (msg_id, user_id, sender, recipients, subject, snippet, thread_id, deal_ids, sent_at, recipient_names)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_timestamp($9 / 1000.0), $10) ON CONFLICT (msg_id) DO NOTHING`,
      [m.id, userId, m.from || res.mailbox || '', recips, m.subject || '', String(m.snippet || '').slice(0, 500),
       m.threadId, deals, m.sentAt || Date.now(), headerNames(m.to, m.cc)]);
    if (ins.rowCount) ctx.stats.sent_scanned++;
  }
  return { newest: newest, oldest: oldest, full: res.messages.length >= SENT_SCAN_MAX };
}

// 6 Oct (admin button): read EVERYONE's sent mail now, all the way back
// (one batch after another until each person is fully read). Gmail only —
// no AI, no triage, no other refresh steps. Runs in the background; one at a time.
var _readAll = null;
function readSentForAll() {
  if (_readAll) return { started: false, running: true };
  _readAll = (async function () {
    var users = (await pool().query(
      `SELECT u.id, u.email FROM users u JOIN gmail_connections g ON g.user_id = u.id WHERE u.status = 'active'`)).rows;
    for (var i = 0; i < users.length; i++) {
      var ctx = { stats: { sent_scanned: 0 } };
      for (var round = 0; round < 60; round++) {
        var before = ctx.stats.sent_scanned;
        try { await scanSentMail(users[i].id, ctx); } catch (e) { console.warn('[task-hub] read-all failed for', users[i].email, e.message); break; }
        var row = (await pool().query('SELECT backfill_before FROM task_hub_sent_scan WHERE user_id = $1', [users[i].id])).rows[0];
        if (!row || !row.backfill_before) break;           // fully read
        if (round > 0 && ctx.stats.sent_scanned === before && !row.backfill_before) break;
      }
      console.log('[task-hub] read-all: ' + users[i].email + ' — ' + ctx.stats.sent_scanned + ' sent emails saved');
    }
    console.log('[task-hub] read-all: done for ' + users.length + ' people (no AI used)');
  })().catch(function (e) { console.error('[task-hub] read-all failed:', e.message); })
    .finally(function () { _readAll = null; });
  return { started: true };
}

// Automatic emails known in advance (task_hub_auto_emails), cached 5 minutes.
var _auto = { at: 0, rows: [] };
async function autoEmailRules() {
  if (Date.now() - _auto.at < 5 * 60 * 1000) return _auto.rows;
  var rows = [];
  try {
    rows = (await pool().query('SELECT * FROM task_hub_auto_emails WHERE active')).rows;
  } catch (e) { rows = []; }
  _auto = { at: Date.now(), rows: rows.map(function (r) {
    var re = null;
    try { re = r.subject_regex ? new RegExp(r.subject_regex, 'i') : null; } catch (e) { re = null; }
    return { id: r.id, name: r.name_he, what: r.what_it_does || '', sender: String(r.sender || '').toLowerCase().trim(), re: re,
             bad: !!r.subject_regex && !re, notATask: !!r.not_a_task,
             skipFor: (r.skip_for || []).map(function (e) { return String(e).toLowerCase().trim(); }) };
  }).filter(function (r) { return !r.bad && (r.sender || r.re); }) };
  return _auto.rows;
}
function matchAutoEmail(rules, sender, subject) {
  var from = taskTypes.senderAddress(sender);
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (r.sender && from !== r.sender) continue;
    if (r.re && !r.re.test(String(subject || ''))) continue;
    return r;
  }
  return null;
}

// 8 Oct: the firm's own automatic emails (rules with not_a_task / skip_for).
// Matched on the subject without Re:/Fwd:, so a reply in the same
// conversation is recognised too. Returns { rule, isReply } or null.
function ownAutoEmail(rules, subject) {
  var raw = String(subject || '');
  var bare = raw;
  for (var i = 0; i < 5; i++) bare = bare.replace(/^\s*(re|fw|fwd|הועבר|תשובה|השב)\s*:\s*/i, '');
  for (var j = 0; j < rules.length; j++) {
    var r = rules[j];
    if (!r.re || !(r.notATask || r.skipFor.length)) continue;
    if (r.re.test(bare.trim())) return { rule: r, isReply: bare !== raw };
  }
  return null;
}

function plainSubject(s) {
  var t = String(s || '');
  for (var i = 0; i < 5; i++) t = t.replace(/^\s*(re|fw|fwd|הועבר|תשובה|השב)\s*:\s*/i, '');
  return taskTypes.clientKey(t);
}

// Display names on To/Cc ("Ohad Levi <o@x.com>, ..." -> "Ohad Levi, ...").
function headerNames(to, cc) {
  return String((to || '') + ',' + (cc || '')).split(',').map(function (x) {
    var m = x.match(/^\s*"?([^"<]*?)"?\s*</); return m ? m[1].trim() : '';
  }).filter(Boolean).join(', ').slice(0, 300);
}

// Words that say WHO or WHAT a task is about (a company, a client, a project,
// an apartment number) — the cheap filter before any AI question.
var STOP_WORDS = ('the and for with from this that please send sent email mail call check need needs about your have will ' +
  'can could would should our you are not into when what which there their them then than also just more some only ' +
  'client clients contract agreement document documents file files signing sign signed meeting date time today tomorrow ' +
  'task follow update reply answer question regarding re fw fwd attached attachment thanks thank hello dear ' +
  'את של על עם זה זו לא כן אם או גם רק כל יש אין לשלוח שלח שלחה שליחה מייל מייל לבדוק בדיקה לקוח לקוחה לקוחות ' +
  'חוזה הסכם מסמך מסמכים קובץ חתימה לחתום פגישה תאריך היום מחר משימה לעדכן עדכון תשובה שאלה בנוגע לגבי מצורף תודה שלום ' +
  'אנא בבקשה צריך צריכה להעביר העברה לקבל לתאם תיאום דירה דירת עסקה עסקת הלקוח הלקוחה בעל בעלת בעלים חברה החברה').split(/\s+/);
var _stop = null;
function stopSet() {
  if (_stop) return _stop;
  _stop = new Set(STOP_WORDS);
  try {
    (require('../config/staff-directory.json').staff || []).forEach(function (st) {
      String(st.name || '').toLowerCase().split(/\s+/).forEach(function (w) { if (w) _stop.add(w); });
      var local = String(st.email || '').split('@')[0].toLowerCase();
      if (local) _stop.add(local);
    });
  } catch (e) { /* no directory */ }
  ['epstein', 'epsteinlaw', 'אפשטיין'].forEach(function (w) { _stop.add(w); });
  return _stop;
}
function words(text) {
  return String(text || '').toLowerCase().replace(/[֑-ׇ]/g, '').split(/[^0-9a-zא-ת]+/).filter(Boolean);
}
function distinctiveTokens(text) {
  var stop = stopSet();
  var out = new Set();
  words(text).forEach(function (w) {
    if (stop.has(w)) return;
    // Short numbers (apartment 12, a date) are everywhere — only 3+ digits count.
    if (/^\d+$/.test(w) ? w.length >= 3 : w.length >= 3) out.add(w);
    // Hebrew prefixes: "לכהן" -> "כהן", "מהבנק" -> "בנק"
    var m = w.match(/^[ולבהמש]{1,2}([א-ת]{3,})$/);
    if (m && !stop.has(m[1])) out.add(m[1]);
  });
  return out;
}
function hits(tokens, text) {
  var n = 0, seen = new Set();
  words(text).forEach(function (w) {
    var base = w.replace(/^[ולבהמש]{1,2}(?=[א-ת]{3,})/, '');
    if ((tokens.has(w) || tokens.has(base)) && !seen.has(w)) { seen.add(w); n++; }
  });
  return n;
}

var SENT_TEXT_MODE = String(process.env.TASK_HUB_SENT_TEXT || 'escalate').toLowerCase(); // lines | escalate | middle
var SENT_MIDDLE_CHARS = 1500;

// The staff WhatsApp messages LAWLY's WhatsApp saw since a time, with the chat
// name and the monday deal of the chat. Text is decrypted here, in memory,
// only for the ones a task might need — never stored in plain text.
async function staffWhatsappSince(sinceIso, oldestIso, savedIso) {
  var rows;
  try {
    rows = (await pool().query(
      `SELECT pj.source_item_id, pj.chat_jid, pj.is_group, pj.sender_staff_phone9, pj.sender_phone,
              COALESCE(pj.sent_at, pj.created_at) AS sent_at, COALESCE(pj.created_at, pj.sent_at) AS saved_at, pj.payload_encrypted,
              COALESCE(g.name, c.display_name, c.monday_client_name) AS chat_name,
              COALESCE(dg.monday_item_id, dp.monday_item_id) AS deal_monday_id
         FROM processing_jobs pj
         LEFT JOIN whatsapp_groups g ON g.provider_group_jid = pj.chat_jid AND g.removed_at IS NULL
         LEFT JOIN deals dg ON dg.id = g.deal_id
         LEFT JOIN deals dp ON dp.id = pj.deal_id
         LEFT JOIN wa_contacts c ON NOT pj.is_group
              AND c.phone_normalized = right(regexp_replace(split_part(pj.chat_jid, '@', 1), '\\D', '', 'g'), 9)
        WHERE COALESCE(pj.sent_at, pj.created_at) > $2 AND (COALESCE(pj.sent_at, pj.created_at) > $1 OR pj.created_at > $3)
          AND (pj.direction = 'out' OR pj.sender_staff_phone9 IS NOT NULL)
        ORDER BY COALESCE(pj.sent_at, pj.created_at) DESC
        LIMIT 20000`, [sinceIso, oldestIso || sinceIso, savedIso || sinceIso])).rows;
  } catch (e) {
    return []; // no WhatsApp tables on this DB
  }
  return rows;
}

var _waText = null;
function whatsappText(row) {
  try {
    if (!_waText) {
      var enc = require('./crypto');
      var phone = require('../whatsapp/ingest/phone');
      _waText = function (pe) {
        var json = enc.decrypt(pe || '');
        var msg = json ? JSON.parse(json) : null;
        return (msg && phone.textPreview(msg.message || msg)) || '';
      };
    }
    return _waText(row.payload_encrypted);
  } catch (e) { return ''; }
}

function staffByPhone(phone9) {
  try {
    var st = (require('../config/staff-directory.json').staff || []).find(function (x) { return x.phone9 === phone9; });
    return st || null;
  } catch (e) { return null; }
}
function staffPhoneOf(email) {
  try {
    var st = (require('../config/staff-directory.json').staff || []).find(function (x) { return x.email === email; });
    return st ? st.phone9 : null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// 6 Oct: did something a staff member SENT finish this task?
// Looks at sent EMAIL (every staff member whose Gmail is connected) and staff
// messages on the firm's WHATSAPP, after the task was created (last 30 days).
// Only what is connected to the task goes on (cheap filter, no AI):
//   email: to the task's outside people / to a client of the task's deal /
//          (internal requests) sent by the task owner, and the recipient's
//          name or company, or the subject, names someone/something in the task
//   WhatsApp: a chat of the task's deal / (internal requests) the owner wrote
//          in a chat whose name is someone/something in the task
// Same subject (Re: ...) to the task's people -> closed, no AI.
// Otherwise ONE AI question per task with everything that passed. First lines
// only; if the AI can't tell, once more with the new text of those emails
// (TASK_HUB_SENT_TEXT = lines | escalate | middle). Every item is asked about
// once per task, and every decision is logged with what the AI saw.
// ---------------------------------------------------------------------------
var _aiFrom = null;
async function sentAiFrom() {
  if (_aiFrom !== null) return _aiFrom;
  try {
    var r = (await pool().query("SELECT value FROM task_hub_settings WHERE key = 'sent_ai_from'")).rows[0];
    _aiFrom = r ? new Date(r.value).getTime() : Date.now();
    if (!isFinite(_aiFrom)) _aiFrom = Date.now();
  } catch (e) { return Date.now(); }
  return _aiFrom;
}

async function closeBySentMail(userId, ctx) {
  var userEmail = await getUserEmail(userId);
  var tasks = (await pool().query(
    `SELECT id, title, summary, source, source_ref, source_name, source_subject, contact_addrs, deal_id, deal_name, extra_deals,
            COALESCE(last_msg_at, first_seen_at) AS first_seen_at, sent_checked_until, recheck_old
       FROM unified_tasks
      WHERE user_id = $1 AND status = 'open' AND NOT keep_open AND source_ref NOT LIKE 'sys:%'
      ORDER BY first_seen_at`, [userId])).rows;
  if (!tasks.length) return;
  // Every open task, however old. Only what was sent after each task — and
  // after it was last looked at (sent_checked_until), so later refreshes are small.
  // A task already looked at only needs what was SAVED since (new mail, or older
  // mail read in later, e.g. during the first full read).
  var ms2 = function (d) { return new Date(d).getTime(); };
  var unchecked = tasks.filter(function (t) { return !t.sent_checked_until; });
  var checkedT = tasks.filter(function (t) { return t.sent_checked_until; });
  var sinceSent = new Date(unchecked.length ? Math.min.apply(null, unchecked.map(function (t) { return ms2(t.first_seen_at); })) : Date.now()).toISOString();
  var sinceSaved = new Date(checkedT.length ? Math.min.apply(null, checkedT.map(function (t) { return ms2(t.sent_checked_until); })) - 10 * 60 * 1000 : Date.now()).toISOString();
  var oldestTask = new Date(Math.min.apply(null, tasks.map(function (t) { return ms2(t.first_seen_at); }))).toISOString();
  var mails = (await pool().query(
    `SELECT msg_id, user_id, sender, recipients, recipient_names, subject, snippet, deal_ids, sent_at, inserted_at
       FROM staff_sent_mail
      WHERE sent_at > $3 AND (sent_at > $1 OR inserted_at > $2)
      ORDER BY sent_at DESC LIMIT 20000`, [sinceSent, sinceSaved, oldestTask])).rows;
  var was = await staffWhatsappSince(sinceSent, oldestTask, sinceSaved);
  var done = []; // tasks fully looked at this time
  var anyDeal = tasks.some(function (t) { return t.deal_id; });
  if (!mails.length && !was.length && !anyDeal) {
    await pool().query('UPDATE unified_tasks SET sent_checked_until = now(), recheck_old = false WHERE id = ANY($1)', [tasks.map(function (t) { return t.id; })]);
    return;
  }
  var mondayLeft = MONDAY_CHANGES_PER_REFRESH;
  var checked = new Set((await pool().query(
    `SELECT task_id, msg_id FROM task_hub_sent_checks WHERE task_id = ANY($1)
        AND NOT (verdict = 'failed' AND attempts < 3 AND checked_at < now() - interval '2 hours')`,
    [tasks.map(function (t) { return t.id; })])).rows.map(function (r) { return r.task_id + '|' + r.msg_id; }));
  var myPhone = staffPhoneOf(userEmail);
  var autoRules = await autoEmailRules();
  var aiFrom = await sentAiFrom();
  var aiLeft = SENT_AI_MAX;

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var tAt = new Date(t.first_seen_at).getTime();
    var people = t.contact_addrs || [];
    var internal = !people.length;
    var taskDeals = [t.deal_id].concat((Array.isArray(t.extra_deals) ? t.extra_deals : []).map(function (d) { return d.id; }))
      .filter(Boolean).map(String);
    var dealNames = [t.deal_name].concat((Array.isArray(t.extra_deals) ? t.extra_deals : []).map(function (d) { return d.name; })).filter(Boolean).join(' ');
    var tokens = distinctiveTokens([t.title, t.summary, t.source_subject, dealNames, internal ? '' : t.source_name].join(' '));
    var items = [];

    for (var j = 0; j < mails.length && items.length < 8; j++) {
      var m = mails[j];
      if (new Date(m.sent_at).getTime() <= tAt || checked.has(t.id + '|' + m.msg_id)) continue;
      if (t.sent_checked_until && ms2(m.inserted_at) <= ms2(t.sent_checked_until) - 10 * 60 * 1000) continue; // already looked at
      var toPeople = people.length && (m.recipients || []).some(function (r) { return people.indexOf(r) !== -1; });
      var toDeal = taskDeals.length && (m.deal_ids || []).some(function (d) { return taskDeals.indexOf(String(d)) !== -1; });
      var why = null;
      if (toPeople) why = 'to the people on the task';
      else if (toDeal) why = "to a client of the task's deal";
      else if (internal && String(m.user_id) === String(userId) && tokens.size) {
        var strong = hits(tokens, (m.recipients || []).join(' ') + ' ' + (m.recipient_names || '') + ' ' + (m.subject || ''));
        if (strong >= 1 || hits(tokens, m.snippet) >= 2) why = 'names something in the task';
      }
      if (!why) continue;
      if (toPeople && t.source === 'email' && t.source_subject && plainSubject(m.subject) && plainSubject(m.subject) === plainSubject(t.source_subject)) {
        // A reply to the same email, from any staff member's mailbox: no AI.
        await markSentCheck(t.id, m.msg_id, 'done');
        await closeTaskBySent(t.id, 'replied', (senderName(m.sender) || 'עמית/ה') + ' ענה/תה ב-' + heDate(m.sent_at) +
          ' (' + String(m.subject || '').slice(0, 80) + ')');
        ctx.stats.closed_sent_same++;
        items = null;
        break;
      }
      if (ms2(m.sent_at) <= aiFrom && !t.recheck_old) continue; // older: the one-time pass in Cowork, not the AI here
      var auto = matchAutoEmail(autoRules, m.sender, m.subject);
      items.push({ channel: 'email', id: m.msg_id, owner: m.user_id, who: senderName(m.sender) || '', at: m.sent_at,
        to: (m.recipient_names || '') || (m.recipients || []).join(', '), subject: m.subject || '',
        // An automatic email: one line saying what it is, never its content.
        text: auto ? '[AUTOMATIC EMAIL: ' + auto.name + (auto.what ? ' — ' + auto.what : '') + ']' : (m.snippet || ''),
        auto: auto ? auto.id : undefined, why: why });
    }
    if (!items) continue;

    for (var k = 0; k < was.length && items.length < 8; k++) {
      var w = was[k];
      var wid = 'wa:' + w.source_item_id;
      if (new Date(w.sent_at).getTime() <= tAt || checked.has(t.id + '|' + wid)) continue;
      if (t.sent_checked_until && ms2(w.saved_at) <= ms2(t.sent_checked_until) - 10 * 60 * 1000) continue;
      if (t.source === 'whatsapp' && w.chat_jid === t.source_ref) continue; // its own chat: the unanswered check handles it
      if (ms2(w.sent_at) <= aiFrom && !t.recheck_old) continue; // older: the one-time pass in Cowork
      var wwhy = null;
      if (w.deal_monday_id && taskDeals.indexOf(String(w.deal_monday_id)) !== -1) wwhy = "in a chat of the task's deal";
      else if (internal && myPhone && w.sender_staff_phone9 === myPhone && tokens.size && hits(tokens, w.chat_name) >= 1) wwhy = 'chat name is in the task';
      if (!wwhy) continue;
      var txt = whatsappText(w);
      if (!txt) continue;
      var st = staffByPhone(w.sender_staff_phone9);
      items.push({ channel: 'whatsapp', id: wid, who: (st && st.name) || 'staff', at: w.sent_at, to: w.chat_name || '',
        subject: '', text: txt.slice(0, 400), why: wwhy });
    }
    // 8 Oct: a status column on the task's deal that changed to "sent / done"
    // AFTER the task (e.g. "שלח צוואה חתומה" -> נשלח). Each change is asked
    // about once (task_hub_sent_checks), together with the sent messages.
    var mondayLater = false;
    for (var di = 0; di < taskDeals.length && items.length < 8; di++) {
      if (!mondayCheck.dealChangesCached(taskDeals[di])) { // monday read: a few per refresh
        if (mondayLeft <= 0) { mondayLater = true; continue; }
        mondayLeft--;
      }
      var changes = await mondayCheck.dealDoneChanges(taskDeals[di]).catch(function () { return []; });
      for (var ci = 0; ci < changes.length && items.length < 8; ci++) {
        var ch = changes[ci];
        var cid = 'mon:' + taskDeals[di] + ':' + ch.col + ':' + ch.ms;
        if (ch.ms <= tAt || checked.has(t.id + '|' + cid)) continue;
        if (ch.ms <= aiFrom && !t.recheck_old) continue;
        items.push({ channel: 'monday', id: cid, who: 'monday', at: new Date(ch.ms).toISOString(), to: t.deal_name || '',
          subject: ch.title, text: ch.title + ' → ' + ch.label, why: "status on the task's deal" });
      }
    }
    var more = items.length >= 8; // possibly more than one question's worth
    if (!items.length) { if (!mondayLater) done.push(t.id); continue; }
    if (aiLeft <= 0) continue;     // asked next refresh
    aiLeft--;
    await askAboutSent(userId, t, items, ctx);
    if (!more) done.push(t.id);
  }
  if (done.length) await pool().query('UPDATE unified_tasks SET sent_checked_until = now(), recheck_old = false WHERE id = ANY($1)', [done]);
}
var MONDAY_CHANGES_PER_REFRESH = Math.max(0, parseInt(process.env.TASK_HUB_MONDAY_CHANGES_PER_REFRESH || '15', 10));

// ---------------------------------------------------------------------------
// 8 Oct (Shira: "it should know before, and not show it as a task"). Each open
// email task gets its people from the WHOLE conversation once — every outside
// address in it, also inside a forwarded message (a colleague's forward has no
// client in its headers). One Gmail read, no AI. When new people (or a deal)
// are found, the task is looked at again from its start, so an email the firm
// already sent them — or a monday change — closes it, with the reason.
// ---------------------------------------------------------------------------
var PEOPLE_PER_REFRESH = Math.max(1, parseInt(process.env.TASK_HUB_PEOPLE_PER_REFRESH || '15', 10));
var NOT_A_PERSON = /(no-?reply|mailer-daemon|postmaster|notifications?@|bounce|calendar-notification)/i;
async function fillPeopleFromConversation(userId, ctx) {
  var gmail;
  try { gmail = require('../lib/gmail'); } catch (e) { return; }
  if (typeof gmail.getThreadTexts !== 'function') return;
  var rows = (await pool().query(
    `SELECT id, thread_id, contact_addrs, deal_id, task_type, title, summary, source_subject, source_name
       FROM unified_tasks
      WHERE user_id = $1 AND status = 'open' AND source = 'email' AND source_ref NOT LIKE 'sys:%'
        AND thread_id IS NOT NULL AND people_checked_at IS NULL
      ORDER BY first_seen_at DESC LIMIT $2`, [userId, PEOPLE_PER_REFRESH])).rows;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    try {
      var thread = await gmail.getThreadTexts(userId, r.thread_id, 12, 3000);
      var people = (r.contact_addrs || []).map(function (a) { return String(a).toLowerCase(); });
      var before = people.length;
      (thread || []).forEach(function (m) {
        mondayCheck.outsideAddresses(m.from, m.to, m.cc, m.text).forEach(function (a) {
          if (!NOT_A_PERSON.test(a) && people.indexOf(a) === -1) people.push(a);
        });
      });
      people = people.slice(0, 12);
      var found = people.length > before;
      var linked = false;
      if (!r.deal_id && people.length) {
        var kind = dealKind(r.task_type);
        var hint = [r.title, r.summary, r.source_subject].filter(Boolean).join(' ');
        var deal = await mondayCheck.findDealByAddresses(people, hint, {}, kind).catch(function () { return null; });
        if (!deal && kind === 'wills') deal = await mondayCheck.findWillByText([r.title, r.summary, r.source_name].filter(Boolean).join(' '), {}).catch(function () { return null; });
        if (deal) { linked = await attachFoundDeal(r.id, deal); }
      }
      await pool().query(
        'UPDATE unified_tasks SET people_checked_at = now(), contact_addrs = $2' +
        (found || linked ? ', sent_checked_until = NULL, recheck_old = true' : '') + ' WHERE id = $1',
        [r.id, people]);
      if (found || linked) ctx.stats.people_found++;
    } catch (e) {
      console.warn('[task-hub] people from conversation failed for task', r.id, '(retried next refresh):', e.message);
    }
  }
}

var WHY_HE = { tagged: 'תויג/ה', addressed: 'פנו אליו/ה בשם', last_replied: 'ענה/תה אחרון/ה', board: 'נבחר/ה בלוח', owner: 'אחראי/ת הקבוצה', last_ever: 'ענה/תה אחרון/ה בקבוצה' };
function heDateTime(d) {
  return new Date(d).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// Why a WhatsApp task left this person's list. Never throws.
async function whatsappCloseWhy(task, waitingWith) {
  var w = waitingWith[task.source_ref];
  if (w) {
    var st = (require('../config/staff-directory.json').staff || []).find(function (s) { return s.email === w.email; });
    return { reason: 'moved', note: w.email ? 'עבר ל' + ((st && st.name) || w.email) + ' (' + (WHY_HE[w.why] || w.why) + ')' : 'עבר ללוח — אין אחראי' };
  }
  try {
    var q = await pool().query(
      `SELECT sender_staff_phone9, COALESCE(sent_at, created_at) AS at FROM processing_jobs
        WHERE chat_jid = $1 AND deleted_at IS NULL AND (direction = 'out' OR sender_staff_phone9 IS NOT NULL)
        ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 1`, [task.source_ref]);
    var m = q.rows[0];
    if (m && new Date(m.at) >= new Date(task.first_seen_at || 0)) {
      var who = m.sender_staff_phone9 ? staffByPhone(m.sender_staff_phone9) : null;
      return { reason: 'replied', note: ((who && who.name) || 'המשרד') + ' ענה/תה ב-' + heDateTime(m.at) };
    }
  } catch (e) { /* no detail */ }
  return { reason: 'replied', note: 'הצ\'אט כבר לא ממתין לתשובה (הלקוח סיים / סומן בלוח)' };
}

function heDate(d) {
  return new Date(d).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

function sentItemsText(items) {
  return items.map(function (it, n) {
    if (it.channel === 'monday') {
      return '[' + (n + 1) + '] MONDAY CHANGE on ' + new Date(it.at).toISOString().slice(0, 16).replace('T', ' ') +
        (it.to ? '\nDeal: ' + it.to : '') + '\nColumn changed: ' + it.text;
    }
    return '[' + (n + 1) + '] ' + (it.channel === 'email' ? 'EMAIL' : 'WHATSAPP') + ' by ' + (it.who || 'staff') +
      ' on ' + new Date(it.at).toISOString().slice(0, 16).replace('T', ' ') +
      (it.channel === 'email' ? '\nTo: ' + it.to + '\nSubject: ' + it.subject : '\nChat: ' + it.to) +
      '\nText: ' + (it.text || '(empty)');
  }).join('\n\n');
}

async function askAboutSent(userId, t, items, ctx) {
  var taskText = 'TASK (open since ' + new Date(t.first_seen_at).toISOString().slice(0, 10) + '):\n' + t.title +
    (t.summary ? '\n' + String(t.summary).slice(0, 600) : '') +
    (t.source_subject ? '\nOriginal email subject: ' + t.source_subject : '') +
    (t.source_name ? '\nFrom: ' + t.source_name : '') +
    (t.deal_name ? '\nDeal: ' + t.deal_name : '');
  var level = SENT_TEXT_MODE === 'middle' ? 'middle' : 'lines';
  if (level === 'middle') await addMiddleText(items);
  var res = await askSentOnce(taskText, items, ctx);
  if (res && res.answer === 'unsure' && SENT_TEXT_MODE === 'escalate' &&
      items.some(function (it) { return it.channel === 'email' && !it.auto; })) {
    await pool().query(
      `INSERT INTO task_hub_sent_decisions (task_id, user_id, text_level, items, answer, item, reason)
       VALUES ($1,$2,'lines',$3,'unsure',NULL,$4)`, [t.id, userId, JSON.stringify(items), res.reason || null]);
    level = 'middle';
    await addMiddleText(items);
    res = await askSentOnce(taskText, items, ctx);
  }
  if (!res) {
    for (var f = 0; f < items.length; f++) await markSentCheck(t.id, items[f].id, 'failed');
    return;
  }
  var pick = res.answer === 'done' && res.item >= 1 && res.item <= items.length ? items[res.item - 1] : null;
  if (res.answer === 'done' && !pick) pick = items[0];
  for (var q = 0; q < items.length; q++) {
    await markSentCheck(t.id, items[q].id, pick === items[q] ? 'done' : (res.answer === 'unsure' ? 'unsure' : 'not_done'));
  }
  await pool().query(
    `INSERT INTO task_hub_sent_decisions (task_id, user_id, text_level, items, answer, item, reason, closed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [t.id, userId, level, JSON.stringify(items), res.answer, pick ? items.indexOf(pick) + 1 : null, res.reason || null, !!pick]);
  if (!pick) return;
  if (pick.channel === 'monday') {
    await closeTaskBySent(t.id, 'monday', pick.text + ' ב-' + heDate(pick.at) + (res.reason ? ': ' + String(res.reason).slice(0, 120) : ''));
    ctx.stats.closed_monday_change++;
    return;
  }
  var note = (pick.channel === 'email' ? 'מייל של ' : 'וואטסאפ של ') + (pick.who || 'עמית/ה') + ' ב-' + heDate(pick.at) +
    (pick.channel === 'whatsapp' && pick.to ? ' (' + pick.to + ')' : '') + ': ' + String(res.reason || pick.subject || '').slice(0, 160);
  await closeTaskBySent(t.id, pick.channel === 'email' ? 'sent_email' : 'sent_whatsapp', note);
  if (pick.channel === 'email') ctx.stats.closed_sent_ai++; else ctx.stats.closed_sent_wa++;
}

async function askSentOnce(taskText, items, ctx) {
  ctx.stats.sent_ai_calls++;
  try {
    var v = await claude.askJSON({
      system: SENT_CHECK_PROMPT,
      user: taskText + '\n\nSENT OR CHANGED AFTER THE TASK WAS CREATED:\n\n' + sentItemsText(items),
      model: process.env.TASK_HUB_SENT_MODEL || undefined,
      maxTokens: 150
    });
    if (!v) return null;
    var a = v.answer === true || v.done === true ? 'done' : String(v.answer || (v.done === false ? 'not_done' : '')).toLowerCase();
    if (['done', 'not_done', 'unsure'].indexOf(a) === -1) return null;
    return { answer: a, item: parseInt(v.item, 10) || null, reason: v.reason || '' };
  } catch (e) { return null; }
}

async function addMiddleText(items) {
  var gmail;
  try { gmail = require('../lib/gmail'); } catch (e) { return; }
  if (typeof gmail.getMessageNewText !== 'function') return;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.channel !== 'email' || it.middle || it.auto) continue; // automatic emails: the label is enough
    var txt = await gmail.getMessageNewText(it.owner, it.id, SENT_MIDDLE_CHARS).catch(function () { return null; });
    if (txt) { it.text = txt; it.middle = true; }
  }
}

var SENT_CHECK_PROMPT =
  'You check a law firm\'s task list. You get one open TASK and messages that staff SENT after the task was created ' +
  '(emails and WhatsApp messages). Decide if one of them did what the task asks (answered the question, sent what ' +
  'was asked, to the right person, confirmed what was needed). Partly done, about something else, or a different ' +
  'person = not_done. If the text shown is too short to tell = unsure. ' +
  'A message shown as [AUTOMATIC EMAIL: ...] was sent by the firm\'s automation; its line says what it is — it counts ' +
  'only if that is exactly what the task asked for. ' +
  'A MONDAY CHANGE is a status column on the client\'s deal that changed after the task was created; it counts only ' +
  'if that change clearly means the task\'s request was done (e.g. "שלח צוואה חתומה → נשלח" after a request to send ' +
  'the signed wills). ' +
  'Reply with JSON only: {"answer": "done" | "not_done" | "unsure", "item": <number of the message that did it, or null>, ' +
  '"reason": "a few words in Hebrew"}';

async function markSentCheck(taskId, msgId, verdict) {
  await pool().query(
    `INSERT INTO task_hub_sent_checks (task_id, msg_id, verdict) VALUES ($1,$2,$3)
     ON CONFLICT (task_id, msg_id) DO UPDATE SET verdict = EXCLUDED.verdict,
       attempts = task_hub_sent_checks.attempts + 1, checked_at = now()`, [taskId, msgId, verdict]);
}

async function closeTaskBySent(taskId, reason, note) {
  await pool().query(
    `UPDATE unified_tasks SET status = 'done', done_at = now(), updated_at = now(), closed_reason = $2, closed_note = $3
      WHERE id = $1 AND status = 'open' AND NOT keep_open`, [taskId, reason, note]);
}

// 2026-10-04: one refresh per person at a time. The Refresh button and the
// 5-minute background sweep could run the full pipeline for the same person
// at the same moment, doubling the AI calls and the wait. A second caller now
// joins the run that's already going instead of starting another.
var _inflight = {};
function refreshTasks(userId) {
  var key = String(userId);
  if (_inflight[key]) return _inflight[key];
  var p = refreshTasksOnce(userId).finally(function () { delete _inflight[key]; });
  _inflight[key] = p;
  return p;
}
function isRefreshing(userId) { return !!_inflight[String(userId)]; }

async function refreshTasksOnce(userId) {
  await ensureTables();
  var userEmail = await getUserEmail(userId);

  var mondayCtx = await fetchMondayContext(userEmail).catch(function (e) {
    console.warn('[task-hub] fetchMondayContext failed (non-fatal):', e.message);
    return { monday: null, byItemId: {}, count: 0 };
  });

  var results = await Promise.allSettled([
    fetchEmailCandidates(userId),
    fetchWhatsappCandidates(userEmail, mondayCtx),
    fetchManualCandidates(userId, userEmail)
  ]);
  // 2026-09-15 (Shira): a rejected promise here used to vanish with NO log at
  // all — the source functions log their own internal failures (see the
  // console.warn calls inside fetchEmailCandidates/fetchWhatsappCandidates),
  // but if one of them throws past its own try/catch, Promise.allSettled
  // swallows it silently and that user's whole source just comes back empty,
  // indistinguishable from "genuinely nothing to do". Confirmed live: a real,
  // board-confirmed unanswered chat for an active user never showed up as a
  // WhatsApp candidate, and the Render logs had zero mention of it — no skip,
  // no failure, nothing. Logging every rejection here closes that blind spot.
  var SOURCE_NAMES = ['email', 'whatsapp', 'manual'];
  results.forEach(function (r, i) {
    if (r.status === 'rejected') {
      console.error('[task-hub] ' + SOURCE_NAMES[i] + ' candidate fetch threw for', userEmail, '-',
        (r.reason && r.reason.stack) || (r.reason && r.reason.message) || r.reason);
    }
  });
  var emailC = results[0].status === 'fulfilled' ? results[0].value : [];
  var waResult = results[1].status === 'fulfilled' ? results[1].value : { ok: false, candidates: [] };
  var waC = waResult.candidates || [];
  var manualC = results[2].status === 'fulfilled' ? results[2].value : [];

  var existingRows = await pool().query(
    'SELECT source, source_ref, status, keep_open, first_seen_at FROM unified_tasks WHERE user_id = $1',
    [userId]
  );
  // 2026-10-05: "is this new?" is now decided by the triage memory, not by
  // whether a task row exists — see triageWithMemory(). The old check only
  // remembered items that BECAME tasks, so everything the AI judged "not a
  // task" was re-sent to the AI on every refresh.
  var ctx = newTriageCtx(userId, existingRows.rows, await loadTriageMemory(userId));

  // Step 2: automatic reminder emails become tasks by rule, never via the AI.
  var types = await loadTaskTypes();
  var systemMatches = [];
  emailC = emailC.filter(function (c) {
    var hit = c.msg ? taskTypes.matchSystemEmail(types, c.msg) : null;
    if (hit) { systemMatches.push({ candidate: c, hit: hit }); return false; }
    return true;
  });
  // 8 Oct (Shira): the firm's own automatic emails that are not tasks (e.g.
  // "בקשת מצב חשבון", which goes to the developer with the clients copied).
  // The email itself is never a task; a reply to it (the developer sending the
  // statement) is asked about as usual, with a line saying what it answers.
  // For the people in skip_for (Tzipora) nothing in that conversation is a task.
  var ownRules = await autoEmailRules();
  var me = String(userEmail || '').toLowerCase();
  emailC = emailC.filter(function (c) {
    var own = c.msg ? ownAutoEmail(ownRules, c.msg.subject) : null;
    if (!own) return true;
    if (own.rule.skipFor.indexOf(me) !== -1 || (own.rule.notATask && !own.isReply)) {
      ctx.stats.own_auto_skipped++;
      return false;
    }
    if (own.isReply) c.claudeInput += '\n(This is a reply in a conversation that started with the firm\'s automatic email "' +
      own.rule.name + '"' + (own.rule.what ? ': ' + own.rule.what : '') + ')';
    return true;
  });

  // 2026-09-16 (Shira): auto-close an existing OPEN WhatsApp task once its
  // chat is no longer on this user's current unanswered list — see the
  // comment on fetchWhatsappCandidates above for why this only runs when
  // waResult.ok is true (a genuine "checked, and it's not on the list
  // anymore" answer), never on a failed/skipped fetch. Same effect as
  // ticking the checkbox by hand: status -> done, done_at stamped, nothing
  // deleted, fully reversible from the UI if this ever gets it wrong. Also
  // correctly handles a chat being reassigned to someone else: it drops off
  // THIS user's list (so their copy closes here) and appears fresh on the
  // new owner's next refresh (via isNewCandidate there), rather than being
  // stuck open for someone who no longer owns it.
  if (waResult.ok) {
    var stillUnanswered = {};
    waC.forEach(function (c) { stillUnanswered[c.source_ref] = true; });
    var toAutoClose = existingRows.rows.filter(function (r) {
      return r.source === 'whatsapp' && r.status === 'open' && !r.keep_open && !stillUnanswered[r.source_ref];
    });
    if (toAutoClose.length) {
      await Promise.all(toAutoClose.map(async function (r) {
        // 7 Oct (Shira: "how do I check when and how it closed?"): say WHY.
        // Still waiting firm-wide -> it moved to someone else (tag / last reply).
        // Otherwise -> who at the firm wrote last, and when.
        var why = await whatsappCloseWhy(r, waResult.waitingWith || {});
        return pool().query(
          `UPDATE unified_tasks SET status = 'done', done_at = now(), updated_at = now(), closed_reason = $3, closed_note = $4
           WHERE user_id = $1 AND source = 'whatsapp' AND source_ref = $2 AND status = 'open' AND NOT keep_open`,
          [userId, r.source_ref, why.reason, why.note]
        ).then(function () {
          console.log('[task-hub] whatsapp task auto-closed (' + why.reason + ': ' + why.note + '):', userEmail, r.source_ref);
        }).catch(function (e) {
          console.warn('[task-hub] failed to auto-close whatsapp task', r.source_ref, e.message);
        });
      }));
    }
  }

  await handleSystemEmails(userId, systemMatches, ctx);
  await triageWithMemory(userId, 'email', 'email-triage', emailC, ctx);
  await triageWithMemory(userId, 'whatsapp', 'wa-triage', waC, ctx);
  await triageWithMemory(userId, 'manual', 'manual-task-extract', manualC, ctx);
  await Promise.all(ctx.writes);
  await closeRepliedEmailTasks(userId, userEmail, ctx).catch(function (e) {
    console.warn('[task-hub] reply check failed (non-fatal):', e.message);
  });
  await scanSentMail(userId, ctx).catch(function (e) {
    console.warn('[task-hub] sent-mail read failed (non-fatal):', e.message);
  });
  await linkOldTasks(userId, ctx, mondayCtx).catch(function (e) {
    console.warn('[task-hub] old-task deal linking failed (non-fatal):', e.message);
  });
  await closeMondayDoneTasks(userId, ctx).catch(function (e) {
    console.warn('[task-hub] monday check failed (non-fatal):', e.message);
  });
  await fillCardDetails(userId, waC).catch(function (e) {
    console.warn('[task-hub] card details fill failed (non-fatal):', e.message);
  });
  await fillPeopleFromConversation(userId, ctx).catch(function (e) {
    console.warn('[task-hub] people from conversation failed (non-fatal):', e.message);
  });
  await closeBySentMail(userId, ctx).catch(function (e) {
    console.warn('[task-hub] sent-mail check failed (non-fatal):', e.message);
  });

  var st = ctx.stats;
  // One line per refresh — the number to watch is ai_calls. After the first
  // refresh following deploy it should be 0 unless something genuinely new
  // arrived.
  console.log('[task-hub/ai] ' + userEmail + ' — AI calls: ' + st.ai_calls +
    ' | already checked (no AI): ' + st.already_checked +
    ' | existing tasks recorded (no AI): ' + st.recorded_existing +
    ' | new tasks: ' + st.tasks_written + ' | not a task: ' + st.ai_not_a_task +
    ' | failed: ' + st.ai_failed + ' | system reminders (no AI): ' + st.system_rule +
    ' | closed — you replied: ' + st.closed_replied +
    ' | reminders already done in monday: ' + st.system_already_done +
    ' | closed — monday: ' + st.closed_monday +
    ' | typed: ' + st.typed + ' | linked to a deal: ' + st.linked_deal +
    ' | older tasks linked: ' + st.old_linked + '/' + st.old_checked +
    ' | not a task — already answered (no AI): ' + st.skipped_answered +
    ' | joined an open task — same conversation (no AI): ' + st.merged_thread +
    ' | joined an open task — same matter (AI): ' + st.merged_same +
    ' | tasks given their people from the conversation (no AI): ' + st.people_found +
    ' | not a task — the firm\'s own automatic email (no AI): ' + st.own_auto_skipped +
    ' | closed — monday changed (AI): ' + st.closed_monday_change +
    ' | sent mail read: ' + st.sent_scanned +
    ' | closed — colleague replied: ' + st.closed_sent_same +
    ' | closed — sent email (AI): ' + st.closed_sent_ai + ' | closed — WhatsApp (AI): ' + st.closed_sent_wa +
    ' | sent-check AI questions: ' + st.sent_ai_calls);

  return {
    email: emailC.length, whatsapp: waC.length, monday: mondayCtx.count, manual: manualC.length,
    triaged: st.ai_calls, stats: st
  };
}

// 2026-09-16 (Shira): "doesn't it make more sense for it to only update
// itself, not everything?" — right. whatsapp/ingest/voice.js used to call
// the full refreshTasks() the instant a voice-note transcript landed, which
// also re-checks email and monday.com for that person — sources that have
// nothing to do with the voice note that just finished. This is the same
// dedup-by-(source, source_ref) idea as refreshTasks(), just scoped to
// ONLY the manual/task-inbox source, so a transcript finishing triggers
// exactly the one Gmail-free, monday-free lookup it actually needs.
// refreshTasks() itself is untouched — the manual Refresh button and the
// 5-min background poll (lib/scheduler.js) still do the full multi-source
// pull, since THAT is genuinely meant to catch everything at once.
async function refreshManualTasks(userId) {
  await ensureTables();
  var userEmail = await getUserEmail(userId);
  var manualC = await fetchManualCandidates(userId, userEmail).catch(function (e) {
    console.warn('[task-hub] fetchManualCandidates failed (non-fatal):', e.message);
    return [];
  });

  // 2026-10-05: same triage memory as refreshTasks — a voice note is asked
  // about once, whichever path (this fast path or a full refresh) gets to it.
  var existingRows = await pool().query(
    "SELECT source, source_ref FROM unified_tasks WHERE user_id = $1 AND source = 'manual'",
    [userId]
  );
  var ctx = newTriageCtx(userId, existingRows.rows, await loadTriageMemory(userId));
  await triageWithMemory(userId, 'manual', 'manual-task-extract', manualC, ctx);
  await Promise.all(ctx.writes);
  console.log('[task-hub/ai] ' + userEmail + ' (task-inbox only) — AI calls: ' + ctx.stats.ai_calls +
    ' | already checked (no AI): ' + ctx.stats.already_checked);
  return { manual: manualC.length, triaged: ctx.stats.ai_calls };
}

// 8 Oct (Shira: "with 2 Gmail accounts open it opened the wrong mailbox"):
// /mail/u/0/ is whichever Google account is FIRST in that browser. The link now
// names the task owner's mailbox (/mail/u/<email>/), and opens the conversation
// (thread id) rather than one message. Old links are fixed when the list is read.
function gmailLink(mailbox, id) {
  if (!id) return null;
  var who = String(mailbox || '').trim();
  return 'https://mail.google.com/mail/u/' + (who ? encodeURIComponent(who).replace(/%40/g, '@') : '0') + '/#all/' + encodeURIComponent(id);
}
function fixMailLink(row, ownerEmail) {
  if (!row || row.source !== 'email' || !ownerEmail) return row;
  var link = String(row.link || '');
  var m = link.match(/^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/(.+)$/);
  if (m || !link) {
    var id = row.thread_id || (m && decodeURIComponent(m[1])) || (!/^sys:/.test(String(row.source_ref || '')) ? row.source_ref : null);
    var fixed = gmailLink(ownerEmail, id);
    if (fixed) return Object.assign({}, row, { link: fixed });
  }
  return row;
}

async function listTasks(userId, opts) {
  await ensureTables();
  var ownerEmail = await getUserEmail(userId).catch(function () { return null; });
  // 6 Oct: with doneToday, also what closed today (by hand or automatically,
  // with the reason), for the "הושלמו היום" list — a wrong close is reopened there.
  var res = await pool().query(
    `SELECT * FROM unified_tasks WHERE user_id = $1 AND (status = 'open'
        OR ($2 AND status = 'done' AND done_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem')))
      ORDER BY first_seen_at ASC`,
    [userId, !!(opts && opts.doneToday)]
  );
  return res.rows.map(function (row) {
    row = fixMailLink(row, ownerEmail);
    var eff = effectivePriority(row);
    var ds = dateState(row);
    return Object.assign({}, row, {
      expired: ds.expired, overdue: ds.overdue,
      effective_priority: eff,
      escalated: !row.priority_overridden_by_user && eff !== row.priority
    });
  }).sort(function (a, b) {
    var pd = PORDER[a.effective_priority] - PORDER[b.effective_priority];
    if (pd !== 0) return pd;
    return new Date(a.first_seen_at) - new Date(b.first_seen_at);
  });
}


async function listAllTasks() {
  await ensureTables();
  var res = await pool().query(
    `SELECT t.*, u.email AS user_email, u.display_name AS user_name
     FROM unified_tasks t
     JOIN users u ON u.id = t.user_id
     WHERE t.status = 'open'
     ORDER BY u.display_name ASC NULLS LAST, t.first_seen_at ASC`
  );
  return res.rows.map(function (row) {
    row = fixMailLink(row, row.user_email);
    var eff = effectivePriority(row);
    var ds = dateState(row);
    return Object.assign({}, row, {
      expired: ds.expired, overdue: ds.overdue,
      effective_priority: eff,
      escalated: !row.priority_overridden_by_user && eff !== row.priority
    });
  }).sort(function (a, b) {
    var nd = String(a.user_name || '').localeCompare(String(b.user_name || ''));
    if (nd !== 0) return nd;
    var pd = PORDER[a.effective_priority] - PORDER[b.effective_priority];
    if (pd !== 0) return pd;
    return new Date(a.first_seen_at) - new Date(b.first_seen_at);
  });
}

// 2026-09-15 (Shira): the "Team view" toggle used to always pull EVERY open
// task from EVERY user (listAllTasks above) just to draw the person-chips
// row, which made opening Team view slow, and gave no feedback while it was
// loading — so admins would click the toggle repeatedly thinking it hadn't
// registered. listTeamRoster() is the cheap replacement: one aggregate
// query (a COUNT, not the tasks themselves) so the "who has how many open
// tasks" dropdown can populate fast, before any actual task data loads. The
// dropdown then fetches ONE person's tasks via listTasks(id) on selection —
// see routes/mytasks.js's GET /admin/roster and GET /admin/user/:id.
// listAllTasks() above is kept for the dropdown's explicit "everyone" choice.
async function listTeamRoster() {
  await ensureTables();
  var res = await pool().query(
    `SELECT u.id, u.display_name AS name, u.email,
            COUNT(t.id) FILTER (WHERE t.status = 'open') AS open_count
     FROM users u
     LEFT JOIN unified_tasks t ON t.user_id = u.id
     WHERE u.status = 'active'
     GROUP BY u.id, u.display_name, u.email
     ORDER BY u.display_name ASC NULLS LAST`
  );
  return res.rows.map(function (row) {
    return { id: row.id, name: row.name, email: row.email, openCount: parseInt(row.open_count, 10) || 0 };
  });
}

async function addManualTask(userId, text) {
  await ensureTables();
  var extracted = await runSkill('manual-task-extract', text);
  var sourceRef = 'manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  await pool().query(
    `INSERT INTO unified_tasks (user_id, source, source_ref, title, estimated_minutes, priority, first_seen_at)
     VALUES ($1,'manual',$2,$3,$4,$5, now())`,
    [userId, sourceRef, extracted.title, extracted.estimated_minutes || 15, extracted.priority || 'normal']
  );
  var res = await pool().query(
    `SELECT * FROM unified_tasks WHERE user_id = $1 AND source_ref = $2`,
    [userId, sourceRef]
  );
  return res.rows[0];
}

async function patchTask(userId, id, fields) {
  await ensureTables();
  var sets = [], vals = [userId, id];
  if (typeof fields.title === 'string' && fields.title.trim()) {
    vals.push(fields.title.trim()); sets.push('title = $' + vals.length);
  }
  if (Number.isFinite(fields.estimated_minutes)) {
    vals.push(fields.estimated_minutes); sets.push('estimated_minutes = $' + vals.length);
  }
  if (typeof fields.priority === 'string' && PORDER.hasOwnProperty(fields.priority)) {
    vals.push(fields.priority); sets.push('priority = $' + vals.length);
    sets.push('priority_overridden_by_user = true');
  }
  if (!sets.length) return null;
  sets.push('updated_at = now()');
  var res = await pool().query(
    `UPDATE unified_tasks SET ${sets.join(', ')} WHERE user_id = $1 AND id = $2 RETURNING *`,
    vals
  );
  return res.rows[0] || null;
}

// Admin editing a task that isn't theirs (from the "Team view" dropdown) —
// same field whitelist as patchTask (title / estimated_minutes / priority
// only, never status/done_at), but scoped by id alone rather than
// `WHERE user_id = $1 AND id = $2`, since the caller is an admin, not the
// task's owner. No admin equivalent of toggleTask() exists here by design —
// an admin can never mark someone else's task done.
//
// 2026-09-15: this function existed before (routes/mytasks.js's
// PATCH /admin/:id already calls it) but was lost from this file in an
// earlier overwrite, so every admin edit from Team view has been hitting
// "taskHub.patchTaskAsAdmin is not a function" (caught and returned as a
// generic 500 "update failed") since then. Restored here, same as before.
async function patchTaskAsAdmin(id, fields) {
  await ensureTables();
  var sets = [], vals = [id];
  if (typeof fields.title === 'string' && fields.title.trim()) {
    vals.push(fields.title.trim()); sets.push('title = $' + vals.length);
  }
  if (Number.isFinite(fields.estimated_minutes)) {
    vals.push(fields.estimated_minutes); sets.push('estimated_minutes = $' + vals.length);
  }
  if (typeof fields.priority === 'string' && PORDER.hasOwnProperty(fields.priority)) {
    vals.push(fields.priority); sets.push('priority = $' + vals.length);
    sets.push('priority_overridden_by_user = true');
  }
  if (!sets.length) return null;
  sets.push('updated_at = now()');
  var res = await pool().query(
    `UPDATE unified_tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    vals
  );
  return res.rows[0] || null;
}

async function toggleTask(userId, id) {
  await ensureTables();
  var res = await pool().query(
    `UPDATE unified_tasks
     SET status = CASE WHEN status = 'open' THEN 'done' ELSE 'open' END,
         done_at = CASE WHEN status = 'open' THEN now() ELSE NULL END,
         keep_open = CASE WHEN status = 'done' THEN true ELSE keep_open END,
         closed_reason = CASE WHEN status = 'open' THEN 'by_hand' ELSE NULL END,
         updated_at = now()
     WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, id]
  );
  return res.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Server-side sweep — 2026-09-15 (Shira): "even if there isn't a task, the
// task is to respond." The shared Board is the source of truth for who owes
// a client a reply; until now the ONLY thing that ever called refreshTasks()
// was a staff member's own Task Hub tab (a manual click, or the 45s
// client-side poll added the same day in public/mytasks.html) — so a chat
// could be fully resolved to someone on the Board, with zero task ever
// appearing for them, purely because they hadn't opened Task Hub since it
// started waiting (confirmed live: several Board rows resolved to a real
// owner had no matching row in unified_tasks). This sweep calls
// refreshTasks() for every active user on a timer, server-side, so the task
// shows up regardless of whether anyone has the page open — matching the
// same in-process interval style as lib/scheduler.js: unref'd, guarded
// against overlapping passes, and one user's failure never blocks the rest
// (each refreshTasks() call has its own try/catch). Cost stays bounded the
// same way a manual refresh already does — isNewCandidate() inside
// refreshTasks() skips anything already triaged, so the AI triage call only
// ever runs for genuinely new candidates.
// ---------------------------------------------------------------------------
// 2026-09-15 (Shira): the "one user's failure never blocks the rest" claim
// above was only half true — a try/catch only catches a REJECTED promise, not
// one that just hangs forever (a slow/stuck Gmail or Claude API call with no
// timeout of its own — confirmed real: Render logs showed a "socket hang up"
// from gmail.searchMail in this same code path). A hang in refreshTasks() for
// ANY one user stalls this whole for-loop indefinitely, so every user after
// them in the list never gets swept — AND _sweeping never resets (its
// `finally` never runs on a suspended await), so every future 5-minute tick
// is silently skipped too, forever, until the next deploy. Confirmed live:
// after deploy, only the FIRST active user's WhatsApp fetch ever logged
// anything. withTimeout() below caps each user's refreshTasks() call so one
// stuck user can never take down the sweep for everyone else again.
function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(new Error('timed out after ' + ms + 'ms (' + label + ')'));
    }, ms);
    Promise.resolve(promise).then(
      function (v) { clearTimeout(timer); resolve(v); },
      function (e) { clearTimeout(timer); reject(e); }
    );
  });
}

var _sweeping = false;
var _sweepTimer = null;
var SWEEP_USER_TIMEOUT_MS = Math.max(60, parseInt(process.env.TASK_HUB_SWEEP_USER_TIMEOUT_SECONDS || '300', 10)) * 1000;
async function sweepAllUsers() {
  if (_sweeping) return;
  _sweeping = true;
  try {
    var allUsers = await withTimeout(db.listAllUsers(), 20 * 1000, 'db.listAllUsers');
    var active = (allUsers || []).filter(function (u) { return u.status === 'active'; });
    var ok = 0, failed = 0;
    for (var i = 0; i < active.length; i++) {
      try {
        // 7 Oct: a full refresh (sent mail + AI checks) often takes 1-3 minutes;
        // at 90s the sweep gave up waiting and started the next person while the
        // first was still running. Wait longer so people run one after another.
        await withTimeout(refreshTasks(active[i].id), SWEEP_USER_TIMEOUT_MS, active[i].email);
        ok++;
      } catch (e) {
        failed++;
        console.warn('[task-hub/sweep] refreshTasks failed for', active[i].email, e.message);
      }
    }
    console.log('[task-hub/sweep] pass done: ' + ok + ' user(s) refreshed, ' + failed + ' failed');
  } catch (e) {
    console.error('[task-hub/sweep] pass failed:', e.message);
  } finally {
    _sweeping = false;
  }
}
function startServerSideSweep() {
  if (_sweepTimer) return; // idempotent — safe to call once at boot
  // 2026-10-04: off switch. TASK_HUB_SWEEP_ENABLED=false on Render stops the
  // background sweep (and its AI calls) entirely; the Refresh button still works.
  if (/^(0|false|no|off)$/i.test(String(process.env.TASK_HUB_SWEEP_ENABLED || '').trim())) {
    console.log('[task-hub/sweep] disabled (TASK_HUB_SWEEP_ENABLED=false)');
    return;
  }
  var everyMs = Math.max(60, parseInt(process.env.TASK_HUB_SWEEP_INTERVAL_SECONDS || '300', 10)) * 1000;
  _sweepTimer = setInterval(sweepAllUsers, everyMs);
  if (_sweepTimer.unref) _sweepTimer.unref();
  console.log('[task-hub/sweep] armed: every ' + (everyMs / 1000) + 's');
  // Kick one off shortly after boot too, instead of waiting a full interval.
  setTimeout(sweepAllUsers, 15000);
}

function _resetCaches() { _auto = { at: 0, rows: [] }; _aiFrom = null; } // tests

module.exports = {
  attachFoundDeal, dealKind,
  _resetCaches, readSentForAll, _readAllPromise: function () { return _readAll; },
  refreshTasks, isRefreshing, chooseDealForTask, removeDealFromTask, searchDeals, setGroupLink, refreshManualTasks, listTasks, listAllTasks, listTeamRoster, addManualTask,
  patchTask, patchTaskAsAdmin, toggleTask, startServerSideSweep
};
