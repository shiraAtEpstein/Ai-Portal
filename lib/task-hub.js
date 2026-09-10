'use strict';

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
 */

var db = require('../db');

// ---------------------------------------------------------------------------
// Claude access goes through the portal's existing lib/claude.js (same
// helper the deal-matching / Phase 4 summary jobs already use) instead of a
// hand-rolled client. That module already resolves a model from
// process.env.CLAUDE_MODEL (falling back to a sane built-in default) and
// handles the API key + JSON parsing — so no separate TASK_HUB_MODEL env
// var is needed at all.
// ---------------------------------------------------------------------------
var claude = require('../lib/claude');

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
  }).then(function () { return true; })
    .catch(function (e) { console.error('[task-hub] ensureTables failed:', e.message); _tablesReady = null; return false; });
  return _tablesReady;
}

// Confirmed against the real repo: lib/calendar.js and lib/gmail.js both
// use this exact `SELECT email FROM users WHERE id = $1` query.
async function getUserEmail(userId) {
  var r = await pool().query('SELECT email FROM users WHERE id = $1', [userId]);
  if (!r.rows.length) throw new Error('task-hub: no user found for id ' + userId);
  return r.rows[0].email;
}

// ---------------------------------------------------------------------------
// Business-hours-aware aging (self-contained — mirrors the 08:00-22:00,
// Sun-Thu calendar documented for the WA aging feature. If you'd rather
// share lib/business-hours.js/lib/wait-label.js exactly, swap
// businessHoursElapsedMs below for a call into those instead.)
// ---------------------------------------------------------------------------
var TZ = process.env.FIRM_TZ || 'Asia/Jerusalem';
var BIZ_START_HOUR = 8, BIZ_END_HOUR = 22; // 08:00-22:00
var BIZ_DAYS = [0, 1, 2, 3, 4]; // Sun(0)-Thu(4); Fri/Sat excluded

function partsInTz(date) {
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false
  });
  var parts = fmt.formatToParts(date);
  var map = {};
  parts.forEach(function (p) { map[p.type] = p.value; });
  var dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday);
  return { day: dayIdx, hour: parseInt(map.hour, 10) % 24, minute: parseInt(map.minute, 10) };
}
function businessHoursElapsedMs(fromDate, toDate) {
  var cursor = new Date(fromDate.getTime());
  var end = toDate.getTime();
  var STEP = 15 * 60 * 1000;
  var counted = 0;
  var guard = 0;
  while (cursor.getTime() < end && guard < 40000) {
    var p = partsInTz(cursor);
    if (BIZ_DAYS.indexOf(p.day) !== -1 && p.hour >= BIZ_START_HOUR && p.hour < BIZ_END_HOUR) {
      counted += STEP;
    }
    cursor = new Date(cursor.getTime() + STEP);
    guard++;
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

// ---------------------------------------------------------------------------
// Skill runner — loads the active DB-stored prompt for `key` (seeded by
// sql/2026-09-task-hub.sql) and asks Claude for one JSON object back.
// ---------------------------------------------------------------------------
async function getActiveSkill(key) {
  var res = await pool().query(
    'SELECT s.body_md, s.model FROM task_hub_skill_active a ' +
    'JOIN task_hub_skills s ON s.id = a.skill_id WHERE a.key = $1',
    [key]
  );
  if (!res.rows.length) throw new Error('task-hub: no active skill for key "' + key + '" — run sql/2026-09-task-hub.sql');
  return res.rows[0];
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

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function fetchEmailCandidates(userId) {
  var gmail;
  try { gmail = require('../lib/gmail'); }
  catch (e) { console.warn('[task-hub] lib/gmail not found — skipping email source:', e.message); return []; }
  if (typeof gmail.searchMail !== 'function') {
    console.warn('[task-hub] lib/gmail.searchMail not found — skipping email source');
    return [];
  }
  // Real signature (confirmed from lib/gmail.js): searchMail(userId, opts)
  // where opts = { query, maxResults, includeBody }, returning
  // { connected, mailbox, count, messages, text } — not a bare array.
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
    // Not an error — this user just hasn't connected their own Gmail yet
    // (Account settings → Connect Gmail). Nothing to pull until they do.
    return [];
  }
  return (result.messages || []).map(function (m) {
    return {
      source_ref: m.id,
      first_seen_at: m.date || new Date().toISOString(),
      claudeInput: 'Subject: ' + (m.subject || '') + '\nFrom: ' + (m.from || '') +
        '\nSnippet: ' + (m.snippet || '')
    };
  });
}

// ---------------------------------------------------------------------------
// Monday: background/context, not a task source. Pulls the user's deals
// once (myDeals), keyed by item id, so a WhatsApp (or future email) task
// that's traceable to a specific deal can carry "where does this stand"
// alongside it — instead of monday items showing up as their own separate
// to-dos. Read-only, same as before.
// ---------------------------------------------------------------------------
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
    res = await monday.myDeals(userEmail);
  } catch (e) {
    console.warn('[task-hub] monday.myDeals failed for', userEmail, e.message);
    return { monday: monday, byItemId: {}, count: 0 };
  }
  var byItemId = {};
  (res && res.deals || []).forEach(function (d) { byItemId[String(d.id)] = d; });
  return { monday: monday, byItemId: byItemId, count: Object.keys(byItemId).length };
}

