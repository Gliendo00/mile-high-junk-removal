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
  freshFindingEvidenceFingerprint,
  needsFindingEvidenceRefresh,
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
});

test("deriveQueryFilterTerm() strips the leading 'blog-' structural prefix for a REAL blog page — that token is a repo convention, never part of the real search topic", () => {
  assert.strictEqual(deriveQueryFilterTerm("blog-seasonal-cleanout-guide.html"), "seasonal cleanout guide");
  assert.strictEqual(deriveQueryFilterTerm("blog-example-post.html"), "example post");
});

test("deriveQueryFilterTerm() leaves a normal service page completely unchanged (no 'blog-' prefix to strip)", () => {
  assert.strictEqual(deriveQueryFilterTerm("furniture-removal.html"), "furniture removal");
});

test("deriveQueryFilterTerm() leaves a normal city page completely unchanged (no 'blog-' prefix to strip)", () => {
  assert.strictEqual(deriveQueryFilterTerm("aurora-junk-removal.html"), "aurora junk removal");
});

test("deriveQueryFilterTerm() does NOT strip a filename that merely starts with similar letters but isn't classified a blog page by isBlogPage() — e.g. 'blogger-...', which has no literal 'blog-' prefix", () => {
  assert.strictEqual(deriveQueryFilterTerm("blogger-marketing-tips.html"), "blogger marketing tips");
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

test("buildQueryPageEvidenceRequest() records the derived term as requestFingerprint, including the blog-prefix fix", () => {
  assert.strictEqual(buildQueryPageEvidenceRequest(contentGapFinding()).requestFingerprint, "furniture removal");
  const blogFinding = contentGapFinding({ key: "content-gap::blog-seasonal-cleanout-guide.html", pages: ["blog-seasonal-cleanout-guide.html"] });
  assert.strictEqual(buildQueryPageEvidenceRequest(blogFinding).requestFingerprint, "seasonal cleanout guide");
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

// -----------------------------------------------------------------------
// Fingerprint-aware freshness — lets a corrected deriveQueryFilterTerm()
// self-heal its own prior evidence without a one-time manual deletion
// -----------------------------------------------------------------------

function contentGapFindingFor(page) {
  return contentGapFinding({ key: `content-gap::${page}`, pages: [page] });
}

test("freshFindingEvidenceFingerprint() returns undefined when there is no fresh-or-aging entry for the key at all", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  assert.strictEqual(freshFindingEvidenceFingerprint([], "a", now), undefined);
});

test("freshFindingEvidenceFingerprint() returns null for a fresh-or-aging entry written before requestFingerprint existed (no field at all)", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const entries = [searchAnalyticsEvidence("a", now.toISOString())]; // no requestFingerprint passed
  assert.strictEqual(freshFindingEvidenceFingerprint(entries, "a", now), null);
});

test("freshFindingEvidenceFingerprint() returns the recorded fingerprint when present", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const entry = makeFirstPartyEvidence({
    findingKey: "a",
    requestFingerprint: "furniture removal",
    source: SOURCE,
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: 0, topRows: [] },
    context: "c",
    limitations: "l",
    fetchedAt: now.toISOString(),
  });
  assert.strictEqual(freshFindingEvidenceFingerprint([entry], "a", now), "furniture removal");
});

test("needsFindingEvidenceRefresh() is true when there is no fresh-or-aging evidence at all", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  assert.strictEqual(needsFindingEvidenceRefresh(contentGapFindingFor("furniture-removal.html"), [], now), true);
});

test("needsFindingEvidenceRefresh() is false when fresh evidence was recorded under the SAME current-derivation fingerprint — a genuinely redundant fetch is correctly skipped", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const finding = contentGapFindingFor("furniture-removal.html");
  const entry = makeFirstPartyEvidence({
    findingKey: finding.key,
    requestFingerprint: "furniture removal",
    source: SOURCE,
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: 0, topRows: [] },
    context: "c",
    limitations: "l",
    fetchedAt: now.toISOString(),
  });
  assert.strictEqual(needsFindingEvidenceRefresh(finding, [entry], now), false);
});

test("THE ONE-TIME FIX: needsFindingEvidenceRefresh() is TRUE for fresh, legacy evidence written before requestFingerprint existed (e.g. the real blog-seasonal-cleanout-guide.html evidence fetched under the old 'blog seasonal cleanout guide' term) — self-heals without deleting the obsolete file or weakening freshness", () => {
  const now = new Date("2026-10-15T18:00:00.000Z");
  const finding = contentGapFindingFor("blog-seasonal-cleanout-guide.html");
  // Simulates the real, already-committed evidence file: fetched moments
  // ago (date-fresh) but with NO requestFingerprint field at all, because
  // it predates this fix and was fetched using the OLD, weaker term.
  const legacyEntry = searchAnalyticsEvidence(finding.key, now.toISOString());
  assert.strictEqual(needsFindingEvidenceRefresh(finding, [legacyEntry], now), true, "legacy evidence recorded under an unknown/older term must never block a corrected re-fetch, even while date-fresh");
});

test("needsFindingEvidenceRefresh() is TRUE when fresh evidence exists but was recorded under an explicitly DIFFERENT fingerprint (derivation logic changed again in the future)", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const finding = contentGapFindingFor("furniture-removal.html");
  const entry = makeFirstPartyEvidence({
    findingKey: finding.key,
    requestFingerprint: "some older term",
    source: SOURCE,
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: 0, topRows: [] },
    context: "c",
    limitations: "l",
    fetchedAt: now.toISOString(),
  });
  assert.strictEqual(needsFindingEvidenceRefresh(finding, [entry], now), true);
});

test("needsFindingEvidenceRefresh() is TRUE for STALE evidence even if its fingerprint matches — staleness alone is still sufficient, unchanged from freshlyEvidencedFindingKeys()'s existing rule", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const finding = contentGapFindingFor("furniture-removal.html");
  const staleFetchedAt = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString();
  const entry = makeFirstPartyEvidence({
    findingKey: finding.key,
    requestFingerprint: "furniture removal",
    source: SOURCE,
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-08-01", end: "2026-08-28", label: "28 days ending 2026-08-28" },
    observed: { totalRowsReturned: 0, topRows: [] },
    context: "c",
    limitations: "l",
    fetchedAt: staleFetchedAt,
  });
  assert.strictEqual(needsFindingEvidenceRefresh(finding, [entry], now), true);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
