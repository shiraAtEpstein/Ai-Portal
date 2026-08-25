// ============================================================
// lib/staff-metrics.js — every NUMBER on the staff response board.
//
//   buildStaffMetrics({ pool, windowDays, staffPairs, includedEmails,
//                       includeFirmLine, trendWeeks, consistencyDays })
//
// lib/staff-response.js owns WHO appears on the board. This file owns WHAT IS
// MEASURED.
//
// ── THE CORRECTION THAT SHAPED THIS FILE (Shira, 2026-08-23) ────────────────
// The first version measured only conversations that GOT a reply. A person who
// answered once in a minute and left twenty messages rotting scored a 0:01
// median and 100% within the hour. That is survivorship bias, and worse, it is
// a metric you improve by ignoring the hard messages.
//
// So an UNANSWERED conversation now counts too, at the time it has been waiting
// so far. Attribution follows Shira's rule exactly:
//
//     answered   -> charged to WHOEVER REPLIED   (real performance)
//     unanswered -> charged to the ASSIGNEE      (nobody replied, so it is
//                                                 whoever should have)
//
// A still-waiting conversation contributes its CURRENT wait, which is a lower
// bound on its eventual latency — the number can only be better than the truth,
// never flattering. Every card therefore also shows how many of its
// conversations are still open, so the median is never read as pure history.
//
// ── AND THE SECOND CORRECTION ───────────────────────────────────────────────
// Consistency used to ask "what opened today". Shira's point: that is the wrong
// question — what matters is whether the day ENDED with nothing waiting on you.
// So a day is now scored on what was still open at 23:59 local, whenever it
// arrived. An eleven-day-old unanswered message darkens EVERY day it survives,
// which is the whole point.
//
// ── WHAT DOES NOT COUNT AS "WAITING" ────────────────────────────────────────
// A conversation whose client messages were ALL classified 'none' by the triage
// ("תודה", "מעולה", plain FYI) is not waiting on anybody, and charging it to a
// person would penalise them for politeness. A message the triage has not
// reached yet stays flagged — the same fail-safe the digest uses.
//
// The two hand-set statuses are NOT the same thing, and are not treated alike:
//
//   "לא דורש מענה"  -> a human correcting the triage. It never was a task, so it
//                      counts NOWHERE — including the days before somebody got
//                      round to marking it. Marking it fixes the past too.
//   "נענה"           -> it DID need a reply and a person handled it, usually off
//                      WhatsApp. That wait was real, so it counts up to the
//                      moment it was cleared.
//
// ── WHY THE AGGREGATION IS IN JAVASCRIPT ────────────────────────────────────
// Two raw queries, then all the arithmetic here. The alternative — aggregating
// in SQL — cannot merge the two attribution rules into one median without
// duplicating the assignee-resolution logic inside the query. At this volume
// (a few hundred replies a month) raw rows are free, and every number below is
// then testable without a database.
// ============================================================
const TZ = 'Asia/Jerusalem';
// ── THE WORKING CLOCK (Shira, 2026-08-24) ──────────────────────────────────
// Every latency below is WORKING seconds — 08:00–22:00, Saturday excluded —
// not wall-clock seconds. See lib/business-hours.js for the policy and why the
// arithmetic is in JavaScript rather than in these queries.
//
// The consequence, said out loud because somebody will compare: medians fall
// and the "within 1h/4h/8h" shares rise. Numbers from before this change are
// not comparable with numbers after it. That is the intended behaviour — a
// message that arrived at 23:00 and was answered at 08:20 is a twenty-minute
// reply, and the old figures said nine hours.
const businessHours = require('./business-hours');
// Defaulted, because these files are deployed ONE AT A TIME through the GitHub
// web UI. If this module lands before the matching whatsapp/ingest/db.js, the
// imports are undefined — and without the guard the whole file threw at require
// time and took every page that needs it down with it. An empty list just means
// "exclude nothing", which is the fail-open direction anyway.
const ingestKinds = require('../whatsapp/ingest/db');
const REACTION_KINDS = ingestKinds.REACTION_KINDS || [];
const SYSTEM_KINDS = ingestKinds.SYSTEM_KINDS || [];
// Rendered as SQL lists from our own constants — no user input reaches them.
// A NOT IN () with an empty list is a syntax error, so an empty list has to
// become a value nothing can equal rather than an empty parenthesis.
const sqlList = (a) => (a.length ? a.map((k) => "'" + k.replace(/'/g, "''") + "'").join(', ') : "'__none__'");
const REACTION_SQL = sqlList(REACTION_KINDS);
const SYSTEM_SQL = sqlList(SYSTEM_KINDS);

// A "waiting streak" is one or more consecutive client messages with no firm
// message among them. Its latency runs from the FIRST of those messages to the
// firm's first reply. firm_cnt is a running count of firm messages in the chat,
// so all messages of one streak share a firm_cnt.
//
// "Firm message" = direction 'out' (the Lawly line) OR a sender resolved to a
// staff phone — staff often reply from their own handset inside a group, which
// arrives as an inbound message. Same rule listUnansweredChats uses.
const STREAKS = `
  WITH base AS (
    -- eff_at: the real WhatsApp send time when we have it, else the moment we
    -- ingested it. EXACTLY what listUnansweredChats uses for the board.
    -- Requiring sent_at here made every message still waiting for the
    -- backfill invisible to the metrics while it was visible on the board.
    SELECT chat_jid,
           COALESCE(sent_at, created_at) AS sent_at,
           sender_staff_phone9 AS ph9,
           client_category,
           (sender_staff_phone9 IS NOT NULL OR direction = 'out') AS is_firm
    FROM processing_jobs
    WHERE source = 'whatsapp' AND COALESCE(sent_at, created_at) IS NOT NULL
      -- Same rule as the board (whatsapp/ingest/db.js), and it must stay the
      -- same or the medians and the board will disagree about which
      -- conversations were ever waiting.
      --   system records: never counted, from either side.
      --   reactions:      a STAFFER's 👍 counts — it ends a waiting streak, it
      --                   is the firm answering. A CLIENT's does not open one.
      -- NULL (not yet classified) still counts, on both sides.
      AND (msg_kind IS NULL OR msg_kind NOT IN (${SYSTEM_SQL}))
      AND (
        sender_staff_phone9 IS NOT NULL OR direction = 'out'
        OR msg_kind IS NULL OR msg_kind NOT IN (${REACTION_SQL})
      )
  ),
  grp AS (
    SELECT *,
      SUM(CASE WHEN is_firm THEN 1 ELSE 0 END)
        OVER (PARTITION BY chat_jid ORDER BY sent_at ROWS UNBOUNDED PRECEDING) AS firm_cnt,
      LAG(is_firm) OVER (PARTITION BY chat_jid ORDER BY sent_at) AS prev_is_firm
    FROM base
  ),
  streak AS (
    SELECT chat_jid, firm_cnt, MIN(sent_at) AS opened_at,
           -- Does this streak actually need answering? The triage classifies each
           -- client message (client_category): 'none' is a closer — "תודה",
           -- "מעולה", pure FYI. A streak where EVERY message is a closer needs no
           -- reply, and counting it as "unanswered" would punish people for
           -- politeness. Anything not yet classified stays flagged: the same
           -- fail-safe the digest uses — never guess a message away.
           bool_or(COALESCE(client_category, 'unclassified') <> 'none') AS needs_reply
    FROM grp WHERE NOT is_firm
    GROUP BY chat_jid, firm_cnt
  ),
  answered AS (
    SELECT s.chat_jid, s.firm_cnt, s.opened_at,
           g.sent_at AS replied_at,
           g.ph9     AS responder_ph9
    FROM streak s
    JOIN grp g ON g.chat_jid = s.chat_jid AND g.firm_cnt = s.firm_cnt + 1
              AND g.is_firm AND g.prev_is_firm = false
  ),
  conv AS (
    SELECT s.chat_jid, s.opened_at, s.needs_reply, a.replied_at, a.responder_ph9
    FROM streak s
    LEFT JOIN answered a ON a.chat_jid = s.chat_jid AND a.firm_cnt = s.firm_cnt
  )`;

// ---------------------------------------------------------------- small maths

function median(values) {
  const xs = (values || []).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const n = xs.length;
  return n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
}
function share(values, seconds) {
  const xs = (values || []).filter((v) => v != null && Number.isFinite(v));
  if (!xs.length) return { count: 0, pct: null };
  const c = xs.filter((v) => v <= seconds).length;
  return { count: c, pct: Math.round((c / xs.length) * 100) };
}

// The last N calendar dates in the firm's timezone, oldest first, as 'YYYY-MM-DD'.
// Built here rather than in the browser: somebody opening the board from abroad
// must still see the firm's days.
function localDateSpine(n) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const out = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(fmt.format(new Date(now - i * 86400000)));
  return out;
}
// ISO dates compare correctly as plain strings, which is why every date below
// crosses the SQL boundary already rendered in the firm's timezone. No timezone
// arithmetic happens in JavaScript at all.
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d == null ? null : String(d)));

