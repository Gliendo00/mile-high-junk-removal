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
//
// Phase 5B — RESEARCH ORCHESTRATION LIFECYCLE (see agent/README.md's
// "Orchestrator architecture" section for the full design): this module
// itself still never touches the network — that invariant is unchanged.
// What's new is a RESUME capability so a research-capable orchestrator
// (a Claude-driven session) can run this pipeline, see which findings
// need external research (record.report.research.questionsPending),
// perform that research and write the result files, then call run()
// again with `resumeRunId` set to finish the SAME run:
//
//   run({ runType: "daily" })                 -> pass 1
//     -> if any finding is RESEARCH_MORE, the persisted report's
//        `status` is "research_pending" (NEVER "completed" or
//        "all-clear" — see report.js's computeRunStatus()) and
//        `record.runId` is returned for the orchestrator to resume.
//   ... orchestrator researches each questionsPending entry, writes
//       agent/research/results/*.json files matching their findingKey ...
//   run({ resumeRunId: record.runId })         -> pass 2 (same runId,
//        sequence 2) -> re-runs the full pipeline fresh (research-
//        intake.js picks up the new files automatically), finalizes to
//        "completed" or "failed".
//
// Both passes append their own line to the git-tracked, append-only
// history log (never rewritten — see history.js's header) sharing the
// same runId; history.latestByRunId() is what every READER (the CRM API,
// the dashboard) uses to collapse that into ONE current-state report, so
// the owner never sees confusing "before research"/"after research"
// duplicates. A run with no RESEARCH_MORE findings at all still
// finalizes in a single pass, exactly as before Phase 5B.

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
const { attachFirstPartyEvidence, attachRotationEvidence } = require("./lib/firstparty-intake");
const { attachFirstPartySignals } = require("./lib/firstparty-signals");
const { loadLocalSourceEvidence } = require("./lib/local-source-intake");
const { getEntries, loadRegistry } = require("./lib/local-source-registry");
const { loadLocalSourceCandidateLog } = require("./lib/local-source-candidate-log");
const { isSearchConsoleConfigured } = require("./lib/search-console-client");
const { isGa4Configured } = require("./lib/ga4-client");
const { appendRun, readAllRuns } = require("./lib/history");
const rewriteHref = require("./lib/apply/rewrite-href");
const { validateAndRevertIfNeeded } = require("./lib/validate");
const { syncProposals, needsOwnerReview } = require("./lib/proposals-sync");
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
  // Phase 6 — attached strictly AFTER decideAll() has already produced
  // every finding's `.decision`, so first-party evidence (Search
  // Console/GA4/URL Inspection — see firstparty-intake.js's header) can
  // never influence a decision via this pipeline's own call order, on
  // top of decision.js itself never reading this field at all.
  const { findings: withFirstParty, warnings: firstPartyWarnings } = attachFirstPartyEvidence(decided);
  // First-Party Signals — attached strictly AFTER both decideAll() AND
  // attachFirstPartyEvidence() above, same ordering guarantee as
  // firstparty-intake.js's own header describes: a signal is DERIVED
  // FROM already-attached evidence, and agent/lib/decision.js has
  // already produced every finding's `.decision` before this line runs
  // (and never reads `.firstPartySignals` regardless — see
  // agent/lib/firstparty-signals.js's header and
  // tests/agent-firstparty-signals-safety.test.js).
  const withFirstPartySignals = attachFirstPartySignals(withFirstParty);
  return { pages, findings: withFirstPartySignals, researchWarnings, firstPartyWarnings };
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
//
// Phase 5B: `excludeRunId` is set when resuming a run (see
// `resumeRunId` below) — the most recent record in history at that point
// is the SAME run's own research_pending line, not a genuinely different
// "previous" run to diff against. Without this, a resumed run would
// nonsensically compare itself to itself.
function readPreviousRun(logPath, excludeRunId) {
  try {
    const runs = readAllRuns(logPath).filter((r) => !excludeRunId || r.runId !== excludeRunId);
    if (!runs.length) return { previousRun: null, warning: null };
    const sorted = [...runs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return { previousRun: sorted[0], warning: null };
  } catch (e) {
    return { previousRun: null, warning: `could not read previous run history: ${e && e.message ? e.message : String(e)}` };
  }
}

// Phase 5B — locates the run to resume (see runner.js's module header
// "Research orchestration lifecycle" section). A run may be recorded as
// more than one line sharing the same runId (sequence 1, 2, ...); this
// returns the LATEST one and throws a clear, specific error if there is
// nothing by that runId, or if it's already finalized (completed/failed)
// — resuming a finalized run would silently double-sync proposals and
// duplicate validation against stale evidence, so it's refused outright
// rather than guessed at.
function findResumableRun(runId, logPath) {
  const runs = readAllRuns(logPath).filter((r) => r.runId === runId);
  if (!runs.length) {
    throw new Error(`No run found with runId "${runId}" to resume.`);
  }
  const latest = runs.sort((a, b) => (b.sequence || 1) - (a.sequence || 1))[0];
  const status = latest.report ? latest.report.status : latest.failed ? "failed" : "completed";
  if (status !== "research_pending") {
    throw new Error(`Run "${runId}" is not awaiting research (status: "${status}") — nothing to resume.`);
  }
  return latest;
}

async function run(options = {}) {
  let priorRecord = null;
  if (options.resumeRunId) {
    // Let a bad/already-finalized runId fail loudly and immediately —
    // before acquiring the lock or touching anything else — rather than
    // starting a pipeline run for a resume that was never going to be
    // valid in the first place.
    priorRecord = findResumableRun(options.resumeRunId, options.logPath);
  }

  const mode = options.mode !== undefined
    ? (options.mode === "apply-safe" ? "apply-safe" : "dry-run")
    : (priorRecord ? priorRecord.mode : "dry-run");
  const runType = RUN_TYPES.includes(options.runType)
    ? options.runType
    : (priorRecord ? priorRecord.runType : "manual");
  const runId = priorRecord ? priorRecord.runId : new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 8);
  const sequence = priorRecord ? (priorRecord.sequence || 1) + 1 : 1;

  const release = options.skipLock ? () => {} : acquireLock(runId, options.lockPath);
  try {
    return await runLocked({ options, mode, runType, runId, sequence, priorRecord });
  } finally {
    release();
  }
}

