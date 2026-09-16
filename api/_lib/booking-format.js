// Shared display-formatting helpers for /api/admin/* routes.
//
// These values are deliberately duplicated from api/book.js rather than
// imported from it or refactored into a module api/book.js also uses.
// api/book.js is the live customer-facing booking endpoint and this phase
// must not restructure or risk regressing it — see
// docs/phase-1/time-windows.md's "Note for Phase 2: duplicated
// definitions", which anticipated exactly this and already recommended a
// shared constants module *for new admin code*, not a retrofit of the
// existing booking flow. If a future phase is willing to touch api/book.js
// and book/book.js together, that would be the time to collapse all three
// copies into one.

const SERVICE_LABELS = {
  junk_removal: "Junk Removal",
  dumpster_rental: "15-Yard Dumpster Rental",
  light_demo: "Light Demo",
};

// Legacy broad windows (pre-2-hour-window UI) + current 2-hour windows.
// Source: docs/phase-1/time-windows.md, itself confirmed from
// TIME_WINDOW_DEFS/TIME_WINDOW_LABELS in api/book.js.
const TIME_WINDOW_LABELS = {
  morning: "Morning (8am–11am)",
  midday: "Midday (11am–2pm)",
  afternoon: "Afternoon (2pm–5pm)",
  evening: "Evening (5pm–7pm)",
  w_0400_0600: "4:00 AM – 6:00 AM",
  w_0600_0800: "6:00 AM – 8:00 AM",
  w_0800_1000: "8:00 AM – 10:00 AM",
  w_1000_1200: "10:00 AM – 12:00 PM",
  w_1200_1400: "12:00 PM – 2:00 PM",
  w_1400_1600: "2:00 PM – 4:00 PM",
  w_1600_1800: "4:00 PM – 6:00 PM",
  w_1800_2000: "6:00 PM – 8:00 PM",
  w_2000_2200: "8:00 PM – 10:00 PM",
};

// The six proposed statuses from docs/phase-1/crm-status-plan.md. Nothing
// in this phase writes any of these back to the database — this is a
// display-only lookup.
const STATUS_LABELS = {
  new: "New",
  contacted: "Contacted",
  quoted: "Quoted",
  booked: "Booked",
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

// NULL/empty status normalizes to "new" for DISPLAY purposes only — per
// docs/phase-1/crm-status-plan.md, this is never written back to the
// database. An unrecognized non-empty value (shouldn't happen given
// api/book.js never writes status today, but defensive regardless) falls
// through to a title-cased version of itself rather than crashing.
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
  normalizedStatus,
  statusLabel,
};
