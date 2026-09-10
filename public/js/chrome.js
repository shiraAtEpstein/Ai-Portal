// chrome.js — the portal-wide top chrome: topbar, breadcrumb, and the
// sidebar-as-drawer (2026-09-10, per Shira: the "LAWLY Home Concept"
// top-bar/breadcrumb treatment, applied everywhere, not just the home
// screen). Deliberately touches nothing inside the drawer itself — every
// element still in there (conversation-list, admin-open-btn,
// activity-open-btn, logout-btn, user-name/role/avatar) keeps its original
// id and is still wired by chat.js/auth.js/settings.js exactly as before.
// (2026-09-10, second pass: new-chat-btn and the whatsapp/mytasks/gmail/
// settings quick-nav buttons were removed from the drawer as duplicates of
// Home-screen tiles — see index.html and home.js — this file needed no
// change for that, since it only opens/closes the drawer generically.)
// This file only opens/closes the drawer and keeps the breadcrumb text in
// sync with whichever screen is showing.
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function openDrawer() {
    var drawer = $('side-drawer'), backdrop = $('menu-backdrop'), btn = $('menu-open-btn');
    if (!drawer) return;
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    if (backdrop) backdrop.hidden = false;
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }
  function closeDrawer() {
    var drawer = $('side-drawer'), backdrop = $('menu-backdrop'), btn = $('menu-open-btn');
    if (!drawer) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    if (backdrop) backdrop.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function wireDrawer() {
    var openBtn = $('menu-open-btn'), closeBtn = $('menu-close-btn'), backdrop = $('menu-backdrop'), drawer = $('side-drawer');
    if (openBtn) openBtn.addEventListener('click', openDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (backdrop) backdrop.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
    // Close the drawer automatically once its own contents send you
    // somewhere (new chat, a recent chat, or any of the quick-nav/logout
    // buttons) — a delegated listener, so it needs no changes wherever
    // those buttons' real click handlers are bound.
    if (drawer) {
      drawer.addEventListener('click', function (e) {
        if (e.target.closest('button, .agent-btn')) closeDrawer();
      });
    }
  }

  // Breadcrumb: "Home" alone, or "Home › <current screen>". Watches which
  // of #no-agent / #chat-view / #admin-screen is actually visible rather
  // than hooking into every place that can show one of them.
  function computeBreadcrumb() {
    var sep = $('breadcrumb-sep'), cur = $('breadcrumb-current');
    if (!sep || !cur) return;
    var admin = $('admin-screen');
    var chat = $('chat-view');
    var label = '';
    if (admin && getComputedStyle(admin).display !== 'none') {
      var h1 = admin.querySelector('h1');
      label = h1 ? h1.textContent.trim() : '';
    } else if (chat && getComputedStyle(chat).display !== 'none') {
      var hn = $('header-name');
      label = hn ? hn.textContent.trim() : '';
    }
    if (label) { cur.textContent = label; cur.hidden = false; sep.hidden = false; }
    else { cur.textContent = ''; cur.hidden = true; sep.hidden = true; }
  }

  function wireBreadcrumb() {
    var home = $('breadcrumb-home');
    if (home) {
      home.addEventListener('click', function () {
        closeDrawer();
        if (typeof window.showHome === 'function') window.showHome();
      });
    }
    ['no-agent', 'chat-view', 'admin-screen'].forEach(function (id) {
      var el = $(id);
      if (el && window.MutationObserver) {
        new MutationObserver(computeBreadcrumb).observe(el, { attributes: true, attributeFilter: ['style'] });
      }
    });
    // header-name's text changes (switching agents, opening a saved
    // conversation) without necessarily toggling #chat-view's display.
    var hn = $('header-name');
    if (hn && window.MutationObserver) {
      new MutationObserver(computeBreadcrumb).observe(hn, { childList: true, characterData: true, subtree: true });
    }
    computeBreadcrumb();
  }

  function init() {
    wireDrawer();
    wireBreadcrumb();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
