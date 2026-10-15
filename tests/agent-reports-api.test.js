// Site Improvement Agent, Phase 5 — tests for api/admin/bookings.js's new
// ?view=agent-reports (list) and ?view=agent-report&runId=... (detail)
// branches. Same offline test harness convention as
// tests/agent-activity-api.test.js: these views never touch Supabase
// (they read agent/history/log.ndjson), but requireAdmin() still gates
// every /api/admin/* route, so a fake auth-only anon client is needed.
//
// The real handlers (handleListAgentReports/handleGetAgentReport, mirrors
// the pre-existing handleAgentActivity) call agent/lib/history.js's
// readAllRuns() with NO explicit path, so they always read
// config.HISTORY_LOG_PATH — this test NEVER touches the real committed
// agent/history/log.ndjson (unlike agent-activity-api.test.js, which
// deliberately reads the real file for ITS own, narrower, read-only
// purpose): instead it redirects config.HISTORY_LOG_PATH itself to a
// throwaway temp file before requiring anything else, the same "mutate
// the shared, cached config object before first use" trick several other
// test files in this suite already rely on for config-driven modules.
//
// Run with:  node tests/agent-reports-api.test.js

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function createFakeAnonClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { email: "owner@milehighjunkremoval.net" } }, error: null }),
      refreshSession: async () => ({ data: null, error: { message: "not used" } }),
    },
  };
}
const fakeAnon = createFakeAnonClient();

