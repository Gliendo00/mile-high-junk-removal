// Site Improvement Agent, Phase 14 — tests for agent/lib/execute-
// proposal.js, the execution engine behind the dashboard's Approved /
// Pending Execution queue.
//
// Supabase is faked via a small in-memory query builder (same
// convention as tests/agent-proposals-api.test.js / agent-proposals-
// sync.test.js, injected via `options.client` rather than intercepting
// "@supabase/supabase-js"). `gatherFindings`/`isWorkingTreeClean`/`git`/
// `runTests` are ALSO injected (execute-proposal.js's own JSDoc
// documents all four) so these tests never touch the real repo's git
// state and never shell out to a real `npm test` — only
// rewrite-href.apply()'s real file write runs for real, against a
// disposable fixture file under tests/fixtures/ (same convention as
// tests/agent-apply-and-history.test.js), so the single-occurrence
// safety net is exercised for real, not mocked away.
//
// Run with:  node tests/agent-execute-proposal.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const config = require("../agent/config");
const { executeProposal, parseFailedFiles, diffNewFailures, RUN_TESTS_TIMEOUT_MS } = require("../agent/lib/execute-proposal");
const { execFileSync } = require("child_process");

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

// --- Fake Supabase (same shape/semantics as tests/agent-proposals-api.test.js) ---

class FakeQueryBuilder {
  constructor(table, db) {
    this.table = table;
    this.db = db;
    this.eqFilters = [];
    this._updatePayload = null;
  }
  select() {
    return this;
  }
  eq(col, val) {
    this.eqFilters.push({ col, val });
    return this;
  }
  update(payload) {
    this._updatePayload = payload;
    return this;
  }
  maybeSingle() {
    return this._resolve();
  }
  async _resolve() {
    const rows = this.db[this.table] || [];
    const matched = rows.filter((row) => this.eqFilters.every((f) => row[f.col] === f.val));
    if (this._updatePayload) {
      const row = matched[0];
      if (!row) return { data: null, error: null };
      Object.assign(row, this._updatePayload);
      return { data: { ...row }, error: null };
    }
    return { data: matched[0] ? { ...matched[0] } : null, error: null };
  }
}
function makeFakeClient(db) {
  return { from: (table) => new FakeQueryBuilder(table, db) };
}

// --- Fixture file for rewrite-href.apply() to really write to ---

const FIXTURE_DIR = path.join(config.SITE_ROOT, "tests", "fixtures");
const FIXTURE_REL = "tests/fixtures/execute-proposal-fixture.html";
const FIXTURE_ABS = path.join(config.SITE_ROOT, FIXTURE_REL);

function writeFixture(html) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(FIXTURE_ABS, html, "utf8");
}
function cleanupFixture() {
  if (fs.existsSync(FIXTURE_ABS)) fs.unlinkSync(FIXTURE_ABS);
}

// --- Fixture finding/proposal builders ---

const FIX = { kind: "rewrite-href", file: FIXTURE_REL, from: "/old-url", to: "/new-url.html" };

function makeFinding(overrides = {}) {
  return {
    key: "missing-canonical::x.html",
    type: "missing-canonical",
    decision: "PROPOSE_CHANGE",
    summary: "x.html links to an old URL.",
    evidence: [{ field: "href", value: "/old-url" }],
    research: [],
    pages: [FIXTURE_REL],
    autoFix: FIX,
    ...overrides,
  };
}

// A legitimately-claimed row — the shape api/admin/bookings.js's
// dashboard Execute action actually writes (atomic approved -> applying
// claim: status "applying", execution.requestedAt/requestedBy set,
// execution.startedAt still null) BEFORE it ever dispatches the GitHub
// Actions workflow that calls executeProposal(). This is the row
// executeProposal() now expects to see on the normal dispatched path —
// see execute-proposal.js's own header on the state-machine hotfix.
function makeClaimedRow(overrides = {}) {
  const f = makeFinding(overrides.finding || {});
  return {
    id: "prop-1",
    finding_key: f.key,
    finding_type: f.type,
    decision: f.decision,
    summary: f.summary,
    evidence: f.evidence,
    research: f.research,
    pages: f.pages,
    proposed_fix: overrides.proposedFix !== undefined ? overrides.proposedFix : FIX,
    status: overrides.status || "applying",
    updated_at: overrides.updatedAt || "2026-01-01T00:00:00.000Z",
    execution: overrides.execution !== undefined
      ? overrides.execution
      : { requestedAt: "2026-01-01T00:00:00.000Z", requestedBy: "owner@milehighjunkremoval.net", startedAt: null },
    ...overrides.row,
  };
}

