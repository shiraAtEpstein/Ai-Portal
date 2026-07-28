// auth.js — login, show-portal, logout, Google sign-in.
// ══════════════════════════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════════════════════════
document.getElementById('login-btn').addEventListener('click', login);
document.getElementById('email-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') login();
});
document.getElementById('password-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') login();
});

async function login() {
  const code  = document.getElementById('email-input').value.trim();
  const pass  = document.getElementById('password-input').value;
  const btn   = document.getElementById('login-btn');
  const error = document.getElementById('login-error');

  if (!code || !pass) return;

  btn.disabled    = true;
  btn.textContent = 'Signing in…';
  error.style.display = 'none';

  try {
    const res  = await fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: code, password: pass }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Login failed');

    sessionToken = data.token;
    showPortal(data.name, data.role);
    loadAgents();

  } catch (err) {
    error.textContent    = err.message;
    error.style.display  = 'block';
    btn.disabled         = false;
    btn.textContent      = 'Sign In →';
  }
}

// ══════════════════════════════════════════════════════════
//  SHOW PORTAL
// ══════════════════════════════════════════════════════════
function showPortal(name, role) {
  document.getElementById('login-screen').style.display = 'none';
  document.body.style.alignItems    = 'stretch';
  document.body.style.justifyContent = 'stretch';
  const portal = document.getElementById('portal');
  portal.style.display = 'flex';

  document.getElementById('user-name').textContent   = name;
  document.getElementById('user-role').textContent   = (role || '').split(',').filter(Boolean).join(', ');
  document.getElementById('user-avatar').textContent = name.charAt(0).toUpperCase();


  // Show the "Manage Users" button only if this person is an admin.
  const roleList = (role || '').split(/[,\s]+/).map(r => r.trim().toLowerCase()).filter(Boolean);
  const isAdmin = roleList.includes('admin');
  // Manage Users and Activity Log now live in Settings (People & roles / Activity log).
  document.getElementById('admin-open-btn').style.display = 'none';
  document.getElementById('activity-open-btn').style.display = 'none';
  // Null-safe: the Marketing button may be absent from the DOM (commented out
  // in index.html), so guard before touching its style.
  const marketingBtn = document.getElementById('marketing-open-btn');
  if (marketingBtn) marketingBtn.style.display = isAdmin ? 'block' : 'none';
}

// ══════════════════════════════════════════════════════════
//  LOGOUT
// ══════════════════════════════════════════════════════════
document.getElementById('logout-btn').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST', headers: authHeader() });
  } catch {}
  sessionToken = null;
  window.location.replace('/');
});

// ══ GOOGLE SIGN-IN (Phase 2) ══
document.getElementById('google-login-btn').addEventListener('click', () => {
  window.location.href = '/auth/google/start';
});

// Hide the Google button if the server doesn't have it configured yet.
fetch('/auth/google/status')
  .then(r => r.json())
  .then(d => {
    if (!d.enabled) {
      document.getElementById('google-login-btn').style.display = 'none';
      document.getElementById('google-divider').style.display = 'none';
    }
  })
  .catch(() => {});
