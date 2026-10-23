#!/usr/bin/env node
// Aggregate test runner — this repo has no test framework (jest/mocha);
// every file under tests/*.test.js is a self-contained Node script using
// `assert` + a local `test()` helper, historically run one at a time
// ("Run with: node tests/<file>.test.js" — see any test file's own
// header) and tallied up by hand for each phase's README writeup ("Full
// repository suite: 135 files, 134 passing").
//
// This script formalizes that into one command (`npm test`) so it can be
// automated: Site Improvement Agent Phase 14's execution engine
// (agent/lib/execute-proposal.js) runs this before allowing a commit to
// be pushed, per the "run the relevant validation/tests, never push a
// broken change" requirement. Runs every tests/*.test.js file in its own
// `node` process (exactly as each file's own header already documents),
// collects each one's exit code, prints a pass/fail summary, and exits
// non-zero if anything failed.
//
// Process-lifecycle hardening (diagnosing a real GitHub Actions
// cancellation on proposal 6ad71748-...: execute-proposal.js's own
// outer RUN_TESTS_TIMEOUT_MS bounds the WHOLE `npm test` invocation,
// but gave no visibility into WHICH of the 151 files was actually
// stuck, and nothing stopped one hanging file from silently consuming
// the entire outer budget on its own) — every file now gets:
//   - a `[tests] START <file>` / `PASS`/`FAIL`/`TIMEOUT <file> (<Ns>)`
//     progress line (minimal: phase + filename + duration only, never
//     raw per-test-file output inline with these lines)
//   - its own bounded per-file timeout (PER_FILE_TIMEOUT_MS below),
//     independent of and much smaller than execute-proposal.js's outer
//     suite-level bound, so ONE hanging file is named and killed in
//     seconds, not left to exhaust the whole outer timeout anonymously
// A timed-out file counts as a FAILED file, exactly like a non-zero
// exit — never silently skipped or excused.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TESTS_DIR = path.join(__dirname, "..", "tests");

// This repo's entire 151-file suite measures ~65-150s locally
// (environment-dependent — most files complete in well under a
// second, but a handful of genuinely heavier integration tests that
// spin up real temp git repos and run several real `git`/`node`
// subprocess calls per case, e.g. tests/github-actions-safe-commit.
// test.js, were observed taking up to ~27s on their own while tuning
// this value). 90 seconds per file leaves ample margin above that
// (3x+) to avoid a false TIMEOUT on a legitimately-slow-but-working
// file, while still being drastically faster than the alternative of
// silently burning through execute-proposal.js's own outer
// RUN_TESTS_TIMEOUT_MS (6 minutes) with no visibility into which file
// was actually stuck — a GENUINE hang (an indefinite wait, not just
// real work taking real time) will still exceed 90s easily.
const PER_FILE_TIMEOUT_MS = 90 * 1000;

// Printed output (for a FAILED or TIMED-OUT file only — a passing
// file's stdout/stderr is never printed at all) is capped so a test
// whose own failure output happens to be huge (a large assertion diff,
// or partial output from a file that was mid-write when killed for
// timing out) can never flood the log — "no secrets, no unrestricted
// raw output," not just for the new progress lines but for this
// pre-existing failure-detail dump too.
const MAX_PRINTED_OUTPUT = 4000;

function truncate(text) {
  const s = String(text || "");
  return s.length > MAX_PRINTED_OUTPUT ? `${s.slice(0, MAX_PRINTED_OUTPUT)}\n…(truncated)` : s;
}

function listTestFiles() {
  return fs
    .readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .sort();
}

// The actual child-process launch + per-file timeout, factored out
// from runOne() so tests can exercise it directly against an arbitrary
// temp file (never needing to drop a fixture into the real TESTS_DIR
// to prove PASS/FAIL/TIMEOUT behavior), and so a test can inject a
// short `timeoutMs` to prove the TIMEOUT path fires without waiting
// out the real 30-second default.
function runOneAtPath(fullPath, displayName, timeoutMs = PER_FILE_TIMEOUT_MS) {
  console.log(`[tests] START ${displayName}`);
  const start = Date.now();
  const result = spawnSync(process.execPath, [fullPath], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  const durationS = ((Date.now() - start) / 1000).toFixed(1);
  // spawnSync does NOT make a timeout kill distinguishable via
  // `result.status` alone (it's `null` either way once killed) —
  // `result.error.code === "ETIMEDOUT"` is the real, empirically-
  // confirmed signal (same pattern execute-proposal.js's own
  // RUN_TESTS_TIMEOUT_MS hotfix already established for execFileSync).
  // spawnSync's own `timeout` option sends `killSignal` directly to
  // the spawned child, which terminates THAT process within the
  // configured window — confirmed empirically elapsed time matches the
  // timeout almost exactly, not the full child_process default. If a
  // test file's own code further spawns an unawaited descendant of its
  // own, that descendant isn't covered by this signal (a known
  // boundary, not silently assumed away) — but every test file in this
  // repo was independently confirmed (by grep, while diagnosing this
  // issue) to only ever use synchronous child_process calls
  // (execSync/execFileSync), so this is not a gap against anything
  // that actually exists in tests/ today.
  const timedOut = Boolean(result.error && result.error.code === "ETIMEDOUT");
  const passed = !timedOut && result.status === 0;
  if (timedOut) {
    console.log(`[tests] TIMEOUT ${displayName} (${durationS}s)`);
  } else if (passed) {
    console.log(`[tests] PASS ${displayName} (${durationS}s)`);
  } else {
    console.log(`[tests] FAIL ${displayName} (${durationS}s)`);
  }
  return { file: displayName, passed, timedOut, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function runOne(file) {
  return runOneAtPath(path.join(TESTS_DIR, file), file);
}

// `listTestFilesFn`/`runOneFn` are injectable purely for testing the
// aggregation/exit-code logic below (a timed-out file counting as a
// failure, the suite continuing past it rather than stopping, the
// printed "Failed: ..." line naming it) without touching the real
// tests/ directory or waiting out a real timeout.
function main({ listTestFilesFn = listTestFiles, runOneFn = runOne } = {}) {
  const files = listTestFilesFn();
  const results = files.map(runOneFn);
  const failed = results.filter((r) => !r.passed);

  for (const r of results) {
    const label = r.timedOut ? "TIMEOUT" : r.passed ? "PASS" : "FAIL";
    console.log(`${label} - ${r.file}`);
    if (!r.passed) {
      process.stdout.write(truncate(r.stdout));
      process.stderr.write(truncate(r.stderr));
    }
  }

  console.log("");
  console.log(`${results.length - failed.length}/${results.length} test files passed.`);
  if (failed.length) {
    console.log(`Failed: ${failed.map((r) => r.file).join(", ")}`);
    process.exitCode = 1;
  }
  return { results, failed };
}

// Guards against this script running `main()` as a side effect of
// being `require()`'d (as the new test suite below does, to test
// `runOneAtPath`/`main` directly) — without this, requiring the module
// re-runs the ENTIRE real test suite immediately, which is exactly the
// footgun that was hit once already while diagnosing this very issue.
if (require.main === module) {
  main();
}

module.exports = { listTestFiles, runOne, runOneAtPath, main, PER_FILE_TIMEOUT_MS, MAX_PRINTED_OUTPUT, truncate };
