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
      'ADD COLUMN IF NOT EXISTS party text'
    );
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

function effectivePriority(task) {
  if (task.priority_overridden_by_user) return task.priority;
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
  if (row.verdict === 'task' || row.verdict === 'skip') return false;
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
async function resolveDeal(c, extracted, out) {
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
    var byEmail = await mondayCheck.findDealByAddresses(addrs, hint, out);
    if (byEmail) { byEmail.via = 'email address'; return byEmail; }
  }
  if (extracted && extracted.client_name) {
    var byName = await mondayCheck.findDeal(String(extracted.client_name), hint, out);
    if (byName) { byName.via = 'client name'; return byName; }
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

// 6 Oct: the person picks the deal from the card ("choose a deal"). Only one
// of that task's own candidates can be chosen; dealId null = "none of these".
// For types monday can close, the current state is the baseline, so a deal
// that is already "done" doesn't close the task the moment it's chosen.
async function chooseDealForTask(userId, id, dealId) {
  await ensureTables();
  var r = await pool().query(
    'SELECT id, task_type, deal_candidates FROM unified_tasks WHERE id = $1 AND user_id = $2', [id, userId]);
  var row = r.rows[0];
  if (!row) return null;
  if (!dealId) {
    await pool().query('UPDATE unified_tasks SET deal_candidates = NULL, updated_at = now() WHERE id = $1', [id]);
  } else {
    var cands = Array.isArray(row.deal_candidates) ? row.deal_candidates : [];
    var pick = cands.find(function (d) { return String(d.id) === String(dealId); });
    if (!pick) { var err = new Error('not one of this task\'s deals'); err.status = 400; throw err; }
    var types = await loadTaskTypes();
    var type = types.find(function (t) { return t.key === row.task_type; }) || null;
    await saveDealLink(row.id, { id: String(pick.id), board: String(pick.board), name: pick.name || null }, type);
  }
  return (await pool().query('SELECT * FROM unified_tasks WHERE id = $1', [id])).rows[0];
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
  if (!deal) deal = await resolveDeal(c, extracted, out);
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
        AND source IN ('email', 'whatsapp') AND source_ref NOT LIKE 'sys:%'
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
      } else if (gmail && typeof gmail.getMessageAddresses === 'function') {
        var msg = await gmail.getMessageAddresses(userId, r.source_ref);
        if (!msg) {
          // The email can't be read (deleted, or Gmail not connected). Mark it
          // so it isn't retried forever and doesn't block the others.
          await pool().query("UPDATE unified_tasks SET deal_checked_at = now(), party = COALESCE(party, 'unknown') WHERE id = $1", [r.id]);
          continue;
        }
        c.msg = msg;
      }
      var out = {};
      var deal = await resolveDeal(c, { title: r.title + ' ' + (r.summary || '') }, out);
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

  await runLimited(todo, 3, async function (c) {
    ctx.stats.ai_calls++;
    var extracted;
    try {
      extracted = await runSkill(skillKey, c.claudeInput + typeBlock);
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
    var type = pickType(types, extracted.task_type);
    try {
      await upsertTask(userId, source, c.source_ref, extracted, c.first_seen_at, c.link,
        { reopenIfDone: source === 'whatsapp', threadId: c.thread_id || null, taskType: type ? type.key : null });
      ctx.stats.tasks_written++;
      if (type) ctx.stats.typed++;
      if (source !== 'manual' || extracted.client_name) {
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
  });
}

function newTriageCtx(userId, taskRows, memory) {
  var taskKeys = {};
  taskRows.forEach(function (r) { taskKeys[triageKey(r.source, r.source_ref)] = true; });
  return {
    nowMs: Date.now(), memory: memory, taskKeys: taskKeys, writes: [],
    stats: { candidates: 0, already_checked: 0, recorded_existing: 0, ai_calls: 0,
             ai_not_a_task: 0, ai_failed: 0, tasks_written: 0,
             system_rule: 0, closed_replied: 0, system_already_done: 0, closed_monday: 0,
             typed: 0, linked_deal: 0, old_linked: 0, old_checked: 0 }
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
      link: m.id ? ('https://mail.google.com/mail/u/0/#all/' + m.id) : null,
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
  var chats = allChats.filter(function (c) { return c.responsibleEmail === userEmail; });
  // 2026-09-15 (Shira): visibility only — so "0 candidates" is distinguishable
  // in the logs from "this call never even ran" (see the rejection logging
  // added in refreshTasks above) and from "found some, all filtered out by
  // wa-triage/isNewCandidate downstream".
  console.log('[task-hub] whatsapp: listUnansweredChats returned', allChats.length,
    'firm-wide,', chats.length, 'resolved to', userEmail);

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
      claudeInput:
        'Chat: ' + (c.label || c.chat_jid) + '\n' +
        'Waited: ' + (c.calendarHoursWaiting != null ? c.calendarHoursWaiting + 'h' : 'unknown') + '\n' +
        'Unanswered messages:\n' + (c.blockText || '') +
        (dealText ? ('\n\n' + dealText) : '') +
        (activeVoiceRules ? ('\n\nFirm WhatsApp voice/rules knowledge:\n' + activeVoiceRules) : '')
    });
  }
  return { ok: true, candidates: out };
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
  await pool().query(
    `INSERT INTO unified_tasks (user_id, source, source_ref, title, summary, estimated_minutes, priority, first_seen_at, link, thread_id, task_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$11,$12)
     ON CONFLICT (user_id, source, source_ref) DO UPDATE SET
       thread_id = COALESCE(EXCLUDED.thread_id, unified_tasks.thread_id),
       task_type = COALESCE(EXCLUDED.task_type, unified_tasks.task_type),
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       estimated_minutes = EXCLUDED.estimated_minutes,
       priority = CASE WHEN unified_tasks.priority_overridden_by_user THEN unified_tasks.priority ELSE EXCLUDED.priority END,
       link = EXCLUDED.link,
       status = CASE WHEN unified_tasks.status = 'done' AND $10 THEN 'open' ELSE unified_tasks.status END,
       done_at = CASE WHEN unified_tasks.status = 'done' AND $10 THEN NULL ELSE unified_tasks.done_at END,
       first_seen_at = CASE WHEN unified_tasks.status = 'done' AND $10 THEN EXCLUDED.first_seen_at ELSE unified_tasks.first_seen_at END,
       updated_at = now()
     WHERE unified_tasks.status = 'open' OR ($10 AND unified_tasks.status = 'done')`,
    [userId, source, sourceRef, extracted.title, extracted.summary || null,
     extracted.estimated_minutes || null, extracted.priority || 'normal', firstSeenAt, link || null, reopenIfDone,
     threadId, taskType]
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
        c.first_seen_at, c.link, { threadId: c.thread_id, taskType: t.key });
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
        await pool().query('UPDATE unified_tasks SET deal_id = $1, deal_board = $2 WHERE id = $3', [deal.id, deal.board, r.id]);
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
var REPLY_CHECK_MAX = 40;
async function closeRepliedEmailTasks(userId, userEmail, ctx) {
  var gmail;
  try { gmail = require('../lib/gmail'); } catch (e) { return; }
  if (typeof gmail.getThreadActivity !== 'function') return;
  var rows = (await pool().query(
    `SELECT id, source_ref, thread_id FROM unified_tasks
      WHERE user_id = $1 AND source = 'email' AND status = 'open' AND NOT keep_open
        AND source_ref NOT LIKE 'sys:%'
      ORDER BY first_seen_at DESC LIMIT $2`, [userId, REPLY_CHECK_MAX]
  )).rows;
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
    var act = await gmail.getThreadActivity(userId, threadId);
    if (!act || !act.messages || !act.messages.length) return;
    var msgs = act.messages.slice().sort(function (a, b) { return a.internalDate - b.internalDate; });
    var idx = msgs.findIndex(function (m) { return m.id === r.source_ref; });
    if (idx < 0) return; // the email itself is gone — don't guess
    var replied = msgs.slice(idx + 1).some(function (m) {
      return (m.labelIds || []).indexOf('SENT') !== -1 ||
        (me && taskTypes.senderAddress(m.from) === me);
    });
    if (!replied) return;
    try {
      await pool().query(
        `UPDATE unified_tasks SET status = 'done', done_at = now(), updated_at = now(), closed_reason = 'replied'
          WHERE id = $1 AND status = 'open' AND NOT keep_open`, [r.id]
      );
      ctx.stats.closed_replied++;
    } catch (e) {
      console.warn('[task-hub] failed to close replied email task', r.id, e.message);
    }
  });
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
    'SELECT source, source_ref, status, keep_open FROM unified_tasks WHERE user_id = $1',
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
      await Promise.all(toAutoClose.map(function (r) {
        return pool().query(
          `UPDATE unified_tasks SET status = 'done', done_at = now(), updated_at = now(), closed_reason = 'replied'
           WHERE user_id = $1 AND source = 'whatsapp' AND source_ref = $2 AND status = 'open' AND NOT keep_open`,
          [userId, r.source_ref]
        ).then(function () {
          console.log('[task-hub] whatsapp task auto-closed (chat no longer unanswered):', userEmail, r.source_ref);
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
  await linkOldTasks(userId, ctx, mondayCtx).catch(function (e) {
    console.warn('[task-hub] old-task deal linking failed (non-fatal):', e.message);
  });
  await closeMondayDoneTasks(userId, ctx).catch(function (e) {
    console.warn('[task-hub] monday check failed (non-fatal):', e.message);
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
    ' | older tasks linked: ' + st.old_linked + '/' + st.old_checked);

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

async function listTasks(userId) {
  await ensureTables();
  var res = await pool().query(
    `SELECT * FROM unified_tasks WHERE user_id = $1 AND status = 'open' ORDER BY first_seen_at ASC`,
    [userId]
  );
  return res.rows.map(function (row) {
    var eff = effectivePriority(row);
    return Object.assign({}, row, {
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
    var eff = effectivePriority(row);
    return Object.assign({}, row, {
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
async function sweepAllUsers() {
  if (_sweeping) return;
  _sweeping = true;
  try {
    var allUsers = await withTimeout(db.listAllUsers(), 20 * 1000, 'db.listAllUsers');
    var active = (allUsers || []).filter(function (u) { return u.status === 'active'; });
    var ok = 0, failed = 0;
    for (var i = 0; i < active.length; i++) {
      try {
        await withTimeout(refreshTasks(active[i].id), 90 * 1000, active[i].email);
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

module.exports = {
  refreshTasks, isRefreshing, chooseDealForTask, refreshManualTasks, listTasks, listAllTasks, listTeamRoster, addManualTask,
  patchTask, patchTaskAsAdmin, toggleTask, startServerSideSweep
};
