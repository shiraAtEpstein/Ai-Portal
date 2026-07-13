// ============================================================
// test/memory.test.js — Layer 3 agent memory (preferences + walled facts).
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
    // Layer 3b facts (keyed by agent)
    _facts: new Map(), // `${agent}|${key}` -> { text, revoked }
    async listFacts(_u, agentId) {
      return [...this._facts.entries()].filter(([k, v]) => k.startsWith(agentId + '|') && !v.revoked)
        .map(([k, v]) => ({ norm_key: k.split('|')[1], text: v.text, last_reaffirmed: new Date().toISOString() }));
    },
    async upsertFact(_u, agentId, key, text) { this._facts.set(agentId + '|' + key, { text, revoked: false }); },
    async revokeFact(_u, agentId, key) { const v = this._facts.get(agentId + '|' + key); if (v) v.revoked = true; },
    async adminListFacts() { return [...this._facts.entries()].filter(([, v]) => !v.revoked).map(([k, v]) => ({ agentId: k.split('|')[0], text: v.text, revoked: false })); },
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

test('client/matter facts are never stored as PREFERENCES', async () => {
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
  assert.deepStrictEqual(r, { staged: 0, promoted: 0, confirmed: 0, forgotten: 0, factsSaved: 0, factsForgotten: 0 });
});

test('listForUser returns trusted + staged from the store (admin view)', async () => {
  const store = {
    async adminListForUser() {
      return {
        trusted: [{ text: 'Reply concisely', source: 'confirmed', createdAt: 'x', lastReaffirmed: 'y' }],
        staged: [{ text: 'Use headings', seenCount: 1, status: 'staged' }],
      };
    },
  };
  const out = await mem.listForUser('11111111-1111-1111-1111-111111111111', { store });
  assert.strictEqual(out.trusted.length, 1);
  assert.strictEqual(out.trusted[0].text, 'Reply concisely');
  assert.strictEqual(out.staged[0].seenCount, 1);
});

test('listForUser is a safe no-op without a user id', async () => {
  assert.deepStrictEqual(await mem.listForUser('', {}), { trusted: [], staged: [] });
});

test('clearStaged delegates to the store and returns the count', async () => {
  let calledWith = null;
  const store = { async clearStaged(u) { calledWith = u; return 7; } };
  const n = await mem.clearStaged('11111111-1111-1111-1111-111111111111', { store });
  assert.strictEqual(n, 7);
  assert.strictEqual(calledWith, '11111111-1111-1111-1111-111111111111');
  assert.strictEqual(await mem.clearStaged('', {}), 0);
});

// ---------- Layer 3b: walled matter facts ----------
const factInfer = (items) => async () => JSON.stringify(items);

test('explicit matter fact is stored, walled to the current agent', async () => {
  const store = fakeStore();
  const r = await mem.observe(U, {
    store, agentId: 'paralegal',
    infer: factInfer([{ kind: 'fact', action: 'remember', text: 'The Levi survey is delayed to March' }]),
  });
  assert.strictEqual(r.factsSaved, 1);
  const load = await mem.loadFactsForAgent(U, 'paralegal', { store });
  assert.match(load.text, /Levi survey is delayed/);
  assert.match(load.text, /THIS agent only/);
});

test('a fact stored under one agent is NOT visible to another agent', async () => {
  const store = fakeStore();
  await mem.observe(U, { store, agentId: 'paralegal', infer: factInfer([{ kind: 'fact', action: 'remember', text: 'Cohen counterparty is difficult' }]) });
  const other = await mem.loadFactsForAgent(U, 'document_review', { store });
  assert.strictEqual(other.text, '', 'facts must not cross the per-agent wall');
});

test('publishing / general agents can NEVER store or load facts', async () => {
  const store = fakeStore();
  for (const bad of ['general', 'marketing_director', 'mkt_copywriter', 'copywriter', 'content_planner']) {
    const r = await mem.observe(U, { store, agentId: bad, infer: factInfer([{ kind: 'fact', action: 'remember', text: 'Secret matter detail' }]) });
    assert.strictEqual(r.factsSaved, 0, bad + ' must not store facts');
    const load = await mem.loadFactsForAgent(U, bad, { store });
    assert.strictEqual(load.text, '', bad + ' must not load facts');
  }
  assert.strictEqual(store._facts.size, 0);
});

test('facts and preferences are handled separately in one turn', async () => {
  const store = fakeStore();
  const r = await mem.observe(U, {
    store, agentId: 'paralegal',
    infer: factInfer([
      { kind: 'preference', action: 'prefer', text: 'Reply concisely' },
      { kind: 'fact', action: 'remember', text: 'The Katz closing moved to April' },
    ]),
  });
  assert.strictEqual(r.staged, 1);
  assert.strictEqual(r.factsSaved, 1);
});

test('"forget" a fact revokes it for that agent', async () => {
  const store = fakeStore();
  await mem.observe(U, { store, agentId: 'daily', infer: factInfer([{ kind: 'fact', action: 'remember', text: 'Deal X is on hold' }]) });
  assert.match((await mem.loadFactsForAgent(U, 'daily', { store })).text, /Deal X is on hold/);
  await mem.observe(U, { store, agentId: 'daily', infer: factInfer([{ kind: 'fact', action: 'forget', text: 'Deal X is on hold' }]) });
  assert.strictEqual((await mem.loadFactsForAgent(U, 'daily', { store })).text, '');
});

test('factsAllowedForAgent gates correctly', () => {
  assert.strictEqual(mem.factsAllowedForAgent('paralegal'), true);
  assert.strictEqual(mem.factsAllowedForAgent('general'), false);
  assert.strictEqual(mem.factsAllowedForAgent('marketing_director'), false);
  assert.strictEqual(mem.factsAllowedForAgent(''), false);
});
