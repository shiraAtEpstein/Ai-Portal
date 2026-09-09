// ============================================================
// whatsapp/agent/pipeline.js — the responder loop, one message at a time.
//
//   prefilter → classify → (escalate / silence / route) → resolve facts →
//   pick entry → compose → validate → record
//
// There is NO send step in this module. Every run ends as a wa_drafts row with an
// outcome. Modes:
//   'offline' — fed from the archive test set; deal facts come from a stub
//               or from monday if the deal is known; nothing is queued.
//   'shadow'  — live inbound; drafts recorded, never shown to a client.
//   'review'  — live inbound; drafts go to the human queue (future).
//
//   runMessage(input, { mode, skills, bank, stubFacts }) -> result
//   input = { text, turns, direction, isGroup, senderIsStaff, kind, dealId,
//             mondayBoardId, mondayItemId, chatJid, jobId, litigationChat,
//             addressedToOther, lastFirmReplyAfter, referenceText }
// ============================================================
const path = require('path');
const db = require('./db');
const { prefilter } = require('./prefilter');
const { classify } = require('./classify');
const { resolveFacts } = require('./facts');
const { compose } = require('./compose');
const { validate } = require('./validate');

let _staffNames = null;
function staffNames() {
  if (_staffNames) return _staffNames;
  try { _staffNames = (require(path.join(__dirname, '..', '..', 'config', 'staff-directory.json')).staff || []).map((s) => s.name); }
  catch (_) { _staffNames = []; }
  return _staffNames;
}

// Escalate reasons and route-only types where there's genuinely nothing safe or
// reliable to draft from — either no usable text/intent (unreadable, injection
// attempt, classifier failure), or the content itself calls for a human's own
// professional judgment rather than AI-suggested wording, even as an internal,
// never-sent draft (a live complaint). Every OTHER escalate/route-only case —
// including legal_opinion — is escalating on tone, stakes, or subject matter, not
// on a lack of information: compose still runs for those, grounded only in real
// facts/allowlisted data (validate() still rejects anything ungrounded), so the
// person handling it by hand gets a possible starting point instead of a blank
// screen, clearly marked as a suggestion only. The outcome stays 'escalate'
// either way; only whether draft_text gets filled in changes.
const NO_DRAFT_ESCALATE_REASONS = new Set(['unreadable', 'injection_suspect', 'third_party_data']);
const NO_DRAFT_ROUTE_ONLY_TYPES = new Set(['complaint', 'meta', 'unknown']);

// Slots a type is allowed to ask for; anything else the classifier requested is dropped.
const SLOTS_BY_TYPE = {
  deal_fact: null,          // any
  what_is_this: null,
  // "any update?" / "מה קורה" — added 7 Sept alongside removing status_nudge
  // from classify.js's ROUTE_ONLY_TYPES. waiting_on/last_firm_action come from
  // LAWLY's own deals/deal_items (facts.js lawlyFacts), not monday.
  status_nudge: ['waiting_on', 'last_firm_action', 'responsible_staff', 'next_payment_due', 'signing_date', 'delivery_date', 'client_display'],
  scheduling: ['meeting_time', 'meeting_link', 'office_address', 'signing_date', 'responsible_staff', 'client_display'],
  procedure: ['responsible_staff', 'client_display', 'next_payment_due', 'signing_date', 'delivery_date'],
  confusion: ['responsible_staff', 'client_display'],
  referral: ['responsible_staff', 'client_display', 'contact_person'],
  handoff: ['responsible_staff', 'client_display'],
};

function versionsOf(skills) {
  const v = {};
  for (const k of ['voice', 'rules', 'classify', 'compose']) if (skills && skills[k]) v[k] = skills[k].id;
  return v;
}

async function runMessage(input, opts = {}) {
  const mode = opts.mode || 'offline';
  const skills = opts.skills || (await db.loadActiveSkills());
  const bank = opts.bank || (await db.listAnswerBank({ activeOnly: true }));
  const base = {
    mode, job_id: input.jobId, chat_jid: input.chatJid, deal_id: input.dealId, message_text: String(input.text || ''),
    skill_versions: versionsOf(skills), reference_text: input.referenceText || null,
    // Persisted so the review screen can show the reviewer what conversation
    // (including any prior staff reply) the model actually saw when it
    // composed this draft -- see whatsapp/agent/db.js's insertDraft.
    turns: input.turns || [],
  };
  const finish = async (row) => { const id = opts.dryRun ? null : await db.insertDraft(Object.assign({}, base, row)); return Object.assign({ id }, row); };

  if (!skills || !skills.rules || !skills.voice || !skills.classify || !skills.compose) {
    return finish({ outcome: 'error', outcome_reason: 'skills not loaded (rules/voice/classify/compose must be active)' });
  }

  // Anything that throws inside the steps (a monday outage, a DB hiccup) is an
  // 'error' row, never an unhandled rejection in the worker. A draft is only ever
  // produced by the last step, so an error can never leave a draft behind.
  try {
    return await runSteps(input, { mode, skills, bank, opts, finish });
  } catch (e) {
    console.error('[wa-agent/pipeline] run failed:', e.message);
    try { return await finish({ outcome: 'error', outcome_reason: 'exception: ' + String(e.message || e).slice(0, 200) }); }
    catch (e2) { return { id: null, outcome: 'error', outcome_reason: 'exception: ' + String(e.message || e).slice(0, 200) }; }
  }
}

