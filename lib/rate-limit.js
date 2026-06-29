// ============================================================
// lib/rate-limit.js — a small in-memory "speed limit" for endpoints.
// No external dependency. Limits how many requests one user (by session id,
// falling back to IP) can make in a time window; returns 429 when exceeded.
// Good first guard against one account hammering an expensive endpoint.
// Note: in-memory means it's per-server-process — fine for a single Render
// instance; if you scale to multiple instances later, move this to the DB/Redis.
// ============================================================
function rateLimit({ windowMs = 60000, max = 20, name = 'requests' } = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  if (sweep.unref) sweep.unref();

  return function rateLimitMiddleware(req, res, next) {
    const id = (req.session && req.session.userId) || req.ip || 'anon';
    const now = Date.now();
    let rec = hits.get(id);
    if (!rec || rec.resetAt <= now) { rec = { count: 0, resetAt: now + windowMs }; hits.set(id, rec); }
    rec.count++;
    if (rec.count > max) {
      const retry = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: 'Too many ' + name + '. Please slow down and try again in a few seconds.' });
    }
    next();
  };
}

module.exports = { rateLimit };
