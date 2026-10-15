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
const { attachFirstPartyEvidence, attachRotationEvidence, isOperationalEvidence, loadFirstPartyEvidence } = require("../agent/lib/firstparty-intake");
const { freshlyEvidencedRotationSlugs } = require("../agent/lib/rotation-evidence");

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
// Mirrors the real loadFirstPartyEvidence()'s own purpose filter
// (isOperationalEvidence()) exactly, so these fixture-based tests
// exercise the SAME provenance enforcement the real loader applies —
// not a weaker stand-in.
function loadFromFixtureDir() {
  const entries = [];
  const warnings = [];
  if (!fs.existsSync(FIXTURE_DIR)) return { entries, warnings };
  for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        const evidence = makeFirstPartyEvidence(item);
        if (isOperationalEvidence(evidence)) entries.push(evidence);
      }
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

  // --- Phase 7B: attachRotationEvidence() — same pattern, keyed by
  // rotationSlug instead of findingKey (a rotation pick is never a
  // Finding — see agent/lib/rotation-evidence.js's header) ------------

  test("attachRotationEvidence gives every pick a `.firstPartyEvidence` array, even with zero entries loaded", () => {
    const picks = [{ slug: "golden", name: "Golden", hasPage: false }];
    const { picks: out } = attachRotationEvidence(picks, { entries: [], warnings: [] });
    assert.deepStrictEqual(out[0].firstPartyEvidence, []);
  });

  test("attachRotationEvidence matches a loaded entry to the pick with the same rotationSlug, and only that one", () => {
    const matching = { slug: "golden", name: "Golden", hasPage: false };
    const other = { slug: "brighton", name: "Brighton", hasPage: false };
    const entry = makeFirstPartyEvidence(validArgs({ findingKey: undefined, rotationSlug: "golden" }));
    const { picks: out } = attachRotationEvidence([matching, other], { entries: [entry], warnings: [] });
    assert.strictEqual(out[0].firstPartyEvidence.length, 1);
    assert.strictEqual(out[0].firstPartyEvidence[0].rotationSlug, "golden");
    assert.strictEqual(out[1].firstPartyEvidence.length, 0);
  });

  test("attachRotationEvidence never attaches a findingKey-only entry to a pick, and attachFirstPartyEvidence never attaches a rotationSlug-only entry to a finding — the two key spaces are fully independent", () => {
    const findingEntry = makeFirstPartyEvidence(validArgs({ findingKey: "coverage-gap-candidate::aurora-junk-removal.html" }));
    const rotationEntry = makeFirstPartyEvidence(validArgs({ findingKey: undefined, rotationSlug: "golden" }));
    const loaded = { entries: [findingEntry, rotationEntry], warnings: [] };

    const pick = { slug: "golden", name: "Golden", hasPage: false };
    const { picks: outPicks } = attachRotationEvidence([pick], loaded);
    assert.strictEqual(outPicks[0].firstPartyEvidence.length, 1);
    assert.strictEqual(outPicks[0].firstPartyEvidence[0].rotationSlug, "golden");

    const finding = makeFinding({ type: "coverage-gap-candidate", summary: "s", pages: ["aurora-junk-removal.html"], evidence: [{ x: 1 }] });
    const { findings: outFindings } = attachFirstPartyEvidence([finding], loaded);
    assert.strictEqual(outFindings[0].firstPartyEvidence.length, 1);
    assert.strictEqual(outFindings[0].firstPartyEvidence[0].findingKey, finding.key);
  });

  test("attachRotationEvidence is resilient to an unavailable/missing firstparty evidence directory — returns empty, not a thrown error", () => {
    cleanupFixtures();
    const loaded = loadFromFixtureDir();
    const picks = [{ slug: "golden", name: "Golden", hasPage: false }];
    const { picks: out } = attachRotationEvidence(picks, loaded);
    assert.deepStrictEqual(out[0].firstPartyEvidence, []);
  });

  // -----------------------------------------------------------------------
  // Evidence provenance (purpose) — a diagnostic artifact can never
  // satisfy operational intake, even when its key matches a real
  // finding/rotation pick. See agent/lib/firstparty-intake.js's own
  // header on why the filter lives in loadFirstPartyEvidence() alone.
  // -----------------------------------------------------------------------

  test("legacy evidence written with no purpose field at all remains operational and loads normally", () => {
    cleanupFixtures();
    writeFixtureFile("legacy.json", [validArgs({ findingKey: "coverage-gap-candidate::aurora-junk-removal.html" })]); // no purpose key at all
    const loaded = loadFromFixtureDir();
    assert.strictEqual(loaded.entries.length, 1);
    assert.strictEqual(loaded.entries[0].purpose, "operational");
  });

  test("explicit purpose: 'operational' evidence remains operational and loads normally", () => {
    cleanupFixtures();
    writeFixtureFile("explicit-operational.json", [validArgs({ findingKey: "coverage-gap-candidate::aurora-junk-removal.html", purpose: "operational" })]);
    const loaded = loadFromFixtureDir();
    assert.strictEqual(loaded.entries.length, 1);
    assert.strictEqual(loaded.entries[0].purpose, "operational");
  });

  test("purpose: 'diagnostic' evidence is EXCLUDED from loadFirstPartyEvidence()'s own operational entries, even though the file parses fine and the key matches a real finding/pick", () => {
    cleanupFixtures();
    writeFixtureFile("diagnostic.json", [validArgs({ findingKey: "coverage-gap-candidate::aurora-junk-removal.html", purpose: "diagnostic" })]);
    const loaded = loadFromFixtureDir();
    assert.strictEqual(loaded.entries.length, 0, "a diagnostic-purpose entry must never reach the operational entries array");
    assert.strictEqual(loaded.warnings.length, 0, "exclusion is not an error/warning — it's the correct, expected outcome");
  });

  test("end-to-end through the real loader shape: a diagnostic entry never attaches to a matching finding OR a matching rotation pick, while a sibling operational entry for a DIFFERENT key still attaches normally", () => {
    cleanupFixtures();
    writeFixtureFile("diagnostic-matching-finding.json", [validArgs({ findingKey: "coverage-gap-candidate::aurora-junk-removal.html", purpose: "diagnostic" })]);
    writeFixtureFile("diagnostic-matching-pick.json", [validArgs({ findingKey: undefined, rotationSlug: "golden", purpose: "diagnostic" })]);
    writeFixtureFile("operational-sibling.json", [validArgs({ findingKey: "coverage-gap-candidate::parker-junk-removal.html", purpose: "operational" })]);
    const loaded = loadFromFixtureDir();

    const matchingFinding = makeFinding({ type: "coverage-gap-candidate", summary: "s", pages: ["aurora-junk-removal.html"], evidence: [{ x: 1 }] });
    const siblingFinding = makeFinding({ type: "coverage-gap-candidate", summary: "s2", pages: ["parker-junk-removal.html"], evidence: [{ x: 1 }] });
    const { findings: outFindings } = attachFirstPartyEvidence([matchingFinding, siblingFinding], loaded);
    assert.deepStrictEqual(outFindings[0].firstPartyEvidence, [], "the diagnostic entry must NOT attach despite the matching findingKey");
    assert.strictEqual(outFindings[1].firstPartyEvidence.length, 1, "a genuine operational entry for a different key must still attach normally");

    const goldenPick = { slug: "golden", name: "Golden", hasPage: false };
    const { picks: outPicks } = attachRotationEvidence([goldenPick], loaded);
    assert.deepStrictEqual(outPicks[0].firstPartyEvidence, [], "the diagnostic entry must NOT attach to the Golden pick despite the matching rotationSlug");
  });

  // -----------------------------------------------------------------------
  // The REAL, already-committed Golden diagnostic artifacts — proves the
  // fix against the actual repo content Controlled Weekly #12 flagged,
  // not just a synthetic analog.
  // -----------------------------------------------------------------------

  test("THE REAL Golden Search Console diagnostic file can no longer attach to the real Golden rotation pick", () => {
    const loaded = loadFirstPartyEvidence();
    const goldenDiagnosticStillOnDisk = fs
      .readFileSync(path.join(__dirname, "..", "agent", "research", "firstparty", "search-console-search-analytics__golden-1792071840456.json"), "utf8");
    assert.ok(JSON.parse(goldenDiagnosticStillOnDisk)[0].purpose === "diagnostic", "sanity check: the real file on disk is marked diagnostic");

    const goldenPick = { slug: "golden", name: "Golden", hasPage: false };
    const { picks: outPicks } = attachRotationEvidence([goldenPick], loaded);
    assert.deepStrictEqual(outPicks[0].firstPartyEvidence, [], "the real Golden diagnostic must never attach to the real Golden rotation pick — Controlled Weekly #12's exact contamination");
  });

  test("THE REAL Golden Search Console diagnostic can no longer satisfy Golden rotation freshness — a genuine --refresh-rotation-evidence fetch for Golden is no longer suppressed", () => {
    const loaded = loadFirstPartyEvidence();
    const freshSlugs = freshlyEvidencedRotationSlugs(loaded.entries);
    assert.strictEqual(freshSlugs.has("golden"), false, "with the diagnostic excluded from operational entries, Golden must read as having NO operational evidence, making it eligible for a real fetch again");
  });

  test("THE REAL Golden GA4 diagnostic is likewise excluded from operational intake", () => {
    const loaded = loadFirstPartyEvidence();
    assert.strictEqual(loaded.entries.some((e) => e.source === "ga4" && e.rotationSlug === "golden-ga4"), false, "the GA4 diagnostic must never appear in operational entries, same as the Search Console one");
  });

  test("both real Golden diagnostic artifacts remain fully committed on disk, with their original observed/context data completely untouched — only `purpose` was added", () => {
    const scPath = path.join(__dirname, "..", "agent", "research", "firstparty", "search-console-search-analytics__golden-1792071840456.json");
    const ga4Path = path.join(__dirname, "..", "agent", "research", "firstparty", "ga4__milehighjunkremoval-net-1792073503085.json");
    assert.ok(fs.existsSync(scPath), "the Search Console Golden diagnostic file must still exist — never deleted");
    assert.ok(fs.existsSync(ga4Path), "the GA4 Golden diagnostic file must still exist — never deleted");

    const sc = JSON.parse(fs.readFileSync(scPath, "utf8"))[0];
    assert.strictEqual(sc.purpose, "diagnostic");
    assert.strictEqual(sc.rotationSlug, "golden");
    assert.strictEqual(sc.observed.totalRowsReturned, 0);
    assert.ok(/One-off controlled test of the production auth\/fetch path/.test(sc.context), "original context text must be unchanged");

    const ga4 = JSON.parse(fs.readFileSync(ga4Path, "utf8"))[0];
    assert.strictEqual(ga4.purpose, "diagnostic");
    assert.strictEqual(ga4.rotationSlug, "golden-ga4");
    assert.strictEqual(ga4.observed.totalRowsReturned, 10);
    assert.ok(/One-off controlled test of the production auth\/fetch path/.test(ga4.context), "original context text must be unchanged");
  });
} finally {
  cleanupFixtures();
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
