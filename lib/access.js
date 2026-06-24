// ============================================================
// lib/access.js — permission logic (which agents a set of roles can use)
// Reads the role -> agents map from config/agents.json.
// ============================================================
const agentsConfig = require('../config/agents.json');

// Union of the agents a set of roles can use, plus whether any role is admin.
function accessForRoles(roles) {
  const agentIds = new Set();
  let isAdmin = false;
  for (const role of (roles || [])) {
    const rc = agentsConfig.roles[role];
    if (!rc) continue;
    if (role === 'admin') isAdmin = true;
    for (const a of rc.agents) agentIds.add(a);
  }
  return { agentIds, isAdmin };
}

// Topic restrictions for an agent across a user's roles. If ANY role grants
// the agent with no restrictions, the user is unrestricted for it.
function topicRestrictionsFor(roles, agentId) {
  let anyUnrestricted = false;
  const merged = new Set();
  for (const role of (roles || [])) {
    const rc = agentsConfig.roles[role];
    if (!rc || !rc.agents.includes(agentId)) continue;
    const tr = rc.topicRestrictions || [];
    if (tr.length === 0) anyUnrestricted = true;
    else tr.forEach((t) => merged.add(t));
  }
  return anyUnrestricted ? [] : Array.from(merged);
}

module.exports = { agentsConfig, accessForRoles, topicRestrictionsFor };
