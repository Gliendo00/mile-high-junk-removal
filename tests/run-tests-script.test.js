// Process-lifecycle hotfix — tests for scripts/run-tests.js's per-file
// progress logging, per-file timeout, and the timed-out-counts-as-
// failed aggregation logic. Added while diagnosing a real GitHub
// Actions cancellation: execute-proposal.js's own outer
// RUN_TESTS_TIMEOUT_MS bounds the WHOLE `npm test` invocation, but
// gave zero visibility into WHICH of the 151 files was actually stuck
// — this is what names it, and bounds it independently, in seconds
// rather than minutes.
//
// Never drops a fixture file into the real tests/ directory —
// runOneAtPath() is exercised directly against temp files under
// os.tmpdir(), so these tests can never accidentally add themselves
// (or a stray fixture) to the real suite's own file count.
//
// Run with:  node tests/run-tests-script.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runOneAtPath, main, PER_FILE_TIMEOUT_MS } = require("../scripts/run-tests");

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

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-script-test-"));
function writeFixture(name, source) {
  const full = path.join(TMP_DIR, name);
  fs.writeFileSync(full, source, "utf8");
  return full;
}

function captureConsoleLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (msg) => lines.push(String(msg));
  try {
    const result = fn();
    return { result, lines };
  } finally {
    console.log = original;
  }
}

// Liveness check that works the same way on POSIX and Windows:
// process.kill(pid, 0) sends no actual signal, just probes whether the
// pid is still addressable — throws ESRCH (POSIX) or a platform
// equivalent once the process is truly gone.
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

async function main_() {
  await test("a normal PASSING file is reported passed:true, not timed out, and logs START then PASS with its filename", () => {
    const full = writeFixture("passing.test.js", "process.exit(0);\n");
    const { result, lines } = captureConsoleLog(() => runOneAtPath(full, "passing.test.js"));
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.timedOut, false);
    assert.ok(lines.some((l) => l === "[tests] START passing.test.js"));
    assert.ok(lines.some((l) => /^\[tests\] PASS passing\.test\.js \([\d.]+s\)$/.test(l)));
  });

  await test("a normal FAILING file is reported passed:false, not timed out, and logs FAIL with its filename", () => {
    const full = writeFixture("failing.test.js", "process.exit(1);\n");
    const { result, lines } = captureConsoleLog(() => runOneAtPath(full, "failing.test.js"));
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.timedOut, false);
    assert.ok(lines.some((l) => /^\[tests\] FAIL failing\.test\.js \([\d.]+s\)$/.test(l)));
  });

  await test("a HANGING file is killed at the configured per-file timeout, reported passed:false/timedOut:true, and the TIMEOUT log line names the exact filename", () => {
    const full = writeFixture("hanging.test.js", "setTimeout(function(){}, 999999);\n");
    const start = Date.now();
    const { result, lines } = captureConsoleLog(() => runOneAtPath(full, "hanging.test.js", 300));
    const elapsedMs = Date.now() - start;
    assert.strictEqual(result.passed, false, "a timed-out file must count as a failed file, never ignored");
    assert.strictEqual(result.timedOut, true);
    assert.ok(elapsedMs < 5000, `expected the kill to happen close to the 300ms timeout, took ${elapsedMs}ms`);
    assert.ok(lines.some((l) => l === "[tests] START hanging.test.js"));
    assert.ok(lines.some((l) => /^\[tests\] TIMEOUT hanging\.test\.js \([\d.]+s\)$/.test(l)), `expected a TIMEOUT line naming the exact file, got:\n${lines.join("\n")}`);
    // Never a PASS/FAIL line for the same file once it timed out.
    assert.ok(!lines.some((l) => /^\[tests\] (PASS|FAIL) hanging\.test\.js/.test(l)));
  });

  await test("no lingering child process survives a timed-out file — the spawned pid is no longer alive shortly after the kill", async () => {
    const full = writeFixture("hanging2.test.js", "setTimeout(function(){}, 999999);\n");
    // Can't observe the pid from runOneAtPath()'s own return value (it
    // doesn't expose it), so this drives spawnSync's underlying
    // mechanism directly with the exact same options, to confirm the
    // process this module relies on genuinely does not survive.
    const { spawnSync } = require("child_process");
    const result = spawnSync(process.execPath, [full], { encoding: "utf8", timeout: 300, killSignal: "SIGTERM" });
    assert.ok(result.pid, "expected spawnSync to report a pid for the killed child");
    // Give the OS a brief moment to finish reaping after the kill signal.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.strictEqual(isPidAlive(result.pid), false, `expected pid ${result.pid} to no longer be alive after being killed for timing out`);
  });

  await test("main() aggregation: a timed-out file counts as FAILED (never silently excused), and the suite continues processing every remaining file rather than stopping", () => {
    const fakeFiles = ["a.test.js", "b-hangs.test.js", "c.test.js"];
    const fakeRunOne = (file) => {
      if (file === "b-hangs.test.js") return { file, passed: false, timedOut: true, stdout: "", stderr: "" };
      return { file, passed: true, timedOut: false, stdout: "", stderr: "" };
    };
    const { result, lines } = captureConsoleLog(() => main({ listTestFilesFn: () => fakeFiles, runOneFn: fakeRunOne }));

    assert.strictEqual(result.results.length, 3, "all 3 files must be processed — a timeout in the middle must not stop the suite early");
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].file, "b-hangs.test.js");
    assert.ok(lines.some((l) => l === "TIMEOUT - b-hangs.test.js"), `expected the per-file summary line to say TIMEOUT, got:\n${lines.join("\n")}`);
    assert.ok(lines.some((l) => l.includes("2/3 test files passed.")));
    assert.ok(lines.some((l) => l === "Failed: b-hangs.test.js"));
    assert.strictEqual(process.exitCode, 1, "a timed-out file must set a non-zero exit code like any other failure");
    process.exitCode = 0; // reset — this is main()'s own side effect, not this test file's real outcome
  });

  await test("PER_FILE_TIMEOUT_MS leaves real headroom above this repo's slowest observed real test file (~27s, tests/github-actions-safe-commit.test.js) but is still far shorter than the outer 6-minute suite timeout", () => {
    assert.ok(PER_FILE_TIMEOUT_MS >= 60 * 1000, "must leave comfortable margin above a legitimately slow ~27s file to avoid false positives");
    assert.ok(PER_FILE_TIMEOUT_MS <= 3 * 60 * 1000, "must still be well short of the outer 6-minute suite timeout so a hang is named quickly");
  });

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main_().finally(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});
