// ============================================================
// lib/firm-mailer.js — send firm email via the Gmail API (OAuth refresh token).
//
// Extracted verbatim from routes/admin.js sendInvite(): exchange the long-lived
// GMAIL_REFRESH_TOKEN for a short-lived access token, then POST an RFC-822
// message to gmail.googleapis.com/.../messages/send. Port 443 only — SMTP is
// blocked on the host, so we do NOT use nodemailer here. No Resend.
//
// This is the ONE proven outbound-mail path in the app; routes/admin.js and the
// unanswered-chat digest both call it so behavior stays identical.
// ============================================================

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Epstein & Co. Portal <noreply@epsteinlaw.co.il>';

function configured() {
  return !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN);
}

// RFC 2047 encode a header value if it contains non-ASCII (e.g. a Hebrew subject).
function encodeHeader(v) {
  const s = String(v || '');
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

// Exchange the long-lived refresh token for a short-lived access token.
async function gmailAccessToken(signal) {
  const body = new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    client_secret: GMAIL_CLIENT_SECRET,
    refresh_token: GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('auth: ' + (j.error_description || j.error || ('HTTP ' + resp.status)));
  return j.access_token;
}

// Send one HTML email. Returns { sent:true } or { sent:false, reason }.
// Times out after 12s (same as the original invite sender).
async function sendFirmEmail({ to, subject, html, from }) {
  if (!configured()) return { sent: false, reason: 'email not configured' };
  if (!to) return { sent: false, reason: 'no recipient' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const accessToken = await gmailAccessToken(controller.signal);
    const mime =
      'From: ' + (from || EMAIL_FROM) + '\r\n' +
      'To: ' + to + '\r\n' +
      'Subject: ' + encodeHeader(subject) + '\r\n' +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: text/html; charset="UTF-8"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      Buffer.from(String(html || ''), 'utf8').toString('base64');
    const raw = Buffer.from(mime, 'utf8').toString('base64url');
    const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      let detail = 'HTTP ' + resp.status;
      try { const j = await resp.json(); detail = (j.error && j.error.message) || detail; } catch (_) { /* keep status */ }
      console.error('[MAIL] firm email send failed:', detail);
      return { sent: false, reason: detail };
    }
    return { sent: true };
  } catch (e) {
    const reason = (e && e.name === 'AbortError') ? 'timed out reaching Google' : (e && e.message) || 'unknown error';
    console.error('[MAIL] firm email send failed:', reason);
    return { sent: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendFirmEmail, configured, EMAIL_FROM };
