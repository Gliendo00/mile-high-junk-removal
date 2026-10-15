// Site Improvement Agent — tests for agent/cli.js's
// --refresh-finding-evidence command: the real end-to-end wiring
// (gatherFindings() -> candidate selection -> freshness check ->
// fetchFirstPartyEvidence() -> writeFirstPartyEvidence()), the four-way
// outcome classification (fetched / fetched-zero-rows / skipped /
// failed), and — the key correctness proof this phase exists to
// deliver — that a REALISTICALLY-SHAPED Search Console query+page
// response with a genuine mismatch row causes
// agent/lib/firstparty-signals.js's query-page-mismatch classifier to
// actually fire, end to end through a real runner.run() call.
//
// Uses the REAL site's current content-gap/structural-inconsistency
// finding (found dynamically via isQueryPageEvidenceCandidate(), never
// hardcoded) as the target — same "real site content, read-only,
// throwaway log/state path, one real filesystem side effect always
// cleaned up in a finally" convention as
// tests/agent-runner-rotation-evidence.test.js.
//
// Run with:  node tests/agent-cli-refresh-finding-evidence.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const runner = require("../agent/runner");
const { gatherFindings } = runner;
const { runRefreshFindingEvidence, classifyFindingEvidenceOutcome } = require("../agent/cli");
const { isQueryPageEvidenceCandidate } = require("../agent/lib/finding-evidence");
const { writeFirstPartyEvidence, EVIDENCE_DIR } = require("../agent/lib/firstparty-fetch");
const { makeFirstPartyEvidence } = require("../agent/lib/firstparty-evidence");
const config = require("../agent/config");

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

function findRealCandidate() {
  const { findings } = gatherFindings();
  const candidate = findings.find((f) => isQueryPageEvidenceCandidate(f));
  assert.ok(candidate, "expected at least one real content-gap/structural-inconsistency candidate in the current site content for this test to exercise");
  return candidate;
}

const GOOGLE_ENV_KEYS = ["GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "GSC_SITE_URL", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS"];

function saveGoogleEnv() {
  const saved = {};
  for (const k of GOOGLE_ENV_KEYS) saved[k] = process.env[k];
  return saved;
}
function restoreGoogleEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function tmpPath(suffix) {
  return path.join(os.tmpdir(), `agent-cli-refresh-finding-evidence-${process.pid}-${Math.random().toString(36).slice(2)}${suffix}`);
}

function filesBeforeIn(dir) {
  return new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
}
function newFilesSince(dir, before) {
  return fs.readdirSync(dir).filter((f) => !before.has(f));
}
function cleanupNewFiles(dir, before) {
  for (const f of newFilesSince(dir, before)) fs.unlinkSync(path.join(dir, f));
}

