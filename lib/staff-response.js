// ============================================================
// lib/staff-response.js — staff response-time monitoring (Yaacov's dashboard).
//
//   buildStaffResponse({ windowDays=30 })
//     -> { generatedAt, windowDays, firm, staff:[...], firmLine, unassigned, crossCover:[...] }
//
// Everything is computed from the real ingested WhatsApp history in
// processing_jobs — no sampling. Two lenses, deliberately kept separate:
//
//   • RESPONSE TIME  — for every client message that opened an unanswered
//     streak, the time until the firm's FIRST reply. Attributed to WHOEVER
//     ACTUALLY REPLIED (sender phone -> staff), because that's real performance.
//     A reply from the shared Lawly line that can't be tied to a person is
//     bucketed under "firm line".
//
//   • OPEN LOAD      — chats still awaiting a reply right now, charged to the
//     monday "person in charge" (the assignee), because nobody has replied yet
//     so the assignee is who SHOULD. Reuses buildBoard() so it matches the board.
//
// "Firm reply" = a message with direction='out' OR whose sender phone is a
// staff member (staff often reply from their own phone inside a group, which
// arrives as an inbound message — same rule listUnansweredChats uses).
//
// ── 2026-08-20 change (Yaakov Epstein's request) ────────────────────────────
// There is NO response-time TARGET any more. The old "answer within 3 hours"
// SLA and everything derived from it (withinTargetPct / "% ביעד") is gone, as
// are the longest-wait figures (maxWaitHours / oldestHours). The measure is now
// purely comparative:
//
//     firm.medianSeconds      — one median across EVERY reply in the window
//     firm.teamMedianSeconds  — the median of the PEOPLE's medians
//     staff[].vsTeamPct       — how each person compares to the TEAM median,
//                               in percent (negative = faster, positive = slower)
//
// TWO NUMBERS, TWO QUESTIONS — this is deliberate (Shira, 2026-08-20):
//
//   firm.medianSeconds answers "how long does a CLIENT MESSAGE wait?". It is
//   volume-weighted, and it is the real client experience. It is the headline.
//
//   firm.teamMedianSeconds answers "what does a TYPICAL COLLEAGUE do?", and it
//   is what each person is compared against. It has to be a different number:
//   the message-weighted median is dominated by whoever answers most, so on the
//   firm's live data two people were 56% of all replies and four of six staff
//   came out "slower than the firm". A median OF PEOPLE puts roughly half the
//   team on each side by construction, which is what makes it a fair peer
//   comparison. Everyone with at least one reply counts toward it — no minimum.
//
//   The page must therefore never label both "המשרד". The headline is per
//   message; the column is "מול חציון הצוות" and shows the team median beside it.
//
// firm.medianSeconds comes from the SAME query as the per-person medians, via
// GROUP BY ROLLUP — computing it as a median of medians would answer the wrong
// question, and a second pass over processing_jobs would double the cost of the
// heaviest query on the page.
//
// Each staff row also carries `items` — the chats currently waiting on THAT
// person — so the dashboard can expand a row into an editable list without a
// second round trip. Attribution is by EMAIL (item.responsibleEmails), not by
// the display name: a chat routed to two people used to be filed under the
// joined string "A, B" and so appeared under neither of them.
//
// ── EXCLUDING PEOPLE FROM THE MEASUREMENT (Yaakov's request) ────────────────
// Anyone flagged `excludeFromStats: true` in config/staff-directory.json is left
// out of this report entirely: no row on the board, and their replies are
// dropped BEFORE the median is computed, so they do not move the firm number.
// `showFirmLine: false` does the same for the shared Lawly line.
//
// This is a MEASUREMENT flag, not a permission. Excluded people stay fully
// routable and stay in the "change responsible" list.
//
// The part that matters: a client message currently sitting with an excluded
// person must NOT vanish with them. Each such chat is re-attributed FOR DISPLAY
// to the monday person in charge; if that person is also excluded or unknown,
// to the default owner. The chat keeps its real assignee in `responsibleName`
// and carries `movedFromExcluded` naming who it was moved off, so the board
// never quietly relocates a message without saying so.
// ============================================================
const db = require('../db');
const { loadDirectory, defaultOwnerOf } = require('./routing');
const { buildBoard } = require('./unanswered-digest');
const { buildStaffMetrics } = require('./staff-metrics');

// last-9-digit form, same normalization as the staff directory / phone.js
function phone9(s) {
  let d = String(s == null ? '' : s).replace(/\D/g, '');
  if (d.startsWith('972')) d = d.slice(3);
  d = d.replace(/^0+/, '');
  return d.length >= 9 ? d.slice(-9) : d;
}

