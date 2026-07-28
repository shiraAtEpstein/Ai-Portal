// settings.js — admin: manage users, invites, activity log, marketing.
// ══════════════════
//  ADMIN — MANAGE USERS (Day 7)
// ══════════════════
let adminRoles = [];   // role names this admin may assign (from the server)


// ── Multi-select dropdown (a button that opens a list of checkboxes) ──
function buildDropdown(container, selected) {
  const sel = new Set(selected || []);
  const opts = adminRoles.map(r =>
    `<label class="dropdown-opt"><input type="checkbox" value="${esc(r)}" ${sel.has(r) ? 'checked' : ''}> ${esc(r)}</label>`
  ).join('');
  container.classList.add('dropdown');
  container.innerHTML =
    '<button type="button" class="dropdown-toggle"><span class="dropdown-toggle-text"></span></button>' +
    '<div class="dropdown-menu">' + opts + '</div>';
  container.querySelector('.dropdown-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = container.classList.contains('open');
    closeAllDropdowns();
    if (!wasOpen) container.classList.add('open');
  });
  container.querySelectorAll('.dropdown-menu input').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => updateDropdownText(container));
  });
  updateDropdownText(container);
}

function updateDropdownText(container) {
  const chosen = Array.from(container.querySelectorAll('input:checked')).map(cb => cb.value);
  const txt = container.querySelector('.dropdown-toggle-text');
  if (chosen.length) { txt.textContent = chosen.join(', '); txt.classList.remove('placeholder'); }
  else { txt.textContent = 'Select roles…'; txt.classList.add('placeholder'); }
}

function dropdownValues(container) {
  return Array.from(container.querySelectorAll('input:checked')).map(cb => cb.value);
}

function closeAllDropdowns() {
  document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
}
document.addEventListener('click', closeAllDropdowns);

// ── Open / close the admin screen and the invite popup ──
document.getElementById('admin-open-btn').addEventListener('click', openAdmin);
document.getElementById('admin-close-btn').addEventListener('click', () => {
  document.getElementById('admin-screen').style.display = 'none';
  try { history.replaceState(null, '', conversationId ? '#c=' + encodeURIComponent(conversationId) : location.pathname); } catch (e) {}
});
document.getElementById('open-invite-btn').addEventListener('click', openInviteModal);
document.getElementById('invite-modal-close').addEventListener('click', closeInviteModal);
document.getElementById('invite-modal').addEventListener('click', (e) => {
  if (e.target.id === 'invite-modal') closeInviteModal();
});
document.getElementById('invite-btn').addEventListener('click', sendInvite);
document.getElementById('activity-open-btn').addEventListener('click', openAudit);
document.getElementById('audit-close-btn').addEventListener('click', closeAudit);
document.getElementById('audit-refresh-btn').addEventListener('click', loadAudit);
document.getElementById('audit-q').addEventListener('input', renderAudit);
document.getElementById('audit-action').addEventListener('change', renderAudit);
document.getElementById('audit-from').addEventListener('change', renderAudit);
document.getElementById('audit-to').addEventListener('change', renderAudit);
document.getElementById('audit-export').addEventListener('click', exportAudit);
document.getElementById('audit-clear').addEventListener('click', function () {
  document.getElementById('audit-q').value = '';
  document.getElementById('audit-action').value = '';
  document.getElementById('audit-from').value = '';
  document.getElementById('audit-to').value = '';
  renderAudit();
});

function openAdmin() {
  document.getElementById('admin-screen').style.display = 'block';
  try { history.replaceState(null, '', '#admin'); } catch (e) {}
  loadAdminUsers();
}

// ==============================================================
//  MARKETING (admins only) - read-only dashboard
// ==============================================================
// Null-safe: these marketing controls may be absent from the DOM (e.g. the
// Marketing button is commented out in index.html). Optional chaining keeps a
// missing element from throwing and halting the rest of this boot script.
document.getElementById('marketing-open-btn')?.addEventListener('click', openMarketing);
document.getElementById('marketing-close-btn')?.addEventListener('click', closeMarketing);
document.getElementById('marketing-refresh-btn')?.addEventListener('click', loadMarketing);

function openMarketing() {
  document.getElementById('marketing-screen').style.display = 'block';
  try { history.replaceState(null, '', '#marketing'); } catch (e) {}
  loadMarketing();
}
function closeMarketing() {
  document.getElementById('marketing-screen').style.display = 'none';
  try { history.replaceState(null, '', conversationId ? '#c=' + encodeURIComponent(conversationId) : location.pathname); } catch (e) {}
}

