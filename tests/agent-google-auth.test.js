// Site Improvement Agent, Phase 6 auth-hardening — tests for
// agent/lib/google-auth.js, the unified resolver search-console-
// client.js/ga4-client.js now import getAccessToken()/
// isGoogleAuthConfigured() from. Proves the exact tier priority
// (impersonation > direct ADC file > legacy service-account key > last-
// resort metadata server), that explicit configuration is used directly
// with ZERO wasted network attempts toward a lower tier (the regression
// this file exists for — see the "no metadata-server pollution" test),
// that nothing falls through silently on a configured-but-failing tier,
// and that no credential material ever leaks into a returned result.
//
// Run with:  node tests/agent-google-auth.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
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

const ENV_VARS = ["GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SERVICE_ACCOUNT_JSON"];
const ORIGINAL_ENV = {};
for (const key of ENV_VARS) ORIGINAL_ENV[key] = process.env[key];

function clearAllAuthEnv() {
  for (const key of ENV_VARS) delete process.env[key];
}

function restoreEnv() {
  for (const key of ENV_VARS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

function freshModule() {
  for (const name of ["google-auth", "google-adc", "google-impersonation", "google-service-account-auth"]) {
    delete require.cache[require.resolve(`../agent/lib/${name}`)];
  }
  return require("../agent/lib/google-auth");
}

function fakeServiceAccountJson() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return JSON.stringify({ client_email: "fake-legacy-sa@example.iam.gserviceaccount.com", private_key: privateKey });
}

let tmpDir;
function pointAdcAt(filename, data) {
  const filePath = path.join(tmpDir, filename);
  if (data !== undefined) fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  process.env.GOOGLE_APPLICATION_CREDENTIALS = filePath;
  return filePath;
}

function pointAdcAtNothing() {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(tmpDir, "nonexistent-" + Math.random().toString(36).slice(2) + ".json");
}

async function main() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-google-auth-test-"));

  await test("isGoogleAuthConfigured() is false when nothing at all is configured", () => {
    clearAllAuthEnv();
    pointAdcAtNothing();
    const { isGoogleAuthConfigured } = freshModule();
    assert.strictEqual(isGoogleAuthConfigured(), false);
  });

  await test("isGoogleAuthConfigured() is true for each of the three tiers independently", () => {
    clearAllAuthEnv();
    pointAdcAtNothing();
    process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "sa@example.com";
    assert.strictEqual(freshModule().isGoogleAuthConfigured(), true);

    clearAllAuthEnv();
    pointAdcAt("adc.json", { type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" });
    assert.strictEqual(freshModule().isGoogleAuthConfigured(), true);

    clearAllAuthEnv();
    pointAdcAtNothing();
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
    assert.strictEqual(freshModule().isGoogleAuthConfigured(), true);
  });

  await test("TIER 1 (impersonation): configured + base ADC succeeds -> uses the base token to impersonate the configured service account", async () => {
    clearAllAuthEnv();
    pointAdcAt("authorized-user.json", { type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" });
    process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com";
    const { getAccessToken } = freshModule();

    const calledUrls = [];
    const fetchImpl = async (url, init) => {
      calledUrls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        return { ok: true, status: 200, json: async () => ({ access_token: "base-adc-token", expires_in: 3600 }) };
      }
      if (url.includes("iamcredentials.googleapis.com")) {
        assert.strictEqual(init.headers.Authorization, "Bearer base-adc-token");
        return { ok: true, status: 200, json: async () => ({ accessToken: "impersonated-token", expireTime: "2026-10-14T05:00:00Z" }) };
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await getAccessToken("https://www.googleapis.com/auth/webmasters.readonly", { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.accessToken, "impersonated-token");
    assert.strictEqual(result.source, "impersonation");
    assert.ok(calledUrls.some((u) => u.includes("iamcredentials.googleapis.com")));
  });

  await test("TIER 1 (impersonation): configured but base ADC fails -> honest skip naming BOTH facts, and NEVER falls through to an also-configured legacy key", async () => {
    clearAllAuthEnv();
    pointAdcAtNothing(); // no ADC file at all
    process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com";
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson(); // also configured — must be ignored
    const { getAccessToken } = freshModule();

    let legacyTokenEndpointCalled = false;
    const fetchImpl = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") legacyTokenEndpointCalled = true;
      // Simulate: no metadata server either (not on GCP compute).
      throw new Error("getaddrinfo ENOTFOUND metadata.google.internal");
    };

    const result = await getAccessToken("some-scope", { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/Impersonation configured/.test(result.reason));
    assert.strictEqual(legacyTokenEndpointCalled, false, "a configured-but-failing impersonation tier must never silently fall through to the legacy key");
  });

  // --- Phase 7C: GOOGLE_IMPERSONATE_SERVICE_ACCOUNT validation --------
  // Root cause: a real production run sent a value containing embedded
  // newlines (literally "<email>\nGSC_SITE_URL <value>\nGA4_PROPERTY_ID
  // <value>") all the way to google-impersonation.js's URL-building,
  // which Google rejected only after a network round trip, with an
  // opaque error naming the whole garbled string. Every other link in
  // the pipeline (this workflow's env: blocks, google-github-actions/
  // auth's own outputs, process.env, every line of code that reads this
  // variable) was traced and found to do no concatenation/parsing at
  // all — see agent/lib/google-auth.js's validateServiceAccountEmail()
  // header for the full writeup. These tests prove the defensive catch
  // this phase adds, and that the three variables genuinely stay
  // independent end to end.

  await test("validateServiceAccountEmail(): a well-formed service-account email is valid (returns null)", () => {
    const { validateServiceAccountEmail } = freshModule();
    assert.strictEqual(validateServiceAccountEmail("mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com"), null);
    assert.strictEqual(validateServiceAccountEmail("123456789-compute@developer.gserviceaccount.com"), null);
  });

  await test("validateServiceAccountEmail(): catches the EXACT real-incident shape — other config lines appended via embedded newlines — and names the real email on the first line", () => {
    const { validateServiceAccountEmail } = freshModule();
    const corrupted = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com\nGSC_SITE_URL sc-domain:milehighjunkremoval.net\nGA4_PROPERTY_ID 549425042";
    const problem = validateServiceAccountEmail(corrupted);
    assert.ok(problem, "a multi-line value must be rejected");
    assert.ok(/2 unexpected newline/.test(problem));
    assert.ok(/mile-high-site-agent@mile-high-site-agent\.iam\.gserviceaccount\.com/.test(problem), "should surface the real (first-line) email for diagnosis");
  });

  await test("validateServiceAccountEmail(): catches plain whitespace (space/tab), and a value missing the gserviceaccount.com domain", () => {
    const { validateServiceAccountEmail } = freshModule();
    assert.ok(/whitespace/.test(validateServiceAccountEmail("sa@example.com extra text")));
    assert.ok(/whitespace/.test(validateServiceAccountEmail("sa@example.com\textra")));
    assert.ok(/valid service-account email/.test(validateServiceAccountEmail("not-a-service-account@gmail.com")));
    assert.ok(/valid service-account email/.test(validateServiceAccountEmail("no-at-sign.iam.gserviceaccount.com")));
  });

  await test("TIER 1 (impersonation): a malformed/multi-line GOOGLE_IMPERSONATE_SERVICE_ACCOUNT fails IMMEDIATELY — zero network calls at all, not even the base-ADC fetch — and NEVER falls through to an also-configured legacy key", async () => {
    clearAllAuthEnv();
    pointAdcAt("authorized-user.json", { type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" }); // base ADC WOULD succeed if ever attempted
    process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT =
      "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com\nGSC_SITE_URL sc-domain:milehighjunkremoval.net\nGA4_PROPERTY_ID 549425042";
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson(); // also configured — must be ignored
    const { getAccessToken } = freshModule();

    let anyFetchCalled = false;
    const fetchImpl = async (url) => {
      anyFetchCalled = true;
      throw new Error(`should never be called — got ${url}`);
    };

    const result = await getAccessToken("https://www.googleapis.com/auth/webmasters.readonly", { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/Impersonation configured, but GOOGLE_IMPERSONATE_SERVICE_ACCOUNT/.test(result.reason));
    assert.ok(/unexpected newline/.test(result.reason));
    assert.strictEqual(anyFetchCalled, false, "a malformed email must be caught before any network call — no base-ADC fetch, no IAM Credentials request");
  });

  await test("the three Google/first-party env vars (GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, GSC_SITE_URL, GA4_PROPERTY_ID) stay three fully independent, exact values end to end — none is read, trimmed, or combined by any of the others' consumers", async () => {
    clearAllAuthEnv();
    pointAdcAt("authorized-user.json", { type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" });
    const EXACT_EMAIL = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com";
    const EXACT_GSC = "sc-domain:milehighjunkremoval.net";
    const EXACT_GA4 = "549425042";
    process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = EXACT_EMAIL;
    process.env.GSC_SITE_URL = EXACT_GSC;
    process.env.GA4_PROPERTY_ID = EXACT_GA4;

    const { getAccessToken } = freshModule();
    delete require.cache[require.resolve("../agent/lib/search-console-client")];
    delete require.cache[require.resolve("../agent/lib/ga4-client")];
    const { isSearchConsoleConfigured } = require("../agent/lib/search-console-client");
    const { isGa4Configured } = require("../agent/lib/ga4-client");

    let capturedAccountIdSegment = null;
    const fetchImpl = async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return { ok: true, status: 200, json: async () => ({ access_token: "base-adc-token", expires_in: 3600 }) };
      }
      if (url.includes("iamcredentials.googleapis.com")) {
        // The account-id path segment must be EXACTLY the email, encoded —
        // never the email plus the other two variables' names/values.
        capturedAccountIdSegment = decodeURIComponent(url.match(/serviceAccounts\/([^:]+):generateAccessToken/)[1]);
        return { ok: true, status: 200, json: async () => ({ accessToken: "impersonated-token", expireTime: "2026-10-15T05:00:00Z" }) };
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await getAccessToken("https://www.googleapis.com/auth/webmasters.readonly", { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(capturedAccountIdSegment, EXACT_EMAIL, "the IAM Credentials request must use EXACTLY the email — no concatenation with GSC_SITE_URL/GA4_PROPERTY_ID");

    // Each variable is still exactly what it was set to — reading/using
    // one never mutated or consumed another.
    assert.strictEqual(process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, EXACT_EMAIL);
    assert.strictEqual(process.env.GSC_SITE_URL, EXACT_GSC);
    assert.strictEqual(process.env.GA4_PROPERTY_ID, EXACT_GA4);
    assert.strictEqual(isSearchConsoleConfigured(), true);
    assert.strictEqual(isGa4Configured(), true);

    delete process.env.GSC_SITE_URL;
    delete process.env.GA4_PROPERTY_ID;
  });

  await test("TIER 2 (direct ADC file) beats TIER 3 (legacy key) when both are configured and impersonation is not", async () => {
    clearAllAuthEnv();
    pointAdcAt("authorized-user.json", { type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" });
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson(); // also configured — must be ignored
    const { getAccessToken } = freshModule();

    let adcRefreshCalled = false;
    const fetchImpl = async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") {
        const params = new URLSearchParams(init.body);
        if (params.get("grant_type") === "refresh_token") adcRefreshCalled = true;
        return { ok: true, status: 200, json: async () => ({ access_token: "adc-token", expires_in: 3600 }) };
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await getAccessToken("some-scope", { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.source, "adc-authorized-user");
    assert.strictEqual(adcRefreshCalled, true);
  });

  await test('TIER 3 (legacy key) used directly when configured alone — ZERO metadata-server network attempt ("no pollution" regression)', async () => {
    clearAllAuthEnv();
    pointAdcAtNothing(); // no ADC file
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
    const { getAccessToken } = freshModule();

    const calledUrls = [];
    const fetchImpl = async (url, init) => {
      calledUrls.push(url);
      assert.strictEqual(url, "https://oauth2.googleapis.com/token", "the legacy tier must call the OAuth token endpoint directly, never the metadata server first");
      const params = new URLSearchParams(init.body);
      assert.strictEqual(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      return { ok: true, status: 200, json: async () => ({ access_token: "legacy-token", expires_in: 3600 }) };
    };

    const result = await getAccessToken("https://www.googleapis.com/auth/analytics.readonly", { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.source, "service-account-key");
    assert.strictEqual(calledUrls.length, 1, "exactly one request — no wasted metadata-server probe before the configured legacy key is used");
    assert.ok(!calledUrls[0].includes("metadata.google.internal"));
  });

  await test("LAST RESORT: nothing explicit configured -> metadata server attempted and succeeds via injected fetchImpl", async () => {
    clearAllAuthEnv();
    pointAdcAtNothing();
    const { getAccessToken } = freshModule();
    const fetchImpl = async (url) => {
      assert.ok(url.startsWith("http://metadata.google.internal/"));
      return { ok: true, status: 200, json: async () => ({ access_token: "metadata-token", expires_in: 3600 }) };
    };
    const result = await getAccessToken("some-scope", { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.source, "adc-metadata-server");
  });

  await test("LAST RESORT: nothing configured and metadata server unreachable -> honest final skip, never thrown", async () => {
    clearAllAuthEnv();
    pointAdcAtNothing();
    const { getAccessToken } = freshModule();
    const fetchImpl = async () => { throw new Error("getaddrinfo ENOTFOUND metadata.google.internal"); };
    const result = await getAccessToken("some-scope", { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(result.reason);
  });

  await test("no credential material (refresh token, client secret, private key) ever appears in a getAccessToken() result, across all three tiers", async () => {
    // Tier 3 (legacy key) with a real secret-shaped private key.
    clearAllAuthEnv();
    pointAdcAtNothing();
    const serviceAccountJson = fakeServiceAccountJson();
    const parsedSa = JSON.parse(serviceAccountJson);
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = serviceAccountJson;
    const mod1 = freshModule();
    const result1 = await mod1.getAccessToken("scope", {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: "t1", expires_in: 3600 }) }),
    });
    assert.strictEqual(JSON.stringify(result1).includes(parsedSa.private_key), false);

    // Tier 2 (direct ADC) with a real secret-shaped refresh token.
    clearAllAuthEnv();
    pointAdcAt("authorized-user-2.json", { type: "authorized_user", client_id: "a", client_secret: "SECRET-2", refresh_token: "REFRESH-2" });
    const mod2 = freshModule();
    const result2 = await mod2.getAccessToken("scope", {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: "t2", expires_in: 3600 }) }),
    });
    assert.strictEqual(JSON.stringify(result2).includes("SECRET-2"), false);
    assert.strictEqual(JSON.stringify(result2).includes("REFRESH-2"), false);
  });

  await test("google-adc.js, google-impersonation.js, and google-auth.js contain zero console.* calls — these are pure library modules, nothing is ever logged (defense in depth against an accidental debug log leaking a token)", () => {
    for (const name of ["google-adc", "google-impersonation", "google-auth"]) {
      const source = fs.readFileSync(require.resolve(`../agent/lib/${name}`), "utf8");
      assert.strictEqual(/console\./.test(source), false, `${name}.js must not call console.*`);
    }
  });

  restoreEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
