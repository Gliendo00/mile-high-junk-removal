// Site Improvement Agent, Phase 6 lifecycle-tightening — tests for
// report.js's new behavior: a NEW first-party-evidence candidate finding
// pauses the run (status "research_pending", the SAME status/resume
// mechanism Phase 5B built for external research — no second lifecycle),
// an older still-open one does not re-block every subsequent run, and
// the report correctly distinguishes evidence gathered DURING this
// logical run from evidence that already existed and was reused — the
// exact gap the first live Phase 6 validation surfaced (see
// agent/README.md's Phase 6 lifecycle-tightening section).
//
// Uses report.js's buildReport() directly with synthetic findings — the
// same established pattern tests/agent-report.test.js already uses —
// never the live site (which has no naturally-occurring candidate
// finding today, since this fix also removed the one real false
// positive — see tests/agent-link-audit.test.js).
//
// Run with:  node tests/agent-firstparty-lifecycle.test.js

const assert = require("assert");
const { buildReport, computeRunStatus, buildHealthSummary } = require("../agent/lib/report");
const { makeFirstPartyEvidence, SOURCES: FIRST_PARTY_SOURCES } = require("../agent/lib/firstparty-evidence");

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

function baseRecord(overrides) {
  return {
    runId: "r1",
    timestamp: "2026-10-15T04:00:00.000Z",
    runType: "daily",
    mode: "dry-run",
    summary: { pagesScanned: 51, byCategory: {} },
    findings: [],
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSync: { skipped: true, reason: "sync disabled for this run" },
    ...overrides,
  };
}

function orphanFinding(overrides) {
  return {
    key: "orphan-page::lonely.html",
    type: "orphan-page",
    tier: "actionable",
    decision: "PROPOSE_CHANGE",
    status: "proposed",
    pages: ["lonely.html"],
    summary: "lonely.html is not linked from any other scanned page.",
    firstPartyEvidence: [],
    ...overrides,
  };
}

function urlInspectionEvidence(overrides) {
  return makeFirstPartyEvidence({
    findingKey: "orphan-page::lonely.html",
    source: "search-console-url-inspection",
    metric: "indexStatus",
    scope: { type: "page", value: "lonely.html" },
    window: { start: "2026-10-15", end: "2026-10-15", label: "point-in-time inspection" },
    observed: { verdict: "PASS", coverageState: "Submitted and indexed" },
    context: "test",
    limitations: "test",
    ...overrides,
  });
}

// -----------------------------------------------------------------------
// computeRunStatus / buildHealthSummary — unit level
// -----------------------------------------------------------------------

test("computeRunStatus: an unresolved first-party-evidence question alone (no research pending) produces 'research_pending'", () => {
  assert.strictEqual(computeRunStatus({ failure: null, hasUnresolvedResearch: false, hasUnresolvedFirstPartyEvidence: true }), "research_pending");
});

test("computeRunStatus: failure still wins over an unresolved first-party-evidence question", () => {
  assert.strictEqual(computeRunStatus({ failure: { message: "x" }, hasUnresolvedResearch: false, hasUnresolvedFirstPartyEvidence: true }), "failed");
});

test("buildHealthSummary names both research and first-party-evidence counts when both are pending, and only the relevant one when just one is", () => {
  const both = buildHealthSummary({ status: "research_pending", questionsPendingCount: 2, firstPartyQuestionsPendingCount: 1 });
  assert.ok(/2 research questions/.test(both.text) && /1 first-party evidence check/.test(both.text));

  const onlyFirstParty = buildHealthSummary({ status: "research_pending", questionsPendingCount: 0, firstPartyQuestionsPendingCount: 1 });
  assert.ok(/1 first-party evidence check/.test(onlyFirstParty.text));
  assert.ok(!/research question/.test(onlyFirstParty.text));
});

// -----------------------------------------------------------------------
// buildReport — integration level
// -----------------------------------------------------------------------

test("a NEW first-party-evidence-candidate finding (not in the previous run) pauses the run — status research_pending, one question raised, health text mentions it, NEVER all-clear/completed", () => {
  const record = baseRecord({ findings: [orphanFinding()] });
  const report = buildReport({ record, previousRun: null, firstPartyIntegrations: { searchConsole: true, ga4: true } });

  assert.strictEqual(report.status, "research_pending");
  assert.notStrictEqual(report.status, "completed");
  assert.notStrictEqual(report.healthSummary.status, "all-clear");
  assert.strictEqual(report.firstPartyEvidence.questionsRaisedCount, 1);
  assert.strictEqual(report.firstPartyEvidence.questionsPending[0].findingKey, "orphan-page::lonely.html");
  assert.ok(/first-party evidence check/.test(report.healthSummary.text));
});

test("the SAME candidate finding, already present in the previous run (still-open, not new), does NOT re-block finalization — no manufactured question for an old finding", () => {
  const record = baseRecord({ findings: [orphanFinding()] });
  const previousRun = { runId: "prev", timestamp: "2026-10-14T04:00:00.000Z", findings: [{ key: "orphan-page::lonely.html" }] };
  const report = buildReport({ record, previousRun });

  assert.strictEqual(report.status, "completed");
  assert.strictEqual(report.firstPartyEvidence.questionsRaisedCount, 0);
  assert.deepStrictEqual(report.firstPartyEvidence.questionsPending, []);
});

