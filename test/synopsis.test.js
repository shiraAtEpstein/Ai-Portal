// ============================================================
// test/synopsis.test.js — the rules the synopsis screen must obey.
//
// LOGIC ONLY. Sample values are declared here; this file never touches monday.
// To check that the mapped COLUMNS still exist on the boards, run:
//     MONDAY_API_TOKEN=... node tools/check-synopsis-columns.js
// Run with:  npm test
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { buildFacts, findMissing, applyWrite, ALLOWED_ACTIONS, formatValue } = require('../lib/synopsis');

const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'synopsis-columns.json'), 'utf8'));

/** A deal shaped the way monday returns one. Values are the real Rosalimsky ones. */
function deal(overrides = {}) {
  const cols = {
    text_mkm085q3: '8', text_mkm0tje8: '1', text_mkm0wajw: '2', numbers_mkm0spc5: '3',
    numeric_mkm0xkv: '2500000', numeric_mknsnjhc: '6', status_mkm0x7dj: 'לא',
    number2__1: '0.75', numeric_mkqq3rn7: '22125', numbers85__1: '2', numbers96__1: '59000',
    numbers5__1: '6809', dropdown_mkn78wdb: 'תושב חוץ - 8%', numbers_mkmck5ye: '200000',
    numeric_mkwxdh99: '2606', date_mkv7gn8f: '2028-08-31', date58__1: '2026-03-25',
    status0__1: 'לא', status__1: 'לא', text_mkm0s5p4: 'כן', status5__1: 'Rabbi',
    lookup96__1: 'Avi Chaim Rosalimsky', lookup957__1: 'A06912601', lookup369__1: 'United States',
    // deliberately empty on the real board:
    numeric_mkqfhayz: null, text_mkqm2q0k: null, text_mkqm8e8w: null,
    text_mkm0rnxt: null, text_mkm0tgtz: null, text_mkx7t7yy: null,
    ...overrides
  };
  const column_values = {};
  for (const [id, text] of Object.entries(cols)) column_values[id] = { type: 'text', text, linked: null };
  return { id: '1', name: 'test', boardId: '1603266152', boardName: 'לידים / עסקאות קבלן', column_values };
}
const run = d => { const { values } = buildFacts(MAP, d); return { values, ...findMissing(MAP, values) }; };

// ---- the form ------------------------------------------------------------

test('an empty column is asked for', () => {
  const keys = run(deal()).missing.map(f => f.key);
  for (const k of ['apartment_sqm', 'porch_sqm', 'sukkah_porch_sqm', 'direction', 'storage_1', 'storage_2'])
    assert.ok(keys.includes(k), 'should be asked: ' + k);
});

test('anything the board answers is NEVER asked', () => {
  const keys = run(deal()).missing.map(f => f.key);
  for (const k of ['contractor_loan', 'index_linked', 'tax_profile', 'delivery_date',
                   'purchase_price', 'parking_1', 'buyer_1_id_number'])
    assert.ok(!keys.includes(k), 'must not be asked, the board answers it: ' + k);
});

test('requirements follow the deal, not a fixed list', () => {
  const no = run(deal({ status0__1: 'לא' })).missing.find(f => f.key === 'contractor_loan_pct');
  assert.strictEqual(no.required, false);
  const yes = run(deal({ status0__1: 'כן' })).missing.find(f => f.key === 'contractor_loan_pct');
  assert.strictEqual(yes.required, true);
});

test('no field name is hardcoded in the engine', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'synopsis', 'missing-fields.js'), 'utf8');
  for (const banned of ['היתר', 'פנטהאוז', 'דמי רצינות', 'הלוואת קבלן'])
    assert.ok(!src.includes(banned), 'the engine must not name a field: ' + banned);
});

test('the two purchase-tax brackets stay two fields', () => {
  const v = run(deal()).values;
  assert.strictEqual(v.purchase_tax, '200000');
  assert.strictEqual(v.purchase_tax_alt, '2606');
});

// ---- the column map ------------------------------------------------------

