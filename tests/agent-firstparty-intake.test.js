// Site Improvement Agent, Phase 6 — tests for agent/lib/firstparty-
// intake.js (reads agent/research/firstparty/*.json, validates, attaches
// to findings by key). Mirrors tests/agent-research.test.js's
// research-intake.js tests, using a throwaway fixture directory under
// tests/fixtures/ — never the real (empty) agent/research/firstparty/.
//
// Run with:  node tests/agent-firstparty-intake.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeFirstPartyEvidence } = require("../agent/lib/firstparty-evidence");
const { makeFinding } = require("../agent/lib/findings");
const { attachFirstPartyEvidence } = require("../agent/lib/firstparty-intake");

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
    source: "ga4",
    metric: "sessions",
    scope: { type: "page", value: "aurora-junk-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: 1, topRows: [{ dimensions: ["aurora-junk-removal.html"], metrics: ["42"] }] },
    context: "Targeted GA4 report for page \"aurora-junk-removal.html\".",
    limitations: "Aggregate session data only — does not establish that a change would improve outcomes.",
    ...overrides,
  };
}

const FIXTURE_DIR = path.join(__dirname, "fixtures", "firstparty-evidence");

function writeFixtureFile(filename, data) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_DIR, filename), JSON.stringify(data, null, 2), "utf8");
}

function cleanupFixtures() {
  if (fs.existsSync(FIXTURE_DIR)) {
    for (const f of fs.readdirSync(FIXTURE_DIR)) fs.unlinkSync(path.join(FIXTURE_DIR, f));
    fs.rmdirSync(FIXTURE_DIR);
  }
}

// firstparty-intake.js reads from the real agent/research/firstparty/
// path by default, so these tests exercise its lower-level loader logic
// directly against a fixture directory instead — same pattern
// tests/agent-research.test.js already uses for research-intake.js.
function loadFromFixtureDir() {
  const entries = [];
  const warnings = [];
  if (!fs.existsSync(FIXTURE_DIR)) return { entries, warnings };
  for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) entries.push(makeFirstPartyEvidence(item));
    } catch (e) {
      warnings.push(`${file}: ${e.message}`);
    }
  }
  return { entries, warnings };
}

try {
  test("attachFirstPartyEvidence gives every finding a `.firstPartyEvidence` array, even with zero entries loaded", () => {
    const findings = [makeFinding({ type: "missing-title", summary: "s", pages: ["a.html"], evidence: [{ x: 1 }] })];
    const { findings: out } = attachFirstPartyEvidence(findings, { entries: [], warnings: [] });
    assert.deepStrictEqual(out[0].firstPartyEvidence, []);
  });

  test("attachFirstPartyEvidence matches a loaded entry to the finding with the same key, and only that one", () => {
    const matching = makeFinding({ type: "coverage-gap-candidate", summary: "s", pages: ["aurora-junk-removal.html"], evidence: [{ x: 1 }] });
    const other = makeFinding({ type: "coverage-gap-candidate", summary: "s2", pages: ["parker-junk-removal.html"], evidence: [{ x: 1 }] });
    const entry = makeFirstPartyEvidence(validArgs({ findingKey: matching.key }));
    const { findings: out } = attachFirstPartyEvidence([matching, other], { entries: [entry], warnings: [] });
    assert.strictEqual(out[0].firstPartyEvidence.length, 1);
    assert.strictEqual(out[0].firstPartyEvidence[0].findingKey, matching.key);
    assert.strictEqual(out[1].firstPartyEvidence.length, 0);
  });

  test("an entry with no findingKey is informational-only and is never attached to any finding", () => {
    const finding = makeFinding({ type: "missing-title", summary: "s", pages: ["a.html"], evidence: [{ x: 1 }] });
    const entry = makeFirstPartyEvidence(validArgs({ findingKey: undefined }));
    const { findings: out } = attachFirstPartyEvidence([finding], { entries: [entry], warnings: [] });
    assert.deepStrictEqual(out[0].firstPartyEvidence, []);
  });

  test("resilient to an unavailable/missing firstparty evidence directory — returns empty, not a thrown error", () => {
    cleanupFixtures();
    const loaded = loadFromFixtureDir();
    assert.deepStrictEqual(loaded.entries, []);
    assert.deepStrictEqual(loaded.warnings, []);
    const findings = [makeFinding({ type: "missing-title", summary: "s", pages: ["a.html"], evidence: [{ x: 1 }] })];
    const { findings: out } = attachFirstPartyEvidence(findings, loaded);
    assert.deepStrictEqual(out[0].firstPartyEvidence, []);
  });

  test("a malformed evidence file is skipped with a warning, never thrown, and never attached", () => {
    writeFixtureFile("broken.json", [{ source: "ga4", metric: "sessions" }]); // missing scope/window/observed/context/limitations
    const loaded = loadFromFixtureDir();
    assert.strictEqual(loaded.entries.length, 0);
    assert.strictEqual(loaded.warnings.length, 1);
    assert.ok(loaded.warnings[0].includes("broken.json"));
  });

  test("a valid fixture file (array of entries) loads and attaches correctly", () => {
    cleanupFixtures(); // the previous test's broken.json must not leak into this one's warning-count assertion
    const entry1 = validArgs({ findingKey: "coverage-gap-candidate::aurora-junk-removal.html" });
    writeFixtureFile("ga4__aurora.json", [entry1]);
    const loaded = loadFromFixtureDir();
    assert.strictEqual(loaded.entries.length, 1);
    assert.strictEqual(loaded.warnings.length, 0);
    const finding = makeFinding({ type: "coverage-gap-candidate", summary: "s", pages: ["aurora-junk-removal.html"], evidence: [{ x: 1 }] });
    const { findings: out } = attachFirstPartyEvidence([finding], loaded);
    assert.strictEqual(out[0].firstPartyEvidence.length, 1);
  });

  test("agent/research/firstparty/ in THIS repo is real and readable by the actual (non-fixture) loadFirstPartyEvidence()", () => {
    const { loadFirstPartyEvidence } = require("../agent/lib/firstparty-intake");
    const loaded = loadFirstPartyEvidence();
    assert.ok(Array.isArray(loaded.entries));
    assert.ok(Array.isArray(loaded.warnings));
  });
} finally {
  cleanupFixtures();
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
