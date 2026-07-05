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
const createAdminRouter = require('./routes/admin');
const createMarketingRouter = require('./routes/marketing');

const app = express();
app.use(express.json());
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
app.use(createAdminRouter({ loadUsers }));
app.use(createMarketingRouter());

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
