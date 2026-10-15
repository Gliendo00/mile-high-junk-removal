// Site Improvement Agent, Phase 5B — integration tests for the research
// orchestration lifecycle: a run that needs external research persists
// as "research_pending" (never looking like a successful/all-clear run),
// a research-capable orchestrator writes result file(s), and resuming
// the SAME runId finalizes it to "completed" — recorded as a second
// append-only line sharing that runId, collapsed to one current report
// by history.latestByRunId() (see runner.js's own header for the full
// design).
//
// Uses the REAL site content but TEMPORARILY moves the real committed
// agent/research/results/*.json files aside (restored in a `finally`
// block, never left moved) so a real category-C finding (content-gap on
// blog-seasonal-cleanout-guide.html) reliably has NO research attached
// yet — i.e. reliably produces a RESEARCH_MORE decision, the exact
// precondition this whole lifecycle is about. This is the same site
// state Phase 2's very first dry run documented before any research
// existed (see agent/README.md).
//
// Run with:  node tests/agent-runner-resume.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const runner = require("../agent/runner");
const history = require("../agent/lib/history");
const { RESULTS_DIR } = require("../agent/lib/research-intake");
const { ConcurrentRunError } = require("../agent/lib/run-lock");

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

function tmpPath(suffix) {
  return path.join(os.tmpdir(), `agent-runner-resume-${process.pid}-${Math.random().toString(36).slice(2)}${suffix}`);
}

function withResearchResultsCleared(fn) {
  const files = fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"));
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-research-results-backup-"));
  for (const f of files) fs.renameSync(path.join(RESULTS_DIR, f), path.join(backupDir, f));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const f of files) fs.renameSync(path.join(backupDir, f), path.join(RESULTS_DIR, f));
      fs.rmdirSync(backupDir);
    });
}