function mkBadge(status) {
  var colors = {
    draft:    ['#eef1f5', '#5b6b7d'],
    review:   ['#fbf1dc', '#b07d18'],
    approved: ['#e4f3ea', '#1c7a42'],
    scheduled:['#e6edf6', '#3a5da8'],
    published:['#eae7f4', '#6b52a8']
  };
  var c = colors[status] || colors.draft;
  return '<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;background:' + c[0] + ';color:' + c[1] + ';">' + esc(status) + '</span>';
}

async function loadMarketing() {
  var note = document.getElementById('marketing-note');
  var body = document.getElementById('marketing-body');
  note.className = 'admin-note';
  note.textContent = '';
  body.innerHTML = '<p style="color:var(--gray-400);">Loading…</p>';
  try {
    var res = await fetch('/api/marketing', { headers: authHeader() });
    if (res.status === 401) return handleSessionExpired();
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load the marketing data.');
    renderMarketing(data);
  } catch (e) {
    body.innerHTML = '';
    note.className = 'admin-note error';
    note.textContent = e.message || 'Could not load the marketing data.';
  }
}

function renderMarketing(d) {
  var body = document.getElementById('marketing-body');
  var td = d.themeDecision || {};
  var plan = d.plan || {};
  var a = d.analytics || {};
  var h = '';

  h += '<div class="admin-card">';
  h += '<h2>Monthly plan · ' + esc(plan.month || td.month || '') + '</h2>';
  if (td.status === 'chosen' && td.chosen) {
    var ch = (td.options || []).find(function (o) { return o.id === td.chosen; }) || {};
    h += '<p style="margin-bottom:14px;">Theme: <strong>' + esc(ch.name || '') + '</strong></p>';
  } else {
    h += '<p style="margin-bottom:12px;color:var(--gray-600);">Theme: awaiting Yaacov’s choice. Options:</p>';
    (td.options || []).forEach(function (o) {
      h += '<div style="border:1px solid var(--gray-200);border-radius:9px;padding:12px 14px;margin-bottom:10px;">'
        + '<div style="font-weight:600;color:var(--navy);">' + esc(o.name) + '</div>'
        + '<div style="font-size:13px;color:var(--gray-600);margin-top:3px;">' + esc(o.focus) + '</div>'
        + '<div style="font-size:12.5px;margin-top:5px;"><strong>Who:</strong> ' + esc(o.audience) + '</div>'
        + '<div style="font-size:12.5px;"><strong>Why it fits:</strong> ' + esc(o.why) + '</div>'
        + '</div>';
    });
  }
  if ((plan.campaigns || []).length) {
    h += '<h2 style="margin-top:18px;">Campaigns</h2><table class="admin-table"><thead><tr><th>Campaign</th><th>Weeks</th><th>Audience</th><th>In plain terms</th></tr></thead><tbody>';
    plan.campaigns.forEach(function (c) {
      h += '<tr><td><strong>' + esc(c.name) + '</strong></td><td>' + esc(c.weeks) + '</td><td>' + esc(c.audience) + '</td><td style="color:var(--gray-600);">' + esc(c.plain) + '</td></tr>';
    });
    h += '</tbody></table>';
  }
  if ((plan.weeks || []).length) {
    h += '<h2 style="margin-top:18px;">Weekly focus</h2><div style="display:flex;flex-wrap:wrap;gap:12px;">';
    plan.weeks.forEach(function (w) {
      h += '<div style="flex:1;min-width:160px;border:1px solid var(--gray-200);border-radius:9px;padding:10px 12px;"><strong>' + esc(w.label) + '</strong><div style="font-size:12.5px;color:var(--gray-600);margin-top:3px;">' + esc(w.focus) + '</div></div>';
    });
    h += '</div>';
  }
  h += '</div>';

  if ((d.content || []).length) {
    h += '<div class="admin-card"><h2>Content</h2><table class="admin-table"><thead><tr><th>Title</th><th>Channel</th><th>Date</th><th>Status</th></tr></thead><tbody>';
    d.content.forEach(function (c, i) {
      h += '<tr class="mk-row" data-mk="' + i + '" style="cursor:pointer;"><td><strong>' + esc(c.title) + '</strong></td><td>' + esc(c.channel) + '</td><td>' + esc(c.date) + '</td><td>' + mkBadge(c.status) + '</td></tr>';
      h += '<tr id="mk-detail-' + i + '" style="display:none;"><td colspan="4" style="background:var(--gray-50);">'
        + '<div style="white-space:pre-wrap;font-size:13px;line-height:1.5;">' + esc(c.body) + '</div>'
        + '<div style="font-size:12.5px;margin-top:8px;"><strong>CTA:</strong> ' + esc(c.cta) + '</div>'
        + (c.note ? '<div style="font-size:12px;color:#b07d18;margin-top:6px;">⚠ ' + esc(c.note) + '</div>' : '')
        + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }

  if ((a.kpis || []).length) {
    h += '<div class="admin-card"><h2>Analytics · ' + esc(a.period || '') + '</h2>';
    h += '<p style="font-size:12px;color:var(--gray-600);margin-bottom:12px;">Reputation-first, since our leads come from referrals.</p>';
    h += '<div style="display:flex;flex-wrap:wrap;gap:14px;">';
    a.kpis.forEach(function (k) {
      h += '<div style="flex:1;min-width:150px;border:1px solid var(--gray-200);border-radius:10px;padding:14px;">'
        + '<div style="font-size:12px;color:var(--gray-600);">' + (k.star ? '★ ' : '') + esc(k.label) + '</div>'
        + '<div style="font-size:24px;font-weight:700;color:' + (k.star ? '#b07d18' : 'var(--navy)') + ';margin-top:2px;">' + esc(k.value) + '</div>'
        + '<div style="font-size:11px;color:var(--gray-600);margin-top:4px;">' + esc(k.sub || '') + '</div>'
        + '</div>';
    });
    h += '</div>';
    if ((a.reviewsRecent || []).length) {
      h += '<div style="margin-top:16px;">';
      a.reviewsRecent.forEach(function (r) { h += '<div style="font-size:13px;padding:7px 0;border-bottom:1px solid var(--gray-100);">⭐ “' + esc(r) + '”</div>'; });
      h += '</div>';
    }
    if (a.note) h += '<p style="font-size:12px;color:var(--gray-400);margin-top:12px;">' + esc(a.note) + '</p>';
    h += '</div>';
  }

  body.innerHTML = h;
  body.querySelectorAll('.mk-row').forEach(function (row) {
    row.addEventListener('click', function () {
      var i = row.getAttribute('data-mk');
      var det = document.getElementById('mk-detail-' + i);
      if (det) det.style.display = (det.style.display === 'none') ? 'table-row' : 'none';
    });
  });
}

// ── History / audit log (Day 9) ──
const AUDIT_LABELS = {
  'agent.used': 'Used an agent',
  'chat.deleted': 'Deleted a chat',
  'user.invite_resent': 'Resent an invite',
  'auth.login': 'Signed in',
  'auth.login.denied': 'Sign-in denied',
  'auth.login.pending': 'Sign-in (pending invite)',
  'user.invited': 'Invited a user',
  'user.roles_changed': 'Changed roles',
  'user.disabled': 'Disabled a user',
  'user.enabled': 'Enabled a user',
  'user.deleted': 'Deleted a user',
};

function openAudit() {
  document.getElementById('audit-screen').style.display = 'block';
  loadAudit();
}
function closeAudit() {
  document.getElementById('audit-screen').style.display = 'none';
}
function fmtWhen(ts) {
  try { return new Date(ts).toLocaleString(); } catch (e) { return esc(ts); }
}
function fmtDetails(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  for (const k of Object.keys(meta)) {
    if (k === 'actor' || k === 'target') continue;
    let v = meta[k];
    if (Array.isArray(v)) v = v.join(', ');
    else if (v && typeof v === 'object') v = JSON.stringify(v);
    parts.push(esc(k) + ': ' + esc(v));
  }
  return parts.join(' · ');
}

let auditEvents = [];

async function loadAudit() {
  const tbody = document.getElementById('audit-tbody');
  const note = document.getElementById('audit-note');
  note.className = 'admin-note';
  tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400);">Loading…</td></tr>';
  try {
    const res = await fetch('/api/admin/audit?limit=500', { headers: authHeader() });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load the history.');
    auditEvents = data.events || [];
    const sel = document.getElementById('audit-action');
    const cur = sel.value;
    const present = Array.from(new Set(auditEvents.map(function (e) { return e.action; })));
    sel.innerHTML = '<option value="">All actions</option>' + present.map(function (a) {
      return '<option value="' + esc(a) + '">' + esc(AUDIT_LABELS[a] || a) + '</option>';
    }).join('');
    sel.value = cur;
    renderAudit();
  } catch (err) {
    tbody.innerHTML = '';
    note.textContent = err.message;
    note.className = 'admin-note err';
  }
}

function filteredAudit() {
  const q = (document.getElementById('audit-q').value || '').trim().toLowerCase();
  const act = document.getElementById('audit-action').value || '';
  const from = document.getElementById('audit-from').value || '';
  const to = document.getElementById('audit-to').value || '';
  const fromT = from ? new Date(from + 'T00:00:00').getTime() : null;
  const toT = to ? new Date(to + 'T23:59:59').getTime() : null;
  return auditEvents.filter(function (e) {
    if (act && e.action !== act) return false;
    const t = new Date(e.ts).getTime();
    if (fromT && t < fromT) return false;
    if (toT && t > toT) return false;
    if (q) {
      const hay = ((e.actorName || '') + ' ' + (e.target || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
}

function renderAudit() {
  const tbody = document.getElementById('audit-tbody');
  const rows = filteredAudit();
  document.getElementById('audit-count').textContent = rows.length + ' event' + (rows.length === 1 ? '' : 's');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400);">No matching events.</td></tr>'; return; }
  tbody.innerHTML = rows.map(function (e) {
    const who = e.actorName ? esc(e.actorName) : '<span style="color:var(--gray-400)">system</span>';
    const action = esc(AUDIT_LABELS[e.action] || e.action);
    return '<tr>' +
      '<td style="white-space:nowrap;">' + fmtWhen(e.ts) + '</td>' +
      '<td>' + who + '</td>' +
      '<td>' + action + '</td>' +
      '<td>' + (e.target ? esc(e.target) : '') + '</td>' +
      '<td style="color:var(--gray-600);">' + fmtDetails(e.metadata) + '</td>' +
      '</tr>';
  }).join('');
}

function fmtDetailsPlain(meta) {
  if (!meta || typeof meta !== 'object') return '';
  return Object.keys(meta).filter(function (k) { return k !== 'actor' && k !== 'target'; }).map(function (k) {
    let v = meta[k];
    if (Array.isArray(v)) v = v.join(', ');
    else if (v && typeof v === 'object') v = JSON.stringify(v);
    return k + ': ' + v;
  }).join(' | ');
}

function exportAudit() {
  const rows = filteredAudit();
  const head = ['When', 'Who', 'Action', 'On', 'Details'];
  const cell = function (s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; };
  const lines = [head.map(cell).join(',')];
  rows.forEach(function (e) {
    lines.push([fmtWhen(e.ts), e.actorName || 'system', (AUDIT_LABELS[e.action] || e.action), e.target || '', fmtDetailsPlain(e.metadata)].map(cell).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'epstein-portal-audit.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function openInviteModal() {
  document.getElementById('invite-email').value = '';
  document.getElementById('invite-name').value = '';
  document.getElementById('invite-note').className = 'admin-note';
  renderInviteRoles();
  document.getElementById('invite-modal').classList.add('open');
}

function closeInviteModal() {
  document.getElementById('invite-modal').classList.remove('open');
}

async function loadAdminUsers() {
  const tbody = document.getElementById('users-tbody');
  const note  = document.getElementById('users-note');
  note.className = 'admin-note';
  tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400);">Loading…</td></tr>';
  try {
    const res  = await fetch('/api/admin/all-users', { headers: authHeader() });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load users.');
    adminRoles = data.roles || [];
    renderUsersTable(data.users || []);
  } catch (err) {
    tbody.innerHTML = '';
    note.textContent = err.message;
    note.className = 'admin-note err';
  }
}

// Roles dropdown inside the invite popup.
function renderInviteRoles() {
  buildDropdown(document.getElementById('invite-roles'), []);
}

function renderUsersTable(users) {
  const tbody = document.getElementById('users-tbody');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400);">No users yet.</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => {
    const rolesText = (u.roles && u.roles.length) ? u.roles.map(esc).join(', ') : '<span style="color:var(--gray-400)">none</span>';
    const toggle = (u.status === 'disabled')
      ? `<button class="row-btn go" data-act="enable" data-email="${esc(u.email)}">Enable</button>`
      : `<button class="row-btn danger" data-act="disable" data-email="${esc(u.email)}">Disable</button>`;
    return `
      <tr>
        <td>${esc(u.name) || '<span style="color:var(--gray-400)">—</span>'}</td>
        <td>${esc(u.email)}</td>
        <td><span class="status-badge status-${esc(u.status)}">${esc(u.status)}</span></td>
        <td>
          <div>${rolesText}</div>
          <div class="role-editor" data-email="${esc(u.email)}">
            <div class="dropdown" data-roledd="${esc(u.email)}" style="margin-top:8px;"></div>
            <button class="row-btn go" data-act="save-roles" data-email="${esc(u.email)}" style="margin-top:8px;">Save roles</button>
            <button class="row-btn" data-act="cancel-roles" data-email="${esc(u.email)}" style="margin-top:8px;">Cancel</button>
          </div>
        </td>
        <td>
          ${u.status === 'pending' ? '<button class="row-btn" data-act="resend" data-email="' + esc(u.email) + '">Resend</button>' : ''}
          <button class="row-btn" data-act="edit" data-email="${esc(u.email)}">Edit roles</button>
          ${toggle}
          <button class="row-btn danger" data-act="delete" data-email="${esc(u.email)}" title="Delete user" aria-label="Delete user" style="padding:6px 10px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg></button>
        </td>
      </tr>`;
  }).join('');

  // Build a roles dropdown for each row, pre-selected to that user's roles.
  users.forEach(u => {
    const dd = tbody.querySelector('.dropdown[data-roledd="' + CSS.escape(u.email) + '"]');
    if (dd) buildDropdown(dd, u.roles || []);
  });

  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); onRowAction(btn); });
  });
}

