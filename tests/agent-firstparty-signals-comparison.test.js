// Site Improvement Agent, Phase 12 — functional/correctness tests for
// the three new comparison/delta signal detectors in
// agent/lib/firstparty-signals.js: search-visibility-change,
// query-visibility-shift, lead-event-landing-page-delta. Safety/
// non-decision-influence properties are covered separately in
// tests/agent-firstparty-signals-safety.test.js (extended for Phase 12).
//
// Run with:  node tests/agent-firstparty-signals-comparison.test.js

const assert = require("assert");
const { makeFirstPartyEvidence } = require("../agent/lib/firstparty-evidence");
const {
  deriveSearchVisibilityChangeSignal,
  deriveQueryVisibilityShiftSignal,
  deriveLeadEventLandingPageDeltaSignal,
  aggregateSearchAnalyticsTotals,
  computeMetricDelta,
} = require("../agent/lib/firstparty-signals");

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

const FINDING = { key: "content-gap::golden-junk-removal.html", pages: ["golden-junk-removal.html"] };

function gscEvidence({ dimension, topRows, previousTopRows, comparisonWindow, window } = {}) {
  return makeFirstPartyEvidence({
    findingKey: FINDING.key,
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    dimension: dimension || "query+page",
    scope: { type: "page", value: "golden-junk-removal.html" },
    window: window || { start: "2026-09-18", end: "2026-10-15", label: "28 days ending 2026-10-15" },
    comparisonWindow: comparisonWindow === undefined ? { start: "2026-08-21", end: "2026-09-17", label: "28 days ending 2026-09-17 (comparison period)" } : comparisonWindow,
    observed: {
      totalRowsReturned: (topRows || []).length,
      topRows: topRows || [],
      ...(previousTopRows !== undefined ? { previousPeriod: { totalRowsReturned: previousTopRows.length, topRows: previousTopRows } } : {}),
    },
    context: "c",
    limitations: "l",
  });
}

// --- aggregateSearchAnalyticsTotals() / computeMetricDelta() -----------

test("aggregateSearchAnalyticsTotals() sums clicks/impressions and computes an impressions-weighted average position + recomputed CTR", () => {
  const totals = aggregateSearchAnalyticsTotals([
    { clicks: 2, impressions: 100, ctr: 0.02, position: 10 },
    { clicks: 8, impressions: 100, ctr: 0.08, position: 4 },
  ]);
  assert.strictEqual(totals.impressions, 200);
  assert.strictEqual(totals.clicks, 10);
  assert.strictEqual(totals.ctr, 10 / 200);
  assert.strictEqual(totals.position, 7, "impressions-weighted average of 10 and 4 at equal weight = 7, never a naive average of the two rows' own ctr/position");
});

test("aggregateSearchAnalyticsTotals() returns null (never 0) for ctr/position when impressions is 0 — a true zero-denominator case", () => {
  const totals = aggregateSearchAnalyticsTotals([]);
  assert.strictEqual(totals.impressions, 0);
  assert.strictEqual(totals.ctr, null);
  assert.strictEqual(totals.position, null);
});

test("computeMetricDelta() returns absolute AND relative delta together", () => {
  const d = computeMetricDelta(120, 100);
  assert.strictEqual(d.absoluteDelta, 20);
  assert.strictEqual(d.relativeDelta, 0.2);
});

test("computeMetricDelta() NEVER fabricates a relative delta from a zero denominator — represents it explicitly as \"not-computable\"", () => {
  const d = computeMetricDelta(50, 0);
  assert.strictEqual(d.absoluteDelta, 50);
  assert.strictEqual(d.relativeDelta, "not-computable");
});

test("computeMetricDelta() returns \"not-computable\" (never NaN) when either value isn't a real number (e.g. a null CTR from a zero-impression period)", () => {
  const d = computeMetricDelta(null, 0.05);
  assert.strictEqual(d.absoluteDelta, null);
  assert.strictEqual(d.relativeDelta, "not-computable");
});

// --- deriveSearchVisibilityChangeSignal() -------------------------------

test("deriveSearchVisibilityChangeSignal() returns null when there is no comparisonWindow at all (compareToPreviousPeriod wasn't requested)", () => {
  const evidence = gscEvidence({ topRows: [{ clicks: 1, impressions: 50, ctr: 0.02, position: 5 }], comparisonWindow: null });
  assert.strictEqual(deriveSearchVisibilityChangeSignal(FINDING, evidence), null);
});

