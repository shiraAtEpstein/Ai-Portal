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
const { evaluateNeedsReply } = require('./needs-reply');
const responsible = require('./responsible');

// Build a wa.me link that opens the client's own 1:1 WhatsApp chat, using the
// last-9-digit phone we already store, prefixed with Israel's country code (972).
// GROUP chats get NO link: WhatsApp has no public "open this group" URL when the
// LAWLY line isn't a group admin, and a private link to a client who wrote inside
// a group is not what we want. So only genuine 1:1 client chats get a link.
// Returns null for groups, or when we have no usable phone (e.g. @lid-only).
function waLink(chat) {
  if (!chat || chat.isGroup) return null;
  const ph = String(chat.lastClientPhone || '').replace(/\D/g, '');
  if (!ph || ph.length < 9) return null;
  return 'https://wa.me/972' + ph.slice(-9);
}

// Compact, email-safe item shape. Carries a wa.me link (opens the client chat)
// but never the raw phone number or message text.
function toItem(chat) {
  return {
    label: chat.label,
    clientName: chat.clientName || null,
    hoursWaiting: chat.hoursWaiting != null ? chat.hoursWaiting : null,
    isGroup: !!chat.isGroup,
    link: waLink(chat),
    chatJid: chat.chat_jid || null, // used by the in-portal page's "סמן כטופל"
  };
}

// Group the unanswered chats by the staff member responsible for each.
async function buildDigest({ hours = 3 } = {}) {
  const dir = loadDirectory();
  // Staff phones = "firm side": a message from any of them counts as a reply,
  // so a chat whose last message is from a staff member is NOT "awaiting reply".
  const staffPhones = (dir.staff || []).map((s) => s.phone9).filter(Boolean);
  const chats = await ingestDb.listUnansweredChats({ hours, staffPhones });

  console.log(`[unanswered] scan hours=${hours}: ${chats.length} candidate chat(s) from processing_jobs (last msg = client, no firm reply after)`);
  for (const c of chats) {
    console.log(`[unanswered]   candidate: "${c.label}" | client=${c.clientName || '-'} | waited=${c.hoursWaiting}h | lastText="${String(c.lastText || '').slice(0, 60)}"`);
  }

  // AI triage: send every candidate's WHOLE unanswered block (all client
  // messages since the firm last replied) to Claude and keep only those that
  // actually need a reply. Using the whole block — not just the last line —
  // means "question then תודה" stays flagged (the question is still in the
  // block). Fail-safe: anything the AI can't judge stays flagged (lib/needs-reply).
  // 3-way classify each chat's whole unanswered block. We ALERT only on
  // 'required' (🔴). 'none' (🟢) and 'potential' (🟡) are not alerted. A chat the
  // AI couldn't classify (missing key — outage) is NOT alerted this run and will
  // be re-evaluated next run when the AI is back (never guessed).
  const verdicts = await evaluateNeedsReply(
    chats.map((c) => ({ key: c.chat_jid, text: c.blockText || c.lastText }))
  );
  const flagged = chats.filter((c) => verdicts.get(c.chat_jid) === 'required');
  for (const c of chats) {
    const cat = verdicts.get(c.chat_jid) || 'pending';
    console.log(`[unanswered]   ${cat === 'required' ? 'ALERT 🔴' : 'skip'} (${cat}): "${c.label}"`);
  }
  console.log(`[unanswered] ${flagged.length} of ${chats.length} are 🔴 Response Required after triage`);

  const byPerson = {}; // email -> { name, items:[] }
  const all = [];

  for (const chat of flagged) {
    const item = toItem(chat);
    all.push(item);
    // PRIMARY: the monday "person in charge" for this group's case (resolved
    // once and cached). FALLBACK (no linked deal / no name match): the staff
    // member(s) who are actually in the group — excluding Yaakov Epstein, who is
    // in every group — and if several, all of them (routeGroupToStaff). Final
    // fallback inside routeGroupToStaff: the default owner.
    let email = chat.responsibleEmail;
    if (email == null) { // not resolved yet -> resolve now (one time) and cache
      try { email = (await responsible.resolveAndStore(chat.chat_jid, dir)).email; }
      catch (_) { email = ''; }
    }
    const mondayPerson = email ? (dir.staff || []).find((s) => s.email === email) : null;
    let recipients;
    if (mondayPerson) {
      recipients = [mondayPerson];
      console.log(`[unanswered]   route "${chat.label}" -> ${mondayPerson.email} (monday responsible)`);
    } else {
      const routed = routeGroupToStaff(chat.participant_phones, dir);
      recipients = routed.responsible;
      console.log(`[unanswered]   route "${chat.label}" -> ${recipients.map((r) => r.email).join(', ')} (${routed.isDefault ? 'default owner — no monday & no staff in group' : 'group staff — no monday responsible'})`);
    }
    // Per-message override: a message that addresses a staffer by name goes to
    // THEM (not the whole chat's responsible).
    const addr = responsible.addresseeFromText(chat.blockText, dir);
    if (addr) {
      recipients = [addr];
      console.log(`[unanswered]   addressed by name -> ${addr.email} (overrides for this message)`);
    }
    for (const person of recipients) {
      if (!byPerson[person.email]) byPerson[person.email] = { name: person.name, items: [] };
      byPerson[person.email].items.push(item);
    }
  }

  console.log(`[unanswered] digest built: ${all.length} chat(s), ${Object.keys(byPerson).length} recipient(s)`);
  return { hours, generatedAt: new Date().toISOString(), all, byPerson };
}

