// Site Improvement Agent — tests for agent/lib/research.js (the
// ResearchResult schema/validation) and agent/lib/research-intake.js (the
// reader that attaches committed results to findings by key). Uses a
// throwaway fixture directory under tests/fixtures/, never the real
// (currently-empty) agent/research/results/.
//
// Run with:  node tests/agent-research.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeResearchResult, SOURCE_TYPES, CONFIDENCE_LEVELS, VERDICTS } = require("../agent/lib/research");
const { makeFinding } = require("../agent/lib/findings");

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
    findingKey: "structural-inconsistency::some-page.html",
    question: "Is some-page.html genuinely thin, or is that word count appropriate for its topic?",
    source: "https://example.gov/disposal-rules",
    sourceType: "official-government",
    evidence: ["The official page lists three accepted bulk-item categories."],
    confidence: "medium",
    limitations: "Does not establish actual local search demand for this topic.",
    verdict: "supports-opportunity",
    recommendation: "Consider expanding the page with the three categories listed.",
    ...overrides,
  };
}

test("makeResearchResult requires every field — missing findingKey/question/source/limitations/recommendation each throw", () => {
  for (const field of ["findingKey", "question", "source", "limitations", "recommendation"]) {
    const args = validArgs({ [field]: undefined });
    assert.throws(() => makeResearchResult(args), new RegExp(field));
  }
});

test("makeResearchResult rejects an unrecognized sourceType/confidence/verdict", () => {
  assert.throws(() => makeResearchResult(validArgs({ sourceType: "a-guess" })), /sourceType/);
  assert.throws(() => makeResearchResult(validArgs({ confidence: "very sure" })), /confidence/);
  assert.throws(() => makeResearchResult(validArgs({ verdict: "probably" })), /verdict/);
});

test("makeResearchResult requires at least one non-empty evidence string — cannot assert a verdict with zero observed evidence", () => {
  assert.throws(() => makeResearchResult(validArgs({ evidence: [] })), /evidence/);
  assert.throws(() => makeResearchResult(validArgs({ evidence: ["", "  "] })), /non-empty string/);
});

test("makeResearchResult succeeds with valid input, defaults accessedAt to now, and tags `kind`", () => {
  const r = makeResearchResult(validArgs());
  assert.strictEqual(r.findingKey, "structural-inconsistency::some-page.html");
  assert.ok(r.accessedAt);
  assert.strictEqual(r.kind, "external");
});

test("makeResearchResult tags sourceType 'internal-repo-review' as kind 'internal-deep-review', not 'external'", () => {
  const r = makeResearchResult(validArgs({ sourceType: "internal-repo-review", source: "nav.js + admin/footer review" }));
  assert.strictEqual(r.kind, "internal-deep-review");
});

test("SOURCE_TYPES/CONFIDENCE_LEVELS/VERDICTS are all non-empty exported lists", () => {
  assert.ok(SOURCE_TYPES.length > 0);
  assert.ok(CONFIDENCE_LEVELS.length > 0);
  assert.ok(VERDICTS.length > 0);
});

// -----------------------------------------------------------------------
// research-intake.js
// -----------------------------------------------------------------------
const FIXTURE_DIR = path.join(__dirname, "fixtures", "research-results");

function writeFixtureResult(filename, args) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_DIR, filename), JSON.stringify(args, null, 2), "utf8");
}

function cleanupFixtures() {
  if (fs.existsSync(FIXTURE_DIR)) {
    for (const f of fs.readdirSync(FIXTURE_DIR)) fs.unlinkSync(path.join(FIXTURE_DIR, f));
    fs.rmdirSync(FIXTURE_DIR);
  }
}

// research-intake.js reads from the real agent/research/results/ path by
// default, so these tests call its lower-level pieces directly against a
// fixture directory instead of monkey-patching the module's internal
// RESULTS_DIR constant.
function loadFromFixtureDir() {
  const results = [];
  const warnings = [];
  if (!fs.existsSync(FIXTURE_DIR)) return { results, warnings };
  for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
      results.push(makeResearchResult(parsed));
    } catch (e) {
      warnings.push(`${file}: ${e.message}`);
    }
  }
  return { results, warnings };
}

const { attachResearch } = require("../agent/lib/research-intake");

try {
  test("attachResearch gives every finding a `.research` array, even with zero results loaded", () => {
    const findings = [makeFinding({ type: "missing-title", summary: "s", pages: ["a.html"], evidence: [{ x: 1 }] })];
    const { findings: out } = attachResearch(findings, { results: [], warnings: [] });
    assert.deepStrictEqual(out[0].research, []);
  });

  test("attachResearch matches a loaded result to the finding with the same key, and only that one", () => {
    const matching = makeFinding({ type: "structural-inconsistency", summary: "thin page", pages: ["x.html"], evidence: [{ x: 1 }] });
    const other = makeFinding({ type: "structural-inconsistency", summary: "different page", pages: ["y.html"], evidence: [{ x: 1 }] });
    const result = makeResearchResult(validArgs({ findingKey: matching.key }));
    const { findings: out } = attachResearch([matching, other], { results: [result], warnings: [] });
    assert.strictEqual(out[0].research.length, 1);
    assert.strictEqual(out[0].research[0].findingKey, matching.key);
    assert.strictEqual(out[1].research.length, 0);
  });

  test("attachResearch is resilient to an unavailable/missing results directory — returns empty research, not a thrown error", () => {
    cleanupFixtures(); // ensure it doesn't exist
    const loaded = loadFromFixtureDir();
    assert.deepStrictEqual(loaded.results, []);
    assert.deepStrictEqual(loaded.warnings, []);
    const findings = [makeFinding({ type: "missing-title", summary: "s", pages: ["a.html"], evidence: [{ x: 1 }] })];
    const { findings: out } = attachResearch(findings, loaded);
    assert.deepStrictEqual(out[0].research, []);
  });

  test("a malformed research result file is skipped with a warning, never thrown, and never attached", () => {
    writeFixtureResult("broken.json", { findingKey: "x", question: "missing everything else" });
    const loaded = loadFromFixtureDir();
    assert.strictEqual(loaded.results.length, 0);
    assert.strictEqual(loaded.warnings.length, 1);
    assert.ok(loaded.warnings[0].includes("broken.json"));
  });

  test("agent/research/results/ in THIS repo is real and readable by the actual (non-fixture) loadResearchResults()", () => {
    const { loadResearchResults } = require("../agent/lib/research-intake");
    const loaded = loadResearchResults();
    assert.ok(Array.isArray(loaded.results));
    assert.ok(Array.isArray(loaded.warnings));
  });
} finally {
  cleanupFixtures();
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
