// ============================================================
// lib/staff-response.js — staff response-time monitoring (Yaacov's dashboard).
//
//   buildStaffResponse({ windowDays=30, targetHours=3 })
//     -> { generatedAt, windowDays, targetHours, firm, staff:[...], firmLine, crossCover:[...] }
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
// ============================================================
const db = require('../db');
const { loadDirectory } = require('./routing');
const { buildBoard } = require('./unanswered-digest');

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

// --- 1) Response-time stats, grouped by the ACTUAL responder ----------------
// firm_cnt = running count of firm messages in the chat; a client streak that
// follows the Nth firm reply all shares firm_cnt=N, so its first firm reply has
// firm_cnt=N+1. Join the reply (first firm msg after client(s)) back to the
// streak's earliest client message to get first-response latency.
async function responseStats(pool, staff9, windowDays, targetHours) {
  const sql = `
    WITH base AS (
      SELECT chat_jid, sent_at,
             sender_staff_phone9 AS ph9,                 -- staffer resolved by phone OR name
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
    streak AS (   -- earliest client message of each waiting streak
      SELECT chat_jid, firm_cnt, MIN(sent_at) AS streak_start
      FROM grp WHERE NOT is_firm
      GROUP BY chat_jid, firm_cnt
    ),
    replies AS ( -- first firm reply after each streak
      SELECT g.chat_jid, g.sent_at AS reply_at, g.ph9,
             s.streak_start,
             EXTRACT(EPOCH FROM (g.sent_at - s.streak_start)) AS latency_s
      FROM grp g
      JOIN streak s ON s.chat_jid = g.chat_jid AND s.firm_cnt = g.firm_cnt - 1
      WHERE g.is_firm AND g.prev_is_firm = false
    )
    SELECT
      CASE WHEN ph9 = ANY($1::text[]) THEN ph9 ELSE '' END AS responder9,
      count(*)                                                          AS replies,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_s)            AS median_s,
      avg(latency_s)                                                    AS avg_s,
      count(*) FILTER (WHERE latency_s <= $3 * 3600)                    AS within_target,
      count(*) FILTER (WHERE latency_s <= 3600)                         AS b_lt1h,
      count(*) FILTER (WHERE latency_s > 3600  AND latency_s <= 10800)  AS b_1_3h,
      count(*) FILTER (WHERE latency_s > 10800 AND latency_s <= 86400)  AS b_3_24h,
      count(*) FILTER (WHERE latency_s > 86400)                         AS b_gt24h
    FROM replies
    WHERE reply_at >= now() - ($2::int * interval '1 day')
    GROUP BY 1`;
  const r = await pool.query(sql, [staff9, windowDays, targetHours]);
  const byPhone = new Map();
  for (const row of r.rows) byPhone.set(row.responder9 || '', row);
  return byPhone;
}

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

async function buildStaffResponse({ windowDays = 30, targetHours = 3 } = {}) {
  const generatedAt = new Date().toISOString();
  const dir = loadDirectory();
  const staff = (dir.staff || []);
  const staff9 = staff.map((s) => phone9(s.phone9)).filter(Boolean);
  const byPhone9 = new Map(staff.map((s) => [phone9(s.phone9), s]));

  const pool = db.getPool();
  const empty = { generatedAt, windowDays, targetHours, firm: {}, staff: [], firmLine: null, crossCover: [] };
  if (!pool) return empty;

  const [stats, board, cover] = await Promise.all([
    responseStats(pool, staff9, windowDays, targetHours),
    buildBoard().catch(() => ({ items: [] })),
    crossCover(pool, staff9).catch(() => []),
  ]);

  // Open load per person, from the live board (assignee lens), broken down by
  // status so each user shows how many are waiting under each bucket.
  const blankStatus = () => ({ required: 0, potential: 0, voice: 0, pending: 0 });
  const openByName = new Map();
  const firmStatus = blankStatus();
  for (const it of (board.items || [])) {
    const name = it.responsibleName || '—';
    const cur = openByName.get(name) || { open: 0, maxWait: 0, byStatus: blankStatus() };
    cur.open += 1;
    cur.maxWait = Math.max(cur.maxWait, Number(it.hoursWaiting) || 0);
    if (cur.byStatus[it.status] != null) cur.byStatus[it.status] += 1;
    openByName.set(name, cur);
    if (firmStatus[it.status] != null) firmStatus[it.status] += 1;
  }

  const rowFor = (row, load) => {
    const replies = row ? Number(row.replies) : 0;
    const dist = row ? {
      lt1h: Number(row.b_lt1h), h1_3: Number(row.b_1_3h),
      h3_24: Number(row.b_3_24h), gt24h: Number(row.b_gt24h),
    } : { lt1h: 0, h1_3: 0, h3_24: 0, gt24h: 0 };
    return {
      open: load ? load.open : 0,
      maxWaitHours: load ? load.maxWait : 0,
      byStatus: load ? load.byStatus : { required: 0, potential: 0, voice: 0, pending: 0 },
      replies,
      medianSeconds: row && row.median_s != null ? Number(row.median_s) : null,
      median: row ? fmtDur(row.median_s) : null,
      withinTargetPct: replies ? Math.round((Number(row.within_target) / replies) * 100) : null,
      dist,
    };
  };

  const staffRows = staff.map((s) => {
    const row = stats.get(phone9(s.phone9));
    const load = openByName.get(s.name);
    return Object.assign({ name: s.name, email: s.email }, rowFor(row, load));
  });

  // Shared-line replies (responder not tied to a staffer).
  const firmLine = rowFor(stats.get('') || null, null);

  // Firm-wide summary.
  const totalReplies = staffRows.reduce((a, r) => a + r.replies, 0) + firmLine.replies;
  const totalWithinArr = [...stats.values()];
  const withinAll = totalWithinArr.reduce((a, r) => a + Number(r.within_target), 0);
  const openTotal = (board.items || []).length;
  const oldest = (board.items || []).reduce((m, it) => Math.max(m, Number(it.hoursWaiting) || 0), 0);
  // firm median = median of all latencies (approximate with a second small query would be exact;
  // here we surface the weighted picture the rows already carry).
  const firm = {
    openTotal,
    byStatus: firmStatus,                 // { required, potential, voice, pending }
    required: firmStatus.required,
    potential: firmStatus.potential,
    voice: firmStatus.voice,
    pending: firmStatus.pending,
    oldestHours: oldest,
    withinTargetPct: totalReplies ? Math.round((withinAll / totalReplies) * 100) : null,
    totalReplies,
  };

  // Cross-cover -> only where active responder differs from the assignee.
  const crossCoverOut = [];
  for (const c of cover) {
    const active = byPhone9.get(c.active9);
    if (!active) continue;                         // shared line / unknown — skip
    if (active.email === c.responsible_email) continue; // same person — not cross-cover
    crossCoverOut.push({
      group: c.group_name,
      assignee: c.responsible_name || c.responsible_email,
      active: active.name,
    });
  }

  return { generatedAt, windowDays, targetHours, firm, staff: staffRows, firmLine, crossCover: crossCoverOut };
}

module.exports = { buildStaffResponse };
