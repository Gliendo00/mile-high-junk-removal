// Site Improvement Agent — private/publication-safe business context
// boundary.
//
// NOT wired to any real data source yet. The CRM does not currently
// collect a completed-job "how'd it go?" note (see the product spec), so
// there is nothing real to ingest. This module exists only to establish,
// and prove with tests, the separation the spec requires BEFORE that
// integration is built: a completed-job note is private CRM data until it
// passes through redactForPublication(), and anything that fails
// validation must never reach a content-generation step.
//
// When the CRM integration is built, it should produce objects shaped like
// RawJobNote below and pass them through this module — not invent its own
// redaction logic inline.

// Fields that may NEVER appear in publication-safe output, under any
// circumstances, regardless of what a future CRM payload calls them.
const PRIVATE_FIELD_PATTERNS = [
  /price/i,
  /payment/i,
  /\btip\b/i,
  /invoice/i,
  /\bcost\b/i,
  /client.?name/i,
  /customer.?name/i,
  /phone/i,
  /email/i,
  /address/i,
  /\bnotes?\b$/i, // the raw private note field itself, e.g. "privateNote"
];

// The only fields a publication-safe summary may draw from.
const PUBLICATION_SAFE_FIELDS = new Set([
  "serviceType", // e.g. "hot tub removal"
  "city", // e.g. "Wheat Ridge" — never a street address
  "accessNotes", // generic operational facts, e.g. "backyard access was easy"
  "outcomeTag", // e.g. "completed-no-issues"
]);

function isPrivateFieldName(fieldName) {
  return PRIVATE_FIELD_PATTERNS.some((re) => re.test(fieldName));
}

/**
 * Given a raw (private) job-note object, returns only the fields that are
 * both (a) explicitly on the publication-safe allowlist and (b) not also
 * matched by a private-field pattern (belt and suspenders: an allowlist
 * typo can never leak a private field, because the blocklist still runs).
 *
 * Throws if the input contains a field matching a private pattern AND
 * also on the allowlist — that is a configuration error, not something to
 * silently resolve either direction.
 */
function redactForPublication(rawNote) {
  if (!rawNote || typeof rawNote !== "object") {
    throw new Error("redactForPublication requires an object");
  }
  const safe = {};
  for (const [key, value] of Object.entries(rawNote)) {
    const isPrivate = isPrivateFieldName(key);
    const isAllowlisted = PUBLICATION_SAFE_FIELDS.has(key);
    if (isPrivate && isAllowlisted) {
      throw new Error(
        `business-context: field "${key}" is both private-patterned and publication-allowlisted — fix the allowlist, do not guess`
      );
    }
    if (isPrivate) continue;
    if (!isAllowlisted) continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * Defense-in-depth: scans a finished piece of publication-safe text (e.g.
 * generated FAQ copy) for an accidentally-embedded private raw value, given
 * the original raw note it was (supposedly) derived from. This does not
 * replace redactForPublication() — it's a last check before anything is
 * written to a public HTML file.
 */
function assertNoPrivateLeakage(text, rawNote) {
  for (const [key, value] of Object.entries(rawNote || {})) {
    if (!isPrivateFieldName(key)) continue;
    if (value && typeof value === "string" && value.length > 2 && text.includes(value)) {
      throw new Error(`business-context: publication text contains private field "${key}"'s value`);
    }
  }
  return true;
}

module.exports = {
  PRIVATE_FIELD_PATTERNS,
  PUBLICATION_SAFE_FIELDS,
  isPrivateFieldName,
  redactForPublication,
  assertNoPrivateLeakage,
};
