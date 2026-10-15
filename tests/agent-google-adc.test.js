// Site Improvement Agent, Phase 6 auth-hardening (+ Phase 7 GitHub
// Actions runner follow-up) — tests for agent/lib/google-adc.js
// (Application Default Credentials loader: a credential FILE —
// "authorized_user" from `gcloud auth application-default login`, a
// "service_account" key file, or a URL-sourced "external_account"
// Workload Identity Federation config (e.g. GitHub Actions OIDC, as
// written by google-github-actions/auth) — or, as a last resort, the
// GCE/Cloud Run metadata server). No real network,
// no real gcloud install required: every fetch is injected, and every
// "file" is a throwaway fixture written to a temp directory and pointed
// at via GOOGLE_APPLICATION_CREDENTIALS (never this machine's real
// %APPDATA%\gcloud\ path, so these tests are deterministic regardless of
// whether the developer has ever run `gcloud auth application-default
// login` on this machine).
//
// Run with:  node tests/agent-google-adc.test.js

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

function freshModule() {
  delete require.cache[require.resolve("../agent/lib/google-adc")];
  delete require.cache[require.resolve("../agent/lib/google-service-account-auth")];
  return require("../agent/lib/google-adc");
}

const ORIGINAL_GAC = process.env.GOOGLE_APPLICATION_CREDENTIALS;
let tmpDir;

function writeAdcFixture(filename, data) {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  process.env.GOOGLE_APPLICATION_CREDENTIALS = filePath;
  return filePath;
}

function pointAtNonexistentFile() {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(tmpDir, "does-not-exist.json");
}

function fakeServiceAccountCredential() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return { type: "service_account", client_email: "fake-sa@example.iam.gserviceaccount.com", private_key: privateKey };
}

