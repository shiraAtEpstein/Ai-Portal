// ============================================================
// public/calendar-connect.js — injects the "Connect Google Calendar"
// button + toast into the portal UI and wires the connect/disconnect flow.
// Loaded by server.js the same way marketing.js is (deferred script tag),
// so no edit to the large index.html is needed. Mirrors the Gmail connect UI.
// ============================================================
(function () {
  var btn = null, toast = null, statusCache = null, tries = 0;

  function injectStyles() {
    if (document.getElementById('calendar-connect-styles')) return;
    var s = document.createElement('style');
    s.id = 'calendar-connect-styles';
    s.textContent =
      '.calendar-btn{display:block}' +
      '.calendar-btn.connected{color:#7CFC9B;border-color:rgba(124,252,155,0.45)}' +
      '#calendar-toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);' +
      'z-index:9999;max-width:90%;padding:10px 18px;border-radius:8px;font-size:13px;' +
      'color:#fff;box-shadow:0 6px 20px rgba(0,0,0,0.3);display:none;text-align:center}' +
      '#calendar-toast.ok{background:#1f7a3d}#calendar-toast.err{background:#a12424}';
    (document.head || document.body).appendChild(s);
  }

  function showToast(msg, ok) {
    if (!toast) return;
    toast.textContent = msg;
    toast.className = ok ? 'ok' : 'err';
    toast.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toast.style.display = 'none'; }, 6000);
  }

  function render(status) {
    statusCache = status;
    if (!btn) return;
    if (status && status.configured === false) { btn.style.display = 'none'; return; }
    btn.style.display = 'block';
    if (status && status.connected) {
      btn.textContent = '📅 Calendar: ' + (status.email || 'connected');
      btn.classList.add('connected');
      btn.title = 'Click to disconnect ' + (status.email || 'your Google Calendar');
    } else {
      btn.textContent = '📅 Connect Google Calendar';
      btn.classList.remove('connected');
      btn.title = 'Connect your Google Calendar';
    }
  }

  function refresh() {
    return fetch('/api/calendar/status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { if (s) render(s); return s; })
      .catch(function () {});
  }

  function onClick() {
    if (statusCache && statusCache.connected) {
      if (!window.confirm('Disconnect ' + (statusCache.email || 'your Google Calendar') + '?')) return;
      fetch('/api/calendar/disconnect', { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function () { showToast('Calendar disconnected.', true); refresh(); })
        .catch(function () { showToast('Could not disconnect. Please try again.', false); });
    } else {
      window.location.href = '/api/calendar/connect';
    }
  }

  var MESSAGES = {
    connected:    ['Google Calendar connected successfully.', true],
    wrongaccount: ['That Google account does not match your portal email. Please connect your own Calendar.', false],
    expired:      ['The connection attempt timed out. Please try again.', false],
    denied:       ['Calendar connection was cancelled.', false],
    noRefresh:    ['Google did not grant lasting access. Please try again and allow access when asked.', false],
    failed:       ['Could not connect Calendar. Please try again.', false]
  };

  function handleReturn() {
    var m = (location.hash || '').match(/calendar=([a-zA-Z]+)/);
    if (!m) return;
    var info = MESSAGES[m[1]];
    if (info) showToast(info[0], info[1]);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }

  // The sidebar (with the Gmail button) may render slightly after load in the
  // SPA. Retry a handful of times until the anchor exists, then inject once.
  function mount() {
    if (btn) return true;
    var gmailBtn = document.getElementById('gmail-connect-btn');
    var container = document.querySelector('.sidebar-bottom');
    if (!gmailBtn && !container) return false;
    btn = document.createElement('button');
    btn.className = 'admin-btn calendar-btn';
    btn.id = 'calendar-connect-btn';
    btn.textContent = '📅 Connect Google Calendar';
    btn.addEventListener('click', onClick);
    if (gmailBtn && gmailBtn.parentNode) {
      gmailBtn.parentNode.insertBefore(btn, gmailBtn.nextSibling);
    } else {
      container.appendChild(btn);
    }
    toast = document.getElementById('calendar-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'calendar-toast';
      document.body.appendChild(toast);
    }
    return true;
  }

  function init() {
    injectStyles();
    if (!mount()) {
      if (tries++ < 20) { setTimeout(init, 500); return; }
      return; // sidebar never appeared (e.g. logged-out view) — nothing to do
    }
    handleReturn();
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