async function main() {
  await withResearchResultsCleared(async () => {
    await test("a run with an unresolved category-C finding persists status 'research_pending', never 'completed' or an all-clear health summary", async () => {
      const logPath = tmpPath(".ndjson");
      const record = await runner.run({ mode: "dry-run", runType: "daily", logPath, syncProposals: false, skipLock: true });
      assert.strictEqual(record.report.status, "research_pending");
      assert.notStrictEqual(record.report.healthSummary.status, "all-clear");
      assert.ok(record.report.research.questionsPending.length > 0);
      assert.ok(/awaiting results/.test(record.report.healthSummary.text));
      fs.unlinkSync(logPath);
    });

    await test("questionsPending carries the full researchQuestion object (question text, internal evidence, suggested source types) — the actual hand-off contract to the orchestrator", async () => {
      const logPath = tmpPath(".ndjson");
      const record = await runner.run({ mode: "dry-run", runType: "daily", logPath, syncProposals: false, skipLock: true });
      const q = record.report.research.questionsPending.find((q) => q.findingKey === "content-gap::blog-seasonal-cleanout-guide.html");
      assert.ok(q, "expected the known real content-gap finding to be pending research");
      assert.ok(typeof q.question === "string" && q.question.length > 0);
      assert.ok(Array.isArray(q.internalEvidence));
      assert.ok(Array.isArray(q.suggestedSourceTypes));
      fs.unlinkSync(logPath);
    });

    await test("writing a research result file and resuming the SAME runId finalizes it to 'completed', as a SECOND line sharing that runId (sequence 2) — never a new runId", async () => {
      const logPath = tmpPath(".ndjson");
      const pass1 = await runner.run({ mode: "dry-run", runType: "daily", logPath, syncProposals: false, skipLock: true });
      assert.strictEqual(pass1.report.status, "research_pending");
      assert.strictEqual(pass1.sequence, 1);

      const q = pass1.report.research.questionsPending[0];
      const resultFile = path.join(RESULTS_DIR, "resume-test-temp.json");
      fs.writeFileSync(resultFile, JSON.stringify({
        findingKey: q.findingKey, question: q.question, source: "test", sourceType: "internal-repo-review",
        evidence: ["test evidence"], confidence: "high", limitations: "none for this test",
        verdict: "supports-opportunity", recommendation: "test", temporality: "evergreen",
      }));

      try {
        const pass2 = await runner.run({ resumeRunId: pass1.runId, logPath, syncProposals: false, skipLock: true });
        assert.strictEqual(pass2.runId, pass1.runId, "resuming must reuse the SAME runId, never mint a new one");
        assert.strictEqual(pass2.sequence, 2);
        assert.strictEqual(pass2.report.status, "completed");
        assert.strictEqual(pass2.report.research.questionsPending.length, 0);

        const allRuns = history.readAllRuns(logPath);
        assert.strictEqual(allRuns.length, 2, "both the pending and the finalized line must exist in the append-only log — neither is ever rewritten");
        assert.deepStrictEqual(allRuns.map((r) => r.runId), [pass1.runId, pass1.runId]);

        const deduped = history.latestByRunId(allRuns);
        assert.strictEqual(deduped.length, 1, "the two lines must collapse to exactly ONE current report — never a confusing duplicate 'before'/'after research' pair");
        assert.strictEqual(deduped[0].report.status, "completed");
      } finally {
        fs.unlinkSync(resultFile);
      }
      fs.unlinkSync(logPath);
    });

    await test("resume inherits mode/runType from the original run when not re-specified", async () => {
      const logPath = tmpPath(".ndjson");
      const pass1 = await runner.run({ mode: "dry-run", runType: "weekly", logPath, syncProposals: false, skipLock: true, rotationStatePath: tmpPath(".rotation.json") });
      const q = pass1.report.research.questionsPending[0];
      const resultFile = path.join(RESULTS_DIR, "resume-inherit-test-temp.json");
      fs.writeFileSync(resultFile, JSON.stringify({
        findingKey: q.findingKey, question: q.question, source: "test", sourceType: "internal-repo-review",
        evidence: ["test evidence"], confidence: "high", limitations: "none", verdict: "supports-opportunity", recommendation: "test",
      }));
      try {
        const pass2 = await runner.run({ resumeRunId: pass1.runId, logPath, syncProposals: false, skipLock: true });
        assert.strictEqual(pass2.mode, "dry-run");
        assert.strictEqual(pass2.runType, "weekly");
        // Weekly rotation picks decided during pass 1 are carried forward, not recomputed.
        assert.deepStrictEqual(pass2.report.rotation.picks, pass1.report.rotation.picks);
      } finally {
        fs.unlinkSync(resultFile);
      }
      fs.unlinkSync(logPath);
    });

    await test("resuming excludes the run's own research_pending line from change-detection's 'previous run' lookup — a resumed run never diffs itself against itself", async () => {
      const logPath = tmpPath(".ndjson");
      const pass1 = await runner.run({ mode: "dry-run", runType: "daily", logPath, syncProposals: false, skipLock: true });
      const q = pass1.report.research.questionsPending[0];
      const resultFile = path.join(RESULTS_DIR, "resume-cd-test-temp.json");
      fs.writeFileSync(resultFile, JSON.stringify({
        findingKey: q.findingKey, question: q.question, source: "test", sourceType: "internal-repo-review",
        evidence: ["test evidence"], confidence: "high", limitations: "none", verdict: "supports-opportunity", recommendation: "test",
      }));
      try {
        const pass2 = await runner.run({ resumeRunId: pass1.runId, logPath, syncProposals: false, skipLock: true });
        assert.strictEqual(pass2.report.changeDetection.hasPreviousRun, false, "with no OTHER prior run in this throwaway log, resume must see 'no previous run', not its own pending line");
      } finally {
        fs.unlinkSync(resultFile);
      }
      fs.unlinkSync(logPath);
    });

    await test("resuming a runId that does not exist throws a clear error, never a false success", async () => {
      const logPath = tmpPath(".ndjson"); // never created — readAllRuns() on a missing path returns []
      await assert.rejects(
        () => runner.run({ resumeRunId: "does-not-exist", logPath, syncProposals: false, skipLock: true }),
        /No run found with runId/
      );
    });

    await test("resuming an already-finalized (completed) run is refused, never silently re-finalized", async () => {
      const logPath = tmpPath(".ndjson");
      // This run has no pending research by construction (findings from an
      // empty/offline content-gap situation aren't guaranteed here since
      // results were cleared) — force a definite "already completed" run
      // instead by resolving the one real pending finding first.
      const pass1 = await runner.run({ mode: "dry-run", runType: "daily", logPath, syncProposals: false, skipLock: true });
      const q = pass1.report.research.questionsPending[0];
      const resultFile = path.join(RESULTS_DIR, "resume-twice-test-temp.json");
      fs.writeFileSync(resultFile, JSON.stringify({
        findingKey: q.findingKey, question: q.question, source: "test", sourceType: "internal-repo-review",
        evidence: ["test evidence"], confidence: "high", limitations: "none", verdict: "supports-opportunity", recommendation: "test",
      }));
      try {
        const pass2 = await runner.run({ resumeRunId: pass1.runId, logPath, syncProposals: false, skipLock: true });
        assert.strictEqual(pass2.report.status, "completed");
        await assert.rejects(
          () => runner.run({ resumeRunId: pass1.runId, logPath, syncProposals: false, skipLock: true }),
          /not awaiting research/
        );
      } finally {
        fs.unlinkSync(resultFile);
      }
      fs.unlinkSync(logPath);
    });

    await test("a concurrent run (fresh or resumed) while one is already in flight is refused — the concurrency guard applies identically to resume", async () => {
      const logPath = tmpPath(".ndjson");
      const lockPath = tmpPath(".lock");
      const pass1 = await runner.run({ mode: "dry-run", runType: "daily", logPath, syncProposals: false, lockPath });
      const q = pass1.report.research.questionsPending[0];
      const resultFile = path.join(RESULTS_DIR, "resume-concurrency-test-temp.json");
      fs.writeFileSync(resultFile, JSON.stringify({
        findingKey: q.findingKey, question: q.question, source: "test", sourceType: "internal-repo-review",
        evidence: ["test evidence"], confidence: "high", limitations: "none", verdict: "supports-opportunity", recommendation: "test",
      }));
      try {
        const p1 = runner.run({ resumeRunId: pass1.runId, logPath, syncProposals: false, lockPath });
        const p2 = runner.run({ resumeRunId: pass1.runId, logPath, syncProposals: false, lockPath });
        const results = await Promise.allSettled([p1, p2]);
        const rejected = results.filter((r) => r.status === "rejected");
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        // Exactly one of these two concurrent resume attempts should
        // succeed; the other refused either by the concurrency lock OR
        // by "already finalized" (a legitimate race either way — the
        // key property is that NEITHER silently double-applies).
        assert.strictEqual(fulfilled.length, 1);
        assert.strictEqual(rejected.length, 1);
        const reason = rejected[0].reason;
        assert.ok(reason instanceof ConcurrentRunError || /not awaiting research/.test(reason.message));
      } finally {
        fs.unlinkSync(resultFile);
      }
      fs.unlinkSync(logPath);
    });
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
