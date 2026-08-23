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

test('no second buyer linked -> nothing about buyer 2, and no question either', () => {
  const keys = run(deal()).missing.map(f => f.key);
  assert.ok(!keys.some(k => k.startsWith('buyer_2_')), 'nothing about him');
  assert.ok(!keys.includes('client_2_link'), 'the link is read, never asked');
  assert.ok(!keys.includes('has_buyer_2'), 'and there is no question at all');
  assert.ok(!MAP.fields.some(f => f.key === 'has_buyer_2'), 'the question is not even on the map');
});

test('a second buyer linked -> his card is asked for, still no question', () => {
  const d = deal();
  d.column_values['link_to_______2__1'] =
    { type: 'board_relation', text: 'buyer two', linked: [{ id: '2733400452', name: 'buyer two' }] };
  const keys = run(d).missing.map(f => f.key);
  assert.ok(keys.filter(k => k.startsWith('buyer_2_')).length >= 8, 'his whole card');
  assert.ok(!keys.includes('client_2_link'), 'the link itself is never asked');
});

test('a linked second buyer whose card is complete asks nothing', () => {
  const d = deal();
  d.column_values['link_to_______2__1'] =
    { type: 'board_relation', text: 'buyer two', linked: [{ id: '2733400452', name: 'buyer two' }] };
  const { values } = buildFacts(MAP, d, { ...OWNERS, client2: OWNERS.client });
  const { missing } = findMissing(MAP, values, { clientLinked: true, client2Linked: true, projectLinked: true });
  assert.deepStrictEqual(missing.filter(f => f.key.startsWith('buyer_2_')).map(f => f.key), []);
});

test('a linked second buyer is asked for exactly what the first is', () => {
  const d = deal();
  d.column_values['link_to_______2__1'] =
    { type: 'board_relation', text: 'buyer two', linked: [{ id: '2733400452', name: 'buyer two' }] };
  const { values } = buildFacts(MAP, d, { ...OWNERS, client2: {} });   // linked, but his card is empty
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

test('only the apartment schedule is taken from לוח תשלומים', () => {
  const { paymentRows } = require('../lib/synopsis');
  const linked = [
    { id:'1', name:'שכ"ט מתווך',   group:'אנשי מקצוע',  cells:{ dropdown_mkm04cr6:'שכ"ט מתווך', numbers__1:'59000' } },
    { id:'2', name:'תשלום 1',      group:'תשלומי דירה', cells:{ dropdown_mkm04cr6:'תשלום 1', numbers__1:'100000' } },
    { id:'3', name:'אימות חתימה',  group:'הוצאות',      cells:{ dropdown_mkm04cr6:'אימות חתימה', numbers__1:'350' } },
    { id:'4', name:'תשלום 2',      group:'תשלומי דירה', cells:{ dropdown_mkm04cr6:'תשלום 2', numbers__1:'400000' } }
  ];
  const rows = paymentRows(MAP, linked);
  assert.strictEqual(rows.length, 2, 'fees and expenses are not part of the letter schedule');
  assert.deepStrictEqual(rows.map(r => r.title), ['תשלום 1', 'תשלום 2']);
});

test('הנחות / תנאים is not shown at all when the answer is לא', () => {
  const keys = run(deal({ single_select93__1: 'לא' })).missing.map(f => f.key);
  assert.ok(!keys.includes('special_terms'), 'not even as optional');
  assert.ok(run(deal({ single_select93__1: 'כן' })).missing.some(f => f.key === 'special_terms'),
    'and it IS asked once the answer is כן');
});

test('there is exactly one /api/me, and it reports capabilities', () => {
  // Two routers both defined /api/me. The first mounted won, so the second was
  // dead code — and a field added to the dead one had no effect at all, which
  // is why the synopsis button stayed missing through several deploys.
  const dir = path.join(__dirname, '..', 'routes');
  const hits = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/router\.get\(\s*['"]\/api\/me['"]/g)) hits.push(f);
  }
  assert.strictEqual(hits.length, 1,
    'exactly one /api/me handler expected, found: ' + (hits.join(', ') || 'none'));

  const src = fs.readFileSync(path.join(dir, hits[0]), 'utf8');
  assert.ok(src.includes('capabilitiesFor'),
    hits[0] + ' serves /api/me and must report capabilities — the UI gates on it');
});

// ---- the reference letter -------------------------------------------------

test('replacing the reference cannot happen without an explicit confirmation', async () => {
  const ref = require('../lib/synopsis/reference');
  const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  // Anything other than the literal true is refused, and refused before the
  // code ever reaches the part that clears the column.
  for (const confirmed of [undefined, false, 'yes', 1, 'true']) {
    await assert.rejects(
      () => ref.uploadToProject('1', 'x.docx', docx, { replace: true, confirmed, replacingAssetId: '9' }),
      e => { assert.ok(e.message.includes('אישור מפורש'), 'got: ' + e.message); return true; });
  }
});

test('only one board and one column can ever be cleared', () => {
  const ref = require('../lib/synopsis/reference');
  assert.deepStrictEqual(ref.CLEARABLE, { boardId: '1603266150', columnId: 'file_mkswxqpn' });
  assert.ok(Object.isFrozen(ref.CLEARABLE), 'the target must not be reassignable at runtime');

  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'synopsis', 'reference.js'), 'utf8');
  const clearFn = src.slice(src.indexOf('async function clearProjectFile'),
                            src.indexOf('async function uploadToProject'));
  assert.ok(clearFn.includes('CLEARABLE.boardId') && clearFn.includes('CLEARABLE.columnId'),
    'the clear must target the hard-coded board and column, never a caller-supplied one');
  assert.ok(!/boardId:\s*String\(boardId/.test(clearFn), 'no caller-supplied board id');
});

test('a replace backs the old file up before clearing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'synopsis', 'reference.js'), 'utf8');
  const body = src.slice(src.indexOf('async function uploadToProject'),
                         src.indexOf('async function rawUpload'));
  assert.ok(body.indexOf('fetchAsset') < body.indexOf('clearProjectFile'),
    'the old file must be downloaded BEFORE the column is cleared');
  assert.ok(body.includes('reference.restored'), 'and put back if the new upload fails');
});

test('LAWLY no longer writes the client name to the project card', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'synopsis.js'), 'utf8');
  assert.ok(!routes.includes('__reference_client'),
    'the לקוח אחרון write was removed — it must not come back quietly');
});

