// Site Improvement Agent, Phase 12 — tests for
// agent/lib/lead-event-instrumentation.js: the narrow, centralized
// record of when each GA4 lead event actually went live in production,
// and the boundary check that keeps a comparison from ever treating
// pre-instrumentation absence as a real zero.
//
// Run with:  node tests/agent-lead-event-instrumentation.test.js

const assert = require("assert");
const { LEAD_EVENT_NAMES, INSTRUMENTED_SINCE, isEventFullyInstrumentedForWindow } = require("../agent/lib/lead-event-instrumentation");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

test("every LEAD_EVENT_NAMES entry has a corresponding INSTRUMENTED_SINCE date — no event is trackable without a known boundary", () => {
  for (const name of LEAD_EVENT_NAMES) {
    assert.ok(INSTRUMENTED_SINCE[name], `expected an INSTRUMENTED_SINCE date for "${name}"`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(INSTRUMENTED_SINCE[name]), `expected an ISO "YYYY-MM-DD" date for "${name}"`);
  }
});

test("isEventFullyInstrumentedForWindow() returns true when the window starts ON the instrumentation date", () => {
  assert.strictEqual(isEventFullyInstrumentedForWindow("phone_click", "2026-08-11"), true);
});

test("isEventFullyInstrumentedForWindow() returns true when the window starts well AFTER the instrumentation date", () => {
  assert.strictEqual(isEventFullyInstrumentedForWindow("phone_click", "2026-10-01"), true);
});

test("isEventFullyInstrumentedForWindow() returns false when the window starts BEFORE the instrumentation date — the exact case a 28-vs-28-day comparison can hit today for the later-instrumented events", () => {
  assert.strictEqual(isEventFullyInstrumentedForWindow("sms_click", "2026-08-20"), false);
  assert.strictEqual(isEventFullyInstrumentedForWindow("generate_lead", "2026-09-13"), false);
});

test("isEventFullyInstrumentedForWindow() returns false (fail-safe) for an unknown event name — never assumes coverage for something it doesn't know about", () => {
  assert.strictEqual(isEventFullyInstrumentedForWindow("some_future_event_nobody_registered", "2020-01-01"), false);
});

test("phone_click/booking funnel events share the earlier (2026-08-11) boundary; sms_click/contact-form events share the later (2026-09-14) boundary — reflecting their real, separately-shipped commits", () => {
  for (const name of ["phone_click", "booking_started", "booking_service_selected", "booking_date_selected", "booking_form_completed"]) {
    assert.strictEqual(INSTRUMENTED_SINCE[name], "2026-08-11", `expected "${name}" to be boundaried at the earlier ship date`);
  }
  for (const name of ["sms_click", "contact_form_start", "generate_lead"]) {
    assert.strictEqual(INSTRUMENTED_SINCE[name], "2026-09-14", `expected "${name}" to be boundaried at the later ship date`);
  }
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
