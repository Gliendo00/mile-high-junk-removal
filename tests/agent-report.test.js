// Site Improvement Agent, Phase 5 — persistent report builder
// (agent/lib/report.js). Proves each of the key report shapes the daily/
// weekly operating system depends on: an All-Clear run, a run with only
// observations, a run with a safe mechanical fix applied, and a run with
// a proposal awaiting approval — plus that healthSummary is never a
// fabricated 0-100 score, and that a weekly run's rotation picks are
// carried into the report untouched.
//
// Run with:  node tests/agent-report.test.js

const assert = require("assert");
const { buildReport } = require("../agent/lib/report");
const { makeFirstPartyEvidence, SOURCES: FIRST_PARTY_SOURCES } = require("../agent/lib/firstparty-evidence");
const { SOURCE: ROTATION_SOURCE } = require("../agent/lib/rotation-evidence");

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
    timestamp: "2026-10-14T04:15:00.000Z",
    runType: "daily",
    mode: "dry-run",
    summary: { pagesScanned: 51, byCategory: {} },
    findings: [],
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSync: { skipped: true, reason: "sync disabled for this run" },
    ...overrides,
  };
}

test("a run with zero findings produces an 'All Clear' report (status 'completed') — a valid, desirable result, not an error", () => {
  const report = buildReport({ record: baseRecord(), previousRun: null });
  assert.strictEqual(report.status, "completed");
  assert.strictEqual(report.healthSummary.status, "all-clear");
  assert.strictEqual(report.healthSummary.text, "All clear — no worthwhile changes found.");
  assert.strictEqual(report.pagesChecked, 51);
  assert.strictEqual(report.proposals.awaitingApprovalCount, 0);
});

// Phase 5B — the bug this specifically guards against: a run whose ONLY
// findings are unresolved RESEARCH_MORE questions (category C, tier
// "opportunity" — never "actionable", never PROPOSE_CHANGE) must NOT
// read as all-clear just because actionableOpenCount and
// proposalsAwaitingApproval both happen to be zero.
test("a run with an unresolved RESEARCH_MORE finding is status 'research_pending', with an honest 'awaiting research' health summary — NEVER 'all-clear' or 'completed'", () => {
  const record = baseRecord({
    findings: [
      {
        key: "a", type: "content-gap", tier: "opportunity", decision: "RESEARCH_MORE", status: "proposed",
        summary: "thin FAQ", pages: ["x.html"],
        researchQuestion: { findingKey: "a", question: "is there a real local angle?", internalEvidence: [], suggestedSourceTypes: ["official-government"] },
      },
    ],
  });
  const report = buildReport({ record, previousRun: null });
  assert.strictEqual(report.status, "research_pending");
  assert.notStrictEqual(report.healthSummary.status, "all-clear");
  assert.notStrictEqual(report.status, "completed");
  assert.ok(/awaiting results/.test(report.healthSummary.text));
  assert.strictEqual(report.research.questionsPending.length, 1);
  assert.strictEqual(report.research.questionsPending[0].findingKey, "a");
});

test("a run with only observation-tier NO_CHANGE findings is still reported as healthy — an observation alone is not an 'issue'", () => {
  const record = baseRecord({
    findings: [
      { key: "a", type: "title-length", tier: "observation", decision: "NO_CHANGE", status: "proposed", summary: "s" },
      { key: "b", type: "weak-internal-support", tier: "observation", decision: "NO_CHANGE", status: "proposed", summary: "s2" },
    ],
  });
  const report = buildReport({ record, previousRun: null });
  assert.strictEqual(report.healthSummary.status, "all-clear");
  assert.strictEqual(report.observationsCount, 2);
  assert.strictEqual(report.technicalIssues.actionableOpen, 0);
});

test("a run with a confirmed safe mechanical fix reports it under safeFixes, and still counts as healthy once resolved", () => {
  const record = baseRecord({
    findings: [
      { key: "a", type: "redirect-hop-internal-link", tier: "actionable", decision: "APPLY_SAFE_FIX", status: "applied", summary: "fixed a link", pages: ["x.html"] },
    ],
  });
  const report = buildReport({ record, previousRun: null });
  assert.strictEqual(report.safeFixes.appliedCount, 1);
  assert.strictEqual(report.safeFixes.items[0].key, "a");
  assert.strictEqual(report.healthSummary.status, "all-clear", "a successfully applied+confirmed fix should not count as an open issue");
});

