'use strict';
// ============================================================
// lib/synopsis/index.js — the feature's single entry point.
//
// Everything outside this folder requires `../lib/synopsis`, never a file
// inside it. So the internal layout can change without touching routes, tests
// or tools — and there is exactly one path to get wrong.
//
//   read           every monday READ (through monday.readQuery — mutations blocked)
//   buildFacts     monday item  -> named values + their source
//   findMissing    which fields the board has no value for
//   applyWrite     the ONLY write. Eight checks, then one mutation.
// ============================================================
const read = require('./read');
const { buildFacts, findMissing, isEmpty, isRequired } = require('./missing-fields');
const { applyWrite, formatValue, ALLOWED_ACTIONS, READ_ONLY } = require('./write-gate');

module.exports = {
  // reads
  searchDealsByName: read.searchDealsByName,
  getDeal: read.getDeal,
  optionsFor: read.optionsFor,
  boardColumns: read.boardColumns,
  // fields
  buildFacts, findMissing, isEmpty, isRequired,
  // the write
  applyWrite, formatValue, ALLOWED_ACTIONS, READ_ONLY
};
