// ============================================================
// lib/task-suggest.js — "הצעה לביצוע" (7 Oct 2026, Shira).
//
// For one open task: what to do now, and — when the task is to answer or send
// something — a draft reply. Staff always read, edit and send it themselves;
// nothing here sends anything.
//
// Made ONLY when someone opens the task's details, then saved
// (task_hub_suggestions) and shown from the table every time after — one AI
// call per task. A new one is made only when someone presses "הצעה חדשה".
//
// What the AI sees (each part optional, each failure just leaves it out):
//   - the task itself (title, summary, sender / group, deal names, type)
//   - the message the task came from: the email's new text, or the last
//     WhatsApp messages in the chat
//   - what the firm already sent on it: staff emails to the people / deal, and
//     the deal's WhatsApp group (last messages)
//   - the deal's monday fields (filled-in columns only)
//   - approved Answer Bank entries that match (status 'active' only)
//   - office processes that match (office_processes table, if it exists)
//   - the firm's voice / rules (wa_skills 'voice', 'rules') for the draft
// Nothing is stored except the suggestion itself.
// ============================================================
'use strict';

var db = require('../db');
var claude = require('./claude');

function pool() {
  var p = db.getPool();
  if (!p) throw new Error('task-suggest: database not ready');
  return p;
}

var _ready = null;
function ensureTable() {
  if (_ready) return _ready;
  _ready = pool().query(
    'CREATE TABLE IF NOT EXISTS task_hub_suggestions (' +
    '  task_id integer PRIMARY KEY,' +
    '  user_id uuid,' +
    '  suggestion jsonb NOT NULL,' +
    '  sources text[],' +
    '  model text,' +
    '  created_by text,' +
    '  created_at timestamptz NOT NULL DEFAULT now(),' +
    '  feedback text,' +
    '  feedback_at timestamptz,' +
    '  draft_saved_at timestamptz' +
    ')'
  ).catch(function (e) { _ready = null; throw e; });
  return _ready;
}

var SYSTEM = [
  'You help a staff member of Epstein & Co., an Israeli real-estate and wills law firm (clients are mostly from abroad), decide the NEXT STEP on one open task, and draft the reply when one is needed.',
  'You get the task, the message it came from, what the firm already sent, the deal\'s monday fields, and possibly approved standard answers and office-process notes.',
  '',
  'Return ONLY JSON:',
  '{',
  '  "next_step": "Hebrew, 1-2 short sentences: the concrete action to take now (who / what / to whom)",',
  '  "why": "Hebrew, one short line: what in the facts leads to this",',
  '  "check_first": ["Hebrew, short: a fact to verify before acting, only if something needed is missing or unclear"],',
  '  "draft": null or { "channel": "email" | "whatsapp", "to": "who it goes to", "subject": "email only, else empty", "body": "the message" },',
  '  "answer_code": "the standard-answer code you based the draft on, else empty",',
  '  "confidence": "high" | "medium" | "low"',
  '}',
  '',
  'How to read it:',
  '- Read the WHOLE conversation before deciding. The task title and summary were written by a quick first pass and can be wrong - when the conversation shows the real request, follow the conversation and say so in "why".',
  '- Work out who asked whom for what. If a colleague asked the task owner for something, the task is to do THAT for the colleague (it may be internal work such as changing an automation, not a client matter).',
  '- If the task owner already promised something in the conversation ("I\'ll add it", "I\'ll send it"), the next step is to do what they promised.',
  '- Messages from @epsteinlaw.co.il are the firm. A forwarded message inside an email is part of the request (e.g. an automatic email that went out wrong).',
  '',
  'Rules:',
  '- Use ONLY the facts given. Never invent amounts, dates, names, documents, deadlines or monday values. If the reply needs a fact you do not have, leave a clear placeholder like [סכום] / [date] in the draft and list it in check_first.',
  '- If the firm already did what the task asks (it is in "already sent"), say so in next_step ("נראה שכבר בוצע: ... — לסגור את המשימה") and give no draft.',
  '- draft only when the next step is to write to someone (client, other side, colleague). Otherwise draft is null.',
  '- channel: the channel the task came from (email task -> email, WhatsApp task -> whatsapp), unless the facts say otherwise.',
  '- Draft language = the language of the message being answered (English client -> English, Hebrew -> Hebrew). Short, warm, professional, in the firm\'s voice. WhatsApp: no subject, no signature block. Email: a short greeting and a simple sign-off.',
  '- When an approved standard answer fits the question, base the draft on it and put its code in answer_code. Do not change its facts.',
  '- Do not promise timings or outcomes that are not in the facts. Do not give legal or tax advice beyond the approved answers; if that is needed, next_step says to check with a lawyer.',
  '- Keep Hebrew names and monday values exactly as written.'
].join('\n');

