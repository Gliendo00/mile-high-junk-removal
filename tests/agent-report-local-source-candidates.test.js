// Site Improvement Agent, Phase 11B — tests for report.js's
// `localSourceCandidates` section: this week's relevance/fetch/reuse/
// staleness/blocked bookkeeping Weekly's report must be able to answer
// (see agent/README.md's Phase 11 section). Uses synthetic
// record/registry/evidence/candidate-log fixtures throughout — never
// the real repo state — so this stays independent of whatever rotation
// picks/registry entries are real today.
//
// Run with:  node tests/agent-report-local-source-candidates.test.js

const assert = require("assert");
const { buildReport } = require("../agent/lib/report");

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

function baseRecord(overrides) {
  return {
    runId: "r1",
    timestamp: "2026-10-16T00:00:00.000Z",
    runType: "weekly",
    mode: "dry-run",
    summary: { pagesScanned: 1, byCategory: {} },
    findings: [],
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSync: { skipped: true, reason: "x" },
    ...overrides,
  };
}

function registryEntry(overrides) {
  return {
    id: "jeffco-slash",
    locality: "Jefferson County, CO",
    relevantCities: ["lakewood", "golden"],
    domain: "jeffco.us",
    url: "https://www.jeffco.us/2493/Slash-Collection",
    topic: "slash-brush-branch-collection-program",
    authorityClass: "official-government",
    expectedTemporality: "temporary",
    humanVerifiedAt: "2026-10-15",
    eligibilityNotes: "Geographic relevance only — does not establish per-resident eligibility.",
    ...overrides,
  };
}

function evidenceEntry(overrides) {
  return {
    sourceUrl: "https://www.jeffco.us/2493/Slash-Collection",
    sourceDomain: "jeffco.us",
    authorityClass: "official-government",
    locality: "Jefferson County, CO",
    topic: "slash-brush-branch-collection-program",
    discoveryMethod: "known-url",
    retrievedAt: "2026-10-16T00:00:00.000Z",
    extractedSnippet: "some text",
    expectedTemporality: "temporary",
    limitations: "l",
    robots: { checkedAt: "2026-10-16T00:00:00.000Z", allowed: true },
    ...overrides,
  };
}

function pick(slug) {
  return { slug, name: slug, hasPage: true, score: 1, reasons: [] };
}

test("report.localSourceCandidates is null on a daily run (no rotationPriorities) — never computed/surfaced when there is no 'this week' to ask relevance for", () => {
  const report = buildReport({ record: baseRecord({ runType: "daily" }), previousRun: null, rotationPriorities: null, localSourceEvidence: { entries: [], warnings: [] } });
  assert.strictEqual(report.localSourceCandidates, null);
});

test("every pick with zero relevant registry entries appears in noCuratedSourcePicks — an honest 'no curated source' signal, never silently omitted", () => {
  const report = buildReport({
    record: baseRecord(),
    previousRun: null,
    rotationPriorities: [pick("lakewood"), pick("denver")],
    localSourceRegistryEntries: [registryEntry()],
    localSourceEvidence: { entries: [], warnings: [] },
  });
  assert.deepStrictEqual(report.localSourceCandidates.noCuratedSourcePicks, ["denver"]);
});

test("a shared source relevant to multiple picks appears exactly ONCE in relevantSources, with every matching pick slug recorded", () => {
  const report = buildReport({
    record: baseRecord(),
    previousRun: null,
    rotationPriorities: [pick("lakewood"), pick("golden")],
    localSourceRegistryEntries: [registryEntry()],
    localSourceEvidence: { entries: [], warnings: [] },
  });
  assert.strictEqual(report.localSourceCandidates.relevantSources.length, 1);
  assert.deepStrictEqual(report.localSourceCandidates.relevantSources[0].matchedPickSlugs.sort(), ["golden", "lakewood"]);
});

test("a source with evidence retrieved AT OR AFTER the workflow boundary is classified 'fetched-this-workflow'", () => {
  const report = buildReport({
    record: baseRecord({ timestamp: "2026-10-16T01:00:00.000Z" }),
    previousRun: null,
    rotationPriorities: [pick("lakewood")],
    workflowStartedAt: "2026-10-16T00:50:00.000Z",
    localSourceRegistryEntries: [registryEntry()],
    localSourceEvidence: { entries: [evidenceEntry({ retrievedAt: "2026-10-16T00:55:00.000Z" })], warnings: [] },
  });
  assert.strictEqual(report.localSourceCandidates.relevantSources[0].status, "fetched-this-workflow");
});

test("a source with FRESH evidence retrieved BEFORE the workflow boundary is classified 'reused-fresh'", () => {
  const report = buildReport({
    record: baseRecord({ timestamp: "2026-10-16T01:00:00.000Z" }),
    previousRun: null,
    rotationPriorities: [pick("lakewood")],
    workflowStartedAt: "2026-10-16T00:50:00.000Z",
    localSourceRegistryEntries: [registryEntry()],
    // One day old, temporality "temporary" (aging window starts at 21 days) — still fresh, and before the boundary.
    localSourceEvidence: { entries: [evidenceEntry({ retrievedAt: "2026-10-15T00:00:00.000Z" })], warnings: [] },
  });
  const src = report.localSourceCandidates.relevantSources[0];
  assert.strictEqual(src.status, "reused-fresh");
  assert.strictEqual(src.freshness, "fresh");
});

