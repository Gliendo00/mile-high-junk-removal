// Site Improvement Agent — integration tests for runner.js, run against
// the REAL site content (read-only in dry-run mode) to prove the agent
// can actually analyze this codebase end-to-end. Also proves the runner
// never mutates site content in dry-run mode, and refuses to apply
// anything when the working tree is dirty.
//
// All test runs are logged to a throwaway history file OUTSIDE the repo
// (os.tmpdir()), not the real committed agent/history/log.ndjson — so
// running this test suite repeatedly (including in CI someday) never
// bloats the real activity log. The real log is only ever written by an
// explicit `node agent/cli.js` invocation.
//
// Run with:  node tests/agent-runner.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const config = require("../agent/config");
const runner = require("../agent/runner");
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

const TEST_LOG_PATH = path.join(os.tmpdir(), `agent-runner-test-${process.pid}.ndjson`);

function gitStatusPorcelain() {
  return execSync("git status --porcelain", { cwd: config.SITE_ROOT, encoding: "utf8" });
}

try {
  test("gatherFindings() runs against the real site without throwing and returns well-formed, decided findings", () => {
    const { pages, findings, researchWarnings } = runner.gatherFindings();
    assert.ok(pages.length > 30, "expected the real site to have more than 30 top-level pages");
    assert.ok(Array.isArray(findings));
    assert.ok(Array.isArray(researchWarnings), "research-unavailable must fail safe — an array (possibly empty), never a thrown error");
    for (const f of findings) {
      assert.ok(f.id);
      assert.ok(f.key);
      assert.ok(f.type);
      assert.ok(["A", "B", "C", "D", "E"].includes(f.category));
      assert.ok(f.evidence.length > 0);
      assert.ok(Array.isArray(f.research), "every finding must have a `.research` array, even when empty");
      assert.ok(f.decision, `finding ${f.type} must have a decision assigned`);
      assert.ok(["APPLY_SAFE_FIX", "PROPOSE_CHANGE", "RESEARCH_MORE", "NO_CHANGE", "REJECT_OPPORTUNITY"].includes(f.decision));
      if (f.decision === "RESEARCH_MORE") {
        assert.ok(f.researchQuestion, "a RESEARCH_MORE finding must carry a structured researchQuestion");
      }
    }
  });

  test("gatherFindings() is resilient when agent/research/results/ is empty (its current real state) — no findings get stuck undecided", () => {
    const { findings } = runner.gatherFindings();
    const undecided = findings.filter((f) => !f.decision);
    assert.deepStrictEqual(undecided, []);
  });

  test("dry-run mode never modifies any file in the repo working tree", () => {
    const before = gitStatusPorcelain();
    const record = runner.run({ mode: "dry-run", logPath: TEST_LOG_PATH });
    const after = gitStatusPorcelain();

    assert.strictEqual(record.mode, "dry-run");
    assert.strictEqual(record.summary.autoApplied, 0);
    for (const f of record.findings) {
      assert.strictEqual(f.status, "proposed");
    }
    assert.strictEqual(after, before, "dry-run must not change git status at all (log goes to a temp path in this test)");
  });

  test("apply-safe mode refuses to apply anything when the working tree is dirty", () => {
    const markerPath = path.join(config.SITE_ROOT, "tests", "fixtures", ".agent-runner-dirty-marker");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "dirtying the tree on purpose for this test\n");
    try {
      assert.strictEqual(runner.isWorkingTreeClean(), false);
      const record = runner.run({ mode: "apply-safe", logPath: TEST_LOG_PATH });
      assert.ok(record.applySkippedReason, "expected applySkippedReason to be set");
      assert.strictEqual(record.summary.autoApplied, 0);
      for (const f of record.findings) {
        assert.notStrictEqual(f.status, "applied");
      }
    } finally {
      fs.unlinkSync(markerPath);
    }
  });

  test("every run, including an empty-findings run, is recorded to history", () => {
    const record = runner.run({ mode: "dry-run", logPath: TEST_LOG_PATH });
    assert.ok(record.runId);
    assert.ok(record.timestamp);
    const allRuns = history.readAllRuns(TEST_LOG_PATH);
    assert.ok(allRuns.some((r) => r.runId === record.runId));
  });
} finally {
  if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
