// ============================================================
// lib/staff-metrics.js — every NUMBER on the staff response board.
//
//   buildStaffMetrics({ windowDays, staff9, included9, includeFirmLine,
//                       trendWeeks, consistencyDays })
//
// lib/staff-response.js owns WHO appears on the board (the directory, the
// exclusions, the live backlog and its re-attribution). This file owns WHAT IS
// MEASURED. Keeping them apart means the metric SQL can grow without the
// routing rules getting tangled into it.
//
// WHAT IT PRODUCES, per person and for the firm as a whole:
//
//   • speed        — reply count, median, and the share answered within
//                    1h / 4h / 8h (percentiles, no target)
//   • trend        — the same median week by week, so improvement is visible
//   • peakHours    — median by HOUR OF DAY the client wrote, so a person can
//                    see when they are actually fastest
//   • consistency  — per day: how many conversations opened, and how many were
//                    answered before that day was out
//
// ── ONE SCAN, NOT FIVE ──────────────────────────────────────────────────────
// Deriving the reply set (walking every chat to find each waiting streak and
// its first firm reply) is by far the expensive part. Doing it once per metric
// would scan processing_jobs five times. Instead the reply set is materialised
// ONCE into a TEMP TABLE on a single dedicated connection, and every aggregate
// reads from that. This is also why the whole thing runs inside one explicit
// transaction on one client rather than through pool.query().
//
// ── A HONEST NOTE ABOUT "CONSISTENCY" ───────────────────────────────────────
// A conversation's responsible person is stored as a CURRENT fact — the manual
// override in chat_responsible_override, else the monday person in charge on
// whatsapp_groups. Neither is versioned, so there is no record of who owned a
// case back in June. Consistency therefore attributes every past day to the
// person who owns that conversation TODAY. For a case that never changed hands
// that is exact; for one that did, older days follow the new owner. Chats with
// no resolvable owner are counted in `coverage.unattributed` and left out of
// everybody's numbers rather than being guessed onto someone.
// ============================================================
const TZ = 'Asia/Jerusalem';

// The reply set. A "waiting streak" is one or more consecutive client messages
// with no firm message among them; its latency is the time from the FIRST of
// those messages to the firm's first reply. firm_cnt is a running count of firm
// messages in the chat, so every message of one streak shares a firm_cnt and
// the reply that ends it has firm_cnt + 1.
//
// "Firm message" = direction 'out' (the Lawly line) OR a sender resolved to a
// staff phone (staff replying from their own handset inside a group arrives as
// an inbound message) — the same rule listUnansweredChats uses.
const STREAK_CTE = `
  WITH base AS (
    SELECT chat_jid, sent_at,
           sender_staff_phone9 AS ph9,
           (sender_staff_phone9 IS NOT NULL OR direction = 'out') AS is_firm
    FROM processing_jobs
    WHERE source = 'whatsapp' AND sent_at IS NOT NULL
  ),
  grp AS (
    SELECT *,
      SUM(CASE WHEN is_firm THEN 1 ELSE 0 END)
        OVER (PARTITION BY chat_jid ORDER BY sent_at ROWS UNBOUNDED PRECEDING) AS firm_cnt,
      LAG(is_firm) OVER (PARTITION BY chat_jid ORDER BY sent_at) AS prev_is_firm
    FROM base
  ),
  streak AS (
    SELECT chat_jid, firm_cnt, MIN(sent_at) AS streak_start
    FROM grp WHERE NOT is_firm
    GROUP BY chat_jid, firm_cnt
  )`;

function pct(part, whole) {
  const p = Number(part), w = Number(whole);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return null;
  return Math.round((p / w) * 100);
}
const num = (v) => (v == null ? null : Number(v));

