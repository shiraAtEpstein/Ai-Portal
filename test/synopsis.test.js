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
  column_values['connect_boards94__1']    = { type: 'board_relation', text: 'client', linked: [{ id: '2725704387', name: 'client' }] };
  column_values['connect_boards_165__1']  = { type: 'board_relation', text: 'project', linked: [{ id: '1807156384', name: 'project' }] };
  return { id: '1', name: 'test', boardId: '1603266152', boardName: 'לידים / עסקאות קבלן', column_values };
}

/** The linked client + project items, read directly — not through mirrors. */
const OWNERS = {
  client: {
    text_mkpjqr1p: { text: 'Avi Chaim Rosalimsky' }, text_mkqvrehd: { text: 'אבי חיים רוזאלימסקי' },
    text1__1: { text: 'A06912601' }, status_10__1: { text: 'Passport' },
    location__1: { text: '40-08 Wilson Street, Fair Lawn, NJ, USA' },
    contact_email: { text: 'avi@example.com' }, contact_phone: { text: '12013629312' },
    dropdown__1: { text: 'United States' }, color_mm33bjc1: { text: 'English' },
    title__1: { text: 'Rabbi' }
  },
  project: {
    text18__1: { text: 'Nativ Neve Shamir' }, text13__1: { text: 'בדיקה בע"מ' },
    text_mksyhx5m: { text: 'Test Ltd.' }, text86__1: { text: '1234' },
    text_mkmetb8s: { text: 'ירושלים' }, text9__1: { text: 'האופה' },
    text21__1: { text: '1' }, text3__1: { text: '3' },
    date_mkmddzcx: { text: '2025-01-01' }
  }
};
const ctxLinked = { clientLinked: true, client2Linked: false, projectLinked: true };
const run = d => {
  const { values } = buildFacts(MAP, d, { ...OWNERS, client2: {} });
  return { values, ...findMissing(MAP, values, ctxLinked) };
};

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

test('a field that does not apply to this deal is not shown at all', () => {
  // no contractor's loan -> the loan percentage is not on the form
  const no = run(deal({ status0__1: 'לא' }));
  assert.ok(!no.missing.some(f => f.key === 'contractor_loan_pct'), 'loan % must be hidden');
  assert.ok(no.hidden.includes('contractor_loan_pct'));
  // once there is a loan it appears, and it is required
  const yes = run(deal({ status0__1: 'כן' })).missing.find(f => f.key === 'contractor_loan_pct');
  assert.ok(yes && yes.required, 'loan % must appear and be required once there is a loan');
});

test('no מדד -> the index start date is not asked', () => {
  assert.ok(!run(deal({ status_mkm0x7dj: 'לא' })).missing.some(f => f.key === 'index_start_date'));
  assert.ok(run(deal({ status_mkm0x7dj: 'כן' })).missing.some(f => f.key === 'index_start_date'));
});

test('no linked second buyer -> nothing about buyer 2 is asked', () => {
  const keys = run(deal()).missing.map(f => f.key);          // no client_2_link in the sample
  assert.ok(!keys.some(k => k.startsWith('buyer_2_')), 'buyer 2 must be silent when nobody is linked');
});

