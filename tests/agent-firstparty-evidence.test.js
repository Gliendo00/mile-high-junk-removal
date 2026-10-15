// Site Improvement Agent, Phase 6 — tests for agent/lib/firstparty-
// evidence.js (the normalized Search Console/GA4/URL Inspection evidence
// schema). Mirrors tests/agent-research.test.js's validation-discipline
// tests for makeResearchResult().
//
// Run with:  node tests/agent-firstparty-evidence.test.js

const assert = require("assert");
const {
  makeFirstPartyEvidence,
  computeFirstPartyFreshness,
  SOURCES,
  SCOPE_TYPES,
  FRESHNESS_WINDOWS_DAYS,
} = require("../agent/lib/firstparty-evidence");

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

function validArgs(overrides) {
  return {
    findingKey: "coverage-gap-candidate::aurora-junk-removal.html",
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    dimension: "query",
    scope: { type: "city", value: "Aurora" },
    window: { start: "2026-09-13", end: "2026-10-10", label: "28 days ending 2026-10-10" },
    observed: { totalRowsReturned: 2, topRows: [{ keys: ["aurora junk removal"], clicks: 4, impressions: 120, ctr: 0.033, position: 8.2 }] },
    context: "Targeted Search Analytics query for city \"Aurora\" over 28 days ending 2026-10-10.",
    limitations: "Search behavior only — does not establish visitor intent or that a page change is warranted.",
    ...overrides,
  };
}

test("makeFirstPartyEvidence requires metric/context/limitations — missing any throws", () => {
  for (const field of ["metric", "context", "limitations"]) {
    assert.throws(() => makeFirstPartyEvidence(validArgs({ [field]: undefined })), new RegExp(field));
  }
});

test("makeFirstPartyEvidence rejects an unrecognized source", () => {
  assert.throws(() => makeFirstPartyEvidence(validArgs({ source: "a-guess" })), /source/);
});

test("makeFirstPartyEvidence requires a valid scope {type, value}", () => {
  assert.throws(() => makeFirstPartyEvidence(validArgs({ scope: undefined })), /scope/);
  assert.throws(() => makeFirstPartyEvidence(validArgs({ scope: { type: "not-a-type", value: "x" } })), /scope/);
  assert.throws(() => makeFirstPartyEvidence(validArgs({ scope: { type: "city", value: "" } })), /scope/);
});

test("makeFirstPartyEvidence requires window.start/end/label", () => {
  assert.throws(() => makeFirstPartyEvidence(validArgs({ window: undefined })), /window/);
  assert.throws(() => makeFirstPartyEvidence(validArgs({ window: { start: "2026-10-01", end: "2026-10-10" } })), /window/);
});

test("makeFirstPartyEvidence requires a non-null `observed` value — evidence may not assert nothing was observed", () => {
  assert.throws(() => makeFirstPartyEvidence(validArgs({ observed: undefined })), /observed/);
  assert.throws(() => makeFirstPartyEvidence(validArgs({ observed: null })), /observed/);
  // Falsy-but-real observed values (0, false, "") are legitimate observations, not "nothing observed".
  assert.doesNotThrow(() => makeFirstPartyEvidence(validArgs({ observed: 0 })));
});

test("makeFirstPartyEvidence has NO verdict/confidence/recommendation field — structurally cannot carry a judgment", () => {
  const evidence = makeFirstPartyEvidence(validArgs());
  assert.strictEqual(evidence.verdict, undefined);
  assert.strictEqual(evidence.confidence, undefined);
  assert.strictEqual(evidence.recommendation, undefined);
  assert.deepStrictEqual(
    Object.keys(evidence).sort(),
    ["comparisonWindow", "context", "dimension", "fetchedAt", "findingKey", "rotationSlug", "requestFingerprint", "limitations", "metric", "observed", "scope", "source", "window"].sort()
  );
});

