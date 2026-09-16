// Shared spam-protection helpers for the public form endpoints (api/book.js,
// api/contact.js).
//
// Deliberately dependency-free and in-memory: on Vercel each warm serverless
// instance holds its own module state, so isRateLimited() caps abuse seen by
// any single instance rather than guaranteeing one hard global ceiling across
// every instance/cold start. Combined with the honeypot and minimum-fill-time
// checks below — which work regardless of how many instances are running,
// since they don't depend on shared state at all — this is a reasonable
// layer of protection for this site's traffic volume without introducing an
// external dependency (e.g. Redis/Vercel KV) for Phase 1.

const buckets = new Map(); // rate-limit key -> array of request timestamps (ms)

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) {
    return fwd.split(",")[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// Sliding-window limiter keyed by an arbitrary string (callers should
// namespace it, e.g. "book:" + ip, so endpoints don't share a budget).
// Returns true when `key` has already made `max` or more requests within
// the trailing `windowMs` and this request should be rejected.
function isRateLimited(key, windowMs, max) {
  const now = Date.now();
  let timestamps = buckets.get(key);
  if (!timestamps) {
    timestamps = [];
    buckets.set(key, timestamps);
  }
  while (timestamps.length && now - timestamps[0] > windowMs) {
    timestamps.shift();
  }
  if (timestamps.length >= max) {
    return true;
  }
  timestamps.push(now);

  // Opportunistic cleanup so `buckets` doesn't grow unbounded on a
  // long-lived warm instance. Cheap and only runs a fraction of calls.
  if (buckets.size > 500 && Math.random() < 0.01) {
    for (const [k, arr] of buckets) {
      if (!arr.length || now - arr[arr.length - 1] > windowMs) {
        buckets.delete(k);
      }
    }
  }
  return false;
}

// True when the honeypot field was filled in. Real visitors never see this
// field (it's positioned off-screen and never focusable), so any non-empty
// value is a strong signal the request came from an automated form filler.
function isHoneypotTripped(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// True when the form was submitted implausibly fast after it loaded.
// `elapsedMs` is a client-computed DURATION (not a timestamp) — the number
// of milliseconds between the page's script running and the submit click,
// measured entirely on the client with performance.now() (falling back to
// Date.now() only if performance.now() is unavailable) and sent as a plain
// number. The server never compares it against its own clock.
//
// This is deliberate: an earlier version sent an absolute client timestamp
// and had the server diff it against the server's own Date.now(). That
// conflated real fill time with client/server clock skew — a client clock
// running even a couple of seconds fast made a genuinely-paced human
// submission look artificially fast to the server, which (per the design
// below) leads to a *silent* fake-success response, i.e. a real lead
// quietly dropped with no error shown. Measuring a duration on one clock
// (the browser's own monotonic timer) and never crossing it with the
// server's clock removes that failure mode entirely.
//
// Missing/invalid/negative values are treated as "unknown" (not suspicious)
// rather than blocked, so a client that fails to send this field for any
// reason is never punished for it.
function isSubmittedTooFast(elapsedMs, minMs) {
  // Number(null) is 0 and Number(undefined) is NaN — checked explicitly
  // here rather than relied on, since 0 is itself a meaningful ("submitted
  // instantly") value for this check, unlike the old absolute-timestamp
  // version where any non-positive number was already invalid.
  if (elapsedMs === null || elapsedMs === undefined) return false;
  const n = Number(elapsedMs);
  if (!Number.isFinite(n) || n < 0) return false;
  return n < minMs;
}

module.exports = { getClientIp, isRateLimited, isHoneypotTripped, isSubmittedTooFast };
