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
// Crash-safety hotfix (diagnosing a real CI-only divergence between a
// Phase 14 execution's baseline and post-apply full-suite runs, where
// agent-research-freshness.test.js and several others started failing
// ONLY on the post-apply run, on a checkout with no real content
// change): scripts/run-tests.js's own PER_FILE_TIMEOUT_MS kills a
// slow/hung test file via `spawnSync(..., {timeout, killSignal:
// "SIGTERM"})` — and a JS `finally`/`Promise.finally` never runs when
// the process is signal-killed. Since withResearchResultsCleared()
// below renames the REAL, git-tracked agent/research/results/*.json
// files out of RESULTS_DIR for the duration of every test in this file,
// a SIGTERM (or SIGINT) arriving anywhere inside that window used to
// leave those real files permanently stranded in an orphaned temp
// directory — corrupting every later test (in THIS run and the next
// `npm test` invocation on the same checkout) that reads RESULTS_DIR
// via attachResearch()/loadResearchResults(). Proven with a disposable
// repro against a throwaway directory (never the real one): the file
// simply never came back after the kill. Fixed by additionally
// registering synchronous SIGTERM/SIGINT handlers that restore the
// stashed files before the process actually exits — see
// createFileStash()/withFilesStashedAndRestored() below, and the
// regression tests proving this mechanism directly.
//
// Run with:  node tests/agent-runner-resume.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
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

// Snapshots every `*.json` file in `dir`, renames them all aside into a
// fresh temp directory, and returns a `{ restore }` handle. `restore()`
// is idempotent (safe to call more than once, from more than one
// caller — the normal completion path AND a crash-signal handler can
// both legitimately race to call it) and never throws, even if some or
// all of the files were already restored.
function createFileStash(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-research-results-backup-"));
  for (const f of files) fs.renameSync(path.join(dir, f), path.join(backupDir, f));

  let restored = false;
  function restore() {
    if (restored) return;
    restored = true;
    for (const f of files) {
      const from = path.join(backupDir, f);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, f));
    }
    try {
      fs.rmdirSync(backupDir);
    } catch (e) {
      // Already removed, or non-empty from a partial failure above —
      // cleanup itself must never throw and mask the real result.
    }
  }
  return { restore };
}

// Stashes every `*.json` file in `dir` for the duration of `fn`,
// guaranteeing restoration via THREE independent paths: the normal
// `finally` (fn resolves or rejects), and a synchronous SIGTERM/SIGINT
// handler that restores before the process exits — the exact crash
// path a per-file test-runner timeout kill (scripts/run-tests.js's
// PER_FILE_TIMEOUT_MS) exercises, which a plain `finally` alone cannot
// survive. Listeners are removed once normal cleanup runs so they never
// leak onto whatever this test process does next.
function withFilesStashedAndRestored(dir, fn) {
  const stash = createFileStash(dir);
  const onCrashSignal = () => {
    stash.restore();
    process.exit(1);
  };
  process.once("SIGTERM", onCrashSignal);
  process.once("SIGINT", onCrashSignal);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.removeListener("SIGTERM", onCrashSignal);
      process.removeListener("SIGINT", onCrashSignal);
      stash.restore();
    });
}

function withResearchResultsCleared(fn) {
  return withFilesStashedAndRestored(RESULTS_DIR, fn);
}

// --- Crash-safety regression coverage for createFileStash()/
// withFilesStashedAndRestored() — exercised against a DISPOSABLE
// directory under os.tmpdir(), never the real RESULTS_DIR, so these
// tests can safely simulate a hard process kill. ------------------------

function makeDisposableJsonDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, "stub.json"), "{}", "utf8");
  return dir;
}

// A tiny child process that stashes `dir` via THIS file's own exported
// withFilesStashedAndRestored(), prints a sentinel the instant the
// stash (rename-out) has happened, then hangs forever — so the parent
// can deterministically wait for the stash to be in place (never a
// fixed sleep) before delivering a real OS signal, exactly mirroring
// how scripts/run-tests.js's PER_FILE_TIMEOUT_MS would SIGTERM a real
// slow/hung test file mid-run.
function crashSafetyChildScript(dir) {
  return `
    const { withFilesStashedAndRestored } = require(${JSON.stringify(__filename)});
    withFilesStashedAndRestored(${JSON.stringify(dir)}, () => {
      console.log("STASHED");
      return new Promise(() => {});
    });
  `;
}