// A gatherFindings fake that returns a DIFFERENT result on each
// successive call (executeProposal() calls it twice on the happy path:
// once for the pre-apply freshness check, once for the post-apply
// re-scan) — a plain queue, defaulting to repeating the last entry
// forever once exhausted (so a test that only cares about the FIRST
// call doesn't need to also specify a second).
function queuedGatherFindings(...resultsInOrder) {
  let i = 0;
  return () => {
    const findings = resultsInOrder[Math.min(i, resultsInOrder.length - 1)];
    i += 1;
    return { findings };
  };
}

function alwaysCleanTree() {
  return true;
}

// A isWorkingTreeClean fake that returns a DIFFERENT result on each
// successive call — executeProposal() now calls it TWICE on the happy
// path: once before the baseline test run, once after it (see the
// post-baseline cleanliness re-check hotfix). Same "repeat the last
// entry forever once exhausted" convention as queuedGatherFindings/
// queuedRunTests above.
function queuedIsWorkingTreeClean(...resultsInOrder) {
  let i = 0;
  return () => {
    const result = resultsInOrder[Math.min(i, resultsInOrder.length - 1)];
    i += 1;
    return result;
  };
}

// A runTests fake that returns a DIFFERENT result on each successive
// call — executeProposal() now calls it TWICE on the happy path: once
// for the pre-apply baseline, once for the after-apply comparison (see
// execute-proposal.js's baseline-aware test gate). Same "repeat the
// last entry forever once exhausted" convention as queuedGatherFindings
// above.
function queuedRunTests(...resultsInOrder) {
  let i = 0;
  return () => {
    const result = resultsInOrder[Math.min(i, resultsInOrder.length - 1)];
    i += 1;
    return result;
  };
}

function fakeGit(calls, { failOn } = {}) {
  let n = 0;
  return (args) => {
    calls.push(args);
    n += 1;
    if (failOn && failOn(args)) throw new Error(`fake git failure for: ${args.join(" ")}`);
    if (args[0] === "rev-parse") return "abc1234deadbeef\n";
    return "";
  };
}

