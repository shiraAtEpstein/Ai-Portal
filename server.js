// ============================================================
// AI PORTAL - Secure Gateway Server (entry point / wiring)
// Day 5: slimmed down. Auth, chat, and admin live in routes/;
// session and permission logic live in lib/.
// ============================================================
require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const { createDbSession } = require('./lib/sessions');
const { agentsConfig } = require('./lib/access');
const createGoogleAuthRouter = require('./google-auth');
const createAuthRouter = require('./routes/auth');
const createChatRouter = require('./routes/chat');
const createGmailRouter = require('./routes/gmail');
const createCalendarRouter = require('./routes/calendar');
const createDropboxRouter = require('./routes/dropbox');
const createAdminRouter = require('./routes/admin');
const createMemoryAdminRouter = require('./routes/memory-admin');
const createMeRouter = require('./routes/me');
const createAccountRouter = require('./routes/account');
const createFirmRulesRouter = require('./routes/firm-rules');
const createMarketingRouter = require('./routes/marketing');
const createDailyRouter = require('./routes/daily');
const createWhatsappGroupsRouter = require('./routes/whatsapp-groups');
const createUnansweredRouter = require('./routes/unanswered');
const createStaffResponseRouter = require('./routes/staff-response');
const whatsappGroups = require('./whatsapp/groups/bootstrap');
const unansweredScheduler = require('./lib/scheduler');

// Dropbox-backed agents: load framework .md files from the connected Dropbox
// folder at boot and on a timer (roles stay in config/agents.json). Falls back
// to the bundled agents if Dropbox is down or not yet connected.
const agentRegistry = require('./lib/agents');
const dropbox = require('./lib/dropbox');

const app = express();
const whatsappWebhook = require('./whatsapp/webhook');
app.use('/whatsapp', whatsappWebhook); 
app.use(express.json());

// Serve the SPA shell with the Marketing Console loader injected. The loader
// (public/marketing.js) is admin-gated client-side. Read once at startup; if
// anything fails we fall through to normal static serving (original behavior).
let INDEX_HTML = null;
try {
  INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    .replace('</body>', '  <script defer src="/marketing.js"></script>\n</body>');
} catch (e) {
  console.error('[BOOT] could not preload index.html for injection:', e.message);
}
app.get(['/', '/index.html'], (req, res, next) => {
  if (!INDEX_HTML) return next();
  res.type('html').send(INDEX_HTML);
});

app.use(express.static(path.join(__dirname, 'public')));

// --- users.json staff file helpers ---
function loadUsers() {
  return JSON.parse(fs.readFileSync('./config/users.json', 'utf8'));
}
function saveUsers(config) {
  fs.writeFileSync('./config/users.json', JSON.stringify(config, null, 2), 'utf8');
}
function findUserByEmail(email) {
  if (!email) return null;
  const usersConfig = loadUsers();
  return usersConfig.users.find(
    u => u.email && u.email.toLowerCase() === String(email).trim().toLowerCase()
  ) || null;
}

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT || '587'),
  secure: process.env.EMAIL_SECURE === 'true',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// --- Routes ---
// Google sign-in creates DATABASE sessions.
app.use(createGoogleAuthRouter({ createSession: createDbSession, findUserByEmail }));
app.use(createAuthRouter({ loadUsers, saveUsers, transporter }));
app.use(createChatRouter());
app.use(createGmailRouter());
app.use(createCalendarRouter());
  app.use(createDropboxRouter());
app.use(createAdminRouter({ loadUsers }));
app.use(createMemoryAdminRouter());
app.use(createMeRouter());
app.use(createAccountRouter());
// Phase 2: pass the mail transporter so a firm-rule proposal can email opted-in admins.
app.use(createFirmRulesRouter({ transporter }));
app.use(createMarketingRouter());
// 'Today' panel: per-user daily task completions (server-side persistence).
app.use(createDailyRouter());
app.use(createWhatsappGroupsRouter());
// Unanswered client chats — deterministic detection + digest (WhatsApp).
app.use(createUnansweredRouter());
// Staff response-time dashboard (Yaacov) — /api/admin/staff-response.
app.use(createStaffResponseRouter());
// Health check — also reports whether the database is reachable.
app.get('/healthz', async (req, res) => {
  let database = false;
  try { database = await db.ping(); } catch (e) { database = false; }
  res.json({ ok: true, database });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  let userCount = 0;
  try { userCount = loadUsers().users.length; } catch (e) { /* ignore */ }
  console.log('\n AI Portal running on http://localhost:' + PORT);
  console.log(' Loaded ' + userCount + ' users (file)');
  console.log(' Loaded ' + Object.keys(agentsConfig.agents).length + ' agents\n');
});


// --- Keep agents fresh from Dropbox -------------------------------------------
async function refreshAgents(reason) {
  const r = await agentRegistry.refreshFromDropbox();
  if (r.ok) {
    console.log('[AGENTS] loaded ' + r.count + ' agent file(s) from Dropbox (' + reason + ')');
  } else {
    console.warn('[AGENTS] using bundled agents — Dropbox skipped: ' + r.reason + ' (' + reason + ')');
  }
}
refreshAgents('boot');

// Start the WhatsApp groups connector. Safe no-op if DATABASE_URL isn't
// set; logs and continues either way so a connector issue never blocks
// the portal from serving. Passing transporter enables the "needs a
// human to rescan" email alert (best-effort, opt-in via Settings).
whatsappGroups.start(transporter).catch((e) => {
  console.error('[whatsapp/groups] failed to start:', e.message);
});
// Daily unanswered-chat digest scheduler (Asia/Jerusalem). In-process; on a
// sleeping host it fires when the instance is next awake (see lib/scheduler.js).
try { unansweredScheduler.start(); } catch (e) {
  console.error('[unanswered/scheduler] failed to start:', e.message);
}
if (dropbox.configured()) {
  const REFRESH_MS = parseInt(process.env.AGENTS_REFRESH_MS || '300000', 10); // 5 min
  setInterval(function () { refreshAgents('interval'); }, REFRESH_MS).unref();
}