function clip(s, n) { s = String(s || '').replace(/\r/g, ''); return s.length > n ? s.slice(0, n) + '…' : s; }
function when(d) {
  try { return new Date(d).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return ''; }
}

var _staff = null;
function staffList() {
  if (!_staff) { try { _staff = require('../config/staff-directory.json').staff || []; } catch (e) { _staff = []; } }
  return _staff;
}
function staffByPhone(p) { return staffList().find(function (s) { return String(s.phone9) === String(p); }) || null; }

// Decrypt one stored WhatsApp message to { text, pushName } (in memory only).
var _dec = null;
function waMessage(row) {
  try {
    if (!_dec) {
      var enc = require('./crypto');
      var phone = require('../whatsapp/ingest/phone');
      _dec = function (pe) {
        var json = enc.decrypt(pe || '');
        var msg = json ? JSON.parse(json) : null;
        return { text: (msg && phone.textPreview(msg.message || msg)) || '', pushName: (msg && msg.pushName) || '' };
      };
    }
    return _dec(row.payload_encrypted);
  } catch (e) { return { text: '', pushName: '' }; }
}

async function chatLines(chatJid, limit) {
  var rows = (await pool().query(
    `SELECT direction, sender_staff_phone9, payload_encrypted, COALESCE(sent_at, created_at) AS at
       FROM processing_jobs
      WHERE chat_jid = $1 AND deleted_at IS NULL
      ORDER BY COALESCE(sent_at, created_at) DESC LIMIT $2`, [chatJid, limit])).rows.reverse();
  var out = [];
  rows.forEach(function (r) {
    var m = waMessage(r);
    if (!m.text) return;
    var st = r.sender_staff_phone9 ? staffByPhone(r.sender_staff_phone9) : null;
    var who = st ? st.name + ' (המשרד)' : (r.direction === 'out' ? 'המשרד' : (m.pushName || 'לקוח'));
    out.push('[' + when(r.at) + '] ' + who + ': ' + clip(m.text.replace(/\s+/g, ' '), 400));
  });
  return out;
}

function words(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9א-ת]+/).filter(function (w) { return w.length >= 3; });
}

