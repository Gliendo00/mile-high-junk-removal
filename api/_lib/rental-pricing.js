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
// 2026-09-18-v2 pricing update: $90/ton -> $125/ton, and overweight billing
// is now actually prorated to the exact scale weight (see overweightCharge()
// below) rather than relying on an admin manually typing a tons-over
// quantity. $125 / 2000 lb = $0.0625/lb — the per-pound rate this constant
// implies, never hardcoded separately anywhere else in this codebase.
const OVERAGE_TON_RATE = 125.0;
const OVERAGE_DAY_RATE = 15.0;

// Bump this (a plain date string, not parsed/compared as a real date
// anywhere — just an opaque version label) any time the agreement text in
// book/index.html materially changes. rental_payments.agreement_version
// stores whatever value was current at the moment a given customer
// accepted it, so an older acceptance is never reinterpreted as having
// agreed to later wording. Bumped for the 2026-09-18-v2 pricing update
// (the agreement's overweight-rate/proration wording changed) — never
// reuse a prior version string once any customer has accepted under it.
const RENTAL_AGREEMENT_VERSION = "2026-09-18-v2";

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 4 decimal places — exactly enough to store overweightLbs/2000 losslessly
// for ANY integer overweightLbs, and no more: 2000 = 2^4 * 5^3, so its
// prime factorization needs at most max(4, 3) = 4 decimal digits to
// terminate exactly (e.g. 1/2000 = 0.0005 lands exactly on the 4th place,
// never repeating, never needing a 5th). Used only for
// overweightCharge()'s quantityTons — see that function and
// rental_additional_charges.quantity's numeric(10,4) column.
function round4(n) {
  return Math.round(n * 10000) / 10000;
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

// Overweight billing, prorated to the EXACT actual scale weight — never
// rounded up to a whole ton or any partial-ton increment. `includedTons`
// and `tonRate` should be a specific booking's own locked-in values
// (rental_payments.included_tons/overage_ton_rate) whenever a booking has
// them; api/admin/booking.js's handleProposeCharge() falls back to this
// module's current INCLUDED_TONS/OVERAGE_TON_RATE only for a booking with
// no rental_payments row of its own (e.g. an admin-created rental never
// paid online) — see that function for the full fallback rule, identical
// in spirit to the one already governing agreement/rate snapshotting.
//
// Money rounding happens exactly once, on the final dollar amount, and
// `amount` is computed directly from the unrounded overweightLbs — never
// from quantityTons — so it's never affected by whatever precision
// quantityTons itself ends up stored/displayed at.
//
// quantityTons uses round4 (not round2): rental_additional_charges.quantity
// is a numeric(10,4) column specifically so a small overage (e.g. 1 lb)
// stores as its true value (0.0005 tons) instead of rounding down to a
// misleading "0.00 tons" next to a real, nonzero dollar amount — a
// genuinely confusing record even though the money itself was always
// correct. additional_days' own quantity (a plain day count, handled
// entirely separately in api/admin/booking.js) is untouched by any of
// this — it still uses round2, and the wider column accepts that
// unchanged, since more available decimal places never alters what an
// already 2-decimal value means.
function overweightCharge(actualWeightLbs, includedTons, tonRate) {
  const includedLbs = includedTons * 2000;
  const overweightLbs = Math.max(0, actualWeightLbs - includedLbs);
  return {
    includedLbs: includedLbs,
    overweightLbs: overweightLbs,
    quantityTons: round4(overweightLbs / 2000),
    amount: round2(overweightLbs * (tonRate / 2000)),
  };
}

module.exports = {
  BASE_RATE,
  INCLUDED_DAYS,
  INCLUDED_TONS,
  OVERAGE_TON_RATE,
  OVERAGE_DAY_RATE,
  RENTAL_AGREEMENT_VERSION,
  round2,
  round4,
  baseRentalAmount,
  overageRate,
  overweightCharge,
};