async function main() {
  // --- Pure-function unit tests for the baseline-aware test gate's two
  // helpers (hotfix, proposal 6ad71748-...) -------------------------------

  await test("parseFailedFiles() extracts the exact file list from scripts/run-tests.js's own 'Failed: ...' line", () => {
    const summary = "PASS - a.test.js\nFAIL - b.test.js\n\n1/2 test files passed.\nFailed: b.test.js, c.test.js";
    assert.deepStrictEqual(parseFailedFiles(summary), ["b.test.js", "c.test.js"]);
  });

  await test("parseFailedFiles() returns [] when every file passed (no 'Failed:' line at all)", () => {
    assert.deepStrictEqual(parseFailedFiles("PASS - a.test.js\n\n2/2 test files passed."), []);
  });

  await test("parseFailedFiles() returns null (NOT []) when run-tests.js's own completion marker is missing — npm/node errored before it could even print that, discovered as a real Windows execFileSync quirk while verifying this hotfix: an empty [] here would let diffNewFailures() silently treat 'the test runner never actually ran' as 'zero failures, safe to deploy'", () => {
    assert.strictEqual(parseFailedFiles(""), null);
    assert.strictEqual(parseFailedFiles("Error: Cannot find module 'something'\n    at ..."), null);
  });

  await test("diffNewFailures() returns only the files NOT present in the baseline", () => {
    const baseline = { failedFiles: ["a.test.js", "b.test.js"] };
    const after = { failedFiles: ["b.test.js", "c.test.js"] };
    assert.deepStrictEqual(diffNewFailures(baseline, after), ["c.test.js"]);
  });

  await test("diffNewFailures() returns [] when the after-apply failures are an exact subset of (or equal to) the baseline", () => {
    assert.deepStrictEqual(diffNewFailures({ failedFiles: ["a.test.js", "b.test.js"] }, { failedFiles: ["a.test.js"] }), []);
    assert.deepStrictEqual(diffNewFailures({ failedFiles: ["a.test.js"] }, { failedFiles: ["a.test.js"] }), []);
  });

  await test("diffNewFailures() returns null (not []) when either side lacks a failedFiles array — the caller must fall back to .passed, never silently treat this as 'no new failures'", () => {
    assert.strictEqual(diffNewFailures({ passed: false }, { failedFiles: ["x.test.js"] }), null);
    assert.strictEqual(diffNewFailures({ failedFiles: ["x.test.js"] }, { passed: false }), null);
    assert.strictEqual(diffNewFailures({}, {}), null);
  });

  // -----------------------------------------------------------------------
  // Process-lifecycle hardening (second real execution attempt on proposal
  // 6ad71748-...: the GitHub Actions step itself was cancelled — job-level
  // timeout-minutes exceeded, with a pile of orphaned npm test/sh/Node
  // processes left for cleanup — not a normal executor result at all).
  // defaultRunTests() now bounds its `npm test` invocation with an
  // explicit `timeout`/`killSignal`, so a hang is converted into a clean,
  // fast, correctly-gated failure instead of consuming the whole job.
  //
  // This can't be proven against the real `npm` command in THIS
  // environment specifically — a separate, unrelated quirk on this
  // machine makes `execFileSync("npm", ...)` fail to even spawn npm at
  // all (confirmed while diagnosing this exact issue) — so this proves
  // the underlying Node.js timeout/killSignal mechanism directly,
  // against a plain `node` child (portable, works identically on every
  // platform this repo's CI actually runs on), which is the same
  // mechanism defaultRunTests() relies on for the real `npm test` call.
  // -----------------------------------------------------------------------

  await test("process-lifecycle hardening: execFileSync's timeout+killSignal genuinely terminates a hanging child within the configured window (the same mechanism defaultRunTests() now relies on)", () => {
    const start = Date.now();
    let caught = null;
    try {
      execFileSync(process.execPath, ["-e", "setTimeout(function(){}, 999999)"], {
        encoding: "utf8",
        timeout: 300,
        killSignal: "SIGTERM",
      });
    } catch (e) {
      caught = e;
    }
    const elapsedMs = Date.now() - start;
    assert.ok(caught, "expected the hanging child to be killed and execFileSync to throw");
    // Node does NOT reliably set error.killed for an execFileSync
    // timeout kill (confirmed empirically — it was `undefined` here
    // even though the child genuinely was terminated within the
    // configured window) — error.code === "ETIMEDOUT" is the actual
    // reliable signal, which is what defaultRunTests() itself checks.
    assert.strictEqual(caught.code, "ETIMEDOUT", "expected the error to report code: ETIMEDOUT");
    assert.strictEqual(caught.signal, "SIGTERM", "expected the configured killSignal to have been used");
    assert.ok(elapsedMs < 5000, `expected the kill to happen close to the 300ms timeout, took ${elapsedMs}ms`);
  });

  await test("process-lifecycle hardening: RUN_TESTS_TIMEOUT_MS is generous relative to this repo's real measured full-suite runtime (~65s locally) but still bounded (not Infinity / not absurdly large)", () => {
    assert.ok(RUN_TESTS_TIMEOUT_MS >= 3 * 60 * 1000, "must leave ample headroom above a slower CI runner's likely runtime");
    assert.ok(RUN_TESTS_TIMEOUT_MS <= 10 * 60 * 1000, "must still leave room for the OTHER run (baseline or after-apply) plus checkout/npm ci inside the 20-minute job ceiling");
  });

  // --- Minimal execution logging (hotfix, proposal 6ad71748-...: the
  // second cancellation left zero visibility into where the job was
  // actually stuck) — these capture real console.log output through the
  // REAL executeProposal() call, not a reimplementation, so a drift
  // between the log-wiring and the actual code can't hide. --------------

  function captureConsoleLog(fn) {
    const lines = [];
    const original = console.log;
    console.log = (msg) => lines.push(String(msg));
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        console.log = original;
      })
      .then((result) => ({ result, lines }));
  }

  await test("execution logging: a normal run logs baseline start/complete, apply start, and post-apply start/complete, in order, with no secrets and no raw per-test output", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const { lines } = await captureConsoleLog(() =>
        executeProposal("prop-1", {
          client,
          isWorkingTreeClean: alwaysCleanTree,
          gatherFindings: queuedGatherFindings([makeFinding()], []),
          runTests: queuedRunTests(
            { passed: false, summary: "Failed: unrelated.test.js", failedFiles: ["unrelated.test.js"] },
            { passed: false, summary: "Failed: unrelated.test.js", failedFiles: ["unrelated.test.js"] }
          ),
          git: fakeGit([]),
        })
      );

      const joined = lines.join("\n");
      const baselineStart = lines.findIndex((l) => /Baseline test suite: starting/.test(l));
      const baselineDone = lines.findIndex((l) => /Baseline test suite: completed in [\d.]+s \(passed: false, failedFiles: 1\)/.test(l));
      const applyStart = lines.findIndex((l) => /Applying proposed fix to .*execute-proposal-fixture\.html/.test(l));
      const postStart = lines.findIndex((l) => /Post-apply test suite: starting/.test(l));
      const postDone = lines.findIndex((l) => /Post-apply test suite: completed in [\d.]+s \(passed: false, failedFiles: 1\)/.test(l));

      assert.ok(baselineStart !== -1, `missing baseline-start log line in:\n${joined}`);
      assert.ok(baselineDone !== -1, `missing baseline-complete log line in:\n${joined}`);
      assert.ok(applyStart !== -1, `missing apply-start log line in:\n${joined}`);
      assert.ok(postStart !== -1, `missing post-apply-start log line in:\n${joined}`);
      assert.ok(postDone !== -1, `missing post-apply-complete log line in:\n${joined}`);
      assert.ok(baselineStart < baselineDone && baselineDone < applyStart && applyStart < postStart && postStart < postDone, `expected strict phase order, got:\n${joined}`);

      // Nothing secret-shaped, and no raw per-test-file PASS/FAIL dump —
      // only the phase summary lines this module itself constructs.
      assert.ok(!/SUPABASE_SECRET_KEY|secret|token/i.test(joined), `log output must never resemble a credential:\n${joined}`);
      assert.ok(!/^PASS - |^FAIL - /m.test(joined), "must not dump raw per-test-file npm-test output into the log");
    } finally {
      cleanupFixture();
    }
  });

  await test("execution logging: a timed-out phase is logged as TIMED OUT, labeled with the correct phase name", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const timedOutResult = { passed: false, summary: " (killed: timed out after 360s, signal SIGTERM)", failedFiles: null, timedOut: true };
      const { lines } = await captureConsoleLog(() =>
        executeProposal("prop-1", {
          client,
          isWorkingTreeClean: alwaysCleanTree,
          gatherFindings: queuedGatherFindings([makeFinding()], []),
          runTests: queuedRunTests(timedOutResult, timedOutResult),
          git: fakeGit([]),
        })
      );
      const joined = lines.join("\n");
      assert.ok(/Baseline test suite: TIMED OUT after [\d.]+s/.test(joined), `expected a labeled baseline timeout line, got:\n${joined}`);
    } finally {
      cleanupFixture();
    }
  });

  // --- State-machine regression tests (first real Phase 14 execution,
  // proposal 0945f338-...) — see execute-proposal.js's own header on
  // the hotfix. These five cover exactly the scenarios the fix is
  // required to get right. ---------------------------------------------

  await test("state machine: an 'approved' proposal, once legitimately claimed to 'applying' by the dashboard, is accepted by the executor", async () => {
    // makeClaimedRow()'s default IS the dashboard's own claimed shape
    // (status "applying", execution.requestedAt/requestedBy set,
    // startedAt still null) — exactly what api/admin/bookings.js writes
    // the instant Execute is clicked, before this ever runs. This is
    // the normal, correct entry point now — proven fully end-to-end by
    // the "happy path" test further below; this test isolates just the
    // state-machine acceptance itself (the start-claim must succeed,
    // startedAt must move from null to a real timestamp).
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: alwaysCleanTree,
        gatherFindings: queuedGatherFindings([makeFinding()], []),
        runTests: () => ({ passed: true, summary: "ok" }),
        git: fakeGit([]),
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, "deployed");
      assert.ok(db.agent_proposals[0].execution.startedAt, "startedAt must be set once the executor actually starts");
      // The admin email that clicked Execute (the dashboard's OWN claim)
      // must survive untouched — never overwritten by this run.
      assert.strictEqual(db.agent_proposals[0].execution.requestedBy, "owner@milehighjunkremoval.net");
    } finally {
      cleanupFixture();
    }
  });

  await test("state machine: a BARE 'approved' proposal (never claimed by the dashboard) is refused — this is the exact original bug", async () => {
    const db = { agent_proposals: [makeClaimedRow({ status: "approved", execution: {} })] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client });
    assert.strictEqual(result.ok, false);
    assert.ok(/freshly-claimed "applying" state/i.test(result.reason));
    assert.ok(/status: "approved"/i.test(result.reason));
    assert.strictEqual(db.agent_proposals[0].status, "approved", "must never move an unclaimed row");
  });

  await test("state machine: an 'applying' row with no execution metadata at all (stale/invalid claim) is refused", async () => {
    const db = { agent_proposals: [makeClaimedRow({ execution: {} })] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client });
    assert.strictEqual(result.ok, false);
    assert.ok(/stale or invalid row/i.test(result.reason));
  });

  await test("state machine: duplicate execution — an 'applying' row whose execution already has a startedAt is refused", async () => {
    const db = {
      agent_proposals: [
        makeClaimedRow({
          execution: { requestedAt: "2026-01-01T00:00:00.000Z", requestedBy: "owner@milehighjunkremoval.net", startedAt: "2026-01-01T00:00:05.000Z" },
        }),
      ],
    };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client });
    assert.strictEqual(result.ok, false);
    assert.ok(/already has a startedAt/i.test(result.reason));
    assert.ok(/prevent the same change being applied twice/i.test(result.reason));
  });

  await test("state machine: a concurrent execution attempt against the SAME claim (updated_at moves between load and start-claim) is refused by the optimistic lock", async () => {
    // A genuine race can't be produced by mutating the row BEFORE calling
    // executeProposal() — its own loadProposal() always reads whatever is
    // current at that moment, so a pre-mutation would just be the fresh
    // value, not a stale one. To exercise the actual race window (between
    // THIS run's own loadProposal() and its own later start-claim), this
    // client wraps the generic fake query builder and injects a
    // concurrent writer's update (bumping updated_at, as a second
    // process's own start-claim would) in between those two specific
    // calls — the second `.from("agent_proposals")` call executeProposal()
    // makes is always the start-claim (the first is loadProposal()).
    const db = { agent_proposals: [makeClaimedRow({ updatedAt: "2026-01-01T00:00:00.000Z" })] };
    let fromCallCount = 0;
    const client = {
      from(table) {
        fromCallCount += 1;
        const builder = new FakeQueryBuilder(table, db);
        if (fromCallCount === 2) {
          const originalResolve = builder._resolve.bind(builder);
          builder._resolve = async () => {
            db.agent_proposals[0].updated_at = "2026-01-01T00:00:01.000Z";
            return originalResolve();
          };
        }
        return builder;
      },
    };
    const result = await executeProposal("prop-1", { client });
    assert.strictEqual(result.ok, false);
    assert.ok(/could not record that execution started/i.test(result.reason));
    // The row itself must be untouched by this refused attempt (only the
    // simulated concurrent writer's own updated_at bump, nothing else).
    assert.strictEqual(db.agent_proposals[0].status, "applying");
    assert.strictEqual(db.agent_proposals[0].execution.startedAt, null);
  });

  await test("refuses a rejected proposal outright, with no DB write to the row", async () => {
    const db = { agent_proposals: [makeClaimedRow({ status: "rejected" })] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client });
    assert.strictEqual(result.ok, false);
    assert.ok(/rejected/i.test(result.reason));
    assert.strictEqual(db.agent_proposals[0].status, "rejected");
  });

  await test("refuses a proposal that is still merely 'proposed' (never even approved)", async () => {
    const db = { agent_proposals: [makeClaimedRow({ status: "proposed", execution: {} })] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client });
    assert.strictEqual(result.ok, false);
    assert.ok(/freshly-claimed "applying" state/i.test(result.reason));
    assert.strictEqual(db.agent_proposals[0].status, "proposed");
  });

  await test("refuses an already-completed proposal (e.g. 'deployed') — un-re-executable", async () => {
    const db = { agent_proposals: [makeClaimedRow({ status: "deployed" })] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client });
    assert.strictEqual(result.ok, false);
    assert.ok(/freshly-claimed "applying" state/i.test(result.reason));
    assert.ok(/status: "deployed"/i.test(result.reason));
  });

  await test("needs_review when no proposed_fix is recorded (every real finding type today)", async () => {
    const db = { agent_proposals: [makeClaimedRow({ proposedFix: null })] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client, isWorkingTreeClean: alwaysCleanTree, gatherFindings: queuedGatherFindings([makeFinding()]) });
    assert.strictEqual(result.status, "needs_review");
    assert.ok(/no supported deterministic fix/i.test(result.reason));
    assert.strictEqual(db.agent_proposals[0].status, "needs_review");
  });

  await test("needs_review when the fix kind is not one this engine supports", async () => {
    const db = { agent_proposals: [makeClaimedRow({ proposedFix: { kind: "rewrite-content", file: FIXTURE_REL } })] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client, isWorkingTreeClean: alwaysCleanTree });
    assert.strictEqual(result.status, "needs_review");
    assert.ok(/kind: rewrite-content/i.test(result.reason));
  });

  await test("needs_review when the working tree is not clean", async () => {
    const db = { agent_proposals: [makeClaimedRow()] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client, isWorkingTreeClean: () => false });
    assert.strictEqual(result.status, "needs_review");
    assert.ok(/working tree is not clean/i.test(result.reason));
  });

  // -----------------------------------------------------------------------
  // Post-baseline cleanliness re-check (defense-in-depth hotfix,
  // diagnosing the SAME CI-only divergence the test-suite crash-safety
  // fix in agent-runner-resume.test.js/agent-runner-rotation-evidence.
  // test.js closes at its source): if the baseline `npm test` run itself
  // leaves the checkout dirty — a test's own crash-safety gap, or any
  // future one — this orchestrator must refuse to proceed, rather than
  // apply the fix and run a post-apply comparison against an
  // untrustworthy starting point.
  // -----------------------------------------------------------------------

  await test("needs_review when the working tree is clean BEFORE the baseline run but dirty AFTER it (baseline testing itself mutated the checkout)", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: queuedIsWorkingTreeClean(true, false),
        gatherFindings: queuedGatherFindings([makeFinding()], []),
        runTests: () => ({ passed: true, summary: "ok" }),
        git: fakeGit(gitCalls),
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, "needs_review");
      assert.ok(/no longer clean after the baseline test run/i.test(result.reason), `expected a baseline-specific reason, got: ${result.reason}`);
      assert.strictEqual(db.agent_proposals[0].status, "needs_review");
      // Nothing was ever applied — the fixture file and git must both be untouched.
      assert.strictEqual(fs.readFileSync(FIXTURE_ABS, "utf8"), '<a href="/old-url">Link</a>');
      assert.deepStrictEqual(gitCalls, [], "must never apply, revert, or touch git when aborting before the apply step");
    } finally {
      cleanupFixture();
    }
  });

  await test("a clean tree both before AND after the baseline run proceeds normally -> deployed (the re-check is not a false positive on the happy path)", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: queuedIsWorkingTreeClean(true, true),
        gatherFindings: queuedGatherFindings([makeFinding()], []),
        runTests: () => ({ passed: true, summary: "ok" }),
        git: fakeGit([]),
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, "deployed");
    } finally {
      cleanupFixture();
    }
  });

  await test("needs_review when the original finding no longer appears in a fresh scan", async () => {
    const db = { agent_proposals: [makeClaimedRow()] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client, isWorkingTreeClean: alwaysCleanTree, gatherFindings: queuedGatherFindings([]) });
    assert.strictEqual(result.status, "needs_review");
    assert.ok(/no longer appears at all/i.test(result.reason));
  });

  await test("needs_review when the finding's decision has since moved off needing review (e.g. NO_CHANGE)", async () => {
    const db = { agent_proposals: [makeClaimedRow()] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", {
      client,
      isWorkingTreeClean: alwaysCleanTree,
      gatherFindings: queuedGatherFindings([makeFinding({ decision: "NO_CHANGE" })]),
    });
    assert.strictEqual(result.status, "needs_review");
    assert.ok(/now decided NO_CHANGE/i.test(result.reason));
  });

  await test("needs_review when the fresh finding's content has drifted from what was approved (summary changed)", async () => {
    const db = { agent_proposals: [makeClaimedRow()] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", {
      client,
      isWorkingTreeClean: alwaysCleanTree,
      gatherFindings: queuedGatherFindings([makeFinding({ summary: "a completely different summary now" })]),
    });
    assert.strictEqual(result.status, "needs_review");
    assert.ok(/site has changed since this proposal was approved/i.test(result.reason));
  });

  await test("needs_review when the exact fix text no longer appears exactly once in the file (zero occurrences)", async () => {
    writeFixture('<a href="/somewhere-else">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const result = await executeProposal("prop-1", { client, isWorkingTreeClean: alwaysCleanTree, gatherFindings: queuedGatherFindings([makeFinding()]) });
      assert.strictEqual(result.status, "needs_review");
      assert.ok(/could not apply the approved fix/i.test(result.reason));
    } finally {
      cleanupFixture();
    }
  });

  await test("happy path: applies the fix for real, re-validates, runs tests, commits, and pushes -> deployed", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      const result = await executeProposal("prop-1", {
        client,
        // Deliberately passed but expected to have NO effect — see
        // execute-proposal.js's own JSDoc: requestedBy is now read from
        // the row's OWN already-claimed execution.requestedBy (asserted
        // below), never from this option, on the normal dispatched path.
        requestedBy: "someone-else@example.com",
        isWorkingTreeClean: alwaysCleanTree,
        gatherFindings: queuedGatherFindings(
          [makeFinding()], // pre-apply freshness check
          [] // post-apply re-scan: the issue is gone
        ),
        runTests: () => ({ passed: true, summary: "147/147 test files passed." }),
        git: fakeGit(gitCalls),
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, "deployed");
      assert.strictEqual(result.commitSha, "abc1234deadbeef");
      assert.deepStrictEqual(result.filesChanged, [FIXTURE_REL]);

      const updatedFile = fs.readFileSync(FIXTURE_ABS, "utf8");
      assert.ok(updatedFile.includes('href="/new-url.html"'), "the fixture file must actually have been rewritten for real");
      assert.ok(!updatedFile.includes("/old-url"));

      const row = db.agent_proposals[0];
      assert.strictEqual(row.status, "deployed");
      assert.strictEqual(row.execution.commitSha, "abc1234deadbeef");
      assert.deepStrictEqual(row.execution.filesChanged, [FIXTURE_REL]);
      assert.strictEqual(row.execution.requestedBy, "owner@milehighjunkremoval.net");
      assert.strictEqual(row.execution.validation.status, "confirmed-resolved");
      assert.strictEqual(row.execution.testResult.passed, true);

      assert.deepStrictEqual(gitCalls[0], ["add", "--", FIXTURE_REL]);
      assert.strictEqual(gitCalls[1][0], "commit");
      assert.deepStrictEqual(gitCalls[2], ["rev-parse", "HEAD"]);
      assert.deepStrictEqual(gitCalls[3], ["push", "origin", "HEAD:main"]);
    } finally {
      cleanupFixture();
    }
  });

  await test("freshness hotfix (proposals 0945f338-.../6ad71748-...): a stored row whose proposed_fix/evidence came back with REORDERED keys (simulating a real Postgres jsonb round-trip) still passes freshness and reaches 'deployed' — it is NOT a false needs_review", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      // The exact same semantic fix/evidence as FIX/makeFinding() above,
      // but with every object's keys in a DIFFERENT order — exactly what
      // a real jsonb column can hand back for byte-identical content
      // (jsonb does not preserve object key insertion order). Before the
      // canonicalizeForFingerprint() hotfix, this alone made the
      // freshness check see a "material change" that was never real.
      const reorderedFix = { to: FIX.to, from: FIX.from, file: FIX.file, kind: FIX.kind };
      const reorderedEvidence = [{ value: "/old-url", field: "href" }];
      const db = { agent_proposals: [makeClaimedRow({ proposedFix: reorderedFix, finding: { evidence: reorderedEvidence } })] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: alwaysCleanTree,
        gatherFindings: queuedGatherFindings([makeFinding()], []),
        runTests: () => ({ passed: true, summary: "ok" }),
        git: fakeGit(gitCalls),
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, "deployed", `expected a key-order-only difference to never fail freshness, got: ${result.reason}`);
    } finally {
      cleanupFixture();
    }
  });

  await test("validation failure (re-scan still shows the finding needing review) -> failed, reverted via git checkout, never committed", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: alwaysCleanTree,
        gatherFindings: queuedGatherFindings(
          [makeFinding()],
          [makeFinding()] // post-apply: STILL needs review -> not resolved
        ),
        runTests: () => ({ passed: true, summary: "ok" }),
        git: fakeGit(gitCalls),
      });

      assert.strictEqual(result.status, "failed");
      assert.ok(/did not resolve it as expected/i.test(result.reason));
      assert.strictEqual(db.agent_proposals[0].status, "failed");
      assert.deepStrictEqual(gitCalls, [["checkout", "--", FIXTURE_REL]], "must revert via git checkout and never reach add/commit/push");
    } finally {
      cleanupFixture();
    }
  });

  await test("test-suite failure after a successful apply+validate -> failed, reverted, never committed", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: alwaysCleanTree,
        gatherFindings: queuedGatherFindings([makeFinding()], []),
        runTests: () => ({ passed: false, summary: "3 tests failed." }),
        git: fakeGit(gitCalls),
      });

      assert.strictEqual(result.status, "failed");
      assert.ok(/automated tests failed/i.test(result.reason));
      assert.strictEqual(db.agent_proposals[0].execution.testResult.passed, false);
      assert.deepStrictEqual(gitCalls, [["checkout", "--", FIXTURE_REL]]);
    } finally {
      cleanupFixture();
    }
  });

  // -----------------------------------------------------------------------
  // Baseline-aware test gate (hotfix, proposal 6ad71748-...): this repo
  // can carry pre-existing, unrelated test failures (env/DB-dependent),
  // which used to fail EVERY execution outright at this step regardless
  // of whether the proposal's own change broke anything — see
  // execute-proposal.js's own header for the full story.
  // -----------------------------------------------------------------------

  await test("baseline-aware test gate: the SAME pre-existing failures present before AND after the apply do not block deployment -> deployed", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      const preExisting = { passed: false, summary: "Failed: unrelated-a.test.js, unrelated-b.test.js", failedFiles: ["unrelated-a.test.js", "unrelated-b.test.js"] };
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: alwaysCleanTree,
        gatherFindings: queuedGatherFindings([makeFinding()], []),
        runTests: queuedRunTests(preExisting, preExisting), // identical baseline and after-apply result
        git: fakeGit(gitCalls),
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, "deployed", `expected unchanged pre-existing failures to never block deployment, got: ${result.reason}`);
      assert.deepStrictEqual(db.agent_proposals[0].execution.testResult.baselineFailedFiles, ["unrelated-a.test.js", "unrelated-b.test.js"]);
    } finally {
      cleanupFixture();
    }
  });

  await test("baseline-aware test gate: a genuinely NEW failure introduced by the change still blocks deployment -> failed, reverted, naming the new failure", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: alwaysCleanTree,
        gatherFindings: queuedGatherFindings([makeFinding()], []),
        runTests: queuedRunTests(
          { passed: false, summary: "Failed: unrelated-a.test.js", failedFiles: ["unrelated-a.test.js"] }, // baseline
          { passed: false, summary: "Failed: unrelated-a.test.js, newly-broken.test.js", failedFiles: ["unrelated-a.test.js", "newly-broken.test.js"] } // after apply
        ),
        git: fakeGit(gitCalls),
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, "failed");
      assert.ok(result.reason.includes("newly-broken.test.js"), `expected the new failure to be named in the reason, got: ${result.reason}`);
      assert.ok(!result.reason.includes("unrelated-a.test.js"), "the pre-existing baseline failure must not be named as if it were new");
      assert.deepStrictEqual(db.agent_proposals[0].execution.testResult.newFailures, ["newly-broken.test.js"]);
      assert.deepStrictEqual(gitCalls, [["checkout", "--", FIXTURE_REL]], "must revert via git checkout and never reach add/commit/push");
    } finally {
      cleanupFixture();
    }
  });

  await test("baseline-aware test gate: a previously-failing file that now PASSES is fine -> deployed", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: alwaysCleanTree,
        gatherFindings: queuedGatherFindings([makeFinding()], []),
        runTests: queuedRunTests(
          { passed: false, summary: "Failed: flaky.test.js", failedFiles: ["flaky.test.js"] }, // baseline
          { passed: true, summary: "All test files passed.", failedFiles: [] } // after apply
        ),
        git: fakeGit(gitCalls),
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, "deployed");
    } finally {
      cleanupFixture();
    }
  });

  await test("baseline-aware test gate: backward-compatible fallback to the plain .passed flag when a runTests double doesn't carry failedFiles at all", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      // Neither call carries `failedFiles` — diffNewFailures() must return
      // null, and the caller must fall back to testResult.passed exactly
      // as it did before this hotfix existed.
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: alwaysCleanTree,
        gatherFindings: queuedGatherFindings([makeFinding()], []),
        runTests: () => ({ passed: true, summary: "ok, no failedFiles field at all" }),
        git: fakeGit(gitCalls),
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, "deployed");
    } finally {
      cleanupFixture();
    }
  });

  await test("baseline-aware test gate: if the test runner itself fails to produce ANY trustworthy result on BOTH calls (e.g. npm failing to even launch), that must still block deployment — never silently 'no new failures' just because both sides are equally broken", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      // What defaultRunTests() itself now produces when npm/execFileSync
      // fails to even spawn (discovered for real on a Windows dev machine
      // while verifying this hotfix): passed:false, failedFiles:null
      // (NOT []) because parseFailedFiles() never saw run-tests.js's own
      // "N/M test files passed." completion marker.
      const brokenRunnerResult = { passed: false, summary: "", failedFiles: null };
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: alwaysCleanTree,
        gatherFindings: queuedGatherFindings([makeFinding()], []),
        runTests: queuedRunTests(brokenRunnerResult, brokenRunnerResult),
        git: fakeGit(gitCalls),
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, "failed", "a test-infrastructure failure on both runs must never be treated as 'safe to deploy'");
      assert.deepStrictEqual(gitCalls, [["checkout", "--", FIXTURE_REL]], "must still revert, never reach commit/push");
    } finally {
      cleanupFixture();
    }
  });

  await test("git push failure after a real commit -> failed, with the local commit SHA recorded but nothing marked deployed", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeClaimedRow()] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      const result = await executeProposal("prop-1", {
        client,
        isWorkingTreeClean: alwaysCleanTree,
        gatherFindings: queuedGatherFindings([makeFinding()], []),
        runTests: () => ({ passed: true, summary: "ok" }),
        git: fakeGit(gitCalls, { failOn: (args) => args[0] === "push" }),
      });

      assert.strictEqual(result.status, "failed");
      assert.ok(/git push to main failed/i.test(result.reason));
      assert.strictEqual(result.commitSha, "abc1234deadbeef");
      assert.strictEqual(db.agent_proposals[0].status, "failed");
      assert.strictEqual(db.agent_proposals[0].execution.commitSha, "abc1234deadbeef");
    } finally {
      cleanupFixture();
    }
  });

  await test("returns a clear 'not configured' result (never throws) when no Supabase client is available", async () => {
    // Process-lifecycle hotfix (diagnosing the GitHub Actions hang on
    // proposal 6ad71748-...): this test used to just ASSUME
    // SUPABASE_URL/SUPABASE_SECRET_KEY were absent from this file's own
    // process env, deliberately no `client` option, to exercise the
    // real getServiceClient() returning null. That assumption is FALSE
    // inside the real execute-proposal.yml workflow -- this file is the
    // ONLY one in the whole 151-file suite that ever calls
    // getServiceClient() (confirmed by grep across every test file),
    // and `npm test` there inherits the EXECUTOR's own real
    // SUPABASE_URL/SUPABASE_SECRET_KEY (no `env:` override anywhere in
    // the execFileSync -> npm -> scripts/run-tests.js -> spawnSync
    // chain). Without this explicit save/clear/restore, this exact
    // test would construct a REAL, LIVE Supabase client pointed at
    // PRODUCTION and make a genuine network call (loadProposal's
    // `.from("agent_proposals")...eq("id","prop-1")`) during `npm
    // test`, inside the one workflow that actually has those
    // credentials -- a real safety issue independent of whether it was
    // the specific thing that hung.
    const savedUrl = process.env.SUPABASE_URL;
    const savedKey = process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    try {
      const result = await executeProposal("prop-1", {});
      assert.strictEqual(result.ok, false);
      assert.ok(/Supabase not configured/i.test(result.reason));
    } finally {
      if (savedUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = savedUrl;
      if (savedKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
      else process.env.SUPABASE_SECRET_KEY = savedKey;
    }
  });

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main();