test('the reference module never stores a copy of the document', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'synopsis', 'reference.js'), 'utf8');
  // It records a pointer — deal, asset, file name. Two copies of a letter is
  // how the wrong one gets sent.
  for (const bad of ['file_size BYTEA', 'content', 'BYTEA', 'base64'])
    assert.ok(!src.includes(bad), 'the reference table must not hold file content: ' + bad);
  assert.ok(src.includes('asset_id'), 'it stores which asset, not the asset');
});

test('only a genuine Word file can become the reference', async () => {
  const ref = require('../lib/synopsis/reference');
  assert.deepStrictEqual([...ref.DOC_EXT], ['.docx']);

  const rejects = async (name, buf, contains) => {
    await assert.rejects(() => ref.uploadToProject('1', name, buf), e => {
      assert.ok(e.message.includes(contains), `expected "${contains}" in "${e.message}"`);
      return true;
    });
  };
  await rejects('letter.pdf',  Buffer.from('%PDF-1.4'), 'Word');
  await rejects('letter.doc',  Buffer.from('anything'), 'Word');
  // a PDF renamed to .docx must not slip through — a .docx is a zip
  await rejects('letter.docx', Buffer.from('%PDF-1.4 renamed'), 'תקין');
  await rejects('letter.docx', Buffer.alloc(0), 'ריק');
});

test('the feature may do exactly three things to monday, and no more', () => {
  const dir = path.join(__dirname, '..', 'lib', 'synopsis');
  const src = fs.readdirSync(dir).filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') +
    fs.readFileSync(path.join(__dirname, '..', 'routes', 'synopsis.js'), 'utf8');

  const forbidden = ['delete_item', 'delete_board', 'delete_column', 'delete_group',
                     'archive_item', 'archive_board', 'archive_group',
                     'move_item_to_board', 'move_item_to_group',
                     'duplicate_item', 'duplicate_board', 'create_item', 'create_board',
                     'clear_item_updates', 'delete_update'];
  for (const m of forbidden)
    assert.ok(!src.includes(m), 'the synopsis feature must never contain "' + m + '"');

  // Three GraphQL mutations exist in the feature, and only three:
  //   1. change_column_value      — the field write, behind the eight-check gate
  //   2. change_column_value      — clear_all, ONLY on the project's reference column
  //   3. add_file_to_column       — putting the new reference letter there
  const mutations = (src.match(/mutation\s*\(/g) || []).length;
  assert.strictEqual(mutations, 3, 'a new mutation appeared — was it meant to?');
  assert.ok(src.includes('change_column_value'));
  assert.ok(src.includes('add_file_to_column'));
  assert.ok(Object.isFrozen(require('../lib/synopsis/reference').CLEARABLE));

  // clear_all destroys files. It may be USED in exactly one place — mentions in
  // comments do not count, but a second call would.
  const clears = (src.match(/clear_all:\s*true/g) || []).length;
  assert.strictEqual(clears, 1, 'clear_all must be called in exactly one place');
  const ref = fs.readFileSync(path.join(dir, 'reference.js'), 'utf8');
  const guarded = ref.slice(ref.indexOf('async function clearProjectFile'),
                            ref.indexOf('async function uploadToProject'));
  assert.ok(guarded.includes('clear_all'), 'and that place is clearProjectFile');
});

test('the build page is gated the same way as the facts page', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes("'/synopsis-build.html'"), 'the build page must be behind the capability check');
  const at = server.indexOf("app.get(['/synopsis.html'");
  const gate = server.slice(at, server.indexOf('express.static', at));
  assert.ok(gate.includes("can(req.session.roles, 'synopsis', 'use')"),
    'both pages must require the synopsis capability');
});

