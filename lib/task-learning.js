// ============================================================
// lib/task-learning.js — סוכן לכל סוג משימה + יומן למידה (8 Oct 2026, Shira).
//
// THE AGENT CARD (task_hub_agents, one row per task type, edited on
// /task-agents.html — no deploy): goal, rules (the old playbook), which
// sources to read, tone. Key '*' is the general agent, used when a type has
// no card of its own (e.g. 'other').
//
// THE LEARNING LOG:
//   - "משהו לא נכון" on a suggestion -> a feedback row (kind 'note') at once,
//     no AI. It is used AT ONCE for this same task ("הצעה חדשה"). With
//     "לזכור גם למשימות הבאות" it also becomes a PROPOSED lesson at once.
//   - every TASK_LEARNING_EVERY_HOURS (default 48 — Shira: "פעם ביומיים"):
//       1. compare: for each suggestion with a draft, find what was really
//          sent after it (the email thread / the WhatsApp chat). No AI: a
//          word-similarity score -> sent_as_is (a good example) / edited /
//          rewritten / not_sent.
//       2. learn: the edited / rewritten ones and the new staff notes, per
//          task type, go to ONE AI call that writes a SPECIFIC note per case
//          (what changed, what kind of change) and proposes general lessons
//          (no names, no amounts) — or says it is the same as an existing one.
//   - a proposed lesson does NOTHING until an admin approves it
//     (TASK_LEARNING_APPROVERS can narrow that to named people). Approved lessons go into every
//     suggestion of that type.
// ============================================================
'use strict';

var db = require('../db');
var claude = require('./claude');

function pool() {
  var p = db.getPool();
  if (!p) throw new Error('task-learning: database not ready');
  return p;
}

var CATEGORIES = {
  action: 'פעולה לא נכונה',
  fact: 'עובדה שגויה',
  missing: 'חסר מידע',
  tone: 'טון / ניסוח',
  recipient: 'נמען שגוי',
  type: 'סוג משימה שגוי',
  length: 'אורך',
  new_info: 'מידע חדש שלא היה ל־AI',
  personal_style: 'סגנון אישי',
  other: 'אחר'
};
var SOURCES = ['monday', 'payments', 'deal_group', 'answer_bank', 'office_process', 'auto_emails', 'firm_notes', 'examples'];

