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
//
// Two callers, same function:
//   1. whatsapp/groups/provider.js's _ingest() — LIVE, the instant a voice
//      note arrives (2026-09-16, Shira: "why wait for a poll?"). Passes
//      ownerEmail, since it already looked up task_owner_email to decide
//      whether to fire at all — so on success THIS run also triggers real
//      task extraction immediately (taskHub.refreshManualTasks — just the
//      manual/task-inbox source for that one person, not email/monday too;
//      see that function's own comment, added the same day for the same
//      reason), instead of waiting for the next scheduled refresh.
//   2. whatsapp/ingest/db.js's listTaskInboxMessages() — the backlog/safety
//      net path (a message from before this was live, or a run the live
//      trigger missed). No ownerEmail passed; on success it just leaves the
//      transcript ready for the next scheduled/manual refresh to pick up,
//      same as before 2026-09-16.
// claimVoiceTranscriptionJob() makes both paths racing on the same message
// safe — only one caller ever wins the claim.
// ============================================================
const db = require('./db');
const media = require('./media');
const transcribeAdapter = require('../../lib/voice-transcribe');

async function transcribeOne(sourceItemId, rawMessage, ownerEmail) {
  const claimed = await db.claimVoiceTranscriptionJob(sourceItemId);
  if (!claimed) return; // already done, already being worked on elsewhere, or over the retry cap
  try {
    const { buffer, mime } = await media.downloadAudioBuffer(rawMessage);
    const result = await transcribeAdapter.transcribe(buffer, mime);
    if (!result || !result.text) throw new Error('transcription returned no text');
    await db.saveVoiceTranscript(sourceItemId, result);
    if (ownerEmail) await triggerImmediateRefresh(ownerEmail, sourceItemId);
  } catch (e) {
    await db.markVoiceTranscriptionFailed(sourceItemId, e && e.message);
  }
}

// Best-effort: resolve the group's owner to a userId and run ONLY the
// manual/task-inbox extraction for them (taskHub.refreshManualTasks) — not
// the full refreshTasks(), which would also re-check that person's email
// and monday.com. Those sources have nothing to do with a voice note
// finishing transcription; re-polling them on every single voice note was
// unnecessary Gmail/monday traffic (2026-09-16, Shira). The manual Refresh
// button and the 5-min background poll (lib/scheduler.js) still call the
// full refreshTasks() — that's genuinely meant to catch everything at once.
// Never throws past this function: a failure here just means "the next
// scheduled refresh will pick it up instead," the same fallback the
// backlog path always relied on.
async function triggerImmediateRefresh(ownerEmail, sourceItemId) {
  try {
    const appDb = require('../../db');
    const taskHub = require('../../lib/task-hub');
    const user = await appDb.getUserAuthByEmail(ownerEmail);
    if (!user || !user.id) {
      console.warn('[task-inbox/live] no user found for', ownerEmail, '— transcript for', sourceItemId, 'will surface on the next scheduled refresh instead');
      return;
    }
    await taskHub.refreshManualTasks(user.id);
  } catch (e) {
    console.warn('[task-inbox/live] immediate refresh failed for', ownerEmail, '-', e && e.message, '(next scheduled refresh will still pick it up)');
  }
}

module.exports = { transcribeOne };