async function runSteps(input, { skills, bank, opts, finish }) {
  // 1. pre-filter
  const pf = prefilter(input);
  if (!pf.keep) return finish({ outcome: 'dropped', outcome_reason: pf.reason });

  // 2. classify
  const cl = await classify({ text: input.text, turns: input.turns, dealLinked: !!input.dealId, litigationChat: !!input.litigationChat, skills, bank });
  const c = cl.classification;
  if (!c) return finish({ outcome: 'escalate', outcome_reason: 'classifier_unavailable', classification: { tripped: cl.tripped }, model_classify: cl.model });

  // 3. escalate / silence / route-only
  // forceEscalate: set when we still compose a suggested draft below, but the
  // final outcome must stay 'escalate' (never silently become a routine 'draft')
  // because the reason this needs a human hasn't gone away just because a draft
  // exists — it's a starting point for them, not a ready answer.
  let forceEscalate = null;
  if (c.silence || c.type === 'ack_social' || c.type === 'handoff') return finish({ outcome: 'silence', outcome_reason: c.type, classification: c, model_classify: cl.model });
  if (c.escalate) {
    const reason = c.escalate_reasons.join(',') || 'model';
    // No specific reason (pure model judgment call) is treated the same as a
    // no-draft reason: without knowing WHY it escalated, drafting anyway isn't safe.
    const noDraft = !c.escalate_reasons.length || c.escalate_reasons.some((r) => NO_DRAFT_ESCALATE_REASONS.has(r));
    if (noDraft) return finish({ outcome: 'escalate', outcome_reason: reason, classification: c, model_classify: cl.model });
    forceEscalate = reason;
  } else if (c.route_only) {
    if (NO_DRAFT_ROUTE_ONLY_TYPES.has(c.type)) return finish({ outcome: 'escalate', outcome_reason: 'route_only:' + c.type, classification: c, model_classify: cl.model });
    forceEscalate = 'route_only:' + c.type;
  }

  // 4. facts
  const allowed = SLOTS_BY_TYPE[c.type];
  const wanted = [...new Set((allowed ? c.slots.filter((s) => allowed.includes(s)) : c.slots).concat(['responsible_staff']))];
  let facts;
  if (opts.stubFacts) facts = opts.stubFacts(input, wanted);
  else facts = await resolveFacts({ dealId: input.dealId, slotsWanted: wanted, mondayBoardId: input.mondayBoardId, mondayItemId: input.mondayItemId, lang: c.lang, documentHint: c.note });
  facts = facts || { slots: {}, unfillable: wanted.slice(), context: {} };
  facts.slots = facts.slots || {}; facts.unfillable = facts.unfillable || []; facts.context = facts.context || {};
  const missingCore = facts.unfillable.filter((s) => s !== 'responsible_staff' && s !== 'client_display' && !['meeting_link', 'office_address'].includes(s));
  const entry = c.faq_pick ? (bank.find((e) => e.code === c.faq_pick) || null) : null;

  // Until 7 Sept, a hole in a deal-fact / what_is_this / scheduling question
  // meant NO draft at all — escalate, blank screen. Shira's call: every draft is
  // reviewed by a person anyway, so a hole should produce a starting point, not
  // nothing. compose() is now always attempted and told exactly which slots it
  // doesn't have, so it can write a placeholder ("[will confirm the exact
  // amount]") instead of guessing or staying silent. `partial` rides on the
  // outcome (outcome stays 'draft') purely so the review screen can flag it —
  // validate() still blocks any actual invented number/date/name, unchanged.
  const partial = missingCore.length ? missingCore.join(',') : null;
  if (!entry && !partial && !(input.turns && input.turns.length) && !Object.keys(facts.slots).some((s) => s !== 'responsible_staff')) {
    // Truly nothing to go on — no bank entry, no facts, no conversation to draw
    // on either. compose() would only abstain here anyway; skip the model call.
    return finish({ outcome: 'escalate', outcome_reason: 'nothing_to_answer_with', classification: c, slots: facts.slots, model_classify: cl.model });
  }

  // 5. compose
  const draft = await compose({ text: input.text, turns: input.turns, classification: c, slots: facts.slots, context: facts.context, entry, missing: missingCore, skills });
  if (!draft.text) {
    const reason = forceEscalate ? forceEscalate + ',abstained:' + (draft.abstain_reason || '') : 'abstained:' + (draft.abstain_reason || '');
    return finish({ outcome: 'escalate', outcome_reason: reason, classification: c, slots: facts.slots, answer_bank_code: entry && entry.code, model_classify: cl.model, model_compose: draft.model });
  }

  // 6. validate
  const v = validate({ text: draft.text, factsUsed: draft.facts_used, slots: facts.slots, entry, lang: c.lang, turns: input.turns, staffNames: staffNames() });
  if (forceEscalate) {
    // Same validation bar as a routine draft — an escalate-with-suggestion that
    // fails validate (e.g. an unverified figure) shows no draft_text at all,
    // exactly like 'blocked' does, just filed under the original escalate reason.
    return finish({
      outcome: 'escalate', outcome_reason: v.ok ? forceEscalate : forceEscalate + ',blocked:' + v.reasons.join(','),
      classification: c, slots: facts.slots, answer_bank_code: entry && entry.code,
      draft_text: v.ok ? draft.text : null, facts_used: draft.facts_used, validation: v,
      model_classify: cl.model, model_compose: draft.model,
    });
  }
  return finish({
    outcome: v.ok ? 'draft' : 'blocked',
    outcome_reason: v.ok ? (partial ? 'partial:' + partial : null) : v.reasons.join(','),
    classification: c, slots: facts.slots, answer_bank_code: entry && entry.code,
    draft_text: draft.text, facts_used: draft.facts_used, validation: v,
    model_classify: cl.model, model_compose: draft.model,
  });
}

module.exports = { runMessage, SLOTS_BY_TYPE };
