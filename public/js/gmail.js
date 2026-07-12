// gmail.js — Connect / disconnect Gmail button + toast.
(function () {
  var btn = null, toast = null, statusCache = null;
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
    if (!btn) return;
    if (status && status.configured === false) { btn.style.display = 'none'; return; }
    btn.style.display = 'block';
    if (status && status.connected) {
      btn.textContent = '✅ Gmail: ' + (status.email || 'connected');
      btn.classList.add('connected');
      btn.title = 'Click to disconnect ' + (status.email || 'your Gmail');
    } else {
      btn.textContent = '🔗 Connect Gmail';
      btn.classList.remove('connected');
      btn.title = 'Connect your Gmail to use the Email Assistant';
    }
  }
  function refresh() {
    return fetch('/api/gmail/status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { if (s) render(s); return s; })
      .catch(function () {});
  }
  function onClick() {
    if (statusCache && statusCache.connected) {
      if (!window.confirm('Disconnect ' + (statusCache.email || 'your Gmail') +
          '? The Email Assistant will no longer be able to read your mail until you reconnect.')) return;
      fetch('/api/gmail/disconnect', { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function () { showToast('Gmail disconnected.', true); refresh(); })
        .catch(function () { showToast('Could not disconnect. Please try again.', false); });
    } else {
      window.location.href = '/api/gmail/connect';
    }
  }
  var MESSAGES = {
    connected:    ['Gmail connected successfully.', true],
    wrongaccount: ['That Google account does not match your portal email. Please connect your own Gmail.', false],
    expired:      ['The connection attempt timed out. Please try again.', false],
    denied:       ['Gmail connection was cancelled.', false],
    noRefresh:    ['Google did not grant lasting access. Please try again and allow access when asked.', false],
    failed:       ['Could not connect Gmail. Please try again.', false]
  };
  function handleReturn() {
    var m = (location.hash || '').match(/gmail=([a-zA-Z]+)/);
    if (!m) return;
    var info = MESSAGES[m[1]];
    if (info) showToast(info[0], info[1]);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }
  function init() {
    btn = document.getElementById('gmail-connect-btn');
    toast = document.getElementById('gmail-toast');
    if (btn) btn.addEventListener('click', onClick);
    handleReturn();
    refresh();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
