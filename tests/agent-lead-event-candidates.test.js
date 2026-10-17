// Site Improvement Agent, Phase 12 — tests for
// agent/lib/lead-event-candidates.js: deterministic, narrow candidate
// eligibility and mechanical request-building for GA4 lead-event
// landing-page evidence.
//
// Run with:  node tests/agent-lead-event-candidates.test.js

const assert = require("assert");
const { isLeadEventEvidenceCandidate, buildLeadEventEvidenceRequests, needsLeadEventEvidenceRefresh } = require("../agent/lib/lead-event-candidates");
const { LEAD_EVENT_NAMES } = require("../agent/lib/lead-event-instrumentation");
const { makeFirstPartyEvidence } = require("../agent/lib/firstparty-evidence");

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

function contentGapFinding(overrides) {
  return {
    key: "content-gap::golden-junk-removal.html",
    type: "content-gap",
    tier: "opportunity",
    decision: "NO_CHANGE",
    pages: ["golden-junk-removal.html"],
    ...overrides,
  };
}

// --- isLeadEventEvidenceCandidate() — narrow, deterministic ------------

test("a content-gap/structural-inconsistency finding on a real city/service page IS a candidate", () => {
  assert.strictEqual(isLeadEventEvidenceCandidate(contentGapFinding()), true);
  assert.strictEqual(isLeadEventEvidenceCandidate(contentGapFinding({ type: "structural-inconsistency" })), true);
});

test("a BLOG page finding is NEVER a candidate — blog posts are content, not a conversion destination", () => {
  assert.strictEqual(isLeadEventEvidenceCandidate(contentGapFinding({ key: "content-gap::blog-seasonal-cleanout-guide.html", pages: ["blog-seasonal-cleanout-guide.html"] })), false);
});

test("a UTILITY page finding is NEVER a candidate — no conversion intent by design", () => {
  assert.strictEqual(isLeadEventEvidenceCandidate(contentGapFinding({ pages: ["privacy-policy.html"] })), false);
});

test("a technical/category-A finding type is never a candidate, same base rule as isQueryPageEvidenceCandidate()", () => {
  assert.strictEqual(isLeadEventEvidenceCandidate(contentGapFinding({ type: "broken-link" })), false);
});

test("an observation-tier finding is never a candidate", () => {
  assert.strictEqual(isLeadEventEvidenceCandidate(contentGapFinding({ tier: "observation" })), false);
});

test("an APPLY_SAFE_FIX finding is never a candidate", () => {
  assert.strictEqual(isLeadEventEvidenceCandidate(contentGapFinding({ decision: "APPLY_SAFE_FIX" })), false);
});

test("a multi-page finding is never a candidate", () => {
  assert.strictEqual(isLeadEventEvidenceCandidate(contentGapFinding({ pages: ["a.html", "b.html"] })), false);
});

test("isLeadEventEvidenceCandidate(null/undefined) degrades to false, never throws", () => {
  assert.strictEqual(isLeadEventEvidenceCandidate(null), false);
  assert.strictEqual(isLeadEventEvidenceCandidate(undefined), false);
});

// --- buildLeadEventEvidenceRequests() -----------------------------------

test("buildLeadEventEvidenceRequests() returns exactly TWO GA4 requests: session-context (dimensions:[landingPage]) and event-detail (dimensions:[eventName])", () => {
  const [sessionReq, eventReq] = buildLeadEventEvidenceRequests(contentGapFinding());
  assert.strictEqual(sessionReq.type, "ga4");
  assert.deepStrictEqual(sessionReq.dimensions, ["landingPage"]);
  assert.deepStrictEqual(sessionReq.metrics, ["sessions"]);
  assert.strictEqual(eventReq.type, "ga4");
  assert.deepStrictEqual(eventReq.dimensions, ["eventName"]);
  assert.deepStrictEqual(eventReq.metrics, ["eventCount"]);
});

test("buildLeadEventEvidenceRequests() NEVER requests the conversions/keyEvents metric", () => {
  const [sessionReq, eventReq] = buildLeadEventEvidenceRequests(contentGapFinding());
  for (const req of [sessionReq, eventReq]) {
    assert.strictEqual(req.metrics.includes("conversions"), false);
    assert.strictEqual(req.metrics.includes("keyEvents"), false);
  }
});

