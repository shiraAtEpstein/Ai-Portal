// ============================================================
// lib/agents.js — the agent registry.
//
// Three layers, each overriding the previous:
//   1) config/agents.json     -> inline agents (bundled defaults + fallback).
//   2) /agents/<id>.md        -> framework agent files in the repo (e.g. gmail).
//   3) Dropbox <subpath>/<id>.md -> the framework agent files the firm keeps in
//      Dropbox, read via lib/dropbox.js. These WIN — the layer you edit.
//
// Roles (who may use which agent) stay in config/agents.json (lib/access.js).
//
// `agents` is a STABLE object mutated IN PLACE, so callers that captured it at
// require time (e.g. routes/chat.js) always see the latest definitions.
// ============================================================
const fs = require('fs');
const path = require('path');
const jsonConfig = require('../config/agents.json');
const dropbox = require('./dropbox');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
// Folder (inside the Dropbox App folder, after DROPBOX_ROOT) holding the agent
// files. Leave DROPBOX_ROOT empty and this defaults to /portal-agents.
const AGENTS_SUBPATH = process.env.AGENTS_SUBPATH || '/portal-agents';

function prettify(id) {
  return String(id || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
function normalizeTools(t) {
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
    tools: normalizeTools(fm.tools),
    model: fm.model ? String(fm.model).trim() : null,
  };
}

// Layers 1 + 2 (local), built into target in place.
function rebuildLocal(target) {
  for (const k of Object.keys(target)) delete target[k];
  const jsonAgents = (jsonConfig && jsonConfig.agents) || {};
  for (const [id, a] of Object.entries(jsonAgents)) {
    target[id] = {
      id,
      name: a.name || prettify(id),
      description: a.description || '',
      systemPrompt: a.systemPrompt || '',
      tools: normalizeTools(a.tools),
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

// The stable registry (starts as the local base).
const agents = {};
rebuildLocal(agents);

// Layer 3: read framework agent files from Dropbox (via lib/dropbox.js) and
// overlay them. Atomic: `agents` is only touched once every file is fetched and
// parsed, so a mid-way failure or a disconnected Dropbox leaves agents intact.
async function refreshFromDropbox() {
  if (!dropbox.configured()) return { ok: false, reason: 'Dropbox app not configured' };
  try {
    const entries = await dropbox.listFiles(AGENTS_SUBPATH);
    const mdFiles = (entries || []).filter((e) => e.type === 'file' && /\.md$/i.test(e.name || ''));
    const parsed = {};
    for (const f of mdFiles) {
      const raw = await dropbox.readFile(f.path);
      const def = parseAgentFile(raw, String(f.name).replace(/\.md$/i, ''));
      if (def.id) parsed[def.id] = def;
    }
    rebuildLocal(agents);
    for (const [id, def] of Object.entries(parsed)) agents[id] = def;
    return { ok: true, count: Object.keys(parsed).length };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'unknown error' };
  }
}

function loadAgents() { return rebuildLocal(agents); }

module.exports = { agents, loadAgents, refreshFromDropbox, parseAgentFile, parseFrontmatter };
