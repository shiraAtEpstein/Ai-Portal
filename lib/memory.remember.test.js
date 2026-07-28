'use strict';

/**
 * Unit test for the explicit memory writes (rememberExplicit / forgetExplicit).
 * No DB, no network: the store is injected. Run: node lib/memory.remember.test.js
 */
const assert = require('assert');
const memory = require('./memory');

function fakeStore() {
  const prefs = new Set();
  const facts = new Set();
  return {
    prefs, facts,
    async hasMemory(u, k) { return prefs.has(k); },
    async reaffirm(u, k) { /* noop */ },
    async upsertConfirmed(u, k) { prefs.add(k); },
    async revoke(u, k) { prefs.delete(k); },
    async upsertFact(u, a, k) { facts.add(a + '|' + k); },
    async revokeFact(u, a, k) { facts.delete(a + '|' + k); },
  };
}

let pass = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); pass++; out.push('  ok   ' + name); }
  catch (e) { out.push('  FAIL ' + name + '\n        ' + e.message); }
}

(async () => {
  const U = 'user-1';

  await test('preference is saved as trusted', async () => {
    const store = fakeStore();
    const r = await memory.rememberExplicit(U, { kind: 'preference', text: 'Address the user as Tzipora' }, { store });
    assert.strictEqual(r.status, 'saved');
    assert.strictEqual(r.tier, 'trusted');
    assert.strictEqual(store.prefs.size, 1);
  });

  await test('duplicate preference returns already_known', async () => {
    const store = fakeStore();
    await memory.rememberExplicit(U, { kind: 'preference', text: 'Reply in Hebrew' }, { store });
    const r = await memory.rememberExplicit(U, { kind: 'preference', text: 'Reply in Hebrew' }, { store });
    assert.strictEqual(r.status, 'already_known');
  });

  await test('preference that looks like client data is REJECTED, not saved', async () => {
    const store = fakeStore();
    const r = await memory.rememberExplicit(U, { kind: 'preference', text: 'client phone is 0501234567' }, { store });
    assert.strictEqual(r.status, 'rejected');
    assert.strictEqual(r.reason, 'looks_like_client_data');
    assert.strictEqual(store.prefs.size, 0);
  });

  await test('fact is saved for an allowed (non-excluded) agent', async () => {
    const store = fakeStore();
    const r = await memory.rememberExplicit(U, { kind: 'fact', text: 'The Cohen survey is delayed', agentId: 'real_estate' }, { store });
    assert.strictEqual(r.status, 'saved');
    assert.strictEqual(r.tier, 'agent-fact');
    assert.strictEqual(store.facts.size, 1);
  });

  await test('fact is REJECTED for a walled/excluded agent (general)', async () => {
    const store = fakeStore();
    const r = await memory.rememberExplicit(U, { kind: 'fact', text: 'The Cohen survey is delayed', agentId: 'general' }, { store });
    assert.strictEqual(r.status, 'rejected');
    assert.strictEqual(r.reason, 'facts_not_allowed_here');
    assert.strictEqual(store.facts.size, 0);
  });

  await test('forget removes a known preference', async () => {
    const store = fakeStore();
    await memory.rememberExplicit(U, { kind: 'preference', text: 'Keep answers short' }, { store });
    const r = await memory.forgetExplicit(U, { text: 'Keep answers short' }, { store });
    assert.strictEqual(r.status, 'forgotten');
    assert.strictEqual(store.prefs.size, 0);
  });

  await test('forget an unknown preference returns not_found', async () => {
    const store = fakeStore();
    const r = await memory.forgetExplicit(U, { text: 'never seen this' }, { store });
    assert.strictEqual(r.status, 'not_found');
  });

  console.log(out.join('\n'));
  console.log('\n' + pass + '/' + out.length + ' tests passed.');
  process.exit(pass === out.length ? 0 : 1);
})();
