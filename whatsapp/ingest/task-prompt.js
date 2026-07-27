// ============================================================
// whatsapp/ingest/task-prompt.js — loads the task-extraction AGENT.
//
// The agent (its instructions/intelligence) lives in Dropbox so the firm can
// teach/correct it without a redeploy. This file is only the loader.
//
// NO silent fallback, by design: if the agent can't be loaded from Dropbox, we
// throw a clear error and the processor refuses to run — so a broken connection
// or wrong path is VISIBLE, never masked by a stale baked-in copy.
//
//   WHATSAPP_TASK_PROMPT_PATH  — Dropbox path to the agent instructions (wa-task-extractor.md)
//   WHATSAPP_PROCEDURE_PATH    — Dropbox path to the firm's deal procedure (folded in as reference)
// ============================================================
const dropbox = require('../../lib/dropbox');

const TTL_MS = 10 * 60 * 1000;
let _cache = null;
let _cacheAt = 0;

async function loadTaskPrompt() {
  if (_cache && (Date.now() - _cacheAt) < TTL_MS) return _cache;

  const instrPath = process.env.WHATSAPP_TASK_PROMPT_PATH;
  if (!instrPath) {
    throw new Error('WHATSAPP_TASK_PROMPT_PATH is not set — the task agent lives in Dropbox; point this env var at wa-task-extractor.md');
  }
  if (!(dropbox.configured && dropbox.configured())) {
    throw new Error('Dropbox is not connected — cannot load the task agent from ' + instrPath);
  }

  let prompt;
  try {
    prompt = String((await dropbox.readFile(instrPath)) || '').trim();
  } catch (e) {
    throw new Error('could not read the task agent from Dropbox (' + instrPath + '): ' + e.message);
  }
  if (!prompt) throw new Error('the task agent file at ' + instrPath + ' is empty');

  // Fold in the firm's procedure so tasks are grounded in the real workflow.
  const procPath = process.env.WHATSAPP_PROCEDURE_PATH;
  let procedureAttached = false;
  if (procPath) {
    let proc;
    try {
      proc = String((await dropbox.readFile(procPath)) || '').trim();
    } catch (e) {
      throw new Error('could not read the procedure from Dropbox (' + procPath + '): ' + e.message);
    }
    if (proc) {
      prompt += '\n\n----- FIRM DEAL PROCEDURE (reference — ground tasks in this) -----\n\n' + proc;
      procedureAttached = true;
    }
  }

  console.log('[whatsapp/processor] task agent loaded from Dropbox: ' + instrPath +
    ' | procedure ' + (procedureAttached ? ('attached (' + procPath + ')') : 'NOT attached (set WHATSAPP_PROCEDURE_PATH)'));

  _cache = prompt;
  _cacheAt = Date.now();
  return prompt;
}

module.exports = { loadTaskPrompt };