test('every writable field knows which column the write targets, and no mirror targets itself', () => {
  for (const f of MAP.fields.filter(f => f.writable)) {
    assert.ok(f.ownerColumnId, f.key + ': writable with no target column');
    if (f.type === 'mirror') {
      assert.notStrictEqual(f.ownerColumnId, f.columnId, f.key + ': would write to the mirror');
      assert.notStrictEqual(f.owner, 'deal', f.key + ': a mirror cannot be owned by the deal board');
    }
  }
});

// ---- the write gate ------------------------------------------------------

const sent = [];
const fakeWrite = async (boardId, itemId, columnId, value) => { sent.push({ boardId, itemId, columnId, value }); return { id: 'x' }; };
const ctx = (roles = ['paralegal']) => ({
  map: MAP, dealId: '2723987361', dealBoardId: '1603266152',
  ownerItemIds: { project: '1807156384', client: '2725704387' },
  session: { email: 'shayna@epsteinlaw.co.il', userId: 7, roles },
  runId: 'test', before: {}, write: fakeWrite, log() {}
});
async function rejects(proposal, roles, contains) {
  await assert.rejects(() => applyWrite(proposal, ctx(roles)), e => {
    assert.ok(e.rejected, 'expected a gate rejection, got: ' + e.message);
    assert.ok(e.message.includes(contains), `expected "${contains}" in "${e.message}"`);
    return true;
  });
}

test('update_column is the only permitted action', async () => {
  assert.deepStrictEqual([...ALLOWED_ACTIONS], ['update_column']);
  for (const action of ['delete_item', 'create_item', 'archive_item', 'move_item_to_board'])
    await rejects({ action, fieldKey: 'apartment_sqm', value: '90' }, ['paralegal'], 'not permitted');
});

test('only fields on the audited map can be written', async () => {
  await rejects({ action: 'update_column', fieldKey: 'whatever', value: 'x' }, ['paralegal'], 'unknown field');
});

test('read-only fields are refused', async () => {
  await rejects({ action: 'update_column', fieldKey: 'project_base_synopsis', value: 'x' }, ['paralegal'], 'read-only');
});

test('a role without monday write capability is refused', async () => {
  await rejects({ action: 'update_column', fieldKey: 'apartment_sqm', value: '90' }, ['accountant'], 'may not write');
  await rejects({ action: 'update_column', fieldKey: 'apartment_sqm', value: '90' }, [], 'may not write');
});

test('values are validated against the owning column type', async () => {
  await rejects({ action: 'update_column', fieldKey: 'apartment_sqm', value: 'ninety' }, ['paralegal'], 'expected a number');
  await rejects({ action: 'update_column', fieldKey: 'delivery_date', value: '31/08/2028' }, ['paralegal'], 'YYYY-MM-DD');
  await rejects({ action: 'update_column', fieldKey: 'buyer_1_email', value: 'nope' }, ['paralegal'], 'email address');
  assert.deepStrictEqual(formatValue('date', '2028-08-31'), { date: '2028-08-31' });
});

test('a write lands on the board that owns the field, never on the mirror', async () => {
  const c = await applyWrite({ action: 'update_column', fieldKey: 'buyer_1_name_en', value: 'Avi Chaim Rosalimsky' }, ctx());
  assert.strictEqual(String(c.boardId), '1603266147', 'buyer name must go to לקוחות');
  assert.strictEqual(c.columnId, 'text_mkpjqr1p', 'must target the client column, not lookup96__1');
  assert.strictEqual(c.itemId, '2725704387');

  const p = await applyWrite({ action: 'update_column', fieldKey: 'permit_date', value: '2026-01-15' }, ctx());
  assert.strictEqual(String(p.boardId), '1603266150', 'היתר must go to פרוייקטים');
  assert.strictEqual(p.columnId, 'date_mkmddzcx');

  const d = await applyWrite({ action: 'update_column', fieldKey: 'apartment_sqm', value: '90' }, ctx());
  assert.strictEqual(String(d.boardId), '1603266152');
  assert.strictEqual(d.user, 'shayna@epsteinlaw.co.il', 'the write is attributed to the person, not to LAWLY');
});
