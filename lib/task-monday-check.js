// ============================================================
// lib/task-monday-check.js — Task Hub step 3: "is this reminder already done
// in monday?" No AI anywhere in this file.
//
// The automatic reminder emails (group A in task_hub_types) are done when a
// monday column says so. WHICH column and WHICH labels count as done live in
// the table, in task_hub_types.monday_rules (sql/2026-10-task-hub-monday-rules.sql),
// so they can be changed in Neon without a deploy. Shape:
//
//   { "boards": { "<deal board id>": [ { "col": "<column id>", "done": ["label", ...] } ] },
//     "kyc_board": true }      // optional: also look at the KYC board
//
// A deal counts as done when ANY rule for its board matches (or, with
// kyc_board, when every KYC-board item linked to the deal is signed).
//
// Finding the deal: the reminder subject carries the deal / client name.
// It must match exactly ONE item — on a deal board, or on the clients board
// with exactly one linked deal. Anything ambiguous: no link, never a guess,
// and the task simply stays open as before.
// ============================================================

const API = 'https://api.monday.com/v2';
const { clientKey } = require('./task-types');

const DEAL_BOARDS = ['1603266152', '1772652154'];     // קבלן, יד 2
const CLIENTS_BOARD = '1603266147';                   // לקוחות
const CLIENT_DEAL_LINKS = [                           // לקוחות -> deal (buyer 1/2/3)
  'link_to_________________1', 'board_relation7__1', 'board_relation59__1',   // קבלן
  'connect_boards_mkmf523n', 'connect_boards_mkmf3bsy', 'connect_boards_mkmfnab9' // יד 2
];
const KYC_BOARD = '2015256149';                       // שאלון הכרת הלקוח
const KYC_COLS = {
  deal: 'board_relation_mks86e0y',   // קישור לעסקה
  status: 'color_mks8p04e',          // הכרת הלקוח
  signedClient: 'file_mks9bfwm',     // מסמך חתום ע"י לקוח
  signedBoth: 'file_mm1c9cbk'        // מסמך חתום ע"י יעקב ולקוח
};
const KYC_DONE_STATUS = ['נחתם ע"י לקוח', 'שמור בתקייה', 'לא נצרך'];
const KYC_IGNORE_STATUS = ['בוטל ע"י לקוח'];

const TIMEOUT_MS = Math.max(5000, parseInt(process.env.MONDAY_TIMEOUT_MS || '15000', 10));

// Swappable for tests.
let _gql = async function gql(query, variables) {
  const token = process.env.MONDAY_API_TOKEN || '';
  if (!token) throw new Error('MONDAY_API_TOKEN is not set');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(API, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: token, 'Content-Type': 'application/json', 'API-Version': '2024-10' },
      body: JSON.stringify({ query, variables: variables || {} })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('monday HTTP ' + r.status);
    if (j.errors) throw new Error('monday: ' + JSON.stringify(j.errors).slice(0, 300));
    return j.data;
  } finally { clearTimeout(timer); }
};
function _setGql(fn) { _gql = fn; _dealCache.clear(); _kycCache = null; }

function hasRules(type) {
  const r = type && type.monday_rules;
  return !!(r && ((r.boards && Object.keys(r.boards).length) || r.kyc_board));
}

// ---- finding the deal ------------------------------------------------------
const DEAL_CACHE_MS = 60 * 60 * 1000;
const _dealCache = new Map(); // clientKey -> { at, deal|null }

async function searchByName(boardId, text) {
  const d = await _gql(
    `query($b:[ID!],$t:CompareValue!){ boards(ids:$b){ items_page(limit:25, query_params:{rules:[{column_id:"name", compare_value:$t, operator:contains_text}]}){ items{ id name } } } }`,
    { b: [boardId], t: [text] });
  const b = d && d.boards && d.boards[0];
  return (b && b.items_page && b.items_page.items) || [];
}

function pickOne(items, wantKey) {
  const exact = items.filter((it) => clientKey(it.name) === wantKey);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;          // two deals with the same name: don't guess
  return items.length === 1 ? items[0] : null; // a single "contains" hit is also safe
}

// Returns { id, board } or null.
async function findDeal(text) {
  const key = clientKey(text);
  if (!key || key.length < 3) return null;
  const hit = _dealCache.get(key);
  if (hit && Date.now() - hit.at < DEAL_CACHE_MS) return hit.deal;

  let deal = null;
  // 1. A deal whose name matches, on either deal board.
  const found = [];
  for (const b of DEAL_BOARDS) {
    for (const it of await searchByName(b, String(text).trim())) found.push({ id: String(it.id), name: it.name, board: b });
  }
  deal = pickOne(found, key);
  // 2. Otherwise a client with exactly one linked deal.
  if (!deal && !found.length) {
    const clients = await searchByName(CLIENTS_BOARD, String(text).trim());
    const client = pickOne(clients, key);
    if (client) {
      const d = await _gql(
        `query($ids:[ID!],$c:[String!]){ items(ids:$ids){ column_values(ids:$c){ id ... on BoardRelationValue { linked_item_ids } } } }`,
        { ids: [String(client.id)], c: CLIENT_DEAL_LINKS });
      const linked = new Map();
      for (const cv of ((d.items && d.items[0] && d.items[0].column_values) || [])) {
        const board = /^(connect_boards_mkmf)/.test(cv.id) ? DEAL_BOARDS[1] : DEAL_BOARDS[0];
        for (const id of (cv.linked_item_ids || [])) linked.set(String(id), board);
      }
      if (linked.size === 1) {
        const [id, board] = [...linked.entries()][0];
        deal = { id, board };
      }
    }
  }
  _dealCache.set(key, { at: Date.now(), deal: deal ? { id: deal.id, board: deal.board } : null });
  return deal ? { id: deal.id, board: deal.board } : null;
}