// ---------------------------------------------------------------------------
// Q1 — every ANSWERED conversation in the window, one row each.
// ---------------------------------------------------------------------------
async function fetchAnswered(pool, windowDays) {
  // The two raw instants come back untouched and the subtraction happens in
  // JavaScript, because it is no longer a subtraction: it is an integration
  // over the firm's open hours. Doing it here keeps ONE definition of a wait
  // for the board, the email and this file — see lib/business-hours.js.
  const r = await pool.query(`
    ${STREAKS}
    SELECT responder_ph9,
           opened_at,
           replied_at,
           date_trunc('week', replied_at AT TIME ZONE '${TZ}')::date      AS week,
           EXTRACT(HOUR FROM replied_at AT TIME ZONE '${TZ}')::int        AS reply_hour
    FROM conv
    WHERE replied_at IS NOT NULL
      AND replied_at >= now() - ($1::int * interval '1 day')`, [windowDays]);
  return r.rows.map((row) => ({
    ph9: row.responder_ph9 || '',              // '' = the shared Lawly line
    latency: businessHours.businessSecondsBetween(row.opened_at, row.replied_at),
    week: isoDate(row.week),
    hour: Number(row.reply_hour),   // the hour the REPLY went out
  }));
}

// ---------------------------------------------------------------------------
// Q2 — every conversation with an ASSIGNEE, answered or not.
//
// A conversation stops counting when it is answered OR when somebody cleared it
// by hand on the board ("נענה" / "לא דורש מענה" write unanswered_dismissals).
// Without the dismissal join a chat somebody had already handled would go on
// darkening their days forever.
//
// Still-open conversations are included regardless of age: an eleven-day-old
// unanswered message is exactly what this is meant to surface.
// ---------------------------------------------------------------------------
async function fetchOwned(pool, days) {
  const r = await pool.query(`
    ${STREAKS}
    SELECT lower(trim(COALESCE(ovr.email, wg.responsible_email)))          AS owner_email,
           c.opened_at                                                     AS opened_at,
           to_char((COALESCE(c.replied_at, dis.dismissed_at)) AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS closed_date,
           (c.replied_at IS NULL AND dis.dismissed_at IS NULL AND c.needs_reply) AS still_open
    FROM conv c
    LEFT JOIN chat_responsible_override ovr ON ovr.chat_jid = c.chat_jid
    LEFT JOIN whatsapp_groups wg
           ON wg.provider_group_jid = c.chat_jid AND wg.removed_at IS NULL
    LEFT JOIN unanswered_dismissals dis ON dis.chat_jid = c.chat_jid
    WHERE (c.replied_at IS NOT NULL OR c.needs_reply)
      -- A conversation somebody marked "לא דורש מענה" by hand never needed
      -- answering at all — the triage got it wrong and a human corrected it.
      -- It must therefore count NOWHERE, including on the days before anyone
      -- got round to marking it. Dropping it only from the day it was cleared
      -- would still darken those earlier days for a message that was never a
      -- task.
      --
      -- "נענה" is different: that conversation DID need a reply and a person
      -- handled it (often by phone). The wait until they cleared it was real,
      -- so it keeps counting up to the moment it was marked.
      AND COALESCE(dis.reason, '') <> 'no_reply_needed'
      AND (c.opened_at >= now() - ($1::int * interval '1 day')
           OR (c.replied_at IS NULL AND dis.dismissed_at IS NULL))`, [days]);

  return r.rows.map((row) => ({
    owner: row.owner_email || '',              // '' = no assignee resolvable
    // The day the conversation STARTED COSTING TIME, not the day it landed. A
    // message that arrives at 23:10 accrues nothing that night, so charging it
    // to that day's consistency strip would mark the day dirty for something
    // nobody could have answered. businessDateOf rolls it to the next open day.
    openedDate: businessHours.businessDateOf(row.opened_at),
    // Crossed as a STRING, already rendered in the firm's timezone. It used to
    // come back as a pg `date`, which node-postgres builds in the process
    // timezone and toISOString() then shifts back a day whenever TZ is east of
    // UTC. That was harmless while opened_date was shifted the same way; now
    // that openedDate is a true local date, only one side would have moved.
    closedDate: row.closed_date || null,      // null while still open
    stillOpen: !!row.still_open,
  }));
}

