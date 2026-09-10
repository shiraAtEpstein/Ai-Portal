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

// Apply the user's saved interface language (Settings → Profile). This makes the
// Settings language choice drive the whole portal, and works across devices
// (the choice lives in the database, not just this browser's localStorage).
async function applySavedLanguage() {
  try {
    const res = await fetch('/api/me/settings', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    const lang = data && data.settings && data.settings.profile && data.settings.profile.language;
    if (lang && typeof window.setPortalLang === 'function') window.setPortalLang(lang);
  } catch (e) { /* ignore — keep the local toggle choice */ }
}

(function boot() {
  const loader = document.getElementById('boot-loading');
  const hideLoader = () => { if (loader) loader.style.display = 'none'; };
  const showLogin = () => { hideLoader(); document.getElementById('login-screen').style.display = ''; };
  const enterPortal = async (name, roles) => {
    showPortal(name, roles);
    await loadAgents();
    await applySavedLanguage();
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
    } else if (typeof window.showHome === 'function') {
      // Default landing screen (LAWLY Home Concept, 2026-09-10): the tile
      // grid instead of an empty chat. newChat() is still what "Open Chat"
      // and "New chat" use to get into an actual conversation.
      window.showHome();
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
    .then(d => {
      if (!d) return showLogin();
      // Synopsis is open to admin, tech and paralegal — decided by
      // config/permissions.json, never by a role list written in the front-end.
      //
      // 2026-09-10 (Shira): the drawer no longer duplicates the Home
      // screen's tiles, so there is no sidebar "הפקת סינופסיס" button to
      // create here any more — "Deal Synopsis" on Home (home.js) is the
      // only entry point, and it reads window.__lawlyCaps below for the
      // exact same permission check this file used to gate its own button
      // with. Kept: the capabilities lookup itself (still the one source of
      // truth home.js relies on) and the cleanup of any stray
      // #synopsis-open-btn left over in cached/old markup.
      const caps = d.capabilities;
      window.__lawlyCaps = caps || null;
      const synBtn0 = document.getElementById('synopsis-open-btn');
      if (synBtn0) synBtn0.remove();                       // never trust markup
      if (!caps) {
        console.warn('[synopsis] /api/me returned no "capabilities" field. ' +
          'Deploy routes/me.js (it must call capabilitiesFor) — the Home tile cannot gate correctly.');
      } else if (!('synopsis' in caps)) {
        console.warn('[synopsis] capabilities has no "synopsis" key. ' +
          'Deploy lib/permissions.js — CONNECTIONS must include \'synopsis\'. Got:', Object.keys(caps).join(', '));
      }

      enterPortal(d.name || 'User', (d.roles || []).join(', '));
    })
    .catch(showLogin);
})();