// ---- reading the deal --------------------------------------------------------
const KYC_CACHE_MS = 10 * 60 * 1000;
let _kycCache = null; // { at, byDeal: Map(dealId -> [ {done, ignored} ]) }

async function kycByDeal() {
  if (_kycCache && Date.now() - _kycCache.at < KYC_CACHE_MS) return _kycCache.byDeal;
  const cols = [KYC_COLS.deal, KYC_COLS.status, KYC_COLS.signedClient, KYC_COLS.signedBoth];
  const fields = `items{ id column_values(ids:${JSON.stringify(cols)}){ id text ... on BoardRelationValue { linked_item_ids } } }`;
  const byDeal = new Map();
  function add(items) {
    for (const it of items || []) {
      const cv = {}; const links = [];
      for (const c of it.column_values || []) {
        cv[c.id] = (c.text || '').trim();
        if (c.id === KYC_COLS.deal) (c.linked_item_ids || []).forEach((x) => links.push(String(x)));
      }
      const status = cv[KYC_COLS.status] || '';
      const entry = {
        ignored: KYC_IGNORE_STATUS.indexOf(status) !== -1,
        done: KYC_DONE_STATUS.indexOf(status) !== -1 || !!cv[KYC_COLS.signedClient] || !!cv[KYC_COLS.signedBoth]
      };
      links.forEach((dealId) => { if (!byDeal.has(dealId)) byDeal.set(dealId, []); byDeal.get(dealId).push(entry); });
    }
  }
  let d = await _gql(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:500){ cursor ${fields} } } }`, { b: [KYC_BOARD] });
  let page = d.boards && d.boards[0] && d.boards[0].items_page;
  for (let guard = 0; page && guard < 10; guard++) {
    add(page.items);
    if (!page.cursor) break;
    d = await _gql(`query($c:String!){ next_items_page(limit:500, cursor:$c){ cursor ${fields} } }`, { c: page.cursor });
    page = d.next_items_page;
  }
  _kycCache = { at: Date.now(), byDeal };
  return byDeal;
}

// deals: [{ id, board }], rulesFor(deal) -> monday_rules object.
// Returns Map(dealId -> { done, evidence }). A deal that couldn't be read is
// simply absent (unknown never closes anything).
async function checkDeals(deals, rulesFor) {
  const out = new Map();
  const byBoard = new Map();
  for (const deal of deals) {
    const rules = rulesFor(deal) || {};
    const list = (rules.boards && rules.boards[deal.board]) || [];
    if (!byBoard.has(deal.board)) byBoard.set(deal.board, { ids: new Set(), cols: new Set() });
    const g = byBoard.get(deal.board);
    g.ids.add(deal.id); list.forEach((r) => g.cols.add(r.col));
  }
  const values = new Map(); // dealId -> { colId: {text, title} }
  for (const [board, g] of byBoard) {
    const ids = [...g.ids];
    const cols = [...g.cols];
    for (let i = 0; i < ids.length; i += 50) {
      const d = await _gql(
        `query($ids:[ID!],$c:[String!]){ items(ids:$ids){ id column_values(ids:$c){ id text column{ title } } } }`,
        { ids: ids.slice(i, i + 50), c: cols.length ? cols : ['name'] });
      for (const it of (d.items || [])) {
        const m = {};
        for (const c of it.column_values || []) m[c.id] = { text: (c.text || '').trim(), title: (c.column && c.column.title) || c.id };
        values.set(String(it.id), m);
      }
    }
  }
  let kyc = null;
  for (const deal of deals) {
    const rules = rulesFor(deal) || {};
    const v = values.get(deal.id);
    if (!v) continue; // deleted / not readable: unknown
    let res = { done: false, evidence: null };
    for (const r of ((rules.boards && rules.boards[deal.board]) || [])) {
      const cell = v[r.col];
      if (cell && (r.done || []).indexOf(cell.text) !== -1) { res = { done: true, evidence: cell.title + ' = ' + cell.text }; break; }
    }
    if (!res.done && rules.kyc_board) {
      if (!kyc) kyc = await kycByDeal();
      const forms = (kyc.get(deal.id) || []).filter((f) => !f.ignored);
      if (forms.length && forms.every((f) => f.done)) res = { done: true, evidence: 'שאלון הכרת הלקוח: ' + forms.length + ' טפסים חתומים' };
    }
    out.set(deal.id, res);
  }
  return out;
}

function dealUrl(deal) {
  return deal ? 'https://epstein-law-firm.monday.com/boards/' + deal.board + '/pulses/' + deal.id : null;
}

module.exports = { hasRules, findDeal, checkDeals, dealUrl, _setGql, KYC_COLS, DEAL_BOARDS };
