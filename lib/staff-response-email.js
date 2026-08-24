// ============================================================
// lib/staff-response-email.js — the daily "לוח בקרת מענה" email.
//
//   renderStaffReportHtml({ data, recipientName, boardUrl })  -> HTML string
//   sendStaffReport({ windowDays, to, testEmail })            -> { sent:[...] }
//
// WHAT THIS IS (and what it deliberately is NOT)
// ----------------------------------------------------------------------------
// This email is a LINK, not a report. Its job is to put one button in Yaakov's
// inbox every morning that opens the live dashboard at /staff-response.html.
// The handful of numbers above the button are there so the email is worth
// opening on a phone — they are not meant to replace the board.
//
// The link is a plain deep link. If the person is already signed in, the page
// loads straight away (the portal session lives in an httpOnly cookie). If not,
// the page bounces to Google sign-in carrying ?next=/staff-response.html, and
// google-auth.js sends them BACK here after login instead of to the portal home
// page. One click either way.
//
// MAIL-CLIENT RULES observed throughout (Gmail/Outlook strip the rest):
//   • tables for layout — never flex or grid
//   • inline styles only — no <style> block, no CSS variables, no classes
//   • no external CSS, fonts or images
//   • dir="rtl" and align set on the elements themselves
//   • no JavaScript (this is why the dashboard page itself cannot be mailed —
//     it builds its DOM in the browser and would arrive blank)
// ============================================================
const { buildStaffResponse } = require('./staff-response');
const { sendFirmEmail } = require('./firm-mailer');
const { loadDirectory } = require('./routing');