test("deriveSearchVisibilityChangeSignal() returns null below the sufficiency floor (combined impressions too low) — never a fabricated signal from noise", () => {
  const evidence = gscEvidence({ topRows: [{ clicks: 0, impressions: 2, ctr: 0, position: 9 }], previousTopRows: [{ clicks: 0, impressions: 3, ctr: 0, position: 9 }] });
  assert.strictEqual(deriveSearchVisibilityChangeSignal(FINDING, evidence), null);
});

test("deriveSearchVisibilityChangeSignal() produces a signal carrying impressions/clicks/ctr/position deltas together, with sufficiency and both windows recorded", () => {
  const evidence = gscEvidence({
    topRows: [{ clicks: 6, impressions: 120, ctr: 0.05, position: 6 }],
    previousTopRows: [{ clicks: 3, impressions: 100, ctr: 0.03, position: 9 }],
  });
  const signal = deriveSearchVisibilityChangeSignal(FINDING, evidence);
  assert.ok(signal);
  assert.strictEqual(signal.type, "search-visibility-change");
  assert.strictEqual(signal.sufficiency, "sufficient");
  assert.strictEqual(signal.impressions.absoluteDelta, 20);
  assert.strictEqual(signal.clicks.absoluteDelta, 3);
  assert.ok(signal.window && signal.comparisonWindow);
  assert.strictEqual(signal.posture, "investigation-only — never a decision, proposal, approval, or rejection; agent/lib/decision.js does not read this signal and cannot be influenced by it.");
  assert.ok(signal.limitations.includes("does NOT explain WHY"));
});

test("deriveSearchVisibilityChangeSignal() marks 'limited' sufficiency in its own reason text when volume is thin but above the floor", () => {
  const evidence = gscEvidence({ topRows: [{ clicks: 1, impressions: 15, ctr: 0.066, position: 8 }], previousTopRows: [{ clicks: 1, impressions: 15, ctr: 0.066, position: 8 }] });
  const signal = deriveSearchVisibilityChangeSignal(FINDING, evidence);
  assert.strictEqual(signal.sufficiency, "limited");
  assert.ok(signal.reason.includes("thin"));
});

test("deriveSearchVisibilityChangeSignal() returns null for a non-search-console-search-analytics / non-query+page-like evidence source", () => {
  const ga4 = makeFirstPartyEvidence({
    findingKey: FINDING.key,
    source: "ga4",
    metric: "sessions",
    dimension: "landingPage",
    scope: { type: "page", value: "golden-junk-removal.html" },
    window: { start: "2026-09-18", end: "2026-10-15", label: "l" },
    comparisonWindow: { start: "2026-08-21", end: "2026-09-17", label: "l" },
    observed: { totalRowsReturned: 1, topRows: [{ dimensions: ["x"], metrics: ["5"] }], previousPeriod: { totalRowsReturned: 1, topRows: [{ dimensions: ["x"], metrics: ["4"] }] } },
    context: "c",
    limitations: "l",
  });
  assert.strictEqual(deriveSearchVisibilityChangeSignal(FINDING, ga4), null);
});

// --- deriveQueryVisibilityShiftSignal() ---------------------------------

test("deriveQueryVisibilityShiftSignal() returns null when both periods have zero rows", () => {
  const evidence = gscEvidence({ topRows: [], previousTopRows: [] });
  assert.strictEqual(deriveQueryVisibilityShiftSignal(FINDING, evidence), null);
});

test("deriveQueryVisibilityShiftSignal() returns null when the query set is IDENTICAL between periods — nothing shifted", () => {
  const row = { keys: ["golden junk removal", "golden-junk-removal.html"], clicks: 2, impressions: 40, ctr: 0.05, position: 6 };
  const evidence = gscEvidence({ topRows: [row], previousTopRows: [row] });
  assert.strictEqual(deriveQueryVisibilityShiftSignal(FINDING, evidence), null);
});

