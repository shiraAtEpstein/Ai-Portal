// ============================================================
// lib/agents.js — the agent registry.
//
// Agents are defined in the SAME framework format as the firm's plugin:
// a markdown file in /agents with frontmatter (name, title, description,
// tools, model) between --- lines, followed by the system-prompt body.
// This is the ONE way every agent is built, so a definition reads the
// same here and in the plugin monorepo.
//
//   /agents/<id>.md     ->  the agent
//   config/agents.json  ->  which ROLES may use which agent ids (+ any
//                           legacy placeholder agents still defined inline)
//
// `tools:` is the allowlist — the portal tools the agent may use (e.g.
// gmail_search). An agent with no tools runs text-only.
//
// No external YAML dependency: the frontmatter here is simple, so we parse
// it directly (keeps deploys dependency-free).
// ============================================================
const fs = require('fs');
const path = require('path');
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

// Minimal frontmatter parser for the framework format. Handles:
//   key: value            (inline; surrounding quotes stripped)
//   key: >  /  key: |     (folded/literal block of indented lines)
function parseFrontmatter(block) {
  const out = {};
  const lines = String(block || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // a key starts at column 0 (indented lines belong to a block above)
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m || /^[ \t]/.test(line)) { i++; continue; }
    const key = m[1];
    let val = m[2];
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const parts = [];
      i++;
      while (i < lines.length && (/^[ \t]+/.test(lines[i]) || lines[i].trim() === '')) {
        parts.push(lines[i].trim());
        i++;
      }
      out[key] = (val[0] === '|' ? parts.join('\n') : parts.join(' ')).trim();
      continue;
    }
    out[key] = val.replace(/^["']|["']$/g, '').trim();
    i++;
  }
  return out;
}

// Parse one framework-format agent file (frontmatter + body).
function parseAgentFile(raw, fallbackId) {
  let fm = {};
  let body = String(raw || '');
  const m = body.match(/^﻿?---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?([\s\S]*)$/);
  if (m) { fm = parseFrontmatter(m[1]); body = m[2]; }
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

  // Base layer: agents still defined inline in config/agents.json (the
  // original placeholders). Kept working, untouched.
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

module.exports = { agents: loadAgents(), loadAgents, parseAgentFile, parseFrontmatter };
