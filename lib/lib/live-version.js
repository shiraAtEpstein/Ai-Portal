// ============================================================
// lib/live-version.js — "has anything changed?" counters (2026-10-05).
//
// Why: the WhatsApp screens (Board, messages, Dashboard, wa-review) used to
// rebuild the whole unanswered-chats board on a timer — every 25s for each
// open wa-review tab — whether or not anything had happened. On a 0.5-CPU
// Render instance that pinned the CPU at 100% and starved everything else
// (WhatsApp and the database both started timing out, 4 Oct).
//
// Now: anything that can change what those screens show bumps a counter here.
// Screens ask GET /api/live/version (answered from memory: no DB, no
// decryption, no AI) and only reload when a counter they care about moved.
//
//   board  — a WhatsApp message was ingested (client OR firm side), or someone
//            changed a chat on the Board (status / responsible / restore).
//   drafts — the responder saved a new draft, or a reviewer acted on one.
//
// In-memory only, on purpose: after a restart every counter starts at a new
// random base, so any open tab sees "changed" once and reloads — correct,
// because the server's caches are empty after a restart too.
// ============================================================
const base = Math.floor(Math.random() * 1e6);
const state = {
  board: base, boardAt: Date.now(),
  drafts: base, draftsAt: Date.now(),
};

function bump(kind) {
  if (kind !== 'board' && kind !== 'drafts') return;
  state[kind] += 1;
  state[kind + 'At'] = Date.now();
}

function get() {
  return { board: state.board, drafts: state.drafts, boardAt: state.boardAt, draftsAt: state.draftsAt };
}

module.exports = { bump, get };
