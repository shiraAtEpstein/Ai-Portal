// ============================================================
// whatsapp/groups/provider.js — Baileys connection lifecycle.
//
// Read-only, groups-only, Phase 1: no sendMessage method exists on this
// object at all — that's the enforcement mechanism, not a flag to check.
//
// Emits events instead of calling into the rest of the app directly, so
// nothing here needs to know about routes, the DB schema for messages
// (that lands in Milestone 3), or LAWLY's AI pipeline. Node's built-in
// EventEmitter is enough for this in-process fan-out — no custom bus
// class needed in a CommonJS codebase this size.
//
// Events emitted:
//   'status'  (status: string, detail?: string)   e.g. 'connected', 'auth_required'
//   'qr'      (qrString: string)                  raw QR payload to render
//   'group'   (group: DB row)                     a group was seen/updated
// ============================================================
const { EventEmitter } = require('events');
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { NodeCache } = require('@cacheable/node-cache');
const { createAuthStore } = require('./auth-store');
const db = require('./db');

const MAX_BACKOFF_MS = 30_000;

class BaileysGroupsProvider extends EventEmitter {
  constructor(accountId) {
    super();
    this.accountId = accountId;
    this.sock = null;
    this.authStore = null;
    this.status = 'disconnected';
    this.reconnectAttempt = 0;
    this._stopped = false;

    // Required by Baileys internally (retry/decrypt bookkeeping and the
    // device list per JID) — without these, processMessage() crashes on
    // its first real incoming message (confirmed against our own logs:
    // TypeError in NodeCache.formatKey via process-message.js). Created
    // once here, not per-connect, so counts survive a reconnect.
    this.msgRetryCounterCache = new NodeCache();
    this.userDevicesCache = new NodeCache();
  }

  getStatus() {
    return this.status;
  }

  async connect() {
    this._stopped = false;
    this.authStore = await createAuthStore(this.accountId);
    await this._startSocket();
  }

  async disconnect() {
    this._stopped = true;
    try {
      await this.sock?.logout();
    } catch (e) {
      // Already disconnected — fine to ignore.
    }
    this.sock = null;
    await this._setStatus('disconnected');
  }

  async getGroups() {
    return db.listGroups(this.accountId);
  }

  // Media download is not implemented in Phase 1 (text-only, per the
  // operator's explicit call). Left as a clear stub rather than silently
  // absent, so a future milestone has one obvious place to fill in.
  async downloadAttachment() {
    throw new Error('Media download not implemented yet — Phase 1 is text-only.');
  }

  async _startSocket() {
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: {
        creds: this.authStore.auth.creds,
        keys: makeCacheableSignalKeyStore(this.authStore.auth.keys, silentLogger()),
      },
      logger: silentLogger(),
      msgRetryCounterCache: this.msgRetryCounterCache,
      userDevicesCache: this.userDevicesCache,
      // Read-only posture: don't announce presence, don't pull full
      // history — we only care about new messages going forward.
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    this.sock.ev.on('creds.update', () => {
      this.authStore.onCredsUpdate(this.sock.authState.creds);
    });

    this.sock.ev.on('connection.update', (update) => this._handleConnectionUpdate(update));

    this.sock.ev.on('groups.update', async (updates) => {
      for (const g of updates) {
        if (g.id) await this._upsertGroup(g.id, g.subject, g.size);
      }
    });

    // Milestone 3 will add: this.sock.ev.on('messages.upsert', ...)
  }

  async _handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      await this._setStatus('auth_required', 'Scan the QR code');
      this.emit('qr', qr);
      return;
    }

    if (connection === 'open') {
      this.reconnectAttempt = 0;
      await this._setStatus('connected');
      await this._discoverGroups();
      return;
    }

    if (connection === 'close') {
      if (this._stopped) return; // intentional disconnect, don't reconnect

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        await this._setStatus('auth_required', 'Session logged out — rescan QR required');
        return;
      }

      await this._setStatus('reconnecting');
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    this.reconnectAttempt += 1;
    const delayMs = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.reconnectAttempt);
    console.warn(`[whatsapp/groups] reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => {
      if (!this._stopped) this._startSocket().catch((e) => console.error('[whatsapp/groups] reconnect failed:', e.message));
    }, delayMs);
  }

  // A single unretried query right at connect time is fragile — this is
  // the same class of query (WhatsApp account/group metadata) that
  // produced the 'Timed Out' error we saw right after connecting, likely
  // because WhatsApp's servers are briefly slow to respond in the first
  // minute or two after a fresh device link. Retry a few times with
  // backoff before giving up, rather than silently leaving groups empty.
  async _discoverGroups(attempt) {
    attempt = attempt || 1;
    if (!this.sock) return;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const jid of Object.keys(groups)) {
        const g = groups[jid];
        await this._upsertGroup(jid, g.subject, g.participants ? g.participants.length : null);
      }
      console.log(`[whatsapp/groups] discovery found ${Object.keys(groups).length} group(s) (attempt ${attempt})`);
    } catch (e) {
      console.error(`[whatsapp/groups] group discovery failed (attempt ${attempt}):`, e.message);
      if (attempt < 4 && this.sock && !this._stopped) {
        const delayMs = attempt * 5000; // 5s, 10s, 15s
        setTimeout(() => this._discoverGroups(attempt + 1), delayMs);
      }
    }
  }

  async _upsertGroup(jid, name, participantCount) {
    const group = await db.upsertGroup(this.accountId, jid, name, participantCount);
    if (group) this.emit('group', group);
  }

  async _setStatus(status, detail) {
    this.status = status;
    await db.setAccountStatus(this.accountId, status, detail).catch((e) =>
      console.error('[whatsapp/groups] failed to persist status:', e.message)
    );
    this.emit('status', status, detail);
  }
}

// Baileys wants a pino-shaped logger; we don't want its verbose default
// output mixed into the portal's console. A tiny no-op logger that
// forwards only warn/error keeps things quiet without a real dependency.
function silentLogger() {
  const noop = () => {};
  const logger = {
    level: 'silent',
    trace: noop, debug: noop, info: noop,
    warn: (msg) => console.warn('[baileys]', msg),
    error: (msg) => console.error('[baileys]', msg),
    child: () => logger,
  };
  return logger;
}

module.exports = { BaileysGroupsProvider };
