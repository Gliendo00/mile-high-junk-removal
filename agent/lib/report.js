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

function countBy(findings, predicate) {
  return findings.filter(predicate).length;
}

// Checked in this exact order: failed > research_pending > completed. A
// run can be BOTH "has unresolved research" and "failed" (research was
// needed, then something else broke) — failed always wins, since "this
// run did not complete successfully" is the most important thing to say.
function computeRunStatus({ failure, hasUnresolvedResearch }) {
  if (failure) return "failed";
  if (hasUnresolvedResearch) return "research_pending";
  return "completed";
}

function buildHealthSummary({ status, actionableOpenCount, proposalsAwaitingApproval, questionsPendingCount, failure }) {
  if (status === "failed") {
    const detail = failure && failure.message ? ` (${failure.message})` : "";
    return { status: "failed", text: `This run did not complete successfully${detail} — see failure details below. No site changes were made based on a failed run.` };
  }
  if (status === "research_pending") {
    return {
      status: "research-pending",
      text: `Research needed before this run can be finalized — ${questionsPendingCount} question${questionsPendingCount === 1 ? "" : "s"} awaiting results.`,
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
 */
function buildReport({ record, previousRun, rotationPriorities, failure, firstPartyIntegrations }) {
  const findings = record.findings || [];
  const now = new Date(record.timestamp);

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
  // configured/gathered, never flip a run between all-clear/needs-
  // attention/research-pending by itself (that stays driven entirely by
  // findings/proposals/questionsPending, computed above, unchanged by
  // this phase). Built from each finding's own `.firstPartyEvidence`
  // (attached by firstparty-intake.js strictly AFTER decideAll() already
  // ran — see that file's header), never from a live API call.
  const firstPartyAttached = findings.flatMap((f) =>
    Array.isArray(f.firstPartyEvidence) ? f.firstPartyEvidence.map((entry) => ({ entry, findingKey: f.key })) : []
  );
  const firstPartyCountsBySource = {};
  for (const source of FIRST_PARTY_SOURCES) firstPartyCountsBySource[source] = 0;
  for (const { entry } of firstPartyAttached) {
    firstPartyCountsBySource[entry.source] = (firstPartyCountsBySource[entry.source] || 0) + 1;
  }
  const firstPartyEvidence = {
    integrations: {
      searchConsole: Boolean(firstPartyIntegrations && firstPartyIntegrations.searchConsole),
      ga4: Boolean(firstPartyIntegrations && firstPartyIntegrations.ga4),
    },
    gatheredThisRunCount: firstPartyAttached.length,
    countsBySource: firstPartyCountsBySource,
    items: firstPartyAttached.map(({ entry, findingKey }) => ({
      findingKey,
      source: entry.source,
      metric: entry.metric,
      scope: entry.scope,
      window: entry.window.label,
      freshness: computeFirstPartyFreshness(entry, now).status,
      context: entry.context,
    })),
  };

  const status = computeRunStatus({ failure, hasUnresolvedResearch: questionsPending.length > 0 });

  const healthSummary = buildHealthSummary({
    status,
    actionableOpenCount,
    proposalsAwaitingApproval,
    questionsPendingCount: questionsPending.length,
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
    validation: record.validation || null,
    proposalsSyncSkippedReason: record.proposalsSync && record.proposalsSync.skipped ? record.proposalsSync.reason : null,
    failure: failure || null,
    rotation: rotationPriorities
      ? {
          picks: rotationPriorities.map((p) => ({ slug: p.slug, name: p.name, hasPage: p.hasPage, score: p.score, reasons: p.reasons })),
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
