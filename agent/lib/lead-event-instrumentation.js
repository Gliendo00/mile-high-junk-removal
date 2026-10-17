// Site Improvement Agent, Phase 12 — GA4 lead-event instrumentation
// boundary.
//
// INVESTIGATION FINDING (do not re-litigate without re-checking
// nav.js/book/book.js/contact.html first): phone_click and sms_click
// GA4 tracking ALREADY EXISTS in production, implemented centrally in
// nav.js as a single delegated `document`-level click listener
// (`a[href^="tel:"]`/`a[href^="sms:"]`) — no per-page inline handlers,
// no PII in either event (no parameters at all), a single listener so
// no duplicate-firing risk, delegation so dynamically-inserted
// tel:/sms: links are covered automatically, and a
// `typeof window.gtag === 'function'` guard so it no-ops safely when
// gtag isn't loaded. Confirmed via `git log --follow -- nav.js`:
//   - phone_click + the booking funnel (booking_started/
//     booking_service_selected/booking_date_selected/
//     booking_form_completed): commit cc85cfa, 2026-08-11.
//   - sms_click + the contact-form events (contact_form_start/
//     generate_lead): commit 926258c, 2026-09-14.
// Both commits are ancestors of the current production `main`. NO new
// site tracking code was needed or added for Phase 12 — see
// agent/README.md's Phase 12 section for the full writeup.
//
// WHY THIS FILE EXISTS: these events have REAL pre-instrumentation
// history gaps, and today's date is close enough to both boundaries
// that a naive 28-day-vs-28-day comparison can genuinely straddle one
// (e.g. a "28 days ending today" vs "the 28 days before that" pair can
// have its PREVIOUS window start before 2026-09-14 for the
// Sep-14-instrumented events). Absence of event data before a boundary
// is NOT zero engagement — it is "not measured yet" — and must never be
// presented as a decline, an increase, or a trustworthy comparison
// point. This is the single, narrow, centralized place that boundary is
// recorded, so agent/lib/firstparty-signals.js's lead-event signal (the
// only consumer) never has to guess it or duplicate it.
//
// Narrowly maintainable on purpose: a flat event-name -> ISO-date map,
// nothing else. Adding a future lead event means adding one line here
// with its own real production ship date (verified the same way these
// were — git history of the actual instrumenting commit — never
// guessed).

// The full "lead event" vocabulary this phase's GA4 lead-event signal
// is permitted to request/report on — deliberately NOT every gtag event
// this site fires (e.g. `before_after_interaction` and the Instagram
// carousel's own tracking are excluded; neither represents a lead/
// conversion action).
const LEAD_EVENT_NAMES = [
  "phone_click",
  "sms_click",
  "contact_form_start",
  "generate_lead",
  "booking_started",
  "booking_service_selected",
  "booking_date_selected",
  "booking_form_completed",
];

// ISO date (UTC, "YYYY-MM-DD") each event has been live in production
// since — the actual commit date of the change that shipped it (see
// this file's header). Never a guess, never "today," never backfilled
// without re-deriving from git history first.
const INSTRUMENTED_SINCE = {
  phone_click: "2026-08-11",
  booking_started: "2026-08-11",
  booking_service_selected: "2026-08-11",
  booking_date_selected: "2026-08-11",
  booking_form_completed: "2026-08-11",
  sms_click: "2026-09-14",
  contact_form_start: "2026-09-14",
  generate_lead: "2026-09-14",
};

/**
 * True only when `windowStartDate` (a "YYYY-MM-DD" string, e.g. a
 * fetched evidence window's own `start`) falls ON OR AFTER the event's
 * own instrumentation date — i.e. the ENTIRE window is covered by real
 * measurement for this event. An unknown event name is treated as
 * "never instrumented" (false) — fail safe, never assume coverage for
 * something this file doesn't explicitly know about.
 * @param {string} eventName
 * @param {string} windowStartDate - "YYYY-MM-DD"
 */
function isEventFullyInstrumentedForWindow(eventName, windowStartDate) {
  const since = INSTRUMENTED_SINCE[eventName];
  if (!since) return false;
  return String(windowStartDate) >= since; // safe lexical compare for "YYYY-MM-DD" strings
}

module.exports = { LEAD_EVENT_NAMES, INSTRUMENTED_SINCE, isEventFullyInstrumentedForWindow };
