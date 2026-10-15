// Site Improvement Agent — tests for agent/lib/finding-evidence.js: the
// weekly finding-level query/page evidence candidate rule, mechanical
// request builder, and freshness check. Mirrors
// tests/agent-rotation-evidence.test.js's own structure/discipline for
// the analogous rotation-side module.
//
// Run with:  node tests/agent-finding-evidence.test.js

const assert = require("assert");
const {
  SOURCE,
  QUERY_PAGE_CANDIDATE_TYPES,
  isQueryPageEvidenceCandidate,
  deriveQueryFilterTerm,
  buildQueryPageEvidenceRequest,
  freshlyEvidencedFindingKeys,
} = require("../agent/lib/finding-evidence");
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
    key: "content-gap::furniture-removal.html",
    type: "content-gap",
    tier: "opportunity",
    decision: "RESEARCH_MORE",
    pages: ["furniture-removal.html"],
    ...overrides,
  };
}

// -----------------------------------------------------------------------
// Candidate rule — narrow and justified
// -----------------------------------------------------------------------

test("QUERY_PAGE_CANDIDATE_TYPES is exactly {content-gap, structural-inconsistency} — a small, fixed set, not every category-C type", () => {
  assert.deepStrictEqual([...QUERY_PAGE_CANDIDATE_TYPES].sort(), ["content-gap", "structural-inconsistency"]);
});

test("a content-gap finding is a candidate", () => {
  assert.strictEqual(isQueryPageEvidenceCandidate(contentGapFinding()), true);
});

test("a structural-inconsistency finding is a candidate", () => {
  assert.strictEqual(isQueryPageEvidenceCandidate(contentGapFinding({ key: "structural-inconsistency::x.html", type: "structural-inconsistency" })), true);
});

test("a technical/category-A finding (e.g. a broken link) is NEVER a candidate, merely for having a URL — the exact case the brief warned against", () => {
  assert.strictEqual(
    isQueryPageEvidenceCandidate({ key: "broken-internal-link::a.html", type: "broken-internal-link", tier: "actionable", decision: "PROPOSE_CHANGE", pages: ["a.html"] }),
    false
  );
});

test("coverage-gap-candidate, overlapping-intent, and duplicate-meta-description are all explicitly NOT candidates in this phase", () => {
  for (const type of ["coverage-gap-candidate", "overlapping-intent", "duplicate-meta-description", "research-gap"]) {
    assert.strictEqual(isQueryPageEvidenceCandidate(contentGapFinding({ type, key: `${type}::x.html` })), false, `${type} must not be a candidate`);
  }
});

test("an observation-tier finding is never a candidate, even if the type would otherwise qualify", () => {
  assert.strictEqual(isQueryPageEvidenceCandidate(contentGapFinding({ tier: "observation" })), false);
});

test("an APPLY_SAFE_FIX finding is never a candidate (defensive — neither real type is ever auto-fixable today)", () => {
  assert.strictEqual(isQueryPageEvidenceCandidate(contentGapFinding({ decision: "APPLY_SAFE_FIX" })), false);
});

test("a multi-page finding (2+ pages) is never a candidate — this module's single-target request shape never force-fits a group", () => {
  assert.strictEqual(isQueryPageEvidenceCandidate(contentGapFinding({ pages: ["a.html", "b.html"] })), false);
  assert.strictEqual(isQueryPageEvidenceCandidate(contentGapFinding({ pages: [] })), false);
  assert.strictEqual(isQueryPageEvidenceCandidate(contentGapFinding({ pages: undefined })), false);
});

test("isQueryPageEvidenceCandidate(null/undefined) degrades to false, never throws", () => {
  assert.strictEqual(isQueryPageEvidenceCandidate(null), false);
  assert.strictEqual(isQueryPageEvidenceCandidate(undefined), false);
});

// -----------------------------------------------------------------------
// Query filter term derivation — mechanical, from the page's own identity
// -----------------------------------------------------------------------

test("deriveQueryFilterTerm() turns a page file name into its plain-words form, reusing decision.js's own existing transform", () => {
  assert.strictEqual(deriveQueryFilterTerm("furniture-removal.html"), "furniture removal");
  assert.strictEqual(deriveQueryFilterTerm("aurora-junk-removal.html"), "aurora junk removal");
  assert.strictEqual(deriveQueryFilterTerm("blog-seasonal-cleanout-guide.html"), "blog seasonal cleanout guide");
});

