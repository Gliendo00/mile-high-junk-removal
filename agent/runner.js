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
const { classifyAll } = require("./lib/risk");
const { attachResearch } = require("./lib/research-intake");
const { decideAll } = require("./lib/decision");
const { appendRun } = require("./lib/history");
const rewriteHref = require("./lib/apply/rewrite-href");
const { validateAndRevertIfNeeded } = require("./lib/validate");

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

function run(options = {}) {
  const mode = options.mode === "apply-safe" ? "apply-safe" : "dry-run";
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 8);

  const { pages, findings, researchWarnings } = gatherFindings();

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

  const record = {
    runId,
    timestamp: new Date().toISOString(),
    mode,
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
  };

  appendRun(record, options.logPath);
  return record;
}

module.exports = { run, gatherFindings, isWorkingTreeClean, applyEligible };
