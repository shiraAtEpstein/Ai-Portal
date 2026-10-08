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

const WILLS_BOARD = '5096606714';                     // צוואות (one item per will file)
const DEAL_BOARDS = ['1603266152', '1772652154', WILLS_BOARD]; // קבלן, יד 2, צוואות
const CLIENTS_BOARD = '1603266147';                   // לקוחות
// 8 Oct (Shira: will tasks were linked to the client's apartment deal): the
// wills board links TO the clients board (לקוח 1 / לקוח 2) but the clients
// board has no link back, so will files are found from the wills board itself:
// its client links, and the client email typed at intake.
const WILLS_COLS = {
  client1: 'board_relation_mm3fap19',   // לקוח 1
  client2: 'board_relation_mm3f8594',   // לקוח 2
  intakeEmail: 'text_mm3es5tj'          // INTAKE מייל לקוח
};
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
function _setGql(fn) { _gql = fn; _dealCache.clear(); _boardCache.clear(); _nameCache.clear(); _clientIndex = null; _kycCache = null; }

// Which deals fit the task (8 Oct). kind:
//   'wills'      - a will task: only will files (never the client's apartment deal)
//   'realestate' - an apartment task: apartment deals; will files only if that's all there is
//   anything else - all deals, as before
function forKind(deals, kind) {
  if (!deals || !deals.length || !kind) return deals || [];
  const wills = deals.filter((d) => String(d.board) === WILLS_BOARD);
  if (kind === 'wills') return wills;
  if (kind === 'realestate') { const re = deals.filter((d) => String(d.board) !== WILLS_BOARD); return re.length ? re : deals; }
  return deals;
}

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

function pickOne(items, wantKey, hint, out) {
  const exact = items.filter((it) => clientKey(it.name) === wantKey);
  if (exact.length === 1) return exact[0];
  const pool = exact.length > 1 ? exact : items;           // same name twice: only if the text says which
  if (pool.length === 1) return pool[0];                  // a single "contains" hit is also safe
  const picked = pickByHint(pool, hint);
  if (!picked && out && pool.length > 1 && pool.length <= 5) out.candidates = pool;
  return picked;
}

// Several deals for the same client (e.g. "דירה 115" and "דירה 116"): pick
// one ONLY if the email/task text names something that only that deal's
// name has (an apartment number, a project word). Otherwise null.
function nameTokens(name) {
  return String(name || '').toLowerCase().replace(/[֑-ׇ]/g, '')
    .split(/[^0-9a-zא-ת]+/).filter((w) => /^\d+$/.test(w) || w.length >= 3);
}
function pickByHint(items, hint) {
  if (!hint || !items || items.length < 2) return null;
  const text = ' ' + String(hint).toLowerCase().replace(/[֑-ׇ]/g, '').replace(/[^0-9a-zא-ת]+/g, ' ') + ' ';
  const toks = items.map((it) => nameTokens(it.name));
  const common = toks.reduce((acc, t) => acc.filter((w) => t.indexOf(w) !== -1));
  const hits = items.filter((it, i) => toks[i].some((w) => common.indexOf(w) === -1 && text.indexOf(' ' + w + ' ') !== -1));
  return hits.length === 1 ? hits[0] : null;
}

