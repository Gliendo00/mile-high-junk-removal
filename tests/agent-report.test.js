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
const { buildReport, parseWorkflowStartedAt } = require("../agent/lib/report");
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

// -----------------------------------------------------------------------
// First-Party Signals (agent/lib/firstparty-signals.js) — report.js's own
// `firstPartySignals` section. Distinct from `firstPartyEvidence` (raw)
// and from `proposals`/`safeFixes` (actual decisions) — see report.js's
// own header comment on the three-way distinction this section exists to
// preserve.
// -----------------------------------------------------------------------

function querySignal(findingKey, overrides) {
  return {
    type: "query-page-mismatch",
    findingKey,
    pages: ["furniture-removal.html"],
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    source: "search-console-search-analytics",
    evidenceFetchedAt: "2026-10-14T00:00:00.000Z",
    mismatchedQueries: [{ query: "sell my old couch", observedPage: "https://www.milehighjunkremoval.net/other.html", clicks: 1, impressions: 10, ctr: 0.1, position: 5 }],
    reason: "test reason",
    limitations: "test limitations",
    posture: "investigation-only — never a decision, proposal, approval, or rejection.",
    ...overrides,
  };
}

test("a run with zero findings carrying first-party signals reports firstPartySignals.count 0 and an empty items array — a valid, successful result", () => {
  const report = buildReport({ record: baseRecord(), previousRun: null });
  assert.strictEqual(report.firstPartySignals.count, 0);
  assert.deepStrictEqual(report.firstPartySignals.items, []);
});

test("report.firstPartySignals is built from findings' attached `.firstPartySignals`, aggregated across findings, and NEVER changes healthSummary/status by itself", () => {
  const record = baseRecord({
    findings: [
      { key: "a", type: "content-gap", tier: "opportunity", decision: "NO_CHANGE", status: "proposed", summary: "s", pages: ["furniture-removal.html"], firstPartySignals: [querySignal("a")] },
    ],
  });
  const report = buildReport({ record, previousRun: null });
  assert.strictEqual(report.firstPartySignals.count, 1);
  assert.strictEqual(report.firstPartySignals.items[0].findingKey, "a");
  assert.strictEqual(report.firstPartySignals.items[0].type, "query-page-mismatch");
  // The finding is NO_CHANGE and there is nothing else actionable — the
  // run must still read as healthy, regardless of a signal existing.
  assert.strictEqual(report.healthSummary.status, "all-clear");
  assert.strictEqual(report.status, "completed");
});

test("report.firstPartySignals is a genuinely separate section from report.firstPartyEvidence and from report.proposals/safeFixes — a signal is neither raw evidence nor a decision", () => {
  const evidence = makeFirstPartyEvidence({
    findingKey: "a",
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "furniture-removal.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: 1, topRows: [{ keys: ["sell my old couch", "https://www.milehighjunkremoval.net/other.html"], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] },
    context: "c",
    limitations: "l",
  });
  const record = baseRecord({
    findings: [
      {
        key: "a",
        type: "content-gap",
        tier: "opportunity",
        decision: "NO_CHANGE",
        status: "proposed",
        summary: "s",
        pages: ["furniture-removal.html"],
        firstPartyEvidence: [evidence],
        firstPartySignals: [querySignal("a")],
      },
    ],
  });
  const report = buildReport({ record, previousRun: null, firstPartyIntegrations: { searchConsole: true, ga4: false } });
  assert.strictEqual(report.firstPartyEvidence.gatheredThisRunCount, 1);
  assert.strictEqual(report.firstPartySignals.count, 1);
  // Neither section contributed a proposal/safe-fix — this finding's
  // decision (NO_CHANGE) is the only thing that determines those.
  assert.strictEqual(report.proposals.createdOrUpdatedCount, 0);
  assert.strictEqual(report.safeFixes.appliedCount, 0);
  // And none of decision.js's vocabulary appears anywhere inside a
  // signal item itself.
  for (const field of ["verdict", "recommendation", "confidence", "decision"]) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(report.firstPartySignals.items[0], field), false);
  }
});

