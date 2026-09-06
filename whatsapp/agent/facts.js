// ============================================================
// whatsapp/agent/facts.js — the fact resolver. Fills the slots the classifier
// asked for, from monday (allowlisted columns only) and from LAWLY's own
// deals / deal_items tables. Never from the model.
//
// Guarantees (see docs: Fact Specs v2 §3):
//   * The monday query names exactly the column ids in config/wa-monday-allowlist.json.
//     A column not listed there is never requested, so it never reaches the model.
//   * One deal per call: the deal item cached on the chat, plus its linked תשלומים
//     rows. No search, no other items.
//   * A slot that cannot be filled is ABSENT from the result (not null, no hint),
//     and is listed in `unfillable` so the caller can refuse to draft.
//   * Every value carries its source ("board:column" or "lawly:table.column").
//
//   resolveFacts({ dealId, slotsWanted, mondayBoardId, mondayItemId, lang })
//     -> { slots: { name: { value, source, flags? } }, unfillable: [names], context: { stage } }
// ============================================================
const path = require('path');
const monday = require('../../lib/monday');
const { getPool } = require('../../db');

const ALLOWLIST = require(path.join(__dirname, '..', '..', 'config', 'wa-monday-allowlist.json'));
const PAYMENTS_BOARD = '1727614456';

let _staffDir = null;
function staffDir() {
  if (_staffDir) return _staffDir;
  try { _staffDir = require(path.join(__dirname, '..', '..', 'config', 'staff-directory.json')); } catch (_) { _staffDir = { staff: [] }; }
  return _staffDir;
}

// ---- the chat's deal → its monday item ------------------------------------
// The caller may pass mondayBoardId / mondayItemId, but the pair that is READ is
// always the one stored on the chat's own deals row when that row exists. A
// caller can therefore never point the resolver at another client's item.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function mondayIdsForDeal(dealId, givenBoardId, givenItemId) {
  const p = getPool();
  if (p && dealId && UUID_RE.test(String(dealId))) {
    try {
      const r = await p.query(`SELECT monday_board_id, monday_item_id FROM deals WHERE id = $1`, [dealId]);
      const row = r.rows[0];
      if (row && row.monday_board_id && row.monday_item_id) {
        if (givenItemId && String(givenItemId) !== String(row.monday_item_id)) {
          console.error(`[wa-agent/facts] monday item ${givenItemId} does not belong to deal ${dealId}; using the deal's own item`);
        }
        return { boardId: String(row.monday_board_id), itemId: String(row.monday_item_id) };
      }
      // a real deal row with no monday item: read nothing rather than trust the caller
      if (row) return { boardId: null, itemId: null };
    } catch (e) { console.error('[wa-agent/facts] deals lookup failed:', e.message); }
  }
  return { boardId: givenBoardId ? String(givenBoardId) : null, itemId: givenItemId ? String(givenItemId) : null };
}

// ---- monday reads (allowlisted) -------------------------------------------
// Every query names exactly `cols` (from the allowlist) — no `column_values` without ids anywhere in this file.
const ITEM_QUERY =
  'query($ids:[ID!],$cols:[String!]){ items(ids:$ids){ id name column_values(ids:$cols){ id text value ' +
  '... on BoardRelationValue { linked_items { id board { id } } } } } }';

async function readItemColumns(boardId, itemId) {
  const board = ALLOWLIST.boards[String(boardId)];
  if (!board) return null; // board not allowlisted → nothing is read
  const ids = Object.values(board.columns).filter(Boolean);
  const data = await monday.readQuery(ITEM_QUERY, { ids: [String(itemId)], cols: ids });
  const item = data && data.items && data.items[0];
  if (!item) return null;
  const byId = {};
  for (const cv of item.column_values || []) byId[cv.id] = { text: cv.text, value: cv.value, linked_items: cv.linked_items || null };
  const out = { id: item.id, name: item.name, cols: {} };
  for (const [key, colId] of Object.entries(board.columns)) if (colId) out.cols[key] = byId[colId] || { text: '', value: null };
  return out;
}

