'use strict';
/**
 * Verify the column map against the live boards.
 *
 * The unit tests check the LOGIC — given these values, ask for these fields. They do
 * not and cannot tell you whether `numeric_mkqfhayz` is still a real column. This does.
 *
 * It answers three questions the tests do not:
 *   1. Does every column id on the map still exist on its board?
 *   2. Is its type still what the map claims? (a text column turned into a status
 *      breaks the write formatter silently)
 *   3. Is its title still what the map shows the paralegal?
 *
 * Run it after anyone edits the boards, and before trusting a letter.
 *   MONDAY_API_TOKEN=... node tools/check-synopsis-columns.js
 */

const fs = require('fs'), path = require('path');
const read = require('../lib/synopsis/read');

const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'synopsis-columns.json'), 'utf8'));

(async () => {
  if (!process.env.MONDAY_API_TOKEN) { console.error('\n  MONDAY_API_TOKEN is not set.\n'); process.exit(1); }

  const schemas = {};
  for (const [key, board] of Object.entries(MAP.boards)) {
    const cols = await read.boardColumns(board.id);
    schemas[key] = new Map(cols.map(c => [c.id, c]));
    console.log(`  ${board.name} (${board.id}) — ${cols.length} columns`);
  }

  const problems = [];
  const ok = [];

  for (const f of MAP.fields) {
    // where the value is READ from — always a column on the deal board
    if (f.columnId) {
      const col = schemas.deal.get(f.columnId);
      if (!col) problems.push({ sev: 'MISSING', field: f.key, detail:
        `read column ${f.columnId} does not exist on ${MAP.boards.deal.name}` });
      else if (f.type !== 'mirror' && col.type !== f.type) problems.push({ sev: 'TYPE', field: f.key, detail:
        `read column ${f.columnId} is "${col.type}" on the board, map says "${f.type}"` });
      else if (col.title !== f.label) problems.push({ sev: 'LABEL', field: f.key, detail:
        `board says "${col.title}", the form shows "${f.label}"` });
      else ok.push(f.key);
    } else if (f.required) {
      problems.push({ sev: 'NO-READ', field: f.key, detail:
        `required, but there is no column on ${MAP.boards.deal.name} to read it from — add a mirror` });
    }

    // where a write LANDS — a column on the owning board
    if (f.writable && f.ownerColumnId) {
      const col = schemas[f.owner]?.get(f.ownerColumnId);
      if (!col) problems.push({ sev: 'MISSING', field: f.key, detail:
        `write target ${f.ownerColumnId} does not exist on ${MAP.boards[f.owner].name}` });
      else if (f.ownerType && col.type !== f.ownerType) problems.push({ sev: 'TYPE', field: f.key, detail:
        `write target ${f.ownerColumnId} is "${col.type}" on ${MAP.boards[f.owner].name}, map says "${f.ownerType}"` });
    }
  }

  console.log(`\n  ${ok.length} fields verified, ${problems.length} problems\n`);
  const order = ['MISSING', 'TYPE', 'NO-READ', 'LABEL'];
  for (const sev of order) {
    const rows = problems.filter(p => p.sev === sev);
    if (!rows.length) continue;
    console.log(`  ${sev}`);
    for (const r of rows) console.log(`    ${r.field.padEnd(28)} ${r.detail}`);
    console.log('');
  }
  const fatal = problems.filter(p => p.sev === 'MISSING' || p.sev === 'TYPE').length;
  if (fatal) { console.error(`  ${fatal} problems would produce a wrong letter. Fix the map before running a synopsis.`); process.exit(1); }
  console.log('  No column on the map is missing or mistyped.');
})().catch(e => { console.error('\n  ' + e.message + '\n'); process.exit(1); });