// Everything the AI reads, as labelled text. `used` lists which parts made it in.
async function buildContext(task) {
  var parts = [], used = [];
  var deals = [];
  if (task.deal_id) deals.push({ id: String(task.deal_id), name: task.deal_name || '' });
  (Array.isArray(task.extra_deals) ? task.extra_deals : []).forEach(function (d) { if (d && d.id) deals.push({ id: String(d.id), name: d.name || '' }); });

  var owner = null;
  try { owner = (await pool().query('SELECT email, display_name FROM users WHERE id = $1', [task.user_id])).rows[0] || null; } catch (e) { /* none */ }
  parts.push('## The task\n' + [
    'Task owner (the person this suggestion is for): ' + (owner ? (owner.display_name || '') + ' <' + owner.email + '>' : 'unknown'),
    'Title: ' + (task.title || ''),
    task.summary ? 'Summary: ' + clip(task.summary, 1200) : '',
    'Came from: ' + task.source + (task.source_name ? ' — ' + task.source_name : '') + (task.source_subject ? ' — subject: ' + task.source_subject : ''),
    'Opened: ' + when(task.first_seen_at),
    task.task_type ? 'Type: ' + task.task_type : '',
    deals.length ? 'Deal(s): ' + deals.map(function (d) { return d.name || d.id; }).join(', ') : 'Deal: not linked'
  ].filter(Boolean).join('\n'));

  // The message the task came from.
  try {
    if (task.source === 'email' && !/^sys:/.test(String(task.source_ref || ''))) {
      // 7 Oct (Shira, the Jacobs example): the WHOLE conversation, not only the
      // last message — "Yes, that would be great" means nothing on its own, and
      // what the task owner already answered is part of it.
      var gmail = require('./gmail');
      var thread = task.thread_id && typeof gmail.getThreadTexts === 'function'
        ? await gmail.getThreadTexts(task.user_id, task.thread_id, 8, 1800) : null;
      if (thread && thread.length) {
        parts.push('## The email conversation (oldest first; the task came from the message marked <<TASK>>)\n' + thread.map(function (m) {
          return '--- ' + (m.id === task.source_ref ? '<<TASK>> ' : '') + when(m.at) + ' — from ' + m.from +
            (m.to ? ' — to ' + clip(m.to, 160) : '') + (m.cc ? ' — cc ' + clip(m.cc, 160) : '') + '\n' + (m.text || '(no text)');
        }).join('\n'));
        used.push('email');
      } else {
        var txt = await gmail.getMessageNewText(task.user_id, task.source_ref, 2500);
        if (txt) { parts.push('## The email the task came from (new text only)\n' + txt); used.push('email'); }
      }
    } else if (task.source === 'whatsapp') {
      var lines = await chatLines(task.source_ref, 20);
      if (lines.length) { parts.push('## The WhatsApp chat (last messages, oldest first)\n' + lines.join('\n')); used.push('whatsapp'); }
    }
  } catch (e) { /* leave it out */ }

  // What the firm already sent: emails to the people / deal since a bit before the task.
  try {
    var since = new Date(new Date(task.first_seen_at || Date.now()).getTime() - 14 * 864e5).toISOString();
    var sent = (await pool().query(
      `SELECT sender, recipient_names, recipients, subject, snippet, sent_at FROM staff_sent_mail
        WHERE sent_at > $1 AND (recipients && $2::text[] OR deal_ids && $3::text[])
        ORDER BY sent_at DESC LIMIT 6`,
      [since, task.contact_addrs || [], deals.map(function (d) { return d.id; })])).rows;
    if (sent.length) {
      parts.push('## Emails the firm already sent to these people / this deal (newest first)\n' + sent.map(function (m) {
        return '[' + when(m.sent_at) + '] from ' + String(m.sender || '').replace(/<.*>/, '').trim() + ' to ' + clip(m.recipient_names || (m.recipients || []).join(', '), 80) +
          ' — ' + clip(m.subject, 120) + ': ' + clip(m.snippet, 300);
      }).join('\n'));
      used.push('sent_mail');
    }
  } catch (e) { /* no sent-mail table yet */ }

  // The deal's WhatsApp group (for a task that did not come from it).
  try {
    if (deals.length) {
      var groups = (await pool().query(
        `SELECT g.provider_group_jid AS jid, g.name FROM whatsapp_groups g JOIN deals d ON d.id = g.deal_id
          WHERE g.removed_at IS NULL AND d.monday_item_id::text = ANY($1) LIMIT 2`, [deals.map(function (d) { return d.id; })])).rows;
      for (var gi = 0; gi < groups.length; gi++) {
        if (task.source === 'whatsapp' && groups[gi].jid === task.source_ref) continue;
        var gl = await chatLines(groups[gi].jid, 12);
        if (gl.length) { parts.push('## The deal\'s WhatsApp group "' + (groups[gi].name || '') + '" (last messages)\n' + gl.join('\n')); used.push('deal_group'); }
      }
    }
  } catch (e) { /* no groups */ }

  // monday.
  try {
    if (deals.length) {
      var mc = require('./task-monday-check');
      for (var di = 0; di < Math.min(deals.length, 2); di++) {
        var snap = await mc.dealSnapshot(deals[di].id);
        if (snap && snap.lines.length) {
          parts.push('## monday — ' + snap.name + ' (' + snap.board + ')\n' + clip(snap.lines.join('\n'), 3500));
          used.push('monday');
        }
      }
    }
  } catch (e) { /* monday down: leave it out */ }

  var taskWords = new Set(words([task.title, task.summary, task.source_subject].join(' ')));
  var score = function (text) { var n = 0; words(text).forEach(function (w) { if (taskWords.has(w)) n++; }); return n; };

  // Approved standard answers only.
  try {
    var bank = await require('../whatsapp/agent/db').listAnswerBank({ activeOnly: true });
    var fit = bank.map(function (b) { return { b: b, s: score([b.topic, (b.question_forms || []).join(' ')].join(' ')) }; })
      .filter(function (x) { return x.s >= 2; }).sort(function (a, b) { return b.s - a.s; }).slice(0, 4);
    if (fit.length) {
      parts.push('## Approved standard answers that may fit\n' + fit.map(function (x) {
        return '[' + x.b.code + '] ' + x.b.topic + ' (' + x.b.lang + ')\n' + clip(x.b.answer_md, 900);
      }).join('\n\n'));
      used.push('answer_bank');
    }
  } catch (e) { /* none */ }

  // Office processes (if the table exists).
  try {
    var procs = (await pool().query('SELECT * FROM office_processes')).rows;
    var pfit = procs.map(function (p) {
      // matched on its keywords only (a name like "הכרת הלקוח" has words that are
      // in every task); a row with no keywords is matched on its key / name.
      var kw = (Array.isArray(p.keywords) ? p.keywords : []).join(' ');
      return { p: p, s: score(kw || [p.key, p.name, p.title].join(' ')) };
    }).filter(function (x) { return x.s >= 1; }).sort(function (a, b) { return b.s - a.s; }).slice(0, 2);
    if (pfit.length) {
      parts.push('## Office process notes\n' + pfit.map(function (x) {
        return '### ' + (x.p.name || x.p.title || x.p.key) + '\n' + clip(x.p.full_content || x.p.content || '', 2500);
      }).join('\n\n'));
      used.push('office_process');
    }
  } catch (e) { /* no table */ }

  // The firm's voice for drafts.
  try {
    var v = (await pool().query(
      "SELECT s.body_md FROM wa_skill_active a JOIN wa_skills s ON s.id = a.skill_id WHERE a.key IN ('voice','rules')")).rows;
    if (v.length) parts.push('## The firm\'s writing voice and rules\n' + clip(v.map(function (r) { return r.body_md; }).join('\n\n'), 2500));
  } catch (e) { /* none */ }

  return { text: parts.join('\n\n'), used: used };
}

