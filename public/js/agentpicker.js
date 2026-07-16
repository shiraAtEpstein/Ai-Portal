// agentpicker.js — custom agent dropdown that renders SVG icons.
//
// The native <select id="agent-select"> stays in the DOM as the source of
// truth (i18n.js, chat.js and the existing change handler all rely on it) but
// is visually hidden. This module decorates it with a styled button + popup
// list so each agent can show its Lawly SVG icon — something a native <option>
// cannot do. Selecting a row mirrors the choice back to the native select and
// dispatches a 'change' event, so all existing logic keeps working untouched.

(function () {
  var select, wrap, btn, btnIco, btnLabel, menu;
  var rows = [];
  var open = false;
  var activeIdx = -1;
  var rebuildScheduled = false;

  function labelFor(opt) {
    if (!opt) return '';
    var t = opt.textContent || '';
    // Options are "<emoji>  <name>"; strip any leading non-letter glyphs.
    try { t = t.replace(/^[^\p{L}\p{N}]+/u, ''); } catch (e) { t = t.replace(/^[^A-Za-z0-9֐-׿]*\s*/, ''); }
    return t.trim() || (opt.textContent || '').trim();
  }

  function placeholderText() {
    var ph = select.querySelector('option[value=""]');
    return ph ? (ph.textContent || 'Choose agent…').trim() : 'Choose agent…';
  }

  function iconSvg(id) {
    return (typeof agentSvg === 'function') ? agentSvg(id) : '';
  }

  // Rebuild the popup rows from the native select's options.
  function buildMenu() {
    menu.innerHTML = '';
    rows = [];
    Array.prototype.forEach.call(select.options, function (opt) {
      if (!opt.value) return;
      var li = document.createElement('li');
      li.className = 'agent-opt';
      li.setAttribute('role', 'option');
      li.dataset.id = opt.value;
      li.innerHTML =
        '<span class="agent-opt-ico">' + iconSvg(opt.value) + '</span>' +
        '<span class="agent-opt-label">' + (window.esc ? esc(labelFor(opt)) : labelFor(opt)) + '</span>';
      li.addEventListener('click', function () { choose(opt.value); });
      li.addEventListener('mousemove', function () { setActive(rows.indexOf(li)); });
      menu.appendChild(li);
      rows.push(li);
    });
    refreshButton();
  }

  // Reflect the native select's current value + disabled state on the button.
  function refreshButton() {
    if (!btn) return;
    var val = select.value;
    var opt = val ? select.querySelector('option[value="' + (window.CSS && CSS.escape ? CSS.escape(val) : val) + '"]') : null;
    if (val && opt) {
      btnIco.innerHTML = iconSvg(val);
      btnIco.style.display = '';
      btnLabel.textContent = labelFor(opt);
      btn.classList.remove('is-placeholder');
    } else {
      btnIco.innerHTML = '';
      btnIco.style.display = 'none';
      btnLabel.textContent = placeholderText();
      btn.classList.add('is-placeholder');
    }
    var dis = !!select.disabled;
    btn.disabled = dis;
    btn.classList.toggle('is-disabled', dis);
    if (dis && open) closeMenu();
    rows.forEach(function (li) {
      var sel = li.dataset.id === val;
      li.classList.toggle('active', sel);
      li.setAttribute('aria-selected', sel ? 'true' : 'false');
    });
  }

  function choose(id) {
    if (select.value === id) { closeMenu(); btn.focus(); return; }
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    refreshButton();
    closeMenu();
    btn.focus();
  }

  function setActive(i) {
    if (i < 0 || i >= rows.length) return;
    if (activeIdx >= 0 && rows[activeIdx]) rows[activeIdx].classList.remove('hl');
    activeIdx = i;
    rows[activeIdx].classList.add('hl');
    rows[activeIdx].scrollIntoView({ block: 'nearest' });
  }

  function openMenu() {
    if (open || select.disabled || !rows.length) return;
    open = true;
    menu.hidden = false;
    wrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    var cur = rows.findIndex(function (li) { return li.dataset.id === select.value; });
    activeIdx = -1;
    setActive(cur >= 0 ? cur : 0);
    document.addEventListener('mousedown', onDocDown, true);
  }

  function closeMenu() {
    if (!open) return;
    open = false;
    menu.hidden = true;
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    if (activeIdx >= 0 && rows[activeIdx]) rows[activeIdx].classList.remove('hl');
    activeIdx = -1;
    document.removeEventListener('mousedown', onDocDown, true);
  }

  function onDocDown(e) {
    if (!wrap.contains(e.target)) closeMenu();
  }

  function onKey(e) {
    var k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'Enter' || k === ' ' || k === 'Spacebar') {
        e.preventDefault(); openMenu();
      }
      return;
    }
    if (k === 'Escape') { e.preventDefault(); closeMenu(); btn.focus(); }
    else if (k === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, rows.length - 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
    else if (k === 'Home') { e.preventDefault(); setActive(0); }
    else if (k === 'End') { e.preventDefault(); setActive(rows.length - 1); }
    else if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      if (activeIdx >= 0 && rows[activeIdx]) choose(rows[activeIdx].dataset.id);
    } else if (k === 'Tab') {
      closeMenu();
    }
  }

  function scheduleRebuild() {
    if (rebuildScheduled) return;
    rebuildScheduled = true;
    (window.requestAnimationFrame || window.setTimeout)(function () {
      rebuildScheduled = false;
      buildMenu();
    }, 0);
  }

  function init() {
    select = document.getElementById('agent-select');
    if (!select || select.dataset.picker === '1') return;
    select.dataset.picker = '1';

    // Build the decorating DOM around the (now hidden) native select.
    wrap = document.createElement('div');
    wrap.className = 'agent-picker';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('agent-select-native');

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agent-pill-btn is-placeholder';
    btn.id = 'agent-pill-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Choose an agent');
    btn.innerHTML =
      '<span class="agent-pill-ico" id="agent-pill-ico" aria-hidden="true"></span>' +
      '<span class="agent-pill-label" id="agent-pill-label"></span>' +
      '<svg class="agent-pill-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" ' +
        'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M6 9l6 6 6-6"/></svg>';
    wrap.appendChild(btn);

    menu = document.createElement('ul');
    menu.className = 'agent-menu';
    menu.id = 'agent-menu';
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;
    menu.hidden = true;
    wrap.appendChild(menu);

    btnIco = btn.querySelector('#agent-pill-ico');
    btnLabel = btn.querySelector('#agent-pill-label');

    btn.addEventListener('click', function () { open ? closeMenu() : openMenu(); });
    wrap.addEventListener('keydown', onKey);
    // Keep the button in sync with programmatic changes to the native select.
    select.addEventListener('change', refreshButton);
    new MutationObserver(scheduleRebuild).observe(select, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled']
    });

    buildMenu();
  }

  // Public: force a resync (called after code sets select.value/.disabled directly).
  window.AgentPicker = { sync: function () { if (select) { scheduleRebuild(); refreshButton(); } } };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
