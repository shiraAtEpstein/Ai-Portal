// ============================================================
// lib/agents.js — the agent registry (source-map model).
//
// Each portal agent is defined in config/agents.json. An agent may carry a
//   "source": "/path/in/app-folder.md"
// which points at a framework agent file in the connected Dropbox app folder.
// When set, the portal loads that file's prompt (via lib/dropbox.js) and it
// WINS over the inline systemPrompt. The inline systemPrompt stays as a
// fallback if Dropbox is unreachable, so the portal never breaks.
//
// An agent file (or its config entry) may also carry a "reads" list of files
//   reads: /ניוזלטר/house-style.md, /path/to/other.md
// Those files are fetched from Dropbox and FOLDED INTO the prompt as reference
// material at load time (the agent can't read files itself at runtime).
//
// Roles (who may use which agent) stay in config/agents.json (lib/access.js).
// `agents` is a STABLE object mutated in place so callers keep the latest.
// ============================================================
const fs = require('fs');
const path = require('path');
const jsonConfig = require('../config/agents.json');
const dropbox = require('./dropbox');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

function prettify(id) {
  return String(id || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
// The agent's folder = its source file's directory, but if the agent sits in an
// `agents/` subfolder (framework layout: <plugin>/agents/<name>.md), the folder
// is the PLUGIN ROOT so it can reach sibling `knowledge-base/` and write there.
function pluginRoot(src) {
  var d = src.slice(0, src.lastIndexOf('/'));
  if (/\/agents$/.test(d)) d = d.slice(0, d.lastIndexOf('/'));
  return d;
}

function normalizeList(t) {
  if (!t) return [];
  if (Array.isArray(t)) return t.map((x) => String(x).trim()).filter(Boolean);
  return String(t).split(',').map((x) => x.trim()).filter(Boolean);
}

function parseFrontmatter(block) {
  const out = {};
  const lines = String(block || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
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
    tools: normalizeList(fm.tools),
    model: fm.model ? String(fm.model).trim() : null,
    reads: normalizeList(fm.reads),
  };
}

// The local base: inline agents from config + repo /agents/*.md (fallback layer).
function buildLocal(target) {
  for (const k of Object.keys(target)) delete target[k];
  const jsonAgents = (jsonConfig && jsonConfig.agents) || {};
  for (const [id, a] of Object.entries(jsonAgents)) {
    target[id] = {
      id,
      name: a.name || prettify(id),
      description: a.description || '',
      systemPrompt: a.systemPrompt || '',
      tools: normalizeList(a.tools),
      model: a.model || null,
    };
  }
  try {
    if (fs.existsSync(AGENTS_DIR)) {
      for (const f of fs.readdirSync(AGENTS_DIR)) {
        if (!f.toLowerCase().endsWith('.md')) continue;
        const raw = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');
        const def = parseAgentFile(raw, f.replace(/\.md$/i, ''));
        if (def.id) target[def.id] = def;
      }
    }
  } catch (e) {
    console.error('[AGENTS] loading /agents failed:', e.message);
  }
  return target;
}

const agents = {};
buildLocal(agents);

// Pull each agent that has a "source" from Dropbox, inline its "reads", overlay.
async function refreshFromDropbox() {
  if (!dropbox.configured()) return { ok: false, reason: 'Dropbox app not configured' };
  try {
    const jsonAgents = (jsonConfig && jsonConfig.agents) || {};
    const built = {};
    buildLocal(built);
    let count = 0;
    for (const [id, a] of Object.entries(jsonAgents)) {
      if (!a.source) continue;
      const raw = await dropbox.readFile(a.source);
      const def = parseAgentFile(raw, id);
      def.id = id;
      // the agent's own folder in Dropbox (its source file's directory) — tools
      // are scoped to this so an agent can only read/write inside its own folder.
      def.folder = pluginRoot(a.source);
      def.name = a.name || def.name || prettify(id);
      def.description = a.description || def.description || '';

      const refs = (def.reads && def.reads.length) ? def.reads : normalizeList(a.reads);
      if (refs.length) {
        // Reads that don't start with '/' resolve RELATIVE to the agent file's
        // own folder, so an agent can just say `reads: house-style.md` for a
        // sibling file and it works no matter where the folder lives.
        const baseDir = pluginRoot(a.source);
        let extra = '';
        for (const rp of refs) {
          const full = rp.charAt(0) === '/' ? rp : (baseDir + '/' + rp);
          try {
            const rraw = await dropbox.readFile(full);
            extra += '\n\n### Reference: ' + full + '\n\n' + String(rraw).trim();
          } catch (e) {
            console.error('[AGENTS] reference not read (' + rp + '): ' + e.message);
          }
        }
        if (extra) {
          def.systemPrompt = String(def.systemPrompt || '').trim() +
            '\n\n----- REFERENCE MATERIAL (follow this; you cannot open files yourself) -----' + extra;
        }
      }
      built[id] = def;
      count++;
    }
    // commit atomically (only after every source + reference resolved)
    for (const k of Object.keys(agents)) delete agents[k];
    Object.assign(agents, built);
    return { ok: true, count };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'unknown error' };
  }
}

function loadAgents() { return buildLocal(agents); }

module.exports = { agents, loadAgents, refreshFromDropbox, parseAgentFile, parseFrontmatter };
