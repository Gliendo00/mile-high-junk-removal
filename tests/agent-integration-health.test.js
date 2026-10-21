// CRM cleanup/verification audit (2026-10-21) — unit coverage for
// agent/lib/integration-health.js: the module backing the new
// `node agent/cli.js --check-integrations` step, which runs a REAL probe
// against Search Console and GA4 (not just an env-var presence check)
// and persists the outcome for the Website Agent dashboard to read
// instead of checking these env vars itself (never provisioned to
// Vercel — see that file's own header).
//
// Run with:  node tests/agent-integration-health.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkIntegrationHealth, writeIntegrationHealth, loadIntegrationHealth } = require("../agent/lib/integration-health");

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

// Saves/restores process.env keys this module reads, around each test —
// never leaks real credentials between tests, never depends on whatever
// happens to be set in the host environment running this suite.
const ENV_KEYS = ["GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SERVICE_ACCOUNT_JSON", "GSC_SITE_URL", "GA4_PROPERTY_ID"];
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

async function main() {
  await test("checkIntegrationHealth(): with no env vars at all, both integrations report configured:false, ok:null, reason:null — never attempted, never a false CONNECTED", () =>
    withEnv({}, async () => {
      const health = await checkIntegrationHealth();
      assert.deepStrictEqual(health.gsc, { configured: false, ok: null, reason: null });
      assert.deepStrictEqual(health.ga4, { configured: false, ok: null, reason: null });
      assert.ok(typeof health.at === "string" && !Number.isNaN(Date.parse(health.at)));
    }));

  await test("checkIntegrationHealth(): GSC configured but the API call fails reports configured:true, ok:false, with the real reason — never collapsed into not-configured", () =>
    withEnv({ GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: "agent@project.iam.gserviceaccount.com", GSC_SITE_URL: "https://www.milehighjunkremoval.net/" }, async () => {
      const fetchImpl = async (url) => {
        if (String(url).includes("securetoken") || String(url).includes("token")) {
          return { ok: false, status: 403, json: async () => ({ error: "forbidden" }) };
        }
        return { ok: false, status: 403, json: async () => ({ error: { message: "The caller does not have permission" } }) };
      };
      const health = await checkIntegrationHealth({ fetchImpl });
      assert.strictEqual(health.gsc.configured, true);
      assert.strictEqual(health.gsc.ok, false);
      assert.ok(health.gsc.reason, "a reason string must be recorded");
      assert.strictEqual(health.ga4.configured, false, "GA4 was never configured in this scenario, independently of GSC's own result");
    }));

  await test("checkIntegrationHealth(): GA4 configured but the API call fails reports configured:true, ok:false — independent of GSC's own outcome", () =>
    withEnv({ GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: "agent@project.iam.gserviceaccount.com", GA4_PROPERTY_ID: "123456789" }, async () => {
      const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "invalid_grant" } }) });
      const health = await checkIntegrationHealth({ fetchImpl });
      assert.strictEqual(health.ga4.configured, true);
      assert.strictEqual(health.ga4.ok, false);
      assert.ok(health.ga4.reason);
      assert.strictEqual(health.gsc.configured, false);
    }));

  await test("writeIntegrationHealth()/loadIntegrationHealth(): round-trips exactly what was written, to an injected path — never the real repo file in this test", () => {
    const tmpPath = path.join(os.tmpdir(), `integration-health-test-${process.pid}-${Date.now()}.json`);
    try {
      const health = { at: "2026-10-21T00:00:00.000Z", gsc: { configured: true, ok: true, reason: null }, ga4: { configured: false, ok: null, reason: null } };
      writeIntegrationHealth(health, tmpPath);
      const loaded = loadIntegrationHealth(tmpPath);
      assert.deepStrictEqual(loaded, health);
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  await test("loadIntegrationHealth(): a missing file returns null, never throws", () => {
    const tmpPath = path.join(os.tmpdir(), `integration-health-test-missing-${process.pid}-${Date.now()}.json`);
    assert.strictEqual(fs.existsSync(tmpPath), false);
    assert.strictEqual(loadIntegrationHealth(tmpPath), null);
  });

  await test("loadIntegrationHealth(): malformed JSON returns null, never throws — a corrupt side-file must never crash the dashboard", () => {
    const tmpPath = path.join(os.tmpdir(), `integration-health-test-corrupt-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpPath, "{not valid json", "utf8");
      assert.strictEqual(loadIntegrationHealth(tmpPath), null);
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  await test("loadIntegrationHealth(): a well-formed-but-incomplete file (missing gsc/ga4/at) returns null rather than a partially-wrong object", () => {
    const tmpPath = path.join(os.tmpdir(), `integration-health-test-incomplete-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify({ at: "2026-10-21T00:00:00.000Z", gsc: { configured: false, ok: null, reason: null } }), "utf8");
      assert.strictEqual(loadIntegrationHealth(tmpPath), null, "ga4 is missing — must not return a half-valid record");
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  // -----------------------------------------------------------------
  // `node agent/cli.js --check-integrations` wiring (runCheckIntegrations()
  // in agent/cli.js) — exported for testing, same convention as this
  // file's other run*() exports (guarded by `require.main === module`,
  // see cli.js's own footer).
  // -----------------------------------------------------------------
  await test("agent/cli.js: --check-integrations is wired in main()'s dispatch table", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "agent", "cli.js"), "utf8");
    assert.ok(/args\.includes\("--check-integrations"\)/.test(src));
    assert.ok(/await runCheckIntegrations\(\)/.test(src));
  });

  await test("agent/cli.js's runCheckIntegrations(): calling it directly writes the real integration-health.json and never sets a nonzero exit code, even when both integrations are unconfigured — a status check, never a gate", () =>
    withEnv({}, async () => {
      const { runCheckIntegrations } = require("../agent/cli");
      const { HEALTH_PATH, loadIntegrationHealth: load } = require("../agent/lib/integration-health");
      const snapshot = fs.existsSync(HEALTH_PATH) ? fs.readFileSync(HEALTH_PATH, "utf8") : null;
      const originalExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        await runCheckIntegrations();
        assert.strictEqual(process.exitCode, undefined, "must never set a nonzero exit code for an unconfigured-but-not-erroring probe");
        const written = load();
        assert.ok(written, "the real integration-health.json must now exist and be loadable");
        assert.strictEqual(written.gsc.configured, false);
        assert.strictEqual(written.ga4.configured, false);
      } finally {
        process.exitCode = originalExitCode;
        if (snapshot === null) {
          if (fs.existsSync(HEALTH_PATH)) fs.unlinkSync(HEALTH_PATH);
        } else {
          fs.writeFileSync(HEALTH_PATH, snapshot, "utf8");
        }
      }
    }));
}

main();
