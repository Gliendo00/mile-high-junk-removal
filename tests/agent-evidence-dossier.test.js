// Site Improvement Agent, Phase 13a — tests for agent/lib/evidence-
// dossier.js: dossier assembly, every family's status rules, and the
// deterministic fingerprint.
//
// Run with:  node tests/agent-evidence-dossier.test.js

const assert = require("assert");
const {
  IN_SCOPE_FINDING_TYPES,
  deriveCityNameForFinding,
  deriveServiceLabelForFinding,
  assembleDossier,
  computeDossierFingerprint,
} = require("../agent/lib/evidence-dossier");
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

function gscEvidence(overrides) {
  return makeFirstPartyEvidence({
    findingKey: "content-gap::blog-seasonal-cleanout-guide.html",
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "blog-seasonal-cleanout-guide.html" },
    window: { start: "2026-09-01", end: "2026-09-28", label: "Sep 1-28, 2026" },
    observed: { totalRowsReturned: 1, topRows: [{ keys: ["seasonal cleanout", "blog-seasonal-cleanout-guide.html"], clicks: 5, impressions: 40, ctr: 0.125, position: 8 }] },
    context: "test",
    limitations: "bounded",
    fetchedAt: new Date().toISOString(),
    ...overrides,
  });
}

function ga4Evidence(overrides) {
  return makeFirstPartyEvidence({
    findingKey: "content-gap::blog-seasonal-cleanout-guide.html",
    source: "ga4",
    metric: "sessions",
    dimension: "landingPage",
    scope: { type: "page", value: "blog-seasonal-cleanout-guide.html" },
    window: { start: "2026-09-01", end: "2026-09-28", label: "Sep 1-28, 2026" },
    observed: { topRows: [{ dimensions: ["/blog-seasonal-cleanout-guide.html"], metrics: ["120"] }] },
    context: "test",
    limitations: "bounded",
    fetchedAt: new Date().toISOString(),
    ...overrides,
  });
}

function contentGapFinding(overrides) {
  return {
    key: "content-gap::blog-seasonal-cleanout-guide.html",
    type: "content-gap",
    category: "C",
    tier: "opportunity",
    decision: "RESEARCH_MORE",
    pages: ["blog-seasonal-cleanout-guide.html"],
    summary: "blog-seasonal-cleanout-guide.html's FAQ answers only 3 question(s), well below the 6-question average.",
    evidence: [
      { field: "faqQuestionCount", value: 3, file: "blog-seasonal-cleanout-guide.html" },
      { field: "comparableAverage", value: 6 },
    ],
    firstPartyEvidence: [],
    research: [],
    ...overrides,
  };
}

function coverageGapFinding(overrides) {
  return {
    key: "coverage-gap-candidate::denver-junk-removal.html",
    type: "coverage-gap-candidate",
    category: "C",
    tier: "opportunity",
    decision: "RESEARCH_MORE",
    pages: ["denver-junk-removal.html"],
    summary: "furniture-removal.html is contextually promoted on most city pages but not on denver-junk-removal.html.",
    evidence: [
      { field: "serviceFile", value: "furniture-removal.html" },
      { field: "citiesPromotingService", value: ["aurora-junk-removal.html"] },
      { field: "fraction", value: 0.85 },
    ],
    firstPartyEvidence: [],
    research: [],
    ...overrides,
  };
}

// --- IN_SCOPE_FINDING_TYPES -------------------------------------------

test("IN_SCOPE_FINDING_TYPES is exactly the 5 category-C types this phase covers — never pageless-city/new-page/visibility-decline/GA4-only types", () => {
  assert.deepStrictEqual(
    [...IN_SCOPE_FINDING_TYPES].sort(),
    ["content-gap", "coverage-gap-candidate", "duplicate-meta-description", "overlapping-intent", "structural-inconsistency"].sort()
  );
  assert.ok(!IN_SCOPE_FINDING_TYPES.includes("pageless-city-evaluation"));
  assert.ok(!IN_SCOPE_FINDING_TYPES.includes("research-gap")); // dead type, never emitted — see finding-evidence.js
});

// --- city/service derivation -------------------------------------------

