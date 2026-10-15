// Site Improvement Agent, Phase 5 (+ Phase 5B lifecycle fix) — persistent
// report builder.
//
// Turns one run record (runner.js's internal shape: findings, summary,
// validation, proposalsSync) plus the previous run and (for a weekly run)
// this week's rotation picks into the CRM-facing REPORT the rest of this
// phase is built around — see agent/README.md's "Daily report" section
// for the exact questions this must answer: WHAT DID THE AGENT DO? WHY?
// DID IT CHANGE ANYTHING? DO I NEED TO APPROVE SOMETHING?
//
// Deliberately NOT a raw log dump, and deliberately NOT a 0-100 "site
// health score" — healthSummary is a short, honest sentence derived from
// real counts (open actionable findings + proposals awaiting approval),
// not an invented metric.
//
// Phase 5B — RUN STATUS LIFECYCLE: a run record now carries an explicit
// `status`: "completed" | "research_pending" | "failed". This fixes a
// real bug in the original Phase 5 report: a run whose ONLY findings
// were unresolved RESEARCH_MORE questions (category C, tier
// "opportunity" — never "actionable", and never PROPOSE_CHANGE) produced
// `actionableOpenCount === 0` and `proposalsAwaitingApproval === 0`,
// which `buildHealthSummary()` read as "All clear" — exactly the
// "a run requiring research must never look like ALL CLEAR" failure mode
// Rocky flagged. `computeRunStatus()` below is checked BEFORE the
// all-clear/needs-attention logic, so a pending research question always
// wins that race.
//
// This is a pure function — runner.js calls it once per run (or once per
// RESUME of a run — see runner.js's resumeRunId option) and persists its
// output as `record.report` (see history.js), so the CRM API layer never
// has to recompute change-detection/rotation context on every read.

const { classifyChanges } = require("./change-detection");
const { computeFreshness } = require("./research");
const { computeFirstPartyFreshness, SOURCES: FIRST_PARTY_SOURCES } = require("./firstparty-evidence");
const { isFirstPartyEvidenceCandidate, buildFirstPartyEvidenceQuestion } = require("./firstparty-candidates");
const { isRotationEvidenceCandidate, classifyRotationConclusion } = require("./rotation-evidence");

// Phase 7B — surfaced verbatim on every rotation pick and in
// rotation.summary: this unattended runner has no research-capable
// orchestrator session (no Claude/Anthropic or other AI provider is
// configured — see agent/README.md's Phase 7 section) and therefore
// cannot perform the EXTERNAL (municipal/county/state, competitor-
// landscape) half of a genuine deep review. Stated once here so it is
// never silently implied to have happened — see rotation-evidence.js's
// header for the full boundary this documents.
const EXTERNAL_RESEARCH_CAPABILITY_MISSING =
  "Not available in this environment — this unattended run has no research-capable orchestrator session (no Claude/Anthropic or other AI provider, no web-research access configured). External/local research (municipal, county, state sources; competitor landscape as context only) for this pick still requires a human or a future research-capable orchestrator session.";

function countBy(findings, predicate) {
  return findings.filter(predicate).length;
}

// Checked in this exact order: failed > research_pending > completed. A
// run can be BOTH "has unresolved research" and "failed" (research was
// needed, then something else broke) — failed always wins, since "this
// run did not complete successfully" is the most important thing to say.
//
// Lifecycle-tightening update: `research_pending` now also covers an
// unresolved FIRST-PARTY-EVIDENCE question (firstparty-candidates.js) —
// deliberately the SAME status value, not a second lifecycle/status
// enum, so the existing resume mechanism (runner.js's
// findResumableRun()/run({resumeRunId})) needs zero changes to also
// cover this case: it already just checks `status === "research_pending"`
// and doesn't care WHY. See agent/README.md's Phase 6 lifecycle-
// tightening section for the full reasoning.
function computeRunStatus({ failure, hasUnresolvedResearch, hasUnresolvedFirstPartyEvidence }) {
  if (failure) return "failed";
  if (hasUnresolvedResearch || hasUnresolvedFirstPartyEvidence) return "research_pending";
  return "completed";
}

