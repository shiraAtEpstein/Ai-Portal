// ============================================================
// lib/scheduler.js — tiny daily scheduler for the unanswered-chat digest.
//
// No cron dependency: a 60s interval checks the wall clock in Asia/Jerusalem
// and fires once per configured slot per day (tracked in memory, same idiom as
// whatsapp/groups/bootstrap.js's processor schedule).
//
//   UNANSWERED_DIGEST_TIMES  comma-separated HH:MM (default "08:00")
//   UNANSWERED_HOURS         threshold hours passed to the digest (default 3)
//
// NOTE: this runs in-process. On a sleeping/idle host (e.g. Render free tier)
// the interval is suspended, so a slot that falls while the instance is asleep
// won't fire until it next wakes — acceptable for a daily nudge.
// ============================================================
const { sendDigests } = require('./unanswered-digest');

const TZ = 'Asia/Jerusalem';
let _timer = null;
let _lastFiredSlot = null;

function digestTimes() {
  return (process.env.UNANSWERED_DIGEST_TIMES || '08:00')
    .split(',').map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s));
}

function thresholdHours() {
  const n = parseInt(process.env.UNANSWERED_HOURS || '3', 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

// HH:MM and YYYY-MM-DD in the firm timezone.
function localParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  return { hhmm: `${parts.hour}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

function start() {
  if (_timer) return; // already started
  const tick = () => {
    try {
      const { hhmm, date } = localParts();
      if (!digestTimes().includes(hhmm)) return;
      const slot = `${date} ${hhmm}`;
      if (_lastFiredSlot === slot) return; // already fired this slot today
      _lastFiredSlot = slot;
      const hours = thresholdHours();
      console.log(`[unanswered/scheduler] firing digest at ${slot} (${TZ}), threshold=${hours}h`);
      sendDigests({ hours })
        .then((r) => console.log(`[unanswered/scheduler] digest done: ${r.counts.emailsSent} email(s), ${r.counts.totalChats} chat(s)`))
        .catch((e) => console.error('[unanswered/scheduler] digest failed:', e.message));
    } catch (e) {
      console.error('[unanswered/scheduler] tick failed:', e.message);
    }
  };
  _timer = setInterval(tick, 60 * 1000);
  if (_timer.unref) _timer.unref();
  console.log(`[unanswered/scheduler] armed for ${digestTimes().join(', ')} (${TZ})`);
}

module.exports = { start };
