// Site Improvement Agent, Phase 11B — tests for
// agent/lib/local-source-candidates.js: deterministic, network-free
// candidate eligibility for Weekly. Uses synthetic fixture registry
// entries/picks/evidence throughout (never the real registry) so a
// future edit to the real entries can never accidentally break these.
//
// Run with:  node tests/agent-local-source-candidates.test.js

const assert = require("assert");
const {
  getRelevantSourcesForCity,
  selectWeeklyLocalSourceCandidates,
  picksWithNoRelevantSource,
  needsFetchThisRun,
  latestEvidenceByUrl,
} = require("../agent/lib/local-source-candidates");

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

function registryEntry(overrides) {
  return {
    id: "jeffco-slash",
    locality: "Jefferson County, CO",
    relevantCities: ["lakewood", "arvada", "golden", "morrison", "wheat-ridge"],
    domain: "jeffco.us",
    url: "https://www.jeffco.us/2493/Slash-Collection",
    topic: "slash-brush-branch-collection-program",
    authorityClass: "official-government",
    expectedTemporality: "temporary",
    humanVerifiedAt: "2026-10-15",
    eligibilityNotes: "Geographic relevance only.",
    ...overrides,
  };
}

function pick(slug) {
  return { slug, name: slug, hasPage: true, score: 1, reasons: [] };
}

function evidenceEntry(overrides) {
  return {
    sourceUrl: "https://www.jeffco.us/2493/Slash-Collection",
    sourceDomain: "jeffco.us",
    authorityClass: "official-government",
    locality: "Jefferson County, CO",
    topic: "slash-brush-branch-collection-program",
    discoveryMethod: "known-url",
    retrievedAt: new Date().toISOString(),
    extractedSnippet: "some text",
    expectedTemporality: "temporary",
    limitations: "l",
    robots: { checkedAt: new Date().toISOString(), allowed: true },
    ...overrides,
  };
}

// --- getRelevantSourcesForCity() — geographic relevance only -----------

test("getRelevantSourcesForCity() returns only entries whose relevantCities includes the slug", () => {
  const entries = [registryEntry(), registryEntry({ id: "thornton-click-haul", relevantCities: ["thornton"] })];
  assert.deepStrictEqual(getRelevantSourcesForCity("lakewood", entries).map((e) => e.id), ["jeffco-slash"]);
  assert.deepStrictEqual(getRelevantSourcesForCity("thornton", entries).map((e) => e.id), ["thornton-click-haul"]);
  assert.deepStrictEqual(getRelevantSourcesForCity("denver", entries), []);
});

test("getRelevantSourcesForCity() returns a single entry for MULTIPLE matching cities (one county source relevant to several cities)", () => {
  const entries = [registryEntry()];
  assert.strictEqual(getRelevantSourcesForCity("lakewood", entries).length, 1);
  assert.strictEqual(getRelevantSourcesForCity("golden", entries).length, 1);
  assert.strictEqual(getRelevantSourcesForCity("morrison", entries).length, 1);
});

// --- selectWeeklyLocalSourceCandidates() — REQUEST DEDUPLICATION --------

test("selectWeeklyLocalSourceCandidates() dedupes a shared source across multiple matching picks into exactly ONE candidate, recording every matching pick", () => {
  const entries = [registryEntry()];
  const picks = [pick("lakewood"), pick("golden"), pick("morrison")];
  const candidates = selectWeeklyLocalSourceCandidates(picks, entries);
  assert.strictEqual(candidates.length, 1, "one shared source across three relevant picks must dedupe to exactly one candidate");
  assert.strictEqual(candidates[0].entry.id, "jeffco-slash");
  assert.deepStrictEqual(candidates[0].matchedPickSlugs.sort(), ["golden", "lakewood", "morrison"]);
});

test("selectWeeklyLocalSourceCandidates() returns one candidate per distinct relevant source when picks map to different sources", () => {
  const entries = [registryEntry(), registryEntry({ id: "thornton-click-haul", domain: "thorntonco.gov", url: "https://www.thorntonco.gov/x", topic: "bulky-item", relevantCities: ["thornton"] })];
  const picks = [pick("lakewood"), pick("thornton")];
  const candidates = selectWeeklyLocalSourceCandidates(picks, entries);
  assert.strictEqual(candidates.length, 2);
  assert.deepStrictEqual(candidates.map((c) => c.entry.id).sort(), ["jeffco-slash", "thornton-click-haul"]);
});

