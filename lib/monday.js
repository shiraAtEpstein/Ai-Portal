// ============================================================
// lib/monday.js — monday.com client.
// Token in env: MONDAY_API_TOKEN. Board field maps in config/monday-boards.json.
//
// READ-OWN (myDeals): memory-safe two-pass scan for the signed-in person.
// READ-BOARD (boardItems): pulls a WHOLE board for firm-wide reports. Gated in
//   chat.js behind the monday 'read_board' permission. Returns the board's real
//   column titles + every item's non-empty values so the model can work with
//   whatever columns actually exist on the board.
// ============================================================
const API = 'https://api.monday.com/v2';
const PROFILES = require('../config/monday-boards.json');
const PAGE = 200;         // items per page
const MAX_PAGES = 40;     // hard cap on pages per board
const MAX_ITEMS = 500;    // hard cap on items returned by a board read

function token() { return process.env.MONDAY_API_TOKEN || ''; }
function isConfigured() { return !!token(); }

async function gql(query, variables) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Authorization': token(), 'Content-Type': 'application/json', 'API-Version': '2024-10' },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('monday HTTP ' + r.status);
  if (j.errors) throw new Error('monday: ' + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

async function findUser(email) {
  const d = await gql('query($e:[String!]){ users(emails:$e){ id name email } }', { e: [email] });
  return (d.users && d.users[0]) || null;
}

function textMap(item) { const cv = {}; for (const c of (item.column_values || [])) cv[c.id] = c.text; return cv; }

// Resolve a friendly board reference ("contractor", "קבלן", or an id) to a profile.
function resolveBoard(ref) {
  const r = String(ref || '').trim().toLowerCase();
  if (!r) return null;
  return PROFILES.find((p) =>
    String(p.id) === r || (p.name || '').toLowerCase().indexOf(r) !== -1) || null;
}

async function myDeals(email) {
  if (!isConfigured()) throw new Error('MONDAY_API_TOKEN is not set');
  const user = await findUser(email);
  if (!user) return { user: null, deals: [] };
  const wanted = String(user.name || '').trim();
  const out = [];

  for (const b of PROFILES) {
    const cols = b.columns;
    const personIds = [cols.paralegal, cols.taxPerson].filter(Boolean);
    const personJson = JSON.stringify(personIds);

    const roleById = {};
    let data = await gql(
      `query($bid:[ID!]){ boards(ids:$bid){ items_page(limit:${PAGE}){ cursor items{ id column_values(ids:${personJson}){ id text } } } } }`,
      { bid: [String(b.id)] }
    );
    let page = data.boards[0].items_page;
    let pages = 0;
    while (page && pages < MAX_PAGES) {
      for (const it of (page.items || [])) {
        const cv = textMap(it);
        const para = (cv[cols.paralegal] || '').trim();
        const tax = (cols.taxPerson ? (cv[cols.taxPerson] || '').trim() : '');
        if (para && para.indexOf(wanted) !== -1) roleById[it.id] = 'paralegal';
        else if (tax && tax.indexOf(wanted) !== -1) roleById[it.id] = 'tax';
      }
      if (!page.cursor) break;
      const nx = await gql(
        `query($c:String!){ next_items_page(limit:${PAGE}, cursor:$c){ cursor items{ id column_values(ids:${personJson}){ id text } } } }`,
        { c: page.cursor }
      );
      page = nx.next_items_page;
      pages++;
    }

    const matchedIds = Object.keys(roleById);
    const allJson = JSON.stringify(Object.values(cols).filter(Boolean));
    for (let i = 0; i < matchedIds.length; i += 50) {
      const chunk = matchedIds.slice(i, i + 50);
      const d = await gql(
        `query($ids:[ID!]){ items(ids:$ids){ id name url column_values(ids:${allJson}){ id text } } }`,
        { ids: chunk }
      );
      for (const it of (d.items || [])) {
        const cv = textMap(it);
        const fields = {};
        for (const [logical, colid] of Object.entries(cols)) fields[logical] = cv[colid] || null;
        out.push({ board: b.name, id: it.id, name: it.name, url: it.url, role: roleById[it.id] || 'paralegal', fields });
      }
    }
  }
  return { user, deals: out };
}

function renderDeals(res) {
  if (!res.user) return 'No monday user matched your email — ask an admin to check your monday account.';
  if (!res.deals.length) return 'No active deals or wills found where you are the person in charge.';
  const lines = [`You: ${res.user.name} — ${res.deals.length} item(s).`, ''];
  for (const d of res.deals) {
    lines.push(`• ${d.name}  [${d.board}, you=${d.role}]  ${d.url}`);
    for (const [k, v] of Object.entries(d.fields)) if (v && v !== '') lines.push(`    ${k}: ${v}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---- READ-BOARD -------------------------------------------------------------
const READ_BOARD_PAGE = 50;   // smaller page for full-board reads (was 200)

// Column types cheap/safe to bulk-read. mirror, formula, and board_relation
// columns each trigger cross-board lookups and blow monday's query-complexity
// budget on large boards, so they are EXCLUDED from default bulk reads and must
// be requested explicitly by id when genuinely needed.
const CHEAP_COLUMN_TYPES = new Set([
  'text', 'long_text', 'status', 'color', 'email', 'phone',
  'numbers', 'numeric', 'date', 'dropdown', 'people', 'location', 'link',
]);

// STEP 1: fetch the board's column list [{id,title,type}]. Schema only, no item
// values, so it is cheap and never trips the complexity limit.
async function boardColumnList(boardRef) {
  if (!isConfigured()) throw new Error('MONDAY_API_TOKEN is not set');
  const b = resolveBoard(boardRef);
  if (!b) throw new Error('board not found: "' + boardRef + '". Try contractor, second-hand, or wills.');
  const d = await gql('query($bid:[ID!]){ boards(ids:$bid){ columns{ id title type } } }', { bid: [String(b.id)] });
  const cols = (d.boards && d.boards[0] && d.boards[0].columns) || [];
  return { board: b.name, boardId: b.id, columns: cols.map((c) => ({ id: c.id, title: c.title, type: c.type })) };
}

// Back-compat: id -> title map.
async function boardColumns(boardId) {
  const d = await gql('query($bid:[ID!]){ boards(ids:$bid){ columns{ id title } } }', { bid: [String(boardId)] });
  const cols = (d.boards && d.boards[0] && d.boards[0].columns) || [];
  const map = {};
  for (const c of cols) map[c.id] = c.title;
  return map;
}

// STEP 2: pull board items, fetching ONLY the requested columns (by id or exact
// title). With no columns requested it defaults to the cheap column types only,
// so a mirror/formula-heavy board (e.g. contractor) never overloads monday.
// Returns { board, columns:{id:title}, items:[{id,name,url,values}], truncated, requestedColumns }.
// Generic value compare for JS-side row filtering: tries date, then number,
// then case-insensitive string. Returns negative / 0 / positive.
function cmpVals(a, b) {
  const da = Date.parse(a), db = Date.parse(b);
  if (!isNaN(da) && !isNaN(db)) return da - db;
  const na = parseFloat(a), nb = parseFloat(b);
  if (!isNaN(na) && !isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na - nb;
  return String(a).trim().toLowerCase().localeCompare(String(b).trim().toLowerCase());
}

// Apply one filter rule ({operator, value}) to a cell's text. General across
// dates / numbers / status / text, so the model can filter ANY request without
// per-request code. Unknown operators fail open (keep the row).
function passesRule(cell, operator, value) {
  const op = String(operator || '').trim().toLowerCase();
  const v = value == null ? '' : String(value);
  const c = cell == null ? '' : String(cell);
  switch (op) {
    case 'is_empty': return c.trim() === '';
    case 'is_not_empty': return c.trim() !== '';
    case 'eq': case 'equals': case '=': case 'is': case 'any_of':
      return c.trim().toLowerCase() === v.trim().toLowerCase();
    case 'ne': case 'neq': case '!=': case 'not': case 'not_any_of':
      return c.trim().toLowerCase() !== v.trim().toLowerCase();
    case 'contains': case 'contains_text':
      return c.toLowerCase().indexOf(v.toLowerCase()) !== -1;
    case 'not_contains': case 'not_contains_text':
      return c.toLowerCase().indexOf(v.toLowerCase()) === -1;
    case 'gt': case '>': case 'greater_than':
      return c.trim() !== '' && cmpVals(c, v) > 0;
    case 'gte': case '>=': case 'greater_than_or_equals': case 'on_or_after': case 'from':
      return c.trim() !== '' && cmpVals(c, v) >= 0;
    case 'lt': case '<': case 'lower_than':
      return c.trim() !== '' && cmpVals(c, v) < 0;
    case 'lte': case '<=': case 'lower_than_or_equal': case 'on_or_before': case 'until':
      return c.trim() !== '' && cmpVals(c, v) <= 0;
    default: return true;
  }
}

// Pull board items: only the requested columns, and (optionally) only rows that
// match generic filters [{column, operator, value}]. Filtering is server-side
// so the model receives just the matching rows. Returns
// { board, columns:{id:title}, items, truncated, requestedColumns, scanned, appliedFilters }.
async function boardItems(boardRef, requestedColumns, filters) {
  if (!isConfigured()) throw new Error('MONDAY_API_TOKEN is not set');
  const b = resolveBoard(boardRef);
  if (!b) throw new Error('board not found: "' + boardRef + '". Try contractor, second-hand, or wills.');

  const meta = await gql('query($bid:[ID!]){ boards(ids:$bid){ columns{ id title type } } }', { bid: [String(b.id)] });
  const allCols = (meta.boards && meta.boards[0] && meta.boards[0].columns) || [];
  const byId = new Map();
  const byTitle = new Map();
  for (const c of allCols) { byId.set(c.id, c); byTitle.set(String(c.title || '').trim().toLowerCase(), c); }
  const resolveCol = (tok) => {
    const key = String(tok || '').trim();
    if (byId.has(key)) return key;
    const mm = byTitle.get(key.toLowerCase());
    return mm ? mm.id : null;
  };

  let chosen;
  const reqCols = Array.isArray(requestedColumns) ? requestedColumns.filter(Boolean) : [];
  if (reqCols.length) {
    const ids = [];
    for (const tok of reqCols) { const id = resolveCol(tok); if (id) ids.push(id); }
    chosen = Array.from(new Set(ids));
    if (!chosen.length) throw new Error('none of the requested columns matched this board — call monday_list_columns first to get valid column ids/titles');
  } else {
    chosen = allCols.filter((c) => CHEAP_COLUMN_TYPES.has(c.type) && c.id !== 'name').map((c) => c.id);
  }

  // Normalise filters and make sure we fetch the columns we filter on.
  const rules = [];
  for (const f of (Array.isArray(filters) ? filters : [])) {
    if (!f || !f.column) continue;
    const colId = resolveCol(f.column);
    if (!colId) continue;
    rules.push({ colId, operator: f.operator || 'contains', value: f.value });
    if (!chosen.includes(colId)) chosen.push(colId);
  }

  const titles = {};
  for (const id of chosen) titles[id] = (byId.get(id) || {}).title || id;

  const cidJson = JSON.stringify(chosen);
  const items = [];
  let truncated = false;
  let scanned = 0;

  let data = await gql(
    `query($bid:[ID!]){ boards(ids:$bid){ items_page(limit:${READ_BOARD_PAGE}){ cursor items{ id name url column_values(ids:${cidJson}){ id text } } } } }`,
    { bid: [String(b.id)] }
  );
  let page = data.boards[0].items_page;
  let pages = 0;
  while (page && pages < MAX_PAGES) {
    for (const it of (page.items || [])) {
      scanned++;
      const cv = {};
      for (const c of (it.column_values || [])) if (c.text) cv[c.id] = c.text;
      let ok = true;
      for (const r of rules) { if (!passesRule(cv[r.colId], r.operator, r.value)) { ok = false; break; } }
      if (!ok) continue;
      if (items.length >= MAX_ITEMS) { truncated = true; break; }
      items.push({ id: it.id, name: it.name, url: it.url, values: cv });
    }
    if (truncated || !page.cursor) break;
    const nx = await gql(
      `query($c:String!){ next_items_page(limit:${READ_BOARD_PAGE}, cursor:$c){ cursor items{ id name url column_values(ids:${cidJson}){ id text } } } }`,
      { c: page.cursor }
    );
    page = nx.next_items_page;
    pages++;
  }
  const appliedFilters = rules.map((r) => ({ column: titles[r.colId] || r.colId, operator: r.operator, value: r.value }));
  return { board: b.name, columns: titles, items, truncated, requestedColumns: chosen, scanned, appliedFilters };
}

// Render the column list (STEP 1 output) for the model.
function renderColumnList(res) {
  const lines = [`Board: ${res.board} (id ${res.boardId}) - ${res.columns.length} columns.`, '', 'Pick the ids you need, then call monday_read_board with them.', '', 'id | title | type'];
  for (const c of res.columns) lines.push(`${c.id} | ${c.title} | ${c.type}`);
  return lines.join('\n');
}

function renderBoard(res) {
  const filt = (res.appliedFilters && res.appliedFilters.length)
    ? ' | filters: ' + res.appliedFilters.map((f) => f.column + ' ' + f.operator + ' ' + f.value).join(', ')
    : '';
  const lines = [`Board: ${res.board} - ${res.items.length} matching item(s)${res.scanned ? ' of ' + res.scanned + ' scanned' : ''}${res.truncated ? ' (TRUNCATED at cap; add filters to narrow)' : ''}${filt}.`, ''];
  lines.push('COLUMNS returned (title):');
  lines.push('  ' + Object.values(res.columns).filter(Boolean).join(' | '));
  lines.push('');
  for (const it of res.items) {
    lines.push(`- ${it.name}  [id ${it.id}]  ${it.url || ''}`);
    for (const [cid, val] of Object.entries(it.values)) lines.push(`    ${res.columns[cid] || cid}: ${val}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { isConfigured, findUser, myDeals, renderDeals, resolveBoard, boardColumns, boardColumnList, boardItems, renderBoard, renderColumnList };
