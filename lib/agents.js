// ============================================================
// lib/agents.js — the agent registry.
//
// Agents are defined in the SAME framework format as the firm's plugin:
// a markdown file in /agents with YAML frontmatter (name, description,
// tools, model) followed by the system-prompt body. This is the ONE way
// every agent is built, so a definition reads the same here and in the
// plugin monorepo.
//
//   /agents/<id>.md   ->   the agent
//   config/agents.json ->  which ROLES may use which agent ids (+ any
//                          legacy placeholder agents still defined inline)
//
// `tools:` is the allowlist — the portal tools the agent is permitted to
// use (e.g. gmail_search). An agent with no tools runs text-only.
// ============================================================
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const jsonConfig = require('../config/agents.json');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

function prettify(id) {
  return String(id || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
function normalizeTools(t) {
  if (!t) return [];
  if (Array.isArray(t)) return t.map((x) => String(x).trim()).filter(Boolean);
  return String(t).split(',').map((x) => x.trim()).filter(Boolean);
}

// Parse one framework-format agent file (frontmatter + body).
function parseAgentFile(raw, fallbackId) {
  let fm = {};
  let body = String(raw || '');
  const m = body.match(/^﻿?---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (m) {
    try { fm = yaml.load(m[1]) || {}; } catch (e) { console.error('[AGENTS] frontmatter parse failed in ' + fallbackId + ': ' + e.message); fm = {}; }
    body = m[2];
  }
  const id = String(fm.id || fm.name || fallbackId || '').trim();
  return {
    id,
    name: String(fm.title || prettify(id)),
    description: String(fm.description || '').trim(),
    systemPrompt: String(body || '').trim(),
    tools: normalizeTools(fm.tools),
    model: fm.model ? String(fm.model).trim() : null,
  };
}

function loadAgents() {
  const agents = {};

  // Base layer: any agents still defined inline in config/agents.json
  // (the original placeholders). Kept working, untouched.
  const jsonAgents = (jsonConfig && jsonConfig.agents) || {};
  for (const [id, a] of Object.entries(jsonAgents)) {
    agents[id] = {
      id,
      name: a.name || prettify(id),
      description: a.description || '',
      systemPrompt: a.systemPrompt || '',
      tools: normalizeTools(a.tools),
      model: a.model || null,
    };
  }

  // Framework layer: /agents/*.md — the way agents are built going forward.
  try {
    if (fs.existsSync(AGENTS_DIR)) {
      for (const f of fs.readdirSync(AGENTS_DIR)) {
        if (!f.toLowerCase().endsWith('.md')) continue;
        const raw = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');
        const def = parseAgentFile(raw, f.replace(/\.md$/i, ''));
        if (def.id) agents[def.id] = def;  // a .md file wins over a same-id placeholder
      }
    }
  } catch (e) {
    console.error('[AGENTS] loading /agents failed:', e.message);
  }

  return agents;
}

module.exports = { agents: loadAgents(), loadAgents, parseAgentFile };
