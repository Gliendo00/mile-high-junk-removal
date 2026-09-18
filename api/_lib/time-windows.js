// Single source of truth for time-window metadata used by /api/admin/* code:
// display labels AND the America/Denver start hour each window begins at
// (needed to sort jobs chronologically on the admin Schedule).
//
// Values are copied verbatim from TIME_WINDOW_DEFS in api/book.js — the live,
// customer-facing booking endpoint's own copy, which is deliberately left
// untouched by this file. api/book.js is out of scope for this change: it's
// the public booking flow, already has its own validation logic built around
// its local copy (isTimeWindowExpired, TIME_WINDOWS_BY_SERVICE, etc.), and
// touching it is a materially different risk than adding a new admin-only
// module. See api/_lib/booking-format.js's header comment for the existing,
// already-established precedent of this project deliberately keeping
// api/book.js's copy separate from the admin side's. This file replaces
// booking-format.js's *own* previously-separate label copy (see that file),
// so the count of independent copies of this data stays at two (api/book.js's
// live copy, and this shared admin one) rather than growing to three.
//
// If api/book.js's window ids/labels/hours ever change, this file must be
// updated to match by hand — there is no automated link between them.
const TIME_WINDOW_DEFS = {
  morning: { label: "Morning (8am–11am)", startHour: 8 },
  midday: { label: "Midday (11am–2pm)", startHour: 11 },
  afternoon: { label: "Afternoon (2pm–5pm)", startHour: 14 },
  evening: { label: "Evening (5pm–7pm)", startHour: 17 },
  w_0400_0600: { label: "4:00 AM – 6:00 AM", startHour: 4 },
  w_0600_0800: { label: "6:00 AM – 8:00 AM", startHour: 6 },
  w_0800_1000: { label: "8:00 AM – 10:00 AM", startHour: 8 },
  w_1000_1200: { label: "10:00 AM – 12:00 PM", startHour: 10 },
  w_1200_1400: { label: "12:00 PM – 2:00 PM", startHour: 12 },
  w_1400_1600: { label: "2:00 PM – 4:00 PM", startHour: 14 },
  w_1600_1800: { label: "4:00 PM – 6:00 PM", startHour: 16 },
  w_1800_2000: { label: "6:00 PM – 8:00 PM", startHour: 18 },
  w_2000_2200: { label: "8:00 PM – 10:00 PM", startHour: 20 },
};

// Returns null for an unrecognized/legacy-unlisted window id rather than
// throwing — callers (the Schedule sort comparator) treat null as "sort
// last," never as an error, since a booking must never disappear from the
// Schedule just because its time_window value is unexpected.
function timeWindowStartHour(id) {
  const def = TIME_WINDOW_DEFS[id];
  return def ? def.startHour : null;
}

// Phase 3C Stage 2.5: bookings.exact_time (a nullable Postgres `time`
// column, added alongside the bookings_time_mode_exclusive CHECK
// constraint) gives a job a precise appointment time instead of a window.
// Supabase/PostgREST round-trips a `time` value as "HH:MM:SS" — but this
// parses "HH:MM" too (what a bare `<input type="time">.value` submits
// client-side, and what api/admin/booking.js writes verbatim), so it works
// on both the write path's raw input and the read path's DB round-trip
// without needing two different parsers.
function parseExactTimeMinutes(raw) {
  if (typeof raw !== "string") return null;
  const m = /^(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(min) || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// "09:00:00" / "09:00" -> "9:00 AM", "13:30:00" -> "1:30 PM". Returns null
// (never a raw/garbled string) when the value can't be parsed — callers fall
// back to their own "—"/unknown display, same null-for-unrecognized contract
// as timeWindowStartHour above.
function formatExactTime(raw) {
  const totalMinutes = parseExactTimeMinutes(raw);
  if (totalMinutes === null) return null;
  const h24 = Math.floor(totalMinutes / 60);
  const min = totalMinutes % 60;
  const period = h24 < 12 ? "AM" : "PM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ":" + String(min).padStart(2, "0") + " " + period;
}

// One appointment-time sort decision, shared by every Schedule range
// (Today/Yesterday/Tomorrow/Week/Month all funnel through
// api/admin/bookings.js's fetchScheduleJobs, which calls this once per
// comparison). A job is expected to have at most one of time_window/
// exact_time set — enforced at the database level by the
// bookings_time_mode_exclusive CHECK constraint (Phase 3C Stage 2.5) — but
// this stays defensive for any malformed/manually-edited row anyway:
// exact_time wins when both happen to be present, since it's the more
// precise value, rather than throwing or picking arbitrarily. Returns null
// (sorts last — see fetchScheduleJobs's comparator) when neither is set or
// parseable, exactly like timeWindowStartHour's existing null contract.
function effectiveTimeSortMinutes(timeWindowRaw, exactTimeRaw) {
  const exactMinutes = parseExactTimeMinutes(exactTimeRaw);
  if (exactMinutes !== null) return exactMinutes;
  const hour = timeWindowStartHour(timeWindowRaw);
  return hour === null ? null : hour * 60;
}

module.exports = { TIME_WINDOW_DEFS, timeWindowStartHour, formatExactTime, effectiveTimeSortMinutes };