test("a run with a PROPOSE_CHANGE finding reports it as a proposal awaiting approval and flags the run as needing attention", () => {
  const record = baseRecord({
    findings: [
      { key: "a", type: "content-gap", tier: "opportunity", decision: "PROPOSE_CHANGE", status: "proposed", summary: "thin FAQ", pages: ["x.html"], proposalStatus: "proposed" },
    ],
  });
  const report = buildReport({ record, previousRun: null });
  assert.strictEqual(report.proposals.awaitingApprovalCount, 1);
  assert.strictEqual(report.healthSummary.status, "needs-attention");
  assert.ok(/1 proposal/.test(report.healthSummary.text));
});

test("healthSummary is always a short sentence derived from real counts — never a numeric 0-100 'score'", () => {
  const report = buildReport({ record: baseRecord(), previousRun: null });
  assert.strictEqual(typeof report.healthSummary.text, "string");
  assert.ok(!/^\d+(\.\d+)?$/.test(report.healthSummary.text));
  assert.ok(!("score" in report.healthSummary));
});

test("a proposal already marked 'rejected' by the owner is reported as previouslyRejectedStillSurfacing, distinct from a fresh proposal", () => {
  const record = baseRecord({
    findings: [
      { key: "a", type: "content-gap", tier: "opportunity", decision: "PROPOSE_CHANGE", status: "proposed", summary: "s", pages: ["x.html"], proposalStatus: "rejected" },
    ],
  });
  const report = buildReport({ record, previousRun: null });
  assert.strictEqual(report.proposals.previouslyRejectedStillSurfacingCount, 1);
  assert.strictEqual(report.proposals.awaitingApprovalCount, 0, "a rejected proposal must not also count as awaiting approval");
});

test("a research-inconclusive NO_CHANGE finding is reported under research.performed, never as a proposal", () => {
  const record = baseRecord({
    findings: [
      {
        key: "a", type: "content-gap", tier: "opportunity", decision: "NO_CHANGE", status: "proposed",
        summary: "s", pages: ["x.html"],
        research: [{ source: "search", sourceType: "search-results-observation", confidence: "low", verdict: "inconclusive", accessedAt: "2026-10-01T00:00:00Z", temporality: "evergreen" }],
      },
    ],
  });
  const report = buildReport({ record, previousRun: null });
  assert.strictEqual(report.research.performed.length, 1);
  assert.strictEqual(report.proposals.createdOrUpdatedCount, 0);
});

test("change detection is included and correctly distinguishes new vs. still-open against the previous run", () => {
  const previousRun = { runId: "r0", timestamp: "2026-10-13T04:15:00.000Z", findings: [{ key: "a" }] };
  const record = baseRecord({
    findings: [
      { key: "a", type: "t", tier: "observation", decision: "NO_CHANGE", status: "proposed", summary: "s" },
      { key: "b", type: "t2", tier: "observation", decision: "NO_CHANGE", status: "proposed", summary: "s2" },
    ],
  });
  const report = buildReport({ record, previousRun });
  assert.strictEqual(report.changeDetection.hasPreviousRun, true);
  assert.deepStrictEqual(report.changeDetection.new, ["b"]);
  assert.deepStrictEqual(report.changeDetection.stillOpen, ["a"]);
});

test("a weekly run's rotation picks carry their original investigation-signal fields through unchanged", () => {
  const record = baseRecord({ runType: "weekly" });
  const rotationPriorities = [{ slug: "golden", name: "Golden", hasPage: false, score: 60, reasons: ["never deep-reviewed"] }];
  const report = buildReport({ record, previousRun: null, rotationPriorities });
  assert.ok(report.rotation);
  assert.strictEqual(report.rotation.picks.length, 1);
  assert.strictEqual(report.rotation.picks[0].slug, "golden");
});

test("a daily run has no rotation section at all (null, not an empty array) — rotation is weekly-only", () => {
  const report = buildReport({ record: baseRecord(), previousRun: null });
  assert.strictEqual(report.rotation, null);
});

