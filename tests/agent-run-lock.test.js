// Site Improvement Agent, Phase 5 — concurrency guard (agent/lib/run-lock.js).
// Proves: a second run while one is in flight is refused (not silently
// interleaved), release() lets a later run proceed, a stale lock (older
// than STALE_AFTER_MS — left behind by a crashed process) is NOT treated
// as blocking, and release() only ever removes a lock it actually owns.
//
// Run with:  node tests/agent-run-lock.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { acquireLock, ConcurrentRunError, isStale, readLock } = require("../agent/lib/run-lock");

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

function tmpLockPath() {
  return path.join(os.tmpdir(), `agent-lock-test-${process.pid}-${Math.random().toString(36).slice(2)}.lock`);
}

test("acquireLock() succeeds when no lock file exists, and writes a lock file others can see", () => {
  const lockPath = tmpLockPath();
  const release = acquireLock("run-1", lockPath);
  assert.ok(fs.existsSync(lockPath));
  const lock = readLock(lockPath);
  assert.strictEqual(lock.runId, "run-1");
  release();
});

test("a second acquireLock() while the first is still held throws ConcurrentRunError, never silently proceeds", () => {
  const lockPath = tmpLockPath();
  const release = acquireLock("run-1", lockPath);
  try {
    assert.throws(() => acquireLock("run-2", lockPath), ConcurrentRunError);
  } finally {
    release();
  }
});

test("release() removes the lock, letting a subsequent acquireLock() succeed", () => {
  const lockPath = tmpLockPath();
  const release1 = acquireLock("run-1", lockPath);
  release1();
  assert.ok(!fs.existsSync(lockPath));
  const release2 = acquireLock("run-2", lockPath);
  release2();
});

test("a stale lock (older than the self-heal window) is NOT treated as blocking — a single crashed run can't wedge every future run forever", () => {
  const lockPath = tmpLockPath();
  fs.writeFileSync(lockPath, JSON.stringify({ runId: "crashed-run", pid: 1, startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }));
  assert.strictEqual(isStale(readLock(lockPath)), true);
  const release = acquireLock("run-2", lockPath); // must not throw
  release();
});

test("a lock with a missing/invalid startedAt is treated as stale (fails safe toward allowing a run, not toward wedging forever)", () => {
  assert.strictEqual(isStale({ runId: "x" }), true);
  assert.strictEqual(isStale({ runId: "x", startedAt: "not-a-date" }), true);
  assert.strictEqual(isStale(null), true);
});

test("release() only removes a lock it actually owns — overwriting a stale lock by starting anyway never deletes a DIFFERENT, newer run's lock out from under it", () => {
  const lockPath = tmpLockPath();
  // run-1's lock goes stale...
  fs.writeFileSync(lockPath, JSON.stringify({ runId: "run-1", pid: 1, startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }));
  const release1 = acquireLock("run-1-retry-never-called", lockPath); // simulate run-1's own stale release handle being unused
  // ...meanwhile a legitimate new run (run-2) starts, since run-1's lock was stale.
  release1(); // this release call belongs to a DIFFERENT runId than what's now in the file conceptually — but acquireLock() just wrote run-1-retry-never-called, so this IS the current owner; simulate the real race instead:
  const release2 = acquireLock("run-2", lockPath);
  fs.writeFileSync(lockPath, JSON.stringify({ runId: "run-3-raced-in", pid: 2, startedAt: new Date().toISOString() }));
  release2(); // release2 thinks it owns run-2's lock, but the file now says run-3-raced-in
  const lock = readLock(lockPath);
  assert.strictEqual(lock.runId, "run-3-raced-in", "release() must never delete a lock file it doesn't recognize as its own");
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
