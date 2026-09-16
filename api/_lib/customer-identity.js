// Shared, pure normalization helpers for repeat-client identity (Phase 3B
// Step 4). Used by api/book.js when writing a new customer so every row
// carries a normalized phone/email from the moment it's created, and
// intended to be reused unchanged by any later admin-side matching code —
// one source of truth for what "the same phone" or "the same email"
// means, never a duplicated SQL/JS expression.
//
// Pure functions only: no I/O, no Supabase, no throwing. They run in the
// public, unauthenticated /api/book request path, so malformed input must
// degrade to a plain (possibly empty) normalized value, never an
// exception that could take down a booking submission.

// Strips every non-digit character, then drops a leading US country-code
// "1" only when the result is exactly 11 digits — e.g. "+1 (303) 555-0100"
// and "303.555.0100" both normalize to "3035550100". Any other digit
// count (a non-US number, anything already-validated-but-unusual) is left
// as its plain digit string: this only ever strips formatting, it never
// validates a phone number — that already happened in api/book.js's own
// isValidPhone() before normalizePhone() is ever called.
function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.charAt(0) === "1") {
    return digits.slice(1);
  }
  return digits;
}

// Lowercases and trims only. Deliberately does not canonicalize
// Gmail-style dots or "+tag" addressing — that's provider-specific and
// risks collapsing two different people's addresses into the same
// normalized value, which this project's matching design treats as an
// unacceptable false-positive risk. Returns null (never "") for a
// missing/empty email so callers can write SQL NULL directly.
function normalizeEmail(email) {
  const trimmed = String(email || "").trim().toLowerCase();
  return trimmed ? trimmed : null;
}

module.exports = { normalizePhone, normalizeEmail };