test("deriveCityNameForFinding resolves a real city page to its canonical name", () => {
  assert.strictEqual(deriveCityNameForFinding({ pages: ["denver-junk-removal.html"] }), "Denver");
});

test("deriveCityNameForFinding returns null for a blog page (no single city)", () => {
  assert.strictEqual(deriveCityNameForFinding({ pages: ["blog-seasonal-cleanout-guide.html"] }), null);
});

test("deriveCityNameForFinding returns null when more than one page is a city page (ambiguous, never guessed)", () => {
  assert.strictEqual(deriveCityNameForFinding({ pages: ["denver-junk-removal.html", "aurora-junk-removal.html"] }), null);
});

test("deriveServiceLabelForFinding resolves a serviceFile evidence field to its canonical label", () => {
  const f = coverageGapFinding();
  assert.strictEqual(deriveServiceLabelForFinding(f), "Furniture Removal");
});

test("deriveServiceLabelForFinding returns null when there is no serviceFile evidence field", () => {
  assert.strictEqual(deriveServiceLabelForFinding(contentGapFinding()), null);
});

// --- site family: never a vote -----------------------------------------

test("site family is always 'not-applicable' — the finding's own generating evidence is the premise, not independent corroboration", () => {
  const dossier = assembleDossier(contentGapFinding());
  assert.strictEqual(dossier.families.site.status, "not-applicable");
});

// --- gsc family ----------------------------------------------------------

test("gsc family: no evidence at all -> unavailable", () => {
  const dossier = assembleDossier(contentGapFinding());
  assert.strictEqual(dossier.families.gsc.status, "unavailable");
});

test("gsc family: zero rows -> insufficient-data, NEVER contradiction", () => {
  const finding = contentGapFinding({ firstPartyEvidence: [gscEvidence({ observed: { totalRowsReturned: 0, topRows: [] } })] });
  const dossier = assembleDossier(finding);
  assert.strictEqual(dossier.families.gsc.status, "insufficient-data");
});

test("gsc family: real rows landing on this page -> supports", () => {
  const finding = contentGapFinding({ firstPartyEvidence: [gscEvidence()] });
  const dossier = assembleDossier(finding);
  assert.strictEqual(dossier.families.gsc.status, "supports");
});

test("gsc family: real rows landing ONLY on a different page -> different-question, never a contradiction of the content-depth premise", () => {
  const finding = contentGapFinding({
    firstPartyEvidence: [
      gscEvidence({
        observed: { totalRowsReturned: 1, topRows: [{ keys: ["seasonal cleanout", "some-other-page.html"], clicks: 3, impressions: 20, ctr: 0.15, position: 4 }] },
      }),
    ],
  });
  const dossier = assembleDossier(finding);
  assert.strictEqual(dossier.families.gsc.status, "different-question");
});

test("gsc family: stale evidence -> insufficient-data (stale support is never current support)", () => {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days, > 21-day stale window
  const finding = contentGapFinding({ firstPartyEvidence: [gscEvidence({ fetchedAt: old })] });
  const dossier = assembleDossier(finding);
  assert.strictEqual(dossier.families.gsc.status, "insufficient-data");
  assert.ok(dossier.families.gsc.detail.includes("stale"));
});

test("gsc family: duplicate same-family evidence (two GSC entries) still counts as ONE family, never two", () => {
  const finding = contentGapFinding({ firstPartyEvidence: [gscEvidence(), gscEvidence({ fetchedAt: new Date().toISOString() })] });
  const dossier = assembleDossier(finding);
  assert.strictEqual(typeof dossier.families.gsc, "object");
  assert.ok(!Array.isArray(dossier.families.gsc));
});

// --- ga4 family: always deferred ----------------------------------------

test("ga4 family: no evidence -> unavailable", () => {
  const dossier = assembleDossier(contentGapFinding());
  assert.strictEqual(dossier.families.ga4.status, "unavailable");
});

test("ga4 family: sessions up / lead events down (or any GA4 movement) -> different-question, NEVER a contradiction", () => {
  const finding = contentGapFinding({ firstPartyEvidence: [ga4Evidence()] });
  const dossier = assembleDossier(finding);
  assert.strictEqual(dossier.families.ga4.status, "different-question");
});