// ---------------------------------------------------------------------------
// Consistency — for each local day, how many of this person's conversations
// were STILL OPEN when the day ended. Not "what arrived today".
// ---------------------------------------------------------------------------
function consistencyFor(convs, spine) {
  // A conversation that arrived after closing time, or on a Saturday, has a
  // business date of TOMORROW — past the end of the spine, where every
  // comparison below is false and the chat becomes invisible. Today would then
  // score "clean" with something genuinely waiting, which is the most
  // flattering possible lie for this particular metric. Clamp it onto the last
  // day instead: it is open, it just has not started costing time yet.
  const last = spine.length ? spine[spine.length - 1] : null;
  convs = (convs || []).map((c) => (
    last && c.openedDate && c.openedDate > last ? Object.assign({}, c, { openedDate: last }) : c
  ));
  const days = spine.map((date) => {
    // Open at 23:59 on `date`: it had arrived by then, and it had not been
    // answered or cleared by then. String comparison is safe — every date here
    // was rendered in the firm's timezone by Postgres.
    const openAtEnd = convs.filter((c) => c.openedDate <= date && (!c.closedDate || c.closedDate > date));
    const arrived = convs.filter((c) => c.openedDate === date);
    return {
      date,
      openAtEndOfDay: openAtEnd.length,
      arrived: arrived.length,
      clean: openAtEnd.length === 0,
      oldestOpenDays: openAtEnd.length
        ? Math.max(...openAtEnd.map((c) => daysBetween(c.openedDate, date)))
        : 0,
    };
  });
  const clean = days.filter((d) => d.clean).length;
  return {
    days,
    cleanDays: clean,
    totalDays: days.length,
    cleanPct: days.length ? Math.round((clean / days.length) * 100) : null,
    // What is hanging over the person right now — the last day in the spine.
    openNow: days.length ? days[days.length - 1].openAtEndOfDay : 0,
  };
}
function daysBetween(a, b) {
  return Math.max(0, Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000));
}