// Returns { id, board, name } or null. `hint` (optional) is the email
// subject / task text, used only to choose between several deals.
// `out` (optional): when several deals fit and nothing says which,
// out.candidates is set to them (for the "choose a deal" button).
async function findDeal(text, hint, out, kind) {
  const key = clientKey(text);
  if (!key || key.length < 3) return null;
  const cacheKey = key + '|' + clientKey(hint || '').slice(0, 80) + '|' + (kind || '');
  const hit = _dealCache.get(cacheKey);
  if (hit && Date.now() - hit.at < DEAL_CACHE_MS) {
    if (!hit.deal && hit.candidates && out) out.candidates = hit.candidates;
    return hit.deal;
  }
  const local = {};

  let deal = null;
  // 1. A deal whose name matches, on either deal board.
  const found = [];
  for (const b of DEAL_BOARDS) {
    if (kind === 'wills' && b !== WILLS_BOARD) continue;
    for (const it of await searchByName(b, String(text).trim())) found.push({ id: String(it.id), name: it.name, board: b });
  }
  const fit = forKind(found, kind);
  deal = pickOne(fit, key, hint, local);
  // 2. Otherwise a client with exactly one linked deal.
  if (!deal && !fit.length) {
    const clients = await searchByName(CLIENTS_BOARD, String(text).trim());
    const client = pickOne(clients, key);
    if (client) {
      const d = await _gql(
        `query($ids:[ID!],$c:[String!]){ items(ids:$ids){ column_values(ids:$c){ id ... on BoardRelationValue { linked_item_ids } } } }`,
        { ids: [String(client.id)], c: CLIENT_DEAL_LINKS });
      const linked = new Map();
      for (const cv of ((d.items && d.items[0] && d.items[0].column_values) || [])) {
        for (const id of (cv.linked_item_ids || [])) linked.set(String(id), boardForLink(cv.id));
      }
      // the client's will files (the wills board links to the client, not back)
      const wills = (await clientIndex().then(() => _willsByClient.get(String(client.id))).catch(() => null)) || [];
      wills.forEach((id) => linked.set(String(id), WILLS_BOARD));
      deal = await chooseDeal(forKind([...linked.entries()].map(([id, board]) => ({ id, board })), kind), hint, local);
    }
  }
  const res = deal ? { id: String(deal.id), board: String(deal.board), name: deal.name || null } : null;
  const candidates = (!res && local.candidates) ? local.candidates.map((d) => ({ id: String(d.id), board: String(d.board), name: d.name || null })) : null;
  _dealCache.set(cacheKey, { at: Date.now(), deal: res, candidates: candidates });
  if (candidates && out) out.candidates = candidates;
  return res;
}

// 6 Oct: every deal of the clients with these email addresses (for matching a
// staff member's sent email to the tasks of that client's deals).
async function dealsForAddresses(addresses) {
  if (!addresses || !addresses.length) return [];
  const idx = await clientIndex();
  const out = new Set();
  for (const a of addresses) {
    const m = idx.get(String(a).toLowerCase());
    if (m) for (const id of m.keys()) out.add(String(id));
  }
  return [...out];
}

// 6 Oct: the "link to a deal" search box on a task card. Deal names on the
// deal boards (8 Oct: wills too) that contain the text (up to 15).
async function searchDeals(q) {
  const text = String(q || '').trim();
  if (text.length < 2) return [];
  const out = [];
  for (const b of DEAL_BOARDS) {
    for (const it of await searchByName(b, text)) out.push({ id: String(it.id), board: b, name: it.name });
  }
  return out.slice(0, 15);
}

// A deal id chosen from the search: must be an item on one of the deal boards.
async function verifyDeal(id) {
  const board = await boardOf(String(id));
  if (!board || DEAL_BOARDS.indexOf(String(board)) === -1) return null;
  const names = await dealNames([String(id)]);
  return { id: String(id), board: String(board), name: names.get(String(id)) || null };
}

function boardForLink(colId) { return /^connect_boards_mkmf/.test(colId) ? DEAL_BOARDS[1] : DEAL_BOARDS[0]; }

// One deal -> it. Several -> fetch their names and use the hint. None -> null.
async function chooseDeal(deals, hint, out) {
  if (!deals.length) return null;
  const names = await dealNames(deals.map((d) => d.id));
  const withNames = deals.filter((d) => names.has(d.id)).map((d) => ({ id: d.id, board: d.board, name: names.get(d.id) }));
  if (withNames.length === 1) return withNames[0];
  const picked = pickByHint(withNames, hint);
  if (!picked && out && withNames.length > 1 && withNames.length <= 5) out.candidates = withNames;
  return picked;
}

