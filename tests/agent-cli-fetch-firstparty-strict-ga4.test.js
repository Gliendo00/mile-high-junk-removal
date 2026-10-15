// Site Improvement Agent, Phase 7E — tests for agent/cli.js's
// --fetch-firstparty-strict= handling of the Golden GA4 diagnostic
// (.github/workflows/website-agent.yml's diagnostic-golden-ga4
// run_type). Mirrors tests/agent-cli-fetch-firstparty-strict.test.js
// (the Search Console diagnostic's own test file) as closely as
// possible: SAME CLI entry point (runFetchFirstParty()), SAME strict/
// non-strict behavior, SAME zero-result-is-success rule — the only
// difference is the request `type` ("ga4" instead of
// "search-analytics") and the Google endpoint being mocked.
//
// agent/cli.js itself needed NO changes for this diagnostic:
// --fetch-firstparty-strict= was already generic over request.type
// ("search-analytics" | "url-inspection" | "ga4" — see
// agent/lib/firstparty-fetch.js's fetchFirstPartyEvidence() dispatcher),
// so this file proves the EXISTING path handles "ga4" requests exactly
// as it already handles "search-analytics" ones, with zero new
// networking code.
//
// Run with:  node tests/agent-cli-fetch-firstparty-strict-ga4.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runFetchFirstParty, parseFetchFirstPartyStrictArg } = require("../agent/cli");
const { FORBIDDEN_GA4_DIMENSION_PATTERNS } = require("../agent/lib/firstparty-fetch");

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
  const filePath = path.join(os.tmpdir(), `cli-fetch-firstparty-strict-ga4-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(request), "utf8");
  return filePath;
}

const COMMITTED_REQUEST_PATH = path.join(__dirname, "..", "agent", "diagnostics", "golden-ga4-request.json");
const GOLDEN_GA4_REQUEST = JSON.parse(fs.readFileSync(COMMITTED_REQUEST_PATH, "utf8"));

async function main() {
  await test("the committed Golden GA4 diagnostic request file has the expected shape: ga4, 28 days, whole-site scope, date dimension, sessions/screenPageViews metrics, rotationSlug golden-ga4", () => {
    assert.strictEqual(GOLDEN_GA4_REQUEST.type, "ga4");
    assert.strictEqual(GOLDEN_GA4_REQUEST.rotationSlug, "golden-ga4");
    assert.deepStrictEqual(GOLDEN_GA4_REQUEST.scope, { type: "site", value: "milehighjunkremoval.net" });
    assert.strictEqual(GOLDEN_GA4_REQUEST.days, 28);
    assert.deepStrictEqual(GOLDEN_GA4_REQUEST.dimensions, ["date"]);
    assert.deepStrictEqual(GOLDEN_GA4_REQUEST.metrics, ["sessions", "screenPageViews"]);
    assert.ok(typeof GOLDEN_GA4_REQUEST.context === "string" && GOLDEN_GA4_REQUEST.context.length > 0);
  });

  await test("the committed request deliberately avoids conversions/keyEvents — only universally-available, automatically-collected GA4 metrics are requested (no dependency on this property's own conversion/key-event configuration)", () => {
    for (const metric of GOLDEN_GA4_REQUEST.metrics) {
      assert.ok(!/conversion/i.test(metric) && !/keyEvent/i.test(metric), `metric "${metric}" depends on conversion/key-event configuration — the diagnostic must only use metrics guaranteed present on every GA4 property`);
    }
  });

  await test("the committed request's dimensions never match a visitor/client-identifier pattern (privacy boundary, same guard fetchGa4Evidence() enforces at the fetch layer)", () => {
    for (const dim of GOLDEN_GA4_REQUEST.dimensions) {
      for (const pattern of FORBIDDEN_GA4_DIMENSION_PATTERNS) {
        assert.strictEqual(pattern.test(dim), false, `dimension "${dim}" unexpectedly matches forbidden pattern ${pattern}`);
      }
    }
  });

  await test("the committed request is NOT scoped/filtered to a landingPage for \"Golden\" — Golden has no dedicated page, so a page-level filter would mean nothing in GA4 (unlike the Search Console diagnostic, which legitimately filters by query text)", () => {
    assert.notStrictEqual(GOLDEN_GA4_REQUEST.scope.type, "page");
    assert.strictEqual(GOLDEN_GA4_REQUEST.dimensionFilter, undefined, "no dimensionFilter should be present — this is a whole-site aggregate, not a per-page or per-query filter");
  });

  await test("parseFetchFirstPartyStrictArg() extracts the path, and never matches a plain --fetch-firstparty= argument", () => {
    assert.strictEqual(parseFetchFirstPartyStrictArg(["--fetch-firstparty-strict=a/b.json"]), "a/b.json");
    assert.strictEqual(parseFetchFirstPartyStrictArg(["--fetch-firstparty=a/b.json"]), null);
    assert.strictEqual(parseFetchFirstPartyStrictArg([]), null);
  });

  await test("STRICT mode: a {skipped:true} result (e.g. GA4_PROPERTY_ID/auth misconfiguration) sets process.exitCode = 1 and never writes an evidence file", async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    const requestPath = tmpRequestFile(GOLDEN_GA4_REQUEST);
    try {
      const savedEnv = {
        GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT,
        GA4_PROPERTY_ID: process.env.GA4_PROPERTY_ID,
        GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
        GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      };
      // Deliberately NOT configured in this test's env -> a genuine,
      // real-shaped {skipped:true} from the real fetchFirstPartyEvidence()
      // dispatch, same as a real misconfigured runner would produce.
      delete process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT;
      delete process.env.GA4_PROPERTY_ID;
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
    const requestPath = tmpRequestFile(GOLDEN_GA4_REQUEST);
    try {
      delete process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT;
      delete process.env.GA4_PROPERTY_ID;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      await runFetchFirstParty(requestPath); // options omitted -> non-strict, same as today
      assert.strictEqual(process.exitCode, before === undefined ? undefined : before, "non-strict mode must NOT set exitCode on a skip");
    } finally {
      fs.unlinkSync(requestPath);
      process.exitCode = before;
    }
  });

  await test("STRICT mode: a REAL, successful fetch — including a legitimate ZERO-ROW GA4 response — is NEVER treated as a failure, IS written as a normal evidence file, and carries no raw payload / visitor identifiers", async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    const requestPath = tmpRequestFile(GOLDEN_GA4_REQUEST);
    const adcPath = tmpRequestFile({ type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" });
    const { EVIDENCE_DIR } = require("../agent/lib/firstparty-fetch");
    const filesBefore = new Set(fs.existsSync(EVIDENCE_DIR) ? fs.readdirSync(EVIDENCE_DIR) : []);
    try {
      process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com";
      process.env.GA4_PROPERTY_ID = "549425042";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;

      // Inject a successful, ZERO-ROW response at the lowest level this
      // test can reach without reorganizing cli.js: monkey-patch global
      // fetch for the duration of this call only, covering the ADC token
      // refresh, the IAM Credentials impersonation call, and the GA4
      // Data API runReport call.
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        if (url === "https://oauth2.googleapis.com/token") {
          return { ok: true, status: 200, json: async () => ({ access_token: "fake-token", expires_in: 3600 }) };
        }
        if (String(url).includes("iamcredentials.googleapis.com")) {
          return { ok: true, status: 200, json: async () => ({ accessToken: "fake-impersonated-token", expireTime: "2026-10-16T00:00:00Z" }) };
        }
        if (String(url).includes("analyticsdata.googleapis.com")) {
          // The legitimate zero-row response — proves a real, well-formed
          // GA4 Data API call succeeded and simply found nothing, which
          // must be treated identically to any other successful count.
          return { ok: true, status: 200, json: async () => ({ dimensionHeaders: [{ name: "date" }], metricHeaders: [{ name: "sessions" }, { name: "screenPageViews" }], rows: [] }) };
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

      assert.strictEqual(entry.source, "ga4");
      assert.strictEqual(entry.rotationSlug, "golden-ga4");
      assert.strictEqual(entry.findingKey, null);
      assert.strictEqual(entry.observed.totalRowsReturned, 0, "the zero-row count must be represented honestly, not hidden or treated as an error");
      assert.deepStrictEqual(entry.observed.topRows, []);

      // Privacy / normalization guarantees — the written evidence must be
      // the normalized firstparty-evidence.js shape ONLY, never the raw
      // GA4 API response (no dimensionHeaders/metricHeaders passthrough,
      // no property id, no client/user identifiers anywhere in the file).
      const serialized = JSON.stringify(written);
      assert.strictEqual(/dimensionHeaders|metricHeaders/.test(serialized), false, "raw GA4 API response shape must never be persisted");
      assert.strictEqual(/clientId|userId|userPseudoId|appInstanceId|ipOverride/i.test(serialized), false, "no visitor/client-identifier field name may appear in persisted evidence");
      assert.strictEqual(serialized.includes(process.env.GA4_PROPERTY_ID), false, "the GA4 property id itself must not be persisted into the evidence file");
    } finally {
      delete process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT;
      delete process.env.GA4_PROPERTY_ID;
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
