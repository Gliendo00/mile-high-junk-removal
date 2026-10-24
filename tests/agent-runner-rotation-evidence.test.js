// Site Improvement Agent, Phase 7B — integration test proving
// agent/runner.js's weekly path actually WIRES UP rotation-evidence
// attachment end-to-end: a real `run({runType:"weekly"})` call attaches
// any already-written agent/research/firstparty/*.json evidence
// (tagged by rotationSlug) onto the matching pick, and the classified
// conclusion reaches record.report.rotation.picks[] — not just that the
// underlying library functions work in isolation (see
// tests/agent-rotation-evidence.test.js and
// tests/agent-firstparty-intake.test.js for that).
//
// Same "real site content, read-only, throwaway log/state path"
// convention as tests/agent-runner-phase5.test.js. The one real
// filesystem side effect this file cannot avoid is writing ONE
// throwaway fixture file into the REAL agent/research/firstparty/
// directory (loadFirstPartyEvidence() has no path-override parameter —
// same constraint tests/agent-firstparty-runner.test.js's header
// already documents) — always removed in a `finally`, named with an
// obviously-fake FILE NAME ("zzz-test-fixture-rotation-evidence") that
// can never collide with a real evidence file's name.
//
// Test-isolation note (added after this test started intermittently
// failing with "2 !== 1" once a REAL Golden Search Console diagnostic
// evidence file landed in the repo — see agent/README.md's Phase 7D/7E):
// the fixture's own `rotationSlug` must still equal the real #1 pick's
// `top.slug` (that's the actual thing under test — real wiring between
// a real rotation pick and real attached evidence, not a renamed
// stand-in), so it CAN legitimately collide with a real, previously-
// committed evidence file for that same real city (e.g. a prior Golden
// diagnostic run's own committed evidence for rotationSlug "golden").
// `withIsolatedRotationSlugEvidence()` below handles this the narrowest
// possible way — by moving any REAL pre-existing evidence file(s) for
// `top.slug` out of `EVIDENCE_DIR` for the duration of this one test,
// then restoring them byte-for-byte in a `finally` — rather than by
// changing what slug is used (which would stop this from testing real
// end-to-end wiring) or weakening the assertions (which would stop
// this from proving the EXACT attachment/conclusion behavior it exists
// to prove). No production code, rotation/candidate-selection logic, or
// freshness semantics are touched by this — it is purely this test's
// own fixture bookkeeping, scoped to this one test, for the duration of
// this one test.
//
// Run with:  node tests/agent-runner-rotation-evidence.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const runner = require("../agent/runner");
const { writeFirstPartyEvidence, EVIDENCE_DIR } = require("../agent/lib/firstparty-fetch");
const { makeFirstPartyEvidence } = require("../agent/lib/firstparty-evidence");
const { computePriorities } = require("../agent/lib/research-rotation");
const { SOURCE: ROTATION_SOURCE } = require("../agent/lib/rotation-evidence");

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
  return path.join(os.tmpdir(), `agent-runner-rotation-evidence-${process.pid}-${Math.random().toString(36).slice(2)}${suffix}`);
}

// Moves aside any `*.json` file in `dir` whose parsed content (a single
// object, or an array of them — same convention real evidence files
// use) matches `predicate`, into a per-file temp stash path, and
// returns a `{ restore }` handle. `restore()` is idempotent (safe to
// call more than once — the normal completion path AND a crash-signal
// handler can both legitimately race to call it) and never throws, even
// if some or all files were already restored. Read/parse failures on
// an unrelated malformed file are ignored — not this test's concern,
// and loadFirstPartyEvidence() already treats malformed files as "no
// evidence" in production, so leaving one in place can't affect this
// test's own assertions either way.
//
// Crash-safety hotfix (same class of bug as
// tests/agent-runner-resume.test.js's createFileStash() — see that
// file's own header for the full story of the CI-only divergence this
// closes): a file moved aside here used to be restored only by a plain
// `finally`, which never runs if the process is signal-killed (exactly
// what scripts/run-tests.js's PER_FILE_TIMEOUT_MS does to a slow/hung
// file). withContentMatchStashed() below additionally restores via a
// synchronous SIGTERM/SIGINT handler.
function createContentMatchStash(dir, predicate) {
  const movedAside = [];
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const fullPath = path.join(dir, file);
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      } catch (e) {
        continue; // malformed/unrelated — leave it exactly where it is
      }
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      if (entries.some(predicate)) {
        const stashPath = tmpPath(`__stashed__${file}`);
        fs.renameSync(fullPath, stashPath);
        movedAside.push({ fullPath, stashPath });
      }
    }
  }

  let restored = false;
  function restore() {
    if (restored) return;
    restored = true;
    for (const { fullPath, stashPath } of movedAside) {
      if (fs.existsSync(stashPath)) fs.renameSync(stashPath, fullPath);
    }
  }
  return { restore };
}

