// Site Improvement Agent, Phase 6 — tests for agent/lib/firstparty-
// fetch.js (the one module that touches the network for Search
// Console/GA4). No real network: fetchImpl is always injected. Covers:
// graceful skip when not configured, correct normalization end-to-end,
// the MAX_ROWS cap, the GA4 visitor-identifier dimension privacy guard,
// and that writeFirstPartyEvidence() never persists a raw API payload.
//
// Run with:  node tests/agent-firstparty-fetch.test.js

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

function tokenOrApi(apiHandler) {
  return async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return { ok: true, status: 200, json: async () => ({ access_token: "fake-token", expires_in: 3600 }) };
    }
    return apiHandler(url, init);
  };
}

function configureAllIntegrations() {
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
  process.env.GSC_SITE_URL = "https://www.milehighjunkremoval.net/";
  process.env.GA4_PROPERTY_ID = "123456789";
}

function clearIntegrations() {
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GSC_SITE_URL;
  delete process.env.GA4_PROPERTY_ID;
}

async function main() {
  await test("fetchSearchAnalyticsEvidence() skips gracefully (never throws) when Search Console isn't configured", async () => {
    clearIntegrations();
    const { fetchSearchAnalyticsEvidence } = freshModule("../agent/lib/firstparty-fetch");
    const result = await fetchSearchAnalyticsEvidence({ scope: { type: "city", value: "Aurora" } });
    assert.strictEqual(result.skipped, true);
  });

  await test("fetchSearchAnalyticsEvidence() normalizes real-shaped rows into bounded, validated evidence, capped at MAX_ROWS", async () => {
    configureAllIntegrations();
    const { fetchSearchAnalyticsEvidence, MAX_ROWS } = freshModule("../agent/lib/firstparty-fetch");

    const manyRows = Array.from({ length: MAX_ROWS + 20 }, (_, i) => ({
      keys: [`query ${i}`],
      clicks: i,
      impressions: i * 10,
      ctr: 0.01,
      position: 10,
      rawOnlyMarker: `should-never-be-persisted-${i}`, // simulates extra raw API fields we must not store
    }));
    const fetchImpl = tokenOrApi(() => ({ ok: true, status: 200, json: async () => ({ rows: manyRows }) }));

    const result = await fetchSearchAnalyticsEvidence({
      findingKey: "coverage-gap-candidate::aurora-junk-removal.html",
      scope: { type: "city", value: "Aurora" },
      days: 28,
      fetchImpl,
    });

    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.evidence.source, "search-console-search-analytics");
    assert.ok(result.evidence.observed.topRows.length <= MAX_ROWS, "observed.topRows must be capped at MAX_ROWS");
    assert.ok(result.evidence.window.start && result.evidence.window.end && result.evidence.window.label);
    assert.strictEqual(JSON.stringify(result.evidence).includes("rawOnlyMarker"), false, "raw-only API fields must never survive normalization");
  });

  await test("fetchSearchAnalyticsEvidence()/fetchUrlInspectionEvidence()/fetchGa4Evidence() all thread `rotationSlug` straight through to the written evidence, exactly like `findingKey` — the real bug this guards against: buildRotationEvidenceRequest()'s rotationSlug being silently dropped so a rotation pick's evidence could never attach back to it", async () => {
    configureAllIntegrations();
    const { fetchSearchAnalyticsEvidence, fetchUrlInspectionEvidence, fetchGa4Evidence } = freshModule("../agent/lib/firstparty-fetch");

    const saResult = await fetchSearchAnalyticsEvidence({
      rotationSlug: "golden",
      scope: { type: "city", value: "Golden" },
      days: 28,
      fetchImpl: tokenOrApi(() => ({ ok: true, status: 200, json: async () => ({ rows: [] }) })),
    });
    assert.strictEqual(saResult.skipped, false);
    assert.strictEqual(saResult.evidence.rotationSlug, "golden");
    assert.strictEqual(saResult.evidence.findingKey, null, "findingKey must stay null when only rotationSlug was requested — the two key spaces never both populate from one request");

    const uiResult = await fetchUrlInspectionEvidence({
      rotationSlug: "golden",
      urls: ["https://www.milehighjunkremoval.net/golden-junk-removal.html"],
      fetchImpl: tokenOrApi(() => ({ ok: true, status: 200, json: async () => ({ inspectionResult: { indexStatusResult: { verdict: "PASS" } } }) })),
    });
    assert.strictEqual(uiResult.skipped, false);
    assert.strictEqual(uiResult.evidence[0].rotationSlug, "golden");

    const ga4Result = await fetchGa4Evidence({
      rotationSlug: "golden",
      scope: { type: "city", value: "Golden" },
      fetchImpl: tokenOrApi(() => ({ ok: true, status: 200, json: async () => ({ dimensionHeaders: [], metricHeaders: [], rows: [] }) })),
    });
    assert.strictEqual(ga4Result.skipped, false);
    assert.strictEqual(ga4Result.evidence.rotationSlug, "golden");
  });

  await test("fetchSearchAnalyticsEvidence() threads `requestFingerprint` straight through to the written evidence when the caller supplies one, and defaults to null when it doesn't — finding-evidence.js's needsFindingEvidenceRefresh() relies on this", async () => {
    configureAllIntegrations();
    const { fetchSearchAnalyticsEvidence } = freshModule("../agent/lib/firstparty-fetch");

    const withFingerprint = await fetchSearchAnalyticsEvidence({
      findingKey: "content-gap::blog-seasonal-cleanout-guide.html",
      scope: { type: "page", value: "blog-seasonal-cleanout-guide.html" },
      requestFingerprint: "seasonal cleanout guide",
      fetchImpl: tokenOrApi(() => ({ ok: true, status: 200, json: async () => ({ rows: [] }) })),
    });
    assert.strictEqual(withFingerprint.skipped, false);
    assert.strictEqual(withFingerprint.evidence.requestFingerprint, "seasonal cleanout guide");

    const withoutFingerprint = await fetchSearchAnalyticsEvidence({
      findingKey: "content-gap::furniture-removal.html",
      scope: { type: "page", value: "furniture-removal.html" },
      fetchImpl: tokenOrApi(() => ({ ok: true, status: 200, json: async () => ({ rows: [] }) })),
    });
    assert.strictEqual(withoutFingerprint.skipped, false);
    assert.strictEqual(withoutFingerprint.evidence.requestFingerprint, null);
  });

  await test("fetchUrlInspectionEvidence() produces one evidence entry per URL and never leaks the raw inspectionResult payload", async () => {
    configureAllIntegrations();
    const { fetchUrlInspectionEvidence } = freshModule("../agent/lib/firstparty-fetch");
    const fetchImpl = tokenOrApi(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        inspectionResult: {
          indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", googleCanonical: "https://x/a", userCanonical: "https://x/a", rawOnlyMarker: "nope" },
          mobileUsabilityResult: { rawOnlyMarker: "should never appear" },
        },
      }),
    }));
    const urls = ["https://www.milehighjunkremoval.net/aurora-junk-removal.html", "https://www.milehighjunkremoval.net/parker-junk-removal.html"];
    const result = await fetchUrlInspectionEvidence({ urls, fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.evidence.length, 2);
    for (const entry of result.evidence) {
      assert.strictEqual(entry.source, "search-console-url-inspection");
      assert.strictEqual(JSON.stringify(entry).includes("rawOnlyMarker"), false);
      assert.strictEqual(JSON.stringify(entry).includes("mobileUsabilityResult"), false, "only indexStatusResult fields are ever normalized");
    }
  });

  await test("fetchGa4Evidence() refuses a visitor/client-identifier dimension and makes NO request at all (privacy boundary)", async () => {
    configureAllIntegrations();
    const { fetchGa4Evidence } = freshModule("../agent/lib/firstparty-fetch");
    let called = false;
    for (const dim of ["userId", "userPseudoId", "clientId", "appInstanceId"]) {
      called = false;
      const result = await fetchGa4Evidence({
        scope: { type: "page", value: "aurora-junk-removal.html" },
        dimensions: [dim],
        fetchImpl: () => { called = true; },
      });
      assert.strictEqual(result.skipped, true);
      assert.ok(/visitor\/client-identifier/.test(result.reason));
      assert.strictEqual(called, false, `no request should ever be sent for forbidden dimension "${dim}"`);
    }
  });

  await test("fetchGa4Evidence() normalizes a real-shaped report, capped at MAX_ROWS, raw fields stripped", async () => {
    configureAllIntegrations();
    const { fetchGa4Evidence, MAX_ROWS } = freshModule("../agent/lib/firstparty-fetch");
    const manyRows = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({
      dimensionValues: [{ value: `/page-${i}` }],
      metricValues: [{ value: String(i) }],
    }));
    const fetchImpl = tokenOrApi(() => ({
      ok: true,
      status: 200,
      json: async () => ({ dimensionHeaders: [{ name: "landingPage" }], metricHeaders: [{ name: "sessions" }], rows: manyRows }),
    }));
    const result = await fetchGa4Evidence({ scope: { type: "page", value: "aurora-junk-removal.html" }, fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.evidence.source, "ga4");
    assert.ok(result.evidence.observed.topRows.length <= MAX_ROWS);
  });

  await test("writeFirstPartyEvidence() writes a new, distinct file per call (git-tracked, diffable evidence — never a rolling overwrite)", () => {
    const { writeFirstPartyEvidence } = freshModule("../agent/lib/firstparty-fetch");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-firstparty-fetch-write-test-"));
    try {
      const entry1 = { source: "ga4", metric: "sessions", scope: { type: "page", value: "a.html" }, window: { start: "x", end: "y", label: "z" }, observed: {}, context: "c", limitations: "l", findingKey: "k1", dimension: null, comparisonWindow: null, fetchedAt: new Date().toISOString() };
      const path1 = writeFirstPartyEvidence(entry1, undefined, tmpDir);
      const path2 = writeFirstPartyEvidence({ ...entry1, findingKey: "k2" }, undefined, tmpDir);
      assert.notStrictEqual(path1, path2);
      assert.strictEqual(fs.readdirSync(tmpDir).length, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test("writeFirstPartyEvidence() output file never contains a raw API payload marker end-to-end (fetch -> write -> read back)", async () => {
    configureAllIntegrations();
    const { fetchSearchAnalyticsEvidence, writeFirstPartyEvidence } = freshModule("../agent/lib/firstparty-fetch");
    const fetchImpl = tokenOrApi(() => ({
      ok: true,
      status: 200,
      json: async () => ({ rows: [{ keys: ["q"], clicks: 1, impressions: 2, ctr: 0.5, position: 3, extraRawField: "leak-marker-xyz" }] }),
    }));
    const result = await fetchSearchAnalyticsEvidence({ scope: { type: "city", value: "Aurora" }, fetchImpl });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-firstparty-fetch-e2e-test-"));
    try {
      const filePath = writeFirstPartyEvidence(result.evidence, undefined, tmpDir);
      const onDisk = fs.readFileSync(filePath, "utf8");
      assert.strictEqual(onDisk.includes("leak-marker-xyz"), false);
      const parsed = JSON.parse(onDisk);
      assert.ok(Array.isArray(parsed));
      assert.strictEqual(parsed[0].source, "search-console-search-analytics");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test("fetchFirstPartyEvidence() dispatcher routes by type and rejects an unknown type without throwing", async () => {
    clearIntegrations();
    const { fetchFirstPartyEvidence } = freshModule("../agent/lib/firstparty-fetch");
    const result = await fetchFirstPartyEvidence({ type: "something-else" });
    assert.strictEqual(result.skipped, true);
    assert.ok(/unknown first-party evidence request type/.test(result.reason));
  });

  clearIntegrations();

  if (process.exitCode) process.exit(process.exitCode);
}

main();