function clean(out) {
  if (!out || typeof out !== 'object' || !out.next_step) return null;
  var d = out.draft && typeof out.draft === 'object' && String(out.draft.body || '').trim() ? {
    channel: out.draft.channel === 'whatsapp' ? 'whatsapp' : 'email',
    to: String(out.draft.to || '').slice(0, 200),
    subject: String(out.draft.subject || '').slice(0, 200),
    body: String(out.draft.body || '').slice(0, 4000)
  } : null;
  return {
    next_step: String(out.next_step).slice(0, 600),
    why: String(out.why || '').slice(0, 400),
    check_first: (Array.isArray(out.check_first) ? out.check_first : []).map(String).filter(Boolean).slice(0, 5),
    draft: d,
    answer_code: String(out.answer_code || '').slice(0, 40),
    confidence: ['high', 'medium', 'low'].indexOf(out.confidence) !== -1 ? out.confidence : 'medium'
  };
}

// Load the task; owner, or an admin (Team view). Returns null when not allowed.
async function loadTask(taskId, userId, isAdmin) {
  var r = (await pool().query('SELECT * FROM unified_tasks WHERE id = $1', [taskId])).rows[0];
  if (!r) return null;
  if (String(r.user_id) !== String(userId) && !isAdmin) return null;
  return r;
}

