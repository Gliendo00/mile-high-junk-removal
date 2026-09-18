// Single source of truth for dumpster-rental pricing. Every dollar amount
// this feature ever charges or displays is computed from these constants —
// never re-typed in the frontend, never trusted from a client-submitted
// value. Mirrors this project's existing convention for an authoritative
// shared code-constants module (api/_lib/time-windows.js,
// api/_lib/historical-floor.js, api/_lib/expense-categories.js) rather than
// a DB-driven settings table: pricing changes for a physical rental
// business are infrequent, and every existing "single source of truth" in
// this codebase already works this way.
//
// api/book.js is the only place this ever becomes money that actually
// moves at booking time. api/admin/booking.js's `?resource=charges` reads
// OVERAGE_TON_RATE/OVERAGE_DAY_RATE the same way, for the same reason — a
// proposed additional charge's rate is computed here, then snapshotted onto
// the rental_additional_charges row so a later pricing change can never
// retroactively alter an already-proposed/approved charge's math.

const BASE_RATE = 349.0;
const INCLUDED_DAYS = 5;
const INCLUDED_TONS = 2;
const OVERAGE_TON_RATE = 90.0;
const OVERAGE_DAY_RATE = 15.0;

// Bump this (a plain date string, not parsed/compared as a real date
// anywhere — just an opaque version label) any time the agreement text in
// book/index.html materially changes. rental_payments.agreement_version
// stores whatever value was current at the moment a given customer
// accepted it, so an older acceptance is never reinterpreted as having
// agreed to later wording.
const RENTAL_AGREEMENT_VERSION = "2026-09-18";

function round2(n) {
  return Math.round(n * 100) / 100;
}

// The only amount the online checkout ever charges up front — a flat base
// rate, independent of which delivery/pickup dates were chosen. Days beyond
// INCLUDED_DAYS are never charged automatically at booking time; like
// overweight tonnage, an extra-days charge only ever happens later, as an
// admin-proposed-then-approved additional charge (see
// api/admin/booking.js's charges resource).
function baseRentalAmount() {
  return BASE_RATE;
}

// `chargeType` must be one of the two values that map to a fixed per-unit
// rate. Returns null (never throws) for an unrecognized type or "other" —
// "other" charges are a manually-entered flat amount with no rate to look
// up, validated separately by the caller.
function overageRate(chargeType) {
  if (chargeType === "overweight_tonnage") return OVERAGE_TON_RATE;
  if (chargeType === "additional_days") return OVERAGE_DAY_RATE;
  return null;
}

module.exports = {
  BASE_RATE,
  INCLUDED_DAYS,
  INCLUDED_TONS,
  OVERAGE_TON_RATE,
  OVERAGE_DAY_RATE,
  RENTAL_AGREEMENT_VERSION,
  round2,
  baseRentalAmount,
  overageRate,
};
