// Site Improvement Agent — runner.
//
// Orchestrates one full run:
//   scan -> audit -> classify (risk.js) -> attach research (research-
//   intake.js) -> decide (decision.js) -> apply the narrow auto-fix
//   whitelist, if eligible and allowed -> validate + auto-revert on
//   failure (validate.js) -> record history.
//
// Always appends to history, even when nothing happens — "no worthwhile
// change today" is a valid, loggable result.
//
// Modes:
//   "dry-run"   (default) - never touches any file. Safe to run anywhere,
//                any time, including in CI/tests.
//   "apply-safe"           - additionally applies findings whose decision
//                is APPLY_SAFE_FIX. Refuses to run at all if the working
//                tree is dirty, so an apply run's diff is always
//                attributable to exactly that run. Every applied fix is
//                re-scanned and validated before the run record is
//                written; a fix that doesn't verify is reverted
//                automatically using the same mechanical, single-
//                unambiguous-occurrence rewrite mechanism as the fix
//                itself.

const { execSync } = require("child_process");
const config = require("./config");
const { scanAllPages } = require("./lib/scan");
const { auditLinks, auditSitemapAndRobots } = require("./lib/link-audit");
const { auditSeo } = require("./lib/seo-audit");
const { auditConsistency } = require("./lib/consistency-audit");
const { auditInternalLinking } = require("./lib/internal-linking-audit");
const { auditCannibalization } = require("./lib/cannibalization-audit");
const { auditContentGaps } = require("./lib/content-gap-audit");
const { auditCoverage } = require("./lib/coverage-audit");
const { auditUx } = require("./lib/ux-audit");
const { auditFactualConsistency } = require("./lib/factual-consistency-audit");
const { classifyAll } = require("./lib/risk");
const { attachResearch } = require("./lib/research-intake");
const { decideAll } = require("./lib/decision");
const { appendRun, readAllRuns } = require("./lib/history");
const rewriteHref = require("./lib/apply/rewrite-href");
const { validateAndRevertIfNeeded } = require("./lib/validate");
const { syncProposals } = require("./lib/proposals-sync");
const { acquireLock } = require("./lib/run-lock");
const { buildReport } = require("./lib/report");
const { loadCompletedJobEvidence, summarizeByCity } = require("./lib/completed-job-intake");
const { computePriorities, loadRotationState, saveRotationState, markReviewed } = require("./lib/research-rotation");

const RUN_TYPES = ["daily", "weekly", "manual"];

function isWorkingTreeClean() {
  try {
    const out = execSync("git status --porcelain", { cwd: config.SITE_ROOT, encoding: "utf8" });
    return out.trim().length === 0;
  } catch (e) {
    // Not a git repo, or git unavailable — fail safe: treat as dirty so
    // apply-safe mode refuses rather than silently writing untracked.
    return false;
  }
}

// The full scan->audit->classify->research->decide pipeline, with no
// side effects — safe to call as many times in one process as needed
// (the runner calls it again, post-apply, purely to validate).
function gatherFindings() {
  const pages = scanAllPages();
  const findings = [
    ...auditLinks(pages),
    ...auditSitemapAndRobots(pages),
    ...auditSeo(pages),
    ...auditConsistency(pages),
    ...auditInternalLinking(pages),
    ...auditCannibalization(pages),
    ...auditContentGaps(pages),
    ...auditCoverage(pages),
    ...auditUx(pages),
    ...auditFactualConsistency(pages),
  ];
  const classified = classifyAll(findings);
  const { findings: withResearch, warnings: researchWarnings } = attachResearch(classified);
  const decided = decideAll(withResearch);
  return { pages, findings: decided, researchWarnings };
}

function applyEligible(findings) {
  const applied = [];
  for (const finding of findings) {
    if (finding.decision !== "APPLY_SAFE_FIX") {
      finding.status = "proposed";
      continue;
    }
    if (finding.autoFix.kind !== "rewrite-href") {
      // Unknown fixer kind — do not attempt; stay proposal-only.
      finding.status = "proposed";
      continue;
    }
    const result = rewriteHref.apply(finding.autoFix);
    if (result.changed) {
      finding.status = "applied";
      finding.appliedResult = result;
      applied.push(finding);
    } else {
      finding.status = "apply-refused";
      finding.applyRefusedReason = result.reason;
    }
  }
  return applied;
}

