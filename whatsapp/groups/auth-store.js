// ============================================================
// whatsapp/groups/auth-store.js — Baileys AuthenticationState, backed by
// Postgres instead of the filesystem.
//
// Why not Baileys' built-in useMultiFileAuthState(): it writes JSON files
// to local disk, and Render's disk is ephemeral — every deploy/restart
// would force a fresh QR re-scan on the physical SIM. This adapter keeps
// the whole state (creds + signal keys) as one encrypted blob in the
// whatsapp_group_accounts row instead, so it survives deploys.
//
// Key writes are debounced (Baileys touches signal keys on every message
// decrypt) so we don't hammer Postgres.
// ============================================================
const { initAuthCreds } = require('@whiskeysockets/baileys');
const db = require('./db');

const FLUSH_DELAY_MS = 1500;

// 2026-10-05: WA_RESET_SESSIONS — a comma-separated list of WhatsApp numbers
// / lid ids (digits only, e.g. "65748097605659"). At boot, the stored
// encryption session(s) for exactly those contacts are deleted, so Baileys
// negotiates a fresh one on the next message instead of failing every message
// with "Bad MAC / No matching sessions". Nothing else in the auth state is
// touched and no QR re-scan is needed. Remove the variable again once the
// errors have stopped (leaving it only re-runs the same harmless reset on
// each boot).
function resetSessions(state) {
  const wanted = String(process.env.WA_RESET_SESSIONS || '')
    .split(',').map((x) => x.replace(/\D/g, '')).filter(Boolean);
  if (!wanted.length) return 0;
  const sessions = (state.keys && state.keys.session) || {};
  let removed = 0;
  for (const id of Object.keys(sessions)) {
    // Signal addresses look like "<number>.<device>" or "<lid>_<domain>.<device>".
    const user = id.split(/[._]/)[0];
    if (wanted.includes(user)) { delete sessions[id]; removed++; }
  }
  console.log(`[whatsapp/groups] WA_RESET_SESSIONS: removed ${removed} stored session(s) for ${wanted.join(', ')}`);
  return removed;
}

async function createAuthStore(accountId) {
  const stored = await db.loadAuthState(accountId);
  const state = stored || { creds: initAuthCreds(), keys: {} };

  let dirty = false;
  let flushTimer = null;
  // 2026-10-05: set on shutdown. A server that is being replaced by a deploy
  // must never write its (soon stale) copy of the keys over the new server's
  // copy — that overwrite is what put chats into "Bad MAC" after the 5 Oct
  // deploy. The whole auth state is ONE row, so the last writer wins.
  let frozen = false;

  function scheduleFlush() {
    if (frozen) return;
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  async function flush() {
    flushTimer = null;
    if (frozen) return;
    if (!dirty) return;
    dirty = false;
    try {
      await db.saveAuthState(accountId, state);
    } catch (e) {
      console.error('[whatsapp/groups] failed to persist auth state:', e.message);
      // Re-mark dirty so the next scheduled write retries.
      dirty = true;
    }
  }

  // db.js's save/load round-trips Buffers correctly anywhere in the
  // object graph (creds and keys alike), so keys are stored and read
  // back as-is here — no separate marker scheme needed.
  const auth = {
    creds: state.creds,
    keys: {
      get: async (type, ids) => {
        const bucket = state.keys[type] || {};
        const result = {};
        for (const id of ids) {
          if (bucket[id] !== undefined) result[id] = bucket[id];
        }
        return result;
      },
      set: async (data) => {
        for (const type of Object.keys(data)) {
          state.keys[type] = state.keys[type] || {};
          for (const id of Object.keys(data[type])) {
            const value = data[type][id];
            if (value === null || value === undefined) {
              delete state.keys[type][id];
            } else {
              state.keys[type][id] = value;
            }
          }
        }
        scheduleFlush();
      },
    },
  };

  function onCredsUpdate(creds) {
    state.creds = creds;
    auth.creds = creds;
    scheduleFlush();
  }

  // Stop all further writes of the auth state (see `frozen` above).
  function freeze() {
    frozen = true;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }

  if (resetSessions(state) > 0) scheduleFlush();

  return { auth, onCredsUpdate, flush, freeze };
}

module.exports = { createAuthStore };
