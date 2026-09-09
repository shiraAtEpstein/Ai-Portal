'use strict';

/**
 * Task Hub — aggregation + prioritization engine.
 *
 * Pulls open items for ONE signed-in user (per_user, not hardcoded to anyone)
 * from three sources — email, WhatsApp, monday — plus tasks the user typed
 * to LAWLY on WhatsApp, runs each through a DB-stored Claude prompt
 * (task_hub_skills, same idea as wa_skills for the WhatsApp agent) to get a
 * title/summary/estimate/priority, and stores the result in unified_tasks.
 *
 * INTEGRATION TODOs are marked below — I could not reach the live repo to
 * confirm exact export names, so this fails loudly with a clear message
 * instead of silently guessing wrong. Search for "TODO(wire)".
 */

// ---------------------------------------------------------------------------
// DB access — TODO(wire): confirm this matches your actual db module.
// Tries the two most common locations/shapes; adjust if neither fits.
// ---------------------------------------------------------------------------
let query;
(function resolveDb(){
  var candidates = ['../lib/db', '../db', './db'];
  var lastErr;
  for (var i = 0; i < candidates.length; i++) {
    try {
      var mod = require(candidates[i]);
      if (typeof mod.query === 'function') { query = mod.query.bind(mod); return; }
      if (mod.pool && typeof mod.pool.query === 'function') { query = mod.pool.query.bind(mod.pool); return; }
    } catch (e) { lastErr = e; }
  }
  throw new Error(
    'task-hub.js: could not find a Postgres query(sql, params) function. ' +
    'Edit the resolveDb() block at the top of lib/task-hub.js to point at your ' +
    'actual db/pool module (the one routes/daily.js uses for daily_directives).'
  );
})();

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

// ---------------------------------------------------------------------------
// Business-hours-aware aging (self-contained — mirrors the 08:00-22:00,
// Sun-Thu calendar documented for the WA aging feature. If you'd rather
// share lib/business-hours.js/lib/wait-label.js exactly, swap businessHoursElapsedMs
// below for a call into those instead.)
// ---------------------------------------------------------------------------
var TZ = process.env.FIRM_TZ || 'Asia/Jerusalem';
var BIZ_START_HOUR = 8, BIZ_END_HOUR = 22; // 08:00-22:00
var BIZ_DAYS = [0,1,2,3,4]; // Sun(0)-Thu(4); Fri/Sat excluded

