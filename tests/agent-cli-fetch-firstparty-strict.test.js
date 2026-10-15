// Site Improvement Agent, Phase 7D — tests for agent/cli.js's
// --fetch-firstparty-strict= handling: the Golden Search Console
// diagnostic (.github/workflows/website-agent.yml's
// diagnostic-golden-search-console run_type) reuses the EXISTING
// --fetch-firstparty path (fetchFirstPartyEvidence()/
// writeFirstPartyEvidence() — no second Google client or auth path),
// with exactly one behavioral difference from the orchestrator-facing
// --fetch-firstparty=: a {skipped:true} result (misconfiguration, auth
// failure, API error) must fail the process (process.exitCode = 1)
// instead of logging and returning 0 — an unattended diagnostic dispatch
// has no one reading the log in real time, so a swallowed failure would
// look identical to a genuinely successful green run. A real zero-row
// Search Console response is NOT a skip and must still succeed.
//
// agent/cli.js guards its own main()-invocation behind
// `require.main === module` specifically so this file can require() it
// and call runFetchFirstParty() directly without triggering a real
// --daily/--weekly run.
//
// Run with:  node tests/agent-cli-fetch-firstparty-strict.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runFetchFirstParty, parseFetchFirstPartyStrictArg } = require("../agent/cli");

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

