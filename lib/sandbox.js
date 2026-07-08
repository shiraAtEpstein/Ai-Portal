// ============================================================
// lib/sandbox.js — build real documents in Anthropic's HOSTED sandbox.
//
// This is the "second API": a separate Messages API call that attaches a
// document skill (xlsx/docx/pdf/pptx) and the code-execution tool. The code
// runs in ANTHROPIC's container — nothing executes on your Render box. The
// finished file comes back as a file_id; we download it via the Files API and
// hand it to the in-memory filestore so the portal can serve a download link.
//
// IMPORTANT (tell your firm): Skills + code execution are NOT ZDR-eligible.
// The instruction + data you send here are retained under Anthropic's standard
// retention policy, not zero-data-retention. You confirmed you're OK with data
// transiting the sandbox; just note the ZDR exclusion so consent is informed.
//
// Requires @anthropic-ai/sdk recent enough for client.beta.messages.create with
// `betas` + `container` (i.e. NOT 0.27 — run `npm install @anthropic-ai/sdk@latest`).
// Requires Node 18+ (global fetch).
// ============================================================
const Anthropic = require('@anthropic-ai/sdk');
const filestore = require('./filestore');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SANDBOX_BETAS = ['code-execution-2025-08-25', 'skills-2025-10-02', 'files-api-2025-04-14'];
const CODE_TOOL = { type: 'code_execution_20250825', name: 'code_execution' };
const FORMAT_SKILL = { xlsx: 'xlsx', docx: 'docx', pdf: 'pdf', pptx: 'pptx' };
const MODEL = process.env.SANDBOX_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const DOC_EXT = /\.(xlsx|xlsm|csv|docx|pdf|pptx)$/i;
const FILES_HEADERS = {
  'x-api-key': process.env.ANTHROPIC_API_KEY,
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'files-api-2025-04-14',
};

// Recursively find every file_id anywhere in the response content blocks.
function collectFileIds(node, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) collectFileIds(n, out); return out; }
  if (typeof node.file_id === 'string') out.push(node.file_id);
  for (const k of Object.keys(node)) { const v = node[k]; if (v && typeof v === 'object') collectFileIds(v, out); }
  return out;
}

async function fileMeta(fileId) {
  const r = await fetch('https://api.anthropic.com/v1/files/' + fileId, { headers: FILES_HEADERS });
  if (!r.ok) throw new Error('file metadata ' + r.status);
  return r.json();
}
async function fileBytes(fileId) {
  const r = await fetch('https://api.anthropic.com/v1/files/' + fileId + '/content', { headers: FILES_HEADERS });
  if (!r.ok) throw new Error('file content ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// Build a document from an instruction + data. Returns { files: [{id, filename, mime, url}] }.
async function buildDocument({ userId, instruction, data, format }) {
  const skill_id = FORMAT_SKILL[format] || 'xlsx';
  const content = String(instruction || 'Create a document.') +
    (data ? '\n\nUse this data:\n' + String(data) : '') +
    '\n\nProduce a ' + (format || 'xlsx') + ' file and save it to the working directory.';

  const resp = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4096,
    betas: SANDBOX_BETAS,
    container: { skills: [{ type: 'anthropic', skill_id, version: 'latest' }] },
    tools: [CODE_TOOL],
    messages: [{ role: 'user', content }],
  });

  const ids = Array.from(new Set(collectFileIds(resp.content)));
  const metas = [];
  for (const id of ids) {
    try { const m = await fileMeta(id); metas.push({ id, filename: m.filename || 'document', mime: m.mime_type || 'application/octet-stream' }); }
    catch (_) { metas.push({ id, filename: 'document', mime: 'application/octet-stream' }); }
  }
  let chosen = metas.filter((m) => DOC_EXT.test(m.filename));
  if (!chosen.length) chosen = metas;

  const files = [];
  for (const m of chosen) {
    const buf = await fileBytes(m.id);
    const localId = filestore.put(userId, m.filename, m.mime, buf);
    files.push({ id: localId, filename: m.filename, mime: m.mime, url: '/api/files/' + localId });
  }
  return { files };
}

module.exports = { buildDocument };
