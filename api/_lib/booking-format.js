// Shared display-formatting helpers for /api/admin/* routes.
//
// service/status labels below are deliberately duplicated from api/book.js
// rather than imported from it or refactored into a module api/book.js also
// uses. api/book.js is the live customer-facing booking endpoint and this
// phase must not restructure or risk regressing it — see
// docs/phase-1/time-windows.md's "Note for Phase 2: duplicated
// definitions", which anticipated exactly this and already recommended a
// shared constants module *for new admin code*, not a retrofit of the
// existing booking flow.
//
// Time-window labels are the one exception: as of Phase 3C Stage 1 they are
// derived from api/_lib/time-windows.js (which also carries each window's
// start hour, needed to sort the admin Schedule chronologically) instead of
// being a second hardcoded copy here. That module's own header explains why
// api/book.js's copy is still left alone. If a future phase is willing to
// touch api/book.js and book/book.js together, that would be the time to
// collapse every remaining copy (service labels, status labels) into one.

const { TIME_WINDOW_DEFS, formatExactTime } = require("./time-windows");

const SERVICE_LABELS = {
  junk_removal: "Junk Removal",
  dumpster_rental: "15-Yard Dumpster Rental",
  light_demo: "Light Demo",
};

// Derived from TIME_WINDOW_DEFS (api/_lib/time-windows.js) rather than
// hardcoded here a second time — same label values as before this change,
// just no longer a second source of truth for them.
const TIME_WINDOW_LABELS = Object.keys(TIME_WINDOW_DEFS).reduce(function (acc, id) {
  acc[id] = TIME_WINDOW_DEFS[id].label;
  return acc;
}, {});

// The 7 real bookings.status values (bookings_status_check), originally
// proposed in docs/phase-1/crm-status-plan.md and confirmed live against
// production in the 2026-10-18 schema audit. Used for display here, but
// these are genuinely stored values, not a display-only convention —
// "new" in particular is the column's own NOT NULL DEFAULT, and every one
// of these (including "new") can also be written explicitly via
// api/admin/booking.js's handleStatusAction().
const STATUS_LABELS = {
  new: "New",
  contacted: "Contacted",
  quoted: "Quoted",
  booked: "Booked",
  // Phase 3C Stage 4: dumpster-rental-only lifecycle step between "booked"
  // and "completed" — a rental that has been delivered and is currently at
  // the client's property. See api/admin/booking-status.js for the
  // service_type-based restriction that keeps this off non-rental jobs.
  rental_out: "Rental Out",
  completed: "Completed",
  lost: "Lost",
};

function serviceLabel(raw) {
  return SERVICE_LABELS[raw] || String(raw || "—");
}

function timeWindowLabel(raw) {
  if (!raw) return "—";
  return TIME_WINDOW_LABELS[raw] || String(raw);
}

// Phase 3C Stage 2.5: the one appointment-time label every display surface
// (Schedule cards, booking detail, Requests, Client history) should use
// instead of timeWindowLabel() alone, now that a job can carry either a
// time_window or an exact_time. Same exact-time-wins precedence as
// api/_lib/time-windows.js's effectiveTimeSortMinutes — see that function's
// comment for why (the DB constraint makes "both set" impossible for a new
// row, but this stays defensive for old/malformed data regardless).
function effectiveTimeLabel(timeWindowRaw, exactTimeRaw) {
  const exactLabel = formatExactTime(exactTimeRaw);
  return exactLabel || timeWindowLabel(timeWindowRaw);
}

// bookings.status is confirmed NOT NULL DEFAULT 'new' in production
// (2026-10-18 schema audit) — a real booking's status is never actually
// NULL/empty, so the `key || "new"` fallback below is purely defensive
// (a malformed/legacy value, or a caller other than a real bookings row)
// rather than an expected, regularly-hit path. An unrecognized non-empty
// value falls through to a title-cased version of itself rather than
// crashing.
function normalizedStatus(raw) {
  const key = String(raw || "").trim().toLowerCase();
  return key || "new";
}

function statusLabel(raw) {
  const key = normalizedStatus(raw);
  return STATUS_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

module.exports = {
  SERVICE_LABELS,
  TIME_WINDOW_LABELS,
  STATUS_LABELS,
  serviceLabel,
  timeWindowLabel,
  effectiveTimeLabel,
  normalizedStatus,
  statusLabel,
};
