// Site Improvement Agent, Phase 6 — wiring tests: proves
// agent/runner.js's gatherFindings() attaches `.firstPartyEvidence` to
// every finding, that the real agent/research/firstparty/ directory
// (empty on a fresh checkout, but — as of the first real Phase 6
// production validation — now legitimately holds real, committed
// evidence tied to a real finding, same precedent as
// agent/research/results/'s real Denver LeafDrop files) never throws,
// that decision/category fields are unaffected by whatever first-party
// evidence currently exists there, that the network-free pipeline
// invariant still holds (no fetch/network import reachable from
// gatherFindings' own call graph), and that report.js's
// firstPartyEvidence summary reflects the integrations flag runner.js
// computes — all without touching the real history log or any real
// credentials.
//
// IMPORTANT: these tests must NEVER assert that
// agent/research/firstparty/ is empty — that was true only before any
// real evidence existed, and is not an invariant of the system (see the
// second test below, which asserts the thing that actually matters —
// decision-independence — instead, and is robust to real content).
//
// Run with:  node tests/agent-firstparty-runner.test.js

const assert = require("assert");
const { gatherFindings } = require("../agent/runner");
const { buildReport } = require("../agent/lib/report");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

test("gatherFindings() never throws against the real site content, and every finding carries a `.firstPartyEvidence` array", () => {
  const { findings, firstPartyWarnings } = gatherFindings();
  assert.ok(Array.isArray(findings));
  for (const f of findings) {
    assert.ok(Array.isArray(f.firstPartyEvidence), `finding ${f.key} must have a firstPartyEvidence array`);
  }
  assert.ok(firstPartyWarnings === undefined || Array.isArray(firstPartyWarnings));
});

test("gatherFindings()'s decision/category are unaffected by whatever first-party evidence currently exists in the repo (Phase 6 is additive-only) — proven by re-deciding with it stripped and comparing", () => {
  // Deliberately does NOT assume agent/research/firstparty/ is empty —
  // real evidence may legitimately exist there (see this file's header).
  // Instead, for EVERY finding, re-run decision.js's decide() on a copy
  // with firstPartyEvidence cleared and assert the decision is
  // byte-identical to what gatherFindings() actually produced — this
  // holds regardless of whether zero or several real evidence entries
  // are currently attached, so it can never go stale the way asserting
  // "always empty" did.
  const { decide } = require("../agent/lib/decision");
  const { findings } = gatherFindings();
  for (const f of findings) {
    assert.ok(f.decision, `finding ${f.key} must still have a decision`);
    assert.ok(f.category, `finding ${f.key} must still have a category`);
    assert.ok(Array.isArray(f.firstPartyEvidence), `finding ${f.key} must have a firstPartyEvidence array`);
    for (const entry of f.firstPartyEvidence) {
      assert.strictEqual(entry.findingKey, f.key, `evidence attached to ${f.key} must carry that same findingKey — never misattributed`);
    }
    const redecided = decide({ ...f, firstPartyEvidence: [] });
    assert.strictEqual(redecided.decision, f.decision, `finding ${f.key}'s decision must be unaffected by its attached first-party evidence`);
  }
});

test("agent/runner.js does not require() any network-calling module directly inside gatherFindings' own require graph beyond the pure isXConfigured() checks", () => {
  // Defense-in-depth static check: runner.js imports search-console-
  // client.js/ga4-client.js ONLY for isSearchConsoleConfigured()/
  // isGa4Configured() (pure env-var reads), never querySearchAnalytics/
  // inspectUrl/runReport — confirm that literally, so a future edit that
  // adds a live call inside runner.js fails this test loudly.
  const fs = require("fs");
  const runnerSource = fs.readFileSync(require.resolve("../agent/runner"), "utf8");
  assert.ok(!/querySearchAnalytics|inspectUrl\(|runReport\(/.test(runnerSource), "runner.js must never call a live Search Console/GA4 API function directly");
  assert.ok(/isSearchConsoleConfigured/.test(runnerSource) && /isGa4Configured/.test(runnerSource));
});

test("buildReport()'s firstPartyEvidence summary reflects the integrations flag passed in, independent of whether any evidence was gathered", () => {
  const record = {
    runId: "r1",
    timestamp: "2026-10-14T04:00:00.000Z",
    runType: "daily",
    mode: "dry-run",
    summary: { pagesScanned: 51, byCategory: {} },
    findings: [],
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSync: { skipped: true, reason: "sync disabled for this run" },
  };

  const neither = buildReport({ record, previousRun: null, firstPartyIntegrations: { searchConsole: false, ga4: false } });
  assert.deepStrictEqual(neither.firstPartyEvidence.integrations, { searchConsole: false, ga4: false });
  assert.strictEqual(neither.firstPartyEvidence.gatheredThisRunCount, 0);

  const both = buildReport({ record, previousRun: null, firstPartyIntegrations: { searchConsole: true, ga4: true } });
  assert.deepStrictEqual(both.firstPartyEvidence.integrations, { searchConsole: true, ga4: true });

  const omitted = buildReport({ record, previousRun: null });
  assert.deepStrictEqual(omitted.firstPartyEvidence.integrations, { searchConsole: false, ga4: false });
});

test("buildReport()'s firstPartyEvidence summary is built from findings' attached evidence, never from a live call, and never changes healthSummary/status by itself", () => {
  const { makeFirstPartyEvidence } = require("../agent/lib/firstparty-evidence");
  const evidence = makeFirstPartyEvidence({
    findingKey: "coverage-gap-candidate::aurora-junk-removal.html",
    source: "ga4",
    metric: "sessions",
    scope: { type: "page", value: "aurora-junk-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: 1, topRows: [] },
    context: "c",
    limitations: "l",
  });
  const record = {
    runId: "r1",
    timestamp: "2026-10-14T04:00:00.000Z",
    runType: "daily",
    mode: "dry-run",
    summary: { pagesScanned: 51, byCategory: {} },
    findings: [
      { key: "coverage-gap-candidate::aurora-junk-removal.html", type: "coverage-gap-candidate", tier: "opportunity", decision: "RESEARCH_MORE", status: "proposed", pages: ["aurora-junk-removal.html"], firstPartyEvidence: [evidence], researchQuestion: { findingKey: "k", question: "q", internalEvidence: [], suggestedSourceTypes: [] } },
    ],
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSync: { skipped: true, reason: "sync disabled for this run" },
  };

  const report = buildReport({ record, previousRun: null, firstPartyIntegrations: { searchConsole: true, ga4: true } });
  assert.strictEqual(report.firstPartyEvidence.gatheredThisRunCount, 1);
  assert.strictEqual(report.firstPartyEvidence.countsBySource.ga4, 1);
  // The finding is RESEARCH_MORE purely because of its own category/tier
  // (unchanged by this phase) — status must still be research_pending
  // REGARDLESS of first-party evidence being present and plentiful.
  assert.strictEqual(report.status, "research_pending");
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