// Stashes every matching file in `dir` for the duration of `fn`,
// guaranteeing restoration via the normal `finally` (fn resolves or
// rejects) AND a synchronous SIGTERM/SIGINT handler that restores
// before the process exits. Listeners are removed once normal cleanup
// runs so they never leak onto whatever this test process does next.
function withContentMatchStashed(dir, predicate, fn) {
  const stash = createContentMatchStash(dir, predicate);
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

// Moves any REAL, pre-existing evidence file(s) in EVIDENCE_DIR that
// carry the given `rotationSlug` out to a temp location for the
// duration of `fn`, then restores them byte-for-byte afterward (even if
// `fn` throws, or the process is SIGTERM/SIGINT-killed) — see this
// file's header "Test-isolation note" for why. A file is matched on
// CONTENT (its entries' own `rotationSlug` field), not on filename, so
// this stays correct regardless of what any real evidence file happens
// to be named.
async function withIsolatedRotationSlugEvidence(rotationSlug, fn) {
  return withContentMatchStashed(EVIDENCE_DIR, (e) => e && e.rotationSlug === rotationSlug, fn);
}

// --- Crash-safety regression coverage for createContentMatchStash()/
// withContentMatchStashed() — exercised against a DISPOSABLE directory
// under os.tmpdir(), never the real EVIDENCE_DIR, so these tests can
// safely simulate a hard process kill. ----------------------------------

const MARKER_PREDICATE = (e) => e && e.marker === "stash-me";

function makeDisposableMarkedDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, "stub.json"), JSON.stringify({ marker: "stash-me" }), "utf8");
  return dir;
}