// ---------------------------------------------------------------------------
// Materialise the reply set for the window, keeping only responders that count.
// ---------------------------------------------------------------------------
async function materialiseReplies(client, { staff9, included9, includeFirmLine, windowDays }) {
  await client.query(`
    CREATE TEMP TABLE _replies ON COMMIT DROP AS
    ${STREAK_CTE}
    SELECT g.chat_jid,
           g.sent_at        AS reply_at,
           s.streak_start,
           g.ph9,
           EXTRACT(EPOCH FROM (g.sent_at - s.streak_start)) AS latency_s
    FROM grp g
    JOIN streak s ON s.chat_jid = g.chat_jid AND s.firm_cnt = g.firm_cnt - 1
    WHERE g.is_firm AND g.prev_is_firm = false
      AND g.sent_at >= now() - ($3::int * interval '1 day')
      -- Excluded responders are dropped HERE, before any aggregate runs, so no
      -- firm-wide figure can carry their latencies.
      AND (
        COALESCE(g.ph9,'') = ANY($2::text[])
        OR ($4::boolean AND COALESCE(g.ph9,'') <> ALL($1::text[]))
      )`,
    [staff9, included9, windowDays, includeFirmLine]);
  await client.query(`CREATE INDEX ON _replies (ph9)`);
}

// responder key: a staff phone stays itself, anything else collapses to '' —
// the shared Lawly line.
const R9 = `CASE WHEN COALESCE(ph9,'') = ANY($1::text[]) THEN ph9 ELSE '' END`;

// --- speed: count, median, and the 1h / 4h / 8h shares ----------------------
async function speedRows(client, staff9) {
  const r = await client.query(`
    SELECT ${R9} AS r9,
      count(*)                                                AS replies,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_s)   AS median_s,
      count(*) FILTER (WHERE latency_s <=  3600)               AS w1h,
      count(*) FILTER (WHERE latency_s <= 14400)               AS w4h,
      count(*) FILTER (WHERE latency_s <= 28800)               AS w8h
    FROM _replies
    GROUP BY ROLLUP((${R9}))`, [staff9]);

  const shape = (row) => ({
    replies: Number(row.replies),
    medianSeconds: num(row.median_s),
    within1hPct: pct(row.w1h, row.replies),
    within4hPct: pct(row.w4h, row.replies),
    within8hPct: pct(row.w8h, row.replies),
    within1h: Number(row.w1h),
    within4h: Number(row.w4h),
    within8h: Number(row.w8h),
  });

  const byPhone = new Map();
  let firm = null;
  for (const row of r.rows) {
    if (row.r9 === null) { firm = shape(row); continue; }   // ROLLUP grand total
    byPhone.set(row.r9 || '', shape(row));
  }
  return { byPhone, firm };
}

// --- trend: the same median, week by week -----------------------------------
// GROUPING SETS gives per-person-per-week and firm-per-week from one pass.
// Weeks are local weeks (Monday), not UTC ones, or a Sunday-evening reply lands
// in the wrong week for anybody reading this in Israel.
async function trendRows(client, staff9, weeks) {
  const r = await client.query(`
    SELECT ${R9} AS r9,
      date_trunc('week', reply_at AT TIME ZONE '${TZ}')::date AS wk,
      count(*)                                              AS replies,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_s) AS median_s
    FROM _replies
    WHERE reply_at >= ((date_trunc('week', (now() AT TIME ZONE '${TZ}'))
                        - (($2::int - 1) * interval '1 week')) AT TIME ZONE '${TZ}')
    GROUP BY GROUPING SETS ((${R9}, 2), (2))
    ORDER BY 2`, [staff9, weeks]);

  const byPhone = new Map();
  const firm = [];
  for (const row of r.rows) {
    const point = {
      week: row.wk instanceof Date ? row.wk.toISOString().slice(0, 10) : String(row.wk),
      replies: Number(row.replies),
      medianSeconds: num(row.median_s),
    };
    if (row.r9 === null) { firm.push(point); continue; }
    const key = row.r9 || '';
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push(point);
  }
  return { byPhone, firm };
}

