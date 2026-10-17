// Site Improvement Agent, Phase 12 — tests for agent/cli.js's
// --refresh-lead-event-evidence command: the real end-to-end wiring
// (gatherFindings() -> isLeadEventEvidenceCandidate() -> two correlated
// GA4 requests -> fetchFirstPartyEvidence() -> writeFirstPartyEvidence()).
//
// ALL network access here is MOCKED via global.fetch — never the real
// GA4 API.
//
// The deterministic SELECTION/REQUEST logic itself (candidate rule,
// exact request shapes, freshness) is unit-tested in isolation in
// tests/agent-lead-event-candidates.test.js — this file proves (1) the
// real site's current content correctly produces ZERO candidates (its
// one real finding-evidence.js candidate is a BLOG page, which this
// narrower rule excludes by design — see lead-event-candidates.js's
// header), and (2) with that one check forced eligible via a scoped
// module-cache override (the same "freshModule" technique
// tests/agent-firstparty-fetch.test.js already uses), the real
// end-to-end fetch/write wiring behaves correctly: two independent
// requests per candidate, each written separately, one half's failure
// never blocking the other.
//
// Run with:  node tests/agent-cli-refresh-lead-event-evidence.test.js

const assert = require("assert");
const fs = require("fs");
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
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
  return JSON.stringify({ client_email: "fake@example.iam.gserviceaccount.com", private_key: privateKey });
}

function filesBeforeIn(dir) {
  return new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
}
function newFilesSince(dir, before) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !before.has(f)) : [];
}
function cleanupNewFiles(dir, before) {
  for (const f of newFilesSince(dir, before)) fs.unlinkSync(path.join(dir, f));
}

async function main() {
  await test("against the REAL site's current content: zero lead-event candidates — the one real finding-evidence.js candidate (blog-seasonal-cleanout-guide.html) is correctly excluded as a blog page, and NO network call is attempted", async () => {
    delete require.cache[require.resolve("../agent/cli")];
    const cli = require("../agent/cli");
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      throw new Error(`unexpected network call with zero real candidates: ${url}`);
    };
    try {
      const outcomes = await cli.runRefreshLeadEventEvidence();
      assert.deepStrictEqual(outcomes, []);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("FORCED-ELIGIBLE: with the candidate rule overridden to accept a real finding, runRefreshLeadEventEvidence() fetches BOTH session-context and event-detail independently, writes two separate evidence files, and survives one half failing", async () => {
    // Force the real repo's one existing finding-evidence.js candidate
    // (a blog page) to also be a lead-event candidate, purely for this
    // test — mutating the ALREADY-LOADED lead-event-candidates.js
    // module's own exported function BEFORE cli.js is freshly required,
    // so cli.js's own `const { isLeadEventEvidenceCandidate } =
    // require(...)` destructuring picks up the override. Restored in
    // the `finally` block unconditionally.
    delete require.cache[require.resolve("../agent/lib/lead-event-candidates")];
    const leadEventCandidates = require("../agent/lib/lead-event-candidates");
    const originalIsCandidate = leadEventCandidates.isLeadEventEvidenceCandidate;
    // Target exactly the one real finding this repo currently has
    // (a blog page, normally excluded) rather than every finding, to
    // keep this test fast, exact, and easy to reason about.
    leadEventCandidates.isLeadEventEvidenceCandidate = (finding) => Boolean(finding) && finding.key === "content-gap::blog-seasonal-cleanout-guide.html";

    delete require.cache[require.resolve("../agent/cli")];
    const cli = require("../agent/cli");
    const { EVIDENCE_DIR } = require("../agent/lib/firstparty-fetch");

    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fakeServiceAccountJson();
    process.env.GA4_PROPERTY_ID = "123456789";
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      const body = JSON.parse(init.body);
      const isEventDetail = Array.isArray(body.dimensions) && body.dimensions.some((d) => d.name === "eventName");
      if (isEventDetail) {
        // The ENTIRE event-detail half fails (both its current and
        // comparison calls) — fetchGa4Evidence() itself returns
        // {skipped:true} for it, while the session-context half below
        // succeeds completely. Proves one half's genuine failure never
        // blocks, or crashes, the other half's fetch/write.
        return { ok: false, status: 500, json: async () => ({ error: { message: "backend error" } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          dimensionHeaders: body.dimensions,
          metricHeaders: body.metrics,
          rows: [{ dimensionValues: [{ value: "/blog-seasonal-cleanout-guide.html" }], metricValues: [{ value: "5" }] }],
        }),
      };
    };

    const evidenceBefore = filesBeforeIn(EVIDENCE_DIR);
    try {
      const outcomes = await cli.runRefreshLeadEventEvidence();
      assert.strictEqual(outcomes.length, 2, "exactly one outcome per half, for the one forced-eligible candidate");
      const sessionOutcome = outcomes.find((o) => o.part === "session-context");
      const eventOutcome = outcomes.find((o) => o.part === "event-detail");
      assert.ok(sessionOutcome && eventOutcome, "both halves must be attempted independently");
      assert.strictEqual(sessionOutcome.outcome, "fetched", "the session-context half must succeed on its own");
      assert.strictEqual(eventOutcome.outcome, "skipped", "the event-detail half's genuine failure must be reported as skipped, never silently dropped or crashing the run");
      assert.ok(/backend error/.test(eventOutcome.reason));

      const newFiles = newFilesSince(EVIDENCE_DIR, evidenceBefore);
      assert.strictEqual(newFiles.length, 1, "exactly one evidence file for the successful half — the failed half must write nothing");
    } finally {
      global.fetch = originalFetch;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      delete process.env.GA4_PROPERTY_ID;
      leadEventCandidates.isLeadEventEvidenceCandidate = originalIsCandidate;
      cleanupNewFiles(EVIDENCE_DIR, evidenceBefore);
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
