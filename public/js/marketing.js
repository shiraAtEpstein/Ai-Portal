// ============================================================
// marketing.js — injects an admin-only "Marketing" entry into the
// AI Portal sidebar and opens the Marketing Console (/marketing.html)
// in an in-portal overlay. Loaded from index.html with a single
// <script defer src="/marketing.js"></script> so the SPA itself is
// touched only once. Admin-gated via /api/me.
// ============================================================
(function () {
  var OVERLAY_ID = 'mkt-overlay';

  function buildOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    var o = document.createElement('div');
    o.id = OVERLAY_ID;
    o.style.cssText = 'position:fixed;inset:0;z-index:60;background:#f4f6f9;display:none;flex-direction:column';

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;background:#12233b;color:#fff;font:600 14px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    var title = document.createElement('span');
    title.textContent = '📣 Marketing Console';
    var close = document.createElement('button');
    close.textContent = '← Back to portal';
    close.style.cssText = 'background:#1b3350;color:#fff;border:0;padding:7px 13px;border-radius:8px;font-size:13px;cursor:pointer';
    close.onclick = function () { o.style.display = 'none'; };
    bar.appendChild(title);
    bar.appendChild(close);

    var frame = document.createElement('iframe');
    frame.src = '/marketing.html';
    frame.title = 'Marketing Console';
    frame.style.cssText = 'flex:1;width:100%;border:0';

    o.appendChild(bar);
    o.appendChild(frame);
    document.body.appendChild(o);
  }

  function openOverlay() {
    buildOverlay();
    document.getElementById(OVERLAY_ID).style.display = 'flex';
  }

  function addButton() {
    if (document.getElementById('mkt-open-btn')) return true;
    var anchor = document.getElementById('activity-open-btn') || document.getElementById('admin-open-btn');
    if (!anchor || !anchor.parentNode) return false;
    var b = document.createElement('button');
    b.id = 'mkt-open-btn';
    b.className = anchor.className;         // reuse the sidebar's .admin-btn styling
    b.textContent = '📣 Marketing';
    b.style.display = 'block';              // we only reach here for admins
    b.onclick = openOverlay;
    anchor.parentNode.insertBefore(b, anchor);
    return true;
  }

  function checkAdmin(cb) {
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return cb(false);
        var roles = d.roles || d.role || [];
        if (typeof roles === 'string') roles = roles.split(/[,\s]+/);
        var norm = (roles || []).map(function (x) { return String(x).trim().toLowerCase(); });
        cb(norm.indexOf('admin') >= 0);
      })
      .catch(function () { cb(false); });
  }

  function start() {
    checkAdmin(function (admin) {
      if (!admin) return;
      // The sidebar may render after login; poll briefly until the anchor exists.
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        if (addButton() || tries > 60) clearInterval(iv);
      }, 500);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