// -----------------------------------------------------------------------
// Website Agent workflow provenance — workflowStartedAt / gatheredByWorkflow
// -----------------------------------------------------------------------

test("parseWorkflowStartedAt(): undefined/null/empty all degrade to null (fall back to existing runStartedAt-based behavior)", () => {
  assert.strictEqual(parseWorkflowStartedAt(undefined), null);
  assert.strictEqual(parseWorkflowStartedAt(null), null);
  assert.strictEqual(parseWorkflowStartedAt(""), null);
});

test("parseWorkflowStartedAt(): an unparsable string degrades to null, never throws, never produces an Invalid Date", () => {
  assert.strictEqual(parseWorkflowStartedAt("not-a-timestamp"), null);
  assert.strictEqual(parseWorkflowStartedAt("WORKFLOW_STARTED_AT"), null); // the literal var name, e.g. a misconfigured workflow
});

test("parseWorkflowStartedAt(): a valid ISO timestamp parses to the equivalent Date", () => {
  const parsed = parseWorkflowStartedAt("2026-10-15T17:30:00Z");
  assert.ok(parsed instanceof Date);
  assert.strictEqual(parsed.getTime(), new Date("2026-10-15T17:30:00Z").getTime());
});

test("parseWorkflowStartedAt(): a value AFTER `now` also degrades to null — a workflow cannot honestly have started in the future", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  assert.strictEqual(parseWorkflowStartedAt("2026-10-15T13:00:00Z", now), null);
});

function findingEvidence(findingKey, fetchedAt, overrides) {
  return makeFirstPartyEvidence({
    findingKey,
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    dimension: "query+page",
    scope: { type: "page", value: "blog-seasonal-cleanout-guide.html" },
    window: { start: "2026-09-17", end: "2026-10-14", label: "28 days ending 2026-10-14" },
    observed: { totalRowsReturned: 0, topRows: [] },
    context: "c",
    limitations: "l",
    fetchedAt,
    ...overrides,
  });
}

test("with NO workflowStartedAt supplied: gatheredByWorkflow/gatheredByWorkflowCount degrade to the EXACT existing gatheredDuringThisRun/gatheredDuringThisRunCount behavior — zero change for local/manual CLI runs, daily, diagnostics, and every historical record", () => {
  const record = {
    runId: "r1",
    timestamp: "2026-10-15T18:00:00.000Z",
    runType: "weekly",
    mode: "dry-run",
    summary: { pagesScanned: 51, byCategory: {} },
    findings: [
      { key: "a", type: "content-gap", tier: "opportunity", decision: "NO_CHANGE", status: "proposed", summary: "s", pages: ["blog-seasonal-cleanout-guide.html"], firstPartyEvidence: [findingEvidence("a", "2026-10-15T17:39:22.391Z")] },
    ],
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSync: { skipped: true, reason: "x" },
  };
  const report = buildReport({ record, previousRun: null, firstPartyIntegrations: { searchConsole: true, ga4: false } });
  const item = report.firstPartyEvidence.items[0];
  assert.strictEqual(item.gatheredByWorkflow, item.gatheredDuringThisRun);
  assert.strictEqual(report.firstPartyEvidence.gatheredByWorkflowCount, report.firstPartyEvidence.gatheredDuringThisRunCount);
  assert.strictEqual(report.firstPartyEvidence.reusedFreshOrAgingCount + report.firstPartyEvidence.gatheredByWorkflowCount + report.firstPartyEvidence.staleReusedCount, report.firstPartyEvidence.gatheredThisRunCount);
});