function dealBackgroundText(d) {
  if (!d) return '';
  var fieldLines = Object.keys(d.fields || {})
    .filter(function (k) { return d.fields[k]; })
    .map(function (k) { return '  ' + k + ': ' + d.fields[k]; })
    .join('\n');
  return 'Deal background (from monday, for context only — not the task itself) — ' +
    d.name + ' [board: ' + d.board + ', your role: ' + d.role + ']:\n' + fieldLines;
}

async function fetchWhatsappCandidates(userEmail, mondayCtx) {
  var waDb;
  try { waDb = require('../whatsapp/ingest/db'); }
  catch (e) { console.warn('[task-hub] whatsapp/ingest/db not found — skipping WhatsApp source:', e.message); return []; }

  // Real shape (confirmed from config/staff-directory.json): a top-level
  // { staff: [{ name, phone9, email, ... }] } — not a flat map keyed by
  // name, and the phone field is `phone9`, not `phone`/`number`.
  var staffDir;
  try { staffDir = require('../config/staff-directory.json'); } catch (e) { staffDir = null; }
  var staffPhone = null;
  if (staffDir && Array.isArray(staffDir.staff)) {
    var entry = staffDir.staff.find(function (s) { return s && s.email === userEmail; });
    staffPhone = entry && entry.phone9;
  }
  if (!staffPhone) {
    console.warn('[task-hub] no phone9 found in config/staff-directory.json for', userEmail, '— skipping WhatsApp source');
    return [];
  }

  var chats = await waDb.listUnansweredChats({ hours: 0, staffPhones: [staffPhone] });

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

  // Real shape (confirmed from whatsapp/ingest/db.js listUnansweredChats):
  // chat_jid / label / firstUnansweredAt / blockText — not
  // chatId/chatName/oldestUnansweredAt/unansweredMessages.
  var out = [];
  for (var i = 0; i < (chats || []).length; i++) {
    var c = chats[i];
    var dealText = '';
    // Best-effort: only finds a deal when (a) monday is configured and (b)
    // this WhatsApp group's id is stored on a deal this same user is
    // paralegal/tax person for (mondayCtx comes from THEIR myDeals). A group
    // linked to someone else's deal, or not linked at all, just gets no
    // background — never blocks or fails the task itself.
    if (mondayCtx && mondayCtx.monday && typeof mondayCtx.monday.resolveDealForGroupId === 'function') {
      try {
        var link = await mondayCtx.monday.resolveDealForGroupId(c.chat_jid);
        if (link && mondayCtx.byItemId[String(link.monday_item_id)]) {
          dealText = dealBackgroundText(mondayCtx.byItemId[String(link.monday_item_id)]);
        }
      } catch (e) { /* best-effort, ignore */ }
    }
    out.push({
      source_ref: c.chat_jid,
      first_seen_at: c.firstUnansweredAt || new Date().toISOString(),
      claudeInput:
        'Chat: ' + (c.label || c.chat_jid) + '\n' +
        'Waited: ' + (c.calendarHoursWaiting != null ? c.calendarHoursWaiting + 'h' : 'unknown') + '\n' +
        'Unanswered messages:\n' + (c.blockText || '') +
        (dealText ? ('\n\n' + dealText) : '') +
        (activeVoiceRules ? ('\n\nFirm WhatsApp voice/rules knowledge:\n' + activeVoiceRules) : '')
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manual: a staff member's own personal WhatsApp group with LAWLY/staff/
// Yaacov (e.g. "Yaakov Hershkowitzes tasks משימות") — everything sent there
// is candidate task text. WHICH group belongs to which user is looked up
// from whatsapp_groups.task_owner_email — an explicit link set once (see the
// SQL delivered alongside this file), never guessed from the group's name.
// Only pulls messages newer than the last one already turned into a task for
// this user, so a repeat refresh doesn't re-spend a Claude call re-reading
// the same old messages every time.
// ---------------------------------------------------------------------------
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
  // Nobody's linked a task-inbox group for this user yet — not an error, just
  // nothing to pull (same as a user who hasn't connected Gmail).
  if (!jid) return [];

  var since = null;
  try {
    var sinceRow = await pool().query(
      "SELECT first_seen_at FROM unified_tasks WHERE user_id = $1 AND source = 'manual' ORDER BY first_seen_at DESC LIMIT 1",
      [userId]
    );
    since = sinceRow.rows[0] && sinceRow.rows[0].first_seen_at;
  } catch (e) { /* first run, or query hiccup — fall through and just take the recent batch */ }

  var msgs;
  try {
    msgs = await waDb.listTaskInboxMessages(jid, { limit: 20 });
  } catch (e) {
    console.warn('[task-hub] listTaskInboxMessages failed for', jid, e.message);
    return [];
  }
  if (since) {
    var sinceMs = new Date(since).getTime();
    msgs = (msgs || []).filter(function (m) { return new Date(m.eff_at).getTime() > sinceMs; });
  }
  return (msgs || []).map(function (m) {
    return {
      source_ref: m.source_item_id,
      first_seen_at: m.eff_at || new Date().toISOString(),
      claudeInput: m.text
    };
  });
}

// ---------------------------------------------------------------------------
// Public API — every function takes userId (uuid), matching
// req.session.userId app-wide.
// ---------------------------------------------------------------------------

async function upsertTask(userId, source, sourceRef, extracted, firstSeenAt) {
  await pool().query(
    `INSERT INTO unified_tasks (user_id, source, source_ref, title, summary, estimated_minutes, priority, first_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, source, source_ref) DO UPDATE SET
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       estimated_minutes = EXCLUDED.estimated_minutes,
       priority = CASE WHEN unified_tasks.priority_overridden_by_user THEN unified_tasks.priority ELSE EXCLUDED.priority END,
       updated_at = now()
     WHERE unified_tasks.status = 'open'`,
    [userId, source, sourceRef, extracted.title, extracted.summary || null,
     extracted.estimated_minutes || null, extracted.priority || 'normal', firstSeenAt]
  );
}

async function refreshTasks(userId) {
  await ensureTables();
  var userEmail = await getUserEmail(userId);

  // monday first — it never creates tasks itself, but fetchWhatsappCandidates
  // needs it (to attach deal background to a WhatsApp task, when there is one).
  var mondayCtx = await fetchMondayContext(userEmail).catch(function (e) {
    console.warn('[task-hub] fetchMondayContext failed (non-fatal):', e.message);
    return { monday: null, byItemId: {}, count: 0 };
  });

  var results = await Promise.allSettled([
    fetchEmailCandidates(userId),
    fetchWhatsappCandidates(userEmail, mondayCtx),
    fetchManualCandidates(userId, userEmail)
  ]);
  var emailC = results[0].status === 'fulfilled' ? results[0].value : [];
  var waC = results[1].status === 'fulfilled' ? results[1].value : [];
  var manualC = results[2].status === 'fulfilled' ? results[2].value : [];

  // 2026-09-10 (Shira): don't re-spend a Claude call on something already
  // triaged. Every refresh used to re-send EVERY currently-open email and
  // EVERY currently-unanswered WhatsApp chat through Claude again, even
  // when nothing about it had changed since last time — that's why a
  // refresh took 50+ seconds and why the same broken email kept showing
  // the identical error on every single refresh. A (source, source_ref)
  // that already has a row in unified_tasks — open OR done — has already
  // been triaged once; asking Claude again produces the same answer (open)
  // or gets thrown away anyway by upsertTask's `WHERE status = 'open'`
  // guard (done), so it's pure waste. Only genuinely new candidates reach
  // runSkill now. Existing tasks aren't "regenerated" — their priority
  // still ages/escalates over time via effectivePriority() with no AI
  // call needed, and marking one done still works exactly as before.
  var existingRows = await pool().query(
    'SELECT source, source_ref FROM unified_tasks WHERE user_id = $1',
    [userId]
  );
  var existingKeys = {};
  existingRows.rows.forEach(function (r) { existingKeys[r.source + '
