// Site Improvement Agent, Phase 6 auth-hardening — tests for
// agent/lib/google-impersonation.js (the IAM Credentials API's
// generateAccessToken, used to impersonate mile-high-site-agent@... from
// a human/hosted ADC identity — see that file's header). No real
// network: fetchImpl is always injected.
//
// Run with:  node tests/agent-google-impersonation.test.js

const assert = require("assert");
const { generateImpersonatedAccessToken, IAM_CREDENTIALS_ENDPOINT } = require("../agent/lib/google-impersonation");

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
  await test("generateImpersonatedAccessToken() builds the correct IAM Credentials endpoint/body and returns the short-lived token", async () => {
    let capturedUrl = null;
    let capturedAuth = null;
    let capturedBody = null;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedAuth = init.headers.Authorization;
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ accessToken: "impersonated-fake-token", expireTime: "2026-10-14T05:00:00Z" }) };
    };

    const result = await generateImpersonatedAccessToken({
      serviceAccountEmail: "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      baseAccessToken: "fake-base-token",
      fetchImpl,
    });

    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.accessToken, "impersonated-fake-token");
    assert.strictEqual(result.source, "impersonation");
    assert.strictEqual(
      capturedUrl,
      IAM_CREDENTIALS_ENDPOINT("mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com")
    );
    assert.strictEqual(capturedAuth, "Bearer fake-base-token");
    assert.deepStrictEqual(capturedBody.scope, ["https://www.googleapis.com/auth/webmasters.readonly"]);
  });

  await test("generateImpersonatedAccessToken() returns {skipped:true} and makes no request when serviceAccountEmail is missing", async () => {
    let called = false;
    const result = await generateImpersonatedAccessToken({ scope: "x", baseAccessToken: "y", fetchImpl: () => { called = true; } });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(called, false);
  });

  await test("generateImpersonatedAccessToken() degrades to {skipped:true} (never thrown) when IAM denies Token Creator permission", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "The caller does not have permission (missing roles/iam.serviceAccountTokenCreator)" } }),
    });
    const result = await generateImpersonatedAccessToken({
      serviceAccountEmail: "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com",
      scope: "x",
      baseAccessToken: "y",
      fetchImpl,
    });
    assert.strictEqual(result.skipped, true);
    assert.ok(/serviceAccountTokenCreator|permission/.test(result.reason));
  });

  await test("generateImpersonatedAccessToken() degrades to {skipped:true} (never thrown) when fetchImpl itself throws", async () => {
    const fetchImpl = async () => { throw new Error("network unreachable"); };
    const result = await generateImpersonatedAccessToken({ serviceAccountEmail: "sa@example.com", scope: "x", baseAccessToken: "y", fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/network unreachable/.test(result.reason));
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
