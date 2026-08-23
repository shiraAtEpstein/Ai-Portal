'use strict';
// ============================================================
// lib/synopsis/write-gate.js — the ONLY place the synopsis feature writes to
// monday, and the only place in this feature a GraphQL *mutation* is issued.
// Everything else reads through monday.readQuery(), which rejects mutations.
//
// No model calls this. The synopsis agent (later phases) has no monday tools
// on its version row at all — it emits a JSON proposal and this validates it.
// Screens 1-3 have no model in the path whatsoever.
//
// Eight checks, in order. Any failure rejects, logs, and reports — never
// silently drops.
// ============================================================
const { can } = require('../permissions');

const API = 'https://api.monday.com/v2';
// The complete set of things this feature may ever do to monday. Reading is the
// other half, and it goes through monday.readQuery(), which refuses mutations.
// Deleting, archiving, moving, duplicating and creating items are not here, and
// a test asserts that no such mutation string exists anywhere in lib/synopsis.
const ALLOWED_ACTIONS = new Set(['update_column']);
const READ_ONLY = process.env.LAWLY_READ_ONLY === '1';

/** Format a value for monday, by the OWNING column's type. */
function formatValue(type, raw) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  switch (type) {
    case 'text':
    case 'long_text':
      if (typeof v !== 'string') throw new Error('expected text');
      if (v.length > 2000) throw new Error('text too long');
      return v;
    case 'numbers': {
      const n = Number(String(v).replace(/,/g, ''));
      if (!Number.isFinite(n)) throw new Error('expected a number');
      return String(n);
    }
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error('expected YYYY-MM-DD');
      return { date: String(v) };
    case 'status':
      if (typeof v !== 'string' || !v) throw new Error('expected a label');
      return { label: v };
    case 'dropdown':
      return { labels: Array.isArray(v) ? v : [String(v)] };
    case 'location':
      if (typeof v !== 'string' || !v) throw new Error('expected an address');
      return { address: v };
    case 'email':
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) throw new Error('expected an email address');
      return { email: String(v), text: String(v) };
    case 'phone':
      if (!/^[+0-9][0-9\-\s]{6,}$/.test(String(v))) throw new Error('expected a phone number');
      return { phone: String(v).replace(/[\s-]/g, ''), countryShortName: 'IL' };
    case 'board_relation': {
      const ids = (Array.isArray(v) ? v : [v]).map(x => Number(x)).filter(Number.isFinite);
      if (!ids.length) throw new Error('expected an item to link');
      return { item_ids: ids };
    }
    case 'file':
      throw new Error('files are uploaded on the monday item itself, not through this form');
    default:
      throw new Error('column type not writable through LAWLY: ' + type);
  }
}