// Ids of the items a board_relation column points at. `linked_items` (typed
// fragment) is preferred; the raw value JSON {linkedPulseIds:[{linkedPulseId}]}
// is the fallback. Only items on the given board are returned.
function linkedIds(cv, onlyBoardId) {
  const want = onlyBoardId ? String(onlyBoardId) : null;
  if (cv && Array.isArray(cv.linked_items) && cv.linked_items.length) {
    return cv.linked_items
      .filter((li) => li && li.id && (!want || !li.board || String(li.board.id) === want))
      .map((li) => String(li.id));
  }
  try {
    const v = cv && cv.value ? JSON.parse(cv.value) : null;
    return (v && Array.isArray(v.linkedPulseIds)) ? v.linkedPulseIds.map((x) => String(x.linkedPulseId)).filter(Boolean) : [];
  } catch (_) { return []; }
}

async function readPayments(paymentItemIds) {
  if (!paymentItemIds.length) return [];
  const board = ALLOWLIST.boards[PAYMENTS_BOARD];
  const cols = Object.values(board.columns).filter(Boolean);
  const data = await monday.readQuery(ITEM_QUERY, { ids: paymentItemIds.slice(0, 100), cols });
  const rows = [];
  for (const item of (data && data.items) || []) {
    const byId = {};
    for (const cv of item.column_values || []) byId[cv.id] = cv.text || '';
    const c = board.columns;
    rows.push({
      id: item.id,
      label: byId[c.label] || '',
      status: byId[c.status] || '',
      amount: num(byId[c.amount]),
      dueDate: byId[c.dueDate] || '',
      dueText: byId[c.dueText] || '',
      remaining: num(byId[c.remaining]),
    });
  }
  const prefix = board.apartmentPaymentPrefix;
  const paid = new Set(board.paidStatuses);
  return rows
    .filter((r) => r.label.startsWith(prefix))
    .map((r) => ({ ...r, paid: paid.has(r.status) }))
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
}