test("selectWeeklyLocalSourceCandidates() returns an empty array when no pick matches any registry entry", () => {
  const entries = [registryEntry()];
  const picks = [pick("denver")];
  assert.deepStrictEqual(selectWeeklyLocalSourceCandidates(picks, entries), []);
});

test("selectWeeklyLocalSourceCandidates() returns an empty array for an empty picks list, even with a non-empty registry — never 'fetch everything by default'", () => {
  assert.deepStrictEqual(selectWeeklyLocalSourceCandidates([], [registryEntry()]), []);
});

// --- picksWithNoRelevantSource() ----------------------------------------

test("picksWithNoRelevantSource() lists picks with zero relevant registry entries — an honest 'external discovery unavailable' signal", () => {
  const entries = [registryEntry()];
  const picks = [pick("lakewood"), pick("denver"), pick("aurora")];
  assert.deepStrictEqual(picksWithNoRelevantSource(picks, entries), ["denver", "aurora"]);
});

test("picksWithNoRelevantSource() returns an empty array when every pick has a relevant source", () => {
  const entries = [registryEntry()];
  assert.deepStrictEqual(picksWithNoRelevantSource([pick("lakewood")], entries), []);
});

// --- needsFetchThisRun() / latestEvidenceByUrl() — freshness/reuse -----

test("needsFetchThisRun() includes a candidate with NO existing evidence at all", () => {
  const candidates = [{ entry: registryEntry(), matchedPickSlugs: ["lakewood"] }];
  assert.strictEqual(needsFetchThisRun(candidates, []).length, 1);
});

test("needsFetchThisRun() EXCLUDES a candidate whose most recent evidence is still fresh", () => {
  const candidates = [{ entry: registryEntry(), matchedPickSlugs: ["lakewood"] }];
  const fresh = evidenceEntry({ retrievedAt: new Date().toISOString() }); // 0 days old — fresh under any temporality window
  assert.strictEqual(needsFetchThisRun(candidates, [fresh]).length, 0);
});

test("needsFetchThisRun() INCLUDES a candidate whose most recent evidence is STALE — a stale temporary source is eligible for refresh, never silently treated as current", () => {
  const candidates = [{ entry: registryEntry(), matchedPickSlugs: ["lakewood"] }];
  const ancient = evidenceEntry({ retrievedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() }); // 100 days old, temporality temporary -> stale (window.stale = 45)
  assert.strictEqual(needsFetchThisRun(candidates, [ancient]).length, 1);
});

test("needsFetchThisRun() uses the MOST RECENT evidence file per sourceUrl when several have accumulated over time", () => {
  const candidates = [{ entry: registryEntry(), matchedPickSlugs: ["lakewood"] }];
  const old = evidenceEntry({ retrievedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() });
  const recent = evidenceEntry({ retrievedAt: new Date().toISOString() });
  // Even though an older, stale entry exists, the MOST RECENT one is fresh — must not need a fetch.
  assert.strictEqual(needsFetchThisRun(candidates, [old, recent]).length, 0);
});

test("needsFetchThisRun() never fetches a candidate irrelevant to any pick — it only ever filters the candidates it's given", () => {
  assert.deepStrictEqual(needsFetchThisRun([], [evidenceEntry()]), []);
});

test("latestEvidenceByUrl() picks the entry with the latest retrievedAt per sourceUrl", () => {
  const old = evidenceEntry({ retrievedAt: "2026-01-01T00:00:00Z" });
  const recent = evidenceEntry({ retrievedAt: "2026-10-01T00:00:00Z" });
  const map = latestEvidenceByUrl([old, recent]);
  assert.strictEqual(map.get("https://www.jeffco.us/2493/Slash-Collection").retrievedAt, "2026-10-01T00:00:00Z");
});

test("latestEvidenceByUrl() keeps entries for different sourceUrls separate", () => {
  const a = evidenceEntry({ sourceUrl: "https://a.gov/x" });
  const b = evidenceEntry({ sourceUrl: "https://b.gov/x" });
  const map = latestEvidenceByUrl([a, b]);
  assert.strictEqual(map.size, 2);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