test("a source with STALE evidence is classified 'stale-needs-refresh' — never silently represented as current", () => {
  const report = buildReport({
    record: baseRecord({ timestamp: "2026-10-16T01:00:00.000Z" }),
    previousRun: null,
    rotationPriorities: [pick("lakewood")],
    workflowStartedAt: "2026-10-16T00:50:00.000Z",
    localSourceRegistryEntries: [registryEntry()],
    // 100 days old, temporality "temporary" (stale window = 45 days).
    localSourceEvidence: { entries: [evidenceEntry({ retrievedAt: "2026-07-08T00:00:00.000Z" })], warnings: [] },
  });
  const src = report.localSourceCandidates.relevantSources[0];
  assert.strictEqual(src.status, "stale-needs-refresh");
  assert.strictEqual(src.freshness, "stale");
});

test("a relevant candidate with NO evidence at all, and NOT recorded in the candidate log, is classified 'not-yet-fetched' — distinct from blocked/failed", () => {
  const report = buildReport({
    record: baseRecord(),
    previousRun: null,
    rotationPriorities: [pick("lakewood")],
    localSourceRegistryEntries: [registryEntry()],
    localSourceEvidence: { entries: [], warnings: [] },
    localSourceCandidateLog: { blockedOrFailed: [] },
  });
  assert.strictEqual(report.localSourceCandidates.relevantSources[0].status, "not-yet-fetched");
});

test("a relevant candidate with NO evidence, recorded in the candidate log's blockedOrFailed, is classified 'blocked-or-failed' with its reason surfaced", () => {
  const report = buildReport({
    record: baseRecord(),
    previousRun: null,
    rotationPriorities: [pick("lakewood")],
    localSourceRegistryEntries: [registryEntry()],
    localSourceEvidence: { entries: [], warnings: [] },
    localSourceCandidateLog: { blockedOrFailed: [{ entryId: "jeffco-slash", matchedPickSlugs: ["lakewood"], reason: "robots.txt disallows this path" }] },
  });
  const src = report.localSourceCandidates.relevantSources[0];
  assert.strictEqual(src.status, "blocked-or-failed");
  assert.strictEqual(src.blockedReason, "robots.txt disallows this path");
});

test("establishes/doesNotEstablish are restated verbatim from the registry entry's own topic/authorityClass/locality/eligibilityNotes — never a manufactured new interpretation", () => {
  const report = buildReport({
    record: baseRecord(),
    previousRun: null,
    rotationPriorities: [pick("lakewood")],
    localSourceRegistryEntries: [registryEntry()],
    localSourceEvidence: { entries: [], warnings: [] },
  });
  const src = report.localSourceCandidates.relevantSources[0];
  assert.ok(src.establishes.includes("slash-brush-branch-collection-program"));
  assert.ok(src.establishes.includes("official-government"));
  assert.ok(src.establishes.includes("Jefferson County, CO"));
  assert.strictEqual(src.doesNotEstablish, "Geographic relevance only — does not establish per-resident eligibility.");
});

test("the section carries the geographic-relevance-only disclaimer verbatim", () => {
  const report = buildReport({
    record: baseRecord(),
    previousRun: null,
    rotationPriorities: [pick("lakewood")],
    localSourceRegistryEntries: [registryEntry()],
    localSourceEvidence: { entries: [], warnings: [] },
  });
  assert.ok(/Geographic relevance only/.test(report.localSourceCandidates.disclaimer));
  assert.ok(/never establishes verified program eligibility/.test(report.localSourceCandidates.disclaimer));
});

test("localSourceCandidates is genuinely separate from localSourceEvidence — never merged into it, and absent from it as a nested key", () => {
  const report = buildReport({
    record: baseRecord(),
    previousRun: null,
    rotationPriorities: [pick("lakewood")],
    localSourceRegistryEntries: [registryEntry()],
    localSourceEvidence: { entries: [], warnings: [] },
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(report.localSourceEvidence, "localSourceCandidates"), false);
  assert.notStrictEqual(report.localSourceCandidates, report.localSourceEvidence);
});

test("missing localSourceRegistryEntries/localSourceCandidateLog degrade safely (empty arrays/no-op), never throw", () => {
  assert.doesNotThrow(() => {
    const report = buildReport({ record: baseRecord(), previousRun: null, rotationPriorities: [pick("lakewood")], localSourceEvidence: { entries: [], warnings: [] } });
    assert.strictEqual(report.localSourceCandidates.relevantSources.length, 0);
    assert.deepStrictEqual(report.localSourceCandidates.noCuratedSourcePicks, ["lakewood"]);
  });
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
