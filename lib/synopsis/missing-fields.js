'use strict';
/**
 * Given the column map and a monday item, work out which synopsis fields have a value
 * on the board and which are empty. An empty one is a "missing field".
 *
 * The list is COMPUTED from the board every run. There is no hand-written list of
 * questions anywhere in this file, and there must never be one — that is how a form
 * starts asking for things the board already knows.
 */

const EMPTY = new Set(['', '-', 'N/A', 'n/a', null, undefined]);

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  return s === '' || EMPTY.has(s);
}

/** Is this field required for THIS deal? Handles conditional requirements. */
function isRequired(field, values) {
  if (field.requiredIf) {
    const other = values[field.requiredIf.field];
    return !isEmpty(other) && String(other).trim() === field.requiredIf.equals;
  }
  return !!field.required;
}

function buildFacts(map, item) {
  const values = {};
  const sources = {};
  for (const f of map.fields) {
    const cv = f.columnId ? item.column_values[f.columnId] : null;
    let v = cv ? cv.text : null;
    if (cv && cv.linked && cv.linked.length) v = cv.linked.map(l => l.name).join(', ');
    values[f.key] = isEmpty(v) ? null : String(v).trim();
    sources[f.key] = {
      board: map.boards[f.owner].name,
      boardId: map.boards[f.owner].id,
      columnId: f.columnId,
      writable: f.writable
    };
  }
  return { values, sources };
}

function findMissing(map, values) {
  const missing = [];
  const present = [];
  for (const f of map.fields) {
    const required = isRequired(f, values);
    const empty = isEmpty(values[f.key]);
    if (empty) {
      missing.push({
        key: f.key, label: f.label, type: f.type, group: f.group,
        owner: f.owner, ownerBoard: map.boards[f.owner].name, ownerBoardId: map.boards[f.owner].id,
        columnId: f.columnId, ownerColumnId: f.ownerColumnId || null,
        required, writable: f.writable,
        note: f.note || null, controlsBlock: f.controlsBlock || null,
        derived: f.derived || null
      });
    } else {
      present.push({ key: f.key, label: f.label, value: values[f.key], group: f.group, owner: f.owner });
    }
  }
  missing.sort((a, b) => (b.required - a.required) || a.group.localeCompare(b.group));
  return { missing, present };
}

module.exports = { buildFacts, findMissing, isEmpty, isRequired };
