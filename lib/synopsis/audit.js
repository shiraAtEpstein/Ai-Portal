'use strict';
// ============================================================
// lib/synopsis/audit.js — the record of what the synopsis feature did.
//
// Every read of a deal and every attempted write is recorded: who, when, which
// deal, which board and column, the value before, the value after, and — for a
// refusal — which gate refused it and why. Rejections are logged as carefully
// as successes; a write that was blocked is the more interesting record.
//
// Postgres when it is reachable, console otherwise. Never throws: a logging
// failure must not stop a paralegal from filling in a field, but it is
// reported so a silently-unlogged system cannot go unnoticed.
// ============================================================
const db = require('../../db');

let _ready = null;
function ensureTable() {
  const p = db.getPool();
  if (!p) return Promise.resolve(false);
  if (_ready) return _ready;
  _ready = p.query(
    'CREATE TABLE IF NOT EXISTS synopsis_audit (' +
    '  id           BIGSERIAL PRIMARY KEY,' +
    '  at           TIMESTAMPTZ NOT NULL DEFAULT now(),' +
    '  run_id       TEXT        NOT NULL,' +
    '  event        TEXT        NOT NULL,' +   // run.open | write.ok | write.rejected | error
    '  ok           BOOLEAN     NOT NULL,' +
    '  user_email   TEXT,' +
    '  user_id      BIGINT,' +
    '  roles        TEXT,' +
    '  deal_id      TEXT,' +
    '  deal_name    TEXT,' +
    '  field_key    TEXT,' +
    '  board_name   TEXT,' +
    '  board_id     TEXT,' +
    '  item_id      TEXT,' +
    '  column_id    TEXT,' +
    '  value_before TEXT,' +
    '  value_after  TEXT,' +
    '  reason       TEXT,' +
    '  detail       JSONB' +
    ')'
  ).then(() =>
    p.query('CREATE INDEX IF NOT EXISTS synopsis_audit_deal_idx ON synopsis_audit (deal_id, at DESC)')
  ).then(() =>
    p.query('CREATE INDEX IF NOT EXISTS synopsis_audit_run_idx ON synopsis_audit (run_id)')
  ).then(() => true)
   .catch((e) => { console.error('[synopsis] audit table unavailable:', e.message); _ready = null; return false; });
  return _ready;
}

const trunc = (v, n = 500) => (v === null || v === undefined ? null : String(v).slice(0, n));

/** Record one line. Fire-and-forget; never rejects. */
async function record(entry) {
  const line = {
    at: entry.at || new Date().toISOString(),
    runId: entry.runId || null,
    event: entry.event || (entry.ok ? 'write.ok' : 'write.rejected'),
    ok: !!entry.ok,
    user: entry.user || null,
    userId: entry.userId || null,
    roles: Array.isArray(entry.roles) ? entry.roles.join(',') : (entry.roles || null),
    dealId: entry.dealId || null,
    dealName: entry.dealName || null,
    fieldKey: entry.fieldKey || entry.proposal?.fieldKey || null,
    board: entry.board || null,
    boardId: entry.boardId ? String(entry.boardId) : null,
    itemId: entry.itemId ? String(entry.itemId) : null,
    columnId: entry.columnId || null,
    before: trunc(entry.before),
    after: trunc(entry.after ?? entry.proposal?.value),
    reason: entry.reason || null
  };

  // Always to the console, so there is a record even with no database.
  console.log('[synopsis]', JSON.stringify(line));

  try {
    if (!(await ensureTable())) return;
    await db.getPool().query(
      'INSERT INTO synopsis_audit (at, run_id, event, ok, user_email, user_id, roles, deal_id, deal_name,' +
      ' field_key, board_name, board_id, item_id, column_id, value_before, value_after, reason, detail)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
      [line.at, line.runId, line.event, line.ok, line.user, line.userId, line.roles, line.dealId,
       line.dealName, line.fieldKey, line.board, line.boardId, line.itemId, line.columnId,
       line.before, line.after, line.reason, entry.detail ? JSON.stringify(entry.detail) : null]);
  } catch (e) {
    console.error('[synopsis] audit write failed:', e.message);
  }
}

/** Recent lines, newest first. For the admin view. */
async function recent({ dealId = null, runId = null, limit = 100 } = {}) {
  if (!(await ensureTable())) return { rows: [], stored: false };
  const where = [], params = [];
  if (dealId) { params.push(String(dealId)); where.push('deal_id = $' + params.length); }
  if (runId)  { params.push(String(runId));  where.push('run_id = $' + params.length); }
  params.push(Math.min(Number(limit) || 100, 500));
  const r = await db.getPool().query(
    'SELECT at, run_id, event, ok, user_email, roles, deal_id, deal_name, field_key, board_name,' +
    ' item_id, column_id, value_before, value_after, reason FROM synopsis_audit' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY at DESC LIMIT $' + params.length, params);
  return { rows: r.rows, stored: true };
}

module.exports = { record, recent };