test('LAWLY_READ_ONLY stops every monday write — the staging guarantee', async () => {
  const prev = process.env.LAWLY_READ_ONLY;
  process.env.LAWLY_READ_ONLY = '1';
  try {
    // the module reads the flag at call time, so re-require is not needed
    delete require.cache[require.resolve('../lib/synopsis/reference')];
    const ref = require('../lib/synopsis/reference');
    const r = await ref.uploadToProject('1', 'x.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]));
    assert.strictEqual(r.readOnly, true, 'the reference upload must be refused');

    // and the field write
    const wgPath = require.resolve('../lib/synopsis/write-gate');
    delete require.cache[wgPath];
    const wg = require('../lib/synopsis/write-gate');
    assert.strictEqual(wg.READ_ONLY, true, 'the write gate must be in read-only mode');
  } finally {
    if (prev === undefined) delete process.env.LAWLY_READ_ONLY;
    else process.env.LAWLY_READ_ONLY = prev;
    delete require.cache[require.resolve('../lib/synopsis/reference')];
    delete require.cache[require.resolve('../lib/synopsis/write-gate')];
  }
});

test('staging mode forces read-only and silences the schedulers', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes("LAWLY_STAGING === '1'"), 'there must be one staging flag');
  const block = server.slice(server.indexOf("const STAGING ="), server.indexOf('const app ='));
  assert.ok(block.includes("process.env.LAWLY_READ_ONLY = '1'"),
    'staging must force read-only rather than rely on a second variable being set');
  assert.ok(server.includes('[staging] unanswered-digest scheduler not started'),
    'the digest scheduler must not arm on staging');
  assert.ok(server.includes('[staging] email NOT sent'),
    'outbound email must be dropped on staging');
});

test('the audit table matches the portal\'s real id types', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'synopsis', 'audit.js'), 'utf8');
  const create = src.slice(src.indexOf('CREATE TABLE IF NOT EXISTS synopsis_audit'),
                           src.indexOf('CREATE INDEX'));
  // User ids in this portal are UUIDs. Declaring them BIGINT made every insert
  // fail with "invalid input syntax for type bigint", and the table stayed empty
  // while the console still showed each line — a log that looks fine and records nothing.
  assert.ok(!/user_id\s+BIGINT/i.test(create), 'user_id must not be BIGINT — ids are UUIDs');
  assert.ok(/user_id\s+TEXT/i.test(create), 'user_id must be TEXT');
  assert.ok(!/\bid\s+BIGINT/i.test(create.replace(/BIGSERIAL/g, '')),
    'no other column should assume a numeric id');
  assert.ok(src.includes('ALTER COLUMN user_id TYPE TEXT'),
    'an already-created table must be widened, not left broken');
});

// ---- the module boundary --------------------------------------------------

test('everything routes/synopsis.js takes off lib/synopsis actually exists there', () => {
  // routes reach the feature through one entry point. If a helper is added to a
  // file inside the folder and not re-exported, the route fails at RUN time with
  // "x is not a function" — which is exactly how it broke in production once.
  const barrel = require('../lib/synopsis');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'synopsis.js'), 'utf8');

  const destructured = (src.match(/const \{([^}]*)\} = synopsis;/) || [, ''])[1]
    .split(',').map(x => x.trim()).filter(Boolean);
  const dotted = [...src.matchAll(/\bsynopsis\.(\w+)\s*\(/g)].map(m => m[1]);

  const used = [...new Set([...destructured, ...dotted])];
  assert.ok(used.length >= 8, 'expected the route to use several exports, found ' + used.length);
  for (const name of used)
    assert.ok(name in barrel, `lib/synopsis does not export "${name}" — routes/synopsis.js uses it`);
});