function fmtDur(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return null;
  const s = Math.max(0, Math.round(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h + ':' + String(m).padStart(2, '0'); // "1:18" = 1h 18m
}

// Median of a list of numbers. Even counts average the two middle values, the
// same convention percentile_cont(0.5) uses in Postgres, so the team median and
// the per-message median are computed the same way.
function medianOf(values) {
  const xs = (values || []).filter((v) => v != null && Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!xs.length) return null;
  const n = xs.length;
  return n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
}

// A consistency block for somebody who had nothing to answer in the window.
function emptyConsistency(spine) {
  return {
    days: (spine || []).map((date) => ({ date, opened: 0, sameDay: 0, stillOpen: 0 })),
    opened: 0, sameDay: 0, stillOpen: 0, sameDayPct: null, activeDays: 0, cleanDays: 0,
  };
}

function sameEmail(a, b) {
  return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// Response-time numbers now live in lib/staff-metrics.js — speed percentiles,
// the weekly trend, peak hours and per-day consistency all come from one
// materialised pass over the reply set. This file keeps what it was always
// best at: WHO belongs on the board, and where each waiting chat is shown.

// --- 2) Cross-cover: open chats whose latest firm replier != assignee --------
async function crossCover(pool, staff9) {
  const sql = `
    WITH last_firm AS (
      SELECT DISTINCT ON (chat_jid) chat_jid, sender_staff_phone9 AS ph9
      FROM processing_jobs
      WHERE source='whatsapp' AND sent_at IS NOT NULL AND sender_staff_phone9 IS NOT NULL
      ORDER BY chat_jid, sent_at DESC
    )
    SELECT g.name AS group_name, g.responsible_email, g.responsible_name, lf.ph9 AS active9
    FROM whatsapp_groups g
    JOIN last_firm lf ON lf.chat_jid = g.provider_group_jid
    WHERE g.removed_at IS NULL AND g.responsible_email IS NOT NULL AND g.responsible_email <> ''`;
  const r = await pool.query(sql, [staff9]);
  return r.rows;
}

// The shape the dashboard's expandable "הודעות ממתינות" panel needs for one
// chat. Deliberately the same field names the board page already uses, so the
// existing /api/board/status and /api/board/responsible endpoints accept it
// unchanged — no new write path, no new permission model.
function toPendingItem(it) {
  return {
    label: it.label,
    clientName: it.clientName || null,
    status: it.status,                        // required | potential | voice
    hoursWaiting: it.hoursWaiting,
    unansweredCount: it.unansweredCount || null,
    responsibleName: it.responsibleName || '',
    responsibleEmails: it.responsibleEmails || [],
    manualAssigned: !!it.manualAssigned,
    addressed: !!it.addressed,
    mondayEmail: it.mondayEmail || null,
    movedFromExcluded: null,   // set below when the assignee is off the board
    chatJid: it.chatJid,
  };
}

async function buildStaffResponse({ windowDays = 30, trendWeeks = 8, consistencyDays = 14 } = {}) {
  const generatedAt = new Date().toISOString();
  const dir = loadDirectory();
  const staff = (dir.staff || []);
  const staff9 = staff.map((s) => phone9(s.phone9)).filter(Boolean);
  const byPhone9 = new Map(staff.map((s) => [phone9(s.phone9), s]));

  // --- who is measured -----------------------------------------------------
  const norm = (e) => String(e == null ? '' : e).trim().toLowerCase();
  const excludedEmails = new Set(
    staff.filter((s) => s.excludeFromStats).map((s) => norm(s.email)).filter(Boolean)
  );
  const isExcluded = (email) => excludedEmails.has(norm(email));
  const measuredStaff = staff.filter((s) => !s.excludeFromStats);
  const included9 = measuredStaff.map((s) => phone9(s.phone9)).filter(Boolean);
  const includeFirmLine = dir.showFirmLine !== false;   // default true, off when set false
  const knownEmails = new Set(staff.map((s) => norm(s.email)).filter(Boolean));

  // Where a chat goes when its assignee is excluded and monday has nobody
  // usable. Guarded: if the default owner were ever excluded too, the chat
  // falls through to the "ללא אחראי" row rather than disappearing.
  const owner = defaultOwnerOf(dir);
  const fallbackEmail = owner && !isExcluded(owner.email) ? norm(owner.email) : null;

  const pool = db.getPool();
  const empty = { generatedAt, windowDays, trendWeeks, consistencyDays,
    firm: {}, staff: [], firmLine: null, unassigned: null, crossCover: [] };
  if (!pool) return empty;

  const [metrics, board, cover] = await Promise.all([
    buildStaffMetrics({ pool, windowDays, staff9, included9, includeFirmLine, trendWeeks, consistencyDays }),
    buildBoard().catch(() => ({ items: [] })),
    crossCover(pool, staff9).catch(() => []),
  ]);

  // Open load per person, from the live board (assignee lens), broken down by
  // status so each user shows how many are waiting under each bucket — and
  // carrying the chats themselves so a row can expand into an editable list.
  const blankStatus = () => ({ required: 0, potential: 0, voice: 0, pending: 0 });
  const openByEmail = new Map();   // lowercased email -> { open, byStatus, items }
  const unassigned = { open: 0, byStatus: blankStatus(), items: [] };
  const firmStatus = blankStatus();

  for (const it of (board.items || [])) {
    const item = toPendingItem(it);
    if (firmStatus[item.status] != null) firmStatus[item.status] += 1;

    // Re-attribute a chat that is sitting with an excluded person. The message
    // itself is untouched — only which row it is DISPLAYED under changes, and
    // the item says so out loud.
    let emails = (item.responsibleEmails || []).filter(Boolean);
    const kept = emails.filter((e) => !isExcluded(e));
    if (emails.length && !kept.length) {
      const movedFrom = item.responsibleName || emails.join(', ');
      const monday = norm(item.mondayEmail);
      if (monday && knownEmails.has(monday) && !isExcluded(monday)) {
        emails = [monday];                       // the monday person in charge
      } else if (fallbackEmail) {
        emails = [fallbackEmail];                // the default owner
      } else {
        emails = [];                             // -> "ללא אחראי" row
      }
      item.movedFromExcluded = movedFrom;
    } else {
      emails = kept;
    }

    if (!emails.length) {
      unassigned.open += 1;
      if (unassigned.byStatus[item.status] != null) unassigned.byStatus[item.status] += 1;
      unassigned.items.push(item);
      continue;
    }
    // A chat routed to two people shows on BOTH their lists — that is the
    // honest picture: either of them could still be the one who answers.
    for (const e of emails) {
      const key = String(e).trim().toLowerCase();
      const cur = openByEmail.get(key) || { open: 0, byStatus: blankStatus(), items: [] };
      cur.open += 1;
      if (cur.byStatus[item.status] != null) cur.byStatus[item.status] += 1;
      cur.items.push(item);
      openByEmail.set(key, cur);
    }
  }
  const byWaitDesc = (a, b) => (Number(b.hoursWaiting) || 0) - (Number(a.hoursWaiting) || 0);
  for (const load of openByEmail.values()) load.items.sort(byWaitDesc);
  unassigned.items.sort(byWaitDesc);

  const blankMetrics = {
    replies: 0, medianSeconds: null,
    within1hPct: null, within4hPct: null, within8hPct: null,
    within1h: 0, within4h: 0, within8h: 0,
    trend: [], hours: [], bestHour: null,
  };
  const rowFor = (m, load) => {
    const met = m || blankMetrics;
    return {
      open: load ? load.open : 0,
      byStatus: load ? load.byStatus : blankStatus(),
      items: load ? load.items : [],
      replies: met.replies,
      medianSeconds: met.medianSeconds,
      median: fmtDur(met.medianSeconds),
      within1hPct: met.within1hPct,
      within4hPct: met.within4hPct,
      within8hPct: met.within8hPct,
      within1h: met.within1h,
      within4h: met.within4h,
      within8h: met.within8h,
      trend: met.trend,
      hours: met.hours,
      bestHour: met.bestHour,
    };
  };

  // The per-MESSAGE median: what a typical client message waits. Headline only.
  const firmMedianSeconds = metrics.firm ? metrics.firm.medianSeconds : null;

  const staffRows = measuredStaff.map((s) => {
    const key = String(s.email || '').trim().toLowerCase();
    const base = rowFor(metrics.byPhone9.get(phone9(s.phone9)), openByEmail.get(key));
    // Consistency is charged to whoever OWNS the conversation, so it is keyed by
    // email — not by the phone that happened to send the reply.
    return Object.assign({ name: s.name, email: s.email }, base, {
      // Never null: somebody with a quiet fortnight gets a grey strip, not a
      // blank space that looks like the metric is broken.
      consistency: metrics.consistencyByEmail.get(key)
        || (metrics.consistencySpine ? emptyConsistency(metrics.consistencySpine) : null),
    });
  });

  // Anyone who ended up holding open chats but has no row yet gets one. This
  // catches the default owner (Shira is the fallback in staff-directory.json but
  // has no `staff` entry of her own, so she has no phone and no reply stats) and
  // any board address that is not in the directory at all. Without this sweep a
  // re-attributed chat could be filed under a key nothing renders — the exact
  // failure this whole change is meant to prevent.
  const consumed = new Set(measuredStaff.map((s) => norm(s.email)).filter(Boolean));
  for (const [email, load] of openByEmail) {
    if (consumed.has(email)) continue;
    const known = staff.find((s) => norm(s.email) === email);
    const name = known ? known.name
      : (fallbackEmail === email && owner ? owner.name : email);
    staffRows.push({
      name, email,
      open: load.open, byStatus: load.byStatus, items: load.items,
      replies: 0, medianSeconds: null, median: null, vsTeamPct: null,
      dist: { lt1h: 0, h1_3: 0, h3_24: 0, gt24h: 0 },
      notInDirectory: true,   // no phone in the directory -> no response-time stats
    });
  }

  // Shared-line replies (responder not tied to a staffer). Suppressed entirely
  // when showFirmLine is false — its replies were already left out of the SQL,
  // so returning a row here would show a median nothing was measured against.
  let firmLine = includeFirmLine ? rowFor(metrics.byPhone9.get(''), null) : null;

  // Chats the board could not route to any known staff email. Surfaced so they
  // are visible somewhere rather than silently missing from every row.
  const unassignedRow = unassigned.open
    ? { name: 'ללא אחראי', email: null, open: unassigned.open, byStatus: unassigned.byStatus, items: unassigned.items }
    : null;

  // ── The number people are compared against ───────────────────────────────
  // Median of the PEOPLE's medians. Everyone who actually replied counts, with
  // no minimum — Shira's call: a threshold would quietly drop a colleague out of
  // the baseline, and on a team this size that moves the number more than the
  // noise it was meant to remove.
  //
  // Rows with no median (nobody's replies in the window, or a leftover owner who
  // has no phone in the directory) contribute nothing — medianOf drops nulls.
  const teamMedianSeconds = medianOf(staffRows.map((r) => r.medianSeconds));

  // Percent difference from the TEAM median. Negative = faster than a typical
  // colleague. null when either side is missing, or when the team median is 0
  // (dividing by it would produce Infinity, which nobody can read).
  const vsTeam = (medianSeconds) => {
    if (medianSeconds == null || teamMedianSeconds == null || teamMedianSeconds <= 0) return null;
    return Math.round(((medianSeconds - teamMedianSeconds) / teamMedianSeconds) * 100);
  };
  for (const r of staffRows) r.vsTeamPct = vsTeam(r.medianSeconds);
  if (firmLine) firmLine.vsTeamPct = vsTeam(firmLine.medianSeconds);

  // Firm-wide summary.
  const fm = metrics.firm;
  const totalReplies = fm ? fm.replies : 0;
  const firm = {
    openTotal: (board.items || []).length,
    byStatus: firmStatus,                 // { required, potential, voice, pending }
    required: firmStatus.required,
    potential: firmStatus.potential,
    voice: firmStatus.voice,
    pending: firmStatus.pending,
    // per MESSAGE — the client experience. The headline number.
    medianSeconds: firmMedianSeconds,
    median: fmtDur(firmMedianSeconds),
    // per PERSON — the peer baseline every "מול חציון הצוות" percentage uses.
    teamMedianSeconds,
    teamMedian: fmtDur(teamMedianSeconds),
    teamSize: staffRows.filter((r) => r.medianSeconds != null).length,
    totalReplies,
    activeStaff: staffRows.filter((s) => s.replies > 0).length,
    // The five board metrics, firm-wide.
    within1hPct: fm ? fm.within1hPct : null,
    within4hPct: fm ? fm.within4hPct : null,
    within8hPct: fm ? fm.within8hPct : null,
    trend: fm ? fm.trend : [],
    hours: fm ? fm.hours : [],
    bestHour: fm ? fm.bestHour : null,
    consistency: metrics.consistencyFirm || null,
    consistencyUnattributed: metrics.consistencyUnattributed || 0,
    // Surfaced so the page can state plainly who is not in these numbers,
    // rather than leaving a reader to wonder why a name is missing.
    excluded: staff.filter((s) => s.excludeFromStats).map((s) => s.name),
    firmLineIncluded: includeFirmLine,
  };

  // Cross-cover -> only where active responder differs from the assignee.
  const crossCoverOut = [];
  for (const c of cover) {
    const active = byPhone9.get(c.active9);
    if (!active) continue;                                      // shared line / unknown — skip
    if (sameEmail(active.email, c.responsible_email)) continue;  // same person — not cross-cover
    crossCoverOut.push({
      group: c.group_name,
      assignee: c.responsible_name || c.responsible_email,
      active: active.name,
    });
  }

  return {
    generatedAt, windowDays, trendWeeks, consistencyDays, firm,
    staff: staffRows, firmLine, unassigned: unassignedRow, crossCover: crossCoverOut,
  };
}

module.exports = { buildStaffResponse, fmtDur };
