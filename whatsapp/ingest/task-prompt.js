// ============================================================
// whatsapp/ingest/task-prompt.js — loads the task-extraction AGENT from Dropbox.
//
// The agent instructions + the firm procedures live in Dropbox so the firm can
// teach/correct them without touching code. The paths come ONLY from env vars —
// there is no baked-in default agent. NO silent fallback either: if the env var
// is missing, Dropbox isn't connected, or the file can't be read, it throws a
// clear error (never a stale or default prompt), so a misconfiguration is loud.
//
//   agent prompt:  WHATSAPP_TASK_PROMPT_PATH  (required — path to the agent .md)
//   procedures:    WHATSAPP_PROCEDURE_PATH    (optional — a FOLDER; every .md/.txt
//                  inside is folded in. May also be a single file or a
//                  comma-separated list of files/folders. If unset, no procedures.)
// ============================================================
const dropbox = require('../../lib/dropbox');

const PROMPT_PATH = process.env.WHATSAPP_TASK_PROMPT_PATH || '';
const PROCEDURES_PATH = process.env.WHATSAPP_PROCEDURE_PATH || '';

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
  if (!PROMPT_PATH) throw new Error('WHATSAPP_TASK_PROMPT_PATH is not set — no task agent configured');
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
        : 'none (WHATSAPP_PROCEDURE_PATH not set)')));

  _cache = prompt;
  _cacheAt = Date.now();
  return prompt;
}

module.exports = { loadTaskPrompt };
