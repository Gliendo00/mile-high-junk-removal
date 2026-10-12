// Site Improvement Agent — Phase 1 runner.
//
// Orchestrates one full run: scan -> audit -> classify -> (optionally
// apply the narrow auto-fix whitelist) -> record history. Always appends
// to history, even when nothing happens — "no worthwhile change today" is
// a valid, loggable result.
//
// Modes:
//   "dry-run"   (default) - never touches any file. Safe to run anywhere,
//                any time, including in CI/tests.
//   "apply-safe"           - additionally applies findings where
//                autoApplyEligible is true. Refuses to run at all if the
//                working tree is dirty, so an apply run's diff is always
//                attributable to exactly that run.

const { execSync } = require("child_process");
const config = require("./config");
const { scanAllPages } = require("./lib/scan");
const { auditLinks, auditSitemapAndRobots } = require("./lib/link-audit");
const { auditSeo } = require("./lib/seo-audit");
const { auditConsistency } = require("./lib/consistency-audit");
const { classifyAll } = require("./lib/risk");
const { appendRun } = require("./lib/history");
const rewriteHref = require("./lib/apply/rewrite-href");

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

function gatherFindings() {
  const pages = scanAllPages();
  const findings = [
    ...auditLinks(pages),
    ...auditSitemapAndRobots(pages),
    ...auditSeo(pages),
    ...auditConsistency(pages),
  ];
  return { pages, findings: classifyAll(findings) };
}

function applyEligible(findings) {
  let appliedCount = 0;
  for (const finding of findings) {
    if (!finding.autoApplyEligible) {
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
      appliedCount += 1;
    } else {
      finding.status = "proposed";
      finding.applyRefusedReason = result.reason;
    }
  }
  return appliedCount;
}

function run(options = {}) {
  const mode = options.mode === "apply-safe" ? "apply-safe" : "dry-run";
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 8);

  const { pages, findings } = gatherFindings();

  let appliedCount = 0;
  let applySkippedReason = null;
  if (mode === "apply-safe") {
    if (!isWorkingTreeClean()) {
      applySkippedReason = "working tree is not clean — refusing to apply changes; ran as dry-run instead";
      for (const f of findings) f.status = "proposed";
    } else {
      appliedCount = applyEligible(findings);
    }
  } else {
    for (const f of findings) f.status = "proposed";
  }

  const byCategory = {};
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  }

  const record = {
    runId,
    timestamp: new Date().toISOString(),
    mode,
    applySkippedReason,
    summary: {
      pagesScanned: pages.length,
      findingsTotal: findings.length,
      byCategory,
      autoApplied: appliedCount,
      proposed: findings.length - appliedCount,
    },
    findings: findings.map((f) => ({
      id: f.id,
      type: f.type,
      category: f.category,
      riskLevel: f.riskLevel,
      autoApplyEligible: f.autoApplyEligible,
      status: f.status,
      summary: f.summary,
      pages: f.pages,
      evidence: f.evidence,
      recommendation: f.recommendation,
      appliedResult: f.appliedResult || null,
      applyRefusedReason: f.applyRefusedReason || null,
    })),
    validation: {
      // Phase 1 has no automated post-apply re-scan yet — see README's
      // "Recommended Phase 2" for closing this loop.
      notes: appliedCount > 0
        ? `${appliedCount} mechanical fix(es) applied; re-run tests and review the diff before committing.`
        : "no changes applied",
    },
  };

  appendRun(record, options.logPath);
  return record;
}

module.exports = { run, gatherFindings, isWorkingTreeClean };