test("a candidate finding that already carries first-party evidence is resolved — no pending question, regardless of change-detection", () => {
  const finding = orphanFinding({ firstPartyEvidence: [urlInspectionEvidence({ fetchedAt: "2026-10-14T00:00:00.000Z" })] });
  const record = baseRecord({ findings: [finding] });
  const report = buildReport({ record, previousRun: null });

  assert.strictEqual(report.status, "completed");
  assert.strictEqual(report.firstPartyEvidence.questionsRaisedCount, 0);
});

test("evidence fetched AFTER the initial pass (a resume) is counted as gathered DURING this logical run, distinct from evidence that already existed and was reused", () => {
  const initialTimestamp = "2026-10-15T00:00:00.000Z";
  const finding = orphanFinding({
    firstPartyEvidence: [urlInspectionEvidence({ fetchedAt: "2026-10-15T00:10:00.000Z" })], // AFTER initialTimestamp
  });
  const record = baseRecord({ timestamp: "2026-10-15T00:10:05.000Z", findings: [finding] });
  const report = buildReport({ record, previousRun: null, initialTimestamp });

  assert.strictEqual(report.status, "completed", "now that evidence exists, the run finalizes");
  assert.strictEqual(report.firstPartyEvidence.gatheredThisRunCount, 1);
  assert.strictEqual(report.firstPartyEvidence.gatheredDuringThisRunCount, 1);
  assert.strictEqual(report.firstPartyEvidence.reusedFromBeforeCount, 0);
  assert.strictEqual(report.firstPartyEvidence.items[0].gatheredDuringThisRun, true);
});

test("evidence that predates the initial pass (pre-existing, from an earlier session) is reused, not counted as gathered during this run", () => {
  const initialTimestamp = "2026-10-15T00:00:00.000Z";
  const finding = orphanFinding({
    firstPartyEvidence: [urlInspectionEvidence({ fetchedAt: "2026-10-01T00:00:00.000Z" })], // well BEFORE initialTimestamp
  });
  const record = baseRecord({ timestamp: "2026-10-15T00:00:05.000Z", findings: [finding] });
  const report = buildReport({ record, previousRun: null, initialTimestamp });

  assert.strictEqual(report.firstPartyEvidence.gatheredDuringThisRunCount, 0);
  assert.strictEqual(report.firstPartyEvidence.reusedFromBeforeCount, 1);
  assert.strictEqual(report.firstPartyEvidence.items[0].gatheredDuringThisRun, false);
});

test("a FRESH single-pass run (no resume, no initialTimestamp override) treats any attached evidence as reused — the network-free runner never fetches anything itself", () => {
  const finding = orphanFinding({ firstPartyEvidence: [urlInspectionEvidence({ fetchedAt: "2026-10-01T00:00:00.000Z" })] });
  const record = baseRecord({ findings: [finding] });
  const report = buildReport({ record, previousRun: null }); // no initialTimestamp passed — defaults to record.timestamp
  assert.strictEqual(report.firstPartyEvidence.gatheredDuringThisRunCount, 0);
  assert.strictEqual(report.firstPartyEvidence.reusedFromBeforeCount, 1);
});

test("sourcesNotConsulted lists exactly the first-party sources that contributed zero items this run", () => {
  const finding = orphanFinding({ firstPartyEvidence: [urlInspectionEvidence({ fetchedAt: "2026-10-14T00:00:00.000Z" })] });
  const record = baseRecord({ findings: [finding] });
  const report = buildReport({ record, previousRun: null });
  assert.deepStrictEqual(
    report.firstPartyEvidence.sourcesNotConsulted.sort(),
    FIRST_PARTY_SOURCES.filter((s) => s !== "search-console-url-inspection").sort()
  );
});

test("a finding type OUTSIDE firstparty-candidates.js's CANDIDATE_TYPES (e.g. an observation-tier length finding) never raises a first-party-evidence question, even when new", () => {
  const record = baseRecord({
    findings: [
      { key: "title-length::x.html", type: "title-length", tier: "observation", decision: "NO_CHANGE", status: "proposed", pages: ["x.html"], summary: "s", firstPartyEvidence: [] },
    ],
  });
  const report = buildReport({ record, previousRun: null });
  assert.strictEqual(report.status, "completed");
  assert.strictEqual(report.firstPartyEvidence.questionsRaisedCount, 0);
});

test("metrics-are-evidence-not-verdicts is preserved: a pending first-party-evidence question affects ONLY status/healthSummary, never actionableOpen/proposals counts or the finding's own decision", () => {
  const finding = orphanFinding();
  const record = baseRecord({ findings: [finding] });
  const reportWithoutCandidate = buildReport({ record: baseRecord({ findings: [{ ...finding, type: "not-a-candidate-type" }] }), previousRun: null });
  const reportWithCandidate = buildReport({ record, previousRun: null });
  // Same decision, same category/tier-derived counts either way — only
  // status/healthSummary/firstPartyEvidence differ.
  assert.strictEqual(reportWithoutCandidate.proposals.createdOrUpdatedCount, reportWithCandidate.proposals.createdOrUpdatedCount);
  assert.strictEqual(reportWithoutCandidate.technicalIssues.actionableOpen, reportWithCandidate.technicalIssues.actionableOpen);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