async function runLocked({ options, mode, runType, runId, sequence, priorRecord }) {
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
      sequence,
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
    const { previousRun } = readPreviousRun(options.logPath, priorRecord ? runId : null);
    const firstPartyIntegrations = { searchConsole: isSearchConsoleConfigured(), ga4: isGa4Configured() };
    failedRecord.report = buildReport({
      record: failedRecord,
      previousRun,
      failure,
      firstPartyIntegrations,
      initialTimestamp: priorRecord ? priorRecord.timestamp : failedRecord.timestamp,
      workflowStartedAt: process.env.WORKFLOW_STARTED_AT,
      // Phase 10 — filesystem-only read (no network), same category as
      // attachFirstPartyEvidence() above: surfaces whatever curated
      // local-source evidence already exists on disk even for a run
      // that otherwise failed, same honesty rule failure reporting
      // already follows elsewhere.
      localSourceEvidence: loadLocalSourceEvidence(),
      // Phase 11B — same filesystem-only-read category: the curated
      // registry itself (read-only; never written by the runner — see
      // local-source-registry.js's header) and the small, overwritten
      // outcome log --refresh-local-source-evidence leaves behind (see
      // local-source-candidate-log.js's header). Included even on a
      // failed run, same honesty rule as localSourceEvidence above.
      localSourceRegistryEntries: getEntries(loadRegistry()),
      localSourceCandidateLog: loadLocalSourceCandidateLog(),
    });
    appendRun(failedRecord, options.logPath);
    throw Object.assign(e, { recordedFailure: failedRecord });
  }

  const { pages, findings, researchWarnings, firstPartyWarnings } = pipelineResult;

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

  // Pre-acceptance hardening (audit finding #4) — moved up from where
  // this used to run only for change-detection further below, so
  // proposals-sync.js can also use it (see `previousOwnerReviewKeys`
  // immediately below). Reused verbatim at the change-detection call
  // site further down this function — the underlying history file isn't
  // written to again until this run's own appendRun() at the very end,
  // so reading it again later would just repeat the same read.
  const { previousRun, warning: historyWarning } = readPreviousRun(options.logPath, priorRecord ? runId : null);

  // Pre-acceptance hardening (audit finding #4) — the set of finding
  // `key`s that needed owner review (proposals-sync.js's own
  // needsOwnerReview()) as of the immediately preceding run, so
  // syncProposals() can tell "this finding_key has been continuously
  // present" apart from "this finding_key just reappeared after being
  // absent" — see proposals-sync.js's own header for why a reviewed
  // decision must not silently carry forward across that gap. `null`
  // (never an empty Set) when there is no previous run at all (the
  // very first run ever) — proposals-sync.js treats `null` as "unknown,
  // never force a reset on this alone," never as "everything was
  // absent."
  const previousOwnerReviewKeys = previousRun && Array.isArray(previousRun.findings)
    ? new Set(previousRun.findings.filter(needsOwnerReview).map((f) => f.key))
    : null;

  // Phase 5 — sync PROPOSE_CHANGE/REJECT_OPPORTUNITY findings into the
  // live, CRM-mutable agent_proposals table BEFORE building the per-
  // finding record entries below, so each finding's resulting
  // `proposalStatus` (proposed/approved/rejected/applied/validated —
  // statusByKey, see proposals-sync.js) can be stamped directly onto the
  // persisted record. Gracefully skipped whenever Supabase isn't
  // configured — never thrown, never affects whether the run succeeds.
  const proposalsSync = options.syncProposals === false
    ? { skipped: true, reason: "sync disabled for this run", synced: 0, total: 0, errors: [], statusByKey: {} }
    : await syncProposals(findings, runId, { client: options.proposalsSyncClient, previousOwnerReviewKeys });
  const statusByKey = proposalsSync.statusByKey || {};
  for (const f of findings) {
    f.proposalStatus = statusByKey[f.key] || null;
  }

  const record = {
    runId,
    sequence,
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
      // Bug fix (found while wiring in First-Party Signals): this field
      // was computed and attached to every finding by
      // attachFirstPartyEvidence() (see firstparty-intake.js), but was
      // never copied into THIS persisted/mapped record — so a finding's
      // own first-party evidence silently never reached
      // record.report.firstPartyEvidence or history, even though
      // report.js has always read `f.firstPartyEvidence` expecting it to
      // be there (only rotation-sourced evidence, passed through a
      // separate parameter, ever actually showed up). Same class of bug
      // as the Phase 4 `tier` fix above: classification/decisions were
      // never affected (computed from the in-memory finding either way),
      // only what got WRITTEN to the log for later display. See
      // tests/agent-firstparty-runner.test.js's end-to-end case.
      firstPartyEvidence: f.firstPartyEvidence && f.firstPartyEvidence.length ? f.firstPartyEvidence : undefined,
      // First-Party Signals — same pattern, same ordering guarantee
      // (attached strictly after decideAll() — see this file's
      // gatherFindings()). Investigation-only; see
      // agent/lib/firstparty-signals.js's header.
      firstPartySignals: f.firstPartySignals && f.firstPartySignals.length ? f.firstPartySignals : undefined,
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
    firstPartyWarnings: firstPartyWarnings && firstPartyWarnings.length ? firstPartyWarnings : undefined,
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
  //
  // Phase 5B: when RESUMING (priorRecord set), exclude this same runId
  // from "previous run" lookup (see readPreviousRun's header — a resumed
  // run must never diff itself against its own research_pending line).
  //
  // `previousRun`/`historyWarning` were already computed earlier in this
  // function (pre-acceptance hardening, audit finding #4 — see that
  // comment for why) — reused here verbatim rather than re-reading the
  // same, unmodified-since-then history file a second time.
  if (historyWarning) {
    record.researchWarnings = [...(record.researchWarnings || []), historyWarning];
  }

  let rotationPriorities = null;
  if (priorRecord) {
    // Resuming: this week's rotation picks were already decided (and
    // already persisted to research-rotation-state.json) during the
    // initial research_pending pass — carry them forward verbatim rather
    // than recomputing (which could pick different cities now that
    // `findings` has shifted) or double-marking them reviewed.
    rotationPriorities = priorRecord.report && priorRecord.report.rotation ? priorRecord.report.rotation.picks : null;
  } else if (runType === "weekly" && options.computeRotation !== false) {
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

  // Phase 7B — attaches any first-party evidence already written for
  // this week's picks (by the separate `--refresh-rotation-evidence`
  // step, run BEFORE this one — see that command's own header; this
  // call itself does no network I/O, same read-only-local-files
  // pattern as attachFirstPartyEvidence() above) so report.js can
  // classify each pick's actual research outcome instead of just
  // listing what was selected. A no-op when rotationPriorities is null
  // (daily runs, or weekly runs with rotation disabled).
  if (rotationPriorities) {
    attachRotationEvidence(rotationPriorities);
  }

  const firstPartyIntegrations = { searchConsole: isSearchConsoleConfigured(), ga4: isGa4Configured() };
  record.report = buildReport({
    record,
    previousRun,
    rotationPriorities,
    firstPartyIntegrations,
    initialTimestamp: priorRecord ? priorRecord.timestamp : record.timestamp,
    // Generic Website Agent workflow-execution boundary (not specific to
    // finding evidence) — set once via $GITHUB_ENV near the top of
    // .github/workflows/website-agent.yml's job, so every step after it
    // (including this one) automatically inherits it. Absent for
    // local/manual CLI runs — buildReport() falls back to
    // initialTimestamp's existing behavior in that case (see
    // report.js's parseWorkflowStartedAt()).
    workflowStartedAt: process.env.WORKFLOW_STARTED_AT,
    // Phase 10 — Curated Official Source Evidence: a filesystem-only read
    // (agent/research/local-sources/*.json), never a network call —
    // same category as attachFirstPartyEvidence() above. Deliberately
    // NOT attached to any finding/rotation pick (see local-source-
    // intake.js's own header on why) — report.js surfaces the whole
    // loaded list as its own, independent section instead.
    localSourceEvidence: loadLocalSourceEvidence(),
    // Phase 11B — see the failed-run buildReport() call above for why
    // these two are included unconditionally (cheap, network-free
    // filesystem reads); report.js itself gates its derived
    // localSourceCandidates section on rotationPriorities being present
    // (weekly runs only), so these have no effect on a daily run.
    localSourceRegistryEntries: getEntries(loadRegistry()),
    localSourceCandidateLog: loadLocalSourceCandidateLog(),
  });

  appendRun(record, options.logPath);
  return record;
}

module.exports = { run, gatherFindings, isWorkingTreeClean, applyEligible, findResumableRun, RUN_TYPES };
