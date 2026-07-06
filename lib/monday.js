// ============================================================
// lib/monday.js — read-only monday.com client for the daily agent.
// Token in env: MONDAY_API_TOKEN  (monday → avatar → Developers → My Access Tokens)
// Board field maps live in config/monday-boards.json (logical field -> column id).
//
// "My deals" = deals where the signed-in person is the paralegal (or tax owner).
// monday's server-side people filter is unreliable, so we fetch the boards'
// items (curated columns only) and match the person by NAME in code.
// ============================================================
const API = 'https://api.monday.com/v2';
const PROFILES = require('../config/monday-boards.json');

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

// All deals (across configured boards) where `wantedName` is paralegal or tax owner.
async function myDeals(email) {
  if (!isConfigured()) throw new Error('MONDAY_API_TOKEN is not set');
  const user = await findUser(email);
  if (!user) return { user: null, deals: [] };
  const wanted = String(user.name || '').trim();
  const out = [];

  for (const b of PROFILES) {
    const cols = b.columns;
    const ids = Object.values(cols).filter(Boolean);
    const idsJson = JSON.stringify(ids);
    // first page
    let data = await gql(
      `query($bid:[ID!]){ boards(ids:$bid){ items_page(limit:500){ cursor items{ id name url column_values(ids:${idsJson}){ id text } } } } }`,
      { bid: [String(b.id)] }
    );
    let page = data.boards[0].items_page;
    let guard = 0;
    while (page && guard < 12) {
      for (const it of (page.items || [])) {
        const cv = {};
        for (const c of it.column_values) cv[c.id] = c.text;
        const paralegal = (cv[cols.paralegal] || '').trim();
        const taxPerson = (cv[cols.taxPerson] || '').trim();
        const isPara = paralegal && paralegal.indexOf(wanted) !== -1;
        const isTax = taxPerson && taxPerson.indexOf(wanted) !== -1;
        if (!isPara && !isTax) continue;
        const fields = {};
        for (const [logical, colid] of Object.entries(cols)) fields[logical] = cv[colid] || null;
        out.push({ board: b.name, id: it.id, name: it.name, url: it.url, role: isPara ? 'paralegal' : 'tax', fields });
      }
      if (!page.cursor) break;
      const next = await gql(
        `query($c:String!){ next_items_page(limit:500, cursor:$c){ cursor items{ id name url column_values(ids:${idsJson}){ id text } } } }`,
        { c: page.cursor }
      );
      page = next.next_items_page;
      guard++;
    }
  }
  return { user, deals: out };
}

// A compact text rendering for the agent to reason over.
function renderDeals(res) {
  if (!res.user) return 'No monday user matched your email — ask an admin to check your monday account.';
  if (!res.deals.length) return 'No active deals found where you are the paralegal or tax owner.';
  const lines = [`You: ${res.user.name} — ${res.deals.length} deal(s).`, ''];
  for (const d of res.deals) {
    lines.push(`• ${d.name}  [${d.board}, you=${d.role}]  ${d.url}`);
    for (const [k, v] of Object.entries(d.fields)) {
      if (v && v !== '') lines.push(`    ${k}: ${v}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { isConfigured, findUser, myDeals, renderDeals };