function runCrashSafetyChild(dir, signal) {
  const child = spawn(process.execPath, ["-e", crashSafetyChildScript(dir)], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk;
      if (buf.includes("STASHED")) {
        child.stdout.removeListener("data", onData);
        child.kill(signal);
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

async function main() {
  await test("createFileStash(): restore() is idempotent — calling it a second time never throws and never corrupts the restored file", () => {
    const dir = makeDisposableJsonDir("crash-safety-idempotent-");
    try {
      const stash = createFileStash(dir);
      assert.deepStrictEqual(fs.readdirSync(dir), [], "expected the file to be stashed away");
      stash.restore();
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "expected the file restored after the first restore() call");
      stash.restore(); // must be a safe no-op the second time
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "a second restore() call must never throw, re-move, or duplicate the file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("withFilesStashedAndRestored(): a normal (non-throwing) callback restores the stashed file via the ordinary finally path", async () => {
    const dir = makeDisposableJsonDir("crash-safety-normal-");
    try {
      await withFilesStashedAndRestored(dir, async () => {
        assert.deepStrictEqual(fs.readdirSync(dir), [], "expected the file stashed away for the duration of the callback");
      });
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "expected the file restored after normal completion");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("withFilesStashedAndRestored(): a callback that throws still restores the stashed file, and the original error still propagates", async () => {
    const dir = makeDisposableJsonDir("crash-safety-throws-");
    try {
      await assert.rejects(
        () => withFilesStashedAndRestored(dir, async () => { throw new Error("simulated callback failure"); }),
        /simulated callback failure/
      );
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "expected the file restored even though the callback threw");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("withFilesStashedAndRestored(): a stashed file is restored before the process exits on SIGTERM — the exact mechanism scripts/run-tests.js's PER_FILE_TIMEOUT_MS uses to kill a slow/hung test file", async () => {
    // Windows cannot deliver a catchable SIGTERM to a child process at
    // all — Node.js on win32 hard-terminates the child outright,
    // bypassing any `process.on("SIGTERM", ...)` handler entirely
    // (confirmed empirically while writing this test: a handler that
    // simply logs and exits never fires there). This is a real, CI-
    // relevant (Linux/Ubuntu) code path, verified for real on any POSIX
    // platform — on Windows this is a platform limitation of the TEST,
    // not of the fix, so it's skipped rather than reported as a failure.
    if (process.platform === "win32") {
      console.log("  (skipped on win32 — Windows cannot deliver a catchable SIGTERM to a child process; this mechanism is verified for real on the Linux CI runner this suite actually targets)");
      return;
    }
    const dir = makeDisposableJsonDir("crash-safety-sigterm-");
    try {
      await runCrashSafetyChild(dir, "SIGTERM");
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "expected the stashed file restored before the SIGTERM-killed child process exited — this is the exact leak that corrupted RESULTS_DIR across baseline/post-apply runs");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("withFilesStashedAndRestored(): a stashed file is restored before the process exits on SIGINT", async () => {
    // Same win32 limitation as the SIGTERM test above — Windows does
    // not deliver a catchable SIGINT to a non-console child either.
    if (process.platform === "win32") {
      console.log("  (skipped on win32 — Windows cannot deliver a catchable SIGINT to a spawned child process; this mechanism is verified for real on the Linux CI runner this suite actually targets)");
      return;
    }
    const dir = makeDisposableJsonDir("crash-safety-sigint-");
    try {
      await runCrashSafetyChild(dir, "SIGINT");
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "expected the stashed file restored before the SIGINT-killed child process exited");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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

// Guards against this script running main() as a side effect of being
// require()'d — the crash-safety regression tests above spawn a CHILD
// process that requires THIS file by path to reach
// withFilesStashedAndRestored() directly (see crashSafetyChildScript()),
// which would otherwise re-run the entire real test suite (including
// the real RESULTS_DIR-clearing tests) inside that short-lived child.
if (require.main === module) {
  main();
}

module.exports = { createFileStash, withFilesStashedAndRestored, withResearchResultsCleared };