/** The single mutation this feature issues. Kept here, beside the checks that guard it. */
async function sendUpdate(boardId, itemId, columnId, value) {
  if (READ_ONLY) return { readOnly: true, boardId, itemId, columnId, value };
  const token = process.env.MONDAY_API_TOKEN || '';
  if (!token) throw new Error('MONDAY_API_TOKEN is not set');
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Authorization': token, 'Content-Type': 'application/json', 'API-Version': '2024-10' },
    body: JSON.stringify({
      query: `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
                change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
              }`,
      variables: { boardId: String(boardId), itemId: String(itemId), columnId, value: JSON.stringify(value) }
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('monday HTTP ' + r.status);
  if (j.errors) throw new Error('monday: ' + JSON.stringify(j.errors).slice(0, 300));
  return j.data.change_column_value;
}

// Emptying a field IS an update: change_column_value with an empty value, the
// same call and the same permission as setting it to anything else. It is not a
// delete, it stays inside the one permitted action, and the mutation count does
// not change. What it does do is discard what was there, so it is only done when
// the caller asked for it in so many words, and the types where "empty" would be
// structural rather than textual refuse outright.
function emptyValue(type) {
  switch (type) {
    case 'text':
    case 'long_text':
    case 'numbers':
    case 'phone':
      return '';
    case 'date':     return {};
    case 'status':   return {};
    case 'dropdown': return { labels: [] };
    case 'email':    return { email: '', text: '' };
    case 'location': return { address: '' };
    case 'board_relation':
      throw new Error('קישור בין פריטים לא נמחק דרך הטופס — יש לנתק אותו במונדיי');
    case 'file':
      throw new Error('קבצים לא נמחקים דרך הטופס');
    default:
      throw new Error('לא ניתן לרוקן עמודה מסוג ' + type);
  }
}

/**
 * @param {object} proposal { action, fieldKey, value, clear? }
 * @param {object} ctx { map, dealId, dealBoardId, ownerItemIds, session, runId, before, log, write? }
 */
async function applyWrite(proposal, ctx) {
  const { map, dealId, dealBoardId, session, runId } = ctx;
  const audit = { runId, at: new Date().toISOString(),
                  user: session.email, userId: session.userId, roles: session.roles, proposal };

  // 1. schema
  if (!proposal || typeof proposal !== 'object') throw reject(audit, 'malformed proposal');
  const { action, fieldKey, value, clear } = proposal;

  // 2. action whitelist
  if (!ALLOWED_ACTIONS.has(action)) throw reject(audit, `action "${action}" is not permitted`);

  // 3. the field must be on the audited column map.
  //    Payment cells are `payment:<itemId>:<columnId>` and are checked against
  //    the payments whitelist — the same rule, expressed for a list.
  let field;
  if (String(fieldKey).startsWith('payment:')) {
    const [, itemId, columnId] = String(fieldKey).split(':');
    const col = (map.payments?.columns || []).find(c => c.id === columnId);
    if (!col) throw reject(audit, `column "${columnId}" is not on the payments whitelist`);
    if (!/^\d+$/.test(String(itemId))) throw reject(audit, 'bad payment item id');
    field = { key: fieldKey, label: col.label, owner: 'payments', group: 'payments',
              writable: !!col.writable, ownerColumnId: col.id, ownerType: col.type,
              type: col.type, _paymentItemId: itemId };
  } else {
    field = map.fields.find(f => f.key === fieldKey);
  }
  if (!field) throw reject(audit, `unknown field "${fieldKey}"`);

  // 4. writable, and we must know which column on the owning board to target
  if (!field.writable)
    throw reject(audit, `"${field.label}" is read-only (${(map.boards[field.owner] || {}).name || map.payments?.boardName})`);
  if (!field.ownerColumnId)
    throw reject(audit, `"${field.label}" has no mapped column on ${map.boards[field.owner].name} yet`);

  // 5. capability — the portal's own permission layer, not a second role table
  if (!can(session.roles, 'monday', 'write_own'))
    throw reject(audit, `your roles (${(session.roles || []).join(', ') || 'none'}) may not write to monday`);

  // 6. route to the board that OWNS the field — never to the mirror on the deal
  const ownerBoardId = field.owner === 'payments' ? map.payments.board : map.boards[field.owner].id;
  const targetItemId = field.owner === 'payments' ? field._paymentItemId
                     : field.owner === 'deal'     ? dealId
                     : ctx.ownerItemIds?.[field.owner];
  if (!targetItemId)
    throw reject(audit, `this deal has no linked ${map.boards[field.owner].name} item — ` +
                        `"${field.label}" cannot be written until it is linked`);
  if (field.owner === 'deal' && String(ownerBoardId) !== String(dealBoardId))
    throw reject(audit, 'deal board mismatch');

  // 7. value type and format, against the OWNING column's type
  let formatted;
  if (clear === true) {
    // Refuse to "clear" something that is already empty: that is not a change,
    // and letting it through would fill the log with writes that did nothing.
    const had = ctx.before?.[fieldKey];
    if (had === undefined || had === null || String(had).trim() === '')
      throw reject(audit, `"${field.label}" כבר ריק`);
    try { formatted = emptyValue(field.ownerType || field.type); }
    catch (e) { throw reject(audit, `${field.label}: ${e.message}`); }
  } else {
    try { formatted = formatValue(field.ownerType || field.type, value); }
    catch (e) { throw reject(audit, `${field.label}: ${e.message}`); }
  }

  // 8. write, attributed to the signed-in person, before + after logged
  const write = ctx.write || sendUpdate;
  const result = await write(ownerBoardId, targetItemId, field.ownerColumnId, formatted);

  const entry = { ...audit, ok: true, event: clear === true ? 'write.emptied' : 'write.ok',
                  board: (map.boards[field.owner] || {}).name || map.payments?.boardName,
                  boardId: ownerBoardId,
                  itemId: targetItemId, columnId: field.ownerColumnId,
                  before: ctx.before?.[fieldKey] ?? null,
                  after: clear === true ? '' : value, result };
  // Logging must never break a write that already succeeded, nor be silently
  // skipped: report the failure and carry on.
  try {
    if (typeof ctx.log === 'function') ctx.log(entry);
    else console.error('[synopsis] no logger passed to applyWrite — write NOT recorded:',
                       JSON.stringify(entry));
  } catch (e) {
    console.error('[synopsis] logging failed for a successful write:', e.message,
                  JSON.stringify(entry));
  }
  return entry;
}

function reject(audit, reason) {
  const err = new Error(reason);
  err.audit = { ...audit, ok: false, reason };
  err.rejected = true;
  return err;
}

module.exports = { emptyValue, applyWrite, formatValue, ALLOWED_ACTIONS, READ_ONLY };