function num(s) {
  if (s == null || s === '') return null;
  const n = Number(String(s).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function nonEmpty(cv) { return cv && cv.text && String(cv.text).trim() ? String(cv.text).trim() : null; }
function isFutureDate(d) { return d && d >= new Date().toISOString().slice(0, 10); }

// Same matching order as lib/responsible.js matchStaffByName (kept local so this
// module does not pull in the groups/ingest DB modules):
//   1) full name  2) unique surname  3) first name only, never the partner
//      (inAllGroups) — so a lone "Yaakov" means Hershkovitz, not Epstein.
// A person column that lists several people ("Yaakov Epstein, Shayna Kovan")
// prefers the non-partner, who is the one actually handling the file.
function staffDisplayName(personText) {
  const t = String(personText || '').toLowerCase().trim();
  if (!t) return null;
  const staff = staffDir().staff || [];
  const norm = (s) => String(s || '').toLowerCase().trim();
  const pick = (list) => (list.find((s) => !s.inAllGroups) || list[0] || null);
  // 1) full name
  const full = staff.filter((s) => { const n = norm(s.name); return n && t.includes(n); });
  if (full.length) return pick(full).name;
  // 2) surname (unique surnames; avoids the two-Yaakovs problem)
  const bySurname = staff.filter((s) => { const last = norm(s.name).split(/\s+/).pop(); return last && last.length >= 3 && t.includes(last); });
  if (bySurname.length) return pick(bySurname).name;
  // 3) first name only — only among non-partner staff, and only when unique
  const byFirst = staff.filter((s) => { if (s.inAllGroups) return false; const first = norm(s.name).split(/\s+/)[0]; return first && first.length >= 2 && t.includes(first); });
  if (byFirst.length === 1) return byFirst[0].name;
  return null;
}

// ---- LAWLY-side facts (deals / deal_items) --------------------------------
async function lawlyFacts(dealId) {
  const p = getPool();
  if (!p || !dealId) return {};
  const out = {};
  try {
    const d = await p.query(`SELECT blocking_on, next_action, status FROM deals WHERE id = $1`, [dealId]);
    const row = d.rows[0];
    if (row && row.blocking_on) out.waiting_on = { value: String(row.blocking_on).slice(0, 200), source: 'lawly:deals.blocking_on' };
  } catch (_) { /* column may not exist on older schemas */ }
  try {
    const it = await p.query(
      `SELECT text, updated_at FROM deal_items
       WHERE deal_id = $1 AND party = 'firm' AND status = 'done' AND updated_at > now() - interval '14 days'
       ORDER BY updated_at DESC LIMIT 1`, [dealId]);
    const row = it.rows[0];
    if (row && row.text) out.last_firm_action = { value: String(row.text).slice(0, 200), source: 'lawly:deal_items', as_of: row.updated_at };
  } catch (_) { /* ignore */ }
  return out;
}

// ---- the resolver ---------------------------------------------------------
async function resolveFacts({ dealId, slotsWanted, mondayBoardId, mondayItemId, lang = 'en', documentHint = '' } = {}) {
  const wanted = new Set(Array.isArray(slotsWanted) ? slotsWanted : []);
  const slots = {};
  const context = {};
  const unfillable = [];
  const mark = (name, value, source, extra) => { if (wanted.has(name)) slots[name] = Object.assign({ value, source }, extra || {}); };

  // One deal per call: the monday item is the one on the chat's deals row.
  const ids = await mondayIdsForDeal(dealId, mondayBoardId, mondayItemId);
  const board = ids.boardId ? ALLOWLIST.boards[String(ids.boardId)] : null;
  let item = null;
  if (board && ids.itemId && monday.isConfigured()) {
    try { item = await readItemColumns(ids.boardId, ids.itemId); } catch (e) { console.error('[wa-agent/facts] monday read failed:', e.message); }
  }
  const src = (key) => `${board ? board.name : ids.boardId}:${board && board.columns[key]}`;
  const c = item ? item.cols : {};

  if (item) {
    context.stage = nonEmpty(c.stage) || null;                 // context only — never a slot
    const para = staffDisplayName(nonEmpty(c.paralegal));
    if (para) mark('responsible_staff', para, src('paralegal'));

    // dates
    const planned = nonEmpty(c.signingPlanned), actual = nonEmpty(c.signingActual);
    if (actual) mark('signing_date', actual, src('signingActual'), { state: 'signed' });
    else if (planned && isFutureDate(planned.slice(0, 10))) mark('signing_date', planned, src('signingPlanned'), { state: 'scheduled' });
    if (nonEmpty(c.deliveryDate)) mark('delivery_date', nonEmpty(c.deliveryDate), src('deliveryDate'));

    // apartment id — only what is filled
    const apt = {};
    for (const k of ['aptNumber', 'building', 'floor', 'address', 'projectNameEn', 'aptDescriptionEn']) if (nonEmpty(c[k])) apt[k] = nonEmpty(c[k]);
    if (Object.keys(apt).length) mark('apartment_id', apt, `${board.name}:apartment columns`);

    // document status — only the column matching the hint. The hint is the
    // classifier's free-text note ("client asks about the KYC form"), so the
    // match is: does the note mention this doc key's word (kyc, notary, …)?
    const docKeys = Object.keys(c).filter((k) => k.startsWith('doc'));
    const hint = String(documentHint || '').toLowerCase().replace(/[^a-z]/g, '');
    const pickDoc = hint ? docKeys.find((k) => { const word = k.slice(3).toLowerCase(); return word.length >= 3 && hint.includes(word); }) : null;
    if (board.kind === 'will' && nonEmpty(c.stage)) mark('document_status', { stage: nonEmpty(c.stage) }, src('stage'));
    else if (pickDoc && nonEmpty(c[pickDoc])) mark('document_status', { document: pickDoc, status: nonEmpty(c[pickDoc]) }, src(pickDoc));

    // registration
    if (nonEmpty(c.registeredDate)) mark('registration_status', { registered_on: nonEmpty(c.registeredDate) }, src('registeredDate'));
    else if (nonEmpty(c.registeredInTabu) || nonEmpty(c.registrationProgress)) mark('registration_status', { status: nonEmpty(c.registeredInTabu) || nonEmpty(c.registrationProgress) }, src('registeredInTabu'));

    // tax — statuses and dates; the outstanding figure only if the voucher went out
    const tax = {};
    if (nonEmpty(c.taxReported)) tax.reported = nonEmpty(c.taxReported);
    if (nonEmpty(c.taxPaid)) tax.paid = nonEmpty(c.taxPaid);
    if (nonEmpty(c.taxVoucherSentDate)) tax.voucher_sent_on = nonEmpty(c.taxVoucherSentDate);
    if (nonEmpty(c.taxAssessmentClosed)) tax.assessment_closed_on = nonEmpty(c.taxAssessmentClosed);
    if (nonEmpty(c.taxVoucherSent) && /נשלח/.test(nonEmpty(c.taxVoucherSent)) && num(nonEmpty(c.taxOutstanding)) != null) tax.outstanding = num(nonEmpty(c.taxOutstanding));
    if (Object.keys(tax).length) mark('tax_status', tax, `${board.name}:tax columns`);

    // contact person — name/role text only
    const contact = nonEmpty(c.companyServiceContact) || nonEmpty(c.otherSideLawyer) || nonEmpty(c.companyLawyer);
    if (contact) mark('contact_person', contact.replace(/\S+@\S+|\+?\d[\d\s().-]{7,}\d/g, '').trim(), `${board.name}:contact columns`);

    // payments
    const needPay = ['next_payment_amount', 'next_payment_due', 'payment_schedule', 'balance'].some((s) => wanted.has(s));
    if (needPay) {
      const payIds = linkedIds(c.paymentsLink, PAYMENTS_BOARD);
      let rows = [];
      try { rows = payIds.length ? await readPayments(payIds) : []; } catch (e) { console.error('[wa-agent/facts] payments read failed:', e.message); }
      const indexLinked = /יש מדד|כן/.test(nonEmpty(c.indexLinked) || '') && !!nonEmpty(c.indexLinked);
      const flags = indexLinked ? { index_linked: true } : {};
      const unpaid = rows.filter((r) => !r.paid);
      const next = unpaid[0];
      if (next && next.amount != null) mark('next_payment_amount', next.amount, `תשלומים:${next.id}.numbers__1`, flags);
      if (next && (next.dueDate || next.dueText)) mark('next_payment_due', next.dueDate || next.dueText, `תשלומים:${next.id}.date4`);
      const expected = num(nonEmpty(c.paymentCount));
      if (rows.length && (expected == null || expected === rows.length)) {
        mark('payment_schedule', rows.map((r) => ({ label: r.label, amount: r.amount, due: r.dueDate || r.dueText, status: r.status })), 'תשלומים:linked rows', flags);
      }
      const bal = unpaid.reduce((s, r) => s + (r.remaining != null ? r.remaining : (r.amount || 0)), 0);
      if (unpaid.length) mark('balance', bal, 'תשלומים:sum(remaining) over unpaid', flags);
    }
  }

  // LAWLY-side
  if (wanted.has('waiting_on') || wanted.has('last_firm_action')) {
    const lf = await lawlyFacts(dealId);
    if (lf.waiting_on) mark('waiting_on', lf.waiting_on.value, lf.waiting_on.source);
    if (lf.last_firm_action) mark('last_firm_action', lf.last_firm_action.value, lf.last_firm_action.source, { as_of: lf.last_firm_action.as_of });
  }

  // Static slots come from the Answer Bank (AB-03 / AB-04) — handled by compose via the entry; not resolved here.
  for (const s of wanted) if (!(s in slots)) unfillable.push(s);
  return { slots, unfillable, context };
}

module.exports = { resolveFacts, readItemColumns, readPayments, staffDisplayName, linkedIds, ITEM_QUERY };
