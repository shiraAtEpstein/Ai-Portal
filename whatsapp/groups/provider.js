// ============================================================
// whatsapp/groups/provider.js — Baileys connection lifecycle.
//
// Read-only, Phase 1: no sendMessage method exists on this object at all —
// that's the enforcement mechanism, not a flag to check.
//
// Scope note: this module is named "groups" because it also DISCOVERS and
// tracks group metadata (whatsapp_groups + is_monitored), but message
// INGESTION deliberately captures ALL chats — 1:1 client DMs included — per
// the operator's decision to monitor the whole dedicated firm line. The
// is_monitored flag governs group listing/display, not ingestion; ingestion
// has no whitelist.
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
  areJidsSameUser,
} = require('@whiskeysockets/baileys');
const { SafeCache } = require('./safe-cache');
const { createAuthStore } = require('./auth-store');
const db = require('./db');
const ingestDb = require('../ingest/db');
const { senderFromMessage } = require('../ingest/phone');
const monday = require('../../lib/monday');

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
    this.msgRetryCounterCache = new SafeCache();
    this.userDevicesCache = new SafeCache();
    this.placeholderResendCache = new SafeCache();
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
      placeholderResendCache: this.placeholderResendCache,
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

    // Fires when the account is added to (or creates) a group — a
    // different event from 'groups.update', which only covers metadata
    // changes on groups it already knew about. Without this, a newly
    // joined group wasn't seen until the next full reconnect re-ran
    // groupFetchAllParticipating() in _discoverGroups().
    this.sock.ev.on('groups.upsert', async (groups) => {
      for (const g of groups) {
        if (g.id) await this._upsertGroup(g.id, g.subject, g.size ?? (g.participants ? g.participants.length : null));
      }
    });

    // 'remove' fires both when someone kicks us and when we leave
    // ourselves (Baileys doesn't distinguish at this event level — only
    // the resulting chat message stub does). Either way, if OUR jid is in
    // the removed list, the group is gone as far as this monitor is
    // concerned. There is no separate "group deleted" event in Baileys;
    // an admin deleting the group for everyone surfaces the same way,
    // as every member (including us) being removed.
    this.sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
      if (action !== 'remove') return;
      const ownJid = this.sock?.user?.id || this.authStore?.auth?.creds?.me?.id;
      if (!ownJid) return;
      const wasRemoved = participants.some((jid) => areJidsSameUser(jid, ownJid));
      if (wasRemoved) {
        await db.markGroupRemoved(this.accountId, id);
        console.log(`[whatsapp/groups] removed from group: ${id}`);
      }
    });

  // Message ingestion (Phase 1): fresh messages -> pending processing_jobs.
    // Never throws back into Baileys.
    this.sock.ev.on('messages.upsert', async (up) => {
      try { await this._ingest(up); } catch (e) {
        console.error('[whatsapp/ingest] upsert handler failed:', e.message);
      }
    });
  }

  async _ingest({ messages, type }) {
    if (type !== 'notify' || !Array.isArray(messages)) return;
    let enqueued = 0;
    let skipped = 0;
    for (const msg of messages) {
      try {
        const info = senderFromMessage(msg);
        if (!info.message_id) { skipped++; continue; }

        // No usable client phone. Two cases we still WANT to capture (raw
        // message archived for later resolution, no contact linked):
        //   - @lid sender (opaque id, not a phone) — common in newer chats
        //   - our own outbound group message (no single client to attribute)
        // Anything else with no phone (status@broadcast, newsletters, system
        // stubs) is noise — skip it as before.
        let contact = null;
        if (info.phone_normalized) {
          contact = await ingestDb.getContactByPhone(info.phone_normalized);
          if (!contact) {
            const match = await this._matchClient(info.phone_normalized);
            contact = await ingestDb.upsertContact(this._contactFields(info, msg, match));
          } else if (contact.resolution_status === 'unresolved') {
            // Cheap re-resolution: a client may have been added to Monday
            // since this contact was first seen. Only reaches Monday when the
            // index is already warm/refreshed, so it's not a per-message cost.
            const match = await this._matchClient(info.phone_normalized);
            if (match) {
              contact = (await ingestDb.upsertContact(this._contactFields(info, msg, match))) || contact;
            }
          }
        } else if (!info.is_lid && !info.self_outbound_group) {
          skipped++; continue;
        }

        const jobId = await ingestDb.enqueueJob({
          source_item_id: info.message_id,
          chat_jid: info.chat_jid,
          is_group: info.is_group,
          direction: info.direction,
          sender_phone: info.phone_normalized || null,
          contact_id: contact ? contact.id : null,
          payloadObj: msg,
        });
        if (jobId) enqueued++; else skipped++;
      } catch (e) {
        skipped++;
        console.error('[whatsapp/ingest] failed to ingest one message:', e.message);
      }
    }
    if (enqueued || skipped) {
      console.log(`[whatsapp/ingest] enqueued ${enqueued}, skipped/duplicate ${skipped}`);
    }
  }

  // Never let a Monday hiccup break ingestion — a failed lookup just means
  // "unresolved for now", retried on a later message (see re-resolution
  // above). Returns null on no-match, ambiguous phone, or any error.
  async _matchClient(phoneNormalized) {
    try { return await monday.findClientByPhone(phoneNormalized); }
    catch (_) { return null; }
  }

  _contactFields(info, msg, match) {
    const base = {
      phone_normalized: info.phone_normalized,
      phone_raw: info.phone_raw,
      display_name: (msg && msg.pushName) || null,
    };
    if (match) {
      return { ...base, monday_item_id: match.monday_item_id, monday_client_name: match.name, resolution_status: 'resolved' };
    }
    return { ...base, resolution_status: 'unresolved' };
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
      const seenJids = new Set();
      for (const jid of Object.keys(groups)) {
        const g = groups[jid];
        await this._upsertGroup(jid, g.subject, g.participants ? g.participants.length : null);
        seenJids.add(jid);
      }
      await this._reconcileRemovedGroups(seenJids);
      console.log(`[whatsapp/groups] discovery found ${Object.keys(groups).length} group(s) (attempt ${attempt})`);
    } catch (e) {
      console.error(`[whatsapp/groups] group discovery failed (attempt ${attempt}):`, e.message);
      if (attempt < 4 && this.sock && !this._stopped) {
        const delayMs = attempt * 5000; // 5s, 10s, 15s
        setTimeout(() => this._discoverGroups(attempt + 1), delayMs);
      }
    }
  }

  // Full discovery is the source of truth for "what groups are we
  // actually still in right now." Anything marked active in our DB but
  // absent from this fresh list has left/been removed/deleted — whether
  // because the live group-participants.update event fired before this
  // listener existed, was missed during a disconnect window, or any other
  // gap. Runs after every successful reconnect, so it self-heals rather
  // than requiring a manual /reset each time this happens.
  async _reconcileRemovedGroups(seenJids) {
    const active = await db.listGroups(this.accountId);
    for (const g of active) {
      if (!seenJids.has(g.provider_group_jid)) {
        await db.markGroupRemoved(this.accountId, g.provider_group_jid);
        console.log(`[whatsapp/groups] reconciled as removed (not in current group list): ${g.name} (${g.provider_group_jid})`);
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
