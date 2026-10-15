// Site Improvement Agent, Phase 10 — tests for
// agent/lib/local-source-evidence.js (the normalized Curated Official
// Source evidence schema). Mirrors tests/agent-firstparty-evidence.test.js's
// validation-discipline tests for makeFirstPartyEvidence().
//
// Run with:  node tests/agent-local-source-evidence.test.js

const assert = require("assert");
const {
  makeLocalSourceEvidence,
  computeLocalSourceFreshness,
  DISCOVERY_METHODS,
  MAX_SNIPPET_CHARS,
} = require("../agent/lib/local-source-evidence");

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
    sourceUrl: "https://www.denvergov.org/My-Property/Recycle-Compost-Trash/Seasonal-Programs/LeafDrop-and-Pumpkin-Recycling",
    sourceDomain: "denvergov.org",
    authorityClass: "official-government",
    locality: "Denver, CO",
    topic: "leafdrop-pumpkin-composting-program",
    discoveryMethod: "known-url",
    extractedSnippet: "LeafDrop and Pumpkin Recycling. Denver's LeafDrop program allows residents to dispose of their fall leaves...",
    expectedTemporality: "temporary",
    limitations: "A single, bounded text snippet — not a structured fact, not a verdict.",
    robots: { checkedAt: "2026-10-15T18:00:00.000Z", allowed: true },
    ...overrides,
  };
}

test("makeLocalSourceEvidence requires sourceUrl/sourceDomain/locality/topic/limitations — missing any throws", () => {
  for (const field of ["sourceUrl", "sourceDomain", "locality", "topic", "limitations"]) {
    assert.throws(() => makeLocalSourceEvidence(validArgs({ [field]: undefined })), new RegExp(field, "i"));
  }
});

test("makeLocalSourceEvidence rejects an unrecognized authorityClass", () => {
  assert.throws(() => makeLocalSourceEvidence(validArgs({ authorityClass: "a-guess" })), /authorityClass/);
});

test("makeLocalSourceEvidence rejects an unrecognized discoveryMethod — Phase 1 only knows 'known-url'", () => {
  assert.throws(() => makeLocalSourceEvidence(validArgs({ discoveryMethod: "sitemap-keyword-match" })), /discoveryMethod/);
  assert.deepStrictEqual(DISCOVERY_METHODS, ["known-url"]);
});

test("makeLocalSourceEvidence rejects an unrecognized expectedTemporality", () => {
  assert.throws(() => makeLocalSourceEvidence(validArgs({ expectedTemporality: "sometimes" })), /expectedTemporality/);
});

test("expectedTemporality is optional — defaults to 'unknown' (research.js's DEFAULT_TEMPORALITY), never silently 'evergreen'", () => {
  const evidence = makeLocalSourceEvidence(validArgs({ expectedTemporality: undefined }));
  assert.strictEqual(evidence.expectedTemporality, "unknown");
});

test("makeLocalSourceEvidence requires a non-empty extractedSnippet — evidence may not assert retrieval with zero observed text", () => {
  assert.throws(() => makeLocalSourceEvidence(validArgs({ extractedSnippet: undefined })), /extractedSnippet/);
  assert.throws(() => makeLocalSourceEvidence(validArgs({ extractedSnippet: "" })), /extractedSnippet/);
  assert.throws(() => makeLocalSourceEvidence(validArgs({ extractedSnippet: "   " })), /extractedSnippet/);
});

test(`makeLocalSourceEvidence REJECTS an extractedSnippet longer than MAX_SNIPPET_CHARS (${MAX_SNIPPET_CHARS}) — the caller must bound it BEFORE construction, this is a hard backstop, not a silent truncation`, () => {
  const tooLong = "x".repeat(MAX_SNIPPET_CHARS + 1);
  assert.throws(() => makeLocalSourceEvidence(validArgs({ extractedSnippet: tooLong })), /exceeds/);
  const exactly = "x".repeat(MAX_SNIPPET_CHARS);
  assert.doesNotThrow(() => makeLocalSourceEvidence(validArgs({ extractedSnippet: exactly })));
});

// --- the robots-allow structural guarantee -------------------------------

