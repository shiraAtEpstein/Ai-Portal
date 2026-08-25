// ============================================================
// routes/unanswered.js — admin-only "unanswered client chats" endpoints.
//
//   GET  /api/admin/unanswered/whatsapp     -> preview, grouped by responsible person
//   POST /api/admin/unanswered/send-digest  -> build + send the digests now
//
// Deterministic: reads ingested WhatsApp data + the staff directory only. No
// Dropbox, no Claude, no dependency on the (blocked) summary processor.
// Admin-gated, same idiom as routes/whatsapp-groups.js.
//
// Scope: WhatsApp only. The email side (unanswered Gmail threads) is a later PR.
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const { authenticate, requireAdmin } = require('../lib/sessions');
const { buildDigest, sendDigests, buildBoard, invalidateBoardCache } = require('../lib/unanswered-digest');
const ingestDb = require('../whatsapp/ingest/db');
const db = require('../db');
const { loadDirectory, routeGroupToStaff } = require('../lib/routing');
const businessHours = require('../lib/business-hours');

const DEFAULT_HOURS = parseInt(process.env.UNANSWERED_HOURS || '3', 10);

function hoursFrom(req) {
  const raw = (req.query && req.query.hours) || (req.body && req.body.hours);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_HOURS;
}

// ---------------------------------------------------------------------------
// Board editing — status (נענה / לא דורש מענה) and אחראי
// ---------------------------------------------------------------------------

// Statuses live in config/board-statuses.json so labels can be changed without
// touching code. Cached in-process like the staff directory, so a restart picks
// up an edit. Falls back to the built-in set when the file is missing or
// malformed — a bad edit must never take the board down.
const FALLBACK_STATUSES = [
  { key: 'answered',        label: 'נענה',           icon: '✅', setBy: 'staff', clears: true },
  { key: 'no_reply_needed', label: 'לא דורש מענה',   icon: '⚪', setBy: 'staff', clears: true },
  { key: 'required',        label: 'ממתין למענה',    icon: '🔴', setBy: 'ai',    clears: false },
  { key: 'potential',       label: 'אולי דורש מענה', icon: '🟡', setBy: 'ai',    clears: false },
  { key: 'voice',           label: 'הודעה קולית',    icon: '🎤', setBy: 'ai',    clears: false },
];
let _statuses = null;
function loadStatuses() {
  if (_statuses) return _statuses;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'config', 'board-statuses.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed.statuses) ? parsed.statuses.filter((s) => s && s.key && s.label) : [];
    _statuses = list.length ? list : FALLBACK_STATUSES;
  } catch (e) {
    console.warn('[board] config/board-statuses.json unreadable, using built-in statuses:', e.message);
    _statuses = FALLBACK_STATUSES;
  }
  return _statuses;
}
// Only a staff-settable status that clears may be applied by hand. The AI
// statuses (ממתין למענה / אולי דורש / הודעה קולית) are produced by the triage and
// are deliberately NOT hand-settable — otherwise the board and the classifier
// would disagree and the next rebuild would silently undo the change.
function clearingStatus(key) {
  return loadStatuses().find((s) => s.key === key && s.setBy === 'staff' && s.clears) || null;
}