test("WITH a valid workflowStartedAt BEFORE the evidence's own fetchedAt (the Controlled Weekly #11 scenario — evidence fetched by an earlier --refresh-finding-evidence step in the SAME job): gatheredByWorkflow is true even though gatheredDuringThisRun (the unchanged, resume-only field) stays false", () => {
  const record = {
    runId: "r1",
    timestamp: "2026-10-15T18:00:00.000Z", // the main --weekly process's own, LATER start time
    runType: "weekly",
    mode: "dry-run",
    summary: { pagesScanned: 51, byCategory: {} },
    findings: [
      { key: "a", type: "content-gap", tier: "opportunity", decision: "NO_CHANGE", status: "proposed", summary: "s", pages: ["blog-seasonal-cleanout-guide.html"], firstPartyEvidence: [findingEvidence("a", "2026-10-15T17:39:22.391Z")] }, // fetched by the EARLIER refresh step
    ],
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSync: { skipped: true, reason: "x" },
  };
  const report = buildReport({
    record,
    previousRun: null,
    firstPartyIntegrations: { searchConsole: true, ga4: false },
    workflowStartedAt: "2026-10-15T17:38:00.000Z", // captured at the TOP of the job, before either refresh step ran
  });
  const item = report.firstPartyEvidence.items[0];
  assert.strictEqual(item.gatheredDuringThisRun, false, "unchanged field: this process's own start was 18:00, after fetchedAt — never silently reinterpreted");
  assert.strictEqual(item.gatheredByWorkflow, true, "new field: the workflow boundary (17:38) was before fetchedAt (17:39:22) — correctly recognized as gathered by this SAME workflow dispatch");
  assert.strictEqual(report.firstPartyEvidence.gatheredByWorkflowCount, 1);
  assert.strictEqual(report.firstPartyEvidence.reusedFreshOrAgingCount, 0);
  assert.strictEqual(report.firstPartyEvidence.staleReusedCount, 0);
});

test("stale evidence reused from before this workflow is counted in staleReusedCount, separately from fresh/aging reused evidence — never silently folded into one 'reused' bucket", () => {
  const now = "2026-10-15T18:00:00.000Z";
  const staleFetchedAt = new Date(new Date(now).getTime() - 25 * 24 * 60 * 60 * 1000).toISOString(); // >21d, stale for search-console-search-analytics
  const record = {
    runId: "r1",
    timestamp: now,
    runType: "weekly",
    mode: "dry-run",
    summary: { pagesScanned: 51, byCategory: {} },
    findings: [
      { key: "a", type: "content-gap", tier: "opportunity", decision: "NO_CHANGE", status: "proposed", summary: "s", pages: ["blog-seasonal-cleanout-guide.html"], firstPartyEvidence: [findingEvidence("a", staleFetchedAt)] },
    ],
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSync: { skipped: true, reason: "x" },
  };
  const report = buildReport({ record, previousRun: null, firstPartyIntegrations: { searchConsole: true, ga4: false }, workflowStartedAt: now });
  assert.strictEqual(report.firstPartyEvidence.items[0].freshness, "stale");
  assert.strictEqual(report.firstPartyEvidence.items[0].gatheredByWorkflow, false);
  assert.strictEqual(report.firstPartyEvidence.staleReusedCount, 1);
  assert.strictEqual(report.firstPartyEvidence.gatheredByWorkflowCount, 0);
  assert.strictEqual(report.firstPartyEvidence.reusedFreshOrAgingCount, 0);
});

test("an INVALID workflowStartedAt (garbage string) degrades safely to existing behavior — never misclassifies pre-existing evidence as newly gathered by this workflow", () => {
  const record = {
    runId: "r1",
    timestamp: "2026-10-15T18:00:00.000Z",
    runType: "weekly",
    mode: "dry-run",
    summary: { pagesScanned: 51, byCategory: {} },
    findings: [
      { key: "a", type: "content-gap", tier: "opportunity", decision: "NO_CHANGE", status: "proposed", summary: "s", pages: ["blog-seasonal-cleanout-guide.html"], firstPartyEvidence: [findingEvidence("a", "2026-10-15T17:39:22.391Z")] },
    ],
    validation: { performed: false, confirmed: 0, reverted: 0 },
    proposalsSync: { skipped: true, reason: "x" },
  };
  const report = buildReport({ record, previousRun: null, firstPartyIntegrations: { searchConsole: true, ga4: false }, workflowStartedAt: "not-a-real-timestamp" });
  const item = report.firstPartyEvidence.items[0];
  assert.strictEqual(item.gatheredByWorkflow, item.gatheredDuringThisRun, "an invalid boundary must fall back to the exact same reference gatheredDuringThisRun already uses, never default to 'everything is new'");
  assert.strictEqual(item.gatheredByWorkflow, false, "a fresh, single-pass run (no resume) correctly reads as reused, not newly gathered, same as gatheredDuringThisRun always has");
});

