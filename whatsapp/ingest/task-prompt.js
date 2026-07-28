// ============================================================
// whatsapp/ingest/task-prompt.js — loads the task-extraction AGENT from Dropbox.
//
// The agent is declared in config/agents.json as `wa_task`, EXACTLY like every
// other portal agent — its Dropbox paths live there, not in env vars and not
// hardcoded here:
//
//   "wa_task": {
//     "source":     "/shared-claude/task-creator/wataskextractor.md",  // the agent
//     "procedures": "/shared-claude/task-creator/נהלים ופרוצדורות"       // a FOLDER
//   }
//
// `source` is the agent instructions (same field the other agents use).
// `procedures` is a FOLDER (or single file, or comma-list) whose .md/.txt files
// are folded in as reference — a folder, so new procedures can just be dropped in.
//
// NO silent fallback: if the entry is missing, Dropbox isn't connected, or a file
// can't be read, it throws a clear error (never a stale or default prompt), so a
// misconfiguration is loud.
// ============================================================
const dropbox = require('../../lib/dropbox');
const agentsConfig = require('../../config/agents.json');

const WA_TASK = (agentsConfig.agents && agentsConfig.agents.wa_task) || {};
const PROMPT_PATH = WA_TASK.source || '';
const PROCEDURES_PATH = WA_TASK.procedures || '';

const TTL_MS = 10 * 60 * 1000;
let _cache = null;
let _cacheAt = 0;

function ensureDropbox(what) {
  if (!(dropbox.configured && dropbox.configured())) {
    throw new Error('Dropbox is not connected — cannot load ' + what);
  }
}

// A path is a folder if it ends with '/' or its last segment has no extension.
function isFolderPath(p) {
  const last = String(p).split('/').pop() || '';
  return String(p).endsWith('/') || !/\.[a-z0-9]{1,6}$/i.test(last);
}

// Read one or more procedure docs. `spec` may be a folder, a file, or a
// comma-separated list of either. Returns the concatenated text.
async function loadProcedures(spec) {
  ensureDropbox('the procedures');
  const parts = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  const texts = [];
  for (const part of parts) {
    if (isFolderPath(part)) {
      const entries = await dropbox.listFiles(part);
      const files = (entries || [])
        .filter((e) => e.type === 'file' && /\.(md|txt)$/i.test(e.name || ''))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      for (const f of files) {
        const t = String((await dropbox.readFile(f.path)) || '').trim();
        if (t) texts.push('## ' + f.name + '\n\n' + t);
      }
    } else {
      const t = String((await dropbox.readFile(part)) || '').trim();
      if (t) texts.push(t);
    }
  }
  return texts.join('\n\n');
}

async function loadTaskPrompt() {
  if (_cache && (Date.now() - _cacheAt) < TTL_MS) return _cache;

  // 1) the agent instructions
  if (!PROMPT_PATH) throw new Error('no task agent configured — set agents.wa_task.source in config/agents.json');
  ensureDropbox('the task agent');
  let prompt;
  try {
    prompt = String((await dropbox.readFile(PROMPT_PATH)) || '').trim();
  } catch (e) {
    throw new Error('could not read the task agent from Dropbox (' + PROMPT_PATH + '): ' + e.message);
  }
  if (!prompt) throw new Error('the task agent file is empty (' + PROMPT_PATH + ')');

  // 2) the firm procedure(s), folded in as reference (only if a path is set)
  let procAttached = false;
  let text = '';
  if (PROCEDURES_PATH) {
    try {
      text = await loadProcedures(PROCEDURES_PATH);
    } catch (e) {
      throw new Error('could not read the procedure(s) from Dropbox (' + PROCEDURES_PATH + '): ' + e.message);
    }
  }
  if (text) {
    prompt += '\n\n----- FIRM DEAL PROCEDURES (reference — ground tasks in this) -----\n\n' + text;
    procAttached = true;
  }

  console.log('[whatsapp/processor] task agent loaded (dropbox ' + PROMPT_PATH + ') | procedure ' +
    (procAttached ? ('attached (' + PROCEDURES_PATH + ')')
      : (PROCEDURES_PATH ? 'NOT attached — is the folder empty? (' + PROCEDURES_PATH + ')'
        : 'none (agents.wa_task.procedures not set)')));

  _cache = prompt;
  _cacheAt = Date.now();
  return prompt;
}

module.exports = { loadTaskPrompt };
