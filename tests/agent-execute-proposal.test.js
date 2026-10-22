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
const { executeProposal } = require("../agent/lib/execute-proposal");

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

function makeApprovedRow(overrides = {}) {
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
    status: overrides.status || "approved",
    execution: {},
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
  await test("refuses a rejected proposal outright, with no DB write to the row", async () => {
    const db = { agent_proposals: [makeApprovedRow({ status: "rejected" })] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client });
    assert.strictEqual(result.ok, false);
    assert.ok(/rejected/i.test(result.reason));
    assert.strictEqual(db.agent_proposals[0].status, "rejected");
  });

  await test("refuses a proposal that is not currently 'approved' (e.g. still 'proposed')", async () => {
    const db = { agent_proposals: [makeApprovedRow({ status: "proposed" })] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client });
    assert.strictEqual(result.ok, false);
    assert.ok(/not currently "approved"/i.test(result.reason));
    assert.strictEqual(db.agent_proposals[0].status, "proposed");
  });

  await test("prevents double-execution: a SECOND call on an already-claimed ('applying') row is refused", async () => {
    const db = { agent_proposals: [makeApprovedRow()] };
    const client = makeFakeClient(db);
    // Manually simulate "already claimed by a first call" by setting
    // status to applying before calling again.
    db.agent_proposals[0].status = "applying";
    const result = await executeProposal("prop-1", { client });
    assert.strictEqual(result.ok, false);
    assert.ok(/not currently "approved"/i.test(result.reason));
  });

  await test("needs_review when no proposed_fix is recorded (every real finding type today)", async () => {
    const db = { agent_proposals: [makeApprovedRow({ proposedFix: null })] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client, isWorkingTreeClean: alwaysCleanTree, gatherFindings: queuedGatherFindings([makeFinding()]) });
    assert.strictEqual(result.status, "needs_review");
    assert.ok(/no supported deterministic fix/i.test(result.reason));
    assert.strictEqual(db.agent_proposals[0].status, "needs_review");
  });

  await test("needs_review when the fix kind is not one this engine supports", async () => {
    const db = { agent_proposals: [makeApprovedRow({ proposedFix: { kind: "rewrite-content", file: FIXTURE_REL } })] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client, isWorkingTreeClean: alwaysCleanTree });
    assert.strictEqual(result.status, "needs_review");
    assert.ok(/kind: rewrite-content/i.test(result.reason));
  });

  await test("needs_review when the working tree is not clean", async () => {
    const db = { agent_proposals: [makeApprovedRow()] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client, isWorkingTreeClean: () => false });
    assert.strictEqual(result.status, "needs_review");
    assert.ok(/working tree is not clean/i.test(result.reason));
  });

  await test("needs_review when the original finding no longer appears in a fresh scan", async () => {
    const db = { agent_proposals: [makeApprovedRow()] };
    const client = makeFakeClient(db);
    const result = await executeProposal("prop-1", { client, isWorkingTreeClean: alwaysCleanTree, gatherFindings: queuedGatherFindings([]) });
    assert.strictEqual(result.status, "needs_review");
    assert.ok(/no longer appears at all/i.test(result.reason));
  });

  await test("needs_review when the finding's decision has since moved off needing review (e.g. NO_CHANGE)", async () => {
    const db = { agent_proposals: [makeApprovedRow()] };
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
    const db = { agent_proposals: [makeApprovedRow()] };
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
      const db = { agent_proposals: [makeApprovedRow()] };
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
      const db = { agent_proposals: [makeApprovedRow()] };
      const client = makeFakeClient(db);
      const gitCalls = [];
      const result = await executeProposal("prop-1", {
        client,
        requestedBy: "owner@milehighjunkremoval.net",
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

  await test("validation failure (re-scan still shows the finding needing review) -> failed, reverted via git checkout, never committed", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeApprovedRow()] };
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
      const db = { agent_proposals: [makeApprovedRow()] };
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

  await test("git push failure after a real commit -> failed, with the local commit SHA recorded but nothing marked deployed", async () => {
    writeFixture('<a href="/old-url">Link</a>');
    try {
      const db = { agent_proposals: [makeApprovedRow()] };
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
    // Deliberately no `client` option AND no SUPABASE_URL/SUPABASE_SECRET_KEY
    // in this test file's own process env (this file never sets them,
    // unlike tests/agent-proposals-api.test.js's own process) — exercises
    // the real getServiceClient() returning null.
    const result = await executeProposal("prop-1", {});
    assert.strictEqual(result.ok, false);
    assert.ok(/Supabase not configured/i.test(result.reason));
  });

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main();
