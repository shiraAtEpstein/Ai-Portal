// ============================================================
// whatsapp/agent/compose.js — one Sonnet call that writes LANGUAGE only.
//
// System prompt = rules page + voice page + compose page (all from wa_skills).
// User prompt   = the chosen Answer Bank entry (if any), the filled slots as
//                 JSON, the last turns, and the message. Nothing else. Raw monday
//                 rows never appear here; unfillable slots are simply absent.
// Output        = { text, facts_used: [{ value, source }], abstain_reason }
//                 text: null means the model abstained — always safe.
// ============================================================
const claude = require('../../lib/claude');

function fmtSlots(slots) {
  if (!slots || !Object.keys(slots).length) return '(none)';
  return JSON.stringify(slots, null, 1);
}
function fmtTurns(turns) {
  if (!turns || !turns.length) return '(none)';
  return turns.slice(-6).map((t) => `${t.who === 'firm' ? 'Firm' : 'Client'}: ${String(t.text || '').slice(0, 300)}`).join('\n');
}

async function compose({ text, turns, classification, slots, context, entry, skills, model } = {}) {
  const rules = skills && skills.rules, voice = skills && skills.voice, page = skills && skills.compose;
  if (!rules || !voice || !page || rules.expired || voice.expired || page.expired) {
    return { text: null, abstain_reason: 'skill page missing or expired', facts_used: [] };
  }
  const system = [
    '# Rules (override everything below)\n' + rules.body,
    '# Voice\n' + voice.body,
    '# Compose\n' + page.body,
    'OUTPUT: JSON only — {"text": string|null, "facts_used": [{"value": string, "source": string}], "abstain_reason": string|null}. ' +
    'Every number, date, amount, link, address and name in "text" must come from SLOTS or the ANSWER ENTRY and be listed in facts_used with its source. ' +
    'If the client asks for something that is not in SLOTS or the ANSWER ENTRY, do not answer that part: say who will confirm it. ' +
    'If you cannot write a correct reply, return text null with abstain_reason.'
  ].join('\n\n');

  const stageLine = context && context.stage ? `CONTEXT (for your understanding only — never state it): stage = ${context.stage}\n` : '';
  const user =
    `CLIENT LANGUAGE: ${classification.lang}   TONE: ${classification.tone}   TYPE: ${classification.type}\n` +
    stageLine +
    `RESPONSIBLE STAFF (for "I'll check with…"): ${(slots && slots.responsible_staff && slots.responsible_staff.value) || 'the office'}\n\n` +
    `SLOTS (the only facts you may use):\n${fmtSlots(slots)}\n\n` +
    `ANSWER ENTRY (approved wording to draw on; adapt, never paste):\n${entry ? `[${entry.code}] ${entry.topic}\n${entry.answer_md}` : '(none)'}\n\n` +
    `RECENT TURNS:\n${fmtTurns(turns)}\n\n` +
    `CLIENT MESSAGE:\n${String(text || '').slice(0, 2000)}\n\n` +
    `Return the JSON object only.`;

  const useModel = page.model || model || 'sonnet';
  const raw = await claude.askJSON({ system, user, model: useModel, maxTokens: 700 });
  if (!raw || typeof raw !== 'object') return { text: null, abstain_reason: 'no parseable output', facts_used: [], model: claude.resolveModel(useModel) };
  const out = {
    text: typeof raw.text === 'string' && raw.text.trim() ? raw.text.trim() : null,
    facts_used: Array.isArray(raw.facts_used) ? raw.facts_used.filter((f) => f && typeof f.value !== 'undefined').map((f) => ({ value: String(f.value), source: String(f.source || '') })) : [],
    abstain_reason: typeof raw.abstain_reason === 'string' ? raw.abstain_reason.slice(0, 200) : null,
    model: claude.resolveModel(useModel),
  };
  return out;
}

module.exports = { compose };