test("makeLocalSourceEvidence REQUIRES robots.checkedAt and robots.allowed === true — a fetch that was never confirmed robots-allowed can never produce evidence at all", () => {
  assert.throws(() => makeLocalSourceEvidence(validArgs({ robots: undefined })), /robots/);
  assert.throws(() => makeLocalSourceEvidence(validArgs({ robots: { checkedAt: "2026-10-15T18:00:00.000Z" } })), /did not explicitly allow/);
  assert.throws(() => makeLocalSourceEvidence(validArgs({ robots: { checkedAt: "2026-10-15T18:00:00.000Z", allowed: false } })), /did not explicitly allow/);
  assert.throws(() => makeLocalSourceEvidence(validArgs({ robots: { allowed: true } })), /checkedAt/);
});

test("makeLocalSourceEvidence has NO verdict/confidence/recommendation field — structurally cannot carry a judgment, same hard rule as firstparty-evidence.js", () => {
  const evidence = makeLocalSourceEvidence(validArgs());
  assert.strictEqual(evidence.verdict, undefined);
  assert.strictEqual(evidence.confidence, undefined);
  assert.strictEqual(evidence.recommendation, undefined);
  assert.deepStrictEqual(
    Object.keys(evidence).sort(),
    ["sourceUrl", "sourceDomain", "authorityClass", "locality", "topic", "discoveryMethod", "retrievedAt", "extractedSnippet", "expectedTemporality", "limitations", "robots"].sort()
  );
});

test("makeLocalSourceEvidence never stores a raw HTML/page field — only the bounded extractedSnippet the caller provided", () => {
  const evidence = makeLocalSourceEvidence(validArgs());
  assert.strictEqual(Object.prototype.hasOwnProperty.call(evidence, "rawHtml"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(evidence, "html"), false);
  assert.strictEqual(JSON.stringify(evidence).includes("<html"), false);
});

test("retrievedAt defaults to now when omitted, and is preserved when provided", () => {
  const a = makeLocalSourceEvidence(validArgs());
  assert.ok(a.retrievedAt);
  const fixed = "2026-01-01T00:00:00.000Z";
  const b = makeLocalSourceEvidence(validArgs({ retrievedAt: fixed }));
  assert.strictEqual(b.retrievedAt, fixed);
});

// -----------------------------------------------------------------------
// computeLocalSourceFreshness — reuses research.js's FRESHNESS_WINDOWS_DAYS
// -----------------------------------------------------------------------

test("computeLocalSourceFreshness: fresh just after retrieval", () => {
  const now = new Date("2026-10-15T18:00:00Z");
  const evidence = makeLocalSourceEvidence(validArgs({ retrievedAt: "2026-10-15T18:00:00Z" }));
  assert.strictEqual(computeLocalSourceFreshness(evidence, now).status, "fresh");
});

test("computeLocalSourceFreshness: a 'temporary' entry ages at research.js's documented temporary window (aging 21d / stale 45d)", () => {
  const { FRESHNESS_WINDOWS_DAYS } = require("../agent/lib/research");
  const { aging, stale } = FRESHNESS_WINDOWS_DAYS.temporary;
  const retrievedAt = new Date("2026-10-01T00:00:00Z");
  const evidence = makeLocalSourceEvidence(validArgs({ expectedTemporality: "temporary", retrievedAt: retrievedAt.toISOString() }));
  const agingNow = new Date(retrievedAt.getTime() + aging * 24 * 60 * 60 * 1000);
  const staleNow = new Date(retrievedAt.getTime() + stale * 24 * 60 * 60 * 1000);
  assert.strictEqual(computeLocalSourceFreshness(evidence, agingNow).status, "aging");
  assert.strictEqual(computeLocalSourceFreshness(evidence, staleNow).status, "stale");
});

test("computeLocalSourceFreshness: 'unknown' temporality is always 'needs-classification', regardless of age", () => {
  const evidence = makeLocalSourceEvidence(validArgs({ expectedTemporality: undefined, retrievedAt: "2020-01-01T00:00:00Z" }));
  assert.strictEqual(computeLocalSourceFreshness(evidence, new Date("2026-10-15Z")).status, "needs-classification");
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