const _nameCache = new Map(); // dealId -> name
async function dealNames(ids) {
  const want = [...new Set(ids.map(String))].filter((id) => !_nameCache.has(id));
  for (let i = 0; i < want.length; i += 50) {
    const d = await _gql(`query($ids:[ID!]){ items(ids:$ids){ id name state } }`, { ids: want.slice(i, i + 50) });
    for (const it of (d.items || [])) if (it.state !== 'deleted') _nameCache.set(String(it.id), it.name);
  }
  const out = new Map();
  ids.forEach((id) => { if (_nameCache.has(String(id))) out.set(String(id), _nameCache.get(String(id))); });
  return out;
}

// ---- finding the deal from email addresses (the strongest signal) ------------
// The clients board (לקוחות) holds each client's email and their deals
// (buyer 1/2/3 on קבלן and יד 2). Read once and cached for 30 minutes.
const FIRM_DOMAIN = /@epsteinlaw\.co\.il$/i;
const CLIENT_EMAIL_COL = 'contact_email';
const CLIENT_INDEX_MS = 30 * 60 * 1000;
let _clientIndex = null; // { at, byEmail: Map(email -> Map(dealId -> board)) }
let _willsByClient = new Map(); // client item id -> [will item ids]

async function clientIndex() {
  if (_clientIndex && Date.now() - _clientIndex.at < CLIENT_INDEX_MS) return _clientIndex.byEmail;
  const cols = [CLIENT_EMAIL_COL].concat(CLIENT_DEAL_LINKS);
  const fields = `items{ id column_values(ids:${JSON.stringify(cols)}){ id text ... on BoardRelationValue { linked_item_ids } } }`;
  const byEmail = new Map();
  const emailsOf = new Map(); // client id -> emails (for the will files below)
  function add(items) {
    for (const it of items || []) {
      let emails = []; const deals = new Map();
      for (const c of it.column_values || []) {
        if (c.id === CLIENT_EMAIL_COL) emails = String(c.text || '').toLowerCase().split(/[\s,;]+/).filter((e) => /@/.test(e));
        else (c.linked_item_ids || []).forEach((id) => deals.set(String(id), boardForLink(c.id)));
      }
      if (emails.length) emailsOf.set(String(it.id), emails);
      if (!deals.size) continue;
      for (const e of emails) {
        if (!byEmail.has(e)) byEmail.set(e, new Map());
        deals.forEach((b, id) => byEmail.get(e).set(id, b));
      }
    }
  }
  let d = await _gql(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:500){ cursor ${fields} } } }`, { b: [CLIENTS_BOARD] });
  let page = d.boards && d.boards[0] && d.boards[0].items_page;
  for (let guard = 0; page && guard < 20; guard++) {
    add(page.items);
    if (!page.cursor) break;
    d = await _gql(`query($c:String!){ next_items_page(limit:500, cursor:$c){ cursor ${fields} } }`, { c: page.cursor });
    page = d.next_items_page;
  }
  // Will files: each one's clients (their emails from the clients board) and the
  // intake email. A failure here leaves will files out, never the apartment deals.
  const willsByClient = new Map();
  try {
    const wcols = [WILLS_COLS.client1, WILLS_COLS.client2, WILLS_COLS.intakeEmail];
    const wfields = `items{ id state column_values(ids:${JSON.stringify(wcols)}){ id text ... on BoardRelationValue { linked_item_ids } } }`;
    const addWill = (items) => {
      for (const it of items || []) {
        if (it.state === 'deleted') continue;
        const emails = new Set();
        for (const c of it.column_values || []) {
          if (c.id === WILLS_COLS.intakeEmail) String(c.text || '').toLowerCase().split(/[\s,;]+/).filter((e) => /@/.test(e)).forEach((e) => emails.add(e));
          else (c.linked_item_ids || []).forEach((cid) => {
            cid = String(cid);
            if (!willsByClient.has(cid)) willsByClient.set(cid, []);
            willsByClient.get(cid).push(String(it.id));
            (emailsOf.get(cid) || []).forEach((e) => emails.add(e));
          });
        }
        for (const e of emails) {
          if (FIRM_DOMAIN.test(e)) continue;
          if (!byEmail.has(e)) byEmail.set(e, new Map());
          byEmail.get(e).set(String(it.id), WILLS_BOARD);
        }
      }
    };
    let w = await _gql(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:500){ cursor ${wfields} } } }`, { b: [WILLS_BOARD] });
    let wp = w.boards && w.boards[0] && w.boards[0].items_page;
    for (let guard = 0; wp && guard < 10; guard++) {
      addWill(wp.items);
      if (!wp.cursor) break;
      w = await _gql(`query($c:String!){ next_items_page(limit:500, cursor:$c){ cursor ${wfields} } }`, { c: wp.cursor });
      wp = w.next_items_page;
    }
  } catch (e) {
    console.warn('[task-monday-check] wills board not read (will files left out this time):', e.message);
  }
  _willsByClient = willsByClient;
  _clientIndex = { at: Date.now(), byEmail };
  return byEmail;
}

