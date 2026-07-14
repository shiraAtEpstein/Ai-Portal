const test = require('node:test');
const assert = require('node:assert');
const fr = require('../lib/firm-rules');

function memStore() {
  const reqs = []; let nextId = 1; const rules = [];
  return {
    _reqs: reqs, _rules: rules,
    async findPendingByKey(key) { const r = reqs.find((x) => x.key === key && x.status === 'pending'); return r ? r.id : null; },
    async insertRequest(row) { const id = nextId++; reqs.push(Object.assign({ id, status: 'pending' }, row)); return id; },
    async getRequest(id) { const r = reqs.find((x) => x.id === id); return r ? { id: r.id, text: r.text, source: r.source, status: r.status } : null; },
    async listPending() { return reqs.filter((x) => x.status === 'pending').map((r) => ({ id: r.id, text: r.text, source: r.source })); },
    async listRecent(l) { return reqs.slice().reverse().slice(0, l).map((r) => ({ id: r.id, text: r.text, status: r.status })); },
    async setStatus(id, status) { const r = reqs.find((x) => x.id === id && x.status === 'pending'); if (!r) return false; r.status = status; return true; },
    async insertActiveRule({ text }) { const version = rules.length + 1; rules.push({ version, text, active: true }); return version; },
    async listActiveRules() { return rules.filter((r) => r.active).map((r) => ({ version: r.version, text: r.text })); },
  };
}

test('form submit stages a pending request', async () => {
  const store = memStore();
  const r = await fr.submitRequest({ store, text: 'All client emails must be answered within 24 hours.', source: 'form', name: 'Shira' });
  assert.equal(r.ok, true); assert.equal(r.status, 'pending'); assert.equal(r.duplicate, false);
  const p = await fr.listPending({ store });
  assert.equal(p.length, 1);
  assert.equal(p[0].text, 'All client emails must be answered within 24 hours.');
});

test('empty text is rejected', async () => {
  const store = memStore();
  const r = await fr.submitRequest({ store, text: '   ', source: 'form' });
  assert.equal(r.ok, false);
});

test('duplicate pending request is de-duplicated', async () => {
  const store = memStore();
  await fr.submitRequest({ store, text: 'Sign every letter with the firm name.', source: 'form' });
  const r2 = await fr.submitRequest({ store, text: 'sign  every LETTER with the firm name.', source: 'form' });
  assert.equal(r2.duplicate, true);
  const p = await fr.listPending({ store });
  assert.equal(p.length, 1);
});

test('approve moves the request to active rules and loadActiveRules renders it', async () => {
  const store = memStore();
  const s = await fr.submitRequest({ store, text: 'Always CC the paralegal on client emails.', source: 'form' });
  const a = await fr.approve(s.id, { store, adminId: 'admin1', adminName: 'Yaacov' });
  assert.equal(a.ok, true); assert.equal(a.version, 1);
  const pend = await fr.listPending({ store });
  assert.equal(pend.length, 0);
  const active = await fr.loadActiveRules({ store });
  assert.equal(active.items.length, 1);
  assert.match(active.text, /APPROVED FIRM-RULE UPDATES/);
  assert.match(active.text, /Always CC the paralegal/);
});

test('approving a non-pending id fails cleanly', async () => {
  const store = memStore();
  const s = await fr.submitRequest({ store, text: 'Use NIS by default.', source: 'form' });
  await fr.approve(s.id, { store });
  const again = await fr.approve(s.id, { store });
  assert.equal(again.ok, false);
});

test('reject marks the request and adds no active rule', async () => {
  const store = memStore();
  const s = await fr.submitRequest({ store, text: 'Ban comic sans in letters.', source: 'form' });
  const r = await fr.reject(s.id, { store, adminName: 'Yaacov' });
  assert.equal(r.ok, true);
  const active = await fr.loadActiveRules({ store });
  assert.equal(active.items.length, 0);
  assert.equal(active.text, '');
});

test('looksLikeFirmRule: firm-scope EN/HE yes, personal no', () => {
  assert.equal(fr.looksLikeFirmRule('From now on, everyone should CC the paralegal.'), true);
  assert.equal(fr.looksLikeFirmRule('מעכשיו כל הצוות שולח אישור תוך יום'), true);
  assert.equal(fr.looksLikeFirmRule('please reply to me in Hebrew'), false);
});

test('detectFromChat: prefilter blocks personal text (infer never called)', async () => {
  const store = memStore();
  let called = false;
  const infer = async () => { called = true; return '{"rule":"x"}'; };
  const r = await fr.detectFromChat({ store, infer, userText: 'reply to me in short bullets please' });
  assert.equal(r.filed, false);
  assert.equal(called, false);
});

test('detectFromChat: files a pending request when firm-wide + infer returns a rule', async () => {
  const store = memStore();
  const infer = async () => '{"rule":"All staff must answer client emails within one business day."}';
  const r = await fr.detectFromChat({ store, infer, userText: 'From now on all staff must reply to clients within a day', userId: 'u1', name: 'Shira' });
  assert.equal(r.filed, true);
  const p = await fr.listPending({ store });
  assert.equal(p.length, 1);
  assert.equal(p[0].source, 'chat');
});

test('detectFromChat: firm-scope phrasing but infer says not-a-rule -> nothing filed', async () => {
  const store = memStore();
  const infer = async () => '{"rule":""}';
  const r = await fr.detectFromChat({ store, infer, userText: 'from now on I will be out on Fridays' });
  assert.equal(r.filed, false);
  assert.equal((await fr.listPending({ store })).length, 0);
});

test('parseRule tolerates prose around JSON', () => {
  assert.equal(fr.parseRule('Sure: {"rule":"Do X."} done'), 'Do X.');
  assert.equal(fr.parseRule('{"rule":""}'), '');
  assert.equal(fr.parseRule('not json'), '');
});