var _ready = null;
function ensureTables() {
  if (_ready) return _ready;
  var p = pool();
  _ready = p.query(
    'CREATE TABLE IF NOT EXISTS task_hub_agents (' +
    '  key text PRIMARY KEY,' +             // task type key, or '*' = the general agent
    '  name_he text,' +
    '  goal_md text,' +
    '  rules_md text,' +
    '  sources text[],' +                   // NULL = the default set
    '  tone_md text,' +
    '  active boolean NOT NULL DEFAULT true,' +
    '  updated_by text,' +
    '  updated_at timestamptz NOT NULL DEFAULT now()' +
    ')'
  ).then(function () {
    return p.query(
      'CREATE TABLE IF NOT EXISTS task_hub_lessons (' +
      '  id serial PRIMARY KEY,' +
      "  task_type text NOT NULL DEFAULT '*'," +
      '  text_he text NOT NULL,' +
      "  status text NOT NULL DEFAULT 'proposed'," +   // proposed | approved | rejected | retired
      '  origin text,' +                                // staff_note | learning
      '  evidence integer[] NOT NULL DEFAULT ARRAY[]::integer[],' +
      '  support_count integer NOT NULL DEFAULT 1,' +
      '  proposed_by text,' +
      '  decided_by text,' +
      '  decided_at timestamptz,' +
      '  uses_count integer NOT NULL DEFAULT 0,' +
      '  last_used_at timestamptz,' +
      '  created_at timestamptz NOT NULL DEFAULT now()' +
      ')');
  }).then(function () {
    return p.query(
      'CREATE TABLE IF NOT EXISTS task_hub_feedback (' +
      '  id serial PRIMARY KEY,' +
      '  task_id integer NOT NULL,' +
      '  task_type text,' +
      '  kind text NOT NULL,' +              // note | compare
      '  categories text[],' +
      '  note_text text,' +                  // the staff note, or the AI's "what changed"
      '  suggested jsonb,' +                 // the suggestion as it was
      '  sent_text text,' +                  // what was really sent (compare)
      '  similarity real,' +
      '  outcome text,' +                    // sent_as_is | edited | rewritten | not_sent
      '  remember boolean NOT NULL DEFAULT false,' +
      '  author text,' +
      "  status text NOT NULL DEFAULT 'new'," +   // new | processed
      '  lesson_id integer,' +
      '  created_at timestamptz NOT NULL DEFAULT now()' +
      ')');
  }).then(function () {
    return p.query('CREATE INDEX IF NOT EXISTS task_hub_feedback_task_idx ON task_hub_feedback (task_id)');
  }).then(function () {
    return p.query('CREATE TABLE IF NOT EXISTS task_hub_learning_state (id integer PRIMARY KEY, last_run timestamptz, last_result text)');
  }).then(function () {
    return p.query('INSERT INTO task_hub_learning_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  }).catch(function (e) { _ready = null; throw e; });
  return _ready;
}

function clip(s, n) { s = String(s || '').replace(/\r/g, ''); return s.length > n ? s.slice(0, n) + '…' : s; }

// ---------- who may approve ----------
// 8 Oct (Shira): every admin can approve lessons and edit cards. The routes are
// admin-only already. TASK_LEARNING_APPROVERS (comma-separated emails) narrows
// it to those people, if it is ever set.
function approvers() {
  return String(process.env.TASK_LEARNING_APPROVERS || '')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}
function canApprove(email, isAdmin) {
  var list = approvers();
  if (!list.length) return !!isAdmin;
  return list.indexOf(String(email || '').toLowerCase()) !== -1;
}

// ---------- the agent card ----------
// The card for this type, else the general '*' card, else null.
async function loadAgent(taskType) {
  await ensureTables();
  var r = (await pool().query(
    "SELECT * FROM task_hub_agents WHERE active AND key = ANY($1) ORDER BY (key = '*')",
    [[String(taskType || ''), '*']])).rows;
  return r[0] || null;
}

// What the suggestion AI reads from the learning side, as labelled parts.
async function learningContext(task, agentKey) {
  await ensureTables();
  var parts = [], used = [];
  var type = String(task.task_type || '');
  // 1. notes on THIS task — used at once, no approval needed
  try {
    var notes = (await pool().query(
      "SELECT categories, note_text, author, created_at FROM task_hub_feedback WHERE task_id = $1 AND kind = 'note' ORDER BY created_at",
      [task.id])).rows;
    if (notes.length) {
      parts.push('## Staff notes on earlier suggestions for THIS task (follow them — they override the rules below where they conflict)\n' +
        notes.map(function (n) {
          var cats = (n.categories || []).map(function (c) { return CATEGORIES[c] || c; }).join(', ');
          return '- ' + (cats ? '[' + cats + '] ' : '') + clip(n.note_text, 600);
        }).join('\n'));
      used.push('task_notes');
    }
  } catch (e) { /* none */ }
  // 2. approved lessons for this type and for all types
  try {
    var ls = (await pool().query(
      "SELECT id, task_type, text_he FROM task_hub_lessons WHERE status = 'approved' AND task_type = ANY($1) " +
      "ORDER BY (task_type = '*'), support_count DESC, decided_at DESC LIMIT 12", [[type, '*']])).rows;
    if (ls.length) {
      parts.push('## Approved lessons from past suggestions (follow them)\n' + clip(ls.map(function (l) { return '- ' + l.text_he; }).join('\n'), 2200));
      used.push('lessons');
      pool().query('UPDATE task_hub_lessons SET uses_count = uses_count + 1, last_used_at = now() WHERE id = ANY($1)', [ls.map(function (l) { return l.id; })]).catch(function () {});
    }
  } catch (e) { /* none */ }
  return { parts: parts, used: used };
}

// Up to 2 drafts of this type that were sent almost unchanged — style only.
async function goodExamples(taskType, excludeTaskId) {
  await ensureTables();
  var r = (await pool().query(
    "SELECT sent_text FROM task_hub_feedback WHERE kind = 'compare' AND outcome = 'sent_as_is' AND task_type = $1 AND task_id <> $2 " +
    'AND sent_text IS NOT NULL ORDER BY created_at DESC LIMIT 2', [String(taskType || ''), excludeTaskId || 0])).rows;
  return r.map(function (x) { return clip(x.sent_text, 700); });
}

// ---------- "משהו לא נכון" ----------
async function reportIssue(task, suggestionRow, input) {
  await ensureTables();
  var cats = (Array.isArray(input.categories) ? input.categories : []).map(String).filter(function (c) { return CATEGORIES[c]; }).slice(0, 5);
  var text = String(input.note || '').trim().slice(0, 2000);
  if (!text) return { ok: false, status: 400, error: 'צריך לכתוב מה לא נכון' };
  var remember = !!input.remember;
  var fb = (await pool().query(
    `INSERT INTO task_hub_feedback (task_id, task_type, kind, categories, note_text, suggested, remember, author, status)
     VALUES ($1, $2, 'note', $3, $4, $5, $6, $7, $8) RETURNING id`,
    [task.id, task.task_type || null, cats, text, suggestionRow ? JSON.stringify(suggestionRow.suggestion) : null,
     remember, input.by || null, remember ? 'processed' : 'new'])).rows[0];
  var lessonId = null;
  if (remember) {
    lessonId = (await pool().query(
      `INSERT INTO task_hub_lessons (task_type, text_he, status, origin, evidence, proposed_by)
       VALUES ($1, $2, 'proposed', 'staff_note', $3, $4) RETURNING id`,
      [task.task_type || '*', text, [fb.id], input.by || null])).rows[0].id;
    await pool().query('UPDATE task_hub_feedback SET lesson_id = $2 WHERE id = $1', [fb.id, lessonId]);
  }
  console.log('[task-learning] note on task', task.id, remember ? '-> proposed lesson ' + lessonId : '(this task only)');
  return { ok: true, id: fb.id, lessonId: lessonId };
}

async function notesForTask(taskId) {
  await ensureTables();
  return (await pool().query(
    "SELECT id, categories, note_text, remember, author, created_at FROM task_hub_feedback WHERE task_id = $1 AND kind = 'note' ORDER BY created_at",
    [taskId])).rows;
}

// ---------- similarity (no AI) ----------
function wordsOf(s) {
  return String(s || '').toLowerCase().replace(/[֑-ׇ]/g, '').split(/[^0-9a-zא-ת]+/).filter(function (w) { return w.length >= 2; });
}
// Dice on word bags: 1 = same words, 0 = nothing in common.
function similarity(a, b) {
  var A = wordsOf(a), B = wordsOf(b);
  if (!A.length || !B.length) return 0;
  var m = {}; A.forEach(function (w) { m[w] = (m[w] || 0) + 1; });
  var common = 0; B.forEach(function (w) { if (m[w]) { common++; m[w]--; } });
  return (2 * common) / (A.length + B.length);
}
function outcomeOf(sim) { return sim >= 0.85 ? 'sent_as_is' : sim >= 0.4 ? 'edited' : 'rewritten'; }

// ---------- what was really sent after the suggestion ----------
async function sentAfter(task, since) {
  var sinceMs = new Date(since).getTime();
  if (task.source === 'email' && task.thread_id) {
    var gmail = require('./gmail');
    var msgs = await gmail.getThreadTexts(task.user_id, task.thread_id, 12, 3000);
    var mine = (msgs || []).filter(function (m) { return m.at > sinceMs && /@epsteinlaw\.co\.il/i.test(m.from || ''); })
      .sort(function (a, b) { return a.at - b.at; })[0];
    return mine ? { text: mine.text || '', at: mine.at } : null;
  }
  if (task.source === 'whatsapp' && task.source_ref) {
    var rows = (await pool().query(
      `SELECT payload_encrypted, COALESCE(sent_at, created_at) AS at FROM processing_jobs
        WHERE chat_jid = $1 AND deleted_at IS NULL AND (direction = 'out' OR sender_staff_phone9 IS NOT NULL)
          AND COALESCE(sent_at, created_at) > $2
        ORDER BY COALESCE(sent_at, created_at) LIMIT 6`, [task.source_ref, new Date(sinceMs).toISOString()])).rows;
    if (!rows.length) return null;
    var first = new Date(rows[0].at).getTime();
    var dec = require('./task-suggest')._waMessage;
    var text = rows.filter(function (r) { return new Date(r.at).getTime() - first <= 10 * 60e3; })
      .map(function (r) { return dec(r).text; }).filter(Boolean).join('\n');
    return text ? { text: text, at: first } : null;
  }
  return null;
}

// Step 1 — compare. Returns how many of each outcome.
async function comparePass(opts) {
  opts = opts || {};
  await ensureTables();
  await require('./task-suggest')._ensureTable();
  var counts = { sent_as_is: 0, edited: 0, rewritten: 0, not_sent: 0, waiting: 0, failed: 0 };
  var rows = (await pool().query(
    `SELECT s.task_id, s.suggestion, s.created_at, s.agent_key, t.*
       FROM task_hub_suggestions s JOIN unified_tasks t ON t.id = s.task_id
      WHERE s.compared_at IS NULL AND s.suggestion->'draft' IS NOT NULL AND jsonb_typeof(s.suggestion->'draft') = 'object'
        AND s.created_at < now() - interval '1 hour'
      ORDER BY s.created_at LIMIT $1`, [opts.limit || 60])).rows;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var draft = (r.suggestion && r.suggestion.draft) || {};
    try {
      var sent = await sentAfter(r, r.created_at);
      var ageDays = (Date.now() - new Date(r.created_at).getTime()) / 864e5;
      if (!sent) {
        if (r.status === 'done' || ageDays > 14) {
          await pool().query(
            `INSERT INTO task_hub_feedback (task_id, task_type, kind, suggested, outcome, status) VALUES ($1, $2, 'compare', $3, 'not_sent', 'processed')`,
            [r.task_id, r.task_type || null, JSON.stringify(r.suggestion)]);
          await pool().query('UPDATE task_hub_suggestions SET compared_at = now() WHERE task_id = $1', [r.task_id]);
          counts.not_sent++;
        } else counts.waiting++;
        continue;
      }
      var sim = similarity(draft.body, sent.text);
      var out = outcomeOf(sim);
      await pool().query(
        `INSERT INTO task_hub_feedback (task_id, task_type, kind, suggested, sent_text, similarity, outcome, status)
         VALUES ($1, $2, 'compare', $3, $4, $5, $6, $7)`,
        [r.task_id, r.task_type || null, JSON.stringify(r.suggestion), clip(sent.text, 4000), Math.round(sim * 100) / 100, out,
         out === 'sent_as_is' ? 'processed' : 'new']);
      await pool().query('UPDATE task_hub_suggestions SET compared_at = now() WHERE task_id = $1', [r.task_id]);
      counts[out]++;
    } catch (e) {
      counts.failed++;
      console.warn('[task-learning] compare failed for task', r.task_id, e.message);
    }
  }
  return counts;
}

// Step 2 — learn: one AI call per task type.
var LEARN_SYSTEM = [
  'You review how staff of Epstein & Co. (an Israeli real-estate and wills law firm) used the AI\'s suggestions for one TYPE of task, so the AI can do better next time.',
  'Each case is either a COMPARE (the AI\'s suggested draft vs. what staff really sent) or a NOTE (a staff member said what was wrong with a suggestion).',
  'For every case write a SPECIFIC note in Hebrew: exactly what changed or what was wrong (e.g. "הוסר המשפט שמבטיח העברה תוך 3 ימים", "נוסף מספר חשבון מהשובר", "הפנייה הייתה לקבלן ולא ללקוח"). Never a score, never "the draft was improved".',
  'category, one of: action (wrong next step), fact (wrong fact), missing (missing information), tone, recipient, length, type (wrong task type), new_info (staff had information the AI did not have - nothing to learn), personal_style (just a different wording - nothing to learn), other.',
  'Then propose LESSONS: short general rules in Hebrew that would have made the suggestion right, for future tasks of this type. A lesson must be general: NO client names, NO amounts, NO dates, NO apartment numbers. Propose a lesson only when the change is a real rule, not new_info or personal_style. If an existing lesson already says it, return its id in same_as instead of a new text.',
  'If what was sent is clearly not an answer to this task (an unrelated or automatic email), say so in what_changed, category other, and no lesson.',
  'Return ONLY JSON:',
  '{ "cases": [ { "id": <case id>, "what_changed": "Hebrew, specific", "category": "...", "lesson": "Hebrew rule or null", "same_as": <existing lesson id or null> } ] }'
].join('\n');

async function learnPass(opts) {
  opts = opts || {};
  await ensureTables();
  var res = { types: 0, cases: 0, proposed: 0, supported: 0 };
  if (!claude.isConfigured()) return res;
  var types = (await pool().query("SELECT DISTINCT COALESCE(task_type, '*') AS t FROM task_hub_feedback WHERE status = 'new'")).rows.map(function (x) { return x.t; });
  for (var ti = 0; ti < types.length; ti++) {
    var type = types[ti];
    var cases = (await pool().query(
      "SELECT f.*, t.title FROM task_hub_feedback f LEFT JOIN unified_tasks t ON t.id = f.task_id " +
      "WHERE f.status = 'new' AND COALESCE(f.task_type, '*') = $1 ORDER BY f.created_at LIMIT 15", [type])).rows;
    if (!cases.length) continue;
    var lessons = (await pool().query(
      "SELECT id, text_he, status FROM task_hub_lessons WHERE task_type = ANY($1) AND status IN ('approved','proposed') ORDER BY id",
      [[type, '*']])).rows;
    var agent = await loadAgent(type === '*' ? '' : type);
    var user = [
      '## Task type: ' + type + (agent && agent.name_he ? ' — ' + agent.name_he : ''),
      agent && agent.rules_md ? '## The rules the AI already follows for this type\n' + clip(agent.rules_md, 2500) : '',
      lessons.length ? '## Existing lessons (id: text)\n' + lessons.map(function (l) { return l.id + ': ' + l.text_he + (l.status === 'proposed' ? ' (waiting for approval)' : ''); }).join('\n') : '## Existing lessons: none',
      '## Cases',
      cases.map(function (c) {
        var s = c.suggested || {};
        var d = s.draft || {};
        var head = '### case ' + c.id + ' — ' + c.kind.toUpperCase() + ' — task: ' + clip(c.title, 140);
        if (c.kind === 'note') {
          return head + '\nAI next step: ' + clip(s.next_step, 400) + (d.body ? '\nAI draft:\n' + clip(d.body, 1000) : '') +
            '\nStaff note' + ((c.categories || []).length ? ' [' + c.categories.join(', ') + ']' : '') + ': ' + clip(c.note_text, 800);
        }
        return head + ' — similarity ' + c.similarity + '\nAI next step: ' + clip(s.next_step, 400) +
          '\nAI draft:\n' + clip(d.body, 1200) + '\nWhat staff really sent:\n' + clip(c.sent_text, 1200);
      }).join('\n\n')
    ].filter(Boolean).join('\n\n');
    var out = await claude.askJSON({ system: LEARN_SYSTEM, user: user, model: process.env.TASK_LEARNING_MODEL || undefined, maxTokens: 2500 });
    var list = out && Array.isArray(out.cases) ? out.cases : null;
    if (!list) { console.warn('[task-learning] learn: no answer for type', type); continue; }
    res.types++;
    var byId = {}; cases.forEach(function (c) { byId[c.id] = c; });
    var lessonIds = {}; lessons.forEach(function (l) { lessonIds[l.id] = true; });
    for (var ci = 0; ci < list.length; ci++) {
      var x = list[ci] || {};
      var c = byId[parseInt(x.id, 10)];
      if (!c) continue;
      res.cases++;
      var cat = CATEGORIES[x.category] ? x.category : 'other';
      var what = clip(x.what_changed, 800);
      var lessonId = null;
      var same = parseInt(x.same_as, 10);
      if (same && lessonIds[same]) {
        await pool().query('UPDATE task_hub_lessons SET support_count = support_count + 1, evidence = array_append(evidence, $2) WHERE id = $1', [same, c.id]);
        lessonId = same; res.supported++;
      } else if (x.lesson && String(x.lesson).trim() && cat !== 'new_info' && cat !== 'personal_style') {
        lessonId = (await pool().query(
          `INSERT INTO task_hub_lessons (task_type, text_he, status, origin, evidence, proposed_by)
           VALUES ($1, $2, 'proposed', 'learning', $3, 'AI') RETURNING id`, [type, clip(x.lesson, 500), [c.id]])).rows[0].id;
        lessonIds[lessonId] = true; res.proposed++;
      }
      if (c.kind === 'compare') {
        await pool().query("UPDATE task_hub_feedback SET note_text = $2, categories = $3, status = 'processed', lesson_id = $4 WHERE id = $1", [c.id, what, [cat], lessonId]);
      } else {
        // a staff note keeps the person's own words; the AI's reading is added
        await pool().query("UPDATE task_hub_feedback SET status = 'processed', lesson_id = $2 WHERE id = $1", [c.id, lessonId]);
      }
    }
    // a case the AI skipped is not asked again forever
    await pool().query("UPDATE task_hub_feedback SET status = 'processed' WHERE id = ANY($1) AND status = 'new'", [cases.map(function (c) { return c.id; })]);
  }
  return res;
}

async function runNow(by) {
  var c = await comparePass();
  var l = await learnPass();
  var summary = 'השוואה: ' + c.sent_as_is + ' נשלחו כמו שהן, ' + c.edited + ' נערכו, ' + c.rewritten + ' נכתבו מחדש, ' + c.not_sent + ' לא נשלחו, ' +
    c.waiting + ' ממתינות | למידה: ' + l.cases + ' מקרים, ' + l.proposed + ' לקחים חדשים לאישור, ' + l.supported + ' חיזוקים ללקחים קיימים';
  await pool().query('UPDATE task_hub_learning_state SET last_run = now(), last_result = $1 WHERE id = 1', [summary + (by ? ' (' + by + ')' : '')]);
  console.log('[task-learning] ' + summary);
  return { compare: c, learn: l, summary: summary };
}

// Every TASK_LEARNING_EVERY_HOURS (48). Claimed in the DB, so a restart or a
// second server never runs it twice. Checked once an hour.
var _timer = null, _running = false;
function start() {
  if (_timer || /^(0|false|off)$/i.test(process.env.TASK_LEARNING_ENABLED || '')) return;
  var hours = Math.max(6, parseInt(process.env.TASK_LEARNING_EVERY_HOURS || '48', 10) || 48);
  var tick = async function () {
    if (_running) return;
    _running = true;
    try {
      await ensureTables();
      var claim = (await pool().query(
        "UPDATE task_hub_learning_state SET last_run = now() WHERE id = 1 AND (last_run IS NULL OR last_run < now() - ($1 || ' hours')::interval) RETURNING id",
        [String(hours)])).rows[0];
      if (claim) await runNow('auto');
    } catch (e) { console.warn('[task-learning] run failed:', e.message); }
    _running = false;
  };
  setTimeout(tick, 5 * 60e3).unref();
  _timer = setInterval(tick, 60 * 60e3);
  if (_timer.unref) _timer.unref();
  console.log('[task-learning] armed: every ' + hours + 'h');
}

// ---------- admin screen ----------
async function listAgents() {
  await ensureTables();
  var types = [];
  try { types = (await pool().query('SELECT key, name_he, name_en FROM task_hub_types WHERE active ORDER BY key')).rows; } catch (e) { /* none */ }
  var cards = (await pool().query('SELECT * FROM task_hub_agents')).rows;
  var counts = (await pool().query(
    "SELECT task_type, count(*) FILTER (WHERE status = 'approved') AS approved, count(*) FILTER (WHERE status = 'proposed') AS proposed FROM task_hub_lessons GROUP BY task_type")).rows;
  var pbs = [];
  try { pbs = (await pool().query('SELECT key FROM task_hub_playbooks WHERE active')).rows.map(function (x) { return x.key; }); } catch (e) { /* none */ }
  var byKey = {}; cards.forEach(function (c) { byKey[c.key] = c; });
  var cnt = {}; counts.forEach(function (c) { cnt[c.task_type] = { approved: +c.approved, proposed: +c.proposed }; });
  var keys = ['*'].concat(types.map(function (t) { return t.key; }));
  cards.forEach(function (c) { if (keys.indexOf(c.key) === -1) keys.push(c.key); });
  var tname = {}; types.forEach(function (t) { tname[t.key] = t.name_he || t.name_en || t.key; });
  return keys.map(function (k) {
    return { key: k, type_name: k === '*' ? 'סוכן כללי (כשאין כרטיס לסוג)' : (tname[k] || k), card: byKey[k] || null,
      has_old_playbook: pbs.indexOf(k) !== -1, lessons: cnt[k] || { approved: 0, proposed: 0 } };
  });
}

async function saveAgent(key, input, by) {
  await ensureTables();
  key = String(key || '').trim();
  if (!key) return { ok: false, error: 'no key' };
  var sources = Array.isArray(input.sources) ? input.sources.filter(function (s) { return SOURCES.indexOf(s) !== -1; }) : null;
  await pool().query(
    `INSERT INTO task_hub_agents (key, name_he, goal_md, rules_md, sources, tone_md, active, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (key) DO UPDATE SET name_he = EXCLUDED.name_he, goal_md = EXCLUDED.goal_md, rules_md = EXCLUDED.rules_md,
       sources = EXCLUDED.sources, tone_md = EXCLUDED.tone_md, active = EXCLUDED.active, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, clip(input.name_he, 120) || null, clip(input.goal_md, 2000) || null, clip(input.rules_md, 8000) || null,
     sources, clip(input.tone_md, 2000) || null, input.active !== false, by || null]);
  return { ok: true };
}

async function listLessons(status) {
  await ensureTables();
  var rows = (await pool().query(
    'SELECT * FROM task_hub_lessons WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 300', [status || null])).rows;
  var ev = [];
  rows.forEach(function (r) { (r.evidence || []).forEach(function (id) { if (ev.indexOf(id) === -1) ev.push(id); }); });
  var evRows = ev.length ? (await pool().query(
    'SELECT f.id, f.task_id, f.kind, f.categories, f.note_text, f.outcome, f.similarity, f.author, f.created_at, t.title FROM task_hub_feedback f LEFT JOIN unified_tasks t ON t.id = f.task_id WHERE f.id = ANY($1)', [ev])).rows : [];
  var byId = {}; evRows.forEach(function (e) { byId[e.id] = e; });
  return rows.map(function (r) { r.evidence_rows = (r.evidence || []).map(function (id) { return byId[id]; }).filter(Boolean); return r; });
}

async function decideLesson(id, action, input, by) {
  await ensureTables();
  var map = { approve: 'approved', reject: 'rejected', retire: 'retired', reopen: 'proposed' };
  var st = map[action];
  if (!st) return { ok: false, error: 'bad action' };
  var text = input && typeof input.text_he === 'string' && input.text_he.trim() ? clip(input.text_he.trim(), 500) : null;
  var type = input && typeof input.task_type === 'string' && input.task_type.trim() ? input.task_type.trim() : null;
  var r = await pool().query(
    'UPDATE task_hub_lessons SET status = $2, text_he = COALESCE($3, text_he), task_type = COALESCE($4, task_type), decided_by = $5, decided_at = now() WHERE id = $1',
    [id, st, text, type, by || null]);
  return { ok: r.rowCount === 1 };
}

async function listFeedback(limit) {
  await ensureTables();
  return (await pool().query(
    'SELECT f.id, f.task_id, f.task_type, f.kind, f.categories, f.note_text, f.outcome, f.similarity, f.remember, f.author, f.status, f.lesson_id, f.created_at, ' +
    "f.suggested->'draft'->>'body' AS draft_body, f.sent_text, t.title FROM task_hub_feedback f LEFT JOIN unified_tasks t ON t.id = f.task_id ORDER BY f.created_at DESC LIMIT $1",
    [Math.min(parseInt(limit, 10) || 100, 300)])).rows;
}

async function state() {
  await ensureTables();
  var s = (await pool().query('SELECT last_run, last_result FROM task_hub_learning_state WHERE id = 1')).rows[0] || {};
  return { last_run: s.last_run || null, last_result: s.last_result || null, every_hours: Math.max(6, parseInt(process.env.TASK_LEARNING_EVERY_HOURS || '48', 10) || 48) };
}

module.exports = {
  ensureTables, loadAgent, learningContext, goodExamples, reportIssue, notesForTask,
  comparePass, learnPass, runNow, start, listAgents, saveAgent, listLessons, decideLesson, listFeedback, state,
  canApprove, approvers, similarity, outcomeOf, CATEGORIES, SOURCES
};