// -----------------------------------------------------------------------
// Phase 7B — closing the "rotation selects a target but nothing reviews
// it" gap. See agent/lib/rotation-evidence.js's header for the full
// root-cause writeup; these tests prove report.js's half of the fix:
// distinguishing selected/researched/concluded, merging rotation
// evidence into the SAME firstPartyEvidence aggregate findings already
// use (the actual symptom observed in the real Weekly run — Search
// Console showing up in sourcesNotConsulted despite evidence existing),
// and never fabricating external-research capability this runner
// doesn't have.
// -----------------------------------------------------------------------

function rotationEvidence(rotationSlug, totalRowsReturned, overrides) {
  return makeFirstPartyEvidence({
    rotationSlug,
    source: ROTATION_SOURCE,
    metric: "clicks-impressions-ctr-position",
    dimension: "query",
    scope: { type: "city", value: "Golden" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned, topRows: [] },
    context: "test",
    limitations: "test",
    ...overrides,
  });
}

test("a pageless pick with NO attached evidence: not researched, conclusion null, honest reason, zero external research claimed, no fabricated freshness", () => {
  const record = baseRecord({ runType: "weekly" });
  const rotationPriorities = [{ slug: "golden", name: "Golden", hasPage: false, score: 60, reasons: ["never deep-reviewed"], firstPartyEvidence: [] }];
  const report = buildReport({ record, previousRun: null, rotationPriorities, firstPartyIntegrations: { searchConsole: true, ga4: false } });
  const pick = report.rotation.picks[0];
  assert.strictEqual(pick.researched, false);
  assert.strictEqual(pick.conclusion, null);
  assert.strictEqual(pick.evidenceFreshness, null);
  assert.ok(typeof pick.conclusionReason === "string" && pick.conclusionReason.length > 0);
  assert.strictEqual(pick.externalResearchPerformed, false);
  assert.ok(typeof pick.externalResearchCapability === "string" && /not available/i.test(pick.externalResearchCapability));
});

test("a NO_CHANGE conclusion's wording never claims 'no local opportunity' and never forecloses future research for the city — the exact distinction this phase must preserve", () => {
  const record = baseRecord({ runType: "weekly" });
  const evidence = rotationEvidence("golden", 0);
  const rotationPriorities = [{ slug: "golden", name: "Golden", hasPage: false, score: 60, reasons: ["never deep-reviewed"], firstPartyEvidence: [evidence] }];
  const report = buildReport({ record, previousRun: null, rotationPriorities, firstPartyIntegrations: { searchConsole: true, ga4: false } });
  const pick = report.rotation.picks[0];
  assert.strictEqual(pick.conclusion, "NO_CHANGE");
  assert.ok(/does NOT establish that no local opportunity exists/i.test(pick.conclusionReason));
  assert.ok(/never closes the door|future research/i.test(pick.conclusionReason));
  assert.ok(/never justifies creating a page/i.test(pick.conclusionReason));
  // And the evidence's own freshness is surfaced, never silently assumed fresh.
  assert.strictEqual(pick.evidenceFreshness, "fresh");
});

test("a pageless pick with zero-row evidence attached: researched, NO_CHANGE, and the evidence shows up in the report's aggregate firstPartyEvidence (moving its source OFF sourcesNotConsulted)", () => {
  const record = baseRecord({ runType: "weekly" });
  const evidence = rotationEvidence("golden", 0);
  const rotationPriorities = [{ slug: "golden", name: "Golden", hasPage: false, score: 60, reasons: ["never deep-reviewed"], firstPartyEvidence: [evidence] }];
  const report = buildReport({ record, previousRun: null, rotationPriorities, firstPartyIntegrations: { searchConsole: true, ga4: false } });

  const pick = report.rotation.picks[0];
  assert.strictEqual(pick.researched, true);
  assert.strictEqual(pick.conclusion, "NO_CHANGE");

  // THE actual symptom from the real Weekly run: Search Console showing
  // as "not consulted" despite rotation evidence existing.
  assert.strictEqual(report.firstPartyEvidence.sourcesNotConsulted.includes(ROTATION_SOURCE), false);
  assert.strictEqual(report.firstPartyEvidence.gatheredThisRunCount, 1);
  assert.strictEqual(report.firstPartyEvidence.items.some((i) => i.rotationSlug === "golden"), true);
});