// -----------------------------------------------------------------------
// Request shape — query-filtered only, never page-filtered
// -----------------------------------------------------------------------

test("buildQueryPageEvidenceRequest() produces a search-analytics request with dimensions [query,page], filtered by QUERY only, never by page", () => {
  const request = buildQueryPageEvidenceRequest(contentGapFinding());
  assert.strictEqual(request.type, "search-analytics");
  assert.strictEqual(request.findingKey, "content-gap::furniture-removal.html");
  assert.deepStrictEqual(request.scope, { type: "page", value: "furniture-removal.html" });
  assert.strictEqual(request.days, 28);
  assert.deepStrictEqual(request.dimensions, ["query", "page"]);
  assert.strictEqual(request.dimensionFilterGroups.length, 1);
  const filter = request.dimensionFilterGroups[0].filters[0];
  assert.strictEqual(filter.dimension, "query");
  assert.strictEqual(filter.operator, "contains");
  assert.strictEqual(filter.expression, "furniture removal");
  assert.ok(typeof request.context === "string" && request.context.length > 0);
});

test("buildQueryPageEvidenceRequest() NEVER includes a page-dimension filter anywhere in dimensionFilterGroups — structural proof, not just today's one example", () => {
  const request = buildQueryPageEvidenceRequest(contentGapFinding());
  const allFilters = request.dimensionFilterGroups.flatMap((g) => g.filters);
  assert.strictEqual(allFilters.some((f) => f.dimension === "page"), false, "a page-dimension filter would make a query-page mismatch structurally undetectable");
});

test("buildQueryPageEvidenceRequest() respects an explicit days override", () => {
  const request = buildQueryPageEvidenceRequest(contentGapFinding(), { days: 14 });
  assert.strictEqual(request.days, 14);
});

// -----------------------------------------------------------------------
// Freshness — stale is treated as absent, fresh/aging blocks a re-fetch
// -----------------------------------------------------------------------

function searchAnalyticsEvidence(findingKey, fetchedAt) {
  return makeFirstPartyEvidence({
    findingKey,
    source: SOURCE,
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: 0, topRows: [] },
    context: "c",
    limitations: "l",
    fetchedAt,
  });
}

test("freshlyEvidencedFindingKeys() includes a findingKey with FRESH search-analytics evidence (fetched just now)", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const entries = [searchAnalyticsEvidence("a", now.toISOString())];
  assert.ok(freshlyEvidencedFindingKeys(entries, now).has("a"));
});

test("freshlyEvidencedFindingKeys() EXCLUDES a findingKey whose evidence is STALE (past the 21-day search-analytics window) — treated as absent, eligible for re-fetch", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const staleFetchedAt = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString();
  const entries = [searchAnalyticsEvidence("a", staleFetchedAt)];
  assert.strictEqual(freshlyEvidencedFindingKeys(entries, now).has("a"), false);
});

test("freshlyEvidencedFindingKeys() still includes an AGING (not yet stale) entry — aging still blocks a redundant re-fetch, only STALE doesn't", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const agingFetchedAt = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString(); // >10d (aging) but <21d (stale)
  const entries = [searchAnalyticsEvidence("a", agingFetchedAt)];
  assert.ok(freshlyEvidencedFindingKeys(entries, now).has("a"));
});

test("freshlyEvidencedFindingKeys() ignores evidence from a different source (e.g. ga4) and evidence with no findingKey (rotation-only entries) — never cross-contaminates the two key spaces", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const ga4Entry = makeFirstPartyEvidence({
    findingKey: "a",
    source: "ga4",
    metric: "sessions",
    dimension: "landingPage",
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: 1, topRows: [] },
    context: "c",
    limitations: "l",
  });
  const rotationOnlyEntry = makeFirstPartyEvidence({
    rotationSlug: "golden",
    source: SOURCE,
    metric: "clicks-impressions-ctr-position",
    scope: { type: "city", value: "Golden" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: 0, topRows: [] },
    context: "c",
    limitations: "l",
  });
  assert.strictEqual(freshlyEvidencedFindingKeys([ga4Entry, rotationOnlyEntry], now).has("a"), false);
});

test("freshlyEvidencedFindingKeys() on an empty/missing entries list returns an empty set, never throws", () => {
  assert.strictEqual(freshlyEvidencedFindingKeys([]).size, 0);
  assert.strictEqual(freshlyEvidencedFindingKeys(undefined).size, 0);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
