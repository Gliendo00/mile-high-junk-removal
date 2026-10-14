// Site Improvement Agent, Phase 5 — research freshness/temporality
// (agent/lib/research.js's computeFreshness(), temporality field).
// Proves: temporary/seasonal evidence (e.g. a municipal program's dates)
// is flagged stale on a realistic schedule, evergreen evidence is not,
// an unclassified result is always flagged as needing classification
// regardless of age (never silently treated as evergreen), and the two
// real Phase 3 research result files are both explicitly classified.
//
// Run with:  node tests/agent-research-freshness.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeResearchResult, computeFreshness, loadResearchResults } = (() => {
  const research = require("../agent/lib/research");
  const { loadResearchResults } = require("../agent/lib/research-intake");
  return { ...research, loadResearchResults };
})();

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

function baseArgs(overrides) {
  return {
    findingKey: "content-gap::x.html",
    question: "q",
    source: "s",
    sourceType: "official-government",
    evidence: ["e"],
    confidence: "medium",
    limitations: "l",
    verdict: "supports-opportunity",
    recommendation: "r",
    ...overrides,
  };
}

test("makeResearchResult defaults temporality to 'unknown' when not specified — never silently 'evergreen'", () => {
  const r = makeResearchResult(baseArgs());
  assert.strictEqual(r.temporality, "unknown");
});

test("makeResearchResult accepts an explicit temporality and rejects an invalid one", () => {
  const r = makeResearchResult(baseArgs({ temporality: "temporary" }));
  assert.strictEqual(r.temporality, "temporary");
  assert.throws(() => makeResearchResult(baseArgs({ temporality: "sometimes" })), /temporality/);
});

test("computeFreshness on an 'unknown' temporality is always 'needs-classification', regardless of age", () => {
  const fresh = computeFreshness(makeResearchResult(baseArgs({ accessedAt: new Date().toISOString() })));
  const old = computeFreshness(
    makeResearchResult(baseArgs({ accessedAt: new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000).toISOString() }))
  );
  assert.strictEqual(fresh.status, "needs-classification");
  assert.strictEqual(old.status, "needs-classification");
});

test("computeFreshness on 'temporary' evidence goes fresh -> aging -> stale on a realistic (weeks-scale) schedule", () => {
  const now = new Date("2026-10-14T00:00:00Z");
  const freshResult = makeResearchResult(baseArgs({ temporality: "temporary", accessedAt: "2026-10-10T00:00:00Z" }));
  const agingResult = makeResearchResult(baseArgs({ temporality: "temporary", accessedAt: "2026-09-20T00:00:00Z" }));
  const staleResult = makeResearchResult(baseArgs({ temporality: "temporary", accessedAt: "2026-08-01T00:00:00Z" }));

  assert.strictEqual(computeFreshness(freshResult, now).status, "fresh");
  assert.strictEqual(computeFreshness(agingResult, now).status, "aging");
  assert.strictEqual(computeFreshness(staleResult, now).status, "stale");
});

test("computeFreshness on 'evergreen' evidence stays 'fresh' far longer than 'temporary' evidence at the same age", () => {
  const now = new Date("2026-10-14T00:00:00Z");
  const accessedAt = "2026-09-20T00:00:00Z"; // ~24 days before `now`
  const temporary = makeResearchResult(baseArgs({ temporality: "temporary", accessedAt }));
  const evergreen = makeResearchResult(baseArgs({ temporality: "evergreen", accessedAt }));

  assert.notStrictEqual(computeFreshness(temporary, now).status, "fresh");
  assert.strictEqual(computeFreshness(evergreen, now).status, "fresh");
});

test("the real Denver LeafDrop research result (a genuinely seasonal municipal program) is explicitly tagged temporality:'temporary', not left as 'unknown'", () => {
  const { results } = loadResearchResults();
  const leafDrop = results.find((r) => r.source.includes("LeafDrop"));
  assert.ok(leafDrop, "expected the real LeafDrop research result to load");
  assert.strictEqual(leafDrop.temporality, "temporary");
  assert.ok(leafDrop.locality);
});

test("every real research result file in agent/research/results/ has an explicit (non-'unknown') temporality — this repo's own evidence should not be sitting in the 'needs classification' bucket", () => {
  const { results } = loadResearchResults();
  assert.ok(results.length > 0, "expected at least the two real Phase 3 research files to load");
  for (const r of results) {
    assert.notStrictEqual(r.temporality, "unknown", `${r.source} has no explicit temporality classification`);
  }
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
