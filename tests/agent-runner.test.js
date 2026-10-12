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
// explicit `node agent/cli.js` invocation. Every call here also passes
// `syncProposals: false` — this file is about the scan/decide/apply/
// validate/history pipeline, not the CRM proposals sync (see
// tests/agent-proposals-sync.test.js for that), and passing false keeps
// this file from depending on whether SUPABASE_URL happens to be set in
// whatever environment it runs in.
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
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((e) => {
      console.error(`FAIL - ${name}`);
      console.error(e);
      process.exitCode = 1;
    });
}

const TEST_LOG_PATH = path.join(os.tmpdir(), `agent-runner-test-${process.pid}.ndjson`);

function gitStatusPorcelain() {
  return execSync("git status --porcelain", { cwd: config.SITE_ROOT, encoding: "utf8" });
}

async function main() {
  try {
    await test("gatherFindings() runs against the real site without throwing and returns well-formed, decided findings", () => {
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

    await test("gatherFindings() is resilient when agent/research/results/ is empty (its current real state) — no findings get stuck undecided", () => {
      const { findings } = runner.gatherFindings();
      const undecided = findings.filter((f) => !f.decision);
      assert.deepStrictEqual(undecided, []);
    });

    await test("dry-run mode never modifies any file in the repo working tree", async () => {
      const before = gitStatusPorcelain();
      const record = await runner.run({ mode: "dry-run", logPath: TEST_LOG_PATH, syncProposals: false });
      const after = gitStatusPorcelain();

      assert.strictEqual(record.mode, "dry-run");
      assert.strictEqual(record.summary.autoApplied, 0);
      for (const f of record.findings) {
        assert.strictEqual(f.status, "proposed");
      }
      assert.strictEqual(after, before, "dry-run must not change git status at all (log goes to a temp path in this test)");
    });

    await test("apply-safe mode refuses to apply anything when the working tree is dirty", async () => {
      const markerPath = path.join(config.SITE_ROOT, "tests", "fixtures", ".agent-runner-dirty-marker");
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, "dirtying the tree on purpose for this test\n");
      try {
        assert.strictEqual(runner.isWorkingTreeClean(), false);
        const record = await runner.run({ mode: "apply-safe", logPath: TEST_LOG_PATH, syncProposals: false });
        assert.ok(record.applySkippedReason, "expected applySkippedReason to be set");
        assert.strictEqual(record.summary.autoApplied, 0);
        for (const f of record.findings) {
          assert.notStrictEqual(f.status, "applied");
        }
      } finally {
        fs.unlinkSync(markerPath);
      }
    });

    // Phase 4 bug fix regression test — runner.js's persisted-record
    // builder was missing `tier` entirely (present on the in-memory
    // finding, from risk.js's classify(), but silently dropped before
    // being written to history). history.js's iconForFinding()/
    // describeFinding() both key off `finding.tier` to tell an
    // observation-tier NO_CHANGE apart from a genuinely-researched one —
    // without this field the CRM activity feed mislabeled every
    // observation. This proves the field both (a) reaches the returned
    // record and (b) survives the actual JSON-line write-then-read
    // round-trip to the log file, not just the in-memory return value.
    await test("tier survives into the persisted activity-log record — every finding has one, matching gatherFindings()'s own classification, after a full write+read round-trip", async () => {
      const { findings: freshlyClassified } = runner.gatherFindings();
      const tierByKey = new Map(freshlyClassified.map((f) => [f.key, f.tier]));

      const record = await runner.run({ mode: "dry-run", logPath: TEST_LOG_PATH, syncProposals: false });
      assert.ok(record.findings.length > 0, "expected the real site to produce at least one finding for this test to be meaningful");
      for (const f of record.findings) {
        assert.ok(["observation", "opportunity", "actionable"].includes(f.tier), `finding ${f.type} (${f.key}) is missing a valid tier in the run() return value`);
        assert.strictEqual(f.tier, tierByKey.get(f.key), `finding ${f.key}'s persisted tier must match risk.js's own classification`);
      }

      // Read back from disk — the actual bug was specifically about what
      // gets WRITTEN, so asserting only on the in-memory `record` would
      // not have caught it.
      const allRuns = history.readAllRuns(TEST_LOG_PATH);
      const saved = allRuns.find((r) => r.runId === record.runId);
      assert.ok(saved, "expected this run to actually be persisted");
      assert.ok(saved.findings.length > 0);
      for (const f of saved.findings) {
        assert.ok(["observation", "opportunity", "actionable"].includes(f.tier), `persisted finding ${f.type} is missing tier after a write+read round-trip`);
      }
      assert.ok(saved.findings.some((f) => f.tier === "observation"), "expected at least one real observation-tier finding on the live site (e.g. a title/description-length outlier) for this regression test to actually exercise the bug");
    });

    await test("every run, including an empty-findings run, is recorded to history", async () => {
      const record = await runner.run({ mode: "dry-run", logPath: TEST_LOG_PATH, syncProposals: false });
      assert.ok(record.runId);
      assert.ok(record.timestamp);
      const allRuns = history.readAllRuns(TEST_LOG_PATH);
      assert.ok(allRuns.some((r) => r.runId === record.runId));
    });

    await test("proposalsSync is skipped (never thrown) and still recorded in history when disabled for the run", async () => {
      const record = await runner.run({ mode: "dry-run", logPath: TEST_LOG_PATH, syncProposals: false });
      assert.strictEqual(record.proposalsSync.skipped, true);
      const allRuns = history.readAllRuns(TEST_LOG_PATH);
      const saved = allRuns.find((r) => r.runId === record.runId);
      assert.ok(saved.proposalsSync);
    });
  } finally {
    if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH);
  }

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main();