function onRowAction(btn) {
  const act = btn.dataset.act;
  const email = btn.dataset.email;
  const editor = document.querySelector('.role-editor[data-email="' + CSS.escape(email) + '"]');
  if (act === 'edit')              { editor.classList.add('open'); }
  else if (act === 'cancel-roles') { editor.classList.remove('open'); }
  else if (act === 'save-roles')   { saveRoles(email, editor); }
  else if (act === 'disable')      { if (confirm('Disable ' + email + '? They will be signed out immediately.')) setStatus(email, 'disable'); }
  else if (act === 'enable')       { setStatus(email, 'enable'); }
  else if (act === 'resend')       { resendInvite(email); }
  else if (act === 'delete')       { deleteUser(email); }
}

async function saveRoles(email, editor) {
  const dd = editor.querySelector('.dropdown[data-roledd]');
  const roles = dropdownValues(dd);
  try {
    const res  = await fetch('/api/admin/set-roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ email, roles }),
    });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not change roles.');
    flash('users-note', 'Roles updated for ' + email + '.', true);
    loadAdminUsers();
  } catch (err) {
    flash('users-note', err.message, false);
  }
}

async function setStatus(email, action) {
  try {
    const res  = await fetch('/api/admin/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ email }),
    });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Action failed.');
    flash('users-note', email + ' is now ' + (action === 'disable' ? 'disabled' : 'active') + '.', true);
    loadAdminUsers();
  } catch (err) {
    flash('users-note', err.message, false);
  }
}

