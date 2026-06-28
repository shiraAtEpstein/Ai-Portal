// ============================================================
// test/access.test.js — proves the role -> agent permission boundaries.
// These are the SAME checks the server uses (lib/access.js), so they prove
// that one role cannot reach another role's tools. Run with:  npm test
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const { accessForRoles, topicRestrictionsFor, agentsConfig } = require('../lib/access');

// Mirrors the server-side gate in routes/chat.js (the /api/chat 403 check).
function canUseAgent(roles, agentId) {
  return accessForRoles(roles).agentIds.has(agentId);
}

test('admin gets every agent and the admin panel', () => {
  const { agentIds, isAdmin } = accessForRoles(['admin']);
  assert.equal(isAdmin, true);
  for (const id of Object.keys(agentsConfig.agents)) {
    assert.ok(agentIds.has(id), 'admin should be able to use ' + id);
  }
});

test('paralegal is limited to paralegal + document_review', () => {
  const { agentIds, isAdmin } = accessForRoles(['paralegal']);
  assert.equal(isAdmin, false);
  assert.deepEqual([...agentIds].sort(), ['document_review', 'paralegal']);
});

test('BOUNDARY: a paralegal cannot reach a lawyer/notary tool (legal_research)', () => {
  assert.equal(canUseAgent(['paralegal'], 'legal_research'), false);
});

test('BOUNDARY: a paralegal cannot reach an admin/tech tool (client_intake)', () => {
  assert.equal(canUseAgent(['paralegal'], 'client_intake'), false);
});

test('BOUNDARY: a lawyer cannot reach client_intake or copywriter', () => {
  assert.equal(canUseAgent(['lawyer'], 'client_intake'), false);
  assert.equal(canUseAgent(['lawyer'], 'copywriter'), false);
});

test('a lawyer CAN reach their own tools', () => {
  for (const id of ['legal_research', 'document_review', 'paralegal', 'researcher']) {
    assert.equal(canUseAgent(['lawyer'], id), true, 'lawyer should reach ' + id);
  }
});

test('only the admin role grants the admin panel', () => {
  assert.equal(accessForRoles(['lawyer']).isAdmin, false);
  assert.equal(accessForRoles(['paralegal']).isAdmin, false);
  assert.equal(accessForRoles(['tech']).isAdmin, false);
  assert.equal(accessForRoles(['notary']).isAdmin, false);
  assert.equal(accessForRoles(['admin']).isAdmin, true);
});

test('multiple roles get the UNION of their agents', () => {
  const paralegalAgents = accessForRoles(['paralegal']).agentIds;
  const lawyerAgents = accessForRoles(['lawyer']).agentIds;
  const both = accessForRoles(['paralegal', 'lawyer']).agentIds;
  for (const id of paralegalAgents) assert.ok(both.has(id), 'union should include paralegal agent ' + id);
  for (const id of lawyerAgents) assert.ok(both.has(id), 'union should include lawyer agent ' + id);
});

test('accountant (parked) has no agents and no admin panel', () => {
  const { agentIds, isAdmin } = accessForRoles(['accountant']);
  assert.equal(agentIds.size, 0);
  assert.equal(isAdmin, false);
});

test('empty / unknown roles grant nothing', () => {
  assert.equal(accessForRoles([]).agentIds.size, 0);
  assert.equal(accessForRoles(['not_a_real_role']).agentIds.size, 0);
  assert.equal(accessForRoles(undefined).agentIds.size, 0);
  assert.equal(canUseAgent(['not_a_real_role'], 'legal_research'), false);
});

test('topic restrictions: an unrestricted role returns no restrictions', () => {
  assert.deepEqual(topicRestrictionsFor(['lawyer'], 'legal_research'), []);
});
