// ============================================================
// whatsapp/ingest/voice.js — orchestrates one voice-note transcription:
// claim -> download -> transcribe -> save. Fire-and-forget from
// whatsapp/ingest/db.js's listTaskInboxMessages(); never throws to its caller.
//
// v1 scope (claude/lawly-voice-task-notes-spec.md): only called for messages
// already known to be in a personal task-inbox group (task_owner_email set).
// Nothing here is wired into the deal-summary pipeline (whatsapp/ingest/
// processor.js) — that stays on the placeholder behavior until a separate,
// later decision (client audio going to the same transcription vendor).
// ============================================================
const db = require('./db');
const media = require('./media');
const transcribeAdapter = require('../../lib/voice-transcribe');

async function transcribeOne(sourceItemId, rawMessage) {
  const claimed = await db.claimVoiceTranscriptionJob(sourceItemId);
  if (!claimed) return; // already done, already being worked on elsewhere, or over the retry cap
  try {
    const { buffer, mime } = await media.downloadAudioBuffer(rawMessage);
    const result = await transcribeAdapter.transcribe(buffer, mime);
    if (!result || !result.text) throw new Error('transcription returned no text');
    await db.saveVoiceTranscript(sourceItemId, result);
  } catch (e) {
    await db.markVoiceTranscriptionFailed(sourceItemId, e && e.message);
  }
}

module.exports = { transcribeOne };
