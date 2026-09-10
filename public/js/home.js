// home.js — the tile-grid home screen ("LAWLY Home Concept", approved by
// Shira 2026-09-10). Renders into the existing #no-agent mount point
// (previously a dead, unreachable "Start a new chat" placeholder — see
// style.css's .home-screen rules) instead of the old chat-first landing.
//
// Deliberately keeps its own small translation table rather than fighting
// i18n.js's data-i18n/EN-capture mechanism: that mechanism snapshots
// English text once at DOMContentLoaded, before this screen's markup
// exists, so a later language switch would have nothing captured to fall
// back to. Instead this file re-renders itself directly whenever the
// language toggle is clicked (see the .lang-btn listener at the bottom).
(function () {
  'use strict';

  var HOME_T = {
    he: {
      sub: 'מה תרצי לעשות?',
      myTasks: { name: 'המשימות שלי', desc: 'כל מה שממתין לך — אימייל, וואטסאפ ועוד, במקום אחד.' },
      daily: { name: 'תדריך יומי', desc: 'סיכום היום שלך: דדליינים, תיקים ומה דחוף.' },
      wa: { name: 'וואטסאפ ללא מענה', desc: 'שיחות לקוחות שמחכות לתשובה.' },
      synopsis: { name: 'סינופסיס עסקה', desc: 'הפקת סינופסיס לעסקה מתוך המסמכים.' },
      review: { name: 'בדיקת הסכם מכר', desc: 'בדיקת חוזה ואיתור נקודות מפתח.' },
      teach: { name: 'למדי את LAWLY', desc: 'לימדו אותה איך אתם אוהבים לעבוד.' },
      chat: { name: 'צ׳אט פתוח', desc: 'שיחה חופשית עם Lawly על כל נושא.' },
      settings: { name: 'חיבורים והגדרות', desc: 'Gmail, וואטסאפ, שפה ועוד.' }
    },
    en: {
      sub: 'What would you like to do?',
      myTasks: { name: 'My Tasks', desc: 'Everything waiting on you — email, WhatsApp and more, in one place.' },
      daily: { name: 'Daily Brief', desc: 'Your day at a glance: deadlines, matters, what’s urgent.' },
      wa: { name: 'Unanswered WhatsApp', desc: 'Client chats still waiting on a reply.' },
      synopsis: { name: 'Deal Synopsis', desc: 'Generate a deal synopsis from the documents.' },
      review: { name: 'Sale Agreement Review', desc: 'Review a contract and flag key points.' },
      teach: { name: 'Teach LAWLY', desc: 'Teach it how you like to work.' },
      chat: { name: 'Open Chat', desc: 'A free-form conversation with Lawly, any topic.' },
      settings: { name: 'Connections & Settings', desc: 'Gmail, WhatsApp, language and more.' }
    }
  };

  function currentLang() {
    var l = 'en';
    try { l = localStorage.getItem('portalLang') || 'en'; } catch (e) {}
    return l === 'he' ? 'he' : 'en';
  }

  function greetingText() {
    var nm = ((document.getElementById('user-name') || {}).textContent || '').trim();
    var first = (nm.split(/[\s,]+/)[0] || '');
    if (/^(loading|—|-)?$/i.test(first) || first.toLowerCase() === 'loading...') first = '';
    var he = currentLang() === 'he';
    var hr = new Date().getHours();
    var part;
    if (he) part = (hr < 5) ? 'ערב טוב' : (hr < 12) ? 'בוקר טוב' : (hr < 18) ? 'צהריים טובים' : 'ערב טוב';
    else part = (hr < 5) ? 'Good evening' : (hr < 12) ? 'Good morning' : (hr < 18) ? 'Good afternoon' : 'Good evening';
    return part + (first ? (he ? ', ' + first : ', ' + first) : '') + (he ? '.' : '.');
  }

  function openChatWith(agentId) {
    if (typeof newChat === 'function') newChat();
    var sel = document.getElementById('agent-select');
    if (sel) sel.value = agentId;
    if (typeof applyAgentChoice === 'function') applyAgentChoice(agentId);
    if (window.AgentPicker) AgentPicker.sync();
  }

  function tileList() {
    var caps = window.__lawlyCaps || null;
    var hasSynopsis = !!(caps && caps.synopsis && caps.synopsis.indexOf('use') !== -1);
    var list = [
      { key: 'myTasks', icon: '🗂', badge: 'mytasks', onClick: function () { location.href = '/mytasks.html'; } },
      { key: 'daily', icon: '☀️', onClick: function () {
          var btn = document.getElementById('daily-open-full');
          if (btn) btn.click();
        } },
      { key: 'wa', icon: '💬', badge: 'whatsapp', onClick: function () { location.href = '/messages.html'; } }
    ];
    if (hasSynopsis) {
      list.push({ key: 'synopsis', icon: '📄', onClick: function () { location.href = '/synopsis.html'; } });
    }
    list.push({ key: 'review', icon: '📝', onClick: function () { openChatWith('document_review'); } });
    list.push({ key: 'teach', icon: '🎓', accent: true, onClick: function () { location.href = '/memories.html'; } });
    list.push({ key: 'chat', icon: '✍️', onClick: function () { if (typeof newChat === 'function') newChat(); } });
    list.push({ key: 'settings', icon: '⚙️', onClick: function () { location.href = '/settings.html'; } });
    return list;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function render() {
    var mount = document.getElementById('no-agent');
    if (!mount) return;
    var lang = currentLang();
    var dict = HOME_T[lang];
    var tiles = tileList();

    var html = '<div class="home-inner">' +
      '<h2 class="home-greet">' + esc(greetingText()) + '</h2>' +
      '<p class="home-sub">' + esc(dict.sub) + '</p>' +
      '<div class="home-tiles">' +
      tiles.map(function (tile, i) {
        var d = dict[tile.key];
        return '<button type="button" class="home-tile' + (tile.accent ? ' is-accent' : '') + '" data-hometile="' + i + '">' +
          (tile.badge ? '<span class="home-tile-badge" data-homebadge="' + tile.badge + '" hidden></span>' : '') +
          '<span class="home-tile-icon">' + tile.icon + '</span>' +
          '<span class="home-tile-name">' + esc(d.name) + '</span>' +
          '<span class="home-tile-desc">' + esc(d.desc) + '</span>' +
          '</button>';
      }).join('') +
      '</div></div>';

    mount.innerHTML = html;
    Array.prototype.forEach.call(mount.querySelectorAll('[data-hometile]'), function (btn) {
      var idx = parseInt(btn.getAttribute('data-hometile'), 10);
      btn.addEventListener('click', function () {
        var tile = tiles[idx];
        if (tile && typeof tile.onClick === 'function') tile.onClick();
      });
    });

    paintBadges();
  }

  // Badges are decorations only, filled in quietly (same philosophy as
  // wa-button.js's own comment: a wrong badge is worse than no badge).
  function paintBadges() {
    // WhatsApp: 2026-09-10 (Shira) — the drawer no longer has its own
    // "Show WhatsApp" button/badge to mirror (removed as a duplicate of
    // this tile), so this fetches the same endpoint wa-button.js used
    // directly. One quiet fetch each time the home screen renders — not a
    // poller, matching the My Tasks badge below.
    var waBadge = document.querySelector('[data-homebadge="whatsapp"]');
    if (waBadge) {
      fetch('/api/me/board?scope=mine', { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var n = Number(d && d.count) || 0;
          if (!waBadge.isConnected) return;
          if (n) { waBadge.textContent = String(n); waBadge.hidden = false; } else { waBadge.hidden = true; }
        })
        .catch(function () {});
    }

    // My Tasks: one quiet fetch each time the home screen renders — not a
    // poller, matches how often someone actually looks at this screen.
    var taskBadge = document.querySelector('[data-homebadge="mytasks"]');
    if (taskBadge) {
      fetch('/api/mytasks', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var n = ((d && d.tasks) || []).filter(function (x) { return x.status === 'open'; }).length;
          if (!taskBadge.isConnected) return;
          if (n) { taskBadge.textContent = String(n); taskBadge.hidden = false; } else { taskBadge.hidden = true; }
        })
        .catch(function () {});
    }
  }

  function showHome() {
    var mount = document.getElementById('no-agent');
    var chatView = document.getElementById('chat-view');
    if (chatView) chatView.style.display = 'none';
    if (mount) { mount.style.display = 'flex'; mount.classList.add('home-screen'); }
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    document.querySelectorAll('#conversation-list .agent-btn.active').forEach(function (b) { b.classList.remove('active'); });
    render();
  }

  window.showHome = showHome;

  // Re-render if the language toggle is used while the home screen is open.
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.lang-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var mount = document.getElementById('no-agent');
        if (mount && mount.style.display !== 'none') render();
      });
    });
  });
})();
