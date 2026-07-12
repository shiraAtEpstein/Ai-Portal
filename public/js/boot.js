// boot.js — startup: restore session, open the right screen. Load LAST.
// Boot: pick the right screen with no flicker, keep you signed in across a
// refresh (via the session cookie), and reopen the agent you had selected.
function restoreAgentFromUrl() {
  const m = (location.hash || '').match(/agent=([^&]+)/);
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
  const btn = document.querySelector('.agent-btn[data-id="' + sel + '"]');
  if (btn) btn.click();
}

(function boot() {
  const loader = document.getElementById('boot-loading');
  const hideLoader = () => { if (loader) loader.style.display = 'none'; };
  const showLogin = () => { hideLoader(); document.getElementById('login-screen').style.display = ''; };
  const enterPortal = async (name, roles) => {
    showPortal(name, roles);
    await loadAgents();
    await loadConversations();
    const hash = location.hash || '';
    const convMatch = hash.match(/c=([^&]+)/);
    if (hash.indexOf('admin') !== -1) {
      newChat();
      const adminBtn = document.getElementById('admin-open-btn');
      if (adminBtn && adminBtn.style.display !== 'none') openAdmin();
    } else if (convMatch) {
      const id = decodeURIComponent(convMatch[1]);
      const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
      const item = document.querySelector('#conversation-list .agent-btn[data-id="' + sel + '"]');
      if (item) { await openConversation(id, item); } else { newChat(); }
    } else {
      newChat();
    }
    hideLoader();
  };

  const params = new URLSearchParams(location.search);
  const authErr = params.get('auth_error');
  if (authErr) {
    history.replaceState(null, '', location.pathname);
    showLogin();
    const error = document.getElementById('login-error');
    if (error) { error.textContent = authErr; error.style.display = 'block'; }
    return;
  }

  if (location.hash && location.hash.indexOf('token=') !== -1) {
    const h = new URLSearchParams(location.hash.slice(1));
    const token = h.get('token');
    if (token) {
      sessionToken = token;
      history.replaceState(null, '', location.pathname);
      enterPortal(h.get('name') || 'User', h.get('roles') || h.get('role') || '');
      return;
    }
  }

  fetch('/api/me')
    .then(res => res.ok ? res.json() : null)
    .then(d => { if (d) enterPortal(d.name || 'User', (d.roles || []).join(', ')); else showLogin(); })
    .catch(showLogin);
})();