// ---- computed values ------------------------------------------------------

test('fees and tax are computed from the price, never asked for', () => {
  const { derive, compare } = require('../lib/synopsis/derive');
  const v = { purchase_price: '2500000', attorney_fee_pct: '0.75', broker_fee_pct: '2',
              tax_profile: 'תושב חוץ - 8%' };
  const c = derive(MAP, v);
  assert.strictEqual(c.attorney_fee_incl_vat.value, '22125');   // 0.75% + VAT
  assert.strictEqual(c.broker_fee_incl_vat.value, '59000');     // 2% + VAT
  assert.strictEqual(c.purchase_tax.value, '200000');           // 8%, non-resident

});

test("the board's figure stays the value; the arithmetic is shown beside it", () => {
  const { derive } = require('../lib/synopsis/derive');
  const d = deal({ numbers_mkmck5ye: '200545' });            // the real letter's wrong tax
  const { values } = buildFacts(MAP, d, { ...OWNERS, client2: {} });
  const computed = derive(MAP, values);
  const { fields } = findMissing(MAP, values, ctxLinked, computed);
  const tax = fields.find(f => f.key === 'purchase_tax');
  assert.strictEqual(values.purchase_tax, '200545', 'the board value is NOT overwritten');
  assert.strictEqual(tax.computedValue, '200000', 'the arithmetic is carried alongside');
  assert.strictEqual(tax.computedAgrees, false, 'and the disagreement is flagged');

  // when the board agrees, it says so rather than complaining
  const ok = findMissing(MAP, { ...values, purchase_tax: '200000' }, ctxLinked,
    derive(MAP, values)).fields.find(f => f.key === 'purchase_tax');
  assert.strictEqual(ok.computedAgrees, true);
});

test('a computed value that disagrees with the board is surfaced', () => {
  const { derive, compare } = require('../lib/synopsis/derive');
  // the real Rosalimsky letter states 200,545 where 8% of 2,500,000 is 200,000
  const v = { purchase_price: '2500000', tax_profile: 'תושב חוץ - 8%', purchase_tax: '200545' };
  const bad = compare(derive(MAP, v), v).find(r => r.key === 'purchase_tax');
  assert.strictEqual(bad.agrees, false, 'the discrepancy must be reported');
  assert.strictEqual(bad.computed, 200000);
  assert.strictEqual(bad.onBoard, 200545);
});

test('nothing is computed from an ambiguous tax profile', () => {
  const { derive } = require('../lib/synopsis/derive');
  const v = { purchase_price: '2500000', tax_profile: 'מס לפי שומה עצמית' };
  assert.ok(!derive(MAP, v).purchase_tax, 'a bracket is not a flat rate — do not guess');
});

test('fields that appear in no real synopsis are not on the map', () => {
  for (const k of ['property_address', 'plot', 'num_payments', 'has_mortgage',
                   'who_signs', 'company_lawyer_fee_default'])
    assert.ok(!MAP.fields.some(f => f.key === k), k + ' should have been removed');
});

// ---- what this feature may do to monday ----------------------------------

test('update_column is the only action the write gate accepts', () => {
  assert.deepStrictEqual([...ALLOWED_ACTIONS], ['update_column']);
});

test('only admin, tech and paralegal may open the synopsis generator', () => {
  const { can } = require('../lib/permissions');
  for (const r of ['admin', 'tech', 'paralegal']) assert.ok(can([r], 'synopsis', 'use'), r + ' should have it');
  for (const r of ['lawyer', 'accountant', 'notary', 'marketing', 'law_intern', 'team_manager'])
    assert.ok(!can([r], 'synopsis', 'use'), r + ' must NOT have it');
  assert.ok(!can([], 'synopsis', 'use'), 'no roles means no access');
});