const PORTAL_URL = (process.env.PUBLIC_BASE_URL || 'https://ai-portal-wf42.onrender.com').replace(/\/$/, '');
const BOARD_PATH = '/staff-response.html';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Percent against the TEAM median (the median of the people's medians) — NOT
// against the per-message headline in the tiles above. A bare "-27%" next to
// Hebrew flips sides in RTL mail clients and ends up reading as "+27%", which
// is the opposite of the truth — so the direction is a word, never a sign.
function vsTeamText(pct) {
  if (pct == null) return null;
  if (pct <= -3) return { text: 'מהיר ב-' + Math.abs(pct) + '% מהצוות', color: '#1f7a44' };
  if (pct >= 3) return { text: 'איטי ב-' + pct + '% מהצוות', color: '#b0281c' };
  return { text: 'כמו חציון הצוות', color: '#6b7280' };
}

function tile(number, label, color, bg, border) {
  return '<td width="33%" align="center" style="padding:4px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="background:' + bg + ';border:1px solid ' + border + ';border-radius:8px;">' +
    '<tr><td align="center" style="padding:14px 8px;">' +
    '<div style="font-size:24px;font-weight:bold;color:' + color + ';line-height:1;">' + esc(number) + '</div>' +
    '<div style="font-size:12px;font-weight:bold;color:' + color + ';margin-top:6px;">' + esc(label) + '</div>' +
    '</td></tr></table></td>';
}

// One line per staff member who currently has something waiting, worst first.
//
// "Worst" is REAL elapsed time, not working hours: this column names ONE
// message, and the honest answer to "how long has your worst one been sitting
// there" is "לפני 5 ימים", not the two working days those five contained. The
// wording is the string the portal already shows for that same row
// (lib/wait-label.js via lib/staff-response.js), so the email and the page can
// never describe the same message differently.
function staffLines(staff) {
  const rows = (staff || [])
    .filter((s) => (s.items || []).length)
    .map((s) => {
      const items = s.items || [];
      // Items arrive oldest-first from lib/staff-response.js, so the head of the
      // list IS the oldest — no re-derivation, and no second sort to disagree.
      const oldestItem = items[0];
      return {
        name: s.name,
        count: items.length,
        oldestHours: Number(oldestItem && oldestItem.elapsedHours) || 0,
        oldestLabel: (oldestItem && oldestItem.waitedLabel) || '—',
        vs: vsTeamText(s.replies ? s.vsTeamPct : null),
      };
    })
    .sort((a, b) => b.oldestHours - a.oldestHours);

  if (!rows.length) {
    return '<tr><td align="center" style="padding:18px 8px;font-size:14px;color:#3f8f6a;">אין כרגע הודעות שממתינות למענה 🎉</td></tr>';
  }

  return rows.map((r) => {
    const vs = r.vs
      ? '<div style="font-size:12px;color:' + r.vs.color + ';margin-top:3px;">' + esc(r.vs.text) + '</div>'
      : '';
    return '<tr>' +
      '<td style="padding:10px 8px;border-bottom:1px solid #f0f0f2;text-align:right;vertical-align:top;">' +
        '<div style="font-size:15px;color:#1f2430;font-weight:bold;">' + esc(r.name) + '</div>' + vs +
      '</td>' +
      '<td style="padding:10px 8px;border-bottom:1px solid #f0f0f2;text-align:center;vertical-align:top;font-size:15px;font-weight:bold;color:#1f2430;white-space:nowrap;">' + r.count + '</td>' +
      '<td style="padding:10px 8px;border-bottom:1px solid #f0f0f2;text-align:left;vertical-align:top;font-size:14px;color:#6e8b7c;white-space:nowrap;">' + esc(r.oldestLabel) + '</td>' +
      '</tr>';
  }).join('');
}

function renderStaffReportHtml({ data, recipientName, boardUrl } = {}) {
  const d = data || {};
  const f = d.firm || {};
  const url = boardUrl || (PORTAL_URL + BOARD_PATH);
  const greeting = 'שלום ' + esc(recipientName || 'רב') + ',';
  const openTotal = f.openTotal || 0;
  const intro = openTotal
    ? (openTotal + ' שיחות ממתינות למענה כרגע. הלוח המלא — כולל ההודעות של כל איש צוות ואפשרות לסמן כטופל או להחליף אחראי — נפתח בלחיצה אחת.')
    : 'אין כרגע שיחות שממתינות למענה. הלוח המלא נפתח בלחיצה אחת.';

  return '' +
    '<div dir="rtl" style="margin:0;padding:24px;background:#f4f4f6;font-family:Arial,Helvetica,sans-serif;direction:rtl;text-align:right;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e2e3e7;">' +

    // header
    '<tr><td style="background:#2b2f38;padding:22px 28px;text-align:right;">' +
      '<div style="color:#9aa1ac;font-size:12px;letter-spacing:.3px;margin-bottom:6px;">משרד אפשטיין · דוח מענה יומי</div>' +
      '<div style="color:#ffffff;font-size:20px;font-weight:bold;">לוח בקרת מענה — צוות המשרד</div>' +
    '</td></tr>' +

    // greeting
    '<tr><td style="padding:22px 28px 2px 28px;font-size:15px;color:#7c8f81;text-align:right;">' + greeting + '</td></tr>' +

    // intro box
    '<tr><td style="padding:12px 28px 6px 28px;">' +
      '<div style="background:#f1ede2;border:1px solid #e7e0cf;border-radius:6px;padding:14px 16px;font-size:14px;color:#5b5341;text-align:right;line-height:1.6;">' + esc(intro) + '</div>' +
    '</td></tr>' +

    // the button — the point of the whole email, so it comes BEFORE the numbers
    '<tr><td style="padding:18px 28px 4px 28px;text-align:right;">' +
      '<a href="' + esc(url) + '" style="display:inline-block;background:#2b2f38;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;padding:13px 30px;border-radius:6px;">פתיחת לוח הבקרה ←</a>' +
    '</td></tr>' +
    '<tr><td style="padding:9px 28px 10px 28px;font-size:12px;color:#9aa0a8;text-align:right;line-height:1.6;">' +
      'הקישור נפתח ישירות בלוח. אם לא בוצעה התחברות, תוצג קודם ההתחברות ומיד לאחריה הלוח עצמו.' +
    '</td></tr>' +

    // headline tiles
    '<tr><td style="padding:6px 24px 2px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl"><tr>' +
      tile(f.median || '—', 'חציון מענה לכל הודעה', '#2f3b34', '#eef2ef', '#dbe4dd') +
      tile(f.teamMedian || '—', 'חציון הצוות', '#4a5560', '#f3f4f6', '#e3e5e9') +
      tile(f.required || 0, '🔴 דורשות מענה', '#b0281c', '#fdeeeb', '#f6d5cd') +
    '</tr></table></td></tr>' +
    '<tr><td style="padding:2px 28px 10px 28px;font-size:11.5px;color:#9aa0a8;text-align:right;line-height:1.6;">' +
      'אין יעד זמן. שני מספרים שונים בכוונה: <b>חציון לכל הודעה</b> הוא מה שלקוח טיפוסי מחכה, ' +
      'ו<b>חציון הצוות</b> הוא החציון של איש צוות טיפוסי — האחוזים שליד כל שם נמדדים מולו. ' +
      'שניהם על ' + (d.windowDays || 30) + ' הימים האחרונים.' +
    '</td></tr>' +

    // per-person waiting list
    '<tr><td style="padding:8px 22px 4px 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl">' +
      '<tr>' +
        '<th style="text-align:right;font-size:12px;color:#8a9099;font-weight:bold;padding:0 8px 8px 8px;border-bottom:1px solid #e6e6ea;">איש צוות</th>' +
        '<th style="text-align:center;font-size:12px;color:#8a9099;font-weight:bold;padding:0 8px 8px 8px;border-bottom:1px solid #e6e6ea;">ממתינות</th>' +
        '<th style="text-align:left;font-size:12px;color:#8a9099;font-weight:bold;padding:0 8px 8px 8px;border-bottom:1px solid #e6e6ea;">הוותיקה — נשלחה</th>' +
      '</tr>' + staffLines(d.staff) +
    '</table></td></tr>' +

    // footer
    '<tr><td style="padding:16px 28px 24px 28px;font-size:11.5px;color:#aab0b8;text-align:right;line-height:1.7;border-top:1px solid #eee;">' +
      'נשלח אוטומטית על ידי Lawly · משרד אפשטיין. שיחה יורדת מהרשימה ברגע שמישהו במשרד עונה בוואטסאפ. ' +
      'הזמנים מבוססים על מועד קליטת ההודעה; אם החיבור היה מנותק ייתכן איחור קל.' +
    '</td></tr>' +

    '</table></div>';
}

// Who the daily report goes to.
//
// DELIBERATELY EMPTY BY DEFAULT. Nothing is scheduled to anybody until someone
// sets STAFF_REPORT_TO in the environment. Shira asked to see the email in her
// own inbox first and to be the one who decides when it starts going to Yaakov
// — a hardcoded default recipient would take that decision away from her, and a
// config slip would mail the partner a report nobody had reviewed.
//
// When it IS time: STAFF_REPORT_TO=y@epsteinlaw.co.il. That is Yaakov Epstein,
// the partner — NOT Yaakov Hershkovitz (yh@). Two different people; see
// config/staff-directory.json.
//
// The "send it to me now" button on the dashboard does not depend on this: it
// passes an explicit address and always works.
function reportRecipients() {
  return String(process.env.STAFF_REPORT_TO || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function nameForEmail(email) {
  try {
    const dir = loadDirectory();
    const person = (dir.staff || []).find((s) => String(s.email || '').toLowerCase() === String(email || '').toLowerCase());
    return person ? person.name : '';
  } catch (_) { return ''; }
}

// Build once, send to everyone. testEmail collapses the whole run to a single
// address with a "[בדיקה]" subject, so a dry run never reaches staff.
async function sendStaffReport({ windowDays = 30, to = null, testEmail = null } = {}) {
  const data = await buildStaffResponse({ windowDays });
  const url = PORTAL_URL + BOARD_PATH;

  let targets;
  if (testEmail) targets = [String(testEmail).trim()];
  else if (to) targets = String(to).split(',').map((s) => s.trim()).filter(Boolean);
  else targets = reportRecipients();

  // No recipients and no explicit address: do nothing, and say so plainly.
  // Silently "succeeding" here is how a daily report goes unnoticed for a week.
  if (!targets.length) {
    console.log('[staff-report] no recipients configured (STAFF_REPORT_TO is empty) — nothing sent.');
    return { sent: [], counts: { recipients: 0, emailsSent: 0, openTotal: (data.firm && data.firm.openTotal) || 0 },
             skipped: 'no recipients configured', windowDays, boardUrl: url };
  }

  const openTotal = (data.firm && data.firm.openTotal) || 0;
  const subject = (testEmail ? '[בדיקה] ' : '') +
    (openTotal ? 'לוח בקרת מענה — ' + openTotal + ' שיחות ממתינות' : 'לוח בקרת מענה — אין שיחות ממתינות');

  const sent = [];
  for (const email of targets) {
    const html = renderStaffReportHtml({
      data,
      recipientName: testEmail ? 'בדיקה' : nameForEmail(email),
      boardUrl: url,
    });
    const res = await sendFirmEmail({ to: email, subject, html });
    console.log(`[staff-report] email -> ${email}: ${res.sent ? 'SENT' : 'FAILED (' + res.reason + ')'} (${openTotal} open chat(s))`);
    sent.push({ email, ok: !!res.sent, reason: res.sent ? undefined : res.reason });
  }

  return {
    sent,
    counts: { recipients: targets.length, emailsSent: sent.filter((s) => s.ok).length, openTotal },
    windowDays,
    boardUrl: url,
  };
}

module.exports = { renderStaffReportHtml, sendStaffReport, reportRecipients, PORTAL_URL, BOARD_PATH };
