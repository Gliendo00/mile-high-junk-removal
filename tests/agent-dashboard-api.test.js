// Website Agent dashboard — tests for api/admin/bookings.js's new
// ?view=agent-dashboard branch (handleAgentDashboard()). Same offline test
// harness convention as tests/agent-reports-api.test.js: this view never
// touches Supabase (not even to check configuration — it reads
// process.env directly, see the handler's own comment), but requireAdmin()
// still gates every /api/admin/* route, so a fake auth-only anon client is
// needed, and any unexpected createClient() call with a non-anon key fails
// the test loudly rather than silently succeeding.
//
// Run with:  node tests/agent-dashboard-api.test.js

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
          throw new Error("agent-dashboard must never touch Supabase — unexpected createClient() call with key: " + key);
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

const TEST_LOG_PATH = path.join(os.tmpdir(), `agent-dashboard-api-test-${process.pid}.ndjson`);

const config = require("../agent/config");
config.HISTORY_LOG_PATH = TEST_LOG_PATH;

const bookingsHandler = require("../api/admin/bookings.js");
const history = require("../agent/lib/history");

function sampleReport(overrides) {
  overrides = overrides || {};
  return {
    runId: overrides.runId,
    timestamp: overrides.timestamp,
    runType: overrides.runType || "daily",
    status: overrides.status || "completed",
    mode: "dry-run",
    pagesChecked: typeof overrides.pagesChecked === "number" ? overrides.pagesChecked : 51,
    healthSummary: overrides.healthSummary || { status: "all-clear", text: "All clear — no worthwhile changes found." },
    technicalIssues: { actionableOpen: overrides.actionableOpen || 0, byCategory: {} },
    observationsCount: overrides.observationsCount || 0,
    opportunitiesCount: overrides.opportunitiesCount || 0,
    research: { questionsRaisedCount: overrides.questionsRaisedCount || 0, questionsPending: [], performed: [] },
    safeFixes: { appliedCount: overrides.safeFixesAppliedCount || 0, items: [] },
    proposals: {
      createdOrUpdatedCount: overrides.createdOrUpdatedCount || 0,
      awaitingApprovalCount: overrides.awaitingApprovalCount || 0,
      previouslyRejectedStillSurfacingCount: 0,
      alreadyAppliedCount: 0,
      items: [],
    },
    changeDetection: { hasPreviousRun: false, previousRunId: null, new: [], stillOpen: [], resolved: [], counts: { new: 0, stillOpen: 0, resolved: 0 } },
    firstPartyEvidence: { integrations: { searchConsole: false, ga4: false }, gatheredThisRunCount: 0, gatheredDuringThisRunCount: 0, reusedFromBeforeCount: 0, countsBySource: {}, sourcesNotConsulted: [], questionsRaisedCount: 0, questionsPending: [], items: [] },
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSyncSkippedReason: "sync disabled for this run",
    failure: overrides.failure || null,
    rotation: null,
    nextReviewHint: "x",
  };
}

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
    await test("?view=agent-dashboard requires admin auth", async () => {
      const res = await run(makeReq({ query: { view: "agent-dashboard" }, headers: { cookie: "" } }));
      assert.strictEqual(res.statusCode, 401);
    });

    await test("?view=agent-dashboard degrades to connected:false (never a 500) when the log is missing entirely", async () => {
      if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH);
      const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.connected, false);
      assert.strictEqual(res.body.metrics, null);
    });

    await test("?view=agent-dashboard reports configured-but-not-queried Supabase flags from env vars alone", async () => {
      const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
      assert.strictEqual(res.body.integrations.crmData, true);
      assert.strictEqual(res.body.integrations.proposalSync, true);
    });

    // -----------------------------------------------------------------
    // Audit fix (2026-10-21): GSC/GA4 integration status now comes from
    // agent/history/integration-health.json (a REAL probe result the
    // GitHub Actions runner's --check-integrations step writes — see
    // agent/lib/integration-health.js's header) instead of an env-var
    // presence check evaluated in THIS Vercel function (which could
    // never see those env vars anyway — they're never provisioned to
    // Vercel by design). Same snapshot/restore pattern tests/agent-cli-
    // refresh-local-source-evidence.test.js already uses for its own
    // real small fixture file, since this module's HEALTH_PATH is a
    // captured constant (same convention as local-source-candidate-
    // log.js's own LOG_PATH), not independently injectable per test.
    // -----------------------------------------------------------------
    const { HEALTH_PATH } = require("../agent/lib/integration-health");
    function snapshotHealthFile() {
      return fs.existsSync(HEALTH_PATH) ? fs.readFileSync(HEALTH_PATH, "utf8") : null;
    }
    function restoreHealthFile(snapshot) {
      if (snapshot === null) {
        if (fs.existsSync(HEALTH_PATH)) fs.unlinkSync(HEALTH_PATH);
      } else {
        fs.writeFileSync(HEALTH_PATH, snapshot, "utf8");
      }
    }
    function writeHealth(health) {
      const dir = path.dirname(HEALTH_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(HEALTH_PATH, JSON.stringify(health), "utf8");
    }

    await test("?view=agent-dashboard: with no integration-health.json file at all, GSC/GA4 both report not_configured (never a crash, never a false CONNECTED)", async () => {
      const snapshot = snapshotHealthFile();
      try {
        if (fs.existsSync(HEALTH_PATH)) fs.unlinkSync(HEALTH_PATH);
        const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
        assert.strictEqual(res.body.integrations.gsc.state, "not_configured");
        assert.strictEqual(res.body.integrations.ga4.state, "not_configured");
      } finally {
        restoreHealthFile(snapshot);
      }
    });

    await test("?view=agent-dashboard: GSC configured+ok and fresh reports CONNECTED; GA4 not configured at all reports not_configured — independently, not coupled", async () => {
      const snapshot = snapshotHealthFile();
      try {
        writeHealth({ at: new Date().toISOString(), gsc: { configured: true, ok: true, reason: null }, ga4: { configured: false, ok: null, reason: null } });
        const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
        assert.strictEqual(res.body.integrations.gsc.state, "connected");
        assert.strictEqual(res.body.integrations.ga4.state, "not_configured");
      } finally {
        restoreHealthFile(snapshot);
      }
    });

    await test("?view=agent-dashboard: a configured-but-broken credential reports ERROR, never a false CONNECTED — and the reason is surfaced, not swallowed", async () => {
      const snapshot = snapshotHealthFile();
      try {
        writeHealth({ at: new Date().toISOString(), gsc: { configured: true, ok: false, reason: "Search Analytics API error: 403 Forbidden" }, ga4: { configured: true, ok: true, reason: null } });
        const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
        assert.strictEqual(res.body.integrations.gsc.state, "error");
        assert.strictEqual(res.body.integrations.gsc.reason, "Search Analytics API error: 403 Forbidden");
      } finally {
        restoreHealthFile(snapshot);
      }
    });

    await test("?view=agent-dashboard: a good-but-OLD reading (the daily check hasn't run in over 36h) reports STALE, not a misleadingly-current CONNECTED", async () => {
      const snapshot = snapshotHealthFile();
      try {
        const oldAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        writeHealth({ at: oldAt, gsc: { configured: true, ok: true, reason: null }, ga4: { configured: true, ok: true, reason: null } });
        const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
        assert.strictEqual(res.body.integrations.gsc.state, "stale");
        assert.strictEqual(res.body.integrations.ga4.state, "stale");
      } finally {
        restoreHealthFile(snapshot);
      }
    });

    await test("?view=agent-dashboard: an OLD error reading still reports ERROR, not STALE — a recorded failure is never time-gated away", async () => {
      const snapshot = snapshotHealthFile();
      try {
        const oldAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        writeHealth({ at: oldAt, gsc: { configured: true, ok: false, reason: "token request failed" }, ga4: { configured: true, ok: true, reason: null } });
        const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
        assert.strictEqual(res.body.integrations.gsc.state, "error");
      } finally {
        restoreHealthFile(snapshot);
      }
    });

    await test("?view=agent-dashboard: a malformed/corrupt integration-health.json degrades to not_configured, never a 500", async () => {
      const snapshot = snapshotHealthFile();
      try {
        const dir = path.dirname(HEALTH_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(HEALTH_PATH, "{not valid json", "utf8");
        const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.integrations.gsc.state, "not_configured");
        assert.strictEqual(res.body.integrations.ga4.state, "not_configured");
      } finally {
        restoreHealthFile(snapshot);
      }
    });

    await test("?view=agent-dashboard cumulative metrics sum findings/fixes/research/no-change across ALL recorded runs", async () => {
      installSeededLog([
        {
          runId: "r1",
          timestamp: "2026-10-10T04:15:00.000Z",
          runType: "daily",
          report: sampleReport({ runId: "r1", timestamp: "2026-10-10T04:15:00.000Z", pagesChecked: 48 }),
          findings: [
            { key: "f1", decision: "NO_CHANGE", status: "reviewed", summary: "no change needed" },
            { key: "f2", decision: "APPLY_SAFE_FIX", status: "applied", summary: "fixed a thing" },
          ],
        },
        {
          runId: "r2",
          timestamp: "2026-10-13T04:15:00.000Z",
          runType: "weekly",
          report: sampleReport({
            runId: "r2",
            timestamp: "2026-10-13T04:15:00.000Z",
            runType: "weekly",
            pagesChecked: 51,
            healthSummary: { status: "needs-attention", text: "1 proposal awaiting approval" },
            awaitingApprovalCount: 1,
            createdOrUpdatedCount: 1,
          }),
          findings: [
            { key: "f3", decision: "PROPOSE_CHANGE", status: "proposed", summary: "new opportunity", research: [{ source: "manual review", sourceType: "manual", confidence: "high", verdict: "worth proposing" }] },
            { key: "f4", decision: "NO_CHANGE", status: "reviewed", summary: "no change needed either" },
          ],
        },
      ]);
      const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.connected, true);
      assert.strictEqual(res.body.metrics.findingsTotal, 4, "2 findings in r1 + 2 in r2");
      assert.strictEqual(res.body.metrics.changesAppliedTotal, 1, "only f2 has status:applied");
      assert.strictEqual(res.body.metrics.researchCompletedTotal, 1, "only f3 carries a non-empty research[] array");
      assert.strictEqual(res.body.metrics.noChangeDecisionsTotal, 2, "f1 and f4 are both NO_CHANGE");
      assert.strictEqual(res.body.metrics.runsRecorded, 2);
      // pagesMonitored is a snapshot of the MOST RECENT run only, never a sum.
      assert.strictEqual(res.body.metrics.pagesMonitored, 51);
    });

    await test("?view=agent-dashboard's overall status reflects the latest run's healthSummary", async () => {
      const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
      assert.strictEqual(res.body.status, "needs-attention");
      assert.strictEqual(res.body.latestRun.runId, "r2");
    });

    await test("?view=agent-dashboard picks the most recent run of each type for daily/weekly panels", async () => {
      const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
      assert.strictEqual(res.body.daily.lastRun.runId, "r1");
      assert.strictEqual(res.body.weekly.lastRun.runId, "r2");
    });

    await test("?view=agent-dashboard's activity feed includes a SCAN COMPLETE event per run and one per finding, newest run first", async () => {
      const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
      const labels = res.body.activity.map((e) => e.label);
      assert.strictEqual(labels[0], "SCAN COMPLETE", "newest run's scan event leads the feed");
      assert.ok(labels.includes("PROPOSAL"));
      assert.ok(labels.includes("OBSERVATION") || labels.includes("RESEARCH"));
    });

    await test("?view=agent-dashboard's search intelligence is an honest {available:false} when no first-party evidence was ever gathered", async () => {
      const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
      assert.strictEqual(res.body.searchIntelligence.searchConsole.available, false);
      assert.strictEqual(res.body.searchIntelligence.ga4.available, false);
    });

    await test("?view=agent-dashboard surfaces REAL persisted first-party search evidence when a finding carries it, never fabricated", async () => {
      installSeededLog([
        {
          runId: "r1",
          timestamp: "2026-10-13T04:15:00.000Z",
          runType: "daily",
          report: sampleReport({ runId: "r1", timestamp: "2026-10-13T04:15:00.000Z" }),
          findings: [
            {
              key: "f1",
              decision: "NO_CHANGE",
              status: "reviewed",
              summary: "checked search performance",
              firstPartyEvidence: [
                {
                  findingKey: "f1",
                  source: "search-console-search-analytics",
                  metric: "clicks-impressions-ctr-position",
                  dimension: "query",
                  scope: { type: "city", value: "Aurora" },
                  window: { start: "2026-09-15", end: "2026-10-12", label: "28 days ending 2026-10-12" },
                  comparisonWindow: null,
                  observed: { totalRowsReturned: 1, topRows: [{ keys: ["junk removal aurora"], clicks: 12, impressions: 340, ctr: 0.035, position: 8.2 }] },
                  context: "Targeted Search Analytics query for city Aurora.",
                  limitations: "Reflects search-result behavior only.",
                  fetchedAt: "2026-10-13T04:00:00.000Z",
                },
              ],
            },
          ],
        },
      ]);
      const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
      const gsc = res.body.searchIntelligence.searchConsole;
      assert.strictEqual(gsc.available, true);
      assert.strictEqual(gsc.rows.length, 1);
      assert.strictEqual(gsc.rows[0].clicks, 12);
      assert.strictEqual(gsc.scope.value, "Aurora");
      assert.strictEqual(res.body.searchIntelligence.ga4.available, false, "no ga4 evidence was seeded");
    });

    await test("a FAILED run is reported honestly as status:'failed', never pretending success", async () => {
      installSeededLog([
        {
          runId: "r1",
          timestamp: "2026-10-13T04:15:00.000Z",
          runType: "daily",
          failed: true,
          report: sampleReport({ runId: "r1", timestamp: "2026-10-13T04:15:00.000Z", healthSummary: { status: "failed", text: "This run did not complete successfully." }, failure: { message: "network error" } }),
          findings: [],
        },
      ]);
      const res = await run(makeReq({ query: { view: "agent-dashboard" } }));
      assert.strictEqual(res.body.status, "failed");
      assert.strictEqual(res.body.latestRun.failureMessage, "network error");
      const scanEvent = res.body.activity.find((e) => e.runId === "r1" && (e.label === "ERROR" || e.label === "SCAN COMPLETE"));
      assert.strictEqual(scanEvent.label, "ERROR");
    });
  } finally {
    if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH);
  }

  if (process.exitCode) process.exit(process.exitCode);
}

main();