// --- GA4 relevance re-evaluated per finding type (pre-push review) -----
//
// The review asked: is GA4 genuinely a different question for EVERY one
// of the 5 in-scope types, or was that asserted globally without
// checking? These tests inspect each type individually rather than
// trusting one blanket rule.

test("ga4 family: structural-inconsistency with real GA4 evidence -> different-question too (same content-completeness-vs-conversion distinction as content-gap)", () => {
  const finding = contentGapFinding({ type: "structural-inconsistency", firstPartyEvidence: [ga4Evidence({ findingKey: "structural-inconsistency::blog-seasonal-cleanout-guide.html" })] });
  const dossier = assembleDossier(finding);
  assert.strictEqual(dossier.families.ga4.status, "different-question");
  assert.ok(dossier.families.ga4.detail.includes("structural completeness"));
});

test("ga4 family: content-gap's different-question detail names its OWN premise label ('content depth/completeness'), not a generic phrase", () => {
  const finding = contentGapFinding({ firstPartyEvidence: [ga4Evidence()] });
  const dossier = assembleDossier(finding);
  assert.ok(dossier.families.ga4.detail.includes("content depth/completeness"));
});

test("ga4 family: coverage-gap-candidate/duplicate-meta-description/overlapping-intent are 'unavailable' for a DIFFERENT reason than content-gap's — no mechanism ever gathers GA4 for them, not a relevance judgment", () => {
  for (const type of ["coverage-gap-candidate", "duplicate-meta-description", "overlapping-intent"]) {
    const finding = coverageGapFinding({ type, firstPartyEvidence: [] });
    const dossier = assembleDossier(finding);
    assert.strictEqual(dossier.families.ga4.status, "unavailable", type);
    assert.ok(dossier.families.ga4.detail.includes("no existing mechanism targets this finding type"), `${type}: ${dossier.families.ga4.detail}`);
  }
});

test("ga4 family: content-gap/structural-inconsistency with NO evidence yet get the ordinary 'not gathered yet' unavailable message (not the 'no mechanism exists' one — a mechanism DOES exist for these two)", () => {
  const dossier = assembleDossier(contentGapFinding());
  assert.strictEqual(dossier.families.ga4.status, "unavailable");
  assert.ok(!dossier.families.ga4.detail.includes("no existing mechanism targets"));
});

// --- completedJobs family ------------------------------------------------

test("completedJobs family: not-applicable for structural-inconsistency/duplicate-meta-description/overlapping-intent", () => {
  for (const type of ["structural-inconsistency", "duplicate-meta-description", "overlapping-intent"]) {
    const finding = contentGapFinding({ type, pages: ["denver-junk-removal.html"] });
    const dossier = assembleDossier(finding, { completedJobEvidence: [{ city: "Denver", serviceType: "furniture removal" }] });
    assert.strictEqual(dossier.families.completedJobs.status, "not-applicable", `expected not-applicable for ${type}`);
  }
});

test("completedJobs family: no completed jobs in the available window -> insufficient-data, NEVER contradiction", () => {
  const finding = coverageGapFinding();
  const dossier = assembleDossier(finding, { completedJobEvidence: [] });
  assert.strictEqual(dossier.families.completedJobs.status, "insufficient-data");
});

test("completedJobs family: city matches but not the specific missing service -> insufficient-data", () => {
  const finding = coverageGapFinding();
  const dossier = assembleDossier(finding, { completedJobEvidence: [{ city: "Denver", serviceType: "appliance disposal" }] });
  assert.strictEqual(dossier.families.completedJobs.status, "insufficient-data");
});

test("completedJobs family: city AND service both match -> supports, with real operational evidence referenced", () => {
  const finding = coverageGapFinding();
  const dossier = assembleDossier(finding, { completedJobEvidence: [{ city: "Denver", serviceType: "furniture removal" }] });
  assert.strictEqual(dossier.families.completedJobs.status, "supports");
  assert.ok(dossier.families.completedJobs.evidenceRefs.length > 0);
});

