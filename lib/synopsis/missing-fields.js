'use strict';
// ============================================================
// lib/synopsis/missing-fields.js
//
// Given the column map, the deal item and its linked client/project items,
// work out which synopsis fields have a value on the board and which are empty.
// An empty one is a "missing field" and appears on the form.
//
// There is no hardcoded list of fields or questions in this file, and there
// must never be one — a test enforces it. Everything comes from the map.
//
// Owner-board fields (client, project) are read from the LINKED ITEM directly,
// not through a mirror on the deal board. A mirror is only a display of the
// real column, several are missing entirely, and reading the source means a
// field can never look empty just because nobody added a mirror for it.
// ============================================================

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  return s === '' || s === '-' || s === 'N/A' || s === 'n/a';
}

/**
 * Should this field be shown for THIS deal at all?
 *   { field, equals }   -> shown when that field holds exactly this value
 *   { field, notEmpty } -> shown when that field holds anything
 * The second form is how buyer 2 works: a linked second buyer is treated
 * exactly like the first, and no link means nothing about him is asked.
 */
function isShown(field, values) {
  if (!field.showIf) return true;
  const other = values[field.showIf.field];
  if (field.showIf.notEmpty) return !isEmpty(other);
  return !isEmpty(other) && String(other).trim() === field.showIf.equals;
}

/** Required for THIS deal? A conditional field is required only once shown. */
function isRequired(field, values) {
  if (field.showIf) return isShown(field, values) && !!field.required;
  if (field.requiredIf) {
    const other = values[field.requiredIf.field];
    return !isEmpty(other) && String(other).trim() === field.requiredIf.equals;
  }
  return !!field.required;
}

function cellText(cv) {
  if (!cv) return null;
  if (cv.linked && cv.linked.length) return cv.linked.map(l => l.name).join(', ');
  return cv.text;
}

/**
 * @param {object} map
 * @param {object} item        the deal item
 * @param {object} ownerItems  { client: {colId: cell}, project: {colId: cell} } — may be empty
 */
function buildFacts(map, item, ownerItems = {}) {
  const values = {}, sources = {}, linkedIds = {};
  for (const f of map.fields) {
    let cv = null;
    if (f.readFrom === 'owner') {
      cv = (ownerItems[f.owner] || {})[f.ownerColumnId] || null;
    } else if (f.columnId) {
      cv = item.column_values[f.columnId] || null;
    }
    const v = cellText(cv);
    values[f.key] = isEmpty(v) ? null : String(v).trim();
    if (cv && cv.linked && cv.linked.length) linkedIds[f.key] = cv.linked.map(l => l.id);
    sources[f.key] = {
      board: map.boards[f.owner].name,
      boardId: map.boards[f.owner].id,
      columnId: f.readFrom === 'owner' ? f.ownerColumnId : f.columnId,
      readFrom: f.readFrom,
      writable: f.writable
    };
  }
  return { values, sources, linkedIds };
}

function findMissing(map, values, context = {}) {
  const missing = [], present = [], hidden = [];
  for (const f of map.fields) {
    if (!isShown(f, values)) { hidden.push(f.key); continue; }
    if (isEmpty(values[f.key])) {
      const row = {
        key: f.key, label: f.label, group: f.group,
        type: f.type, inputType: f.ownerType || f.type, ui: f.ui || null,
        owner: f.owner, ownerBoard: map.boards[f.owner].name, ownerBoardId: map.boards[f.owner].id,
        columnId: f.readFrom === 'owner' ? f.ownerColumnId : f.columnId,
        ownerColumnId: f.ownerColumnId || null,
        lookupBoard: f.lookupBoard || null,
        required: isRequired(f, values), writable: f.writable,
        note: f.note || null, controlsBlock: f.controlsBlock || null, derived: f.derived || null
      };
      // An owner field cannot be filled at all until its item is linked. Say so.
      if (f.readFrom === 'owner' && !context[f.owner + 'Linked'])
        row.blockedReason = 'אין קישור ל' + map.boards[f.owner].name + ' בעסקה';
      missing.push(row);
    } else {
      present.push({ key: f.key, label: f.label, value: values[f.key], group: f.group, owner: f.owner });
    }
  }
  missing.sort((a, b) => (b.required - a.required) || a.group.localeCompare(b.group));
  return { missing, present, hidden };
}

module.exports = { buildFacts, findMissing, isEmpty, isRequired, isShown };
