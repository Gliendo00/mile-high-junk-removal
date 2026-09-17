// Shared historical-migration date floor — Phase 3C Stage 2.2. "+ Past Job"
// accepts appointment dates from this floor through today (America/Denver)
// only, matching the date the owner began manually backfilling historical
// jobs into the CRM. A future stage (Month/Year historical Schedule
// navigation) is expected to reuse this same constant so the two features
// never silently disagree about where "history" begins.
//
// Pure constant — no I/O, safe to import from any runtime (server or, via a
// duplicated client-side copy per this project's established convention,
// static admin JS — see admin/booking-past.js's own header).
const HISTORICAL_FLOOR_ISO = "2026-01-01";

module.exports = { HISTORICAL_FLOOR_ISO };