test("deriveQueryVisibilityShiftSignal() reports gained and lost queries correctly, and NEVER claims a lost query stopped ranking", () => {
  const current = [{ keys: ["golden junk hauling", "golden-junk-removal.html"], clicks: 1, impressions: 20, ctr: 0.05, position: 7 }];
  const previous = [{ keys: ["golden trash removal", "golden-junk-removal.html"], clicks: 2, impressions: 30, ctr: 0.066, position: 5 }];
  const evidence = gscEvidence({ topRows: current, previousTopRows: previous });
  const signal = deriveQueryVisibilityShiftSignal(FINDING, evidence);
  assert.ok(signal);
  assert.strictEqual(signal.type, "query-visibility-shift");
  assert.strictEqual(signal.gainedQueries.length, 1);
  assert.strictEqual(signal.gainedQueries[0].query, "golden junk hauling");
  assert.strictEqual(signal.lostQueries.length, 1);
  assert.strictEqual(signal.lostQueries[0].query, "golden trash removal");
  assert.ok(!signal.limitations.includes("stopped ranking") || signal.limitations.includes("NEVER"), "the limitations text must explicitly rule out the 'stopped ranking' misinterpretation");
  assert.ok(signal.limitations.toLowerCase().includes("bounded"));
});

test("deriveQueryVisibilityShiftSignal() is case/whitespace-insensitive when matching queries across periods (same query, different casing, is not a false 'shift')", () => {
  const current = [{ keys: [" Golden Junk Removal ", "golden-junk-removal.html"], clicks: 1, impressions: 20, ctr: 0.05, position: 6 }];
  const previous = [{ keys: ["golden junk removal", "golden-junk-removal.html"], clicks: 1, impressions: 18, ctr: 0.055, position: 6 }];
  const evidence = gscEvidence({ topRows: current, previousTopRows: previous });
  assert.strictEqual(deriveQueryVisibilityShiftSignal(FINDING, evidence), null);
});

test("deriveQueryVisibilityShiftSignal() returns null without comparisonWindow", () => {
  const evidence = gscEvidence({ topRows: [{ keys: ["q", "golden-junk-removal.html"], clicks: 1, impressions: 20, ctr: 0.05, position: 6 }], comparisonWindow: null });
  assert.strictEqual(deriveQueryVisibilityShiftSignal(FINDING, evidence), null);
});

// --- deriveLeadEventLandingPageDeltaSignal() ----------------------------

function ga4SessionEvidence({ current, previous, comparisonWindow } = {}) {
  return makeFirstPartyEvidence({
    findingKey: FINDING.key,
    source: "ga4",
    metric: "sessions",
    dimension: "landingPage",
    scope: { type: "page", value: "golden-junk-removal.html" },
    window: { start: "2026-09-18", end: "2026-10-15", label: "28 days ending 2026-10-15" },
    comparisonWindow: comparisonWindow === undefined ? { start: "2026-08-21", end: "2026-09-17", label: "28 days ending 2026-09-17 (comparison period)" } : comparisonWindow,
    observed: {
      totalRowsReturned: 1,
      topRows: [{ dimensions: ["/golden-junk-removal.html"], metrics: [String(current)] }],
      ...(previous !== undefined ? { previousPeriod: { totalRowsReturned: 1, topRows: [{ dimensions: ["/golden-junk-removal.html"], metrics: [String(previous)] }] } } : {}),
    },
    context: "c",
    limitations: "l",
  });
}

function ga4EventEvidence({ currentRows, previousRows, comparisonWindow } = {}) {
  return makeFirstPartyEvidence({
    findingKey: FINDING.key,
    source: "ga4",
    metric: "eventCount",
    dimension: "eventName",
    scope: { type: "page", value: "golden-junk-removal.html" },
    window: { start: "2026-09-18", end: "2026-10-15", label: "28 days ending 2026-10-15" },
    comparisonWindow: comparisonWindow === undefined ? { start: "2026-08-21", end: "2026-09-17", label: "28 days ending 2026-09-17 (comparison period)" } : comparisonWindow,
    observed: {
      totalRowsReturned: currentRows.length,
      topRows: currentRows,
      ...(previousRows !== undefined ? { previousPeriod: { totalRowsReturned: previousRows.length, topRows: previousRows } } : {}),
    },
    context: "c",
    limitations: "l",
  });
}

test("deriveLeadEventLandingPageDeltaSignal() returns null when only ONE of the two correlated GA4 entries is present", () => {
  const sessionOnly = [ga4SessionEvidence({ current: 30, previous: 20 })];
  assert.strictEqual(deriveLeadEventLandingPageDeltaSignal(FINDING, sessionOnly), null);
});

test("deriveLeadEventLandingPageDeltaSignal() returns null below the ga4-sessions sufficiency floor", () => {
  const evidenceList = [
    ga4SessionEvidence({ current: 1, previous: 1 }),
    ga4EventEvidence({ currentRows: [{ dimensions: ["generate_lead"], metrics: ["1"] }], previousRows: [] }),
  ];
  assert.strictEqual(deriveLeadEventLandingPageDeltaSignal(FINDING, evidenceList), null);
});

