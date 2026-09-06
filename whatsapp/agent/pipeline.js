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

// Slots a type is allowed to ask for; anything else the classifier requested is dropped.
const SLOTS_BY_TYPE = {
  deal_fact: null,          // any
  what_is_this: null,
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
  if (c.escalate) return finish({ outcome: 'escalate', outcome_reason: c.escalate_reasons.join(',') || 'model', classification: c, model_classify: cl.model });
  if (c.silence || c.type === 'ack_social' || c.type === 'handoff') return finish({ outcome: 'silence', outcome_reason: c.type, classification: c, model_classify: cl.model });
  if (c.route_only) return finish({ outcome: 'escalate', outcome_reason: 'route_only:' + c.type, classification: c, model_classify: cl.model });

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

  // A deal-fact question with a hole gets no draft. So does a scheduling question
  // with a hole (a missing signing date / meeting time goes to a person — v1 has no
  // calendar). A procedure question with an entry can go on without deal facts:
  // the unfillable slot is simply absent and compose says who will confirm it.
  const strictTypes = c.type === 'deal_fact' || c.type === 'what_is_this' || c.type === 'scheduling';
  if (missingCore.length && (strictTypes || !entry)) {
    return finish({ outcome: 'escalate', outcome_reason: 'unfillable:' + missingCore.join(','), classification: c, slots: facts.slots, answer_bank_code: entry && entry.code, model_classify: cl.model });
  }
  if (!entry && !Object.keys(facts.slots).some((s) => s !== 'responsible_staff')) {
    return finish({ outcome: 'escalate', outcome_reason: 'nothing_to_answer_with', classification: c, slots: facts.slots, model_classify: cl.model });
  }

  // 5. compose
  const draft = await compose({ text: input.text, turns: input.turns, classification: c, slots: facts.slots, context: facts.context, entry, skills });
  if (!draft.text) return finish({ outcome: 'escalate', outcome_reason: 'abstained:' + (draft.abstain_reason || ''), classification: c, slots: facts.slots, answer_bank_code: entry && entry.code, model_classify: cl.model, model_compose: draft.model });

  // 6. validate
  const v = validate({ text: draft.text, factsUsed: draft.facts_used, slots: facts.slots, entry, lang: c.lang, turns: input.turns, staffNames: staffNames() });
  return finish({
    outcome: v.ok ? 'draft' : 'blocked', outcome_reason: v.ok ? null : v.reasons.join(','),
    classification: c, slots: facts.slots, answer_bank_code: entry && entry.code,
    draft_text: draft.text, facts_used: draft.facts_used, validation: v,
    model_classify: cl.model, model_compose: draft.model,
  });
}

module.exports = { runMessage, SLOTS_BY_TYPE };
