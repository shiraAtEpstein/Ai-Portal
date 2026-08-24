// ============================================================
// public/js/wa-button.js — the "הצג וואטסאפ" button's live count.
//
// Puts a number on the sidebar button so a person knows there is something
// waiting on them without opening the page. The button works with or without
// this file: it is a plain link to /messages.html, and everything here only
// decorates it.
//
// ── WHY IT IS THIS QUIET ────────────────────────────────────────────────────
// /api/me/board rebuilds the control board, which runs the AI triage for any
// chat whose content changed. The board itself is cached server-side for 45s,
// but this file must still not turn every open portal tab into a poller:
//
//   • it fetches once, a moment after the portal appears;
//   • it refreshes every 5 minutes, and ONLY while the tab is visible;
//   • a hidden tab is skipped entirely and picks up again when it is shown.
//
// A failure is silent by design. A red badge that appears because the network
// blipped is worse than no badge, and the person is one click from the real
// list either way.
// ============================================================
(function () {
  var POLL_MS = 5 * 60 * 1000;
  var btn, badge, timer = null;

  function paint(n) {
    if (!badge) return;
    if (!n) {                       // nothing waiting -> no badge at all
      badge.textContent = '';
      badge.removeAttribute('style');
      return;
    }
    badge.textContent = String(n);
    badge.setAttribute('style', [
      'display:inline-block',
      'min-width:20px',
      'margin-inline-start:8px',
      'padding:1px 7px',
      'border-radius:999px',
      'background:#b4462f',
      'color:#fff',
      'font-size:11px',
      'font-weight:700',
      'line-height:17px',
      'text-align:center',
      'vertical-align:middle',
    ].join(';'));
  }

  function portalVisible() {
    var portal = document.getElementById('portal');
    return !!portal && portal.style.display !== 'none' && document.visibilityState !== 'hidden';
  }

  function refresh() {
    if (!portalVisible()) return;
    fetch('/api/me/board?scope=mine', {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) paint(Number(d.count) || 0); })
      .catch(function () { /* silent: never show a badge we are unsure of */ });
  }

  function start() {
    btn = document.getElementById('whatsapp-open-btn');
    badge = document.getElementById('whatsapp-count');
    if (!btn || !badge) return;             // button not on this page — nothing to do
    setTimeout(refresh, 1500);              // let the portal finish booting first
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refresh();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
