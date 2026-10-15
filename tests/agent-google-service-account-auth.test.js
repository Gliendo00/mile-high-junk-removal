// Site Improvement Agent, Phase 6 — tests for agent/lib/google-service-
// account-auth.js (the shared JWT-bearer OAuth2 token exchange). Never
// hits the real network: a genuine (throwaway, test-only) RSA keypair is
// generated in-process so the JWT signing path is exercised for real,
// and the token endpoint itself is a fake `fetchImpl` — no googleapis/
// google-auth-library dependency, no network.
//
// Run with:  node tests/agent-google-service-account-auth.test.js

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

const ORIGINAL_ENV = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = ORIGINAL_ENV;
}

function freshModule() {
  delete require.cache[require.resolve("../agent/lib/google-service-account-auth")];
  return require("../agent/lib/google-service-account-auth");
}

function generateFakeServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return { client_email: "fake-agent@example-project.iam.gserviceaccount.com", private_key: privateKey };
}

function decodeJwtPayload(token) {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

async function main() {
  await test("isGoogleServiceAccountConfigured() is false when GOOGLE_SERVICE_ACCOUNT_JSON is unset", () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const { isGoogleServiceAccountConfigured } = freshModule();
    assert.strictEqual(isGoogleServiceAccountConfigured(), false);
  });

  await test("isGoogleServiceAccountConfigured() is false for malformed JSON, or JSON missing client_email/private_key", () => {
    const { isGoogleServiceAccountConfigured } = freshModule();
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "{not json";
    assert.strictEqual(isGoogleServiceAccountConfigured(), false);
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "a@b.com" }); // no private_key
    assert.strictEqual(isGoogleServiceAccountConfigured(), false);
  });

  await test("getAccessToken() returns {skipped:true} and attempts NO network call when unconfigured", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const { getAccessToken } = freshModule();
    let called = false;
    const result = await getAccessToken("https://example.com/scope", { fetchImpl: () => { called = true; } });
    assert.strictEqual(result.skipped, true);
    assert.ok(/not configured/i.test(result.reason));
    assert.strictEqual(called, false);
  });

  await test("getAccessToken() signs a real RS256 JWT and exchanges it at the token endpoint via the injected fetchImpl", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(generateFakeServiceAccount());
    const { getAccessToken, TOKEN_ENDPOINT } = freshModule();

    let capturedUrl = null;
    let capturedBody = null;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedBody = init.body;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "fake-access-token", expires_in: 3600 }),
      };
    };

    const result = await getAccessToken("https://www.googleapis.com/auth/webmasters.readonly", { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.accessToken, "fake-access-token");
    assert.strictEqual(capturedUrl, TOKEN_ENDPOINT);

    const params = new URLSearchParams(capturedBody);
    assert.strictEqual(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = params.get("assertion");
    assert.strictEqual(assertion.split(".").length, 3, "assertion must be a 3-part JWT");
    const payload = decodeJwtPayload(assertion);
    assert.strictEqual(payload.scope, "https://www.googleapis.com/auth/webmasters.readonly");
    assert.strictEqual(payload.aud, TOKEN_ENDPOINT);
  });

  await test("getAccessToken() degrades to {skipped:true} (never thrown) when the token endpoint returns an error", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(generateFakeServiceAccount());
    const { getAccessToken } = freshModule();
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: "invalid_grant", error_description: "bad assertion" }) });
    const result = await getAccessToken("some-scope", { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/invalid_grant|bad assertion/.test(result.reason));
  });

  await test("getAccessToken() degrades to {skipped:true} (never thrown) when fetchImpl itself throws", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(generateFakeServiceAccount());
    const { getAccessToken } = freshModule();
    const fetchImpl = async () => { throw new Error("network unreachable"); };
    const result = await getAccessToken("some-scope", { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/network unreachable/.test(result.reason));
  });

  restoreEnv();
  freshModule();

  if (process.exitCode) process.exit(process.exitCode);
}

main();
