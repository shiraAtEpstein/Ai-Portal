// ============================================================
// test/memory.test.js — Layer 3 agent memory (preferences only).
// Runs with `node --test`. No DB, no network: fake store + fake extractor.
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const mem = require('../lib/memory');

// In-memory store implementing the same surface as pgStore.
function fakeStore() {
  const memories = new Map();   // key -> { text, source, last_reaffirmed, revoked }
  const candidates = new Map(); // key -> { text, seen_count, status }
  const s = {
    _memories: memories, _candidates: candidates,
    async listActive() {
      return [...memories.entries()].filter(([, v]) => !v.revoked)
        .map(([k, v]) => ({ norm_key: k, text: v.text, last_reaffirmed: v.last_reaffirmed || new Date().toISOString() }));
    },
    async hasMemory(_u, k) { const v = memories.get(k); return !!(v && !v.revoked); },
    async reaffirm(_u, k) { const v = memories.get(k); if (v) v.last_reaffirmed = new Date().toISOString(); },
    async bumpOrInsertCandidate(_u, k, text) {
      const c = candidates.get(k) || { text, seen_count: 0, status: 'staged' };
      c.seen_count += 1; c.text = text; candidates.set(k, c);
      return { seen_count: c.seen_count, status: c.status };
    },
    async markCandidatePromoted(_u, k) { const c = candidates.get(k); if (c) c.status = 'promoted'; },
    async upsertConfirmed(_u, k, text, source) { memories.set(k, { text, source, last_reaffirmed: new Date().toISOString(), revoked: false }); },
    async revoke(_u, k) { const v = memories.get(k); if (v) v.revoked = true; },
  };
  return s;
}
const inferReturning = (items) => async () => JSON.stringify(items);
const U = '11111111-1111-1111-1111-111111111111';

test('prefer once: staged, not yet trusted, nothing loaded', async () => {
  const store = fakeStore();
  const r = await mem.observe(U, { store, infer: inferReturning([{ action: 'prefer', text: 'Reply concisely' }]) });
  assert.strictEqual(r.staged, 1);
  assert.strictEqual(r.promoted, 0);
  const load = await mem.loadForUser(U, { store });
  assert.strictEqual(load.text, '');
});

test('prefer repeated PROMOTE_AFTER times: promoted and then loaded', async () => {
  const store = fakeStore();
  const infer = inferReturning([{ action: 'prefer', text: 'Reply concisely' }]);
  let promoted = 0;
  for (let i = 0; i < mem.PROMOTE_AFTER; i++) {
    const r = await mem.observe(U, { store, infer });
    promoted += r.promoted;
  }
  assert.strictEqual(promoted, 1, 'exactly one promotion at the threshold');
  const load = await mem.loadForUser(U, { store });
  assert.match(load.text, /Reply concisely/);
  assert.match(load.text, /ALWAYS win/);
});

test('confirm: trusted immediately, no repetition needed', async () => {
  const store = fakeStore();
  await mem.observe(U, { store, infer: inferReturning([{ action: 'confirm', text: 'Always sign off in Hebrew' }]) });
  const load = await mem.loadForUser(U, { store });
  assert.match(load.text, /Always sign off in Hebrew/);
});

test('forget: revokes a trusted memory', async () => {
  const store = fakeStore();
  await mem.remember(U, 'Use bullet points', { store });
  assert.match((await mem.loadForUser(U, { store })).text, /Use bullet points/);
  await mem.observe(U, { store, infer: inferReturning([{ action: 'forget', text: 'Use bullet points' }]) });
  assert.strictEqual((await mem.loadForUser(U, { store })).text, '');
});

test('client/matter facts are never stored (preferences only)', async () => {
  const store = fakeStore();
  const r = await mem.observe(U, { store, infer: inferReturning([
    { action: 'prefer', text: 'The Levi deal closes on March 3' },
    { action: 'confirm', text: 'Client Cohen paid 250000' },
    { action: 'prefer', text: 'Reply in short paragraphs' },
  ]) });
  // only the genuine preference survives the guard
  assert.strictEqual(r.staged, 1);
  assert.strictEqual(store._memories.size, 0);
});

test('decayed memories are not loaded', async () => {
  const store = fakeStore();
  await mem.remember(U, 'Prefer formal tone', { store });
  // backdate the reaffirm well past the decay window
  const old = new Date(Date.now() - (mem.DECAY_DAYS + 30) * 86400000).toISOString();
  for (const v of store._memories.values()) v.last_reaffirmed = old;
  const load = await mem.loadForUser(U, { store });
  assert.strictEqual(load.text, '', 'stale memory should not load');
});

test('re-seeing a trusted preference reaffirms it (no duplicate)', async () => {
  const store = fakeStore();
  await mem.remember(U, 'Keep it brief', { store });
  const before = store._memories.size;
  await mem.observe(U, { store, infer: inferReturning([{ action: 'prefer', text: 'keep IT brief!!' }]) });
  assert.strictEqual(store._memories.size, before, 'no new row for a normalized-equal preference');
});

test('sanitizeItems tolerates prose-wrapped JSON and bad input', () => {
  assert.deepStrictEqual(mem.sanitizeItems('garbage'), []);
  const items = mem.sanitizeItems('Here you go: [{"action":"prefer","text":"Be concise"}] thanks');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].text, 'Be concise');
});

test('normalize/keyFor stable across casing, punctuation, spacing', () => {
  assert.strictEqual(mem.keyFor('Reply Concisely!'), mem.keyFor('  reply   concisely '));
  assert.notStrictEqual(mem.keyFor('reply concisely'), mem.keyFor('reply in detail'));
});

test('disabled/empty inputs are safe no-ops', async () => {
  const store = fakeStore();
  assert.deepStrictEqual(await mem.loadForUser('', { store }), { text: '', items: [] });
  const r = await mem.observe(U, { store, infer: inferReturning([]) });
  assert.deepStrictEqual(r, { staged: 0, promoted: 0, confirmed: 0, forgotten: 0 });
});