test("deriveLeadEventLandingPageDeltaSignal() computes a per-event delta, alongside session movement, for a FULLY-instrumented event and comparison window", () => {
  const evidenceList = [
    ga4SessionEvidence({ current: 50, previous: 40 }),
    ga4EventEvidence({
      currentRows: [{ dimensions: ["booking_started"], metrics: ["6"] }],
      previousRows: [{ dimensions: ["booking_started"], metrics: ["4"] }],
      comparisonWindow: { start: "2026-08-21", end: "2026-09-17", label: "l" }, // after booking_started's 2026-08-11 boundary
    }),
  ];
  const signal = deriveLeadEventLandingPageDeltaSignal(FINDING, evidenceList);
  assert.ok(signal);
  assert.strictEqual(signal.type, "lead-event-landing-page-delta");
  assert.strictEqual(signal.sessions.absoluteDelta, 10);
  const bookingEvent = signal.events.find((e) => e.eventName === "booking_started");
  assert.ok(bookingEvent);
  assert.strictEqual(bookingEvent.comparisonAvailable, true);
  assert.strictEqual(bookingEvent.delta.absoluteDelta, 2);
});

test("INSTRUMENTATION BOUNDARY: deriveLeadEventLandingPageDeltaSignal() refuses to compute a delta for an event whose comparison window predates its own instrumented-since date — reports current count only, with comparisonAvailable:false, and NEVER implies zero/increase/decrease", () => {
  const evidenceList = [
    ga4SessionEvidence({ current: 50, previous: 40, comparisonWindow: { start: "2026-08-20", end: "2026-09-16", label: "l" } }),
    ga4EventEvidence({
      currentRows: [{ dimensions: ["sms_click"], metrics: ["3"] }],
      previousRows: [], // sms_click did not exist yet during this comparison window
      comparisonWindow: { start: "2026-08-20", end: "2026-09-16", label: "l" }, // BEFORE sms_click's 2026-09-14 boundary
    }),
  ];
  const signal = deriveLeadEventLandingPageDeltaSignal(FINDING, evidenceList);
  assert.ok(signal);
  const smsEvent = signal.events.find((e) => e.eventName === "sms_click");
  assert.ok(smsEvent);
  assert.strictEqual(smsEvent.comparisonAvailable, false);
  assert.strictEqual(smsEvent.current, 3);
  assert.strictEqual(smsEvent.previous, null, "previous must be null, never a fabricated 0");
  assert.strictEqual(smsEvent.delta, null, "delta must be null — no comparison is ever computed across an instrumentation boundary");
  assert.ok(smsEvent.note && smsEvent.note.includes("NOT evidence of zero prior engagement"));
});

test("deriveLeadEventLandingPageDeltaSignal() never reports a non-lead-event name, even if one somehow appeared in the evidence (defensive)", () => {
  const evidenceList = [
    ga4SessionEvidence({ current: 50, previous: 40 }),
    ga4EventEvidence({
      currentRows: [
        { dimensions: ["generate_lead"], metrics: ["4"] },
        { dimensions: ["before_after_interaction"], metrics: ["9"] },
      ],
      previousRows: [{ dimensions: ["generate_lead"], metrics: ["2"] }],
    }),
  ];
  const signal = deriveLeadEventLandingPageDeltaSignal(FINDING, evidenceList);
  assert.ok(signal);
  assert.strictEqual(signal.events.some((e) => e.eventName === "before_after_interaction"), false);
});

test("deriveLeadEventLandingPageDeltaSignal()'s limitations text explicitly rules out causation/revenue inference and names the raw eventName+eventCount approach", () => {
  const evidenceList = [
    ga4SessionEvidence({ current: 50, previous: 40 }),
    ga4EventEvidence({ currentRows: [{ dimensions: ["generate_lead"], metrics: ["4"] }], previousRows: [{ dimensions: ["generate_lead"], metrics: ["2"] }] }),
  ];
  const signal = deriveLeadEventLandingPageDeltaSignal(FINDING, evidenceList);
  assert.ok(signal.limitations.includes("does NOT establish causation"));
  assert.ok(signal.limitations.toLowerCase().includes("revenue"));
  assert.ok(signal.limitations.includes("eventName+eventCount") || signal.limitations.includes("conversions"));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
