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

async function createAuthStore(accountId) {
  const stored = await db.loadAuthState(accountId);
  const state = stored || { creds: initAuthCreds(), keys: {} };

  let dirty = false;
  let flushTimer = null;

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  async function flush() {
    flushTimer = null;
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

  return { auth, onCredsUpdate, flush };
}

module.exports = { createAuthStore };
