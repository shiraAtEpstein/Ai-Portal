// ============================================================
// lib/skill-catalog.js — turns the portal's agents into a role-scoped SKILL
// CATALOG for the single "general" chat.
//
// This is how we reproduce the Claude-app feel WITHOUT changing your security
// model. Each agent the user's role already grants becomes a "skill":
//   • a short description the general agent sees up front (cheap, ~1 line), and
//   • a full body it loads on demand via the load_skill tool (in routes/chat.js).
//
// Scoping is airtight: only the caller's permitted agents ever enter the
// catalog (we build it from accessForRoles), so the general agent can never see
// or load a skill the user's role doesn't allow. Nothing here is "allow all".
// ============================================================
const { agents: agentRegistry } = require('./agents');
const { accessForRoles, topicRestrictionsFor } = require('./access');

// The behavioural prompt that makes the general agent act like the app:
// decisive, tool-first, and proactive instead of interrogating the user.
const PROACTIVE_PROMPT = [
  'You are the firm\'s general assistant. Work like a capable colleague:',
  '- Be decisive. When a request is clear enough to act on, produce the',
  '  deliverable rather than describing what you could do.',
  '- Prefer reasonable assumptions over questions. State an assumption in one',
  '  line and proceed. Ask at most ONE clarifying question, and only when you',
  '  genuinely cannot proceed without it.',
  '- Use your tools to find answers before asking the user for information that',
  '  a connected system already holds.',
  '- For multi-step tasks, plan briefly, then carry out every step in this turn.',
  '- SKILLS: below is a catalog of specialised skills. If a request matches ANY',
  '  skill in the catalog, you MUST call the load_skill tool with its id and',
  '  follow its instructions BEFORE you answer or act. Do NOT answer a matching',
  '  request from your own knowledge, even if you are confident — a skill can',
  '  carry requirements you cannot know until you load it. Answer directly ONLY',
  '  when no skill in the catalog matches. If unsure whether one matches, load',
  '  the closest one rather than guessing.',
  '- Reply in the language the user writes in; preserve names and legal terms exactly.',
].join('\n');

// Build the role-scoped catalog: the skills these roles may use.
// Returns [{ id, name, description, body, tools, folder, restrictions }].
function catalogForRoles(roles) {
  const { agentIds } = accessForRoles(roles);
  const skills = [];
  for (const id of agentIds) {
    if (!id || id === 'general') continue;
    const a = agentRegistry[id];
    if (!a) continue;
    skills.push({
      id,
      name: a.name || id,
      description: a.description || '',
      body: a.systemPrompt || '',
      tools: Array.isArray(a.tools) ? a.tools.slice() : [],
      folder: a.folder || null,
      restrictions: topicRestrictionsFor(roles, id),
    });
  }
  return skills;
}

// A compact, model-facing menu of the catalog (ids + when to use each).
// This is the ~1-line-per-skill summary the general agent routes on.
function renderCatalog(skills) {
  if (!skills.length) return '(You have no specialised skills; answer directly.)';
  return skills
    .map((s) => '- id: ' + s.id + '\n  name: ' + s.name +
      '\n  use when: ' + (s.description || '(general help)'))
    .join('\n');
}

// Union of tool names across a set of skills. Still role-scoped, because the
// skills themselves were already filtered to the user's permissions.
function unionTools(skills) {
  const set = new Set();
  for (const s of skills) for (const t of (s.tools || [])) set.add(t);
  return set;
}

module.exports = { PROACTIVE_PROMPT, catalogForRoles, renderCatalog, unionTools };