function partsInTz(date) {
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false
  });
  var parts = fmt.formatToParts(date);
  var map = {};
  parts.forEach(function(p){ map[p.type] = p.value; });
  var dayIdx = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(map.weekday);
  return { day: dayIdx, hour: parseInt(map.hour, 10) % 24, minute: parseInt(map.minute, 10) };
}
// Business-hours-weighted elapsed time between two dates, in ms, walking hour by hour.
// Simple and cheap (task lists are small); fine for this feature's scale.
function businessHoursElapsedMs(fromDate, toDate) {
  var cursor = new Date(fromDate.getTime());
  var end = toDate.getTime();
  var STEP = 15 * 60 * 1000; // 15-minute steps
  var counted = 0;
  var guard = 0;
  while (cursor.getTime() < end && guard < 40000) { // guard: ~2 years of 15-min steps
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
// Skill runner — loads the active DB-stored prompt for `key` and asks Claude
// for one JSON object back.
// ---------------------------------------------------------------------------
async function getActiveSkill(key) {
  var res = await query(
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
  var text = (msg.content || []).map(function(b){ return b.text || ''; }).join('');
  var match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('task-hub: skill "' + key + '" did not return JSON: ' + text.slice(0, 200));
  return JSON.parse(match[0]);
}

// ---------------------------------------------------------------------------
// Sources — email + monday need one small wire-up each (TODO(wire) below);
// WhatsApp is grounded in the documented listUnansweredChats() shape.
// ---------------------------------------------------------------------------

async function fetchEmailCandidates(userEmail) {
  // TODO(wire): lib/gmail.js is documented (claude/portal-ops-notes.md) as
  // exporting at least searchMail(...) and createDraft(...) for the per-user
  // Gmail connection, but the exact argument shape wasn't confirmed against
  // the live file. Adjust the call below to match.
  var gmail;
  try { gmail = require('../lib/gmail'); }
  catch (e) { console.warn('[task-hub] lib/gmail not found — skipping email source:', e.message); return []; }
  if (typeof gmail.searchMail !== 'function') {
    console.warn('[task-hub] lib/gmail.searchMail not found — skipping email source');
    return [];
  }
  var query_ = 'is:unread newer_than:14d -category:promotions';
  var results;
  try {
    results = await gmail.searchMail(userEmail, query_, { max: 15 });
  } catch (e) {
    console.warn('[task-hub] gmail.searchMail failed for', userEmail, e.message);
    return [];
  }
  return (results || []).map(function(m){
    return {
      source_ref: m.threadId || m.id,
      first_seen_at: m.date || m.internalDate || new Date().toISOString(),
      claudeInput: 'Subject: ' + (m.subject || '') + '\nFrom: ' + (m.from || '') +
        '\nSnippet/body: ' + (m.snippet || m.body || '')
    };
  });
}

async function fetchWhatsappCandidates(userEmail) {
  var db;
  try { db = require('../whatsapp/ingest/db'); }
  catch (e) { console.warn('[task-hub] whatsapp/ingest/db not found — skipping WhatsApp source:', e.message); return []; }

  var staffDir;
  try { staffDir = require('../config/staff-directory.json'); } catch (e) { staffDir = null; }
  var staffPhone = null;
  if (staffDir) {
    var entry = Object.keys(staffDir).map(function(k){ return staffDir[k]; })
      .find(function(s){ return s && s.email === userEmail; });
    staffPhone = entry && (entry.phone || entry.number);
  }
  if (!staffPhone) {
    console.warn('[task-hub] no phone found in config/staff-directory.json for', userEmail, '— skipping WhatsApp source');
    return [];
  }

  var chats = await db.listUnansweredChats({ hours: 0, staffPhones: [staffPhone] });

  // Ground urgency in the firm's own WA knowledge, same as the response agent.
  var activeVoiceRules = '';
  try {
    var skillsRes = await query(
      "SELECT s.body_md FROM wa_skill_active a JOIN wa_skills s ON s.id = a.skill_id " +
      "WHERE a.key IN ('voice','rules')"
    );
    activeVoiceRules = skillsRes.rows.map(function(r){ return r.body_md; }).join('\n\n');
  } catch (e) {
    console.warn('[task-hub] could not read wa_skills for grounding (non-fatal):', e.message);
  }

  return (chats || []).map(function(c){
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
  // TODO(wire): no confirmed monday read-access module was found while
  // building this offline. board-triage-and-dashboard / staff-response
  // already pull monday data somehow in this repo — find and call that
  // client here instead of a new integration. Returns [] (safe no-op)
  // until wired, so the rest of the feature works without it.
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function upsertTask(userEmail, source, sourceRef, extracted, firstSeenAt) {
  await query(
    `INSERT INTO unified_tasks (user_email, source, source_ref, title, summary, estimated_minutes, priority, first_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_email, source, source_ref) DO UPDATE SET
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       estimated_minutes = EXCLUDED.estimated_minutes,
       priority = CASE WHEN unified_tasks.priority_overridden_by_user THEN unified_tasks.priority ELSE EXCLUDED.priority END,
       updated_at = now()
     WHERE unified_tasks.status = 'open'`,
    [userEmail, source, sourceRef, extracted.title, extracted.summary || null,
     extracted.estimated_minutes || null, extracted.priority || 'normal', firstSeenAt]
  );
}

async function refreshTasks(userEmail) {
  var results = await Promise.allSettled([
    fetchEmailCandidates(userEmail),
    fetchWhatsappCandidates(userEmail),
    fetchMondayCandidates(userEmail)
  ]);
  var [emailC, waC, mondayC] = results.map(function(r){ return r.status === 'fulfilled' ? r.value : []; });

  var jobs = [];
  emailC.forEach(function(c){ jobs.push(runOne('email', 'email-triage', c)); });
  waC.forEach(function(c){ jobs.push(runOne('whatsapp', 'wa-triage', c)); });
  mondayC.forEach(function(c){ jobs.push(runOne('monday', 'monday-relevance', c)); });

  async function runOne(source, skillKey, candidate) {
    try {
      var extracted = await runSkill(skillKey, candidate.claudeInput);
      if (extracted.skip) return;
      await upsertTask(userEmail, source, candidate.source_ref, extracted, candidate.first_seen_at);
    } catch (e) {
      console.warn('[task-hub] failed to triage', source, candidate.source_ref, e.message);
    }
  }

  await Promise.all(jobs);
  return { email: emailC.length, whatsapp: waC.length, monday: mondayC.length };
}

async function listTasks(userEmail) {
  var res = await query(
    `SELECT * FROM unified_tasks WHERE user_email = $1 AND status = 'open' ORDER BY first_seen_at ASC`,
    [userEmail]
  );
  return res.rows.map(function(row){
    var eff = effectivePriority(row);
    return Object.assign({}, row, {
      effective_priority: eff,
      escalated: !row.priority_overridden_by_user && eff !== row.priority
    });
  }).sort(function(a, b){
    var pd = PORDER[a.effective_priority] - PORDER[b.effective_priority];
    if (pd !== 0) return pd;
    return new Date(a.first_seen_at) - new Date(b.first_seen_at);
  });
}

async function addManualTask(userEmail, text) {
  var extracted = await runSkill('manual-task-extract', text);
  var sourceRef = 'manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  await query(
    `INSERT INTO unified_tasks (user_email, source, source_ref, title, estimated_minutes, priority, first_seen_at)
     VALUES ($1,'manual',$2,$3,$4,$5, now())`,
    [userEmail, sourceRef, extracted.title, extracted.estimated_minutes || 15, extracted.priority || 'normal']
  );
  var res = await query(
    `SELECT * FROM unified_tasks WHERE user_email = $1 AND source_ref = $2`,
    [userEmail, sourceRef]
  );
  return res.rows[0];
}

async function patchTask(userEmail, id, fields) {
  var sets = [], vals = [userEmail, id];
  var overrodePriority = false;
  if (typeof fields.title === 'string' && fields.title.trim()) {
    vals.push(fields.title.trim()); sets.push('title = $' + vals.length);
  }
  if (Number.isFinite(fields.estimated_minutes)) {
    vals.push(fields.estimated_minutes); sets.push('estimated_minutes = $' + vals.length);
  }
  if (typeof fields.priority === 'string' && PORDER.hasOwnProperty(fields.priority)) {
    vals.push(fields.priority); sets.push('priority = $' + vals.length);
    sets.push('priority_overridden_by_user = true');
    overrodePriority = true;
  }
  if (!sets.length) return null;
  sets.push('updated_at = now()');
  var res = await query(
    `UPDATE unified_tasks SET ${sets.join(', ')} WHERE user_email = $1 AND id = $2 RETURNING *`,
    vals
  );
  return res.rows[0] || null;
}

async function toggleTask(userEmail, id) {
  var res = await query(
    `UPDATE unified_tasks
     SET status = CASE WHEN status = 'open' THEN 'done' ELSE 'open' END,
         done_at = CASE WHEN status = 'open' THEN now() ELSE NULL END,
         updated_at = now()
     WHERE user_email = $1 AND id = $2 RETURNING *`,
    [userEmail, id]
  );
  return res.rows[0] || null;
}

module.exports = { refreshTasks, listTasks, addManualTask, patchTask, toggleTask };