test("a pageless pick with a nonzero-row evidence attached: researched, RESEARCH_MORE — NEVER a proposal, NEVER PROPOSE_CHANGE", () => {
  const record = baseRecord({ runType: "weekly" });
  const evidence = rotationEvidence("golden", 4);
  const rotationPriorities = [{ slug: "golden", name: "Golden", hasPage: false, score: 60, reasons: ["never deep-reviewed"], firstPartyEvidence: [evidence] }];
  const report = buildReport({ record, previousRun: null, rotationPriorities, firstPartyIntegrations: { searchConsole: true, ga4: false } });
  const pick = report.rotation.picks[0];
  assert.strictEqual(pick.researched, true);
  assert.strictEqual(pick.conclusion, "RESEARCH_MORE");
  assert.strictEqual(report.proposals.createdOrUpdatedCount, 0, "a rotation RESEARCH_MORE conclusion must never create a proposal");
  assert.strictEqual(report.healthSummary.status, "all-clear", "a rotation pick's own conclusion must never flip the run's health status — only findings do that");
});

test("a pick that already HAS a page is never treated as an evidence candidate — explicit reason points to the ordinary daily pipeline instead", () => {
  const record = baseRecord({ runType: "weekly" });
  const rotationPriorities = [{ slug: "denver", name: "Denver", hasPage: true, score: 40, reasons: ["stale"], firstPartyEvidence: [] }];
  const report = buildReport({ record, previousRun: null, rotationPriorities });
  const pick = report.rotation.picks[0];
  assert.strictEqual(pick.researched, false);
  assert.strictEqual(pick.conclusion, null);
  assert.ok(/already has a dedicated page/i.test(pick.conclusionReason));
});

test("rotation.summary correctly tallies selected/researched/concluded/not-yet-researched across a mixed set of picks, and always reports zero external research performed", () => {
  const record = baseRecord({ runType: "weekly" });
  const rotationPriorities = [
    { slug: "golden", name: "Golden", hasPage: false, score: 60, reasons: ["x"], firstPartyEvidence: [rotationEvidence("golden", 0)] },
    { slug: "brighton", name: "Brighton", hasPage: false, score: 55, reasons: ["x"], firstPartyEvidence: [rotationEvidence("brighton", 2)] },
    { slug: "morrison", name: "Morrison", hasPage: false, score: 50, reasons: ["x"], firstPartyEvidence: [] },
    { slug: "denver", name: "Denver", hasPage: true, score: 40, reasons: ["x"], firstPartyEvidence: [] },
  ];
  const report = buildReport({ record, previousRun: null, rotationPriorities, firstPartyIntegrations: { searchConsole: true, ga4: false } });
  assert.deepStrictEqual(report.rotation.summary, {
    targetsSelected: 4,
    targetsPageless: 3,
    targetsActuallyResearched: 2,
    targetsConcludedNoChange: 1,
    targetsConcludedResearchMore: 1,
    targetsNotYetResearched: 2,
    proposalsCreatedFromRotation: 0,
    externalResearchPerformed: 0,
    externalResearchCapability: report.rotation.picks[0].externalResearchCapability,
  });
});

test("rotation.summary is null on a daily run (no rotation at all), consistent with rotation itself being null", () => {
  const report = buildReport({ record: baseRecord(), previousRun: null });
  assert.strictEqual(report.rotation, null);
});

test("a failed run reports status 'failed' (and healthSummary.status 'failed') and carries the failure message, never pretending success", () => {
  const record = baseRecord({ failed: true });
  const report = buildReport({ record, previousRun: null, failure: { message: "simulated scan failure" } });
  assert.strictEqual(report.status, "failed");
  assert.strictEqual(report.healthSummary.status, "failed");
  assert.strictEqual(report.failure.message, "simulated scan failure");
});

test("'failed' always wins over 'research_pending' when both are true — a run that failed mid-research must never be reported as merely awaiting research", () => {
  const record = baseRecord({
    failed: true,
    findings: [
      { key: "a", type: "content-gap", tier: "opportunity", decision: "RESEARCH_MORE", status: "proposed", summary: "s", pages: ["x.html"], researchQuestion: { findingKey: "a", question: "q" } },
    ],
  });
  const report = buildReport({ record, previousRun: null, failure: { message: "simulated failure" } });
  assert.strictEqual(report.status, "failed");
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
