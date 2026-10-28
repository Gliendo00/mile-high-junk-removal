// Site Improvement Agent, Phase 15 — tests for history.js's
// latestClassificationByKey(): the "log-only" memory for WATCH/
// LOW_SUPPRESS/PROTECT findings, which never reach agent_proposals.
//
// Run with:  node tests/agent-opportunity-history.test.js

const assert = require("assert");
const { latestClassificationByKey, buildDashboardSummary } = require("../agent/lib/history");

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

function run(timestamp, classifications) {
  return { runId: "run-" + timestamp, timestamp, opportunityClassifications: classifications, findings: [] };
}

async function main() {
  test("returns null when no run has any classification for the key", () => {
    const runs = [run("2026-10-20T00:00:00Z", [{ key: "a", classification: "WATCH" }])];
    assert.strictEqual(latestClassificationByKey(runs, "nonexistent-key"), null);
  });

  test("returns null (never throws) for empty/malformed input", () => {
    assert.strictEqual(latestClassificationByKey([], "k"), null);
    assert.strictEqual(latestClassificationByKey(null, "k"), null);
    assert.strictEqual(latestClassificationByKey(undefined, "k"), null);
  });

  test("a WATCH classification persists across runs and is read back by key", () => {
    const runs = [run("2026-10-25T00:00:00Z", [{ key: "ctr::denver.html", classification: "WATCH", fingerprint: "fp1", reason: "r" }])];
    const found = latestClassificationByKey(runs, "ctr::denver.html");
    assert.strictEqual(found.classification, "WATCH");
    assert.strictEqual(found.fingerprint, "fp1");
  });

  test("a PROTECT classification persists the same way as WATCH", () => {
    const runs = [run("2026-10-25T00:00:00Z", [{ key: "protect::pricing.html", classification: "PROTECT", fingerprint: "fp2" }])];
    const found = latestClassificationByKey(runs, "protect::pricing.html");
    assert.strictEqual(found.classification, "PROTECT");
  });

  test("the MOST RECENT run's entry wins when the same key appears in multiple runs", () => {
    const runs = [
      run("2026-10-20T00:00:00Z", [{ key: "k1", classification: "WATCH", fingerprint: "old" }]),
      run("2026-10-25T00:00:00Z", [{ key: "k1", classification: "IMPORTANT", fingerprint: "new" }]),
    ];
    const found = latestClassificationByKey(runs, "k1");
    assert.strictEqual(found.fingerprint, "new");
  });

  test("order of the `runs` array passed in does not matter — results are sorted by timestamp internally", () => {
    const runs = [
      run("2026-10-25T00:00:00Z", [{ key: "k1", classification: "IMPORTANT", fingerprint: "new" }]),
      run("2026-10-20T00:00:00Z", [{ key: "k1", classification: "WATCH", fingerprint: "old" }]),
    ];
    const found = latestClassificationByKey(runs, "k1");
    assert.strictEqual(found.fingerprint, "new");
  });

  test("buildDashboardSummary() surfaces a terse operational-counts line when a run has classifications, even with zero findings", () => {
    const runs = [
      {
        runId: "r1",
        timestamp: "2026-10-26T00:00:00Z",
        mode: "dry-run",
        summary: { pagesScanned: 30 },
        findings: [],
        opportunityClassifications: [
          { key: "a", classification: "IMPORTANT" },
          { key: "b", classification: "WATCH" },
          { key: "c", classification: "WATCH" },
          { key: "d", classification: "LOW_SUPPRESS" },
          { key: "e", classification: "PROTECT" },
        ],
      },
    ];
    const summary = buildDashboardSummary(runs);
    const line = summary[0].lines.find((l) => /Opportunities researched/.test(l.text));
    assert.ok(line, "expected an 'Opportunities researched' line in the activity feed");
    assert.ok(line.text.includes("5"));
    assert.ok(line.text.includes("1 important"));
    assert.ok(line.text.includes("2 watch"));
    assert.ok(line.text.includes("1 suppressed"));
    assert.ok(line.text.includes("1 protect"));
  });

  test("buildDashboardSummary() omits the operational-counts line entirely when a run has no classifications (e.g. a pre-Phase-15 log entry)", () => {
    const runs = [{ runId: "r1", timestamp: "2026-10-26T00:00:00Z", mode: "dry-run", summary: { pagesScanned: 30 }, findings: [] }];
    const summary = buildDashboardSummary(runs);
    const line = summary[0].lines.find((l) => /Opportunities researched/.test(l.text));
    assert.strictEqual(line, undefined);
  });

  console.log("agent-opportunity-history.test.js: all tests completed");
}

main();
