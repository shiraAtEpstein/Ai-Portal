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
// Fetch the board's real column id->title map (so output is interpretable).
async function boardColumns(boardId) {
  const d = await gql('query($bid:[ID!]){ boards(ids:$bid){ columns{ id title } } }', { bid: [String(boardId)] });
  const cols = (d.boards && d.boards[0] && d.boards[0].columns) || [];
  const map = {};
  for (const c of cols) map[c.id] = c.title;
  return map;
}

// Pull an entire board (capped). Returns { board, columns:{id:title}, items:[{id,name,url,values:{colid:text}}], truncated }.
async function boardItems(boardRef) {
  if (!isConfigured()) throw new Error('MONDAY_API_TOKEN is not set');
  const b = resolveBoard(boardRef);
  if (!b) throw new Error('board not found: "' + boardRef + '". Try contractor, second-hand, or wills.');
  const titles = await boardColumns(b.id);
  const items = [];
  let truncated = false;

  let data = await gql(
    `query($bid:[ID!]){ boards(ids:$bid){ items_page(limit:${PAGE}){ cursor items{ id name url column_values{ id text } } } } }`,
    { bid: [String(b.id)] }
  );
  let page = data.boards[0].items_page;
  let pages = 0;
  while (page && pages < MAX_PAGES) {
    for (const it of (page.items || [])) {
      if (items.length >= MAX_ITEMS) { truncated = true; break; }
      const cv = {};
      for (const c of (it.column_values || [])) if (c.text) cv[c.id] = c.text;
      items.push({ id: it.id, name: it.name, url: it.url, values: cv });
    }
    if (truncated || !page.cursor) break;
    const nx = await gql(
      `query($c:String!){ next_items_page(limit:${PAGE}, cursor:$c){ cursor items{ id name url column_values{ id text } } } }`,
      { c: page.cursor }
    );
    page = nx.next_items_page;
    pages++;
  }
  return { board: b.name, columns: titles, items, truncated };
}

function renderBoard(res) {
  const lines = [`Board: ${res.board} — ${res.items.length} item(s)${res.truncated ? ' (TRUNCATED at cap; ask to narrow)' : ''}.`, ''];
  lines.push('COLUMNS available on this board (title):');
  lines.push('  ' + Object.values(res.columns).filter(Boolean).join(' | '));
  lines.push('');
  for (const it of res.items) {
    lines.push(`• ${it.name}  [id ${it.id}]  ${it.url || ''}`);
    for (const [cid, val] of Object.entries(it.values)) lines.push(`    ${res.columns[cid] || cid}: ${val}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { isConfigured, findUser, myDeals, renderDeals, resolveBoard, boardColumns, boardItems, renderBoard };
