// Site Improvement Agent, Phase 5 — integration tests for runner.js's new
// behavior layered on top of the Phase 1-4 pipeline (tests/agent-runner.
// test.js already covers that underlying pipeline and is left
// untouched): run type, the persisted `report`, weekly rotation
// persistence, concurrent-run protection, and honest failure recording.
//
// Same "real site content, read-only, throwaway log path" convention as
// tests/agent-runner.test.js — never writes to the real committed
// agent/history/log.ndjson or agent/history/research-rotation-state.json.
//
// Run with:  node tests/agent-runner-phase5.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const runner = require("../agent/runner");
const history = require("../agent/lib/history");
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
  return path.join(os.tmpdir(), `agent-runner-phase5-${process.pid}-${Math.random().toString(36).slice(2)}${suffix}`);
}

async function main() {
  await test("a 'daily' run persists runType:'daily' and a report with a daily-appropriate nextReviewHint", async () => {
    const logPath = tmpPath(".ndjson");
    const record = await runner.run({ mode: "dry-run", runType: "daily", logPath, syncProposals: false, skipLock: true });
    assert.strictEqual(record.runType, "daily");
    assert.ok(record.report);
    assert.strictEqual(record.report.runType, "daily");
    assert.ok(/weekly deep-research run/.test(record.report.nextReviewHint));
    fs.unlinkSync(logPath);
  });

  await test("an unrecognized/omitted runType defaults to 'manual' — back-compatible with every pre-Phase-5 caller that never passed one", async () => {
    const logPath = tmpPath(".ndjson");
    const record = await runner.run({ mode: "dry-run", logPath, syncProposals: false, skipLock: true });
    assert.strictEqual(record.runType, "manual");
    fs.unlinkSync(logPath);
  });

  await test("a 'weekly' run computes rotation priorities, includes them in the report, and persists rotation state to the given path", async () => {
    const logPath = tmpPath(".ndjson");
    const rotationStatePath = tmpPath(".rotation.json");
    const record = await runner.run({
      mode: "dry-run",
      runType: "weekly",
      logPath,
      syncProposals: false,
      skipLock: true,
      rotationStatePath,
      rotationLimit: 2,
    });
    assert.strictEqual(record.runType, "weekly");
    assert.ok(record.report.rotation);
    assert.strictEqual(record.report.rotation.picks.length, 2);
    assert.ok(fs.existsSync(rotationStatePath), "weekly run must persist rotation state so next week's run sees it");
    const persisted = JSON.parse(fs.readFileSync(rotationStatePath, "utf8"));
    for (const pick of record.report.rotation.picks) {
      assert.ok(persisted.byCitySlug[pick.slug], `expected ${pick.slug} to be marked reviewed in the persisted rotation state`);
    }
    fs.unlinkSync(logPath);
    fs.unlinkSync(rotationStatePath);
  });

  await test("a weekly run with persistRotationState:false computes picks but does NOT write rotation state (useful for a dry preview)", async () => {
    const logPath = tmpPath(".ndjson");
    const rotationStatePath = tmpPath(".rotation.json");
    const record = await runner.run({
      mode: "dry-run",
      runType: "weekly",
      logPath,
      syncProposals: false,
      skipLock: true,
      rotationStatePath,
      persistRotationState: false,
    });
    assert.ok(record.report.rotation);
    assert.ok(!fs.existsSync(rotationStatePath));
    fs.unlinkSync(logPath);
  });

  await test("two overlapping runs (second started before the first releases its lock) — the second is refused with ConcurrentRunError, the log never shows interleaved writes", async () => {
    const logPath = tmpPath(".ndjson");
    const lockPath = tmpPath(".lock");
    const p1 = runner.run({ mode: "dry-run", runType: "daily", logPath, syncProposals: false, lockPath });
    const p2 = runner.run({ mode: "dry-run", runType: "daily", logPath, syncProposals: false, lockPath });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.strictEqual(fulfilled.length, 1, "exactly one of the two overlapping runs should succeed");
    assert.strictEqual(rejected.length, 1, "exactly one should be refused");
    assert.ok(rejected[0].reason instanceof ConcurrentRunError);

    const allRuns = history.readAllRuns(logPath);
    assert.strictEqual(allRuns.length, 1, "only the successful run should have appended to history — the refused one never got that far");
    fs.unlinkSync(logPath);
  });

  await test("after a run completes, a later run can acquire the lock again without issue", async () => {
    const logPath = tmpPath(".ndjson");
    const lockPath = tmpPath(".lock");
    await runner.run({ mode: "dry-run", logPath, syncProposals: false, lockPath });
    // Must not throw ConcurrentRunError — the first run's `finally` block released the lock.
    const record = await runner.run({ mode: "dry-run", logPath, syncProposals: false, lockPath });
    assert.ok(record.runId);
    fs.unlinkSync(logPath);
  });

  await test("a failed run is recorded with failed:true, a 'failed' healthSummary, and NEVER a record that looks like a successful empty run — and the thrown error carries the recorded failure for the CLI to surface", async () => {
    const logPath = tmpPath(".ndjson");
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = function (...args) {
      if (typeof args[0] === "string" && args[0].replace(/\\/g, "/").endsWith("/milehighjunkremovalsite/site")) {
        throw new Error("simulated scan failure for this test");
      }
      return originalReaddirSync.apply(fs, args);
    };
    try {
      await assert.rejects(
        () => runner.run({ mode: "dry-run", runType: "daily", logPath, syncProposals: false, skipLock: true }),
        (err) => {
          assert.ok(err.recordedFailure);
          assert.strictEqual(err.recordedFailure.failed, true);
          assert.strictEqual(err.recordedFailure.report.healthSummary.status, "failed");
          return true;
        }
      );
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
    const allRuns = history.readAllRuns(logPath);
    assert.strictEqual(allRuns.length, 1);
    assert.strictEqual(allRuns[0].failed, true);
    fs.unlinkSync(logPath);
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
