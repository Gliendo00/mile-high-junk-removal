// Site Improvement Agent, Phase 6 — tests for agent/lib/ga4-client.js. No
// real network: a fake `fetchImpl` handles both the OAuth token endpoint
// and the GA4 Data API endpoint.
//
// Run with:  node tests/agent-ga4-client.test.js

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

function tokenOrApi(apiHandler) {
  return async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return { ok: true, status: 200, json: async () => ({ access_token: "fake-token", expires_in: 3600 }) };
    }
    return apiHandler(url, init);
  };
}

async function main() {
  await test("isGa4Configured() is false without GA4_PROPERTY_ID, even with a service account configured", () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
    delete process.env.GA4_PROPERTY_ID;
    const { isGa4Configured } = freshModule("../agent/lib/ga4-client");
    assert.strictEqual(isGa4Configured(), false);
  });

  await test("runReport() returns {skipped:true} and makes no request when GA4_PROPERTY_ID is missing", async () => {
    delete process.env.GA4_PROPERTY_ID;
    const { runReport } = freshModule("../agent/lib/ga4-client");
    let called = false;
    const result = await runReport({ startDate: "2026-09-17", endDate: "2026-10-14", fetchImpl: () => { called = true; } });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(called, false);
  });

  await test("runReport() builds the correct endpoint/body and returns normalized headers/rows", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
    process.env.GA4_PROPERTY_ID = "123456789";
    const { runReport } = freshModule("../agent/lib/ga4-client");

    let apiUrl = null;
    let apiBody = null;
    const fetchImpl = tokenOrApi((url, init) => {
      apiUrl = url;
      apiBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          dimensionHeaders: [{ name: "landingPage" }],
          metricHeaders: [{ name: "sessions" }],
          rows: [{ dimensionValues: [{ value: "/aurora-junk-removal.html" }], metricValues: [{ value: "42" }] }],
        }),
      };
    });

    const result = await runReport({
      startDate: "2026-09-17",
      endDate: "2026-10-14",
      dimensions: ["landingPage"],
      metrics: ["sessions"],
      fetchImpl,
    });

    assert.strictEqual(result.skipped, false);
    assert.strictEqual(apiUrl, "https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport");
    assert.deepStrictEqual(apiBody.dimensions, [{ name: "landingPage" }]);
    assert.deepStrictEqual(apiBody.metrics, [{ name: "sessions" }]);
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.dimensionHeaders[0].name, "landingPage");
  });

  await test("runReport() degrades to {skipped:true} (never thrown) on an API error response", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
    process.env.GA4_PROPERTY_ID = "123456789";
    const { runReport } = freshModule("../agent/lib/ga4-client");
    const fetchImpl = tokenOrApi(() => ({ ok: false, status: 403, json: async () => ({ error: { message: "The caller does not have permission" } }) }));
    const result = await runReport({ startDate: "a", endDate: "b", fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/permission/.test(result.reason));
  });

  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GA4_PROPERTY_ID;

  if (process.exitCode) process.exit(process.exitCode);
}

main();