async function deleteUser(email) {
  if (!confirm('Permanently DELETE ' + email + ' from the database? This removes the account entirely and cannot be undone.')) return;
  try {
    const res = await fetch('/api/admin/delete-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ email }),
    });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete the user.');
    flash('users-note', email + ' was permanently deleted.', true);
    loadAdminUsers();
  } catch (err) {
    flash('users-note', err.message, false);
  }
}

async function resendInvite(email) {
  try {
    const res = await fetch('/api/admin/resend-invite', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ email }) });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not resend the invite.');
    let msg = 'Invite resent to ' + esc(email) + '. ';
    msg += data.emailed ? 'A new invitation email was sent.' : 'Email is off, so share this new link:<br><strong>' + esc(data.inviteLink) + '</strong>';
    flash('users-note', msg, true, true);
    loadAdminUsers();
  } catch (err) {
    flash('users-note', err.message, false);
  }
}

async function sendInvite() {
  const email = document.getElementById('invite-email').value.trim();
  const name  = document.getElementById('invite-name').value.trim();
  const roles = dropdownValues(document.getElementById('invite-roles'));
  const btn   = document.getElementById('invite-btn');
  if (!email) return flash('invite-note', 'Please enter an email address.', false);
  if (!name) return flash('invite-note', 'Please enter a name.', false);

  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res  = await fetch('/api/admin/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ email, name, roles }),
    });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not send the invite.');
    let msg = 'Invited ' + esc(email) + (roles.length ? ' as ' + esc(roles.join(', ')) : '') + '. ';
    msg += data.emailed ? 'An invitation email was sent. ' : 'Email was not sent (' + esc(data.emailError || 'unknown') + '). ';
    msg += 'Invite link (share this if needed):<br><strong>' + esc(data.inviteLink) + '</strong>';
    flash('invite-note', msg, true, true);
    loadAdminUsers();
  } catch (err) {
    flash('invite-note', err.message, false);
  } finally {
    btn.disabled = false; btn.textContent = 'Send invite';
  }
}

// Show a small success/error note. allowHtml only for trusted, pre-escaped text.
function flash(id, text, ok, allowHtml) {
  const el = document.getElementById(id);
  if (allowHtml) el.innerHTML = text; else el.textContent = text;
  el.className = 'admin-note ' + (ok ? 'ok' : 'err');
}