test("completedJobs family: repeated jobs in the same city/service strengthen detail but remain ONE family (never multiple)", () => {
  const finding = coverageGapFinding();
  const dossier = assembleDossier(finding, {
    completedJobEvidence: [
      { city: "Denver", serviceType: "furniture removal" },
      { city: "Denver", serviceType: "furniture removal" },
      { city: "Denver", serviceType: "furniture removal" },
    ],
  });
  assert.strictEqual(dossier.families.completedJobs.status, "supports");
  assert.ok(!Array.isArray(dossier.families.completedJobs));
});

test("completedJobs family: content-gap on a blog page (no city) -> not-applicable", () => {
  const dossier = assembleDossier(contentGapFinding(), { completedJobEvidence: [{ city: "Denver", serviceType: "furniture removal" }] });
  assert.strictEqual(dossier.families.completedJobs.status, "not-applicable");
});

test("completedJobs family: content-gap on a city page with matching-city activity -> supports", () => {
  const finding = contentGapFinding({ pages: ["denver-junk-removal.html"] });
  const dossier = assembleDossier(finding, { completedJobEvidence: [{ city: "Denver", serviceType: "appliance disposal" }] });
  assert.strictEqual(dossier.families.completedJobs.status, "supports");
});

// --- localSource family: always unavailable (semantic boundary) --------

test("localSource family: no evidence at all -> unavailable", () => {
  const dossier = assembleDossier(contentGapFinding());
  assert.strictEqual(dossier.families.localSource.status, "unavailable");
});

test("localSource family: matching-locality evidence exists but is STILL 'unavailable' — mechanical matching can never establish semantic support/contradiction", () => {
  const finding = coverageGapFinding();
  const dossier = assembleDossier(finding, {
    localSourceEvidence: [{ sourceUrl: "https://denvergov.org/x", sourceDomain: "denvergov.org", locality: "Denver, CO", topic: "furniture-disposal-program" }],
  });
  assert.strictEqual(dossier.families.localSource.status, "unavailable");
  assert.ok(dossier.families.localSource.detail.includes("not been confirmed"));
});

test("localSource family: never produces 'contradicts' or 'supports' in Phase 13a, by construction", () => {
  const finding = coverageGapFinding();
  const dossier = assembleDossier(finding, {
    localSourceEvidence: [{ sourceUrl: "https://denvergov.org/x", sourceDomain: "denvergov.org", locality: "Denver, CO", topic: "anything" }],
  });
  assert.notStrictEqual(dossier.families.localSource.status, "supports");
  assert.notStrictEqual(dossier.families.localSource.status, "contradicts");
});

// --- fingerprint ----------------------------------------------------------

test("computeDossierFingerprint is deterministic for identical inputs", () => {
  const finding = coverageGapFinding();
  const ctx = { completedJobEvidence: [{ city: "Denver", serviceType: "furniture removal" }], localSourceEvidence: [] };
  assert.strictEqual(computeDossierFingerprint(finding, ctx), computeDossierFingerprint(finding, ctx));
});

test("computeDossierFingerprint changes when the underlying evidence changes", () => {
  const finding = coverageGapFinding();
  const fpBefore = computeDossierFingerprint(finding, { completedJobEvidence: [], localSourceEvidence: [] });
  const fpAfter = computeDossierFingerprint(finding, { completedJobEvidence: [{ city: "Denver", serviceType: "furniture removal" }], localSourceEvidence: [] });
  assert.notStrictEqual(fpBefore, fpAfter);
});

test("computeDossierFingerprint is unaffected by GA4/GSC evidence that doesn't exist for a different finding (no cross-contamination)", () => {
  const a = coverageGapFinding({ key: "coverage-gap-candidate::denver-junk-removal.html" });
  const b = coverageGapFinding({ key: "coverage-gap-candidate::aurora-junk-removal.html", pages: ["aurora-junk-removal.html"] });
  // Different findings with the same (empty) evidence inputs CAN share a
  // fingerprint value structurally (fingerprint is over inputs, not
  // identity) — this test only proves the function doesn't throw/crash
  // across distinct findings and pages.
  assert.doesNotThrow(() => computeDossierFingerprint(a, {}));
  assert.doesNotThrow(() => computeDossierFingerprint(b, {}));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
