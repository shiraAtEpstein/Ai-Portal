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
      source_ref: m.id,
      first_seen_at: m.date || new Date().toISOString(),
      link: m.id ? ('https://mail.google.com/mail/u/0/#all/' + m.id) : null,
      claudeInput: 'Subject: ' + (m.subject || '') + '\nFrom: ' + (m.from || '') +
        (ccOnly ? '\n(You were CC\'d on this, not a direct recipient)' : '') +
        '\nSnippet: ' + (m.snippet || '')
    });
  }
  return out;
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

async function fetchWhatsappCandidates(userEmail, mondayCtx) {
  var waDb;
  try { waDb = require('../whatsapp/ingest/db'); }
  catch (e) { console.warn('[task-hub] whatsapp/ingest/db not found — skipping WhatsApp source:', e.message); return []; }

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
      link: await waLinkFor(c),
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
  await pool().query(
    `INSERT INTO unified_tasks (user_id, source, source_ref, title, summary, estimated_minutes, priority, first_seen_at, link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, source, source_ref) DO UPDATE SET
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
     extracted.estimated_minutes || null, extracted.priority || 'normal', firstSeenAt, link || null, reopenIfDone]
  );
}

async function refreshTasks(userId) {
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
  var waC = results[1].status === 'fulfilled' ? results[1].value : [];
  var manualC = results[2].status === 'fulfilled' ? results[2].value : [];

  var existingRows = await pool().query(
    'SELECT source, source_ref, status FROM unified_tasks WHERE user_id = $1',
    [userId]
  );
  // existingKeys: ANY row for this (source, ref), regardless of status — the
  // original "ever existed, never touch again" guard, kept as-is for
  // email/manual. openWaKeys: WhatsApp only, OPEN rows only — a done
  // WhatsApp row does NOT block re-triage, since the chat can legitimately
  // need a reply again after being marked done (see upsertTask's
  // reopenIfDone above). See 2026-09-15 note there for why WhatsApp is
  // treated differently from email/manual.
  var existingKeys = {};
  var openWaKeys = {};
  existingRows.rows.forEach(function (r) {
    existingKeys[r.source + ' ' + r.source_ref] = true;
    if (r.source === 'whatsapp' && r.status === 'open') openWaKeys[r.source + ' ' + r.source_ref] = true;
  });
  function isNewCandidate(source, ref) {
    if (source === 'whatsapp') return !openWaKeys[source + ' ' + ref];
    return !existingKeys[source + ' ' + ref];
  }

  var jobs = [];
  emailC.filter(function (c) { return isNewCandidate('email', c.source_ref); })
    .forEach(function (c) { jobs.push(runOne('email', 'email-triage', c)); });
  waC.filter(function (c) { return isNewCandidate('whatsapp', c.source_ref); })
    .forEach(function (c) { jobs.push(runOne('whatsapp', 'wa-triage', c)); });
  manualC.filter(function (c) { return isNewCandidate('manual', c.source_ref); })
    .forEach(function (c) { jobs.push(runOne('manual', 'manual-task-extract', c)); });

  async function runOne(source, skillKey, candidate) {
    try {
      var extracted = await runSkill(skillKey, candidate.claudeInput);
      if (extracted.skip) {
        // Logged so a "board says X needs a reply, task hub never got one"
        // report can be traced to a deliberate AI skip (this skill decided,
        // independently of the shared Board's own classifier, that no task
        // was needed) rather than looking like a silent bug.
        console.log('[task-hub] ' + skillKey + ' skipped', source, candidate.source_ref);
        return;
      }
      await upsertTask(userId, source, candidate.source_ref, extracted, candidate.first_seen_at, candidate.link,
        { reopenIfDone: source === 'whatsapp' });
    } catch (e) {
      console.warn('[task-hub] failed to triage', source, candidate.source_ref, e.message);
    }
  }

  await Promise.all(jobs);

  return {
    email: emailC.length, whatsapp: waC.length, monday: mondayCtx.count, manual: manualC.length,
    triaged: jobs.length
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

  var existingRows = await pool().query(
    "SELECT source_ref FROM unified_tasks WHERE user_id = $1 AND source = 'manual'",
    [userId]
  );
  var existingRefs = {};
  existingRows.rows.forEach(function (r) { existingRefs[r.source_ref] = true; });

  var jobs = manualC
    .filter(function (c) { return !existingRefs[c.source_ref]; })
    .map(function (c) { return runOneManual(c); });

  async function runOneManual(candidate) {
    try {
      var extracted = await runSkill('manual-task-extract', candidate.claudeInput);
      if (extracted.skip) return;
      await upsertTask(userId, 'manual', candidate.source_ref, extracted, candidate.first_seen_at, candidate.link);
    } catch (e) {
      console.warn('[task-hub] failed to triage manual', candidate.source_ref, e.message);
    }
  }

  await Promise.all(jobs);
  return { manual: manualC.length, triaged: jobs.length };
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
  var everyMs = Math.max(60, parseInt(process.env.TASK_HUB_SWEEP_INTERVAL_SECONDS || '300', 10)) * 1000;
  _sweepTimer = setInterval(sweepAllUsers, everyMs);
  if (_sweepTimer.unref) _sweepTimer.unref();
  console.log('[task-hub/sweep] armed: every ' + (everyMs / 1000) + 's');
  // Kick one off shortly after boot too, instead of waiting a full interval.
  setTimeout(sweepAllUsers, 15000);
}

module.exports = {
  refreshTasks, refreshManualTasks, listTasks, listAllTasks, listTeamRoster, addManualTask,
  patchTask, patchTaskAsAdmin, toggleTask, startServerSideSweep
};
