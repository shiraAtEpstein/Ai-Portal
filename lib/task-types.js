// ============================================================
// lib/task-types.js — matching logic for the Task Hub task types (step 2).
//
// The types themselves live ONLY in the database table task_hub_types
// (created and loaded by sql/2026-10-task-hub-types.sql, run once in Neon).
// This file holds no data — just the rules for reading a row:
//
//   system_sender + subject_regex — an automatic reminder email. BOTH must
//   match, and the subject must not start with Re:/Fwd: (Tzipora also writes
//   to people from the same address). A match becomes a task with NO AI.
//   The regex's first capture group is the client/deal, so a repeated
//   reminder for the same client updates one task.
// ============================================================

const REPLY_PREFIX = /^\s*(re|fw|fwd|הועבר|תשובה)\s*:/i;

function senderAddress(fromHeader) {
  const s = String(fromHeader || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// A short, stable key for "which client/deal is this about", from the
// captured subject text: lower-case, punctuation and extra spaces removed.
function clientKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')            // Hebrew vowel marks
    .replace(/[^0-9a-zא-ת]+/g, ' ')    // keep letters (Latin + Hebrew) and digits
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

// Returns { type, clientText, clientKey } when the email is one of the
// automatic reminders, otherwise null. `types` are rows from the table.
function matchSystemEmail(types, msg) {
  const from = senderAddress(msg.from);
  const subject = String(msg.subject || '').trim();
  if (!from || !subject || REPLY_PREFIX.test(subject)) return null;
  for (const t of types) {
    if (!t.active || !t.approved || !t.system_sender || !t.subject_regex) continue;
    if (from !== String(t.system_sender).toLowerCase()) continue;
    let re;
    try { re = new RegExp(t.subject_regex, 'i'); } catch (_) { continue; }
    const m = subject.match(re);
    if (!m) continue;
    const clientText = (m[1] || '').trim();
    return { type: t, clientText, clientKey: clientKey(clientText) };
  }
  return null;
}

module.exports = { matchSystemEmail, senderAddress, clientKey, REPLY_PREFIX };