test("both requests filter to the EXACT landing page path ('/' + the page's own repo-relative file name)", () => {
  const [sessionReq, eventReq] = buildLeadEventEvidenceRequests(contentGapFinding());
  assert.strictEqual(sessionReq.dimensionFilter.filter.fieldName, "landingPage");
  assert.strictEqual(sessionReq.dimensionFilter.filter.stringFilter.value, "/golden-junk-removal.html");
  const landingPageFilter = eventReq.dimensionFilter.andGroup.expressions.find((e) => e.filter.fieldName === "landingPage");
  assert.strictEqual(landingPageFilter.filter.stringFilter.value, "/golden-junk-removal.html");
});

test("the event-detail request filters eventName to EXACTLY lead-event-instrumentation.js's own LEAD_EVENT_NAMES list — never an open-ended eventName sweep", () => {
  const [, eventReq] = buildLeadEventEvidenceRequests(contentGapFinding());
  const eventNameFilter = eventReq.dimensionFilter.andGroup.expressions.find((e) => e.filter.fieldName === "eventName");
  assert.deepStrictEqual(eventNameFilter.filter.inListFilter.values, LEAD_EVENT_NAMES);
});

test("both requests set compareToPreviousPeriod:true and share the same findingKey/scope", () => {
  const finding = contentGapFinding();
  const [sessionReq, eventReq] = buildLeadEventEvidenceRequests(finding);
  assert.strictEqual(sessionReq.compareToPreviousPeriod, true);
  assert.strictEqual(eventReq.compareToPreviousPeriod, true);
  assert.strictEqual(sessionReq.findingKey, finding.key);
  assert.strictEqual(eventReq.findingKey, finding.key);
  assert.deepStrictEqual(sessionReq.scope, eventReq.scope);
});

test("buildLeadEventEvidenceRequests() respects an explicit days override on both requests", () => {
  const [sessionReq, eventReq] = buildLeadEventEvidenceRequests(contentGapFinding(), { days: 14 });
  assert.strictEqual(sessionReq.days, 14);
  assert.strictEqual(eventReq.days, 14);
});

// --- needsLeadEventEvidenceRefresh() — freshness, not permanent suppression ---

function ga4Entry(findingKey, dimension, fetchedAt) {
  return makeFirstPartyEvidence({
    findingKey,
    source: "ga4",
    metric: dimension === "landingPage" ? "sessions" : "eventCount",
    dimension,
    scope: { type: "page", value: "golden-junk-removal.html" },
    window: { start: "2026-09-18", end: "2026-10-15", label: "l" },
    observed: { totalRowsReturned: 1, topRows: [{ dimensions: ["x"], metrics: ["1"] }] },
    context: "c",
    limitations: "l",
    fetchedAt,
  });
}

test("needsLeadEventEvidenceRefresh() is TRUE when there is no evidence at all for this finding", () => {
  assert.strictEqual(needsLeadEventEvidenceRefresh(contentGapFinding(), []), true);
});

test("needsLeadEventEvidenceRefresh() is FALSE only when BOTH required shapes are fresh for this finding's key", () => {
  const finding = contentGapFinding();
  const now = new Date();
  const entries = [ga4Entry(finding.key, "landingPage", now.toISOString()), ga4Entry(finding.key, "eventName", now.toISOString())];
  assert.strictEqual(needsLeadEventEvidenceRefresh(finding, entries, now), false);
});

test("needsLeadEventEvidenceRefresh() is TRUE when only ONE of the two required shapes is present", () => {
  const finding = contentGapFinding();
  const now = new Date();
  const onlySession = [ga4Entry(finding.key, "landingPage", now.toISOString())];
  assert.strictEqual(needsLeadEventEvidenceRefresh(finding, onlySession, now), true);
});

test("needsLeadEventEvidenceRefresh() is TRUE when both shapes exist but are STALE — treated as absent, eligible for re-fetch, never permanently suppressed", () => {
  const finding = contentGapFinding();
  const now = new Date();
  const ancient = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(); // GA4 stale window is 14 days
  const entries = [ga4Entry(finding.key, "landingPage", ancient), ga4Entry(finding.key, "eventName", ancient)];
  assert.strictEqual(needsLeadEventEvidenceRefresh(finding, entries, now), true);
});

test("needsLeadEventEvidenceRefresh() ignores evidence for a DIFFERENT findingKey", () => {
  const finding = contentGapFinding();
  const now = new Date();
  const entries = [ga4Entry("some-other-finding-key", "landingPage", now.toISOString()), ga4Entry("some-other-finding-key", "eventName", now.toISOString())];
  assert.strictEqual(needsLeadEventEvidenceRefresh(finding, entries, now), true);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