// Control board (Shira's verification view): EVERY currently-unanswered chat
// that needs attention, with its status (🔴 required / 🟡 potential / ⏳ pending),
// how long it's waited, and who's in charge. Answered chats simply aren't here
// (they cleared). 🟢 (no response needed) is excluded. Not filtered to only 🔴 —
// this is the full picture for verification.
async function buildBoard() {
  const dir = loadDirectory();
  const staffPhones = (dir.staff || []).map((s) => s.phone9).filter(Boolean);
  const chats = await ingestDb.listUnansweredChats({ hours: 0, staffPhones });
  const verdicts = await evaluateNeedsReply(
    chats.map((c) => ({ key: c.chat_jid, text: c.blockText || c.lastText }))
  );
  const items = [];
  for (const chat of chats) {
    const cat = verdicts.get(chat.chat_jid); // required | potential | none | undefined(pending)
    if (cat === 'none') continue;            // no response needed -> not on the board
    const status = cat === 'required' ? 'required' : cat === 'potential' ? 'potential' : 'pending';

    // Who's in charge — monday responsible (cached), else group staff.
    let email = chat.responsibleEmail;
    if (email == null) { try { email = (await responsible.resolveAndStore(chat.chat_jid, dir)).email; } catch (_) { email = ''; } }
    const mondayPerson = email ? (dir.staff || []).find((s) => s.email === email) : null;
    let responsibleName;
    if (mondayPerson) responsibleName = mondayPerson.name;
    else {
      const routed = routeGroupToStaff(chat.participant_phones, dir);
      responsibleName = routed.responsible.map((r) => r.name).join(', ');
    }
    // Per-message override: if the message explicitly addresses a staffer
    // ("היי יעקב"), show THEM as who should answer (does not change the chat's
    // stored responsible).
    let addressed = false;
    const addr = responsible.addresseeFromText(chat.blockText, dir);
    if (addr) { responsibleName = addr.name; addressed = true; }

    items.push({
      label: chat.label,
      clientName: chat.clientName || null,
      status,
      hoursWaiting: chat.hoursWaiting,
      unansweredCount: chat.unansweredCount || null,
      responsibleName,
      addressed,
      chatJid: chat.chat_jid,
    });
  }
  items.sort((a, b) => (b.hoursWaiting || 0) - (a.hoursWaiting || 0));
  console.log(`[board] ${items.length} chat(s) on the control board`);
  return { generatedAt: new Date().toISOString(), items };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Where the "פתיחת רשימת השיחות" button points — the in-portal "הודעות שממתינות"
// page (public/messages.html), which shows the live, auto-clearing list.
const PORTAL_URL = (process.env.PUBLIC_BASE_URL || 'https://ai-portal-wf42.onrender.com').replace(/\/$/, '');
const MESSAGES_URL = PORTAL_URL + '/messages.html';

// Natural-Hebrew wait label from a number of hours: שעה / שעתיים / N שעות,
// and from a day up: יום / יומיים / N ימים.
function waitLabel(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return '';
  if (n >= 24) {
    const d = Math.round(n / 24);
    if (d === 1) return 'יום';
    if (d === 2) return 'יומיים';
    return d + ' ימים';
  }
  const hr = Math.max(1, Math.round(n));
  if (hr === 1) return 'שעה';
  if (hr === 2) return 'שעתיים';
  return hr + ' שעות';
}

// Hebrew, right-to-left email — matches the approved design: two-line dark
// header, a beige intro box, a table with a header row (stacked group + client
// name, teal wait time), then the "פתיחת רשימת השיחות" button into Lawly and a
// short footer. Sorted oldest-first upstream (longest wait at the top). A 1:1
// client chat carries a wa.me link; group chats have no link (see waLink).
function renderHtml({ recipientName, items, isFullList, hours }) {
  const rows = items.map((it) => {
    const waited = waitLabel(it.hoursWaiting);
    const labelHtml = it.link
      ? '<a href="' + esc(it.link) + '" style="color:#1f2430;text-decoration:none;">' + esc(it.label) + '</a>' +
        '<span style="color:#0a7cff;font-size:12px;font-weight:normal;"> ↗ פתיחת צ׳אט</span>'
      : esc(it.label);
    const clientLine = it.clientName
      ? '<div style="font-size:13px;color:#93a08f;margin-top:3px;">' + esc(it.clientName) + '</div>'
      : '';
    return '<tr>' +
      '<td style="padding:11px 8px;border-bottom:1px solid #f0f0f2;text-align:right;vertical-align:top;">' +
        '<div style="font-size:15px;color:#1f2430;font-weight:bold;">' + labelHtml + '</div>' + clientLine +
      '</td>' +
      '<td style="padding:11px 8px;border-bottom:1px solid #f0f0f2;text-align:left;vertical-align:top;font-size:14px;color:#6e8b7c;white-space:nowrap;">' + esc(waited) + '</td>' +
      '</tr>';
  }).join('');

  const count = items.length;
  const intro = isFullList
    ? (count + ' שיחות שמחכות לתשובה — ריכזנו אותן כאן כדי שיהיה נוח לעבור עליהן')
    : (count + ' שיחות שלך שמחכות לתשובה — ריכזנו אותן כאן כדי שיהיה נוח לעבור עליהן');
  const greeting = 'שלום ' + esc(recipientName || 'רב') + ',';

  return '' +
    '<div dir="rtl" style="margin:0;padding:24px;background:#f4f4f6;font-family:Arial,Helvetica,sans-serif;direction:rtl;text-align:right;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2e3e7;">' +
    // header (two lines)
    '<tr><td style="background:#2b2f38;padding:22px 28px;text-align:right;">' +
      '<div style="color:#9aa1ac;font-size:12px;letter-spacing:.3px;margin-bottom:6px;">משרד אפשטיין · תזכורת יומית</div>' +
      '<div style="color:#ffffff;font-size:20px;font-weight:bold;">שיחות שמחכות לתשובה</div>' +
    '</td></tr>' +
    // greeting
    '<tr><td style="padding:22px 28px 2px 28px;font-size:15px;color:#7c8f81;text-align:right;">' + greeting + '</td></tr>' +
    // beige intro box
    '<tr><td style="padding:12px 28px 6px 28px;">' +
      '<div style="background:#f1ede2;border:1px solid #e7e0cf;border-radius:6px;padding:14px 16px;font-size:14px;color:#5b5341;text-align:right;line-height:1.6;">' + esc(intro) + '</div>' +
    '</td></tr>' +
    // table with header row
    '<tr><td style="padding:14px 22px 4px 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl">' +
      '<tr>' +
        '<th style="text-align:right;font-size:12px;color:#8a9099;font-weight:bold;padding:0 8px 8px 8px;border-bottom:1px solid #e6e6ea;">שיחה / לקוח</th>' +
        '<th style="text-align:left;font-size:12px;color:#8a9099;font-weight:bold;padding:0 8px 8px 8px;border-bottom:1px solid #e6e6ea;">זמן המתנה</th>' +
      '</tr>' + rows +
    '</table></td></tr>' +
    // button
    '<tr><td style="padding:18px 28px 4px 28px;">' +
      '<a href="' + esc(MESSAGES_URL) + '" style="display:inline-block;background:#2b2f38;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;padding:13px 30px;border-radius:6px;">פתיחת רשימת השיחות ←</a>' +
    '</td></tr>' +
    // sub-note under the button
    '<tr><td style="padding:9px 28px 6px 28px;font-size:12px;color:#9aa0a8;text-align:right;">הקישור נפתח ב-Lawly ומציג את כל השיחות שדרושות מענה.</td></tr>' +
    // footer
    '<tr><td style="padding:14px 28px 24px 28px;font-size:11.5px;color:#aab0b8;text-align:right;line-height:1.7;border-top:1px solid #eee;">נשלח אוטומטית על ידי Lawly · משרד אפשטיין. השיחה יורדת מהרשימה ברגע שמישהו במשרד עונה בוואטסאפ. הזמנים מבוססים על מועד קליטת ההודעה; אם החיבור היה מנותק ייתכן איחור קל.</td></tr>' +
    '</table></div>';
}

// Send the digests. Each responsible staff member gets their own list; the admin
// default owner (Shira) and the inAllGroups partner (Yaakov Epstein) get the
// FULL firm list. Returns { sent:[{email,ok,count,reason?}], counts:{...} }.
// testEmail (optional): when set, ALL email goes only to that address (the full
// firm list), with a "[TEST]" subject — so you can preview the digest without
// emailing any staff. Real runs leave it null.
async function sendDigests({ hours = 3, testEmail = null } = {}) {
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

  // TEST MODE: collapse all recipients to just the test address, full list.
  if (testEmail) {
    for (const k of Object.keys(recipients)) delete recipients[k];
    recipients[testEmail] = { name: 'בדיקה', items: digest.all, isFullList: true };
    console.log(`[unanswered] TEST MODE — sending only to ${testEmail} (full list, ${digest.all.length} item(s)); no staff emailed.`);
  }

  const sent = [];
  for (const [email, r] of Object.entries(recipients)) {
    if (!r.items.length) { sent.push({ email, ok: true, count: 0, skipped: 'nothing to send' }); continue; }
    const subject = (testEmail ? '[בדיקה] ' : '') + (r.isFullList ? 'הודעות שממתינות למענה (כל המשרד): ' : 'הודעות שממתינות למענה: ') + r.items.length;
    const html = renderHtml({ recipientName: r.name, items: r.items, isFullList: r.isFullList, hours });
    const res = await sendFirmEmail({ to: email, subject, html });
    console.log(`[unanswered] email -> ${email}: ${res.sent ? 'SENT' : 'FAILED (' + res.reason + ')'} (${r.items.length} item(s)${r.isFullList ? ', full list' : ''})`);
    sent.push({ email, ok: !!res.sent, count: r.items.length, reason: res.sent ? undefined : res.reason });
  }
  console.log(`[unanswered] send-digest done: ${sent.filter((s) => s.ok && s.count > 0).length}/${Object.keys(recipients).length} email(s) sent`);

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

module.exports = { buildDigest, sendDigests, renderHtml, buildBoard };
