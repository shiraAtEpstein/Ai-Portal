'use strict';
// ============================================================
// lib/synopsis/read.js — every monday READ the synopsis screen makes.
//
// Goes through monday.readQuery(), the portal's existing guarded read path
// (it rejects mutations outright). Reads are scoped to the column ids on
// config/synopsis-columns.json — nothing else on the item is fetched, so the
// ~300 workflow columns, file URLs and WhatsApp ids never leave monday.
// ============================================================
const monday = require('../monday');

async function searchDealsByName(term, boardIds) {
  const out = [];
  for (const boardId of boardIds) {
    const d = await monday.readQuery(`
      query ($boardId: ID!, $term: CompareValue!) {
        boards(ids: [$boardId]) {
          id name
          items_page(limit: 25, query_params: {
            rules: [{ column_id: "name", compare_value: $term, operator: contains_text }]
          }) { items { id name } }
        }
      }`, { boardId: String(boardId), term });
    for (const b of (d.boards || []))
      for (const it of (b.items_page?.items || []))
        out.push({ id: it.id, name: it.name, boardId: b.id, boardName: b.name });
  }
  return out;
}

async function getDeal(itemId, columnIds) {
  const d = await monday.readQuery(`
    query ($itemId: ID!, $cols: [String!]) {
      items(ids: [$itemId]) {
        id name
        board { id name }
        column_values(ids: $cols) {
          id type text
          ... on MirrorValue { display_value }
          ... on BoardRelationValue { linked_items { id name board { id name } } }
        }
      }
    }`, { itemId: String(itemId), cols: columnIds });
  const item = d.items?.[0];
  if (!item) throw new Error('Deal not found on monday: ' + itemId);
  const column_values = {};
  for (const cv of item.column_values)
    column_values[cv.id] = {
      type: cv.type,
      text: cv.display_value != null ? cv.display_value : cv.text,
      linked: cv.linked_items || null
    };
  return { id: item.id, name: item.name, boardId: item.board.id, boardName: item.board.name, column_values };
}

/** Dropdown labels come from the column's own settings — never written by us. */
async function optionsFor(boardId) {
  const d = await monday.readQuery(
    `query ($boardId: ID!) { boards(ids: [$boardId]) { columns { id title type settings_str } } }`,
    { boardId: String(boardId) });
  const cols = d.boards?.[0]?.columns || [];
  const out = {};
  for (const c of cols) {
    if (c.type !== 'status' && c.type !== 'dropdown') continue;
    let s = {};
    try { s = JSON.parse(c.settings_str || '{}'); } catch (_) {}
    out[c.id] = c.type === 'status'
      ? Object.values(s.labels || {}).filter(Boolean)
      : (s.labels || []).map(l => l.name);
  }
  return out;
}

async function boardColumns(boardId) {
  const d = await monday.readQuery(
    `query ($boardId: ID!) { boards(ids: [$boardId]) { columns { id title type } } }`,
    { boardId: String(boardId) });
  return d.boards?.[0]?.columns || [];
}

/**
 * Read a linked client / project item directly. Owner-board fields are read
 * from the real column here, not from a mirror on the deal — several columns
 * (רחוב, סטטוס הבניה, חברה מוכרת אנגלית) have no mirror at all, and a mirror
 * that is missing looks exactly like a value that is missing.
 */
async function getItemColumns(itemId, columnIds) {
  if (!itemId || !columnIds.length) return {};
  const d = await monday.readQuery(`
    query ($itemId: ID!, $cols: [String!]) {
      items(ids: [$itemId]) {
        id
        column_values(ids: $cols) {
          id type text
          ... on MirrorValue { display_value }
          ... on BoardRelationValue { linked_items { id name board { id name } } }
        }
      }
    }`, { itemId: String(itemId), cols: columnIds });
  const out = {};
  for (const cv of (d.items?.[0]?.column_values || []))
    out[cv.id] = { type: cv.type, text: cv.display_value != null ? cv.display_value : cv.text,
                   linked: cv.linked_items || null };
  return out;
}

/** Items on a board whose name matches — powers the "link a client / project" picker. */
async function lookupItems(boardId, term) {
  const d = await monday.readQuery(`
    query ($boardId: ID!, $term: CompareValue!) {
      boards(ids: [$boardId]) {
        items_page(limit: 25, query_params: {
          rules: [{ column_id: "name", compare_value: $term, operator: contains_text }]
        }) { items { id name } }
      }
    }`, { boardId: String(boardId), term });
  return (d.boards?.[0]?.items_page?.items || []).map(i => ({ id: i.id, name: i.name }));
}

/** The deal's payment rows, in order, with only the mapped columns. */
async function getPayments(itemIds, columnIds) {
  if (!itemIds || !itemIds.length) return [];
  const d = await monday.readQuery(`
    query ($ids: [ID!], $cols: [String!]) {
      items(ids: $ids) {
        id name
        group { id title }
        column_values(ids: $cols) { id type text }
      }
    }`, { ids: itemIds.map(String), cols: columnIds });
  return (d.items || []).map(it => {
    const cells = {};
    for (const cv of it.column_values) cells[cv.id] = cv.text;
    return { id: it.id, name: it.name, group: it.group?.title || null, cells };
  });
}

module.exports = { searchDealsByName, getDeal, optionsFor, boardColumns, getItemColumns,
                   lookupItems, getPayments };
