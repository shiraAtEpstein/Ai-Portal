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
const { pickDealByGroupName } = require('../ingest/match');
const { pickDealByGroupNameAI } = require('../ingest/ai-match');
const monday = require('../../lib/monday');

// Reconnect policy. The old code capped backoff at 30s and then retried
// FOREVER with no jitter — that produced 700+ perfectly-regular reconnects
// against a dead/restricted session, which is exactly the pattern WhatsApp
// flags as automated abuse. Now: back off up to 10 min, add jitter so the
// retries aren't metronomic, and STOP after a bounded number of attempts —
// handing off to the human-alert path (bootstrap emails on 'auth_required')
// instead of hammering. Ordinary blips still recover within the first few
// fast attempts; only a genuinely stuck session reaches the cap.
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 600_000;          // 10 min ceiling (was 30s)
const MAX_RECONNECT_ATTEMPTS = 15;       // ~1h of backed-off tries, then stop

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
    this.reconnectAttempt = 0; // fresh attempt budget on a manual (re)connect / reset
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
      // Diagnostic: logs EVERY upsert before any filtering, so we can see
      // whether WhatsApp is delivering messages to this device at all, and
      // with what type ('notify' = live, 'append' = history-style).
      console.log(`[whatsapp/ingest] upsert received: type=${up && up.type} count=${up && up.messages ? up.messages.length : 0}`);
      // (Removed the 'first message key' diagnostic that dumped raw message
      // keys — those include client phone numbers, which must not be written
      // to the logs. LID→phone resolution is confirmed working.)
      try { await this._ingest(up); } catch (e) {
        console.error('[whatsapp/ingest] upsert handler failed:', e.message);
      }
    });
  }

  async _ingest({ messages, type }) {
    if (!Array.isArray(messages)) return;
    // 'notify' = live messages. 'append' = messages WhatsApp redelivers after a
    // reconnect/gap (or a small recent-message sync). We ingest BOTH so a
    // message missed during a disconnect is still captured when it comes back —
    // without this, the redelivered copy was silently dropped and the message
    // was lost for good. Safe to reprocess: UNIQUE(source, source_item_id) +
    // ON CONFLICT DO NOTHING means a message that arrives twice inserts once.
    // Other upsert types (e.g. 'replace' for edits) are ignored for now.
    if (type !== 'notify' && type !== 'append') return;
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

        // Resolve the message up to its Deal (Phase 4). The deal belongs to the
        // CHAT, not the client: a group resolves via its stored group-id or by
        // matching the group name against the sender-client's deals; a 1:1 chat
        // falls back to the client (only when they have a single deal).
        const dealId = await this._resolveDealForMessage(info, contact);

        const jobId = await ingestDb.enqueueJob({
          source_item_id: info.message_id,
          chat_jid: info.chat_jid,
          is_group: info.is_group,
          direction: info.direction,
          sender_phone: info.phone_normalized || null,
          contact_id: contact ? contact.id : null,
          deal_id: dealId,
          payloadObj: msg,
        });
        if (jobId) {
          enqueued++;
          if (dealId) {
            // Mark for the summary processor, and update the deterministic
            // "awaiting reply" signal (client in / firm out).
            try { await ingestDb.markDealNeedsUpdate(dealId); } catch (_) {}
            try { await ingestDb.noteDealActivity(dealId, info.direction, info.timestamp); } catch (_) {}
          }
        } else skipped++;
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

  // Resolve a message to its Deal. The deal belongs to the CHAT.
  //   Group chat:
  //     1) the deal that stores THIS group's id (most reliable), else
  //     2) the sender-client's deals, disambiguated by matching the group name.
  //     Cached on the whatsapp_groups row so it's resolved once per group.
  //   One-on-one chat: fall back to the client (only if a single deal).
  // Never throws — a failure just leaves the message unlinked (review).
  async _resolveDealForMessage(info, contact) {
    try {
      if (!info.is_group) {
        return await this._resolveContactDeal(contact);
      }
      const group = await db.getGroup(this.accountId, info.chat_jid);
      if (group && group.deal_id) return group.deal_id;   // already resolved once

      // 1) Reliable: a deal has this group's id stored.
      let dealDesc = await monday.resolveDealForGroupId(info.chat_jid);

      // 2) Else: pick from the sender-client's deals by best group-name match —
      //    first the free deterministic pass, then an AI fallback for the
      //    ambiguous / cross-language cases (constrained to these candidates).
      if (!dealDesc && contact && contact.monday_item_id) {
        const candidates = await monday.resolveDealsForClient(contact.monday_item_id);
        const groupName = group && group.name;
        dealDesc = pickDealByGroupName(groupName, candidates);
        if (!dealDesc) dealDesc = await pickDealByGroupNameAI(groupName, candidates);
      }
      if (!dealDesc) return null;

      const dealRow = await ingestDb.upsertDeal(dealDesc);
      if (!dealRow) return null;
      await db.setGroupDeal(this.accountId, info.chat_jid, dealRow.id);
      return dealRow.id;
    } catch (e) {
      console.error('[whatsapp/ingest] deal resolution failed:', e.message);
      return null;
    }
  }

  // 1:1 fallback: resolve (and cache on the contact) the deal, only when the
  // client has exactly ONE deal — otherwise there's no way to disambiguate a
  // one-on-one message, so it stays unlinked (review).
  async _resolveContactDeal(contact) {
    if (!contact) return null;
    if (contact.deal_id) return contact.deal_id;        // already resolved once
    if (!contact.monday_item_id) return null;           // sender not matched to a client
    try {
      const deals = await monday.resolveDealsForClient(contact.monday_item_id);
      if (!Array.isArray(deals) || deals.length !== 1) {
        if (deals && deals.length > 1) {
          console.log(`[whatsapp/ingest] client ${contact.monday_item_id} is in ${deals.length} deals — leaving message unlinked (ambiguous)`);
        }
        return null;
      }
      const dealRow = await ingestDb.upsertDeal(deals[0]);
      if (!dealRow) return null;
      await ingestDb.setContactDeal(contact.id, dealRow.id);
      contact.deal_id = dealRow.id;
      return dealRow.id;
    } catch (e) {
      console.error('[whatsapp/ingest] deal resolution failed:', e.message);
      return null;
    }
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

    // Endless reconnects against a logged-out / restricted / dead session are
    // pointless and are the exact signal WhatsApp treats as abuse. After a
    // bounded number of attempts, STOP auto-reconnecting and surface an
    // 'auth_required' state — bootstrap emails the operator on that status, and
    // a manual Reset or a redeploy (both start a fresh provider) resumes it.
    if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      this._stopped = true;
      console.error(`[whatsapp/groups] giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts — manual Reset / QR rescan needed`);
      this._setStatus('auth_required', `Stopped auto-reconnecting after ${MAX_RECONNECT_ATTEMPTS} failed attempts — rescan the QR or Reset the connector to resume`)
        .catch((e) => console.error('[whatsapp/groups] failed to persist give-up status:', e.message));
      return;
    }

    // Exponential backoff with a 10-min ceiling, plus jitter (a random 50-100%
    // of the computed delay) so repeated reconnects don't land on a perfectly
    // regular clock — another automation tell.
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.reconnectAttempt);
    const delayMs = Math.round(ceiling * (0.5 + Math.random() * 0.5));
    console.warn(`[whatsapp/groups] reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);
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
    const prev = this.status;
    this.status = status;
    await db.setAccountStatus(this.accountId, status, detail).catch((e) =>
      console.error('[whatsapp/groups] failed to persist status:', e.message)
    );
    // Record offline windows so missed-message gaps are auditable. "up" is
    // strictly 'connected'; anything else (reconnecting / auth_required /
    // disconnected) is "down". Only act on an actual up<->down transition.
    this._trackConnectionGap(prev, status, detail).catch((e) =>
      console.error('[whatsapp/gap] failed to record connection gap:', e.message)
    );
    this.emit('status', status, detail);
  }

  async _trackConnectionGap(prevStatus, newStatus, detail) {
    const wasUp = prevStatus === 'connected';
    const isUp = newStatus === 'connected';
    if (wasUp && !isUp) {
      // Just went offline — open a gap window (idempotent).
      await db.openConnectionGap(this.accountId, detail || newStatus);
      console.warn(`[whatsapp/gap] connection down (${detail || newStatus}) — messages arriving now may be missed until reconnect`);
    } else if (!wasUp && isUp) {
      // Just came back — close the open window and report how long it lasted.
      const gap = await db.closeConnectionGap(this.accountId);
      if (gap && gap.went_down_at) {
        const mins = Math.max(0, Math.round((new Date(gap.came_back_at) - new Date(gap.went_down_at)) / 60000));
        console.log(`[whatsapp/gap] reconnected after ~${mins} min offline (down ${gap.went_down_at} → back ${gap.came_back_at}) — check these chats if it was long`);
      }
    }
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