function interceptSupabaseModule() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return {
        createClient: function (_url, key) {
          if (key === process.env.SUPABASE_ANON_KEY) return fakeAnon;
          throw new Error("agent-reports views must never touch Supabase — unexpected createClient() call with key: " + key);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
interceptSupabaseModule();

process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";

const TEST_LOG_PATH = path.join(os.tmpdir(), `agent-reports-api-test-${process.pid}.ndjson`);

// Redirect the shared, cached config object's HISTORY_LOG_PATH BEFORE
// requiring bookings.js/history.js — both read config.HISTORY_LOG_PATH
// as a per-call default parameter, so mutating this one (cached, shared)
// object's property is enough to redirect every later readAllRuns()/
// appendRun() call in this process to the temp path, without ever
// touching the real committed log file.
const config = require("../agent/config");
config.HISTORY_LOG_PATH = TEST_LOG_PATH;

const bookingsHandler = require("../api/admin/bookings.js");
const history = require("../agent/lib/history");

function sampleReport(overrides) {
  return {
    runId: overrides.runId,
    timestamp: overrides.timestamp,
    runType: overrides.runType || "daily",
    mode: "dry-run",
    pagesChecked: 51,
    healthSummary: overrides.healthSummary || { status: "all-clear", text: "All clear — no worthwhile changes found." },
    technicalIssues: { actionableOpen: 0, byCategory: {} },
    observationsCount: 0,
    opportunitiesCount: 0,
    research: { questionsRaisedCount: 0, performed: [] },
    safeFixes: { appliedCount: 0, items: [] },
    proposals: { createdOrUpdatedCount: 0, awaitingApprovalCount: overrides.awaitingApprovalCount || 0, previouslyRejectedStillSurfacingCount: 0, alreadyAppliedCount: 0, items: [] },
    changeDetection: { hasPreviousRun: false, previousRunId: null, new: [], stillOpen: [], resolved: [], counts: { new: 0, stillOpen: 0, resolved: 0 } },
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSyncSkippedReason: "sync disabled for this run",
    failure: null,
    rotation: null,
    nextReviewHint: "x",
  };
}

// The handler itself calls readAllRuns() with no path argument, so it
// always reads config.HISTORY_LOG_PATH — already redirected to
// TEST_LOG_PATH above, before bookings.js/history.js were ever required.
function installSeededLog(runs) {
  if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH);
  for (const run of runs) {
    history.appendRun(run, TEST_LOG_PATH);
  }
}

function makeReq(opts) {
  opts = opts || {};
  return {
    method: opts.method || "GET",
    headers: Object.assign({ cookie: "mhjr_admin_at=good", "x-forwarded-proto": "https" }, opts.headers || {}),
    query: opts.query || {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}
function makeRes() {
  const headers = {};
  const res = {
    statusCode: null,
    body: null,
    getHeader: (name) => headers[name.toLowerCase()],
    setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
    status: function (code) { res.statusCode = code; return res; },
    json: function (obj) { res.body = obj; return res; },
  };
  return res;
}
function run(req) {
  const res = makeRes();
  return Promise.resolve(bookingsHandler(req, res)).then(() => res);
}

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

async function main() {
  try {
    await test("?view=agent-reports requires admin auth", async () => {
      const res = await run(makeReq({ query: { view: "agent-reports" }, headers: { cookie: "" } }));
      assert.strictEqual(res.statusCode, 401);
    });

    await test("?view=agent-reports lists runs newest-first with a compact summary shape, never the full findings payload", async () => {
      installSeededLog([
        { runId: "r1", timestamp: "2026-10-12T04:15:00.000Z", runType: "daily", report: sampleReport({ runId: "r1", timestamp: "2026-10-12T04:15:00.000Z" }), findings: [] },
        { runId: "r2", timestamp: "2026-10-13T04:15:00.000Z", runType: "daily", report: sampleReport({ runId: "r2", timestamp: "2026-10-13T04:15:00.000Z", healthSummary: { status: "needs-attention", text: "1 proposal awaiting approval" }, awaitingApprovalCount: 1 }), findings: [] },
      ]);
      const res = await run(makeReq({ query: { view: "agent-reports" } }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.reports.length, 2);
      assert.strictEqual(res.body.reports[0].runId, "r2", "newest run must come first");
      assert.strictEqual(res.body.reports[0].proposalsAwaitingApprovalCount, 1);
      assert.strictEqual(res.body.reports[0].findings, undefined, "the list view must never include the full per-finding payload");
    });

    await test("?view=agent-reports&limit=1 respects the limit", async () => {
      const res = await run(makeReq({ query: { view: "agent-reports", limit: "1" } }));
      assert.strictEqual(res.body.reports.length, 1);
    });

    await test("?view=agent-reports degrades to connected:false (never a 500) when the log is missing entirely", async () => {
      if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH);
      const res = await run(makeReq({ query: { view: "agent-reports" } }));
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body.reports, []);
    });

    await test("?view=agent-report&runId=... requires admin auth", async () => {
      installSeededLog([{ runId: "r1", timestamp: "2026-10-12T04:15:00.000Z", runType: "daily", report: sampleReport({ runId: "r1", timestamp: "2026-10-12T04:15:00.000Z" }), findings: [] }]);
      const res = await run(makeReq({ query: { view: "agent-report", runId: "r1" }, headers: { cookie: "" } }));
      assert.strictEqual(res.statusCode, 401);
    });

    await test("?view=agent-report&runId=... with no runId returns 400", async () => {
      const res = await run(makeReq({ query: { view: "agent-report" } }));
      assert.strictEqual(res.statusCode, 400);
    });

    await test("?view=agent-report&runId=... returns the FULL run record (including findings) for that one run", async () => {
      const res = await run(makeReq({ query: { view: "agent-report", runId: "r1" } }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.run.runId, "r1");
      assert.ok(res.body.run.report);
      assert.ok(Array.isArray(res.body.run.findings));
    });

    await test("?view=agent-report&runId=... for a runId that doesn't exist returns 404, not a silent empty success", async () => {
      const res = await run(makeReq({ query: { view: "agent-report", runId: "does-not-exist" } }));
      assert.strictEqual(res.statusCode, 404);
    });

    await test("a FAILED run appears in the list with failed:true and a 'failed' healthSummary, never pretending success", async () => {
      installSeededLog([
        { runId: "r1", timestamp: "2026-10-12T04:15:00.000Z", runType: "daily", failed: true, report: sampleReport({ runId: "r1", timestamp: "2026-10-12T04:15:00.000Z", healthSummary: { status: "failed", text: "This run did not complete successfully." } }), findings: [] },
      ]);
      const res = await run(makeReq({ query: { view: "agent-reports" } }));
      assert.strictEqual(res.body.reports[0].failed, true);
      assert.strictEqual(res.body.reports[0].healthSummary.status, "failed");
    });
  } finally {
    if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH);
  }

  if (process.exitCode) process.exit(process.exitCode);
}

main();
