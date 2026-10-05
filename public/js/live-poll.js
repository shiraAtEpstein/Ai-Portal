/* ============================================================
 * public/js/live-poll.js — reload a screen only when something changed
 * (2026-10-05, CPU fix).
 *
 * Replaces "setInterval(load, N)" on the WhatsApp screens. Every ~30s, and
 * ONLY while the tab is actually visible, it asks GET /api/live/version
 * (answered from server memory — no database, no AI) and calls the page's
 * reload function only if a counter the page cares about moved:
 *
 *   LawlyLive.watch(['board'], load);                 // Board / messages
 *   LawlyLive.watch(['board', 'drafts'], load);       // wa-review
 *   LawlyLive.watch(['board'], load, { maxAgeMs: 15 * 60 * 1000 });
 *
 * Also reloads when the data on screen is older than maxAgeMs (default 10
 * min) so "waiting X hours" labels don't freeze, and checks right away when
 * the person comes back to the tab. A hidden tab makes no requests at all.
 * ============================================================ */
(function () {
  'use strict';
  var CHECK_MS = 30 * 1000;

  function watch(kinds, onChange, opts) {
    opts = opts || {};
    var maxAgeMs = opts.maxAgeMs || 10 * 60 * 1000;
    var last = null;              // last versions seen
    var loadedAt = Date.now();    // the page did its own first load already
    var busy = false;

    function visible() { return document.visibilityState === 'visible'; }

    function check() {
      if (busy || !visible()) return;
      busy = true;
      fetch('/api/live/version', { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (v) {
          if (!v) return;
          var changed = false;
          if (last) {
            for (var i = 0; i < kinds.length; i++) {
              if (v[kinds[i]] !== last[kinds[i]]) { changed = true; break; }
            }
          }
          var stale = Date.now() - loadedAt >= maxAgeMs;
          last = v;
          if (changed || stale) {
            loadedAt = Date.now();
            try { onChange(); } catch (_) { /* the page reports its own errors */ }
          }
        })
        .catch(function () { /* offline / server busy — try again next tick */ })
        .then(function () { busy = false; });
    }

    setTimeout(check, 2000);      // learn the current versions (no reload)
    setInterval(check, CHECK_MS);
    document.addEventListener('visibilitychange', function () { if (visible()) check(); });

    return {
      // Call after a manual reload so the max-age clock restarts.
      markLoaded: function () { loadedAt = Date.now(); }
    };
  }

  window.LawlyLive = { watch: watch };
})();
