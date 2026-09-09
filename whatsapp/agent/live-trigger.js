// ============================================================
// whatsapp/agent/live-trigger.js — runs the responder for ONE chat shortly
// after a real client message arrives, instead of waiting for someone to open
// wa-review.html and click "Generate drafts".
//
// Debounced per chat: a client who sends three messages in a row gets ONE
// draft off the whole block, not three separate runs racing each other.
// Reuses runQueueDrafts({ onlyChatJid }) exactly as the admin button does —
// no new query logic, same "is this really unanswered right now" check
// (buildBoard, fresh each time).
//
// Called from whatsapp/groups/provider.js right after a genuine inbound
// CLIENT message is enqueued (never for staff messages or our own sends).
//
// Kill switch: WA_RESPONDER_LIVE_TRIGGER=0 turns this off instantly, no
// redeploy — the admin button and the twice-daily task processor are
// unaffected either way, since neither depends on this module.
// ============================================================
const DEBOUNCE_MS = parseInt(process.env.WA_RESPONDER_DEBOUNCE_MS || '', 10) || 45000;

const timers = new Map();   // chatJid -> Timeout
const running = new Set();  // chatJid currently being drafted, to avoid overlap

function scheduleDraft(chatJid) {
  if (!chatJid || process.env.WA_RESPONDER_LIVE_TRIGGER === '0') return;

  const existing = timers.get(chatJid);
  if (existing) clearTimeout(existing);

  timers.set(chatJid, setTimeout(async () => {
    timers.delete(chatJid);
    if (running.has(chatJid)) {
      // A run is already in flight for this chat. Previously this just
      // returned and relied on some LATER message to re-trigger a run — but
      // if this happened to be the client's last message for now, nothing
      // ever rescheduled and it was silently never drafted for. Reschedule
      // ourselves instead so it's retried after the in-flight run clears.
      // Cheap even when it turns out not to be needed: runQueueDrafts()
      // already no-ops on a message that's already been drafted.
      scheduleDraft(chatJid);
      return;
    }
    running.add(chatJid);
    try {
      // Lazy require: this file is loaded from provider.js (the Baileys
      // connection lifecycle), which should never eagerly pull in Neon/Claude
      // clients just because a message came in — only once one actually needs
      // drafting.
      const { runQueueDrafts } = require('./replay-history');
      const r = await runQueueDrafts({ onlyChatJid: chatJid, limit: 1 });
      if (r.ran) {
        const row = r.rows && r.rows[0];
        console.log(`[wa-agent/live-trigger] ${chatJid}: ${row ? row.outcome : 'ran'}`);
      }
    } catch (e) {
      // Never throw back into the caller — same posture as the rest of
      // whatsapp/groups/provider.js's ingest path.
      console.error('[wa-agent/live-trigger] draft run failed for', chatJid, e.message);
    } finally {
      running.delete(chatJid);
    }
  }, DEBOUNCE_MS));
}

module.exports = { scheduleDraft };
