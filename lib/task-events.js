'use strict';

// ============================================================
// lib/task-events.js — real-time push for the Task Hub (2026-09-14).
//
// In-process pub/sub (Node's built-in EventEmitter), keyed by user_id
// (uuid) — the same key unified_tasks uses. Lets a freshly-extracted
// task be pushed to that user's open Task Hub tab(s) the instant it's
// created, instead of waiting for the next 45s poll or a manual
// refresh. Used by:
//   - routes/mytasks.js  — GET /api/mytasks/stream (SSE), one
//     subscriber per open browser tab.
//   - lib/task-hub.js    — publishes after a real-time extraction
//     (see processRealtimeManualMessage), which itself is called from
//     whatsapp/groups/provider.js the moment a message lands in a
//     linked personal task-inbox group.
//
// SINGLE-PROCESS ONLY. This portal runs as one Node process on Render
// today — confirmed nothing else in the repo uses Redis or any other
// shared pub/sub, and server.js has no cluster/worker setup. If that
// ever changes (more than one instance, or a worker process separate
// from the web process), this needs to move to a shared broker (Redis
// pub/sub, or Postgres LISTEN/NOTIFY) — otherwise a push can silently
// miss a client connected to a different instance. Flagged, not
// solved, here; ask before scaling to >1 instance.
// ============================================================
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0); // unbounded — one listener per open SSE connection, not a leak

function publish(userId, task) {
  if (!userId || !task) return;
  bus.emit(String(userId), task);
}

// Subscribe to real-time task pushes for one user. Returns an
// unsubscribe function — callers MUST call it when the connection
// closes (see routes/mytasks.js's req.on('close', ...)), or listeners
// pile up across reconnects.
function subscribe(userId, handler) {
  const key = String(userId);
  bus.on(key, handler);
  return function unsubscribe() { bus.off(key, handler); };
}

module.exports = { publish, subscribe };