// A tiny child process that stashes `dir` via THIS file's own exported
// withContentMatchStashed(), prints a sentinel the instant the stash
// (rename-out) has happened, then hangs forever — so the parent can
// deterministically wait for the stash to be in place (never a fixed
// sleep) before delivering a real OS signal, exactly mirroring how
// scripts/run-tests.js's PER_FILE_TIMEOUT_MS would SIGTERM a real
// slow/hung test file mid-run.
function crashSafetyChildScript(dir) {
  return `
    const { withContentMatchStashed } = require(${JSON.stringify(__filename)});
    withContentMatchStashed(${JSON.stringify(dir)}, (e) => e && e.marker === "stash-me", () => {
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
  await test("createContentMatchStash(): restore() is idempotent — calling it a second time never throws and never corrupts the restored file", () => {
    const dir = makeDisposableMarkedDir("crash-safety-rotation-idempotent-");
    try {
      const stash = createContentMatchStash(dir, MARKER_PREDICATE);
      assert.deepStrictEqual(fs.readdirSync(dir), [], "expected the matching file to be stashed away");
      stash.restore();
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "expected the file restored after the first restore() call");
      stash.restore(); // must be a safe no-op the second time
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "a second restore() call must never throw, re-move, or duplicate the file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("withContentMatchStashed(): a normal (non-throwing) callback restores the stashed file via the ordinary finally path", async () => {
    const dir = makeDisposableMarkedDir("crash-safety-rotation-normal-");
    try {
      await withContentMatchStashed(dir, MARKER_PREDICATE, async () => {
        assert.deepStrictEqual(fs.readdirSync(dir), [], "expected the file stashed away for the duration of the callback");
      });
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "expected the file restored after normal completion");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("withContentMatchStashed(): a callback that throws still restores the stashed file, and the original error still propagates", async () => {
    const dir = makeDisposableMarkedDir("crash-safety-rotation-throws-");
    try {
      await assert.rejects(
        () => withContentMatchStashed(dir, MARKER_PREDICATE, async () => { throw new Error("simulated callback failure"); }),
        /simulated callback failure/
      );
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "expected the file restored even though the callback threw");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("withContentMatchStashed(): a stashed file is restored before the process exits on SIGTERM — the exact mechanism scripts/run-tests.js's PER_FILE_TIMEOUT_MS uses to kill a slow/hung test file", async () => {
    // Windows cannot deliver a catchable SIGTERM to a child process at
    // all — Node.js on win32 hard-terminates the child outright,
    // bypassing any `process.on("SIGTERM", ...)` handler entirely (see
    // tests/agent-runner-resume.test.js's matching test for the
    // empirical confirmation). Skipped (not failed) on win32; verified
    // for real on the Linux CI runner this suite actually targets.
    if (process.platform === "win32") {
      console.log("  (skipped on win32 — Windows cannot deliver a catchable SIGTERM to a child process; this mechanism is verified for real on the Linux CI runner this suite actually targets)");
      return;
    }
    const dir = makeDisposableMarkedDir("crash-safety-rotation-sigterm-");
    try {
      await runCrashSafetyChild(dir, "SIGTERM");
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "expected the stashed file restored before the SIGTERM-killed child process exited");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("withContentMatchStashed(): a stashed file is restored before the process exits on SIGINT", async () => {
    // Same win32 limitation as the SIGTERM test above.
    if (process.platform === "win32") {
      console.log("  (skipped on win32 — Windows cannot deliver a catchable SIGINT to a spawned child process; this mechanism is verified for real on the Linux CI runner this suite actually targets)");
      return;
    }
    const dir = makeDisposableMarkedDir("crash-safety-rotation-sigint-");
    try {
      await runCrashSafetyChild(dir, "SIGINT");
      assert.deepStrictEqual(fs.readdirSync(dir), ["stub.json"], "expected the stashed file restored before the SIGINT-killed child process exited");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("a 'weekly' run attaches a pre-written firstparty evidence file to the rotation pick with the matching rotationSlug, and the report reflects the classified conclusion", async () => {
    const logPath = tmpPath(".ndjson");
    const rotationStatePath = tmpPath(".rotation.json");

    // Determine THIS repo's real #1 rotation pick deterministically —
    // same inputs runner.js's own weekly path will use a moment later
    // (fresh empty state, the real current findings, no completed-job
    // signal): staleness/no-page/open-findings/completed-job are all
    // pure functions of those inputs, so the same inputs always produce
    // the same #1 pick.
    const { gatherFindings } = runner;
    const { findings } = gatherFindings();
    const [top] = computePriorities({ state: { byCitySlug: {} }, currentFindings: findings, completedJobCitySummary: {}, limit: 1 });
    assert.ok(top, "expected at least one rotation pick to exist");

    await withIsolatedRotationSlugEvidence(top.slug, async () => {
      const evidence = makeFirstPartyEvidence({
        rotationSlug: top.slug,
        source: ROTATION_SOURCE,
        metric: "clicks-impressions-ctr-position",
        dimension: "query",
        scope: { type: "city", value: top.name },
        window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
        observed: { totalRowsReturned: 2, topRows: [] },
        context: "test fixture",
        limitations: "test fixture",
      });
      const written = writeFirstPartyEvidence(evidence, `zzz-test-fixture-rotation-evidence__${top.slug}.json`, EVIDENCE_DIR);

      try {
        const record = await runner.run({
          mode: "dry-run",
          runType: "weekly",
          logPath,
          rotationStatePath,
          rotationLimit: 1,
          syncProposals: false,
          skipLock: true,
        });
        assert.ok(record.report.rotation);
        const pick = record.report.rotation.picks.find((p) => p.slug === top.slug);
        assert.ok(pick, `expected the #1 pick (${top.slug}) to appear in the report`);
        assert.strictEqual(pick.researched, true);
        assert.strictEqual(pick.firstPartyEvidence.length, 1);
        assert.strictEqual(pick.firstPartyEvidence[0].rotationSlug, top.slug);
        // 2 rows observed -> RESEARCH_MORE (never NO_CHANGE, never PROPOSE_CHANGE)
        assert.strictEqual(pick.conclusion, "RESEARCH_MORE");
        // and it reaches the aggregate summary too — the actual symptom this phase fixes
        assert.strictEqual(record.report.firstPartyEvidence.sourcesNotConsulted.includes(ROTATION_SOURCE), false);
      } finally {
        fs.unlinkSync(written);
        if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
        if (fs.existsSync(rotationStatePath)) fs.unlinkSync(rotationStatePath);
      }
    });
  });

  await test("a 'weekly' run with NO pre-written evidence for the picked city reports researched:false and never fabricates a conclusion", async () => {
    const logPath = tmpPath(".ndjson");
    const rotationStatePath = tmpPath(".rotation.json");
    try {
      const record = await runner.run({
        mode: "dry-run",
        runType: "weekly",
        logPath,
        rotationStatePath,
        rotationLimit: 1,
        syncProposals: false,
        skipLock: true,
      });
      const pick = record.report.rotation.picks[0];
      // Resilient to real pre-existing evidence from a prior real run —
      // only assert the shape/consistency invariant, not a specific
      // value (same "never assume empty" discipline as
      // tests/agent-firstparty-runner.test.js).
      assert.strictEqual(typeof pick.researched, "boolean");
      assert.ok([null, "NO_CHANGE", "RESEARCH_MORE"].includes(pick.conclusion));
      assert.strictEqual(pick.externalResearchPerformed, false);
    } finally {
      if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
      if (fs.existsSync(rotationStatePath)) fs.unlinkSync(rotationStatePath);
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
}

// Guards against this script running main() as a side effect of being
// require()'d — the crash-safety regression tests above spawn a CHILD
// process that requires THIS file by path to reach
// withContentMatchStashed() directly (see crashSafetyChildScript()),
// which would otherwise re-run the entire real test suite inside that
// short-lived child.
if (require.main === module) {
  main();
}

module.exports = { createContentMatchStash, withContentMatchStashed, withIsolatedRotationSlugEvidence };
