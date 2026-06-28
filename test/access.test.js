// ============================================================
// test/access.test.js — proves the role -> agent permission boundaries.
// These use lib/access.js, the SAME logic the server enforces with, so they
// prove that one role cannot reach another role's tools.
//
// The core tests are CONFIG-DRIVEN: they read the expected answers from
// config/agents.json itself, so they stay correct no matter which agents
// exist now or later (placeholder agents today, real agents tomorrow).
// Run with:  npm test
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const { accessForRoles, topicRestrictionsFor, agentsConfig } = require('../lib/access');

const ROLES = Object.keys(agentsConfig.roles);
const ALL_AGENTS = Object.keys(agentsConfig.agents);

// ---- Config-driven invariants (independent of which agents exist) ----

test('each role grants EXACTLY the agents listed for it in the config', () => {
  for (const role of ROLES) {
    const expected = [...new Set(agentsConfig.roles[role].agents)].sort();
    const got = [...accessForRoles([role]).agentIds].sort();
    assert.deepEqual(got, expected, 'role "' + role + '" should grant exactly its configured agents');
  }
});

test('BOUNDARY: a role can never reach an agent not listed for it in the config', () => {
  for (const role of ROLES) {
    const allowed = new Set(agentsConfig.roles[role].agents);
    for (const agentId of ALL_AGENTS) {
      const canUse = accessForRoles([role]).agentIds.has(agentId);
      assert.equal(canUse, allowed.has(agentId),
        '"' + role + '"' + (allowed.has(agentId) ? ' should ' : ' should NOT ') + 'be able to reach "' + agentId + '"');
    }
  }
});

test('only the "admin" role grants the admin panel', () => {
  for (const role of ROLES) {
    assert.equal(accessForRoles([role]).isAdmin, role === 'admin',
      'isAdmin for "' + role + '" should be ' + (role === 'admin'));
  }
});

test('multiple roles get the UNION of their agents (checked across every pair)', () => {
  for (const a of ROLES) {
    for (const b of ROLES) {
      const ua = accessForRoles([a]).agentIds;
      const ub = accessForRoles([b]).agentIds;
      const both = accessForRoles([a, b]).agentIds;
      const expected = new Set([...ua, ...ub]);
      assert.equal(both.size, expected.size, 'union size for "' + a + '" + "' + b + '"');
      for (const id of expected) assert.ok(both.has(id), 'union "' + a + '" + "' + b + '" is missing "' + id + '"');
    }
  }
});

test('empty / unknown roles grant nothing and no admin panel', () => {
  for (const roles of [[], ['__not_a_role__'], undefined]) {
    const { agentIds, isAdmin } = accessForRoles(roles);
    assert.equal(agentIds.size, 0);
    assert.equal(isAdmin, false);
  }
});

test('topic restrictions: an unrestricted role returns no restrictions', () => {
  const role = ROLES.find(r => (agentsConfig.roles[r].agents || []).length) || ROLES[0];
  const agentId = (agentsConfig.roles[role].agents || [])[0];
  if (agentId) assert.deepEqual(topicRestrictionsFor([role], agentId), []);
});

// ---- Readable examples against the CURRENT (placeholder) agents ----
// These illustrate the rules in plain terms. They auto-skip if the named
// agents are ever renamed/removed, so swapping in the real agents won't break
// the suite — the config-driven tests above remain the real guarantee.

function withAgents(ids, fn) {
  return (t) => { if (ids.every(id => ALL_AGENTS.includes(id))) fn(); else t.skip('agents changed: ' + ids.join(', ')); };
}

test('example: a paralegal cannot reach the lawyer/notary tool "legal_research"',
  withAgents(['legal_research'], () => {
    assert.equal(accessForRoles(['paralegal']).agentIds.has('legal_research'), false);
  }));

test('example: a lawyer cannot reach "client_intake" or "copywriter"',
  withAgents(['client_intake', 'copywriter'], () => {
    assert.equal(accessForRoles(['lawyer']).agentIds.has('client_intake'), false);
    assert.equal(accessForRoles(['lawyer']).agentIds.has('copywriter'), false);
  }));