function sameEmail(a, b) {
  return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
function isAdminSession(req) {
  const roles = (req.session && req.session.roles) || [];
  return roles.some((r) => String(r).toLowerCase() === 'admin');
}

// A person may edit a chat if they are an admin, or if the board currently
// routes that chat to them. The check reuses the board itself (and its 45s
// cache) rather than re-deriving the routing here, so "who is this assigned to"
// has exactly one definition and the two can never disagree.
async function findBoardItem(chatJid) {
  const board = await buildBoard();
  return (board.items || []).find((i) => i.chatJid === chatJid) || null;
}
async function assertMayEdit(req, chatJid) {
  const item = await findBoardItem(chatJid);
  if (isAdminSession(req)) return { ok: true, item };
  if (!item) return { ok: false, code: 404, message: 'השיחה לא נמצאה ברשימה.' };
  const mine = (item.responsibleEmails || []).some((e) => sameEmail(e, req.session && req.session.email));
  if (!mine) return { ok: false, code: 403, message: 'רק האחראי על השיחה או מנהל יכולים לעדכן אותה.' };
  return { ok: true, item };
}

// Fire-and-forget audit line. Never blocks or fails the request.
function audit(req, action, targetName, metadata) {
  try {
    db.writeAudit({
      actorId: req.session && req.session.userId,
      actorName: (req.session && (req.session.name || req.session.email)) || null,
      action,
      targetType: 'whatsapp_chat',
      targetName,
      metadata: metadata || {},
    }).catch(() => {});
  } catch (_) { /* auditing must never break the action */ }
}

module.exports = function createUnansweredRouter() {
  const router = express.Router();

  // Preview Shira opens to see real results before any email goes out.
  router.get('/api/admin/unanswered/whatsapp', authenticate, requireAdmin, async (req, res) => {
    try {
      const hours = hoursFrom(req);
      const digest = await buildDigest({ hours });
      res.json({
        hours: digest.hours,
        generatedAt: digest.generatedAt,
        total: digest.all.length,
        byPerson: digest.byPerson,
        all: digest.all,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to build unanswered list.', detail: e.message });
    }
  });

  // Diagnostic: does the firm SENDER token (GMAIL_REFRESH_TOKEN) still work?
  // Reads the GMAIL_* env vars, asks Google for an access token exactly like
  // lib/firm-mailer does, and returns Google's RAW answer so we can see the
  // real words ("invalid_grant: Token has been expired or revoked", etc.).
  // Never returns any secret value or the access token itself. Sends no email.
  router.get('/api/admin/mail-health', authenticate, requireAdmin, async (req, res) => {
    const clientId = process.env.GMAIL_CLIENT_ID || '';
    const clientSecret = process.env.GMAIL_CLIENT_SECRET || '';
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN || '';
    const present = {
      GMAIL_CLIENT_ID: !!clientId,
      GMAIL_CLIENT_SECRET: !!clientSecret,
      GMAIL_REFRESH_TOKEN: !!refreshToken,
      EMAIL_FROM: !!(process.env.EMAIL_FROM || ''),
    };
    // A quick fingerprint (NOT the secret) so we can tell if a value looks empty
    // or truncated without ever printing it: length + last 6 chars of the client id.
    const clientIdTail = clientId ? ('…' + clientId.slice(-6)) : null;
    if (!clientId || !clientSecret || !refreshToken) {
      return res.json({ ok: false, stage: 'config', present, clientIdTail,
        message: 'One or more GMAIL_* env vars are missing in Render.' });
    }
    try {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const google = await resp.json().catch(() => ({}));
      const ok = resp.ok && !!google.access_token;
      return res.json({
        ok,
        stage: 'token',
        httpStatus: resp.status,             // 200 = good, 400/401 = rejected
        googleError: google.error || null,             // e.g. "invalid_grant"
        googleErrorDescription: google.error_description || null, // Google's words
        gotAccessToken: !!google.access_token,         // true = token is ALIVE
        present,
        clientIdTail,
      });
    } catch (e) {
      return res.json({ ok: false, stage: 'network', message: e.message, present, clientIdTail });
    }
  });

  // Backfill: resolve still-unresolved WhatsApp contacts to their monday CLIENT
  // by phone (same match the ingest path does). Run this BEFORE relink — it's
  // what lets relink then find each group's deal via its now-resolved client.
  //   POST /api/admin/unanswered/resolve-clients?limit=500  -> run until remaining stops dropping
  router.post('/api/admin/unanswered/resolve-clients', authenticate, requireAdmin, async (req, res) => {
    try {
      const { resolveUnresolvedContacts } = require('../lib/resolve-contacts');
      const limit = parseInt((req.query && req.query.limit) || '500', 10);
      const result = await resolveUnresolvedContacts({ limit });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: 'Resolve-clients failed.', detail: e.message });
    }
  });

  // Re-link a batch of still-unlinked groups to their monday deal + responsible,
  // on demand (rebuilds links without waiting for new messages).
  //   POST /api/admin/unanswered/relink?limit=25   -> run again until remaining=0
  router.post('/api/admin/unanswered/relink', authenticate, requireAdmin, async (req, res) => {
    try {
      const { relinkUnlinked } = require('../lib/relink');
      const limit = parseInt((req.query && req.query.limit) || '25', 10);
      const result = await relinkUnlinked({ limit });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: 'Relink failed.', detail: e.message });
    }
  });

  // Control board (verification): every currently-unanswered chat with status,
  // wait time, and who's in charge. Answered chats aren't here.
  router.get('/api/admin/unanswered/board', authenticate, requireAdmin, async (req, res) => {
    try {
      const board = await buildBoard();
      res.json(board);
    } catch (e) {
      res.status(500).json({ error: 'Failed to build board.', detail: e.message });
    }
  });

  // Management dashboard data: live "waiting now" numbers (consistent with the
  // digest/page) + historical response-time stats.
  //   GET /api/admin/unanswered/dashboard?days=30
  router.get('/api/admin/unanswered/dashboard', authenticate, requireAdmin, async (req, res) => {
    try {
      const dir = loadDirectory();
      const staffPhones = (dir.staff || []).map((s) => s.phone9).filter(Boolean);
      const dRaw = parseInt((req.query && req.query.days) || '30', 10);
      const days = Math.min(Math.max(Number.isFinite(dRaw) ? dRaw : 30, 1), 180);

      // Live: everything currently waiting (hours=0), same source as the page.
      const chats = await ingestDb.listUnansweredChats({ hours: 0, staffPhones });
      let oldest = 0;
      // These describe HOW LONG A MESSAGE HAS BEEN SITTING THERE, so they use
      // real elapsed time — the same clock as the words on every list. The
      // working clock belongs to the SPEED figures below (history), which is
      // why the two are labelled apart on the page.
      const aging = { lt3: 0, h3to24: 0, gt24: 0 };
      const perStaff = {};
      for (const c of chats) {
        const h = Number(c.calendarHoursWaiting) || 0;
        if (h > oldest) oldest = h;
        if (h < 3) aging.lt3++; else if (h < 24) aging.h3to24++; else aging.gt24++;
        const { responsible } = routeGroupToStaff(c.participant_phones, dir);
        for (const person of responsible) perStaff[person.name] = (perStaff[person.name] || 0) + 1;
      }
      const perStaffArr = Object.entries(perStaff)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      const history = await ingestDb.responseStats({ days, staffPhones });

      res.json({
        days,
        live: {
          waitingNow: chats.length,
          oldestHours: Math.round(oldest * 10) / 10,
          aging,
          perStaff: perStaffArr,
        },
        clockLabel: businessHours.config().label,
        workingDayHours: businessHours.config().workingDayHours,
        history,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to build dashboard.', detail: e.message });
    }
  });

  // Testing aid: the most recent ingested WhatsApp messages (read-only, no text).
  //   GET /api/admin/unanswered/ingest-recent?limit=40&chat=teller
  // Lets you send a WhatsApp message and confirm it landed with the right
  // direction ('in' = client, 'out' = LAWLY line) and time.
  router.get('/api/admin/unanswered/ingest-recent', authenticate, requireAdmin, async (req, res) => {
    try {
      const limit = parseInt((req.query && req.query.limit) || '40', 10);
      const chat = (req.query && req.query.chat) || null;
      const rows = await ingestDb.listRecentJobs({ limit, chatLike: chat });
      res.json({ count: rows.length, rows });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read recent ingest.', detail: e.message });
    }
  });

  // Manual trigger: build + send the digests right now.
  router.post('/api/admin/unanswered/send-digest', authenticate, requireAdmin, async (req, res) => {
    try {
      const hours = hoursFrom(req);
      // ?to=someone@epsteinlaw.co.il -> TEST MODE: send only there (no staff).
      const testEmail = (req.query && req.query.to) || (req.body && req.body.to) || null;
      const result = await sendDigests({ hours, testEmail });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: 'Failed to send digests.', detail: e.message });
    }
  });

  // -------------------------------------------------------------------------
  // Board editing. Any signed-in user may CALL these; the per-chat permission
  // (assignee or admin) is enforced inside each handler by assertMayEdit.
  // -------------------------------------------------------------------------

  // What the board UI needs to draw its two dropdowns: the status list and the
  // staff list. No chat data, so it is safe for any signed-in user.
  router.get('/api/board/meta', authenticate, async (req, res) => {
    try {
      const dir = loadDirectory();
      res.json({
        isAdmin: isAdminSession(req),
        email: (req.session && req.session.email) || null,
        statuses: loadStatuses().map((s) => ({
          key: s.key,
          label: s.label,
          icon: s.icon || '',
          setBy: s.setBy || 'ai',
          clears: !!s.clears,
          help: s.help || '',
        })),
        staff: (dir.staff || [])
          .filter((s) => s.email)
          .map((s) => ({ name: s.name, email: s.email })),
        // The working clock the SPEED figures are measured on. The wait shown
        // against each row is real elapsed time (item.waitedLabel) — these two
        // are different questions, and the pages say which is which. Sent from
        // the server so a page can never state a policy the server is not
        // actually applying.
        clock: {
          label: businessHours.config().label,
          startHour: businessHours.config().startHour,
          endHour: businessHours.config().endHour,
          workingNow: businessHours.isWorkingNow(),
        },
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to load board metadata.', detail: e.message });
    }
  });

  // -------------------------------------------------------------------------
  // WILL THE DAILY EMAIL GO OUT, WHEN, AND TO WHOM? — read-only, admin only.
  //
  //   GET /api/admin/unanswered/schedule
  //
  // The answer lives in environment variables on Render, which nobody can see
  // from the portal — so "is the digest live or still in test mode?" has been a
  // question only the server logs could answer, and only at 08:00. This says it
  // on demand, and it resolves the ACTUAL recipient list rather than describing
  // the rule: who would get an email right now, with how many chats each.
  //
  // Nothing is sent. The recipient names come from config/staff-directory.json,
  // and no chat labels or message text are returned — only counts.
  // -------------------------------------------------------------------------
  router.get('/api/admin/unanswered/schedule', authenticate, requireAdmin, async (req, res) => {
    try {
      const dir = loadDirectory();
      const testEmail = String(process.env.UNANSWERED_TEST_EMAIL || '').trim() || null;
      const num = (v, d) => { const n = parseInt(v || '', 10); return Number.isFinite(n) && n >= 0 ? n : d; };
      const hours = testEmail ? num(process.env.UNANSWERED_TEST_HOURS, 0) : num(process.env.UNANSWERED_HOURS, 3);
      // The real slots, from config/digest-schedule.json via the scheduler, so
      // this page cannot describe a timetable the scheduler is not running.
      let slots = [];
      try { slots = require('../lib/scheduler').digestSlots(); } catch (_) { slots = []; }
      const times = slots.map((x) => x.at);
      const describe = (x) => x.at + ' → ' + (x.to === 'everyone'
        ? ('כל מי שיש לו משהו ממתין' + (x.except && x.except.length ? ' חוץ מ-' + x.except.join(', ') : ''))
        : x.to.join(', '));

      // Build the digest exactly as the 08:00 run would, so the preview cannot
      // drift from what actually gets sent.
      const digest = await buildDigest({ hours });
      const owner = (dir.staff || []).find((s) => s.email === dir.defaultOwnerEmail);
      const partner = (dir.staff || []).find((s) => s.inAllGroups) || null;
      const fullList = new Set([dir.defaultOwnerEmail].concat(partner ? [partner.email] : []));

      const recipients = [];
      for (const [email, entry] of Object.entries(digest.byPerson)) {
        if (fullList.has(email)) continue;
        recipients.push({ email, name: entry.name, count: entry.items.length, list: 'their own' });
      }
      for (const email of fullList) {
        const person = (dir.staff || []).find((s) => s.email === email);
        recipients.push({
          email,
          name: person ? person.name : (owner ? owner.name : ''),
          count: digest.all.length,
          list: 'the whole firm',
        });
      }
      const willSend = recipients.filter((r) => r.count > 0);

      res.json({
        mode: testEmail ? 'TEST' : 'LIVE',
        // The one sentence that matters, in plain language, so nobody has to
        // interpret the fields below.
        summary: testEmail
          ? `TEST MODE — the ${times.join(', ')} run emails ONLY ${testEmail}, with a "[בדיקה]" subject. No member of staff receives anything. Remove UNANSWERED_TEST_EMAIL on Render to go live.`
          : `LIVE — ${slots.map(describe).join('  |  ')} (Asia/Jerusalem). Each person gets their own list; ${[...fullList].join(' and ')} get the whole firm's. The 08:00 run would send ${willSend.length} email(s) right now.`,
        timesLocal: times,
        // Said in words, because "08:00, 13:15" does not tell you that the
        // second one goes to one person only.
        schedule: slots.map(describe),
        timezone: 'Asia/Jerusalem',
        thresholdHours: hours,
        thresholdMeaning: 'a chat appears once the client has waited this many REAL hours (not working hours) — so an overnight message is still in the 08:00 list',
        testEmail,
        recipients: recipients.sort((a, b) => b.count - a.count),
        wouldSendNow: willSend.length,
        skippedBecauseEmpty: recipients.length - willSend.length,
        note: 'Sending goes through the Gmail API — check /api/admin/mail-health if a run reports failures.',
      });
    } catch (e) {
      console.error('[unanswered/schedule] failed:', e.message);
      res.status(500).json({ error: 'could not read the schedule', detail: e.message });
    }
  });

  // -------------------------------------------------------------------------
  // WHY DOES THIS CHAT SAY THAT? — read-only, admin only.
  //
  //   GET /api/admin/unanswered/why?chat=weinstein
  //
  // Added after a row read "waiting 12 days" on a conversation that had plainly
  // been answered that morning. The wait is measured from the oldest message
  // the firm has not replied to, so an impossible number always means the same
  // thing: something the detector is not counting as a firm reply. Reading the
  // code cannot say WHICH thing — only the rows can.
  //
  // Returns what each message IS (kind, side, sender, timestamp source), never
  // what it says, with phones masked to the last three digits.
  // -------------------------------------------------------------------------
  router.get('/api/admin/unanswered/why', authenticate, requireAdmin, async (req, res) => {
    try {
      const chat = String((req.query && req.query.chat) || '').trim();
      if (!chat) return res.status(400).json({ error: 'Add ?chat=<part of the group name>' });
      const dir = loadDirectory();
      const staffPhones = (dir.staff || []).map((s) => s.phone9).filter(Boolean);
      const out = await ingestDb.diagnoseChat({
        chatLike: chat,
        limit: parseInt((req.query && req.query.limit) || '25', 10),
        staffPhones,
      });
      res.json(Object.assign({
        // Said out loud, because it is the most common cause and it is invisible
        // from the board: anyone answering from a phone that is not in this list
        // is read as a CLIENT, and their reply never closes the wait.
        staffDirectory: (dir.staff || []).map((s) => ({ name: s.name, phone9: s.phone9 })),
      }, out));
    } catch (e) {
      console.error('[unanswered/why] failed:', e.message);
      res.status(500).json({ error: 'diagnosis failed', detail: e.message });
    }
  });

  // -------------------------------------------------------------------------
  // THE PERSONAL BOARD — "הוואטסאפים שלי" (public/messages.html).
  //
  // The same board every admin sees, cut down to the chats routed to the
  // signed-in person. The cut is made HERE, on the server, before the JSON
  // leaves: a page that merely hides other people's rows is not a permission,
  // it is a suggestion, and the JSON is one devtools tab away. (Same reasoning
  // as scopeToSelf() in routes/staff-response.js.)
  //
  // "Routed to me" is EXACTLY the board's own definition — item.responsibleEmails
  // — which is also what assertMayEdit checks before allowing an edit, and what
  // the daily email routes on. One definition, so the page, the email and the
  // permission can never disagree about whose message this is.
  //
  // ?scope=all gives the whole firm and is ADMIN ONLY; anyone else asking for it
  // is refused rather than quietly downgraded, because silently returning a
  // different list than the one requested is how a page ends up lying about
  // what it is showing.
  // -------------------------------------------------------------------------
  router.get('/api/me/board', authenticate, async (req, res) => {
    try {
      const email = (req.session && req.session.email) || null;
      const admin = isAdminSession(req);
      const wantsAll = String((req.query && req.query.scope) || 'mine').toLowerCase() === 'all';
      if (wantsAll && !admin) {
        return res.status(403).json({ error: 'תצוגת כל המשרד פתוחה למנהלים בלבד.' });
      }

      const board = await buildBoard();
      const all = board.items || [];
      const items = wantsAll
        ? all
        : all.filter((it) => (it.responsibleEmails || []).some((e) => sameEmail(e, email)));

      res.json({
        email,
        isAdmin: admin,
        scope: wantsAll ? 'firm' : 'mine',
        // How many the person would see in the other view. Lets an admin's
        // toggle show a real number instead of loading the board twice.
        firmTotal: admin ? all.length : null,
        count: items.length,
        items,
        generatedAt: board.generatedAt,
      });
    } catch (e) {
      console.error('[board] personal board failed:', e.message);
      res.status(500).json({ error: 'לא ניתן לטעון את הרשימה כרגע.', detail: e.message });
    }
  });

  // Set a chat's status by hand. Only the staff-settable, clearing statuses are
  // accepted (נענה / לא דורש מענה); both remove the chat from the list, and the
  // key is stored as the dismissal reason so the admin view can show WHY.
  // A chat re-appears by itself if the client writes again afterwards.
  router.post('/api/board/status', authenticate, async (req, res) => {
    try {
      const chatJid = String((req.body && req.body.chatJid) || '').trim();
      const status = String((req.body && req.body.status) || '').trim();
      if (!chatJid) return res.status(400).json({ error: 'chatJid חסר.' });
      const st = clearingStatus(status);
      if (!st) return res.status(400).json({ error: 'סטטוס לא חוקי (ניתן לקבוע ידנית רק סטטוס שמסיר מהרשימה).' });

      const gate = await assertMayEdit(req, chatJid);
      if (!gate.ok) return res.status(gate.code).json({ error: gate.message });

      await ingestDb.dismissChat(chatJid, (req.session && req.session.email) || null, st.key);
      invalidateBoardCache();
      audit(req, 'whatsapp.board.status', (gate.item && gate.item.label) || chatJid, { chatJid, status: st.key });
      res.json({ ok: true, chatJid, status: st.key, label: st.label });
    } catch (e) {
      res.status(500).json({ error: 'Failed to set status.', detail: e.message });
    }
  });

  // Reassign the אחראי. Stored as a portal-side override that always beats the
  // monday-derived value; monday itself is never written to. An empty email
  // removes the override and returns the chat to automatic resolution.
  router.post('/api/board/responsible', authenticate, async (req, res) => {
    try {
      const chatJid = String((req.body && req.body.chatJid) || '').trim();
      const email = String((req.body && req.body.email) || '').trim();
      if (!chatJid) return res.status(400).json({ error: 'chatJid חסר.' });

      const gate = await assertMayEdit(req, chatJid);
      if (!gate.ok) return res.status(gate.code).json({ error: gate.message });

      // Only a known staff member may be assigned — never a free-text address.
      let person = null;
      if (email) {
        const dir = loadDirectory();
        person = (dir.staff || []).find((s) => sameEmail(s.email, email)) || null;
        if (!person) return res.status(400).json({ error: 'לא נמצא איש צוות עם הכתובת הזו.' });
      }

      await ingestDb.setResponsibleOverride(
        chatJid,
        person ? person.email : null,
        person ? person.name : null,
        (req.session && req.session.email) || null
      );
      invalidateBoardCache();
      audit(req, person ? 'whatsapp.board.reassign' : 'whatsapp.board.reassign_clear',
        (gate.item && gate.item.label) || chatJid,
        { chatJid, to: person ? person.email : null });
      res.json({ ok: true, chatJid, responsibleName: person ? person.name : null, cleared: !person });
    } catch (e) {
      res.status(500).json({ error: 'Failed to set responsible.', detail: e.message });
    }
  });

  // Audit view: what was cleared from the board, by whom, when and why. Because
  // clearing is permanent until the client writes again, an admin must always be
  // able to see what left the list — and put it back.
  router.get('/api/admin/unanswered/dismissed', authenticate, requireAdmin, async (req, res) => {
    try {
      const limit = parseInt((req.query && req.query.limit) || '100', 10);
      const rows = await ingestDb.listDismissals({ limit });
      const byKey = new Map(loadStatuses().map((s) => [s.key, s]));
      res.json({
        count: rows.length,
        rows: rows.map((r) => ({
          ...r,
          reasonLabel: r.reason && byKey.has(r.reason) ? byKey.get(r.reason).label : (r.reason || 'לא ידוע'),
        })),
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to list dismissed chats.', detail: e.message });
    }
  });

  // Undo a clear — puts the chat straight back on the board. Admin only.
  router.post('/api/admin/unanswered/restore', authenticate, requireAdmin, async (req, res) => {
    try {
      const chatJid = String((req.body && req.body.chatJid) || (req.query && req.query.chatJid) || '').trim();
      if (!chatJid) return res.status(400).json({ error: 'chatJid חסר.' });
      const restored = await ingestDb.undismissChat(chatJid, (req.session && req.session.email) || null);
      invalidateBoardCache();
      audit(req, 'whatsapp.board.restore', chatJid, { chatJid, restored });
      res.json({ ok: true, chatJid, restored });
    } catch (e) {
      res.status(500).json({ error: 'Failed to restore chat.', detail: e.message });
    }
  });

  return router;
};