// Every outside address in From / To / Cc headers (the firm's own excluded).
function outsideAddresses() {
  const out = new Set();
  for (const h of arguments) {
    const s = String(h || '');
    const found = s.match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
    found.forEach((a) => { a = a.toLowerCase(); if (!FIRM_DOMAIN.test(a)) out.add(a); });
  }
  return [...out];
}

// Is any of these addresses a client on the clients board (with a deal)?
async function anyClientAddress(addresses) {
  if (!addresses || !addresses.length) return false;
  const idx = await clientIndex();
  return addresses.some((a) => idx.has(String(a).toLowerCase()));
}

// Returns { id, board, name } when the people on the email belong to exactly
// one deal (or the hint picks one of theirs); otherwise null.
async function findDealByAddresses(addresses, hint, out, kind) {
  if (!addresses || !addresses.length) return null;
  const idx = await clientIndex();
  const deals = new Map();
  addresses.forEach((a) => { const m = idx.get(String(a).toLowerCase()); if (m) m.forEach((b, id) => deals.set(id, b)); });
  const fit = forKind([...deals.entries()].map(([id, board]) => ({ id, board })), kind);
  if (!fit.length) return null;
  return chooseDeal(fit, hint, out);
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

// Which board an item is on (WhatsApp groups carry only the item id).
const _boardCache = new Map();
async function boardOf(itemId) {
  const id = String(itemId);
  if (_boardCache.has(id)) return _boardCache.get(id);
  const d = await _gql(`query($ids:[ID!]){ items(ids:$ids){ id board{ id } } }`, { ids: [id] });
  const it = d && d.items && d.items[0];
  const board = it && it.board ? String(it.board.id) : null;
  if (board) _boardCache.set(id, board);
  return board;
}

function dealUrl(deal) {
  return deal ? 'https://epstein-law-firm.monday.com/boards/' + deal.board + '/pulses/' + deal.id : null;
}

// 7 Oct (הצעה לביצוע): the deal's filled-in monday fields as "title: value"
// lines, for the AI to read. Empty cells, files and long texts are skipped.
async function dealSnapshot(id) {
  if (!id) return null;
  const d = await _gql(`query($ids:[ID!]){ items(ids:$ids){ id name board{ id name } column_values{ id type text column{ title } } } }`, { ids: [String(id)] });
  const it = d && d.items && d.items[0];
  if (!it) return null;
  const lines = [];
  for (const c of it.column_values || []) {
    const text = String(c.text || '').trim();
    if (!text || /^(file|doc|button|subtasks|dependency)$/.test(c.type || '')) continue;
    lines.push(((c.column && c.column.title) || c.id) + ': ' + text.replace(/\s+/g, ' ').slice(0, 200));
    if (lines.length >= 80) break;
  }
  return { id: String(it.id), name: it.name, board: it.board ? it.board.name : '', lines };
}

module.exports = { forKind, WILLS_BOARD, dealSnapshot, hasRules, findDeal, findDealByAddresses, searchDeals, verifyDeal, dealsForAddresses, outsideAddresses, anyClientAddress, dealNames, checkDeals, boardOf, dealUrl, _setGql, KYC_COLS, DEAL_BOARDS };