function buildHealthSummary({ status, actionableOpenCount, proposalsAwaitingApproval, questionsPendingCount, firstPartyQuestionsPendingCount, failure }) {
  if (status === "failed") {
    const detail = failure && failure.message ? ` (${failure.message})` : "";
    return { status: "failed", text: `This run did not complete successfully${detail} — see failure details below. No site changes were made based on a failed run.` };
  }
  if (status === "research_pending") {
    const parts = [];
    if (questionsPendingCount > 0) parts.push(`${questionsPendingCount} research question${questionsPendingCount === 1 ? "" : "s"}`);
    if (firstPartyQuestionsPendingCount > 0) {
      parts.push(`${firstPartyQuestionsPendingCount} first-party evidence check${firstPartyQuestionsPendingCount === 1 ? "" : "s"}`);
    }
    return {
      status: "research-pending",
      text: `Evidence needed before this run can be finalized — ${parts.join(" and ")} awaiting results.`,
    };
  }
  if (actionableOpenCount === 0 && proposalsAwaitingApproval === 0) {
    return { status: "all-clear", text: "All clear — no worthwhile changes found." };
  }
  const parts = [];
  if (actionableOpenCount > 0) parts.push(`${actionableOpenCount} open issue${actionableOpenCount === 1 ? "" : "s"}`);
  if (proposalsAwaitingApproval > 0) parts.push(`${proposalsAwaitingApproval} proposal${proposalsAwaitingApproval === 1 ? "" : "s"} awaiting approval`);
  return { status: "needs-attention", text: parts.join(" · ") };
}

/**
 * @param {object} args
 * @param {object} args.record - the run record runner.js builds (pre-persistence), including `runType`
 * @param {object|null} args.previousRun - the previous run record read from history, or null if this is the first run
 * @param {object[]} [args.rotationPriorities] - this week's picks (weekly runs only; agent/lib/research-rotation.js)
 * @param {object} [args.failure] - { message } if this run failed partway (see agent/README.md's failure-safety section)
 * @param {object} [args.firstPartyIntegrations] - Phase 6: {searchConsole, ga4} booleans — whether each
 *   integration is CONFIGURED (env vars present), computed by runner.js via a pure env-var/local-JSON
 *   check (no network call — see search-console-client.js/ga4-client.js's isXConfigured()), passed in
 *   explicitly so this function stays a pure function of its arguments rather than reading process.env itself
 * @param {string} [args.initialTimestamp] - lifecycle-tightening: the FIRST pass's timestamp for this
 *   logical run (runner.js passes `priorRecord.timestamp` on a resume, else `record.timestamp` — i.e.
 *   itself, on a fresh single-pass run). Used only to tell "evidence gathered DURING this logical run"
 *   (fetched after the initial pass, picked up by a resume) apart from "evidence that already existed
 *   and was simply reused" — see the firstPartyEvidence section below.
 */
