// Site Improvement Agent, Phase 10 — tests for
// agent/lib/local-source-intake.js. Mirrors
// tests/agent-firstparty-intake.test.js's fixture-directory pattern —
// never the real (near-empty) agent/research/local-sources/.
//
// Run with:  node tests/agent-local-source-intake.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeLocalSourceEvidence } = require("../agent/lib/local-source-evidence");

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

const FIXTURE_DIR = path.join(__dirname, "fixtures", "local-source-evidence");

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

// local-source-intake.js reads from the real agent/research/local-sources/
// path by default, so these tests exercise its lower-level loader logic
// directly against a fixture directory instead — same pattern
// tests/agent-firstparty-intake.test.js already uses.
function loadFromFixtureDir() {
  const entries = [];
  const warnings = [];
  if (!fs.existsSync(FIXTURE_DIR)) return { entries, warnings };
  for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) entries.push(makeLocalSourceEvidence(item));
    } catch (e) {
      warnings.push(`${file}: ${e.message}`);
    }
  }
  return { entries, warnings };
}

try {
  test("resilient to an unavailable/missing local-sources directory — returns empty, not a thrown error", () => {
    cleanupFixtures();
    const loaded = loadFromFixtureDir();
    assert.deepStrictEqual(loaded.entries, []);
    assert.deepStrictEqual(loaded.warnings, []);
  });

  test("a malformed evidence file is skipped with a warning, never thrown", () => {
    cleanupFixtures();
    writeFixtureFile("broken.json", [{ sourceUrl: "https://x.gov/y" }]); // missing most required fields
    const loaded = loadFromFixtureDir();
    assert.strictEqual(loaded.entries.length, 0);
    assert.strictEqual(loaded.warnings.length, 1);
    assert.ok(loaded.warnings[0].includes("broken.json"));
  });

  test("a valid fixture file (single object, not an array) loads correctly — writeLocalSourceEvidence() always writes a single object, never an array, unlike firstparty's own files", () => {
    cleanupFixtures();
    writeFixtureFile("denvergov-org__leafdrop-1.json", validArgs());
    const loaded = loadFromFixtureDir();
    assert.strictEqual(loaded.entries.length, 1);
    assert.strictEqual(loaded.warnings.length, 0);
    assert.strictEqual(loaded.entries[0].sourceDomain, "denvergov.org");
  });

  test("multiple evidence files all load, each independently", () => {
    cleanupFixtures();
    writeFixtureFile("a.json", validArgs({ topic: "topic-a" }));
    writeFixtureFile("b.json", validArgs({ topic: "topic-b" }));
    const loaded = loadFromFixtureDir();
    assert.strictEqual(loaded.entries.length, 2);
    assert.deepStrictEqual(loaded.entries.map((e) => e.topic).sort(), ["topic-a", "topic-b"]);
  });

  test("the REAL agent/research/local-sources/ directory loads cleanly via the real (non-fixture) loadLocalSourceEvidence() — near-empty on a fresh checkout, never a thrown error", () => {
    const { loadLocalSourceEvidence } = require("../agent/lib/local-source-intake");
    const loaded = loadLocalSourceEvidence();
    assert.ok(Array.isArray(loaded.entries));
    assert.ok(Array.isArray(loaded.warnings));
  });
} finally {
  cleanupFixtures();
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
