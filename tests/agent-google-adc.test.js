// Site Improvement Agent, Phase 6 auth-hardening — tests for
// agent/lib/google-adc.js (Application Default Credentials loader: a
// credential FILE — "authorized_user" from `gcloud auth
// application-default login`, or a "service_account" key file — or, as
// a last resort, the GCE/Cloud Run metadata server). No real network,
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

  await test('getAdcAccessToken() refuses an "external_account" (Workload Identity Federation) file honestly — not yet supported, no network attempted', async () => {
    writeAdcFixture("external-account.json", { type: "external_account", audience: "//iam.googleapis.com/...", token_url: "https://sts.googleapis.com/v1/token" });
    const { getAdcAccessToken } = freshModule();
    let called = false;
    const result = await getAdcAccessToken("some-scope", { fetchImpl: () => { called = true; } });
    assert.strictEqual(result.skipped, true);
    assert.ok(/Workload Identity Federation|not yet supported/i.test(result.reason));
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