function buildReport({ record, previousRun, rotationPriorities, failure, firstPartyIntegrations, initialTimestamp }) {
  const findings = record.findings || [];
  const now = new Date(record.timestamp);
  const runStartedAt = new Date(initialTimestamp || record.timestamp);

  const changeDetection = classifyChanges(findings, previousRun);

  const safeFixesApplied = findings.filter((f) => f.status === "applied");
  const proposalsCreatedOrUpdated = findings.filter(
    (f) => f.decision === "PROPOSE_CHANGE" || f.decision === "REJECT_OPPORTUNITY"
  );
  const proposalsAwaitingApproval = findings.filter((f) => {
    const status = f.proposalStatus;
    return f.decision === "PROPOSE_CHANGE" && (status === "proposed" || status == null);
  }).length;
  const previouslyRejectedStillSurfacing = findings.filter((f) => f.proposalStatus === "rejected").length;
  const alreadyApplied = findings.filter((f) => f.proposalStatus === "applied" || f.proposalStatus === "validated").length;

  const researchPerformed = findings
    .filter((f) => Array.isArray(f.research) && f.research.length > 0)
    .map((f) => ({
      findingKey: f.key,
      page: f.pages && f.pages[0],
      results: f.research.map((r) => ({
        source: r.source,
        sourceType: r.sourceType,
        confidence: r.confidence,
        verdict: r.verdict,
        freshness: computeFreshness(r, now),
      })),
    }));

  // Phase 5B — the actual hand-off contract to the research-capable
  // orchestrator (a Claude-driven session — see agent/README.md's
  // "Orchestrator architecture" section): every RESEARCH_MORE finding's
  // full researchQuestion object (question text, internal evidence,
  // suggested source types — see decision.js's buildResearchQuestion())
  // is surfaced here, not just a count. The orchestrator reads THIS
  // array (via `--json`, or the CRM report detail), researches each one,
  // writes agent/research/results/*.json files matching each
  // `findingKey`, then resumes this exact run (see runner.js's
  // `resumeRunId`).
  const questionsPending = findings
    .filter((f) => f.decision === "RESEARCH_MORE")
    .map((f) => f.researchQuestion)
    .filter(Boolean);

  const actionableOpenCount = countBy(
    findings,
    (f) => f.tier === "actionable" && f.decision !== "APPLY_SAFE_FIX" && f.status !== "applied"
  );
  const observationsCount = countBy(findings, (f) => f.tier === "observation");
  const opportunitiesCount = countBy(findings, (f) => f.tier === "opportunity");

  // Phase 6 — first-party evidence (Search Console/GA4/URL Inspection)
  // summary. Deliberately NOT part of status/healthSummary computation —
  // see agent/README.md's Phase 6 "metrics are signals, not decisions"
  // rule: this section may only ever REPORT what first-party evidence was
  // configured/gathered/pending, never flip a run between all-clear/
  // needs-attention by itself (that stays driven entirely by findings/
  // proposals, computed above, unchanged by this phase) — the ONE
  // exception, matching research's existing precedent exactly, is that
  // an UNRESOLVED question (not a metric value) can keep a run from
  // finalizing as "completed" — see computeRunStatus() above. Built from
  // each finding's own `.firstPartyEvidence` (attached by
  // firstparty-intake.js strictly AFTER decideAll() already ran — see
  // that file's header), never from a live API call.
  const findingFirstPartyAttached = findings.flatMap((f) =>
    Array.isArray(f.firstPartyEvidence) ? f.firstPartyEvidence.map((entry) => ({ entry, findingKey: f.key, rotationSlug: null })) : []
  );
  // Phase 7B — a weekly run's rotation picks (agent/lib/research-
  // rotation.js) can ALSO carry attached first-party evidence (by
  // runner.js's call to firstparty-intake.js's attachRotationEvidence(),
  // matched by rotationSlug — see that file's header). Folded into the
  // SAME aggregate counts/sourcesNotConsulted below, since it is
  // genuinely first-party evidence gathered this run, regardless of
  // whether a Finding or a rotation pick prompted it — the earlier
  // Weekly-run gap this closes was exactly that Search Console/GA4
  // showed up as "not consulted" even when rotation evidence HAD been
  // gathered, simply because nothing merged it into this summary.
  const rotationFirstPartyAttached = (rotationPriorities || []).flatMap((p) =>
    Array.isArray(p.firstPartyEvidence) ? p.firstPartyEvidence.map((entry) => ({ entry, findingKey: null, rotationSlug: p.slug })) : []
  );
  const firstPartyAttached = [...findingFirstPartyAttached, ...rotationFirstPartyAttached];
  const firstPartyCountsBySource = {};
  for (const source of FIRST_PARTY_SOURCES) firstPartyCountsBySource[source] = 0;
  for (const { entry } of firstPartyAttached) {
    firstPartyCountsBySource[entry.source] = (firstPartyCountsBySource[entry.source] || 0) + 1;
  }
  const sourcesConsulted = new Set(firstPartyAttached.map(({ entry }) => entry.source));
  const sourcesNotConsulted = FIRST_PARTY_SOURCES.filter((s) => !sourcesConsulted.has(s));

  // Lifecycle-tightening: distinguishes evidence genuinely fetched
  // DURING this logical run (after the initial pass, picked up by a
  // resume — see runner.js's resumeRunId) from evidence that already
  // existed beforehand and was simply reused. A fresh, single-pass run
  // (no resume) has `runStartedAt === now`, so nothing can postdate it —
  // everything attached on a single pass is correctly "reused" (the
  // network-free deterministic runner never fetches anything itself;
  // anything attached was necessarily gathered by an earlier session —
  // for a rotation pick, that's the separate --refresh-rotation-evidence
  // step, run moments earlier in the same job).
  const firstPartyItems = firstPartyAttached.map(({ entry, findingKey, rotationSlug }) => {
    const gatheredDuringThisRun = new Date(entry.fetchedAt) > runStartedAt;
    return {
      findingKey,
      rotationSlug,
      source: entry.source,
      metric: entry.metric,
      scope: entry.scope,
      window: entry.window.label,
      freshness: computeFirstPartyFreshness(entry, now).status,
      context: entry.context,
      gatheredDuringThisRun,
    };
  });
  const gatheredDuringThisRunCount = firstPartyItems.filter((i) => i.gatheredDuringThisRun).length;

  // Lifecycle-tightening — which open findings would genuinely benefit
  // from a targeted first-party check, raised NOW (only for a finding
  // that's NEW this run — see firstparty-candidates.js's header on why
  // an older still-open finding doesn't keep re-blocking every
  // subsequent run) so the orchestrator can gather evidence BEFORE this
  // run finalizes, not only after (the exact gap the first live Phase 6
  // validation surfaced).
  const newKeysThisRun = new Set(changeDetection.new);
  const firstPartyQuestionsPending = findings
    .filter((f) => isFirstPartyEvidenceCandidate(f, { isNewThisRun: newKeysThisRun.has(f.key) }))
    .map(buildFirstPartyEvidenceQuestion);

  const firstPartyEvidence = {
    integrations: {
      searchConsole: Boolean(firstPartyIntegrations && firstPartyIntegrations.searchConsole),
      ga4: Boolean(firstPartyIntegrations && firstPartyIntegrations.ga4),
    },
    gatheredThisRunCount: firstPartyAttached.length,
    gatheredDuringThisRunCount,
    reusedFromBeforeCount: firstPartyAttached.length - gatheredDuringThisRunCount,
    countsBySource: firstPartyCountsBySource,
    sourcesNotConsulted,
    questionsRaisedCount: firstPartyQuestionsPending.length,
    questionsPending: firstPartyQuestionsPending,
    items: firstPartyItems,
  };

  // Phase 7B — closes the "rotation selects a target but nothing
  // reviews it" gap (see agent/lib/rotation-evidence.js's header for
  // the full root-cause writeup). Rotation picks STILL never produce
  // PROPOSE_CHANGE and STILL never block run finalization (§4/§11's
  // rules are unchanged) — this only makes the report tell the truth
  // about which picks were actually researched, with what, and why not
  // when they weren't, instead of silently looking identical to a
  // genuinely-completed deep review.
  const rotationPicks = (rotationPriorities || []).map((p) => {
    const candidate = isRotationEvidenceCandidate(p);
    const evidenceList = Array.isArray(p.firstPartyEvidence) ? p.firstPartyEvidence : [];
    if (!candidate) {
      return {
        slug: p.slug,
        name: p.name,
        hasPage: p.hasPage,
        score: p.score,
        reasons: p.reasons,
        researched: false,
        firstPartyEvidence: [],
        evidenceFreshness: null,
        conclusion: null,
        conclusionReason: `${p.name} already has a dedicated page — reviewed through the ordinary daily audit + first-party-evidence pipeline for that page, not this rotation mechanism.`,
        externalResearchPerformed: false,
        externalResearchCapability: EXTERNAL_RESEARCH_CAPABILITY_MISSING,
      };
    }
    const classified = classifyRotationConclusion(evidenceList[0] || null, {
      searchConsoleConfigured: Boolean(firstPartyIntegrations && firstPartyIntegrations.searchConsole),
    });
    // Surfaces the evidence's own age alongside the conclusion — a
    // reader must never mistake a `NO_CHANGE` grounded in months-old
    // data for a fresh, current answer. `--refresh-rotation-evidence`
    // (cli.js) already treats stale evidence as absent and re-fetches,
    // so this should normally read "fresh"; a non-fresh value here
    // means that re-fetch didn't happen this run (e.g. Search Console
    // was unreachable) — visible, never hidden.
    const evidenceFreshness = evidenceList[0] ? computeFirstPartyFreshness(evidenceList[0], now).status : null;
    return {
      slug: p.slug,
      name: p.name,
      hasPage: p.hasPage,
      score: p.score,
      reasons: p.reasons,
      researched: classified.researched,
      firstPartyEvidence: evidenceList,
      evidenceFreshness,
      conclusion: classified.conclusion,
      conclusionReason: classified.reason,
      externalResearchPerformed: false,
      externalResearchCapability: EXTERNAL_RESEARCH_CAPABILITY_MISSING,
    };
  });

  const rotationSummary = rotationPriorities
    ? {
        targetsSelected: rotationPicks.length,
        targetsPageless: rotationPicks.filter((p) => !p.hasPage).length,
        targetsActuallyResearched: rotationPicks.filter((p) => p.researched).length,
        targetsConcludedNoChange: rotationPicks.filter((p) => p.conclusion === "NO_CHANGE").length,
        targetsConcludedResearchMore: rotationPicks.filter((p) => p.conclusion === "RESEARCH_MORE").length,
        targetsNotYetResearched: rotationPicks.filter((p) => !p.researched).length,
        proposalsCreatedFromRotation: 0, // structurally always 0 — see §11's rule, unchanged by this phase
        externalResearchPerformed: 0,
        externalResearchCapability: EXTERNAL_RESEARCH_CAPABILITY_MISSING,
      }
    : null;

  // First-Party Signals — derived, investigation-only leads computed
  // from the SAME attached `.firstPartyEvidence` the section above
  // reads, by agent/lib/firstparty-signals.js (see that file's header).
  // Deliberately kept as its own, separate, clearly-labeled report
  // section — this report now distinguishes three genuinely different
  // things, and conflating any two of them would recreate exactly the
  // "metrics quietly become decisions" risk this architecture was built
  // to avoid:
  //   1. `firstPartyEvidence` (above)  — RAW/NORMALIZED first-party
  //      evidence: what was actually observed, bounded and sourced, no
  //      interpretation at all.
  //   2. `firstPartySignals` (here)    — DERIVED investigation leads:
  //      a bounded, named pattern noticed IN that evidence (e.g. a
  //      query/page mismatch), with its own stated limitations and an
  //      explicit investigation-only posture. Still not a decision.
  //   3. `proposals`/`safeFixes` (above) — ACTUAL Agent decisions: the
  //      only section this run's real site changes or owner-facing
  //      proposals ever come from. Computed entirely by
  //      agent/lib/decision.js, which never reads `.firstPartyEvidence`
  //      or `.firstPartySignals` — see tests/agent-firstparty-safety.test.js
  //      and tests/agent-firstparty-signals-safety.test.js.
  // Never folded into status/healthSummary computation (same rule
  // firstPartyEvidence already follows) — zero signals is a valid,
  // ordinary, successful result, same as zero findings.
  const firstPartySignalItems = findings.flatMap((f) => (Array.isArray(f.firstPartySignals) ? f.firstPartySignals : []));
  const firstPartySignals = {
    count: firstPartySignalItems.length,
    items: firstPartySignalItems,
  };

  const status = computeRunStatus({
    failure,
    hasUnresolvedResearch: questionsPending.length > 0,
    hasUnresolvedFirstPartyEvidence: firstPartyQuestionsPending.length > 0,
  });

  const healthSummary = buildHealthSummary({
    status,
    actionableOpenCount,
    proposalsAwaitingApproval,
    questionsPendingCount: questionsPending.length,
    firstPartyQuestionsPendingCount: firstPartyQuestionsPending.length,
    failure,
  });

  const report = {
    runId: record.runId,
    sequence: record.sequence || 1,
    status,
    timestamp: record.timestamp,
    runType: record.runType || "manual",
    mode: record.mode,
    pagesChecked: record.summary ? record.summary.pagesScanned : 0,
    healthSummary,
    technicalIssues: {
      actionableOpen: actionableOpenCount,
      byCategory: record.summary ? record.summary.byCategory : {},
    },
    observationsCount,
    opportunitiesCount,
    research: {
      questionsRaisedCount: questionsPending.length,
      questionsPending,
      performed: researchPerformed,
    },
    safeFixes: {
      appliedCount: safeFixesApplied.length,
      items: safeFixesApplied.map((f) => ({ key: f.key, summary: f.summary, page: f.pages && f.pages[0] })),
    },
    proposals: {
      createdOrUpdatedCount: proposalsCreatedOrUpdated.length,
      awaitingApprovalCount: proposalsAwaitingApproval,
      previouslyRejectedStillSurfacingCount: previouslyRejectedStillSurfacing,
      alreadyAppliedCount: alreadyApplied,
      items: proposalsCreatedOrUpdated.map((f) => ({
        key: f.key,
        summary: f.summary,
        decision: f.decision,
        proposalStatus: f.proposalStatus || null,
      })),
    },
    changeDetection,
    firstPartyEvidence,
    firstPartySignals,
    validation: record.validation || null,
    proposalsSyncSkippedReason: record.proposalsSync && record.proposalsSync.skipped ? record.proposalsSync.reason : null,
    failure: failure || null,
    rotation: rotationPriorities
      ? {
          picks: rotationPicks,
          summary: rotationSummary,
        }
      : null,
    nextReviewHint:
      record.runType === "weekly"
        ? "Next weekly deep review will rotate to a different set of service-area topics — see agent/history/research-rotation-state.json."
        : "A weekly deep-research run has not been scheduled yet in production — see agent/README.md's scheduling recommendation.",
  };

  return report;
}

module.exports = { buildReport, buildHealthSummary, computeRunStatus };
