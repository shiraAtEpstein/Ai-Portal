// ============================================================
// whatsapp/agent/classify.js — one Haiku call: type, language, tone, escalation,
// silence, fact slots, and which Answer Bank entry (if any) answers the message.
//
// The page the model reads is wa_skills 'classify' (editable in the DB). This
// file only assembles the call and validates the JSON that comes back. Anything
// the model returns outside the allowed vocabularies is rejected -> null, and a
// null classification means "escalate, no draft" upstream. Never guess.
//
// Retrieval note: with ~40 Answer Bank entries the whole topic list (code + topic
// + question forms, ~3k tokens) fits in the prompt, so v1 skips embeddings and
// lets the model pick from the full list. pgvector shortlisting is the upgrade
// path when the bank passes ~150 entries.
// ============================================================
const claude = require('../../lib/claude');

const TYPES = new Set(['status_nudge', 'deal_fact', 'scheduling', 'procedure', 'what_is_this', 'confusion',
  'legal_opinion', 'complaint', 'handoff', 'ack_social', 'referral', 'meta', 'unknown']);
const LANGS = new Set(['he', 'en', 'mixed']);
const TONES = new Set(['neutral', 'frustrated', 'urgent', 'confused', 'warm']);
const ESCALATE_REASONS = new Set(['frustration', 'anger', 'urgent_consequence', 'dispute', 'legal_opinion', 'money_trouble',
  'sensitive', 'named_lawyer', 'litigation_chat', 'unlinked', 'unreadable', 'injection_suspect', 'third_party_data']);
const SLOTS = new Set(['waiting_on', 'last_firm_action', 'responsible_staff', 'next_payment_amount', 'next_payment_due',
  'payment_schedule', 'balance', 'delivery_date', 'signing_date', 'meeting_time', 'meeting_link', 'office_address',
  'apartment_id', 'document_status', 'registration_status', 'tax_status', 'contact_person', 'client_display']);

// Types that never get a draft in v1, whatever the model says about escalation.
const ROUTE_ONLY_TYPES = new Set(['status_nudge', 'legal_opinion', 'complaint', 'meta', 'unknown']);

// Deterministic injection / third-party tripwires. These run BEFORE the model and
// force escalation; the model's own judgement is added on top, never instead.
const INJECTION_RE = /(ignore (your|all|previous|the) (rules|instructions)|system prompt|your instructions|reveal|what data do you have|pretend (to be|you are)|act as (the|a) lawyer|as yaacov|jailbreak|תתעלם מההוראות|מה ההוראות שלך|תגלה לי|תעמיד פנים)/i;
const THIRD_PARTY_RE = /(other (buyer|client|deal|apartment)|someone else'?s|the (seller|kablan|contractor|company)'?s (phone|number|email|address|id)|(id|passport|teudat zehut) number|תעודת ה?זהות|מספר ה?זהות|ת"ז|מספר ה?דרכון|הטלפון של המוכר|הלקוח האחר|דירה אחרת)/i;

function tripwires(text) {
  const t = String(text || '');
  const reasons = [];
  if (INJECTION_RE.test(t)) reasons.push('injection_suspect');
  if (THIRD_PARTY_RE.test(t)) reasons.push('third_party_data');
  return reasons;
}

function bankListing(entries) {
  if (!entries || !entries.length) return '(no approved entries)';
  return entries.map((e) => `${e.code} [${e.lang}] ${e.topic}\n  asks: ${(e.question_forms || []).slice(0, 6).join(' · ')}`).join('\n');
}

function historyBlock(turns) {
  if (!turns || !turns.length) return '(none)';
  return turns.slice(-8).map((t) => `${t.who === 'firm' ? 'Firm' : 'Client'}${t.name ? ' ' + t.name : ''}: ${String(t.text || '').slice(0, 300)}`).join('\n');
}

function validate(raw, bankCodes) {
  if (!raw || typeof raw !== 'object') return null;
  const c = {};
  c.type = TYPES.has(raw.type) ? raw.type : 'unknown';
  c.lang = LANGS.has(raw.lang) ? raw.lang : null;
  if (!c.lang) return null;
  c.tone = TONES.has(raw.tone) ? raw.tone : 'neutral';
  c.escalate_reasons = Array.isArray(raw.escalate_reasons) ? raw.escalate_reasons.filter((r) => ESCALATE_REASONS.has(r)) : [];
  c.escalate = !!raw.escalate || c.escalate_reasons.length > 0;
  c.silence = !!raw.silence;
  c.slots = Array.isArray(raw.slots) ? [...new Set(raw.slots.filter((s) => SLOTS.has(s)))] : [];
  c.faq_pick = (typeof raw.faq_pick === 'string' && bankCodes.has(raw.faq_pick)) ? raw.faq_pick : null;
  c.needs_attachment = !!raw.needs_attachment;
  const conf = Number(raw.confidence);
  c.confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null;
  c.note = typeof raw.note === 'string' ? raw.note.slice(0, 200) : '';
  return c;
}

/**
 * classify({ text, turns, dealLinked, litigationChat, skills, bank, model })
 *   -> { classification, tripped: [reasons], model } | { classification: null, ... }
 */
async function classify({ text, turns, dealLinked, litigationChat, skills, bank, model } = {}) {
  const page = skills && skills.classify;
  if (!page || page.expired) return { classification: null, tripped: [], error: 'classify page missing or expired' };
  const tripped = tripwires(text);
  if (!dealLinked) tripped.push('unlinked');
  if (litigationChat) tripped.push('litigation_chat');

  const bankCodes = new Set((bank || []).map((e) => e.code));
  const user =
    `CHAT LINKED TO A KNOWN DEAL: ${dealLinked ? 'yes' : 'no'}\n\n` +
    `RECENT TURNS (oldest first):\n${historyBlock(turns)}\n\n` +
    `MESSAGE TO CLASSIFY:\n${String(text || '').slice(0, 2000)}\n\n` +
    `CANDIDATE ANSWER-BANK ENTRIES (pick ONE code that truly answers the message, or null):\n${bankListing(bank)}\n\n` +
    `Return the JSON object only.`;

  const useModel = page.model || model || 'haiku';
  const raw = await claude.askJSON({ system: page.body, user, model: useModel, maxTokens: 600 });
  const c = validate(raw, bankCodes);
  if (c) {
    for (const r of tripped) if (!c.escalate_reasons.includes(r)) c.escalate_reasons.push(r);
    if (tripped.length) c.escalate = true;
    if (ROUTE_ONLY_TYPES.has(c.type)) c.route_only = true;
  }
  return { classification: c, tripped, model: claude.resolveModel(useModel) };
}

module.exports = { classify, tripwires, validate, TYPES, SLOTS, ROUTE_ONLY_TYPES };
