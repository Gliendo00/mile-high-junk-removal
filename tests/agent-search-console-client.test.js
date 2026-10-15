// Site Improvement Agent, Phase 6 — tests for agent/lib/search-console-
// client.js. No real network: a fake `fetchImpl` handles both the OAuth
// token endpoint and the Search Console endpoints, and asserts the
// request shape (method/URL/body) rather than trusting a live API.
//
// Run with:  node tests/agent-search-console-client.test.js

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

function makeFetchStub({ onTokenRequest, onApiRequest } = {}) {
  return async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      if (onTokenRequest) onTokenRequest(url, init);
      return { ok: true, status: 200, json: async () => ({ access_token: "fake-token", expires_in: 3600 }) };
    }
    if (onApiRequest) onApiRequest(url, init);
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

async function main() {
  await test("isSearchConsoleConfigured() is false without GSC_SITE_URL, even with a service account configured", () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GSC_SITE_URL;
    const { isSearchConsoleConfigured } = freshModule("../agent/lib/search-console-client");
    assert.strictEqual(isSearchConsoleConfigured(), false);
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
    const reloaded = freshModule("../agent/lib/search-console-client");
    assert.strictEqual(reloaded.isSearchConsoleConfigured(), false); // still no GSC_SITE_URL
  });

  await test("querySearchAnalytics() returns {skipped:true} and makes no request when GSC_SITE_URL is missing", async () => {
    delete process.env.GSC_SITE_URL;
    const { querySearchAnalytics } = freshModule("../agent/lib/search-console-client");
    let called = false;
    const result = await querySearchAnalytics({ startDate: "2026-09-01", endDate: "2026-09-28", fetchImpl: () => { called = true; } });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(called, false);
  });

  await test("querySearchAnalytics() builds the correct endpoint/body and returns normalized rows", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
    process.env.GSC_SITE_URL = "https://www.milehighjunkremoval.net/";
    const { querySearchAnalytics } = freshModule("../agent/lib/search-console-client");

    let apiUrl = null;
    let apiBody = null;
    const fetchImpl = makeFetchStub({
      onApiRequest: (url, init) => {
        apiUrl = url;
        apiBody = JSON.parse(init.body);
      },
    });
    // Override the json() for the API call specifically — reuse the stub but intercept.
    const wrapped = async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") return fetchImpl(url, init);
      apiUrl = url;
      apiBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ rows: [{ keys: ["junk removal aurora"], clicks: 3, impressions: 90, ctr: 0.033, position: 9.1 }] }) };
    };

    const result = await querySearchAnalytics({
      startDate: "2026-09-13",
      endDate: "2026-10-10",
      dimensions: ["query"],
      rowLimit: 10,
      fetchImpl: wrapped,
    });

    assert.strictEqual(result.skipped, false);
    assert.ok(apiUrl.startsWith("https://www.googleapis.com/webmasters/v3/sites/"));
    assert.ok(apiUrl.includes("searchAnalytics/query"));
    assert.deepStrictEqual(apiBody.dimensions, ["query"]);
    assert.strictEqual(apiBody.startDate, "2026-09-13");
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].clicks, 3);
  });

  await test("querySearchAnalytics() degrades to {skipped:true} (never thrown) on an API error response", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
    process.env.GSC_SITE_URL = "https://www.milehighjunkremoval.net/";
    const { querySearchAnalytics } = freshModule("../agent/lib/search-console-client");
    const fetchImpl = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      return { ok: false, status: 429, json: async () => ({ error: { message: "Quota exceeded" } }) };
    };
    const result = await querySearchAnalytics({ startDate: "a", endDate: "b", fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/Quota exceeded/.test(result.reason));
  });

  await test("inspectUrl() builds the correct endpoint/body and returns the raw inspectionResult", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
    process.env.GSC_SITE_URL = "https://www.milehighjunkremoval.net/";
    const { inspectUrl } = freshModule("../agent/lib/search-console-client");

    let apiUrl = null;
    let apiBody = null;
    const fetchImpl = async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      apiUrl = url;
      apiBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } }) };
    };

    const result = await inspectUrl({ inspectionUrl: "https://www.milehighjunkremoval.net/aurora-junk-removal.html", fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(apiUrl, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
    assert.strictEqual(apiBody.inspectionUrl, "https://www.milehighjunkremoval.net/aurora-junk-removal.html");
    assert.strictEqual(result.result.indexStatusResult.verdict, "PASS");
  });

  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GSC_SITE_URL;

  if (process.exitCode) process.exit(process.exitCode);
}

main();
