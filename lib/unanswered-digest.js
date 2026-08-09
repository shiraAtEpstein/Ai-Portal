// ============================================================
// lib/unanswered-digest.js — build & send the "unanswered WhatsApp chats"
// digest. Deterministic end-to-end: no Dropbox, no Claude, no processor.
//
//   buildDigest({hours})  -> { all:[...], byPerson:{ email:{name,items:[...]} } }
//   sendDigests({hours})  -> emails each responsible person their list (Shira +
//                            Yaakov Epstein get the full firm list) via the
//                            Gmail API (lib/firm-mailer). Returns {sent, counts}.
//
// Shared by routes/unanswered.js (manual trigger + preview) and lib/scheduler.js
// (daily run) so both produce identical output.
// ============================================================
const ingestDb = require('../whatsapp/ingest/db');
const { routeGroupToStaff, loadDirectory, defaultOwnerOf } = require('./routing');
const { sendFirmEmail } = require('./firm-mailer');

// Compact, email-safe item shape (never includes message text / phones).
function toItem(chat) {
  return {
    label: chat.label,
    clientName: chat.clientName || null,
    hoursWaiting: chat.hoursWaiting != null ? chat.hoursWaiting : null,
    isGroup: !!chat.isGroup,
  };
}

// Group the unanswered chats by the staff member responsible for each.
async function buildDigest({ hours = 3 } = {}) {
 const dir = loadDirectory();
  // Staff phones = "firm side": a message from any of them counts as a reply,
  // so a chat whose last message is from a staff member is NOT "awaiting reply".
  const staffPhones = (dir.staff || []).map((s) => s.phone9).filter(Boolean);
  const chats = await ingestDb.listUnansweredChats({ hours, staffPhones });

  const byPerson = {}; // email -> { name, items:[] }
  const all = [];

  for (const chat of chats) {
    const item = toItem(chat);
    all.push(item);
    const { responsible } = routeGroupToStaff(chat.participant_phones, dir);
    for (const person of responsible) {
      if (!byPerson[person.email]) byPerson[person.email] = { name: person.name, items: [] };
      byPerson[person.email].items.push(item);
    }
  }

  return { hours, generatedAt: new Date().toISOString(), all, byPerson };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderHtml({ recipientName, items, isFullList, hours }) {
  const rows = items.map((it) => {
    const client = it.clientName ? (' — ' + esc(it.clientName)) : '';
    const waited = it.hoursWaiting != null ? (it.hoursWaiting + 'h') : '';
    return '<tr>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;color:#15161a;">' + esc(it.label) + client + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;color:#a33;text-align:right;white-space:nowrap;">' + esc(waited) + '</td>' +
      '</tr>';
  }).join('');
  const heading = isFullList
    ? 'Unanswered client WhatsApp chats — firm-wide'
    : 'Your unanswered client WhatsApp chats';
  const intro = isFullList
    ? 'Client messages with no firm reply for more than ' + hours + 'h (all chats):'
    : 'These clients messaged and have had no reply for more than ' + hours + 'h:';
  return '' +
    '<div style="margin:0;padding:24px;background:#f4f4f6;font-family:Arial,Helvetica,sans-serif;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e2e3e7;">' +
    '<tr><td style="background:#000;padding:22px 28px;color:#ececee;font-size:17px;font-weight:bold;">' + esc(heading) + '</td></tr>' +
    '<tr><td style="padding:20px 28px 6px 28px;font-size:14px;color:#565a62;">Hi ' + esc(recipientName || 'there') + ',<br><br>' + esc(intro) + '</td></tr>' +
    '<tr><td style="padding:12px 20px 20px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rows + '</table></td></tr>' +
    '<tr><td style="padding:6px 28px 24px 28px;font-size:12px;color:#9aa0a8;">Sent by Lawly · Epstein &amp; Co. Times are from message ingest; if the connector was offline they may lag slightly.</td></tr>' +
    '</table></div>';
}

// Send the digests. Each responsible staff member gets their own list; the admin
// default owner (Shira) and the inAllGroups partner (Yaakov Epstein) get the
// FULL firm list. Returns { sent:[{email,ok,count,reason?}], counts:{...} }.
async function sendDigests({ hours = 3 } = {}) {
  const dir = loadDirectory();
  const digest = await buildDigest({ hours });

  const owner = defaultOwnerOf(dir);
  const partner = (dir.staff || []).find((s) => s.inAllGroups) || null;
  const fullListEmails = new Set([owner.email]);
  if (partner) fullListEmails.add(partner.email);

  // Compose the recipient -> items map: start from per-person, then force the
  // full-list recipients to the complete list.
  const recipients = {}; // email -> { name, items, isFullList }
  for (const [email, entry] of Object.entries(digest.byPerson)) {
    recipients[email] = { name: entry.name, items: entry.items, isFullList: false };
  }
  for (const email of fullListEmails) {
    const staff = (dir.staff || []).find((s) => s.email === email);
    recipients[email] = {
      name: staff ? staff.name : (recipients[email] && recipients[email].name) || '',
      items: digest.all,
      isFullList: true,
    };
  }

  const sent = [];
  for (const [email, r] of Object.entries(recipients)) {
    if (!r.items.length) { sent.push({ email, ok: true, count: 0, skipped: 'nothing to send' }); continue; }
    const subject = (r.isFullList ? 'Unanswered client chats (firm-wide): ' : 'Your unanswered client chats: ') + r.items.length;
    const html = renderHtml({ recipientName: r.name, items: r.items, isFullList: r.isFullList, hours });
    const res = await sendFirmEmail({ to: email, subject, html });
    sent.push({ email, ok: !!res.sent, count: r.items.length, reason: res.sent ? undefined : res.reason });
  }

  return {
    sent,
    counts: {
      totalChats: digest.all.length,
      recipients: Object.keys(recipients).length,
      emailsSent: sent.filter((s) => s.ok && s.count > 0).length,
    },
    hours,
  };
}

module.exports = { buildDigest, sendDigests };