test('capabilities are case-insensitive — roles are stored capitalized for some users', () => {
  const { can, capabilitiesFor } = require('../lib/permissions');
  // A user whose roles read "Admin, Tech" must get exactly what "admin, tech" gets.
  assert.ok(can(['Admin'], 'synopsis', 'use'), 'Admin (capitalized) must have it');
  assert.ok(can(['Tech'], 'synopsis', 'use'), 'Tech (capitalized) must have it');
  assert.ok(can(['Paralegal'], 'synopsis', 'use'), 'Paralegal (capitalized) must have it');
  assert.ok(can([' paralegal '], 'synopsis', 'use'), 'stray whitespace must not matter');
  assert.ok(!can(['Lawyer'], 'synopsis', 'use'), 'and it must not accidentally grant');

  // and it is not only synopsis — every capability was affected
  const caps = capabilitiesFor(['Admin']);
  assert.ok(caps.monday.has('write_any'), 'an Admin must have monday write');
  assert.ok(caps.gmail.has('draft'), 'an Admin must have gmail draft');
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

test('a status field the board already answers is read, not asked — שפה מדוברת', () => {
  const filled = run(deal({ single_select0__1: 'אנגלית' }));
  assert.ok(!filled.missing.some(f => f.key === 'spoken_language'), 'already answered — do not ask');
  assert.strictEqual(filled.present.find(f => f.key === 'spoken_language').value, 'אנגלית');

  const blank = run(deal({ single_select0__1: null })).missing.find(f => f.key === 'spoken_language');
  assert.ok(blank, 'asked when genuinely empty');
  assert.strictEqual(blank.inputType, 'status', 'and it must render as a dropdown, not a text box');
});

test('every status / dropdown field carries the type that makes it a dropdown', () => {
  for (const f of MAP.fields.filter(f => (f.ownerType || f.type) === 'status' || (f.ownerType || f.type) === 'dropdown')) {
    assert.ok(f.ownerColumnId, f.key + ': needs a column to read its labels from');
    assert.ok(['deal', 'client', 'client2', 'project'].includes(f.owner), f.key + ': unknown owner');
  }
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

test('every successful write is recorded, and a logging fault never fails the write', async () => {
  const logged = [];
  const c = { ...ctx(), log: e => logged.push(e) };
  const r = await applyWrite({ action: 'update_column', fieldKey: 'direction', value: 'צפון' }, c);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(logged.length, 1, 'the write must be recorded');
  assert.strictEqual(logged[0].after, 'צפון');
  assert.strictEqual(logged[0].user, 'shayna@epsteinlaw.co.il');

  // a broken logger must not turn a completed write into a reported failure
  const bad = { ...ctx(), log: () => { throw new Error('db down'); } };
  const r2 = await applyWrite({ action: 'update_column', fieldKey: 'direction', value: 'דרום' }, bad);
  assert.strictEqual(r2.ok, true, 'the write succeeded; logging failing must not undo that');

  // nor must a missing logger
  const none = { ...ctx() }; delete none.log;
  const r3 = await applyWrite({ action: 'update_column', fieldKey: 'direction', value: 'מערב' }, none);
  assert.strictEqual(r3.ok, true);
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

// ============================================================
// Reading the letter, and judging what changed between two versions.
// ============================================================
const { blocks } = require('../lib/synopsis/docx');
const { compareDocs, intrinsicallyClient, onlyDigitsDiffer } =
  require('../lib/synopsis/compare-docs');

const fixture = n => fs.readFileSync(path.join(__dirname, 'fixtures', 'fixture-' + n + '.docx'));

test('a .docx is read into ordered blocks, headings and tables intact', () => {
  const b = blocks(fixture('a'));
  assert.strictEqual(b[0].kind, 'heading');
  assert.strictEqual(b[0].text, 'SYNOPSIS OF CONTRACT');
  assert.strictEqual(b[1].level, 1);

  const table = b.find(x => x.kind === 'table');
  assert.ok(table, 'the payment table must survive as a table');
  assert.deepStrictEqual(table.rows[0], ['Payment', 'Amount', 'Due']);
  assert.strictEqual(table.rows[1][1], '382,300');

  // Hebrew comes back exactly as written, not mangled by the XML decode.
  assert.ok(b.some(x => x.text.includes('א.פ.י נתיב פיתוח בע"מ')));

  // Empty paragraphs carry no meaning and only add noise to a comparison.
  assert.ok(b.every(x => x.text.trim() !== ''));

  // Reading order is preserved, which is what makes two versions comparable.
  assert.deepStrictEqual(b.map(x => x.index), b.map((_, i) => i));
});

test('a file that is not a .docx is refused, not half-read', () => {
  assert.throws(() => blocks(Buffer.from('%PDF-1.4 this is a pdf')), /valid \.docx|zip/i);
  assert.throws(() => blocks(Buffer.alloc(0)), /empty/i);
});

test('a change is judged by WHY it is there, not by how it looks', () => {
  const r = compareDocs(blocks(fixture('a')), blocks(fixture('b')),
    { buyer_1_name_en: 'Karp', purchase_price: '4100000', apartment_no: '22' }, COLMAP);

  // The new boilerplate section is the ONLY thing offered to the template.
  assert.ok(r.proposals.length > 0);
  assert.ok(r.proposals.every(c => /Governing Law/i.test(c.heading)),
    'only genuinely general wording may be proposed for the template');

  // Everything under a benefits heading belongs to one client, full stop.
  const benefits = r.changes.filter(c => /Commercial Benefits/i.test(c.heading));
  assert.ok(benefits.length);
  assert.ok(benefits.every(c => c.absorbable === false),
    'a benefits clause must never be absorbable into the template');
});

test('the previous client\'s money can never be proposed for the template', () => {
  // The regression that matters: the template is itself seeded from a real
  // client's letter, so it still holds THAT client's price and payment table.
  // Judging only against the current client's values marked those "general" —
  // which would have offered to bake the previous client's money into the
  // template, contaminating every future letter.
  const r = compareDocs(blocks(fixture('a')), blocks(fixture('b')),
    { buyer_1_name_en: 'Karp' }, COLMAP);           // deliberately thin facts

  for (const c of r.proposals) {
    assert.ok(!/\d[\d,]{3,}/.test([c.before, c.after].join(' ')),
      'a block carrying an amount was proposed for the template: ' + (c.after || c.before));
    assert.notStrictEqual(c.kind, 'table', 'a payment table is never template material');
  }
});

test('money, percentages and dates are client data whoever the client is', () => {
  assert.ok(intrinsicallyClient('the price is 3,823,000'));
  assert.ok(intrinsicallyClient('a fee of 0.75%'));
  assert.ok(intrinsicallyClient('on 12.05.2026'));
  assert.ok(intrinsicallyClient('NIS four million'));
  assert.strictEqual(intrinsicallyClient('The parties shall act in good faith.'), null);

  // The same clause with different numbers is the same clause, refilled.
  assert.ok(onlyDigitsDiffer('Payment of 100,000 is due', 'Payment of 250,000 is due'));
  assert.ok(!onlyDigitsDiffer('Payment is due', 'Delivery is due'));
});

test('nothing decides on its own — every proposal is a proposal', () => {
  const r = compareDocs(blocks(fixture('a')), blocks(fixture('b')), {}, COLMAP);
  for (const c of r.changes) {
    assert.ok(['client', 'general', 'unsure'].includes(c.verdict));
    assert.strictEqual(c.absorbable, c.verdict === 'general');
    assert.ok(c.reason && c.reason.length, 'every judgement must say why');
  }
  // proposals and clientOnly together account for every change, with no overlap
  assert.strictEqual(r.proposals.length + r.clientOnly.length, r.changes.length);
});

// ============================================================
// Making the template: one real letter, minus everything that was that
// client's. This is the step that decides whether a previous client's data
// can reach the next letter, so it is tested from both directions.
// ============================================================
const { extractTemplate, assertClean } = require('../lib/synopsis/template');

// Real keys from config/synopsis-columns.json — not invented ones. If a key
// here stops existing on the map, that is a failure worth seeing.
const COLMAP = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'config', 'synopsis-columns.json'), 'utf8'));

const WEINSTEIN = {
  buyer_1_name_en: 'Weinstein', purchase_price: '3823000',
  apartment_no: '19', building_no: '1',
  seller_company: 'א.פ.י נתיב פיתוח בע"מ', seller_company_no: '511519134', gush: '34574',
};

test('the test facts use keys that actually exist on the column map', () => {
  const keys = new Set(COLMAP.fields.map(f => f.key));
  for (const k of Object.keys(WEINSTEIN))
    assert.ok(keys.has(k), 'no such field on the column map: ' + k);
});

test('the template is what is left after the client is removed', () => {
  const r = extractTemplate(blocks(fixture('a')), WEINSTEIN, COLMAP);

  // Structure survives: every heading is still there, in order.
  const heads = r.template.filter(b => b.kind === 'heading').map(b => b.text);
  assert.deepStrictEqual(heads,
    ['SYNOPSIS OF CONTRACT', '1. The Parties', '2. The Purchase Price', '3. Commercial Benefits']);

  // The client's own content became positions, not words.
  assert.ok(r.removed >= 4);
  assert.ok(r.slots.every(s => s.kind === 'slot' && !('text' in s)),
    'a slot must not carry the text it replaced');
  assert.ok(r.slots.every(s => s.reason && s.reason.length), 'every removal must say why');
});

test('nothing of the source client survives into the stored template', () => {
  const r = extractTemplate(blocks(fixture('a')), WEINSTEIN, COLMAP);
  const text = r.template.filter(b => b.kind !== 'slot').map(b => b.text).join(' ');

  assert.ok(!/Weinstein/i.test(text), 'the previous client\'s name must be gone');
  assert.ok(!/3,?823,?000/.test(text), 'the previous client\'s price must be gone');
  assert.ok(!/382,?300/.test(text), 'the previous client\'s payment table must be gone');
  assert.ok(!/kitchen|parking space/i.test(text), 'the previous client\'s benefits must be gone');

  assert.strictEqual(assertClean(r.template, WEINSTEIN, COLMAP), true);
});

test('what the whole project shares is boilerplate, not client data', () => {
  const r = extractTemplate(blocks(fixture('a')), WEINSTEIN, COLMAP);
  const text = r.template.filter(b => b.kind !== 'slot').map(b => b.text).join(' ');

  // The seller's company and its number are the same for every buyer here.
  // Stripping them would gut the template of real content.
  assert.ok(/511519134/.test(text), 'the seller company number belongs in the template');
  assert.ok(/נתיב פיתוח/.test(text), 'the seller name belongs in the template');
});

test('a template that still holds client data is refused, not saved', () => {
  // Simulate the classifier having missed something.
  const dirty = [{ index: 0, kind: 'paragraph', text: 'Sold to Mr. Weinstein for 3,823,000.' }];
  assert.throws(() => assertClean(dirty, WEINSTEIN, COLMAP), /עדיין מכילה נתונים/);
});

test('an empty document cannot become a template', () => {
  assert.throws(() => extractTemplate([], WEINSTEIN, COLMAP), /אין מה לפרק/);
});

// ============================================================
// The collision Shira found: "כתוב 8 אחוז ריבית שזה כללי ובדיוק ללקוח יש נתון 8
// על משהו אחר — זה יושמט?"  It would have. This is what stops it.
// ============================================================
const { blockTopic } = require('../lib/synopsis/topics');
const { judgeBlock, clientMarkers } = require('../lib/synopsis/compare-docs');

test('the same number on two different subjects is not the same fact', () => {
  const facts = { tax_profile: 'דירה שניה - 8%', purchase_price: '3823000' };
  const mk = clientMarkers(facts, COLMAP);

  // 8% that IS this client's tax — removed.
  const tax = judgeBlock(null, 'The Purchaser shall pay purchase tax at the rate of 8%.',
                         '4. Taxation', mk);
  assert.strictEqual(tax.verdict, 'client');

  // 8% that merely shares the digits — NOT removed on the strength of that.
  const interest = judgeBlock(null, 'Interest at the rate of 8% per annum shall accrue on any late payment.',
                              'General Provisions', mk);
  assert.notStrictEqual(interest.verdict, 'client',
    'a general interest clause must not be stripped because the digits match a tax rate');
  assert.strictEqual(interest.absorbable, false,
    'and it must not be silently kept either — it goes for a second opinion');
});

test('a block is placed by its subject, and never guessed', () => {
  assert.strictEqual(blockTopic('3. Commercial Benefits', 'x').topic, 'benefits');
  assert.strictEqual(blockTopic('2. The Purchase Price', 'x').topic, 'price');
  assert.ok(blockTopic('4. Taxation', 'purchase tax at 8%').confident);

  // Nothing recognisable: no topic is invented.
  const none = blockTopic('', 'The parties shall act in good faith.');
  assert.ok(!none.confident, 'an unreadable block must not be given a confident topic');
});

test('the model is asked once, about the doubtful blocks only, and decides nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'synopsis', 'ask-model.js'), 'utf8');

  // It must never be handed board structure — only words.
  for (const leak of ['columnId', 'column_id', 'boardId', 'board_id', 'itemId', 'item_id'])
    assert.ok(!src.includes(leak), 'the model must never see ' + leak);

  // It cannot reach monday from here, whatever it answers.
  assert.ok(!src.includes('change_column_value') && !src.includes('api.monday.com'));

  // One call, capped, carrying the batch together.
  assert.ok(/MAX_BLOCKS/.test(src));
  assert.strictEqual((src.match(/await askJSON\(/g) || []).length, 1,
    'exactly one model call per letter');

  // Anything that is not one of the two words is discarded, not coerced.
  assert.ok(src.includes("v.verdict !== 'client' && v.verdict !== 'general'"));
});

test('when the model is unavailable nothing is decided in its place', async () => {
  const { classifyUnsure } = require('../lib/synopsis/ask-model');
  const before = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const out = await classifyUnsure([{ index: 0, text: 'x', heading: 'y' }], {});
    assert.strictEqual(out.size, 0, 'no key must mean no verdicts, not default verdicts');
  } finally {
    if (before !== undefined) process.env.ANTHROPIC_API_KEY = before;
  }
});

// ============================================================
// Emptying a field — an UPDATE that sets the value to nothing, not a delete.
// Until this was fixed, clearing a box did nothing at all AND the page said
// "nothing to update — the board is already full", so a deliberate change was
// thrown away and reported back as success.
// ============================================================
const { emptyValue } = require('../lib/synopsis/write-gate');

test('every writable column type knows how to be emptied', () => {
  assert.strictEqual(emptyValue('text'), '');
  assert.strictEqual(emptyValue('long_text'), '');
  assert.strictEqual(emptyValue('numbers'), '');
  assert.deepStrictEqual(emptyValue('date'), {});
  assert.deepStrictEqual(emptyValue('status'), {});
  assert.deepStrictEqual(emptyValue('dropdown'), { labels: [] });
  assert.deepStrictEqual(emptyValue('email'), { email: '', text: '' });
});

test('what must not be emptied through the form, is not', () => {
  // Files are the one irreversible thing on the board; links are structural.
  assert.throws(() => emptyValue('file'), /קבצים/);
  assert.throws(() => emptyValue('board_relation'), /קישור/);
  assert.throws(() => emptyValue('mirror'), /לא ניתן לרוקן/);
});

test('a clear is refused when there is nothing there to clear', async () => {
  const map = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config', 'synopsis-columns.json'), 'utf8'));
  const field = map.fields.find(f => f.writable && f.ownerColumnId && f.owner === 'deal');

  let hit = false;
  await assert.rejects(
    () => applyWrite({ action: 'update_column', fieldKey: field.key, value: '', clear: true }, {
      map, dealId: '1', dealBoardId: String(map.boards.deal.id),
      ownerItemIds: {}, session: { email: 'x@y.z', roles: ['admin'], userId: 'u' },
      runId: 'r', before: { [field.key]: '' },
      log: () => {}, write: () => { hit = true; return {}; },
    }),
    /כבר ריק/);
  assert.strictEqual(hit, false, 'monday must not be called for a no-op clear');
});

test('clearing goes through the one permitted action, and is logged as a deletion', async () => {
  const map = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config', 'synopsis-columns.json'), 'utf8'));
  const field = map.fields.find(f => f.writable && f.ownerColumnId && f.owner === 'deal'
                                     && ['text', 'long_text'].includes(f.ownerType || f.type));

  const lines = [];
  const entry = await applyWrite(
    { action: 'update_column', fieldKey: field.key, value: '', clear: true }, {
      map, dealId: '1', dealBoardId: String(map.boards.deal.id),
      ownerItemIds: {}, session: { email: 'x@y.z', roles: ['admin'], userId: 'u' },
      runId: 'r', before: { [field.key]: 'something that was there' },
      log: e => lines.push(e), write: (b, i, c, v) => ({ boardId: b, columnId: c, value: v }),
    });

  assert.strictEqual(entry.proposal.action, 'update_column',
    'emptying is an update, not a second kind of action');
  assert.strictEqual(entry.event, 'write.emptied');
  assert.strictEqual(entry.before, 'something that was there');
  assert.strictEqual(entry.after, '');
  assert.strictEqual(lines.length, 1, 'a deletion must always leave a line behind');
});

test('the page sends deletions explicitly, never as a blank value', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'synopsis.html'), 'utf8');

  // A clear is its own list, and only for fields the board actually holds.
  assert.ok(/const clear = Object\.keys\(DRAFT\)/.test(html));
  assert.ok(html.includes("!isBlank(BOARD[k])"),
    'an untouched empty field must never be sent as a deletion');
  assert.ok(/values, clear \}/.test(html), 'the clear list must reach the server');

  // And the paralegal is told, by name, what is about to be deleted.
  assert.ok(html.includes('יתרוקנו'), 'emptying a value must be confirmed before it happens');
});


test('every name the routes take off the barrel actually exists on it', () => {
  // A module can go missing from a deploy without anything failing at boot:
  // routes/synopsis.js reaches synopsis.reference.state() only when someone
  // opens the build page, and until then the gap is invisible. This test makes
  // an incomplete upload fail here instead of in front of a paralegal.
  const barrel = require('../lib/synopsis');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'synopsis.js'), 'utf8');
  // Only real uses — `synopsis.name(` or `synopsis.name.` — so the filename in
  // the header comment is not mistaken for a missing export.
  const used = [...new Set([...src.matchAll(/\bsynopsis\.([a-zA-Z_][a-zA-Z0-9_]*)\s*[.(]/g)]
    .map(m => m[1]))];
  const missing = used.filter(n => barrel[n] === undefined);
  assert.deepStrictEqual(missing, [],
    'routes/synopsis.js uses names the barrel does not export: ' + missing.join(', '));
});
