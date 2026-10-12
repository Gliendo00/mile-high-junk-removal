// Site Improvement Agent — private/publication-safe business context
// boundary.
//
// Phase 3 wired the real CRM source: bookings.operational_note ("How'd it
// go?", see sql/2026-10-12_phase3-agent-howd-it-go.sql and
// api/admin/booking.js's handleUpdateOperationalNote()). fromCompletedBooking()
// below maps a real booking row into the same raw-note shape the Phase 1
// synthetic fixtures already used, then redacts it the same way. Nothing
// in agent/runner.js calls it yet — there is no Supabase access from the
// offline runner (by design, see agent/README.md), and this feature has
// no real production data behind it yet either. This module stays ready
// for whoever (or whatever) next pulls completed jobs from Supabase: feed
// the raw row through fromCompletedBooking(), never reimplement
// redaction inline.
//
// Even the output of fromCompletedBooking()/redactForPublication() is
// EVIDENCE for the agent to reason about, not automatic website copy —
// nothing becomes public merely because it passed redaction.

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

/**
 * Maps a real `bookings` row (any mix of snake_case DB columns or the
 * camelCase shape api/admin/booking.js's GET already returns — both are
 * accepted so this works whether it's fed a raw Supabase row or an
 * already-mapped API response) into the same four-field raw-note shape
 * used throughout this module, then redacts it. The booking row may
 * contain (and in production WILL contain) private fields — customer_id,
 * final_price, tip_amount, internal_notes, service_address, etc. — none
 * of those are ever read here; only the four explicit fields below are
 * picked off the input, so nothing else could leak even before
 * redactForPublication()'s own allowlist runs as a second, independent
 * check.
 *
 * Returns null (not an empty object) when there is no operational note
 * at all — "no evidence" should never be mistaken for "evidence of an
 * empty job."
 */
function fromCompletedBooking(booking) {
  if (!booking || typeof booking !== "object") {
    throw new Error("fromCompletedBooking requires a booking object");
  }
  const status = booking.status;
  const operationalNote = booking.operational_note || booking.operationalNote || null;
  if (!operationalNote) return null;

  const raw = {
    serviceType: booking.service_type || booking.serviceType || null,
    city: booking.service_city || booking.serviceCity || null,
    accessNotes: operationalNote,
    outcomeTag: status === "completed" ? "completed" : null,
  };
  for (const key of Object.keys(raw)) {
    if (raw[key] === null) delete raw[key];
  }
  return redactForPublication(raw);
}

module.exports = {
  PRIVATE_FIELD_PATTERNS,
  PUBLICATION_SAFE_FIELDS,
  isPrivateFieldName,
  redactForPublication,
  assertNoPrivateLeakage,
  fromCompletedBooking,
};