// --- peak hours: median by the hour the CLIENT wrote -------------------------
// Bucketed by streak_start, not by reply time: the question is "when a client
// writes at 09:00, how fast do they hear back", which is what a person can
// actually act on.
async function hourRows(client, staff9) {
  const r = await client.query(`
    SELECT ${R9} AS r9,
      EXTRACT(HOUR FROM streak_start AT TIME ZONE '${TZ}')::int AS hr,
      count(*)                                              AS replies,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_s) AS median_s
    FROM _replies
    GROUP BY GROUPING SETS ((${R9}, 2), (2))
    ORDER BY 2`, [staff9]);

  const byPhone = new Map();
  const firm = [];
  for (const row of r.rows) {
    const point = { hour: Number(row.hr), replies: Number(row.replies), medianSeconds: num(row.median_s) };
    if (row.r9 === null) { firm.push(point); continue; }
    const key = row.r9 || '';
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push(point);
  }
  return { byPhone, firm };
}

// --- consistency: did the day end with your conversations answered? ---------
// Every waiting streak in the window, answered or not, attributed to the person
// responsible for that CONVERSATION (manual override first, then the monday
// person in charge), and bucketed by the local day the client wrote.
//
// This is the one metric that is charged to the ASSIGNEE rather than to whoever
// happened to reply — which is the point of it. See the note at the top about
// what that costs in historical accuracy.
async function consistencyRows(client, days) {
  const r = await client.query(`
    ${STREAK_CTE},
    first_reply AS (
      SELECT s.chat_jid, s.firm_cnt, s.streak_start, MIN(g.sent_at) AS replied_at
      FROM streak s
      LEFT JOIN grp g
        ON g.chat_jid = s.chat_jid AND g.is_firm AND g.sent_at > s.streak_start
      GROUP BY s.chat_jid, s.firm_cnt, s.streak_start
    ),
    owned AS (
      SELECT fr.streak_start, fr.replied_at,
             COALESCE(ovr.email, wg.responsible_email) AS owner_email
      FROM first_reply fr
      LEFT JOIN chat_responsible_override ovr ON ovr.chat_jid = fr.chat_jid
      LEFT JOIN whatsapp_groups wg
             ON wg.provider_group_jid = fr.chat_jid AND wg.removed_at IS NULL
      WHERE fr.streak_start >= ((((now() AT TIME ZONE '${TZ}')::date)
                                 - ($1::int - 1) * interval '1 day') AT TIME ZONE '${TZ}')
    )
    SELECT COALESCE(lower(trim(owner_email)), '')                      AS owner_email,
           (streak_start AT TIME ZONE '${TZ}')::date                  AS day,
           count(*)                                                   AS opened,
           count(*) FILTER (
             WHERE replied_at IS NOT NULL
               AND (replied_at AT TIME ZONE '${TZ}')::date
                 = (streak_start AT TIME ZONE '${TZ}')::date
           )                                                          AS same_day,
           count(*) FILTER (WHERE replied_at IS NULL)                 AS still_open
    FROM owned
    GROUP BY GROUPING SETS ((COALESCE(lower(trim(owner_email)), ''), 2), (2))
    ORDER BY 2`, [days]);

  const byEmail = new Map();
  const firm = [];
  let unattributed = 0;
  for (const row of r.rows) {
    const point = {
      date: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day),
      opened: Number(row.opened),
      sameDay: Number(row.same_day),
      stillOpen: Number(row.still_open),
    };
    // NULL now means one thing only: the GROUPING SETS grand total.
    if (row.owner_email === null) { firm.push(point); continue; }
    // '' = a real conversation whose owner could not be resolved. Counted, but
    // never charged to a person.
    if (!row.owner_email) { unattributed += point.opened; continue; }
    if (!byEmail.has(row.owner_email)) byEmail.set(row.owner_email, []);
    byEmail.get(row.owner_email).push(point);
  }
  return { byEmail, firm, unattributed };
}

// The last N calendar dates in the firm's timezone, oldest first. Built here
// rather than in the browser: a person opening the board from abroad must still
// see the firm's days, not their own.
function localDateSpine(n) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const out = [];
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(fmt.format(new Date(now - i * dayMs)));
  return out;
}