async function getSuggestion(taskId, userId, opts) {
  opts = opts || {};
  await ensureTable();
  var task = await loadTask(taskId, userId, opts.isAdmin);
  if (!task) return { error: 'not found', status: 404 };
  if (!opts.fresh) {
    var saved = (await pool().query('SELECT suggestion, sources, created_at, feedback, draft_saved_at FROM task_hub_suggestions WHERE task_id = $1', [task.id])).rows[0];
    if (saved) return { suggestion: saved.suggestion, sources: saved.sources, created_at: saved.created_at, feedback: saved.feedback, draft_saved_at: saved.draft_saved_at, cached: true };
    if (opts.cachedOnly) return { suggestion: null };
  }
  if (!claude.isConfigured()) return { error: 'AI is not configured', status: 503 };
  var ctx = await buildContext(task);
  var model = process.env.TASK_HUB_SUGGEST_MODEL || undefined;
  var out = await claude.askJSON({ system: SYSTEM, user: ctx.text, model: model, maxTokens: 1400 });
  var s = clean(out);
  if (!s) return { error: 'no suggestion came back — try again', status: 502 };
  await pool().query(
    `INSERT INTO task_hub_suggestions (task_id, user_id, suggestion, sources, model, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (task_id) DO UPDATE SET suggestion = EXCLUDED.suggestion, sources = EXCLUDED.sources, model = EXCLUDED.model,
       created_by = EXCLUDED.created_by, created_at = now(), feedback = NULL, feedback_at = NULL, draft_saved_at = NULL`,
    [task.id, task.user_id, JSON.stringify(s), ctx.used, model || null, opts.by || null]);
  console.log('[task-suggest] made for task', task.id, '(' + (ctx.used.join(', ') || 'task only') + ')' + (opts.fresh ? ' — fresh' : ''));
  return { suggestion: s, sources: ctx.used, created_at: new Date().toISOString(), cached: false };
}

async function setFeedback(taskId, userId, isAdmin, vote) {
  await ensureTable();
  var task = await loadTask(taskId, userId, isAdmin);
  if (!task) return false;
  var v = vote === 'up' ? 'up' : vote === 'down' ? 'down' : null;
  await pool().query('UPDATE task_hub_suggestions SET feedback = $2, feedback_at = now() WHERE task_id = $1', [task.id, v]);
  return true;
}

// Save the (edited) email draft in the task owner's Gmail Drafts — never sends.
// Only the owner: it goes into their own mailbox.
async function saveGmailDraft(taskId, userId, edit) {
  await ensureTable();
  var task = await loadTask(taskId, userId, false);
  if (!task) return { ok: false, status: 404, error: 'not found' };
  var row = (await pool().query('SELECT suggestion FROM task_hub_suggestions WHERE task_id = $1', [task.id])).rows[0];
  var d = (row && row.suggestion && row.suggestion.draft) || {};
  var body = edit && typeof edit.body === 'string' ? edit.body : d.body;
  var subject = edit && typeof edit.subject === 'string' ? edit.subject : (d.subject || task.source_subject || task.title);
  if (!String(body || '').trim()) return { ok: false, status: 400, error: 'no draft' };
  var to = '';
  if (task.source === 'email' && Array.isArray(task.contact_addrs) && task.contact_addrs.length) to = task.contact_addrs[0];
  if (task.source === 'email' && task.source_subject && !/^re:/i.test(subject) && subject === (d.subject || '')) {
    // a reply to the email the task came from keeps its subject
    subject = 'Re: ' + String(task.source_subject).replace(/^(re|fwd?):\s*/i, '');
  }
  var gmail = require('./gmail');
  var r = await gmail.createDraft(task.user_id, { to: to, subject: subject, body: body, threadId: task.thread_id || null });
  if (r && r.ok) await pool().query('UPDATE task_hub_suggestions SET draft_saved_at = now() WHERE task_id = $1', [task.id]);
  return r;
}

module.exports = { getSuggestion, setFeedback, saveGmailDraft, buildContext, _SYSTEM: SYSTEM, _clean: clean };
