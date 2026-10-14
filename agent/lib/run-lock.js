// Site Improvement Agent, Phase 5 — concurrency guard.
//
// A file-based lock so two runs (e.g. a manual run started while a
// scheduled one is already in flight) can never interleave their reads/
// writes of agent/history/log.ndjson or apply a mechanical fix while
// another run is also mid-apply. See agent/README.md's "Scheduling
// architecture" section: this is the actual mechanism backing that
// section's "concurrency protection" requirement — a plain git-tracked-
// sibling file, not a new database table or service, matching this
// project's existing files/git-first convention (history.js, the
// research-rotation state file).
//
// The lock file (agent/history/.run.lock, NOT git-tracked — see
// .gitignore) is NEVER committed; it only exists for the lifetime of one
// in-progress run on one machine. A stale lock (the process that created
// it crashed without cleaning up) is treated as expired after
// STALE_AFTER_MS so a single crashed run can't permanently wedge every
// future run — see agent/README.md's failure-safety section.

const fs = require("fs");
const path = require("path");
const config = require("../config");

const DEFAULT_LOCK_PATH = path.join(config.SITE_ROOT, "agent", "history", ".run.lock");
const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours — generous for a scan+research-wait, short enough to self-heal

class ConcurrentRunError extends Error {
  constructor(existingLock) {
    super(`Another Site Improvement Agent run appears to already be in progress (runId ${existingLock.runId}, started ${existingLock.startedAt}). Refusing to start a second run.`);
    this.name = "ConcurrentRunError";
    this.existingLock = existingLock;
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (e) {
    return null;
  }
}

function isStale(lock, now = new Date()) {
  if (!lock || !lock.startedAt) return true;
  const started = new Date(lock.startedAt).getTime();
  if (Number.isNaN(started)) return true;
  return now.getTime() - started > STALE_AFTER_MS;
}

/**
 * Throws ConcurrentRunError if a non-stale lock already exists. Otherwise
 * writes a fresh lock and returns a `release()` function the caller MUST
 * call in a `finally` block.
 */
function acquireLock(runId, lockPath = DEFAULT_LOCK_PATH) {
  const existing = readLock(lockPath);
  if (existing && !isStale(existing)) {
    throw new ConcurrentRunError(existing);
  }

  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ runId, pid: process.pid, startedAt: new Date().toISOString() }), "utf8");

  return function release() {
    try {
      const current = readLock(lockPath);
      // Only remove the lock if it's still ours — a stale lock we
      // overwrote-by-starting-anyway shouldn't let us delete a NEWER
      // run's lock out from under it in some pathological race.
      if (current && current.runId === runId) {
        fs.unlinkSync(lockPath);
      }
    } catch (e) {
      // Best-effort cleanup — a failure to remove the lock file is not
      // itself a reason to fail the run; the next run will see it's
      // stale (if truly abandoned) after STALE_AFTER_MS.
    }
  };
}

module.exports = { acquireLock, ConcurrentRunError, DEFAULT_LOCK_PATH, STALE_AFTER_MS, isStale, readLock };