// Roll a list of per-day points into the headline consistency figures.
// `spine` (optional) is the full list of dates the strip should show; days with
// no conversations are filled in as empty rather than left out, so the strip is
// a calendar and not a ragged list — a gap has to look like a quiet day, not
// like missing data.
function summariseDays(days, spine) {
  const raw = days || [];
  const byDate = new Map(raw.map((d) => [d.date, d]));
  const list = spine && spine.length
    ? spine.map((date) => byDate.get(date) || { date, opened: 0, sameDay: 0, stillOpen: 0 })
    : raw;
  const opened = list.reduce((a, d) => a + d.opened, 0);
  const sameDay = list.reduce((a, d) => a + d.sameDay, 0);
  const stillOpen = list.reduce((a, d) => a + d.stillOpen, 0);
  // A "clean day" is a day that had conversations AND ended with all of them
  // answered. Days with nothing to answer are not counted either way — they are
  // neither an achievement nor a failure.
  const active = list.filter((d) => d.opened > 0);
  const clean = active.filter((d) => d.sameDay === d.opened).length;
  return {
    days: list,
    opened,
    sameDay,
    stillOpen,
    sameDayPct: pct(sameDay, opened),
    activeDays: active.length,
    cleanDays: clean,
  };
}

// Best hour = the hour with the lowest median, among hours with enough replies
// to mean anything. One reply at 04:00 is not a peak, it is an anecdote.
const MIN_HOUR_SAMPLE = 3;
function bestHour(hours) {
  const usable = (hours || []).filter((h) => h.replies >= MIN_HOUR_SAMPLE && h.medianSeconds != null);
  if (!usable.length) return null;
  return usable.reduce((best, h) => (h.medianSeconds < best.medianSeconds ? h : best));
}

async function buildStaffMetrics({
  pool,
  windowDays = 30,
  staff9 = [],
  included9 = [],
  includeFirmLine = true,
  trendWeeks = 8,
  consistencyDays = 14,
} = {}) {
  const empty = {
    byPhone9: new Map(), firm: null,
    consistencyByEmail: new Map(), consistencyFirm: null, consistencyUnattributed: 0,
    trendWeeks, consistencyDays,
  };
  if (!pool) return empty;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await materialiseReplies(client, { staff9, included9, includeFirmLine, windowDays });

    // One client, one transaction -> these run in sequence by definition.
    // Each is a small aggregate over the materialised temp table.
    const speed = await speedRows(client, staff9);
    const trend = await trendRows(client, staff9, trendWeeks);
    const hours = await hourRows(client, staff9);

    // Consistency reads the raw tables, not _replies — it needs the streaks
    // NOBODY answered, which by definition are not in the reply set.
    let consistency = { byEmail: new Map(), firm: [], unattributed: 0 };
    try {
      consistency = await consistencyRows(client, consistencyDays);
    } catch (e) {
      // Missing chat_responsible_override / whatsapp_groups must not take the
      // whole board down — the other four metrics are still worth showing.
      console.error('[staff-metrics] consistency unavailable:', e.message);
    }

    await client.query('COMMIT');

    const byPhone9 = new Map();
    for (const [ph9, s] of speed.byPhone) {
      const h = hours.byPhone.get(ph9) || [];
      byPhone9.set(ph9, Object.assign({}, s, {
        trend: trend.byPhone.get(ph9) || [],
        hours: h,
        bestHour: bestHour(h),
      }));
    }

    const firm = speed.firm
      ? Object.assign({}, speed.firm, {
          trend: trend.firm,
          hours: hours.firm,
          bestHour: bestHour(hours.firm),
        })
      : null;

    const spine = localDateSpine(consistencyDays);
    const consistencyByEmail = new Map();
    // Everyone who is measured gets a full strip, including people with a quiet
    // fortnight — an absent strip reads as "broken", a grey one reads as "quiet".
    for (const [email, days] of consistency.byEmail) consistencyByEmail.set(email, summariseDays(days, spine));

    return {
      byPhone9,
      firm,
      consistencyByEmail,
      consistencySpine: spine,
      consistencyFirm: summariseDays(consistency.firm, spine),
      consistencyUnattributed: consistency.unattributed,
      trendWeeks,
      consistencyDays,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the connection is going back to the pool anyway */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { buildStaffMetrics, summariseDays, bestHour, MIN_HOUR_SAMPLE };