async function main() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-google-adc-test-"));

  await test("isAdcFileConfigured() is false when GOOGLE_APPLICATION_CREDENTIALS points at a nonexistent file", () => {
    pointAtNonexistentFile();
    const { isAdcFileConfigured } = freshModule();
    assert.strictEqual(isAdcFileConfigured(), false);
  });

  await test("isAdcFileConfigured() is true once a credential file actually exists at that path", () => {
    writeAdcFixture("exists.json", { type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" });
    const { isAdcFileConfigured } = freshModule();
    assert.strictEqual(isAdcFileConfigured(), true);
  });

  await test('getAdcAccessToken() exchanges an "authorized_user" refresh token correctly, and never echoes the refresh token/client secret back', async () => {
    writeAdcFixture("authorized-user.json", {
      type: "authorized_user",
      client_id: "fake-client-id.apps.googleusercontent.com",
      client_secret: "SUPER-SECRET-DO-NOT-LEAK",
      refresh_token: "REFRESH-TOKEN-DO-NOT-LEAK",
    });
    const { getAdcAccessToken } = freshModule();

    let capturedUrl = null;
    let capturedBody = null;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedBody = init.body;
      return { ok: true, status: 200, json: async () => ({ access_token: "fake-access-token", expires_in: 3600 }) };
    };

    const result = await getAdcAccessToken("https://www.googleapis.com/auth/cloud-platform", { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.accessToken, "fake-access-token");
    assert.strictEqual(result.source, "adc-authorized-user");
    assert.strictEqual(capturedUrl, "https://oauth2.googleapis.com/token");

    const params = new URLSearchParams(capturedBody);
    assert.strictEqual(params.get("grant_type"), "refresh_token");
    assert.strictEqual(params.get("client_id"), "fake-client-id.apps.googleusercontent.com");

    const resultJson = JSON.stringify(result);
    assert.strictEqual(resultJson.includes("SUPER-SECRET-DO-NOT-LEAK"), false, "client_secret must never appear in the returned result");
    assert.strictEqual(resultJson.includes("REFRESH-TOKEN-DO-NOT-LEAK"), false, "refresh_token must never appear in the returned result");
  });

  await test('getAdcAccessToken() delegates a "service_account"-typed ADC file to the real JWT signer, and never echoes the private key', async () => {
    const credential = fakeServiceAccountCredential();
    writeAdcFixture("service-account.json", credential);
    const { getAdcAccessToken } = freshModule();

    const fetchImpl = async (url) => {
      assert.strictEqual(url, "https://oauth2.googleapis.com/token");
      return { ok: true, status: 200, json: async () => ({ access_token: "fake-sa-token", expires_in: 3600 }) };
    };

    const result = await getAdcAccessToken("https://www.googleapis.com/auth/webmasters.readonly", { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.accessToken, "fake-sa-token");
    assert.strictEqual(result.source, "service-account-key");
    assert.strictEqual(JSON.stringify(result).includes(credential.private_key), false);
  });

  function githubActionsExternalAccountFixture() {
    return {
      type: "external_account",
      audience: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/github-actions-pool/providers/github-actions-provider",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: {
        url: "https://token.actions.githubusercontent.com/.well-known/fake?audience=...",
        headers: { Authorization: "Bearer GH-ACTIONS-RUNTIME-TOKEN-DO-NOT-LEAK" },
        format: { type: "json", subject_token_field_name: "value" },
      },
    };
  }

  await test('getAdcAccessToken() resolves a URL-sourced "external_account" (Workload Identity Federation / GitHub Actions OIDC) file via subject-token fetch + STS exchange, and never echoes the subject token/bearer header', async () => {
    writeAdcFixture("external-account.json", githubActionsExternalAccountFixture());
    const { getAdcAccessToken } = freshModule();

    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (String(url).startsWith("https://token.actions.githubusercontent.com/")) {
        assert.strictEqual(init.headers.Authorization, "Bearer GH-ACTIONS-RUNTIME-TOKEN-DO-NOT-LEAK");
        return { ok: true, status: 200, json: async () => ({ value: "GITHUB-OIDC-JWT-DO-NOT-LEAK" }) };
      }
      if (url === "https://sts.googleapis.com/v1/token") {
        const params = new URLSearchParams(init.body);
        assert.strictEqual(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
        assert.strictEqual(params.get("audience"), "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/github-actions-pool/providers/github-actions-provider");
        assert.strictEqual(params.get("scope"), "https://www.googleapis.com/auth/cloud-platform");
        assert.strictEqual(params.get("subject_token"), "GITHUB-OIDC-JWT-DO-NOT-LEAK");
        assert.strictEqual(params.get("subject_token_type"), "urn:ietf:params:oauth:token-type:jwt");
        return { ok: true, status: 200, json: async () => ({ access_token: "fake-federated-token", expires_in: 3599 }) };
      }
      throw new Error(`unexpected fetch to ${url}`);
    };

    const result = await getAdcAccessToken("https://www.googleapis.com/auth/cloud-platform", { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.accessToken, "fake-federated-token");
    assert.strictEqual(result.source, "adc-external-account");
    assert.strictEqual(calls.length, 2);

    const resultJson = JSON.stringify(result);
    assert.strictEqual(resultJson.includes("GITHUB-OIDC-JWT-DO-NOT-LEAK"), false, "the GitHub OIDC subject token must never appear in the returned result");
    assert.strictEqual(resultJson.includes("GH-ACTIONS-RUNTIME-TOKEN-DO-NOT-LEAK"), false, "the bearer header used to fetch it must never appear in the returned result");
  });

  await test('getAdcAccessToken() on "external_account" degrades honestly (no STS attempt) when the subject-token fetch itself fails', async () => {
    writeAdcFixture("external-account-subject-fail.json", githubActionsExternalAccountFixture());
    const { getAdcAccessToken } = freshModule();
    let stsCalled = false;
    const fetchImpl = async (url) => {
      if (String(url).startsWith("https://token.actions.githubusercontent.com/")) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      stsCalled = true;
      throw new Error("STS should never be reached if the subject-token fetch failed");
    };
    const result = await getAdcAccessToken("https://www.googleapis.com/auth/cloud-platform", { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/subject-token request failed/.test(result.reason));
    assert.strictEqual(stsCalled, false);
  });

  await test('getAdcAccessToken() on "external_account" degrades honestly when the STS token exchange itself fails', async () => {
    writeAdcFixture("external-account-sts-fail.json", githubActionsExternalAccountFixture());
    const { getAdcAccessToken } = freshModule();
    const fetchImpl = async (url) => {
      if (String(url).startsWith("https://token.actions.githubusercontent.com/")) {
        return { ok: true, status: 200, json: async () => ({ value: "a-jwt" }) };
      }
      return { ok: false, status: 400, json: async () => ({ error: "invalid_target", error_description: "audience mismatch" }) };
    };
    const result = await getAdcAccessToken("https://www.googleapis.com/auth/cloud-platform", { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/STS token exchange failed/.test(result.reason));
    assert.ok(/audience mismatch/.test(result.reason));
  });

  await test('getAdcAccessToken() refuses a file-sourced "external_account" config honestly — only URL-sourced is supported, no network attempted', async () => {
    writeAdcFixture("external-account-file-sourced.json", {
      type: "external_account",
      audience: "//iam.googleapis.com/...",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { file: "/some/local/token/file" },
    });
    const { getAdcAccessToken } = freshModule();
    let called = false;
    const result = await getAdcAccessToken("some-scope", { fetchImpl: () => { called = true; } });
    assert.strictEqual(result.skipped, true);
    assert.ok(/URL-sourced/i.test(result.reason));
    assert.strictEqual(called, false);
  });

  await test("getAdcAccessToken() degrades honestly (never thrown) on a malformed/unparseable credential file", async () => {
    const filePath = path.join(tmpDir, "broken.json");
    fs.writeFileSync(filePath, "{not valid json", "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = filePath;
    const { getAdcAccessToken } = freshModule();
    const result = await getAdcAccessToken("some-scope", { fetchImpl: () => { throw new Error("should never be called"); } });
    assert.strictEqual(result.skipped, true);
  });

  await test("getAdcAccessToken() degrades honestly on an unrecognized credential file `type`", async () => {
    writeAdcFixture("weird-type.json", { type: "something-else" });
    const { getAdcAccessToken } = freshModule();
    const result = await getAdcAccessToken("some-scope", { fetchImpl: () => { throw new Error("should never be called"); } });
    assert.strictEqual(result.skipped, true);
    assert.ok(/unrecognized type/.test(result.reason));
  });

  await test("getAdcAccessToken() falls back to the GCE/Cloud Run metadata server when no credential file exists, and succeeds via the injected fetchImpl", async () => {
    pointAtNonexistentFile();
    const { getAdcAccessToken } = freshModule();
    let capturedUrl = null;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      assert.strictEqual(init.headers["Metadata-Flavor"], "Google");
      return { ok: true, status: 200, json: async () => ({ access_token: "fake-metadata-token", expires_in: 3600 }) };
    };
    const result = await getAdcAccessToken("https://www.googleapis.com/auth/analytics.readonly", { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.source, "adc-metadata-server");
    assert.ok(capturedUrl.startsWith("http://metadata.google.internal/"));
    assert.ok(capturedUrl.includes("scopes="));
  });

  await test("getAdcAccessToken() degrades honestly (never thrown) when the metadata server is unreachable (the normal case off Google Cloud)", async () => {
    pointAtNonexistentFile();
    const { getAdcAccessToken } = freshModule();
    const fetchImpl = async () => { throw new Error("getaddrinfo ENOTFOUND metadata.google.internal"); };
    const result = await getAdcAccessToken("some-scope", { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/not running on GCP compute|ENOTFOUND/.test(result.reason));
  });

  if (ORIGINAL_GAC === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  else process.env.GOOGLE_APPLICATION_CREDENTIALS = ORIGINAL_GAC;
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
