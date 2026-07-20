// ============================================================
// whatsapp/groups/safe-cache.js — a minimal CacheStore for Baileys.
//
// Baileys' CacheStore interface is just get/set/del/flushAll. When you
// don't supply one for msgRetryCounterCache, userDevicesCache, or
// placeholderResendCache, Baileys creates its own default using
// @cacheable/node-cache — and that package's formatKey() does
// `key.toString()` with no null check. WhatsApp sometimes sends a
// message where the field used as a cache key (e.g. a stanzaId) is
// null, which crashes processMessage() on every such message
// (confirmed in our own logs: TypeError in NodeCache.formatKey).
//
// The classic `node-cache` package has the same problem from the other
// direction — it throws a hard EKEYTYPE error on a non-string/number
// key instead of just no-opping.
//
// Simplest fix: don't depend on either cache package for this. A plain
// Map with a null/undefined guard satisfies Baileys' CacheStore type
// and never throws, so we supply this for all three cache slots.
// ============================================================
class SafeCache {
  constructor() {
    this._map = new Map();
  }

  get(key) {
    if (key === null || key === undefined) return undefined;
    return this._map.get(key);
  }

  set(key, value) {
    if (key === null || key === undefined) return;
    this._map.set(key, value);
  }

  del(key) {
    if (key === null || key === undefined) return;
    this._map.delete(key);
  }

  flushAll() {
    this._map.clear();
  }
}

module.exports = { SafeCache };