// --- Phase 15: opportunityResearch section ---------------------------------

test("Phase 15: report.opportunityResearch tallies classification counts correctly, even when nothing becomes a proposal", () => {
  const record = baseRecord({
    findings: [
      { key: "a", type: "keyword-opportunity-ctr-opportunity", decision: "REJECT_OPPORTUNITY", opportunityClassification: { classification: "WATCH", reason: "local pack" } },
      { key: "b", type: "keyword-opportunity-protect-maintain", decision: "REJECT_OPPORTUNITY", opportunityClassification: { classification: "PROTECT", reason: "strong performer" } },
      { key: "c", type: "totally-unknown-type", decision: "NO_CHANGE", opportunityClassification: { classification: "LOW_SUPPRESS", reason: "unrecognized" } },
    ],
    opportunityClassifications: [
      { key: "a", classification: "WATCH", reason: "local pack" },
      { key: "b", classification: "PROTECT", reason: "strong performer" },
      { key: "c", classification: "LOW_SUPPRESS", reason: "unrecognized" },
    ],
  });
  const report = buildReport({ record, previousRun: null });
  assert.strictEqual(report.opportunityResearch.researchedCount, 3);
  assert.strictEqual(report.opportunityResearch.watch, 1);
  assert.strictEqual(report.opportunityResearch.protect, 1);
  assert.strictEqual(report.opportunityResearch.suppressed, 1);
  assert.strictEqual(report.opportunityResearch.important, 0);
  assert.strictEqual(report.opportunityResearch.proposalsCreated, 0, "no proposal can still mean the Agent did useful work");
});

test("Phase 15: report.opportunityResearch.proposalsCreated only counts IMPORTANT findings that actually synced (proposalStatus set)", () => {
  const record = baseRecord({
    findings: [
      { key: "a", type: "missing-canonical", pages: ["a.html"], decision: "PROPOSE_CHANGE", opportunityClassification: { classification: "IMPORTANT", reason: "r" }, proposalStatus: "proposed" },
      { key: "b", type: "missing-h1", pages: ["b.html"], decision: "PROPOSE_CHANGE", opportunityClassification: { classification: "IMPORTANT", reason: "r" }, proposalStatus: null }, // sync skipped/failed
    ],
    opportunityClassifications: [
      { key: "a", classification: "IMPORTANT", reason: "r" },
      { key: "b", classification: "IMPORTANT", reason: "r" },
    ],
  });
  const report = buildReport({ record, previousRun: null });
  assert.strictEqual(report.opportunityResearch.important, 2);
  assert.strictEqual(report.opportunityResearch.proposalsCreated, 1);
});

test("Phase 15: report.opportunityResearch defaults to all-zero counts when a run has no classifications at all (e.g. a pre-Phase-15 record)", () => {
  const report = buildReport({ record: baseRecord(), previousRun: null });
  assert.strictEqual(report.opportunityResearch.researchedCount, 0);
  assert.strictEqual(report.opportunityResearch.important, 0);
  assert.strictEqual(report.opportunityResearch.watch, 0);
  assert.strictEqual(report.opportunityResearch.suppressed, 0);
  assert.strictEqual(report.opportunityResearch.protect, 0);
  assert.deepStrictEqual(report.opportunityResearch.examples, []);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