async function main() {
  // -----------------------------------------------------------------
  // classifyFindingEvidenceOutcome() — pure classification logic
  // -----------------------------------------------------------------

  await test("classifyFindingEvidenceOutcome(): a successful fetch with rows is 'fetched'", () => {
    assert.strictEqual(classifyFindingEvidenceOutcome({ skipped: false, evidence: { observed: { totalRowsReturned: 2 } } }), "fetched");
  });

  await test("classifyFindingEvidenceOutcome(): a successful fetch with zero rows is 'fetched-zero-rows', never conflated with fetched or with a skip/fail", () => {
    assert.strictEqual(classifyFindingEvidenceOutcome({ skipped: false, evidence: { observed: { totalRowsReturned: 0 } } }), "fetched-zero-rows");
  });

  await test("classifyFindingEvidenceOutcome(): a 'not configured' skip is 'skipped'", () => {
    assert.strictEqual(classifyFindingEvidenceOutcome({ skipped: true, reason: "Search Console not configured (GOOGLE_SERVICE_ACCOUNT_JSON / GSC_SITE_URL missing)" }), "skipped");
  });

  await test("classifyFindingEvidenceOutcome(): a genuine API error is 'failed', NOT 'skipped' — the exact distinction this phase was told to preserve", () => {
    assert.strictEqual(classifyFindingEvidenceOutcome({ skipped: true, reason: "Search Analytics API error: quota exceeded" }), "failed");
    assert.strictEqual(classifyFindingEvidenceOutcome({ skipped: true, reason: "Search Analytics request failed: network timeout" }), "failed");
  });

  await test("classifyFindingEvidenceOutcome(): an auth-resolution problem (impersonation/ADC) is 'failed', not 'skipped' — a real attempt was made and did not succeed", () => {
    assert.strictEqual(
      classifyFindingEvidenceOutcome({ skipped: true, reason: 'Impersonation configured (GOOGLE_IMPERSONATE_SERVICE_ACCOUNT="x@y.iam.gserviceaccount.com") but no base Application Default Credentials were available: ...' }),
      "failed"
    );
  });

  // -----------------------------------------------------------------
  // runRefreshFindingEvidence() — real end-to-end wiring
  // -----------------------------------------------------------------

  await test("with NO Google env configured: the real candidate is correctly identified, the fetch is correctly SKIPPED (not failed), and NO evidence file is written", async () => {
    const saved = saveGoogleEnv();
    for (const k of GOOGLE_ENV_KEYS) delete process.env[k];
    const before = filesBeforeIn(EVIDENCE_DIR);
    try {
      const outcomes = await runRefreshFindingEvidence();
      assert.ok(outcomes.length >= 1, "expected at least the real candidate to have been attempted");
      for (const o of outcomes) {
        assert.strictEqual(o.outcome, "skipped");
        assert.ok(/not configured/i.test(o.reason));
      }
      assert.deepStrictEqual(newFilesSince(EVIDENCE_DIR, before), [], "a skipped fetch must never write an evidence file");
    } finally {
      restoreGoogleEnv(saved);
      cleanupNewFiles(EVIDENCE_DIR, before);
    }
  });

  await test("a candidate finding with FRESH existing evidence is excluded entirely — zero candidates attempted, never a redundant fetch", async () => {
    const target = findRealCandidate();
    const saved = saveGoogleEnv();
    for (const k of GOOGLE_ENV_KEYS) delete process.env[k];
    const freshEvidence = makeFirstPartyEvidence({
      findingKey: target.key,
      source: "search-console-search-analytics",
      metric: "clicks-impressions-ctr-position",
      dimension: "query+page",
      scope: { type: "page", value: target.pages[0] },
      window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
      observed: { totalRowsReturned: 0, topRows: [] },
      context: "test fixture (fresh)",
      limitations: "test fixture",
      fetchedAt: new Date().toISOString(),
    });
    const written = writeFirstPartyEvidence(freshEvidence, "zzz-test-fixture-fresh-finding-evidence.json", EVIDENCE_DIR);
    const before = filesBeforeIn(EVIDENCE_DIR);
    try {
      const outcomes = await runRefreshFindingEvidence();
      assert.strictEqual(outcomes.some((o) => o.findingKey === target.key), false, "a finding with fresh evidence must not be re-attempted");
      assert.deepStrictEqual(newFilesSince(EVIDENCE_DIR, before), []);
    } finally {
      fs.unlinkSync(written);
      restoreGoogleEnv(saved);
      cleanupNewFiles(EVIDENCE_DIR, before);
    }
  });

  await test("STRICT-ANALOG real fetch: a genuine API error (e.g. quota) is classified 'failed', writes NO evidence file, and is never indistinguishable from a real zero-row success", async () => {
    const saved = saveGoogleEnv();
    process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com";
    process.env.GSC_SITE_URL = "sc-domain:milehighjunkremoval.net";
    const adcPath = tmpPath(".adc.json");
    fs.writeFileSync(adcPath, JSON.stringify({ type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" }), "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;

    const before = filesBeforeIn(EVIDENCE_DIR);
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return { ok: true, status: 200, json: async () => ({ access_token: "fake-token", expires_in: 3600 }) };
      }
      if (String(url).includes("iamcredentials.googleapis.com")) {
        return { ok: true, status: 200, json: async () => ({ accessToken: "fake-impersonated-token", expireTime: "2026-10-16T00:00:00Z" }) };
      }
      if (String(url).includes("webmasters/v3/sites")) {
        return { ok: false, status: 429, json: async () => ({ error: { message: "Quota exceeded for this property." } }) };
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    };
    try {
      const outcomes = await runRefreshFindingEvidence();
      assert.ok(outcomes.length >= 1);
      for (const o of outcomes) {
        assert.strictEqual(o.outcome, "failed");
        assert.ok(/quota exceeded/i.test(o.reason));
      }
      assert.deepStrictEqual(newFilesSince(EVIDENCE_DIR, before), [], "a failed fetch must never write an evidence file — never mistakable for a real zero-row result");
    } finally {
      global.fetch = originalFetch;
      restoreGoogleEnv(saved);
      fs.unlinkSync(adcPath);
      cleanupNewFiles(EVIDENCE_DIR, before);
    }
  });

  await test("a real successful fetch with a legitimate ZERO-ROW response is classified 'fetched-zero-rows' and IS written as normal, honest evidence", async () => {
    const saved = saveGoogleEnv();
    process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com";
    process.env.GSC_SITE_URL = "sc-domain:milehighjunkremoval.net";
    const adcPath = tmpPath(".adc.json");
    fs.writeFileSync(adcPath, JSON.stringify({ type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" }), "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;

    const before = filesBeforeIn(EVIDENCE_DIR);
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return { ok: true, status: 200, json: async () => ({ access_token: "fake-token", expires_in: 3600 }) };
      }
      if (String(url).includes("iamcredentials.googleapis.com")) {
        return { ok: true, status: 200, json: async () => ({ accessToken: "fake-impersonated-token", expireTime: "2026-10-16T00:00:00Z" }) };
      }
      if (String(url).includes("webmasters/v3/sites")) {
        return { ok: true, status: 200, json: async () => ({ rows: [] }) };
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    };
    try {
      const outcomes = await runRefreshFindingEvidence();
      assert.ok(outcomes.length >= 1);
      for (const o of outcomes) {
        assert.strictEqual(o.outcome, "fetched-zero-rows");
        assert.strictEqual(o.rows, 0);
      }
      const newFiles = newFilesSince(EVIDENCE_DIR, before);
      assert.strictEqual(newFiles.length, outcomes.length);
      const written = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, newFiles[0]), "utf8"));
      const entry = Array.isArray(written) ? written[0] : written;
      assert.strictEqual(entry.observed.totalRowsReturned, 0);
      assert.strictEqual(entry.dimension, "query+page");
    } finally {
      global.fetch = originalFetch;
      restoreGoogleEnv(saved);
      fs.unlinkSync(adcPath);
      cleanupNewFiles(EVIDENCE_DIR, before);
    }
  });

  // -----------------------------------------------------------------
  // THE KEY PROOF: a realistically-shaped query+page response with a
  // genuine mismatch row makes query-page-mismatch actually fire, end
  // to end through a real runner.run({runType:"weekly"}) call.
  // -----------------------------------------------------------------

  await test("END TO END: a realistic GSC query+page response with a mismatched row flows through --refresh-finding-evidence, gets attached by firstparty-intake.js, and firstparty-signals.js's query-page-mismatch classifier DOES fire on it in a real weekly run", async () => {
    const target = findRealCandidate();
    const saved = saveGoogleEnv();
    process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com";
    process.env.GSC_SITE_URL = "sc-domain:milehighjunkremoval.net";
    const adcPath = tmpPath(".adc.json");
    fs.writeFileSync(adcPath, JSON.stringify({ type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" }), "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;

    const beforeEvidence = filesBeforeIn(EVIDENCE_DIR);
    const originalFetch = global.fetch;
    // A realistically-shaped Search Analytics response: the target
    // page's own topic query (from deriveQueryFilterTerm()) returning
    // results, with the SAME query actually landing on a DIFFERENT real
    // page on this site — a genuine, realistic mismatch, not a
    // synthetic unrelated-page placeholder.
    global.fetch = async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return { ok: true, status: 200, json: async () => ({ access_token: "fake-token", expires_in: 3600 }) };
      }
      if (String(url).includes("iamcredentials.googleapis.com")) {
        return { ok: true, status: 200, json: async () => ({ accessToken: "fake-impersonated-token", expireTime: "2026-10-16T00:00:00Z" }) };
      }
      if (String(url).includes("webmasters/v3/sites")) {
        const body = JSON.parse(init.body);
        assert.deepStrictEqual(body.dimensions, ["query", "page"]);
        assert.strictEqual(body.dimensionFilterGroups[0].filters[0].dimension, "query");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            rows: [
              {
                keys: [body.dimensionFilterGroups[0].filters[0].expression, `${config.SITE_ORIGIN}/contact.html`],
                clicks: 4,
                impressions: 150,
                ctr: 0.0267,
                position: 7.3,
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    };

    const logPath = tmpPath(".ndjson");
    try {
      const refreshOutcomes = await runRefreshFindingEvidence();
      const targetOutcome = refreshOutcomes.find((o) => o.findingKey === target.key);
      assert.ok(targetOutcome, "expected the real candidate to have been fetched");
      assert.strictEqual(targetOutcome.outcome, "fetched");
      assert.strictEqual(targetOutcome.rows, 1);

      const record = await runner.run({ mode: "dry-run", runType: "weekly", logPath, skipLock: true, syncProposals: false, computeRotation: false });
      const persisted = record.findings.find((f) => f.key === target.key);
      assert.ok(persisted, "expected the target finding to appear in the persisted weekly record");
      assert.ok(Array.isArray(persisted.firstPartyEvidence) && persisted.firstPartyEvidence.length === 1);
      assert.ok(Array.isArray(persisted.firstPartySignals) && persisted.firstPartySignals.length === 1, "expected query-page-mismatch to have fired");
      assert.strictEqual(persisted.firstPartySignals[0].type, "query-page-mismatch");
      assert.strictEqual(persisted.firstPartySignals[0].mismatchedQueries.length, 1);
      assert.strictEqual(persisted.firstPartySignals[0].mismatchedQueries[0].observedPage, `${config.SITE_ORIGIN}/contact.html`);

      // And decision.js's own output for this finding is completely
      // unaffected by any of this.
      assert.strictEqual(persisted.decision, target.decision);

      assert.strictEqual(record.report.firstPartySignals.count, 1);
      assert.strictEqual(record.report.firstPartySignals.items[0].type, "query-page-mismatch");
    } finally {
      global.fetch = originalFetch;
      restoreGoogleEnv(saved);
      fs.unlinkSync(adcPath);
      if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
      cleanupNewFiles(EVIDENCE_DIR, beforeEvidence);
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