test('a linked second buyer is asked for exactly what the first is', () => {
  const d = deal();
  d.column_values['link_to_______2__1'] =
    { type: 'board_relation', text: 'buyer two', linked: [{ id: '2733400452', name: 'buyer two' }] };
  const { values } = buildFacts(MAP, d, { ...OWNERS, client2: {} });   // linked, but his item is empty
  const { missing } = findMissing(MAP, values,
    { clientLinked: true, client2Linked: true, projectLinked: true });
  const asked = new Set(missing.map(f => f.key));
  const buyer1Fields = MAP.fields.filter(f => f.key.startsWith('buyer_1_')).map(f => f.key);
  for (const k of buyer1Fields) {
    const k2 = k.replace('buyer_1_', 'buyer_2_');
    assert.ok(MAP.fields.some(f => f.key === k2), 'buyer 2 must have the same field as buyer 1: ' + k2);
    assert.ok(asked.has(k2), 'his empty field must be asked, same as the first buyer: ' + k2);
  }
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

// ---- what this feature may do to monday ----------------------------------

test('update_column is the only action, and no destructive mutation exists in the code', () => {
  assert.deepStrictEqual([...ALLOWED_ACTIONS], ['update_column']);

  const dir = path.join(__dirname, '..', 'lib', 'synopsis');
  const src = fs.readdirSync(dir).filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') +
    fs.readFileSync(path.join(__dirname, '..', 'routes', 'synopsis.js'), 'utf8');

  const forbidden = ['delete_item', 'delete_board', 'delete_column', 'delete_group',
                     'archive_item', 'archive_board', 'archive_group',
                     'move_item_to_board', 'move_item_to_group',
                     'duplicate_item', 'duplicate_board', 'create_item', 'create_board'];
  for (const m of forbidden)
    assert.ok(!src.includes(m), 'the synopsis feature must never contain "' + m + '"');

  // exactly one mutation, and it is the column update
  const mutations = src.match(/mutation\s*\(/g) || [];
  assert.strictEqual(mutations.length, 1, 'expected exactly one GraphQL mutation in the feature');
  assert.ok(src.includes('change_column_value'), 'the one mutation must be change_column_value');
});

test('only admin, tech and paralegal may open the synopsis generator', () => {
  const { can } = require('../lib/permissions');
  for (const r of ['admin', 'tech', 'paralegal']) assert.ok(can([r], 'synopsis', 'use'), r + ' should have it');
  for (const r of ['lawyer', 'accountant', 'notary', 'marketing', 'law_intern', 'team_manager'])
    assert.ok(!can([r], 'synopsis', 'use'), r + ' must NOT have it');
  assert.ok(!can([], 'synopsis', 'use'), 'no roles means no access');
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

test('a field that is not on the map is refused', async () => {
  await rejects({ action: 'update_column', fieldKey: 'signing_method', value: 'x' }, ['paralegal'], 'unknown field');
});

test('project and client values are read from the linked item, not from a mirror', () => {
  const v = run(deal()).values;
  assert.strictEqual(v.city, 'ירושלים', 'city comes from the project item');
  assert.strictEqual(v.street, 'האופה', 'street has no mirror on the deal board and must still read');
  assert.strictEqual(v.buyer_1_id_number, 'A06912601');
});

test('nothing already on the linked client or project card is ever asked for', () => {
  const r = run(deal());
  const asked = new Set(r.missing.map(f => f.key));
  const has = new Set(r.present.map(f => f.key));

  // every value the linked cards hold must land in `present`, never on the form
  const onCards = ['buyer_1_name_en', 'buyer_1_name_he', 'buyer_1_id_number', 'buyer_1_id_type',
                   'buyer_1_address', 'buyer_1_email', 'buyer_1_phone', 'buyer_1_country', 'buyer_1_title',
                   'project_name_en', 'seller_company', 'seller_company_en', 'seller_company_no',
                   'city', 'street', 'gush', 'chelka', 'permit_date'];
  for (const k of onCards) {
    assert.ok(has.has(k), k + ' is on the linked card and must be read, not asked');
    assert.ok(!asked.has(k), k + ' must NOT appear on the form — the card already has it');
  }
  // and each one is attributed to the card it came from, for the summary strip
  const city = r.present.find(f => f.key === 'city');
  assert.strictEqual(city.owner, 'project');
  assert.strictEqual(r.present.find(f => f.key === 'buyer_1_email').owner, 'client');
});

test('an unlinked project makes its fields blocked, with a reason', () => {
  const { values } = buildFacts(MAP, deal(), { client: OWNERS.client, client2: {}, project: {} });
  const { missing } = findMissing(MAP, values, { clientLinked: true, client2Linked: false, projectLinked: false });
  const city = missing.find(f => f.key === 'city');
  assert.ok(city && city.blockedReason, 'city must say why it cannot be filled');
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
