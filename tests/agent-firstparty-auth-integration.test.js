// Site Improvement Agent, Phase 6 auth-hardening — end-to-end
// integration tests proving two things the narrow per-module tests
// don't, on their own, fully demonstrate:
//
//   1. GSC/GA4/URL Inspection behavior through the REAL client+fetch
//      layer (search-console-client.js, ga4-client.js,
//      firstparty-fetch.js) is unchanged by the auth-hardening refactor
//      — now exercised via the NEW preferred tier (impersonation), not
//      just the legacy tier the earlier Phase 6 tests used.
//   2. No credential material (refresh token, client secret, private
//      key, or even the short-lived access token itself) is ever
//      persisted to a written evidence file on disk — the full
//      fetch -> normalize -> write pipeline, not just the auth layer in
//      isolation.
//
// No real network, no real gcloud install: every fetch is injected, and
// the "ADC file" is a throwaway fixture in a temp directory.
//
// Run with:  node tests/agent-firstparty-auth-integration.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

const ENV_VARS = ["GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SERVICE_ACCOUNT_JSON", "GSC_SITE_URL", "GA4_PROPERTY_ID"];
const ORIGINAL_ENV = {};
for (const key of ENV_VARS) ORIGINAL_ENV[key] = process.env[key];
function restoreEnv() {
  for (const key of ENV_VARS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

function freshModule(name) {
  delete require.cache[require.resolve(name)];
  return require(name);
}
function freshAuthModules() {
  for (const n of ["google-auth", "google-adc", "google-impersonation", "google-service-account-auth", "search-console-client", "ga4-client", "firstparty-fetch"]) {
    delete require.cache[require.resolve(`../agent/lib/${n}`)];
  }
}

function tokenThenApi(apiHandler) {
  return async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return { ok: true, status: 200, json: async () => ({ access_token: "base-adc-token-SHOULD-NOT-PERSIST", expires_in: 3600 }) };
    }
    if (url.includes("iamcredentials.googleapis.com")) {
      return { ok: true, status: 200, json: async () => ({ accessToken: "impersonated-token-SHOULD-NOT-PERSIST", expireTime: "2026-10-14T05:00:00Z" }) };
    }
    return apiHandler(url, init);
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-firstparty-auth-integration-test-"));
  const adcFile = path.join(tmpDir, "adc.json");
  fs.writeFileSync(adcFile, JSON.stringify({ type: "authorized_user", client_id: "a", client_secret: "CLIENT-SECRET-SHOULD-NOT-PERSIST", refresh_token: "REFRESH-TOKEN-SHOULD-NOT-PERSIST" }), "utf8");

  await test("fetchSearchAnalyticsEvidence() succeeds end-to-end through the NEW preferred (impersonation) tier, and writes a file containing NO credential/token material", async () => {
    for (const key of ENV_VARS) delete process.env[key];
    process.env.GOOGLE_APPLICATION_CREDENTIALS = adcFile;
    process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com";
    process.env.GSC_SITE_URL = "https://www.milehighjunkremoval.net/";
    freshAuthModules();
    const { fetchSearchAnalyticsEvidence, writeFirstPartyEvidence } = require("../agent/lib/firstparty-fetch");

    const fetchImpl = tokenThenApi(() => ({
      ok: true,
      status: 200,
      json: async () => ({ rows: [{ keys: ["aurora junk removal"], clicks: 3, impressions: 90, ctr: 0.033, position: 9.1 }] }),
    }));

    const result = await fetchSearchAnalyticsEvidence({
      findingKey: "coverage-gap-candidate::aurora-junk-removal.html",
      scope: { type: "city", value: "Aurora" },
      fetchImpl,
    });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.evidence.source, "search-console-search-analytics");

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-firstparty-auth-integration-write-"));
    try {
      const filePath = writeFirstPartyEvidence(result.evidence, undefined, outDir);
      const onDisk = fs.readFileSync(filePath, "utf8");
      for (const secret of ["base-adc-token-SHOULD-NOT-PERSIST", "impersonated-token-SHOULD-NOT-PERSIST", "CLIENT-SECRET-SHOULD-NOT-PERSIST", "REFRESH-TOKEN-SHOULD-NOT-PERSIST"]) {
        assert.strictEqual(onDisk.includes(secret), false, `"${secret}" must never be persisted to the evidence file`);
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  await test("fetchGa4Evidence() also succeeds end-to-end through the impersonation tier, unaffected by the auth refactor", async () => {
    for (const key of ENV_VARS) delete process.env[key];
    process.env.GOOGLE_APPLICATION_CREDENTIALS = adcFile;
    process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com";
    process.env.GA4_PROPERTY_ID = "549425042";
    freshAuthModules();
    const { fetchGa4Evidence } = require("../agent/lib/firstparty-fetch");

    const fetchImpl = tokenThenApi(() => ({
      ok: true,
      status: 200,
      json: async () => ({ dimensionHeaders: [{ name: "landingPage" }], metricHeaders: [{ name: "sessions" }], rows: [{ dimensionValues: [{ value: "/aurora-junk-removal.html" }], metricValues: [{ value: "12" }] }] }),
    }));

    const result = await fetchGa4Evidence({ scope: { type: "page", value: "aurora-junk-removal.html" }, fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.evidence.source, "ga4");
  });

  await test("report.firstPartyEvidence never contains credential material even when integrations ARE configured via impersonation", async () => {
    for (const key of ENV_VARS) delete process.env[key];
    process.env.GOOGLE_APPLICATION_CREDENTIALS = adcFile;
    process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com";
    process.env.GSC_SITE_URL = "https://www.milehighjunkremoval.net/";
    process.env.GA4_PROPERTY_ID = "549425042";
    freshAuthModules();
    const { buildReport } = require("../agent/lib/report");
    const { isSearchConsoleConfigured } = require("../agent/lib/search-console-client");
    const { isGa4Configured } = require("../agent/lib/ga4-client");

    const record = {
      runId: "r1",
      timestamp: "2026-10-14T04:00:00.000Z",
      runType: "daily",
      mode: "dry-run",
      summary: { pagesScanned: 51, byCategory: {} },
      findings: [],
      validation: { performed: false, confirmed: 0, reverted: 0 },
      proposalsSync: { skipped: true, reason: "sync disabled for this run" },
    };
    const report = buildReport({ record, previousRun: null, firstPartyIntegrations: { searchConsole: isSearchConsoleConfigured(), ga4: isGa4Configured() } });
    assert.strictEqual(report.firstPartyEvidence.integrations.searchConsole, true);
    assert.strictEqual(report.firstPartyEvidence.integrations.ga4, true);
    const json = JSON.stringify(report);
    for (const secret of ["CLIENT-SECRET-SHOULD-NOT-PERSIST", "REFRESH-TOKEN-SHOULD-NOT-PERSIST", "mile-high-site-agent@"]) {
      assert.strictEqual(json.includes(secret), false, `"${secret}" must never appear in report.firstPartyEvidence`);
    }
  });

  restoreEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
