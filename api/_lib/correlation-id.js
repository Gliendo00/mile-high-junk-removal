// Shared, minimal observability helper for the public form endpoints
// (api/book.js, api/contact.js). Deliberately NOT a logging subsystem —
// no new table, no third-party service, just a per-request id threaded
// through console.log/console.error so a single submission's checkpoints
// (received, customer resolution, lead/booking creation, idempotent
// replay, spam rejection, email failure, final outcome) can be grepped
// together out of Vercel's existing function log stream, which is the
// only durable trace these endpoints have today.
//
// getCorrelationId() prefers Vercel's own per-invocation request id
// (`x-vercel-id`, present on every request Vercel proxies in production)
// over minting a new one, so these log lines line up with whatever id
// Vercel's own platform-level logging already uses for the same request.
// Falls back to a locally generated id only when that header is absent
// (local/dev, or a platform that doesn't set it) — never blocks or throws
// either way.
function getCorrelationId(req) {
  const fromPlatform = req && req.headers && req.headers["x-vercel-id"];
  if (typeof fromPlatform === "string" && fromPlatform.trim()) {
    return fromPlatform.trim();
  }
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const nodeCrypto = require("crypto");
  return nodeCrypto.randomUUID();
}

// One consistent log line shape across both endpoints. `details` must
// never carry a raw phone/email/name/message — ids, booleans, and counts
// only, so these lines stay safe to read/share without exposing a
// customer's personal data.
function logEvent(correlationId, event, details) {
  const suffix = details ? " " + JSON.stringify(details) : "";
  console.log("[" + correlationId + "] " + event + suffix);
}

module.exports = { getCorrelationId, logEvent };
