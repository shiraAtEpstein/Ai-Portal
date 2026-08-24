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
const crypto = require('crypto');
const ingestDb = require('../whatsapp/ingest/db');
const { routeGroupToStaff, loadDirectory, defaultOwnerOf } = require('./routing');
const { sendFirmEmail } = require('./firm-mailer');
const { evaluateNeedsReply } = require('./needs-reply');
const responsible = require('./responsible');
const { elapsedLabel, elapsedHours, elapsedTone } = require('./wait-label');

// Classify chats, REUSING each chat's cached verdict until its content changes.
// The signature is a hash of the unanswered block, so a chat is only sent to the
// AI again when a NEW message arrives (or the firm hasn't replied and the text
// changed). Unchanged chats never hit the AI again. Verdicts the AI couldn't
// produce (outage) are not cached, so they retry next run.
function triageSig(chat) {
  return crypto.createHash('sha1').update(String(chat.blockText || chat.lastText || '')).digest('hex');
}

// Light, no-AI staleness check: if a chat's LAST message was an arrival / ETA
// ("on my way", "be there in 15 min", "אנחנו בדרך", "מגיע עוד רבע שעה") and more
// than STALE_ARRIVAL_MIN minutes have passed with nothing new, the visit has
// surely happened — so drop it even though the cached verdict says otherwise.
// Runs on every board build without re-asking the AI.
const STALE_ARRIVAL_MIN = 30;
const ARRIVAL_EN = /\b(on (my|our) way|omw|be there|almost there|arriv(e|ing)|heading (over|down|back)|coming (now|over|back)|leaving now|(\d{1,2})\s*(min|minute)|few (min|minutes))\b/i;
const ARRIVAL_HE = /(בדרך|בדרכי|בדרכנו|מגיע(ים)?|יוצא(ים)?\s*עכשיו|עוד\s*\d+\s*דק|עוד\s*(רבע|חצי)\s*שעה|כמעט (שם|הגענו)|תכף)/;
function isStaleArrival(chat) {
  const lines = String(chat.blockText || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return false;
  const last = lines[lines.length - 1];
  if (!(ARRIVAL_EN.test(last) || ARRIVAL_HE.test(last))) return false;
  const age = ageMinutes(chat.lastInboundAt);
  return age != null && age >= STALE_ARRIVAL_MIN;
}
async function classifyWithCache(chats) {
  const jids = chats.map((c) => c.chat_jid);
  let cached = new Map();
  try { cached = await ingestDb.getChatTriage(jids); } catch (_) {}

  const verdicts = new Map();
  const toEval = [];
  for (const c of chats) {
    const sig = triageSig(c);
    const hit = cached.get(c.chat_jid);
    if (hit && hit.sig === sig && hit.verdict) verdicts.set(c.chat_jid, hit.verdict);
    else toEval.push({ c, sig });
  }

  if (toEval.length) {
    const fresh = await evaluateNeedsReply(
      toEval.map(({ c }) => ({ key: c.chat_jid, text: c.blockText || c.lastText, lastMsgAgeMinutes: ageMinutes(c.lastInboundAt) }))
    );
    for (const { c, sig } of toEval) {
      const v = fresh.get(c.chat_jid);
      if (v) { verdicts.set(c.chat_jid, v); try { await ingestDb.setChatTriage(c.chat_jid, sig, v); } catch (_) {} }
      // v undefined = AI outage -> don't cache, retry next run
    }
  }
  // Free staleness override: stale arrival/ETA chats drop, no AI call.
  let staled = 0;
  for (const c of chats) {
    const v = verdicts.get(c.chat_jid);
    if ((v === 'required' || v === 'potential') && isStaleArrival(c)) { verdicts.set(c.chat_jid, 'none'); staled++; }
  }
  console.log(`[triage] ${chats.length} chat(s): ${chats.length - toEval.length} reused from cache, ${toEval.length} sent to AI${staled ? `, ${staled} dropped (stale arrival)` : ''}`);
  return verdicts;
}

// Minutes since a timestamp (the last client message), so the triage can decide
// whether an "on my way / be there in 15 min" message has gone stale. Returns
// null when unknown (the AI then just skips the time-decay rule for that chat).
function ageMinutes(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

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
    waitedSince: chat.firstUnansweredAt || null,
    waitedLabel: elapsedLabel(chat.firstUnansweredAt),
    elapsedHours: elapsedHours(chat.firstUnansweredAt),
    waitedTone: elapsedTone(chat.firstUnansweredAt),
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
  const verdicts = await classifyWithCache(chats);
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
// that needs attention, with its status (🔴 required / 🟡 potential / 🎤 voice),
// how long it's waited, and who's in charge. Answered chats simply aren't here
// (they cleared). 🟢 (no response needed) is excluded.
//
// Result is CACHED briefly so the board page and the staff dashboard (which both
// call this) show the SAME snapshot — otherwise each call re-runs the AI triage
// and the two disagree. Also halves the AI cost.
let _boardCache = null, _boardCacheAt = 0;
const BOARD_TTL_MS = 45 * 1000;

// Drop the cached board so the next read rebuilds from scratch. Called after any
// write from the board (status change / reassign). Without this, an edit would
// appear to do nothing for up to BOARD_TTL_MS and people would click it twice.
function invalidateBoardCache() {
  _boardCache = null;
  _boardCacheAt = 0;
}

async function buildBoard({ fresh = false } = {}) {
  if (!fresh && _boardCache && (Date.now() - _boardCacheAt) < BOARD_TTL_MS) return _boardCache;
  const dir = loadDirectory();
  const staffPhones = (dir.staff || []).map((s) => s.phone9).filter(Boolean);
  const chats = await ingestDb.listUnansweredChats({ hours: 0, staffPhones });
  const verdicts = await classifyWithCache(chats);
  // Manual אחראי choices, fetched once for the whole board instead of per row.
  let overrides = new Map();
  try { overrides = await ingestDb.getResponsibleOverrides(chats.map((c) => c.chat_jid)); } catch (_) {}
  const items = [];
  for (const chat of chats) {
    const cat = verdicts.get(chat.chat_jid); // required | potential | none | voice | undefined
    if (cat === 'none') continue;            // no response needed -> not on the board
    // Only three visible statuses. 'potential' AND unclassified (AI couldn't
    // decide yet) both show as 🟡 — there is no separate "בבדיקה" bucket.
    const status = cat === 'required' ? 'required'
      : cat === 'voice' ? 'voice'            // client sent a voice note — its own status, not alerted
      : 'potential';

    // WHO'S IN CHARGE — precedence, highest first:
    //   1. manual override set on the board (a person decided; it always wins)
    //   2. monday "person in charge" for the linked deal (resolved once, cached)
    //   3. staff actually in the group
    //   4. default owner (inside routeGroupToStaff)
    // The "פנייה בשם" text heuristic can bump 2-4 but never beats 1 — a human's
    // explicit choice outranks a guess made from message text.
    const manual = overrides.get(chat.chat_jid) || null;
    let responsibleName = '';
    let responsibleEmails = [];
    let addressed = false;
    let manualAssigned = false;
    // The monday "person in charge" for this chat's deal, kept on the item even
    // when a manual override or a by-name guess wins the routing. It is the
    // fallback the staff dashboard uses when the winner turns out to be someone
    // who is excluded from the board — see lib/staff-response.js.
    let mondayEmail = null;

    if (manual) {
      const person = (dir.staff || []).find((s) => s.email === manual.email);
      responsibleName = manual.name || (person ? person.name : manual.email);
      responsibleEmails = [manual.email];
      manualAssigned = true;
      // A manual choice does not erase who monday says owns the case.
      let mEmail = chat.responsibleEmail;
      if (mEmail == null) { try { mEmail = (await responsible.resolveAndStore(chat.chat_jid, dir)).email; } catch (_) { mEmail = ''; } }
      mondayEmail = mEmail || null;
    } else {
      let email = chat.responsibleEmail;
      if (email == null) { try { email = (await responsible.resolveAndStore(chat.chat_jid, dir)).email; } catch (_) { email = ''; } }
      mondayEmail = email || null;
      const mondayPerson = email ? (dir.staff || []).find((s) => s.email === email) : null;
      if (mondayPerson) {
        responsibleName = mondayPerson.name;
        responsibleEmails = [mondayPerson.email];
      } else {
        const routed = routeGroupToStaff(chat.participant_phones, dir);
        responsibleName = routed.responsible.map((r) => r.name).join(', ');
        responsibleEmails = routed.responsible.map((r) => r.email).filter(Boolean);
      }
      // Per-message override: if the message explicitly addresses a staffer
      // ("היי יעקב"), show THEM as who should answer (does not change the chat's
      // stored responsible).
      const addr = responsible.addresseeFromText(chat.blockText, dir);
      if (addr) { responsibleName = addr.name; responsibleEmails = [addr.email]; addressed = true; }
    }

    items.push({
      label: chat.label,
      clientName: chat.clientName || null,
      status,
      // TWO CLOCKS, ON PURPOSE (Shira, 2026-08-24):
      //   hoursWaiting   — WORKING hours. Feeds the medians and the percentages.
      //                    Nobody is slow for not replying at 03:00.
      //   waitedLabel    — REAL elapsed time, and the only thing shown next to
      //                    the row. A client who wrote on Thursday has been
      //                    waiting since Thursday, whatever the office hours
      //                    were in between.
      // The label is built server-side (lib/wait-label.js) so every screen and
      // both emails word it identically, and so "today" means the firm's today
      // rather than the viewer's.
      hoursWaiting: chat.hoursWaiting,
      waitedSince: chat.firstUnansweredAt || null,
      waitedLabel: elapsedLabel(chat.firstUnansweredAt),
      elapsedHours: elapsedHours(chat.firstUnansweredAt),
      // ok | warn | bad — decided from the same day count as the label, so the
      // colour and the words above it cannot contradict each other.
      waitedTone: elapsedTone(chat.firstUnansweredAt),
      unansweredCount: chat.unansweredCount || null,
      // Same wa.me link the email carries (1:1 client chats only — see waLink).
      // The personal page uses it to open the conversation straight from the
      // row, which is the whole point of a list you are meant to act on.
      link: waLink(chat),
      responsibleName,
      // Used server-side for the assignee-or-admin permission check, and
      // client-side to preselect the current person in the אחראי dropdown.
      responsibleEmails,
      addressed,
      manualAssigned,
      mondayEmail,
      chatJid: chat.chat_jid,
    });
  }
  // Oldest first, by when the client actually wrote — see the same note in
  // whatsapp/ingest/db.js. Working hours tie overnight; a timestamp cannot.
  items.sort((a, b) => new Date(a.waitedSince).getTime() - new Date(b.waitedSince).getTime());
  console.log(`[board] ${items.length} chat(s) on the control board`);
  const result = { generatedAt: new Date().toISOString(), items };
  _boardCache = result; _boardCacheAt = Date.now();
  return result;
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

// The one sentence the email exists to deliver, in natural Hebrew — "1 הודעות"
// in a mail people get every morning reads as a machine talking. Shared by the
// body and the SUBJECT so the two can never word the same count differently.
function countHeadline(count, isFullList) {
  if (isFullList) {
    if (count === 1) return 'יש הודעה אחת שממתינה למענה במשרד';
    if (count === 2) return 'יש שתי הודעות שממתינות למענה במשרד';
    return 'יש ' + count + ' הודעות שממתינות למענה במשרד';
  }
  if (count === 1) return 'יש לך הודעה אחת שממתינה למענה';
  if (count === 2) return 'יש לך שתי הודעות שממתינות למענה';
  return 'יש לך ' + count + ' הודעות שממתינות למענה';
}

// The daily email (Shira, 2026-08-24): a NUDGE, not a report.
//
// It used to carry the whole table. Shira's call is that the list belongs in
// one place — the portal — and the email exists only to say there is something
// there and to open it. The reasoning holds up: the table in the mail went
// stale the moment somebody replied, it could not be acted on (no status, no
// אחראי, no "סמן כטופל"), and two lists of the same thing drift.
//
// So: how many are waiting on YOU, and a button to your own list. No rows, no
// medians, no percentages — none of the measurement lives here.
//
// The button lands on /messages.html, which scopes itself to the signed-in
// person server-side, so the same URL shows each person their own messages and
// there is no per-recipient token to leak or expire.
function renderHtml({ recipientName, items, isFullList }) {
  const count = (items || []).length;
  const greeting = 'שלום ' + esc(recipientName || 'רב') + ',';

  const headline = countHeadline(count, isFullList);

  const sub = isFullList
    ? 'הרשימה המלאה נמצאת בלולי, עם זמן ההמתנה של כל שיחה, האחראי עליה, ואפשרות לסמן שטופלה.'
    : 'הרשימה נמצאת בלולי, עם זמן ההמתנה של כל שיחה ואפשרות לשנות אחראי או לסמן שטופלה.';

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
    // the count, large, in the beige box
    '<tr><td style="padding:12px 28px 6px 28px;">' +
      '<div style="background:#f1ede2;border:1px solid #e7e0cf;border-radius:6px;padding:18px 18px;text-align:right;">' +
        '<div style="font-size:19px;font-weight:bold;color:#4a4230;line-height:1.5;">' + esc(headline) + '</div>' +
        '<div style="font-size:13.5px;color:#6b6350;line-height:1.7;margin-top:8px;">' + esc(sub) + '</div>' +
      '</div>' +
    '</td></tr>' +
    // the button — the whole point of the email
    '<tr><td style="padding:20px 28px 4px 28px;">' +
      '<a href="' + esc(MESSAGES_URL) + '" style="display:inline-block;background:#2b2f38;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;padding:14px 32px;border-radius:6px;">פתיחת ההודעות שלי ←</a>' +
    '</td></tr>' +
    '<tr><td style="padding:9px 28px 6px 28px;font-size:12px;color:#9aa0a8;text-align:right;">הקישור נפתח ב-Lawly ומציג את ההודעות שממתינות לך.</td></tr>' +
    // footer
    '<tr><td style="padding:14px 28px 24px 28px;font-size:11.5px;color:#aab0b8;text-align:right;line-height:1.7;border-top:1px solid #eee;">נשלח אוטומטית על ידי Lawly · משרד אפשטיין. שיחה יורדת מהרשימה ברגע שמישהו במשרד עונה בוואטסאפ.</td></tr>' +
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
    const subject = (testEmail ? '[בדיקה] ' : '') + countHeadline(r.items.length, r.isFullList);
    const html = renderHtml({ recipientName: r.name, items: r.items, isFullList: r.isFullList });
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

module.exports = { buildDigest, sendDigests, renderHtml, buildBoard, invalidateBoardCache };
