// Shared historical-migration date floor — Phase 3C Stage 2.2. "+ Past Job"
// accepts appointment dates from this floor through today (America/Denver)
// only, matching the date the owner began manually backfilling historical
// jobs into the CRM. Reused as-of Phase 3C Stage 2.4 by the Month/Year
// calendar navigation (api/admin/bookings.js) and the daily Quick Expense
// floor, so every feature agrees on exactly where "history" begins.
//
// Pure constant — no I/O, safe to import from any runtime (server or, via a
// duplicated client-side copy per this project's established convention,
// static admin JS — see admin/booking-past.js's own header).
const HISTORICAL_FLOOR_ISO = "2026-01-01";

// Derived, not re-typed — kept in lockstep with HISTORICAL_FLOOR_ISO above
// rather than risking a second hardcoded "2026"/"1" that could drift from it.
const HISTORICAL_FLOOR_YEAR = Number(HISTORICAL_FLOOR_ISO.slice(0, 4));
const HISTORICAL_FLOOR_MONTH = Number(HISTORICAL_FLOOR_ISO.slice(5, 7));

module.exports = { HISTORICAL_FLOOR_ISO, HISTORICAL_FLOOR_YEAR, HISTORICAL_FLOOR_MONTH };
