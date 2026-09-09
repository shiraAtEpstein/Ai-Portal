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
 * on user_id accordingly. Email is only needed for the Gmail/WhatsApp
 * source lookups below, resolved from userId via getUserEmail() —
 * TODO(wire): confirm the users table's real column names (guessed
 * `users(id, email)`, the natural shape for Google-only auth).
 */

var db = require('../db');

// ---------------------------------------------------------------------------
// Claude client — model is required via env, never guessed, so a stale
// hardcoded model id can't silently ship. Set TASK_HUB_MODEL to whatever
// model routes/chat.js already uses, for consistency.
// ---------------------------------------------------------------------------
var Anthropic = require('@anthropic-ai/sdk');
var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
var MODEL = process.env.TASK_HUB_MODEL;
if (!MODEL) {
  console.warn('[task-hub] TASK_HUB_MODEL is not set — set it to the same model ' +
    'routes/chat.js uses, in Render env vars. Skill calls will fail until it is set.');
}

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

// TODO(wire): verify against your real users table (columns/name).
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
  var model = skill.model || MODEL;
  if (!model) throw new Error('task-hub: no model configured (set TASK_HUB_MODEL)');
  var msg = await anthropic.messages.create({
    model: model,
    max_tokens: 500,
    system: skill.body_md,
    messages: [{ role: 'user', content: userContent }]
  });
  var text = (msg.content || []).map(function (b) { return b.text || ''; }).join('');
  var match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('task-hub: skill "' + key + '" did not return JSON: ' + text.slice(0, 200));
  return JSON.parse(match[0]);
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
  // searchMail takes the user's id (uuid), not their email — confirmed from
  // the "invalid input syntax for type uuid" error the email-string version
  // threw. It looks up that user's connected Gmail account internally.
  var results;
  try {
    results = await gmail.searchMail(userId, 'is:unread newer_than:14d -category:promotions', { max: 15 });
  } catch (e) {
    console.warn('[task-hub] gmail.searchMail failed for', userId, e.message);
    return [];
  }
  return (results || []).map(function (m) {
    return {
      source_ref: m.threadId || m.id,
      first_seen_at: m.date || m.internalDate || new Date().toISOString(),
      claudeInput: 'Subject: ' + (m.subject || '') + '\nFrom: ' + (m.from || '') +
        '\nSnippet/body: ' + (m.snippet || m.body || '')
    };
  });
}

async function fetchWhatsappCandidates(userEmail) {
  var waDb;
  try { waDb = require('../whatsapp/ingest/db'); }
  catch (e) { console.warn('[task-hub] whatsapp/ingest/db not found — skipping WhatsApp source:', e.message); return []; }

  var staffDir;
  try { staffDir = require('../config/staff-directory.json'); } catch (e) { staffDir = null; }
  var staffPhone = null;
  if (staffDir) {
    var entry = Object.keys(staffDir).map(function (k) { return staffDir[k]; })
      .find(function (s) { return s && s.email === userEmail; });
    staffPhone = entry && (entry.phone || entry.number);
  }
  if (!staffPhone) {
    console.warn('[task-hub] no phone found in config/staff-directory.json for', userEmail, '— skipping WhatsApp source');
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

  return (chats || []).map(function (c) {
    return {
      source_ref: c.chatId || c.chat_id || c.id,
      first_seen_at: c.oldestUnansweredAt || c.oldest_unanswered_at || new Date().toISOString(),
      claudeInput:
        'Chat: ' + (c.chatName || c.chat_name || c.chatId) + '\n' +
        'Unanswered block:\n' + JSON.stringify(c.unansweredMessages || c.block || c.messages || [], null, 2) +
        (activeVoiceRules ? ('\n\nFirm WhatsApp voice/rules knowledge:\n' + activeVoiceRules) : '')
    };
  });
}

async function fetchMondayCandidates(userEmail) {
  // TODO(wire): no confirmed monday read-access module found while building
  // this offline. board-triage-and-dashboard / staff-response already pull
  // monday data somehow in this repo — call that client here instead of a
  // new integration. Returns [] (safe no-op) until wired.
  return [];
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

  var results = await Promise.allSettled([
    fetchEmailCandidates(userId),
    fetchWhatsappCandidates(userEmail),
    fetchMondayCandidates(userEmail)
  ]);
  var emailC = results[0].status === 'fulfilled' ? results[0].value : [];
  var waC = results[1].status === 'fulfilled' ? results[1].value : [];
  var mondayC = results[2].status === 'fulfilled' ? results[2].value : [];

  var jobs = [];
  emailC.forEach(function (c) { jobs.push(runOne('email', 'email-triage', c)); });
  waC.forEach(function (c) { jobs.push(runOne('whatsapp', 'wa-triage', c)); });
  mondayC.forEach(function (c) { jobs.push(runOne('monday', 'monday-relevance', c)); });

  async function runOne(source, skillKey, candidate) {
    try {
      var extracted = await runSkill(skillKey, candidate.claudeInput);
      if (extracted.skip) return;
      await upsertTask(userId, source, candidate.source_ref, extracted, candidate.first_seen_at);
    } catch (e) {
      console.warn('[task-hub] failed to triage', source, candidate.source_ref, e.message);
    }
  }

  await Promise.all(jobs);
  return { email: emailC.length, whatsapp: waC.length, monday: mondayC.length };
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

module.exports = { refreshTasks, listTasks, addManualTask, patchTask, toggleTask };