// Reads the previous run from history for change-detection, failing safe
// (null, with a warning) rather than throwing if the log is malformed or
// unreadable — see agent/README.md's failure-safety section: a corrupt
// history file must never block a new run from happening.
function readPreviousRun(logPath) {
  try {
    const runs = readAllRuns(logPath);
    if (!runs.length) return { previousRun: null, warning: null };
    const sorted = [...runs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return { previousRun: sorted[0], warning: null };
  } catch (e) {
    return { previousRun: null, warning: `could not read previous run history: ${e && e.message ? e.message : String(e)}` };
  }
}

async function run(options = {}) {
  const mode = options.mode === "apply-safe" ? "apply-safe" : "dry-run";
  const runType = RUN_TYPES.includes(options.runType) ? options.runType : "manual";
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 8);

  const release = options.skipLock ? () => {} : acquireLock(runId, options.lockPath);
  try {
    return await runLocked({ options, mode, runType, runId });
  } finally {
    release();
  }
}

async function runLocked({ options, mode, runType, runId }) {
  // Failure safety (agent/README.md): if the scan/audit/decide pipeline
  // itself throws, this run must still produce an honest, persisted
  // record saying so — never silently nothing, and never a record that
  // looks like a successful "no findings" run. Apply/validate's own
  // narrower try/catch-equivalents (isWorkingTreeClean's fail-safe,
  // validate.js's revert-or-flag logic) are unaffected; this is the
  // outer guard around the whole pipeline.
  let pipelineResult;
  try {
    pipelineResult = gatherFindings();
  } catch (e) {
    const failure = { message: e && e.message ? e.message : String(e) };
    const failedRecord = {
      runId,
      timestamp: new Date().toISOString(),
      mode,
      runType,
      failed: true,
      applySkippedReason: null,
      summary: { pagesScanned: 0, findingsTotal: 0, byCategory: {}, byDecision: {}, autoApplied: 0, proposed: 0, researchQuestionsRaised: 0 },
      findings: [],
      researchQuestions: [],
      validation: { performed: false, confirmed: 0, reverted: 0, notes: "run failed before validation could occur" },
      proposalsSync: { skipped: true, reason: "run failed before proposal sync could occur", synced: 0, total: 0, errors: [] },
    };
    const { previousRun } = readPreviousRun(options.logPath);
    failedRecord.report = buildReport({ record: failedRecord, previousRun, failure });
    appendRun(failedRecord, options.logPath);
    throw Object.assign(e, { recordedFailure: failedRecord });
  }

  const { pages, findings, researchWarnings } = pipelineResult;

  let appliedFindings = [];
  let applySkippedReason = null;
  let validationSummary = { performed: false, confirmed: 0, reverted: 0 };

  if (mode === "apply-safe") {
    if (!isWorkingTreeClean()) {
      applySkippedReason = "working tree is not clean — refusing to apply changes; ran as dry-run instead";
      for (const f of findings) f.status = "proposed";
    } else {
      appliedFindings = applyEligible(findings);
      if (appliedFindings.length > 0) {
        const result = validateAndRevertIfNeeded(appliedFindings, () => gatherFindings().findings);
        validationSummary = { performed: true, confirmed: result.confirmed, reverted: result.reverted };
      }
    }
  } else {
    for (const f of findings) f.status = "proposed";
  }

  const byCategory = {};
  const byDecision = {};
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    byDecision[f.decision] = (byDecision[f.decision] || 0) + 1;
  }

  const researchQuestions = findings
    .filter((f) => f.decision === "RESEARCH_MORE")
    .map((f) => f.researchQuestion);

  const confirmedAppliedCount = appliedFindings.filter((f) => f.status === "applied").length;

  // Phase 5 — sync PROPOSE_CHANGE/REJECT_OPPORTUNITY findings into the
  // live, CRM-mutable agent_proposals table BEFORE building the per-
  // finding record entries below, so each finding's resulting
  // `proposalStatus` (proposed/approved/rejected/applied/validated —
  // statusByKey, see proposals-sync.js) can be stamped directly onto the
  // persisted record. Gracefully skipped whenever Supabase isn't
  // configured — never thrown, never affects whether the run succeeds.
  const proposalsSync = options.syncProposals === false
    ? { skipped: true, reason: "sync disabled for this run", synced: 0, total: 0, errors: [], statusByKey: {} }
    : await syncProposals(findings, runId, { client: options.proposalsSyncClient });
  const statusByKey = proposalsSync.statusByKey || {};
  for (const f of findings) {
    f.proposalStatus = statusByKey[f.key] || null;
  }

  const record = {
    runId,
    timestamp: new Date().toISOString(),
    mode,
    runType,
    applySkippedReason,
    summary: {
      pagesScanned: pages.length,
      findingsTotal: findings.length,
      byCategory,
      byDecision,
      autoApplied: confirmedAppliedCount,
      proposed: findings.length - confirmedAppliedCount,
      researchQuestionsRaised: researchQuestions.length,
    },
    findings: findings.map((f) => ({
      id: f.id,
      key: f.key,
      type: f.type,
      category: f.category,
      riskLevel: f.riskLevel,
      // Phase 4 bug fix: this was missing entirely, so every persisted
      // run record silently lost risk.js's tier (observation/opportunity/
      // actionable) — history.js's iconForFinding()/describeFinding()
      // both key off `finding.tier` to distinguish an observation-tier
      // NO_CHANGE from a genuinely-researched one, so without this the
      // CRM activity feed mislabeled every observation as "Reviewed:
      // ... no change needed" (research icon) instead of "Observed: ...
      // not actionable on its own" (observation icon). Classification,
      // decisions, and proposal sync are all computed from the in-memory
      // finding either way and were never affected by this — only what
      // got WRITTEN to the log for later display.
      tier: f.tier,
      autoApplyEligible: f.autoApplyEligible,
      decision: f.decision,
      decisionReason: f.reason,
      requiresApproval: f.requiresApproval || false,
      status: f.status,
      summary: f.summary,
      pages: f.pages,
      evidence: f.evidence,
      research: f.research && f.research.length ? f.research : undefined,
      researchQuestion: f.researchQuestion || undefined,
      recommendation: f.recommendation,
      appliedResult: f.appliedResult || null,
      applyRefusedReason: f.applyRefusedReason || null,
      validation: f.validation || null,
      revertResult: f.revertResult || null,
      // Phase 5 — see statusByKey above. null whenever sync was skipped or
      // this particular finding never needed owner review in the first
      // place (e.g. an APPLY_SAFE_FIX or NO_CHANGE finding).
      proposalStatus: f.proposalStatus || null,
    })),
    researchQuestions,
    researchWarnings: researchWarnings.length ? researchWarnings : undefined,
    validation: {
      ...validationSummary,
      notes:
        appliedFindings.length > 0
          ? `${confirmedAppliedCount} mechanical fix(es) confirmed-resolved after re-scan; ${validationSummary.reverted} reverted automatically; re-run tests and review the diff before committing.`
          : "no changes applied",
    },
    proposalsSync,
  };

  // Phase 5 — change detection against the previous run, and (weekly runs
  // only) this week's research-rotation picks, both folded into one
  // persisted `report` object so the CRM API layer never has to
  // recompute either on every read (see agent/lib/report.js's header).
  const { previousRun, warning: historyWarning } = readPreviousRun(options.logPath);
  if (historyWarning) {
    record.researchWarnings = [...(record.researchWarnings || []), historyWarning];
  }

  let rotationPriorities = null;
  if (runType === "weekly" && options.computeRotation !== false) {
    const { evidence } = loadCompletedJobEvidence(options.completedJobsDir);
    const citySummary = summarizeByCity(evidence);
    const rotationState = loadRotationState(options.rotationStatePath);
    rotationPriorities = computePriorities({
      state: rotationState,
      currentFindings: findings,
      completedJobCitySummary: citySummary,
      limit: options.rotationLimit,
    });
    if (options.persistRotationState !== false) {
      const nextState = markReviewed(rotationState, rotationPriorities.map((p) => p.slug), runId);
      saveRotationState(nextState, options.rotationStatePath);
    }
  }

  record.report = buildReport({ record, previousRun, rotationPriorities });

  appendRun(record, options.logPath);
  return record;
}

module.exports = { run, gatherFindings, isWorkingTreeClean, applyEligible, RUN_TYPES };