// Best hour = lowest median among hours with enough replies to mean anything.
// One reply at 04:00 is an anecdote, not a peak.
const MIN_HOUR_SAMPLE = 3;

// Hours grouped into the four bands people actually think in, so the card can
// show a whole profile rather than a single cherry-picked hour.
const BANDS = [
  { key: 'morning',   label: 'בוקר 6–12',   from: 6,  to: 11 },
  { key: 'noon',      label: 'צהריים 12–16', from: 12, to: 15 },
  { key: 'afternoon', label: 'אחה״צ 16–20',  from: 16, to: 19 },
  { key: 'evening',   label: 'ערב/לילה 20–6', from: 20, to: 5 },
];
function bandOf(hour) {
  for (const b of BANDS) {
    if (b.from <= b.to) { if (hour >= b.from && hour <= b.to) return b.key; }
    else if (hour >= b.from || hour <= b.to) return b.key;   // wraps midnight
  }
  return 'evening';
}

// Mean of the same list. Shown BESIDE the median, never instead of it: the two
// answer different questions and the gap between them is itself information.
// Median = what a typical conversation looks like. Mean = how much total pain is
// in the pile, because every rotting conversation drags it. On the firm's real
// shape the two came out 1.3 hours and 22 hours from the same 80 conversations.
function mean(values) {
  const xs = (values || []).filter((v) => v != null && Number.isFinite(v));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function speedFrom(latencies, openCount) {
  const w1 = share(latencies, 3600), w4 = share(latencies, 14400), w8 = share(latencies, 28800);
  return {
    measured: latencies.length,          // answered + still-waiting, together
    openCount,                           // how many of those are still waiting
    medianSeconds: median(latencies),
    avgSeconds: mean(latencies),
    within1hPct: w1.pct, within1h: w1.count,
    within4hPct: w4.pct, within4h: w4.count,
    within8hPct: w8.pct, within8h: w8.count,
  };
}

function profileFrom(answered) {
  // Trend and peak hours use ANSWERED conversations only: a conversation with no
  // reply has no reply-week and no answered-hour to sit in. Labelled as such on
  // the card so the difference from the median is never a surprise.
  const byWeek = new Map();
  const byHour = new Map();
  const byBand = new Map();
  for (const a of answered) {
    if (!byWeek.has(a.week)) byWeek.set(a.week, []);
    byWeek.get(a.week).push(a.latency);
    if (!byHour.has(a.hour)) byHour.set(a.hour, []);
    byHour.get(a.hour).push(a.latency);
    const b = bandOf(a.hour);
    if (!byBand.has(b)) byBand.set(b, []);
    byBand.get(b).push(a.latency);
  }
  const trend = [...byWeek.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .map(([week, ls]) => ({ week, replies: ls.length, medianSeconds: median(ls) }));
  const hours = [...byHour.entries()].sort((x, y) => x[0] - y[0])
    .map(([hour, ls]) => ({ hour, replies: ls.length, medianSeconds: median(ls) }));
  const bands = BANDS.map((b) => {
    const ls = byBand.get(b.key) || [];
    return { key: b.key, label: b.label, replies: ls.length, medianSeconds: median(ls) };
  }).filter((b) => b.replies > 0);

  // The headline band is where the WORK happens — most replies — because that
  // is what "when do you answer" means. Ties break toward the faster one.
  const bestBand = bands.length
    ? bands.reduce((a, b) => (b.replies > a.replies || (b.replies === a.replies && b.medianSeconds < a.medianSeconds) ? b : a))
    : null;
  // The strongest hour is chosen from INSIDE the strongest band. Picking it
  // globally produced a card that said "fastest in the morning · strongest hour
  // 18:00" — two true sentences that contradict each other on the face of it.
  // The band is the headline, so the hour has to belong to it.
  const inBand = bestBand ? hours.filter((h) => bandOf(h.hour) === bestBand.key) : [];
  const usable = inBand.filter((h) => h.replies >= MIN_HOUR_SAMPLE);
  const bestHour = usable.length ? usable.reduce((a, h) => (h.replies > a.replies ? h : a)) : null;

  // "Improving" compared against the person's OWN earlier weeks, not against the
  // single first point: one freak week at either end used to flip the label.
  // A baseline of ONE previous week is not a trend, it is two dots. Comparing
  // against a single quiet week is what produced "האטה של 245%".
  const MIN_BASELINE_WEEKS = 2;
  let change = null;
  if (trend.length >= MIN_BASELINE_WEEKS + 1) {
    const done = trend.slice(0, -1);                       // completed weeks
    const current = trend[trend.length - 1];               // the week still running
    const baseline = median(done.map((t) => t.medianSeconds));
    if (baseline != null && current.medianSeconds != null && baseline > 0) {
      change = {
        currentSeconds: current.medianSeconds,
        currentReplies: current.replies,
        baselineSeconds: baseline,
        baselineWeeks: done.length,
        pct: Math.round(((current.medianSeconds - baseline) / baseline) * 100),
        // Ratios of medians explode when the baseline is small (0:43 -> 2:30 is
        // "+245%"). A multiple reads as what it is; the page shows whichever is
        // less alarming to misread.
        times: Math.round((current.medianSeconds / baseline) * 10) / 10,
      };
    }
  }
  return { trend, hours, bands, bestHour, bestBand, change };
}

async function buildStaffMetrics({
  pool,
  windowDays = 30,
  staffPairs = [],           // [{ ph9, email }] for the MEASURED staff only
  includedEmails = [],       // lowercased emails that count
  includeFirmLine = true,
  trendWeeks = 8,
  consistencyDays = 14,
} = {}) {
  const spine = localDateSpine(consistencyDays);
  const empty = {
    byEmail: new Map(), firm: null, firmLine: null,
    spine, trendWeeks, consistencyDays, unattributedOpen: 0,
  };
  if (!pool) return empty;

  const [answeredRows, ownedRows] = await Promise.all([
    fetchAnswered(pool, windowDays),
    fetchOwned(pool, Math.max(windowDays, consistencyDays)),
  ]);

  const phoneToEmail = new Map();
  for (const p of staffPairs) if (p.ph9) phoneToEmail.set(p.ph9, String(p.email || '').toLowerCase());
  const counts = new Set(includedEmails.map((e) => String(e || '').toLowerCase()));

  // --- answered: charged to whoever replied --------------------------------
  const answeredByEmail = new Map();
  const firmLineAnswered = [];
  for (const a of answeredRows) {
    const email = phoneToEmail.get(a.ph9);
    if (!email) {                       // not a measured staff phone -> shared line
      if (includeFirmLine) firmLineAnswered.push(a);
      continue;
    }
    if (!counts.has(email)) continue;   // an excluded person
    if (!answeredByEmail.has(email)) answeredByEmail.set(email, []);
    answeredByEmail.get(email).push(a);
  }

  // --- owned: unanswered ones charged to the assignee -----------------------
  const ownedByEmail = new Map();
  let unattributedOpen = 0;
  for (const c of ownedRows) {
    if (!c.owner) { if (c.stillOpen) unattributedOpen += 1; continue; }
    if (!counts.has(c.owner)) continue;
    if (!ownedByEmail.has(c.owner)) ownedByEmail.set(c.owner, []);
    ownedByEmail.get(c.owner).push(c);
  }

  const byEmail = new Map();
  const everyone = new Set([...answeredByEmail.keys(), ...ownedByEmail.keys(), ...counts]);
  for (const email of everyone) {
    const answered = answeredByEmail.get(email) || [];
    const owned = ownedByEmail.get(email) || [];
    byEmail.set(email, Object.assign(
      profileFrom(answered),
      {
        answeredCount: answered.length,
        // Raw latencies, NOT aggregated here. lib/staff-response.js merges these
        // with the board's open conversations and only then takes the median —
        // because only the board knows the real, re-attributed waiting list.
        answeredLatencies: answered.map((a) => a.latency),
        consistency: consistencyFor(owned, spine),
      }
    ));
  }

  // --- firm-wide ------------------------------------------------------------
  const allAnswered = [...answeredByEmail.values()].flat().concat(firmLineAnswered);
  const allOwned = [...ownedByEmail.values()].flat();
  const firm = Object.assign(
    profileFrom(allAnswered),
    {
      answeredCount: allAnswered.length,
      answeredLatencies: allAnswered.map((a) => a.latency),
      consistency: consistencyFor(allOwned, spine),
    }
  );

  const firmLine = includeFirmLine && firmLineAnswered.length
    ? Object.assign(profileFrom(firmLineAnswered), {
        answeredCount: firmLineAnswered.length,
        answeredLatencies: firmLineAnswered.map((a) => a.latency),
        consistency: null,
      })
    : null;

  return { byEmail, firm, firmLine, spine, trendWeeks, consistencyDays, unattributedOpen };
}

module.exports = {
  buildStaffMetrics,
  // exported for tests
  median, mean, share, consistencyFor, profileFrom, speedFrom, bandOf, localDateSpine,
  MIN_HOUR_SAMPLE, BANDS,
};
