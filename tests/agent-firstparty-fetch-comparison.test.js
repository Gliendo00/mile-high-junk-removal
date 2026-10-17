// Site Improvement Agent, Phase 12 — tests for the two-window
// (current vs immediately-preceding comparable period) comparison
// mechanism added to agent/lib/firstparty-fetch.js's
// fetchSearchAnalyticsEvidence()/fetchGa4Evidence(). No real network:
// fetchImpl is always injected.
//
// Run with:  node tests/agent-firstparty-fetch-comparison.test.js

const assert = require("assert");
const crypto = require("crypto");

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

function freshModule(name) {
  delete require.cache[require.resolve(name)];
  return require(name);
}

function fakeServiceAccountJson() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return JSON.stringify({ client_email: "fake@example.iam.gserviceaccount.com", private_key: privateKey });
}

function configureAllIntegrations() {
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
  process.env.GSC_SITE_URL = "https://www.milehighjunkremoval.net/";
  process.env.GA4_PROPERTY_ID = "123456789";
}

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

async function main() {
  // --- computeComparisonWindow() — pure function ------------------------

  await test("computeComparisonWindow() produces an equal-length, non-overlapping, immediately-preceding window", () => {
    const { computeComparisonWindow } = freshModule("../agent/lib/firstparty-fetch");
    const current = { start: "2026-10-01", end: "2026-10-28", label: "28 days ending 2026-10-28" };
    const prev = computeComparisonWindow(current, 28);
    assert.strictEqual(prev.end, "2026-09-30", "comparison window must end the day BEFORE the current window starts");
    assert.strictEqual(daysBetween(prev.start, prev.end) + 1, 28, "comparison window must be the SAME length (28 days) as the current window");
    assert.ok(prev.end < current.start, "comparison window must end strictly before the current window starts — never overlapping");
  });

  await test("computeComparisonWindow() works for an arbitrary (non-28) day count", () => {
    const { computeComparisonWindow } = freshModule("../agent/lib/firstparty-fetch");
    const current = { start: "2026-10-15", end: "2026-10-21" }; // 7 days
    const prev = computeComparisonWindow(current, 7);
    assert.strictEqual(prev.end, "2026-10-14");
    assert.strictEqual(daysBetween(prev.start, prev.end) + 1, 7);
  });

  // --- fetchSearchAnalyticsEvidence() with compareToPreviousPeriod ------

  await test("fetchSearchAnalyticsEvidence() WITHOUT compareToPreviousPeriod makes exactly ONE Search Analytics call and leaves comparisonWindow null (unchanged default behavior)", async () => {
    configureAllIntegrations();
    const { fetchSearchAnalyticsEvidence } = freshModule("../agent/lib/firstparty-fetch");
    let searchAnalyticsCalls = 0;
    const fetchImpl = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      searchAnalyticsCalls += 1;
      return { ok: true, status: 200, json: async () => ({ rows: [] }) };
    };
    const result = await fetchSearchAnalyticsEvidence({ scope: { type: "page", value: "golden-junk-removal.html" }, fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(searchAnalyticsCalls, 1, "no comparison fetch should ever be attempted when not requested");
    assert.strictEqual(result.evidence.comparisonWindow, null);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.evidence.observed, "previousPeriod"), false);
  });

  await test("fetchSearchAnalyticsEvidence() WITH compareToPreviousPeriod issues TWO calls with IDENTICAL dimensions/dimensionFilterGroups/rowLimit, equal-length non-overlapping windows, and populates comparisonWindow/observed.previousPeriod", async () => {
    configureAllIntegrations();
    const { fetchSearchAnalyticsEvidence } = freshModule("../agent/lib/firstparty-fetch");
    const calls = [];
    const fetchImpl = async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      const body = JSON.parse(init.body);
      calls.push(body);
      const isCurrent = calls.length === 1;
      return { ok: true, status: 200, json: async () => ({ rows: isCurrent ? [{ keys: ["q"], clicks: 5, impressions: 100, ctr: 0.05, position: 8 }] : [{ keys: ["q"], clicks: 2, impressions: 60, ctr: 0.033, position: 10 }] }) };
    };

    const result = await fetchSearchAnalyticsEvidence({
      scope: { type: "page", value: "golden-junk-removal.html" },
      dimensions: ["query"],
      dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "contains", expression: "golden" }] }],
      compareToPreviousPeriod: true,
      fetchImpl,
    });

    assert.strictEqual(result.skipped, false);
    assert.strictEqual(calls.length, 2, "exactly two Search Analytics calls — current + comparison");
    assert.deepStrictEqual(calls[0].dimensions, calls[1].dimensions, "dimensions must be IDENTICAL across both periods");
    assert.deepStrictEqual(calls[0].dimensionFilterGroups, calls[1].dimensionFilterGroups, "filters must be IDENTICAL across both periods");
    assert.strictEqual(calls[0].rowLimit, calls[1].rowLimit, "rowLimit must be IDENTICAL across both periods");
    assert.notStrictEqual(calls[0].startDate, calls[1].startDate, "the two calls must query DIFFERENT date ranges");

    const cw = result.evidence.comparisonWindow;
    assert.ok(cw && cw.start && cw.end && cw.label);
    assert.ok(cw.end < result.evidence.window.start, "comparisonWindow must end before the current window starts");
    assert.strictEqual(daysBetween(cw.start, cw.end) + 1, daysBetween(result.evidence.window.start, result.evidence.window.end) + 1, "equal duration");

    assert.ok(result.evidence.observed.previousPeriod, "observed.previousPeriod must be populated");
    assert.strictEqual(result.evidence.observed.previousPeriod.totalRowsReturned, 1);
    assert.strictEqual(result.evidence.observed.topRows[0].clicks, 5, "current period's own rows must be unaffected by the comparison fetch");
    assert.strictEqual(result.evidence.observed.previousPeriod.topRows[0].clicks, 2);
  });

  await test("fetchSearchAnalyticsEvidence() respects the existing GSC reporting lag: the comparison window still ends before the (lag-adjusted) current window's own start — never re-applies the lag a second time further into the past than necessary", async () => {
    configureAllIntegrations();
    const { fetchSearchAnalyticsEvidence, computeComparisonWindow } = freshModule("../agent/lib/firstparty-fetch");
    const fetchImpl = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      return { ok: true, status: 200, json: async () => ({ rows: [] }) };
    };
    const result = await fetchSearchAnalyticsEvidence({ scope: { type: "page", value: "x.html" }, compareToPreviousPeriod: true, fetchImpl });
    const expectedPrev = computeComparisonWindow(result.evidence.window, 28);
    assert.deepStrictEqual(result.evidence.comparisonWindow, expectedPrev, "the comparison window must be derived from the ALREADY lag-adjusted current window, via the one shared computeComparisonWindow() helper — never a separately re-lagged computation");
  });

  await test("fetchSearchAnalyticsEvidence(): a FAILED/skipped comparison fetch never fails the current period's evidence — comparisonWindow simply stays null", async () => {
    configureAllIntegrations();
    const { fetchSearchAnalyticsEvidence } = freshModule("../agent/lib/firstparty-fetch");
    let call = 0;
    const fetchImpl = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      call += 1;
      if (call === 1) return { ok: true, status: 200, json: async () => ({ rows: [{ keys: ["q"], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] }) };
      return { ok: false, status: 500, json: async () => ({ error: { message: "backend error" } }) };
    };
    const result = await fetchSearchAnalyticsEvidence({ scope: { type: "page", value: "x.html" }, compareToPreviousPeriod: true, fetchImpl });
    assert.strictEqual(result.skipped, false, "the current period succeeded — this must still be a successful result overall");
    assert.strictEqual(result.evidence.comparisonWindow, null, "a failed comparison fetch leaves comparisonWindow null, never partial/fabricated data");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.evidence.observed, "previousPeriod"), false);
    assert.strictEqual(result.evidence.observed.topRows[0].clicks, 1, "the current period's own evidence is completely unaffected by the comparison fetch failing");
  });

  // --- fetchGa4Evidence() with compareToPreviousPeriod ------------------

  await test("fetchGa4Evidence() WITH compareToPreviousPeriod issues TWO calls with IDENTICAL dimensions/metrics/dimensionFilter, equal-length non-overlapping windows, and populates comparisonWindow/observed.previousPeriod", async () => {
    configureAllIntegrations();
    const { fetchGa4Evidence } = freshModule("../agent/lib/firstparty-fetch");
    const calls = [];
    const fetchImpl = async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      const body = JSON.parse(init.body);
      calls.push(body);
      const isCurrent = calls.length === 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          dimensionHeaders: [{ name: "landingPage" }],
          metricHeaders: [{ name: "sessions" }],
          rows: [{ dimensionValues: [{ value: "/golden-junk-removal.html" }], metricValues: [{ value: isCurrent ? "40" : "25" }] }],
        }),
      };
    };

    const result = await fetchGa4Evidence({
      scope: { type: "page", value: "golden-junk-removal.html" },
      dimensions: ["landingPage"],
      metrics: ["sessions"],
      compareToPreviousPeriod: true,
      fetchImpl,
    });

    assert.strictEqual(result.skipped, false);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0].dimensions, calls[1].dimensions);
    assert.deepStrictEqual(calls[0].metrics, calls[1].metrics);
    assert.notStrictEqual(calls[0].dateRanges[0].startDate, calls[1].dateRanges[0].startDate);

    assert.ok(result.evidence.comparisonWindow);
    assert.strictEqual(result.evidence.comparisonWindow.end < result.evidence.window.start, true);
    assert.strictEqual(result.evidence.observed.topRows[0].metrics[0], "40");
    assert.strictEqual(result.evidence.observed.previousPeriod.topRows[0].metrics[0], "25");
  });

  await test("fetchGa4Evidence() WITHOUT compareToPreviousPeriod makes exactly ONE GA4 call (unchanged default behavior)", async () => {
    configureAllIntegrations();
    const { fetchGa4Evidence } = freshModule("../agent/lib/firstparty-fetch");
    let calls = 0;
    const fetchImpl = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ dimensionHeaders: [], metricHeaders: [], rows: [] }) };
    };
    const result = await fetchGa4Evidence({ scope: { type: "page", value: "x.html" }, fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(calls, 1);
    assert.strictEqual(result.evidence.comparisonWindow, null);
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