test("requestFingerprint is optional — defaults to null, and round-trips when provided", () => {
  const a = makeFirstPartyEvidence(validArgs());
  assert.strictEqual(a.requestFingerprint, null);
  const b = makeFirstPartyEvidence(validArgs({ requestFingerprint: "seasonal cleanout guide" }));
  assert.strictEqual(b.requestFingerprint, "seasonal cleanout guide");
});

test("makeFirstPartyEvidence never stores a raw API payload field — only the bounded `observed` shape the caller provided", () => {
  const evidence = makeFirstPartyEvidence(validArgs({ observed: { totalRowsReturned: 1, topRows: [{ clicks: 1 }] } }));
  assert.strictEqual(JSON.stringify(evidence).includes('"raw"'), false);
});

test("findingKey is optional — evidence not tied to a specific finding is still valid", () => {
  const evidence = makeFirstPartyEvidence(validArgs({ findingKey: undefined }));
  assert.strictEqual(evidence.findingKey, null);
});

test("fetchedAt defaults to now when omitted, and is preserved when provided", () => {
  const a = makeFirstPartyEvidence(validArgs());
  assert.ok(a.fetchedAt);
  const fixed = "2026-01-01T00:00:00.000Z";
  const b = makeFirstPartyEvidence(validArgs({ fetchedAt: fixed }));
  assert.strictEqual(b.fetchedAt, fixed);
});

test("comparisonWindow defaults to null and is normalized when provided", () => {
  const a = makeFirstPartyEvidence(validArgs());
  assert.strictEqual(a.comparisonWindow, null);
  const b = makeFirstPartyEvidence(
    validArgs({ comparisonWindow: { start: "2026-08-16", end: "2026-09-12", label: "prior 28 days" } })
  );
  assert.deepStrictEqual(b.comparisonWindow, { start: "2026-08-16", end: "2026-09-12", label: "prior 28 days" });
});

test("SOURCES/SCOPE_TYPES are non-empty exported lists covering every source this phase implements", () => {
  assert.deepStrictEqual(SOURCES.sort(), ["ga4", "search-console-search-analytics", "search-console-url-inspection"].sort());
  assert.ok(SCOPE_TYPES.length > 0);
});

// -----------------------------------------------------------------------
// computeFirstPartyFreshness — freshness/comparison windows (brief §6)
// -----------------------------------------------------------------------

test("computeFirstPartyFreshness: fresh just after fetch, for every source", () => {
  const now = new Date("2026-10-14T00:00:00Z");
  for (const source of SOURCES) {
    const evidence = makeFirstPartyEvidence(validArgs({ source, fetchedAt: "2026-10-14T00:00:00Z" }));
    assert.strictEqual(computeFirstPartyFreshness(evidence, now).status, "fresh");
  }
});

test("computeFirstPartyFreshness: search-console-search-analytics ages at its documented window", () => {
  const { aging, stale } = FRESHNESS_WINDOWS_DAYS["search-console-search-analytics"];
  const fetchedAt = new Date("2026-10-01T00:00:00Z");
  const agingNow = new Date(fetchedAt.getTime() + aging * 24 * 60 * 60 * 1000);
  const staleNow = new Date(fetchedAt.getTime() + stale * 24 * 60 * 60 * 1000);
  const evidence = makeFirstPartyEvidence(validArgs({ fetchedAt: fetchedAt.toISOString() }));
  assert.strictEqual(computeFirstPartyFreshness(evidence, agingNow).status, "aging");
  assert.strictEqual(computeFirstPartyFreshness(evidence, staleNow).status, "stale");
});

test("computeFirstPartyFreshness: ga4 has the shortest aging window (near-real-time data goes stale fastest)", () => {
  const ga4Window = FRESHNESS_WINDOWS_DAYS.ga4;
  const gscWindow = FRESHNESS_WINDOWS_DAYS["search-console-search-analytics"];
  assert.ok(ga4Window.aging < gscWindow.aging);
});

test("computeFirstPartyFreshness falls back to a conservative default window for an unrecognized source (defense in depth)", () => {
  const evidence = { source: "future-source", fetchedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString() };
  const result = computeFirstPartyFreshness(evidence);
  assert.ok(["fresh", "aging", "stale"].includes(result.status));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