function tmpRequestFile(request) {
  const filePath = path.join(os.tmpdir(), `cli-fetch-firstparty-strict-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(request), "utf8");
  return filePath;
}

const GOLDEN_REQUEST = {
  type: "search-analytics",
  rotationSlug: "golden",
  scope: { type: "city", value: "Golden" },
  days: 28,
  dimensions: ["query"],
  dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "contains", expression: "golden" }] }],
  context: "test",
};

async function main() {
  await test("parseFetchFirstPartyStrictArg() extracts the path, and never matches a plain --fetch-firstparty= argument", () => {
    assert.strictEqual(parseFetchFirstPartyStrictArg(["--fetch-firstparty-strict=a/b.json"]), "a/b.json");
    assert.strictEqual(parseFetchFirstPartyStrictArg(["--fetch-firstparty=a/b.json"]), null);
    assert.strictEqual(parseFetchFirstPartyStrictArg([]), null);
  });

  await test("the committed Golden diagnostic request file matches the exact proposed shape: search-analytics, 28 days, query dimension, query-contains-golden filter, rotationSlug: golden", () => {
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "agent", "diagnostics", "golden-search-console-request.json"), "utf8"));
    assert.strictEqual(committed.type, "search-analytics");
    assert.strictEqual(committed.rotationSlug, "golden");
    assert.deepStrictEqual(committed.scope, { type: "city", value: "Golden" });
    assert.strictEqual(committed.days, 28);
    assert.deepStrictEqual(committed.dimensions, ["query"]);
    assert.deepStrictEqual(committed.dimensionFilterGroups, [{ filters: [{ dimension: "query", operator: "contains", expression: "golden" }] }]);
    assert.ok(typeof committed.context === "string" && committed.context.length > 0);
  });

  await test("the committed Golden diagnostic request's structural fields are BYTE-IDENTICAL to rotation-evidence.js's own buildRotationEvidenceRequest() output for Golden — same shape used in production, not a hand-drifted copy", () => {
    const { buildRotationEvidenceRequest } = require("../agent/lib/rotation-evidence");
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "agent", "diagnostics", "golden-search-console-request.json"), "utf8"));
    const generated = buildRotationEvidenceRequest({ slug: "golden", name: "Golden" });
    const { context: committedContext, ...committedRest } = committed;
    const { context: generatedContext, ...generatedRest } = generated;
    assert.deepStrictEqual(committedRest, generatedRest, "every field except `context` must match buildRotationEvidenceRequest()'s real output exactly");
  });

  await test("STRICT mode: a {skipped:true} result (e.g. misconfiguration/auth/API failure) sets process.exitCode = 1 and never writes an evidence file", async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    const requestPath = tmpRequestFile(GOLDEN_REQUEST);
    try {
      // No GOOGLE_IMPERSONATE_SERVICE_ACCOUNT / GSC_SITE_URL configured
      // in this test's env (deliberately not set) -> a genuine,
      // real-shaped {skipped:true} from the real fetchFirstPartyEvidence()
      // dispatch, same as a real misconfigured runner would produce.
      const savedEnv = { GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, GSC_SITE_URL: process.env.GSC_SITE_URL, GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS };
      delete process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT;
      delete process.env.GSC_SITE_URL;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      try {
        await runFetchFirstParty(requestPath, { strict: true });
      } finally {
        for (const [k, v] of Object.entries(savedEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      assert.strictEqual(process.exitCode, 1, "strict mode must fail the process on a skipped (misconfigured/failed) fetch");
    } finally {
      fs.unlinkSync(requestPath);
      process.exitCode = before;
    }
  });

  await test("NON-STRICT mode (the existing, orchestrator-facing --fetch-firstparty= path): the SAME skipped result does NOT fail the process — unchanged, backward-compatible behavior", async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    const requestPath = tmpRequestFile(GOLDEN_REQUEST);
    try {
      delete process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT;
      delete process.env.GSC_SITE_URL;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      await runFetchFirstParty(requestPath); // options omitted -> non-strict, same as today
      assert.strictEqual(process.exitCode, before === undefined ? undefined : before, "non-strict mode must NOT set exitCode on a skip");
    } finally {
      fs.unlinkSync(requestPath);
      process.exitCode = before;
    }
  });

  await test("STRICT mode: a REAL, successful fetch — including a legitimate ZERO-ROW Search Console response — is NEVER treated as a failure, and IS written as a normal evidence file", async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    const requestPath = tmpRequestFile(GOLDEN_REQUEST);
    const adcPath = tmpRequestFile({ type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" });
    const { EVIDENCE_DIR } = require("../agent/lib/firstparty-fetch");
    const filesBefore = new Set(fs.existsSync(EVIDENCE_DIR) ? fs.readdirSync(EVIDENCE_DIR) : []);
    // Cleanup of any newly-written evidence file happens in the OUTER
    // finally below, unconditionally — NOT after the assertions — so a
    // failing assertion (e.g. a regression in rotationSlug pass-through)
    // can never leave a stray file behind in the real, tracked
    // agent/research/firstparty/ directory.
    try {
      process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com";
      process.env.GSC_SITE_URL = "sc-domain:milehighjunkremoval.net";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;

      // Inject a successful, ZERO-ROW response at the lowest level this
      // test can reach without reorganizing cli.js: monkey-patch global
      // fetch for the duration of this call only, covering BOTH the ADC
      // token refresh and the Search Analytics API call.
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        if (url === "https://oauth2.googleapis.com/token") {
          return { ok: true, status: 200, json: async () => ({ access_token: "fake-token", expires_in: 3600 }) };
        }
        if (String(url).includes("iamcredentials.googleapis.com")) {
          return { ok: true, status: 200, json: async () => ({ accessToken: "fake-impersonated-token", expireTime: "2026-10-16T00:00:00Z" }) };
        }
        if (String(url).includes("webmasters/v3/sites")) {
          return { ok: true, status: 200, json: async () => ({ rows: [] }) }; // the legitimate zero-row response
        }
        throw new Error(`unexpected fetch in test: ${url}`);
      };
      try {
        await runFetchFirstParty(requestPath, { strict: true });
      } finally {
        global.fetch = originalFetch;
      }

      assert.strictEqual(process.exitCode, before === undefined ? undefined : before, "a real zero-row success must NOT set a failing exitCode");

      const filesAfter = fs.readdirSync(EVIDENCE_DIR).filter((f) => !filesBefore.has(f));
      assert.strictEqual(filesAfter.length, 1, "exactly one new evidence file should have been written");
      const written = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, filesAfter[0]), "utf8"));
      const entry = Array.isArray(written) ? written[0] : written;
      assert.strictEqual(entry.rotationSlug, "golden");
      assert.strictEqual(entry.observed.totalRowsReturned, 0, "the zero-row count must be represented honestly, not hidden or treated as an error");
    } finally {
      delete process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT;
      delete process.env.GSC_SITE_URL;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      fs.unlinkSync(requestPath);
      fs.unlinkSync(adcPath);
      for (const f of fs.readdirSync(EVIDENCE_DIR)) {
        if (!filesBefore.has(f)) fs.unlinkSync(path.join(EVIDENCE_DIR, f));
      }
      process.exitCode = before;
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
