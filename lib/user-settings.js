// ============================================================
// lib/user-settings.js — Phase 2.
// Pure helpers for per-user settings (profile preferences + notification
// preferences). No I/O here: this module only defines the shape, the
// defaults, and a strict sanitizer that whitelists and type-checks incoming
// values, so we never persist arbitrary client-supplied JSON.
//
// The display NAME is deliberately NOT part of this blob — it lives on the
// users table (firm identity, unique, audited) and is handled in routes/me.js.
// ============================================================

const LANGUAGES = ['en', 'he'];
const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];
const NUMBER_FORMATS = ['1,234,567.89', '1.234.567,89'];
const DELIVERIES = ['inapp_email', 'email', 'inapp'];

// A safe, sensible default for a brand-new user (nothing stored yet).
function defaults() {
  return {
    profile: {
      language: 'en',
      timezone: 'Asia/Jerusalem',
      dateFormat: 'DD/MM/YYYY',
      numberFormat: '1,234,567.89',
      workStart: '08:30',
      workEnd: '18:00',
      workingDays: [0, 1, 2, 3, 4], // Sun–Thu (0=Sun)
    },
    notifications: {
      channels: { inApp: true, email: true, desktop: false },
      types: {
        taskReminders: true,
        aiTaskCompleted: true,
        agentApproval: true,
        systemAlerts: true,
        securityAlerts: true,
        ruleProposal: true, // admins: emailed when a firm-rule change is proposed
      },
      summaries: {
        daily: { enabled: true, delivery: 'email', time: '07:30' },
        weekly: { enabled: true, delivery: 'email' },
      },
      quietHours: { enabled: false, from: '19:00', to: '07:00' },
    },
  };
}

// ── coercion helpers ──
function bool(v, dflt) { return typeof v === 'boolean' ? v : dflt; }
function oneOf(v, list, dflt) { return list.indexOf(v) !== -1 ? v : dflt; }
function timeStr(v, dflt) {
  return (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) ? v : dflt;
}
function tz(v, dflt) {
  // Accept IANA-ish "Area/City" or a short label; cap length. We don't resolve
  // it here — the client offers a fixed list; this just guards the stored value.
  return (typeof v === 'string' && v.length > 0 && v.length <= 64) ? v : dflt;
}
function days(v, dflt) {
  if (!Array.isArray(v)) return dflt;
  const out = [];
  v.forEach((n) => {
    const d = Number(n);
    if (Number.isInteger(d) && d >= 0 && d <= 6 && out.indexOf(d) === -1) out.push(d);
  });
  return out.sort((a, b) => a - b);
}

// Merge a (possibly partial, possibly hostile) input over the current stored
// settings, returning a clean object that only ever contains known keys with
// valid values. `current` lets a PATCH-style save touch only some sections.
function sanitize(input, current) {
  const base = current && typeof current === 'object' ? current : {};
  const d = defaults();
  const curProfile = Object.assign({}, d.profile, base.profile || {});
  const curNotif = deepNotif(base.notifications, d.notifications);

  const inp = input && typeof input === 'object' ? input : {};
  const p = inp.profile && typeof inp.profile === 'object' ? inp.profile : {};
  const n = inp.notifications && typeof inp.notifications === 'object' ? inp.notifications : {};

  const profile = {
    language: oneOf(p.language, LANGUAGES, curProfile.language),
    timezone: tz(p.timezone, curProfile.timezone),
    dateFormat: oneOf(p.dateFormat, DATE_FORMATS, curProfile.dateFormat),
    numberFormat: oneOf(p.numberFormat, NUMBER_FORMATS, curProfile.numberFormat),
    workStart: timeStr(p.workStart, curProfile.workStart),
    workEnd: timeStr(p.workEnd, curProfile.workEnd),
    workingDays: p.workingDays !== undefined ? days(p.workingDays, curProfile.workingDays) : curProfile.workingDays,
  };

  const nc = (n.channels && typeof n.channels === 'object') ? n.channels : {};
  const nt = (n.types && typeof n.types === 'object') ? n.types : {};
  const ns = (n.summaries && typeof n.summaries === 'object') ? n.summaries : {};
  const nsd = (ns.daily && typeof ns.daily === 'object') ? ns.daily : {};
  const nsw = (ns.weekly && typeof ns.weekly === 'object') ? ns.weekly : {};
  const nq = (n.quietHours && typeof n.quietHours === 'object') ? n.quietHours : {};

  const notifications = {
    channels: {
      inApp: bool(nc.inApp, curNotif.channels.inApp),
      email: bool(nc.email, curNotif.channels.email),
      desktop: bool(nc.desktop, curNotif.channels.desktop),
    },
    types: {
      taskReminders: bool(nt.taskReminders, curNotif.types.taskReminders),
      aiTaskCompleted: bool(nt.aiTaskCompleted, curNotif.types.aiTaskCompleted),
      agentApproval: bool(nt.agentApproval, curNotif.types.agentApproval),
      systemAlerts: bool(nt.systemAlerts, curNotif.types.systemAlerts),
      securityAlerts: bool(nt.securityAlerts, curNotif.types.securityAlerts),
      ruleProposal: bool(nt.ruleProposal, curNotif.types.ruleProposal),
    },
    summaries: {
      daily: {
        enabled: bool(nsd.enabled, curNotif.summaries.daily.enabled),
        delivery: oneOf(nsd.delivery, DELIVERIES, curNotif.summaries.daily.delivery),
        time: timeStr(nsd.time, curNotif.summaries.daily.time),
      },
      weekly: {
        enabled: bool(nsw.enabled, curNotif.summaries.weekly.enabled),
        delivery: oneOf(nsw.delivery, DELIVERIES, curNotif.summaries.weekly.delivery),
      },
    },
    quietHours: {
      enabled: bool(nq.enabled, curNotif.quietHours.enabled),
      from: timeStr(nq.from, curNotif.quietHours.from),
      to: timeStr(nq.to, curNotif.quietHours.to),
    },
  };

  return { profile, notifications };
}

// Deep-merge stored notifications over defaults so older/partial rows still
// return a complete shape.
function deepNotif(stored, dflt) {
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    channels: Object.assign({}, dflt.channels, s.channels || {}),
    types: Object.assign({}, dflt.types, s.types || {}),
    summaries: {
      daily: Object.assign({}, dflt.summaries.daily, (s.summaries && s.summaries.daily) || {}),
      weekly: Object.assign({}, dflt.summaries.weekly, (s.summaries && s.summaries.weekly) || {}),
    },
    quietHours: Object.assign({}, dflt.quietHours, s.quietHours || {}),
  };
}

// Return a complete settings object for a stored (possibly partial) row.
function withDefaults(stored) {
  const d = defaults();
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    profile: Object.assign({}, d.profile, s.profile || {}),
    notifications: deepNotif(s.notifications, d.notifications),
  };
}

// Should this admin be emailed when a firm-rule change is proposed?
// Opt-out: defaults to true unless they turned off the email channel or the
// ruleProposal type. Missing settings ⇒ default (notified).
function wantsRuleProposalEmail(stored) {
  const s = withDefaults(stored);
  return !!(s.notifications.channels.email && s.notifications.types.ruleProposal);
}

module.exports = {
  defaults, sanitize, withDefaults, wantsRuleProposalEmail,
  LANGUAGES, DATE_FORMATS, NUMBER_FORMATS, DELIVERIES,
};
