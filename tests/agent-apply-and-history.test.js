// Site Improvement Agent — tests for the apply whitelist (rewrite-href)
// and the history log, using a throwaway fixture file / log path under
// tests/fixtures/ so these tests never touch real site pages or the real
// committed history log. The fixture directory is cleaned up afterward.
//
// Run with:  node tests/agent-apply-and-history.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const config = require("../agent/config");
const rewriteHref = require("../agent/lib/apply/rewrite-href");
const history = require("../agent/lib/history");

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

const FIXTURE_DIR = path.join(config.SITE_ROOT, "tests", "fixtures");
const FIXTURE_REL = "tests/fixtures/agent-apply-fixture.html";
const FIXTURE_ABS = path.join(config.SITE_ROOT, FIXTURE_REL);
const FAKE_LOG = path.join(FIXTURE_DIR, "agent-history-fixture.ndjson");

function writeFixture(html) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(FIXTURE_ABS, html, "utf8");
}

function cleanup() {
  for (const p of [FIXTURE_ABS, FAKE_LOG]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

try {
  test("rewrite-href applies a single unambiguous match", () => {
    writeFixture('<a href="/service-areas/denver-co">Denver</a>');
    const result = rewriteHref.apply({
      file: FIXTURE_REL,
      from: "/service-areas/denver-co",
      to: "/denver-junk-removal.html",
    });
    assert.strictEqual(result.changed, true);
    const updated = fs.readFileSync(FIXTURE_ABS, "utf8");
    assert.ok(updated.includes('href="/denver-junk-removal.html"'));
    assert.ok(!updated.includes("/service-areas/denver-co"));
  });

  test("rewrite-href refuses when the target string appears zero times", () => {
    writeFixture('<a href="/somewhere-else.html">Link</a>');
    const result = rewriteHref.apply({
      file: FIXTURE_REL,
      from: "/service-areas/denver-co",
      to: "/denver-junk-removal.html",
    });
    assert.strictEqual(result.changed, false);
    assert.ok(result.reason.includes("not found"));
    const untouched = fs.readFileSync(FIXTURE_ABS, "utf8");
    assert.ok(untouched.includes("/somewhere-else.html"));
  });

  test("rewrite-href refuses when the target string appears more than once (never guesses)", () => {
    writeFixture(
      '<a href="/service-areas/denver-co">A</a><a href="/service-areas/denver-co">B</a>'
    );
    const result = rewriteHref.apply({
      file: FIXTURE_REL,
      from: "/service-areas/denver-co",
      to: "/denver-junk-removal.html",
    });
    assert.strictEqual(result.changed, false);
    assert.ok(result.reason.includes("appears 2 times"));
    const untouched = fs.readFileSync(FIXTURE_ABS, "utf8");
    assert.strictEqual((untouched.match(/service-areas\/denver-co/g) || []).length, 2);
  });

  test("history.appendRun + readAllRuns round-trips a run record", () => {
    if (fs.existsSync(FAKE_LOG)) fs.unlinkSync(FAKE_LOG);
    const record = { runId: "test-run-1", timestamp: new Date().toISOString(), mode: "dry-run", findings: [] };
    history.appendRun(record, FAKE_LOG);
    const all = history.readAllRuns(FAKE_LOG);
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].runId, "test-run-1");
  });

  test("history.buildDashboardSummary renders 'no worthwhile change' for an empty-findings run", () => {
    const runs = [{ runId: "r1", timestamp: new Date().toISOString(), mode: "dry-run", findings: [] }];
    const summary = history.buildDashboardSummary(runs);
    assert.strictEqual(summary.length, 1);
    assert.deepStrictEqual(summary[0].lines, [{ icon: "check", text: "No worthwhile change today." }]);
  });

  test("history.buildDashboardSummary leads with a 'Checked N pages' line when pagesScanned is known", () => {
    const runs = [{ runId: "r0", timestamp: new Date().toISOString(), mode: "dry-run", summary: { pagesScanned: 51 }, findings: [] }];
    const summary = history.buildDashboardSummary(runs);
    assert.deepStrictEqual(summary[0].lines[0], { icon: "check", text: "Checked 51 pages" });
  });

  test("history.buildDashboardSummary distinguishes applied / proposed / researched lines (Phase 1 shape, no `decision` field)", () => {
    const runs = [
      {
        runId: "r2",
        timestamp: new Date().toISOString(),
        mode: "apply-safe",
        findings: [
          { status: "applied", summary: "fixed a redirect hop", category: "B", riskLevel: "low" },
          { status: "proposed", summary: "duplicate title found", category: "D", riskLevel: "high" },
          { status: "proposed", summary: "outdated content maybe", category: "E", riskLevel: "unknown" },
        ],
      },
    ];
    const summary = history.buildDashboardSummary(runs);
    assert.deepStrictEqual(summary[0].lines[0], { icon: "check", text: "Fixed: fixed a redirect hop" });
    assert.deepStrictEqual(summary[0].lines[1], { icon: "flag", text: "Identified opportunity: duplicate title found" });
    assert.deepStrictEqual(summary[0].lines[2], { icon: "research", text: "Researched: outdated content maybe — no change made" });
  });

  test("history.buildDashboardSummary uses Phase 2 `decision`-aware icons/text when present", () => {
    const runs = [
      {
        runId: "r3",
        timestamp: new Date().toISOString(),
        mode: "apply-safe",
        summary: { pagesScanned: 51 },
        findings: [
          { decision: "APPLY_SAFE_FIX", status: "applied", summary: "fixed a redirect hop" },
          { decision: "RESEARCH_MORE", summary: "Aurora appliance-removal opportunity" },
          { decision: "NO_CHANGE", summary: "thin page maybe", research: [{ source: "x" }] },
          { decision: "REJECT_OPPORTUNITY", summary: "not actually useful" },
          { decision: "PROPOSE_CHANGE", summary: "sitemap issue" },
        ],
      },
    ];
    const summary = history.buildDashboardSummary(runs);
    assert.deepStrictEqual(summary[0].lines, [
      { icon: "check", text: "Checked 51 pages" },
      { icon: "check", text: "Fixed: fixed a redirect hop" },
      { icon: "research", text: "Researching: Aurora appliance-removal opportunity — pending" },
      { icon: "research", text: "Researched: thin page maybe — no change made — insufficient evidence" },
      { icon: "reject", text: "Rejected opportunity: not actually useful" },
      { icon: "flag", text: "Found: sitemap issue — review/apply status" },
    ]);
  });

  test("history.buildDashboardSummary: Phase 3's observation-tier NO_CHANGE renders distinctly from a researched NO_CHANGE", () => {
    const runs = [
      {
        runId: "r4",
        timestamp: new Date().toISOString(),
        mode: "dry-run",
        summary: { pagesScanned: 51 },
        findings: [
          { decision: "NO_CHANGE", tier: "observation", summary: "title is 71 characters" },
          { decision: "NO_CHANGE", summary: "thin page maybe", research: [{ source: "x" }] },
        ],
      },
    ];
    const summary = history.buildDashboardSummary(runs);
    assert.deepStrictEqual(summary[0].lines[1], { icon: "observation", text: "Observed: title is 71 characters — not actionable on its own" });
    assert.deepStrictEqual(summary[0].lines[2], { icon: "research", text: "Researched: thin page maybe — no change made — insufficient evidence" });
  });

  test("history.buildDashboardSummary sorts most-recent-first and respects limit", () => {
    const runs = [
      { runId: "old", timestamp: "2026-01-01T00:00:00.000Z", mode: "dry-run", findings: [] },
      { runId: "new", timestamp: "2026-06-01T00:00:00.000Z", mode: "dry-run", findings: [] },
    ];
    const summary = history.buildDashboardSummary(runs, 1);
    assert.strictEqual(summary.length, 1);
    assert.strictEqual(summary[0].runId, "new");
  });
} finally {
  cleanup();
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
