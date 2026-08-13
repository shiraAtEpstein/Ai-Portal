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
    `query($bid:[ID!]){ boards(ids:$bid){ items_page(limit:${READ_BOARD_PAGE}){ cursor items{ id name url column_values(ids:${cidJson}){ id text ... on BoardRelationValue { display_value } ... on MirrorValue { display_value } ... on DependencyValue { display_value } } } } } }`,
    { bid: [String(b.id)] }
  );
  let page = data.boards[0].items_page;
  let pages = 0;
  while (page && pages < MAX_PAGES) {
    for (const it of (page.items || [])) {
      scanned++;
      const cv = {};
      for (const c of (it.column_values || [])) { const val = c.text || c.display_value || ''; if (val) cv[c.id] = val; }
      let ok = true;
      for (const r of rules) { if (!passesRule(cv[r.colId], r.operator, r.value)) { ok = false; break; } }
      if (!ok) continue;
      if (items.length >= MAX_ITEMS) { truncated = true; break; }
      items.push({ id: it.id, name: it.name, url: it.url, values: cv });
    }
    if (truncated || !page.cursor) break;
    const nx = await gql(
      `query($c:String!){ next_items_page(limit:${READ_BOARD_PAGE}, cursor:$c){ cursor items{ id name url column_values(ids:${cidJson}){ id text ... on BoardRelationValue { display_value } ... on MirrorValue { display_value } ... on DependencyValue { display_value } } } } }`,
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

// ESCAPE HATCH: run an arbitrary READ-ONLY monday GraphQL query. Rejects any
// mutation so it can never write. This is what lets the agent handle requests
// the structured tools can't express (cross-board links, aggregations, etc.)
// without new hand-written code per case.
async function readQuery(query, variables) {
  if (!isConfigured()) throw new Error('MONDAY_API_TOKEN is not set');
  const q = String(query || '').trim();
  if (!q) throw new Error('empty query');
  if (/\bmutation\b/i.test(q)) throw new Error('only read-only queries are allowed (mutations are blocked)');
  if (!/\bquery\b/i.test(q) && q.charAt(0) !== '{') throw new Error('provide a valid GraphQL read query');
  let vars = {};
  if (variables) { try { vars = typeof variables === 'string' ? JSON.parse(variables) : variables; } catch (_) { vars = {}; } }
  return gql(q, vars);
}
// ---- PHONE -> CLIENT MATCH (WhatsApp ingestion) ----------------------------
const { normalizePhone } = require('../whatsapp/ingest/phone');

const CLIENTS_BOARD_ID = 1603266147;
const CLIENTS_INDEX_TTL_MS = 30 * 60 * 1000; // 30 min
const CLIENTS_PAGE = 200;

let _clientsIndex = null;
let _clientsIndexAt = 0;
let _clientsIndexBuilding = null; // in-flight build promise (dedupes concurrent rebuilds)

function _clientsPhoneColumnIds() {
  const prof = PROFILES.find((p) => String(p.id) === String(CLIENTS_BOARD_ID));
  const cols = (prof && prof.columns) || {};
  return [cols.contactPhone, cols.phone2, cols.phone3].filter(Boolean);
}

async function _buildClientsIndex() {
  const index = new Map();
  const phoneCols = _clientsPhoneColumnIds();
  if (!phoneCols.length) return index;
  const cidJson = JSON.stringify(phoneCols);

  let data = await gql(
    `query($bid:[ID!]){ boards(ids:$bid){ items_page(limit:${CLIENTS_PAGE}){ cursor items{ id name column_values(ids:${cidJson}){ id text } } } } }`,
    { bid: [String(CLIENTS_BOARD_ID)] }
  );
  let page = data.boards && data.boards[0] && data.boards[0].items_page;
  let pages = 0;
  while (page && pages < MAX_PAGES) {
    for (const it of (page.items || [])) {
      for (const cv of (it.column_values || [])) {
        const norm = normalizePhone(cv.text || '');
        if (!norm || norm.length < 9) continue;
        const existing = index.get(norm);
        if (!existing) {
          index.set(norm, { monday_item_id: String(it.id), name: it.name || null });
        } else if (!existing.ambiguous && existing.monday_item_id !== String(it.id)) {
          // Same phone on two different client rows (e.g. spouses / co-buyers
          // sharing a number). We must NOT guess which one — mark it ambiguous
          // so findClientByPhone returns null and the contact lands in the
          // human review queue instead of being silently misattributed.
          index.set(norm, { ambiguous: true });
        }
      }
    }
    if (!page.cursor) break;
    const nx = await gql(
      `query($c:String!){ next_items_page(limit:${CLIENTS_PAGE}, cursor:$c){ cursor items{ id name column_values(ids:${cidJson}){ id text } } } }`,
      { c: page.cursor }
    );
    page = nx.next_items_page;
    pages++;
  }
  return index;
}

async function _getClientsIndex() {
  const fresh = _clientsIndex && (Date.now() - _clientsIndexAt) < CLIENTS_INDEX_TTL_MS;
  if (fresh) return _clientsIndex;
  if (!isConfigured()) {
    _clientsIndex = new Map();
    _clientsIndexAt = Date.now();
    return _clientsIndex;
  }
  // Coalesce concurrent rebuilds: a burst of messages arriving after the TTL
  // expires would otherwise each kick off its own full board scan (7+ pages,
  // 1,200+ items) and hammer Monday's rate limit. The first caller starts the
  // build; everyone else awaits the same promise.
  if (_clientsIndexBuilding) return _clientsIndexBuilding;
  _clientsIndexBuilding = (async () => {
    try {
      const index = await _buildClientsIndex();
      _clientsIndex = index;
      _clientsIndexAt = Date.now();
    } catch (e) {
      console.error('[monday] findClientByPhone index build failed:', e.message);
      _clientsIndex = new Map();
      _clientsIndexAt = Date.now();
    } finally {
      _clientsIndexBuilding = null;
    }
    return _clientsIndex;
  })();
  return _clientsIndexBuilding;
}

async function findClientByPhone(normalizedPhone) {
  try {
    const key = normalizePhone(normalizedPhone);
    if (!key) return null;
    const index = await _getClientsIndex();
    const hit = index.get(key);
    // No hit, or a phone shared by multiple clients (ambiguous) — treat as
    // "not confidently matched" so the caller leaves it unresolved.
    if (!hit || hit.ambiguous) return null;
    return hit;
  } catch (_) {
    return null;
  }
}

// ---- CLIENT -> DEAL RESOLUTION (WhatsApp knowledge, Phase 4) ---------------
// A client row on the לקוחות board (1603266147) is board-linked to its deal(s)
// via board_relation columns (verified against the live board). We resolve to
// the REAL-ESTATE deal boards only:
//   קבלן  (contractor,  board 1603266152): buyers 1/2/3
//   יד 2   (second-hand, board 1772652154): buyers 1/2/3
// The wills board (5099077728, column board_relation_mm4k7wwe) is intentionally
// EXCLUDED here: almost every client also has a wills matter, so including it
// would make nearly everyone look "ambiguous". Wills is a separate track; the
// WhatsApp knowledge engine is scoped to the real-estate transaction flow.
const CLIENT_DEAL_RELATION_COLS = [
  'link_to_________________1', 'board_relation7__1', 'board_relation59__1', // קבלן
  'connect_boards_mkmf523n', 'connect_boards_mkmf3bsy', 'connect_boards_mkmfnab9', // יד 2
];

// Given a client item id, return the real-estate deal(s) it is linked to,
// de-duplicated: [{ monday_board_id, monday_item_id, name }].
// Empty array = no linked real-estate deal. More than one = the client is in
// several deals — the caller does NOT guess which message belongs to which.
async function resolveDealsForClient(clientItemId) {
  if (!isConfigured() || !clientItemId) return [];
  const cidJson = JSON.stringify(CLIENT_DEAL_RELATION_COLS);
  let data;
  try {
    data = await gql(
      `query($ids:[ID!]){ items(ids:$ids){ id column_values(ids:${cidJson}){
         id ... on BoardRelationValue { linked_items { id name board { id } } } } } }`,
      { ids: [String(clientItemId)] }
    );
  } catch (e) {
    console.error('[monday] resolveDealsForClient failed:', e.message);
    return [];
  }
  const item = data.items && data.items[0];
  if (!item) return [];
  const byId = new Map();
  for (const cv of (item.column_values || [])) {
    for (const li of (cv.linked_items || [])) {
      if (!li || !li.id) continue;
      if (!byId.has(String(li.id))) {
        byId.set(String(li.id), {
          monday_item_id: String(li.id),
          monday_board_id: li.board && li.board.id ? String(li.board.id) : null,
          name: li.name || null,
        });
      }
    }
  }
  return Array.from(byId.values());
}

// Enrich candidate deals with a `context` blob = their own column values PLUS the
// fields of any linked item in the "פרויקטים" (projects) board — because the
// city / neighbourhood / project info often lives on the linked PROJECT, not on
// the deal. Call this ONLY as a fallback, when a name-only match failed, so a
// group named for the NEIGHBOURHOOD ("יובלים") can still match a deal whose
// project is "ימים הצעירה בנתניה". Mutates the candidates (sets .context).
// Best-effort (up to 2 small queries); returns the same array.
async function enrichDealsWithContext(candidates) {
  const list = (candidates || []).filter(Boolean);
  if (!isConfigured() || !list.length) return candidates;
  try {
    const ids = list.map((c) => c.monday_item_id);
    const full = await gql(
      `query($ids:[ID!]){ items(ids:$ids){ id column_values { id text
         ... on BoardRelationValue { display_value linked_items { id name } }
         ... on MirrorValue { display_value } } } }`,
      { ids }
    );
    const partsById = new Map();     // dealId -> [text...]
    const linkedByDeal = new Map();  // dealId -> [projectItemId]
    const allLinked = new Set();
    const pushText = (arr, v) => { const t = String(v || '').trim(); if (t && t.length <= 80 && !/^https?:/i.test(t)) arr.push(t); };
    for (const it of (full.items || [])) {
      const parts = []; const linked = [];
      for (const cv of (it.column_values || [])) {
        pushText(parts, cv.text);
        pushText(parts, cv.display_value);
        for (const li of (cv.linked_items || [])) {
          if (li && li.name) pushText(parts, li.name);
          if (li && li.id) { linked.push(String(li.id)); allLinked.add(String(li.id)); }
        }
      }
      partsById.set(String(it.id), parts);
      linkedByDeal.set(String(it.id), linked);
    }
    const projParts = new Map();
    if (allLinked.size) {
      const proj = await gql(
        `query($ids:[ID!]){ items(ids:$ids){ id column_values { id text } } }`,
        { ids: Array.from(allLinked) }
      );
      for (const it of (proj.items || [])) {
        const parts = [];
        for (const cv of (it.column_values || [])) pushText(parts, cv.text);
        projParts.set(String(it.id), parts);
      }
    }
    for (const c of list) {
      const parts = (partsById.get(c.monday_item_id) || []).slice();
      for (const pid of (linkedByDeal.get(c.monday_item_id) || [])) {
        for (const t of (projParts.get(pid) || [])) parts.push(t);
      }
      c.context = Array.from(new Set(parts)).join(' · ').slice(0, 600);
    }
  } catch (e) {
    console.warn('[monday] deal context enrich failed:', e.message);
  }
  return candidates;
}

// ---- DEAL <- WHATSAPP GROUP ID (verified columns on the deal boards) -------
// Each deal board has a text column holding the linked WhatsApp group id.
// When it's filled in, it's the most reliable chat->deal link (no guessing).
const DEAL_BOARDS_GROUP_COL = [
  { boardId: '1603266152', groupCol: 'text_mkv8fskq' }, // קבלן
  { boardId: '1772652154', groupCol: 'text_mkv8b20n' }, // יד 2
];
const DEAL_GROUP_TTL_MS = 30 * 60 * 1000;
let _dealGroupIndex = null, _dealGroupIndexAt = 0, _dealGroupBuilding = null;

function _digitsOnly(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

async function _buildDealGroupIndex() {
  const index = new Map(); // normalized group id -> { monday_board_id, monday_item_id, name }
  for (const b of DEAL_BOARDS_GROUP_COL) {
    let data = await gql(
      `query($bid:[ID!]){ boards(ids:$bid){ items_page(limit:200){ cursor items{ id name column_values(ids:["${b.groupCol}"]){ id text } } } } }`,
      { bid: [b.boardId] }
    );
    let page = data.boards && data.boards[0] && data.boards[0].items_page;
    let pages = 0;
    while (page && pages < MAX_PAGES) {
      for (const it of (page.items || [])) {
        const cv = (it.column_values || [])[0];
        const gid = _digitsOnly(cv && cv.text);
        // WhatsApp group ids are long (~18 digits) — guard against stray short numbers.
        if (gid && gid.length >= 15 && !index.has(gid)) {
          index.set(gid, { monday_board_id: b.boardId, monday_item_id: String(it.id), name: it.name || null });
        }
      }
      if (!page.cursor) break;
      const nx = await gql(
        `query($c:String!){ next_items_page(limit:200, cursor:$c){ cursor items{ id name column_values(ids:["${b.groupCol}"]){ id text } } } }`,
        { c: page.cursor }
      );
      page = nx.next_items_page;
      pages++;
    }
  }
  return index;
}

async function _getDealGroupIndex() {
  const fresh = _dealGroupIndex && (Date.now() - _dealGroupIndexAt) < DEAL_GROUP_TTL_MS;
  if (fresh) return _dealGroupIndex;
  if (!isConfigured()) { _dealGroupIndex = new Map(); _dealGroupIndexAt = Date.now(); return _dealGroupIndex; }
  if (_dealGroupBuilding) return _dealGroupBuilding;
  _dealGroupBuilding = (async () => {
    try { _dealGroupIndex = await _buildDealGroupIndex(); _dealGroupIndexAt = Date.now(); }
    catch (e) { console.error('[monday] deal-group index build failed:', e.message); _dealGroupIndex = new Map(); _dealGroupIndexAt = Date.now(); }
    finally { _dealGroupBuilding = null; }
    return _dealGroupIndex;
  })();
  return _dealGroupBuilding;
}

// Reliable link: does any deal store this WhatsApp group's id? Returns
// { monday_board_id, monday_item_id, name } or null.
async function resolveDealForGroupId(groupJid) {
  try {
    const gid = _digitsOnly(groupJid);
    if (gid.length < 15) return null;
    const idx = await _getDealGroupIndex();
    return idx.get(gid) || null;
  } catch (_) { return null; }
}

// The "person in charge" (paralegal / deal_owner) name for a specific monday
// deal (board + item), or null. Read-only. This is the preferred path: the
// caller already knows the deal (however it was linked — group-id OR name match).
async function responsibleNameForDeal(boardId, itemId) {
  if (!isConfigured() || !boardId || !itemId) return null;
  try {
    const prof = PROFILES.find((p) => String(p.id) === String(boardId));
    const col = prof && prof.columns && prof.columns.paralegal;
    if (!col) return null;
    const d = await gql(
      `query($ids:[ID!]){ items(ids:$ids){ id column_values(ids:["${col}"]){ id text } } }`,
      { ids: [String(itemId)] }
    );
    const it = d.items && d.items[0];
    const cv = it && (it.column_values || [])[0];
    return (cv && cv.text ? String(cv.text).trim() : '') || null;
  } catch (e) {
    console.error('[monday] responsibleNameForDeal failed:', e.message);
    return null;
  }
}

// Fallback: resolve the deal from the group-id column, then read its person.
// Used only when we don't already have a cached deal for the group.
async function responsibleNameForGroup(groupJid) {
  if (!isConfigured()) return null;
  try {
    const deal = await resolveDealForGroupId(groupJid);
    if (!deal) return null;
    return await responsibleNameForDeal(deal.monday_board_id, deal.monday_item_id);
  } catch (e) {
    console.error('[monday] responsibleNameForGroup failed:', e.message);
    return null;
  }
}

module.exports = { isConfigured, findUser, myDeals, renderDeals, resolveBoard, boardColumns, boardColumnList, boardItems, renderBoard, renderColumnList, readQuery, findClientByPhone, resolveDealsForClient, enrichDealsWithContext, resolveDealForGroupId, responsibleNameForGroup, responsibleNameForDeal };
