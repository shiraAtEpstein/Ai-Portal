// ============================================================
// lib/voice-transcribe.js — speech-to-text adapter, Speechmatics-backed.
//
// Contract, kept deliberately swappable (see claude/lawly-voice-task-notes-spec.md):
//   transcribe(buffer, mime) -> { text, confidence, lang }
// If Speechmatics doesn't hold up on real firm audio, only this file needs
// to change — nothing else in the codebase knows which vendor is behind it.
//
// Picked 2026-09-14: cheapest real hosted STT API ($0.129/hr — the "Melia 1"
// multilingual batch model) among the researched candidates, and the vendor
// that explicitly benchmarks code-switching (mixed-language) accuracy — the
// firm's real usage is Hebrew with English terms mixed in, not pure Hebrew.
// NOT YET spot-checked against real firm audio (spec doc, "Still open" #1).
//
// REQUIRES SPEECHMATICS_API_KEY in the environment. Sign up at
// https://portal.speechmatics.com, create an API key, set it in Render.
// Nothing in this file works without it — every call throws immediately.
//
// FIXED 2026-09-15, after the first live call (Yaakov's task-inbox group)
// came back with a real 400: `transcription_config.model` must be one of
// "standard" / "enhanced" / "melia-1" — not "melia1" (missing hyphen), and
// `operating_point` is NOT sent alongside `model` — per Speechmatics' own
// docs (docs.speechmatics.com/speech-to-text/models), `model` REPLACES
// `operating_point` in the current API; the two aren't used together, and
// `operating_point` is deprecated. Melia-1 also requires `language: "multi"`
// explicitly — it does NOT support `"auto"`. Both are now correct below and
// match the error message's own allowed-values list exactly.
// ============================================================

const API_BASE = process.env.SPEECHMATICS_API_BASE || 'https://eu1.asr.api.speechmatics.com/v2';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // voice notes are short; 5 min is generous headroom

function apiKey() {
  const k = process.env.SPEECHMATICS_API_KEY;
  if (!k) throw new Error('SPEECHMATICS_API_KEY not set — voice transcription is not configured');
  return k;
}

function authHeaders() {
  return { Authorization: 'Bearer ' + apiKey() };
}

async function submitJob(buffer, mime) {
  const config = {
    type: 'transcription',
    transcription_config: {
      language: 'multi',  // required (not "auto") for Melia 1 to handle Hebrew/English in one recording
      model: 'melia-1',   // NOT "melia1" — see note above. `model` replaces `operating_point`, don't send both.
    },
  };
  const form = new FormData();
  form.append('config', JSON.stringify(config));
  form.append('data_file', new Blob([buffer], { type: mime || 'application/octet-stream' }), 'voice-note');

  const res = await fetch(API_BASE + '/jobs', {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Speechmatics job submission failed: ' + res.status + ' ' + body.slice(0, 300));
  }
  const data = await res.json();
  const jobId = data && data.id;
  if (!jobId) throw new Error('Speechmatics job submission returned no job id');
  return jobId;
}

async function pollJob(jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(API_BASE + '/jobs/' + jobId, { headers: authHeaders() });
    if (!res.ok) throw new Error('Speechmatics job status check failed: ' + res.status);
    const data = await res.json();
    const status = data && data.job && data.job.status;
    if (status === 'done') return;
    if (status === 'rejected') {
      throw new Error('Speechmatics rejected the job: ' + JSON.stringify((data && data.job && data.job.errors) || data));
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('Speechmatics job did not finish within ' + POLL_TIMEOUT_MS + 'ms');
}

// json-v2 transcript format: a flat list of { type: 'word'|'punctuation',
// alternatives: [{ content, confidence, language }] }. This is a simplified
// reconstruction (space before each word, punctuation appended directly) —
// good enough for feeding manual-task-extract, not meant to be a polished
// display transcript. Revisit if real output looks off (e.g. Speechmatics
// documents an `attaches_to` hint on punctuation items worth honoring).
async function fetchTranscript(jobId) {
  const res = await fetch(API_BASE + '/jobs/' + jobId + '/transcript?format=json-v2', { headers: authHeaders() });
  if (!res.ok) throw new Error('Speechmatics transcript fetch failed: ' + res.status);
  const data = await res.json();
  const results = (data && data.results) || [];
  let text = '';
  let confSum = 0;
  let confN = 0;
  let lang = null;
  for (const r of results) {
    const alt = r && r.alternatives && r.alternatives[0];
    if (!alt) continue;
    if (r.type === 'word') text += (text ? ' ' : '') + alt.content;
    else if (r.type === 'punctuation') text += alt.content;
    if (typeof alt.confidence === 'number') { confSum += alt.confidence; confN++; }
    if (alt.language && !lang) lang = alt.language;
  }
  return {
    text: text.trim(),
    confidence: confN ? confSum / confN : null,
    lang: lang || 'multi',
  };
}

async function transcribe(buffer, mime) {
  const jobId = await submitJob(buffer, mime);
  await pollJob(jobId);
  return fetchTranscript(jobId);
}

module.exports = { transcribe };
