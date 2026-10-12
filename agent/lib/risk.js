// Site Improvement Agent — risk/category classification.
//
// Assigns every finding one of five categories (per the product spec) and
// a risk level. This is a pure function over a finding's `type` plus a
// small amount of finding-specific context — it never looks at business
// content, so it cannot be swayed by anything an audit module "wants" to
// be true.
//
// Categories:
//   A - technical/site-quality issue
//   B - clear low-risk improvement
//   C - content opportunity requiring research
//   D - major/high-risk SEO change
//   E - insufficient evidence — do nothing
//
// autoApplyEligible is intentionally a separate, much narrower flag than
// "risk is low" — see agent/README.md's "Auto-apply whitelist" section.
// Most low-risk findings are still propose-only in Phase 1; only the one
// mechanical, text-preserving fix registered in agent/lib/apply/ is
// eligible, and only when the finding itself says so via `autoFix`.

const RULES = {
  "broken-internal-link": { category: "A", riskLevel: "medium" },
  "broken-internal-link-fixable": { category: "A", riskLevel: "low" },
  "redirect-hop-internal-link": { category: "B", riskLevel: "low" },
  "orphan-page": { category: "C", riskLevel: "medium" },
  "sitemap-missing-file": { category: "A", riskLevel: "medium" },
  "sitemap-missing-url": { category: "A", riskLevel: "low" },
  "robots-sitemap-conflict": { category: "A", riskLevel: "medium" },
  "missing-title": { category: "A", riskLevel: "medium" },
  "missing-meta-description": { category: "A", riskLevel: "medium" },
  "title-length": { category: "B", riskLevel: "low" },
  "description-length": { category: "B", riskLevel: "low" },
  "duplicate-title": { category: "D", riskLevel: "high" },
  "duplicate-meta-description": { category: "C", riskLevel: "medium" },
  "missing-canonical": { category: "A", riskLevel: "medium" },
  "canonical-mismatch": { category: "A", riskLevel: "medium" },
  "missing-json-ld": { category: "A", riskLevel: "medium" },
  "missing-h1": { category: "A", riskLevel: "medium" },
  "multiple-h1": { category: "B", riskLevel: "low" },
  "structural-inconsistency": { category: "C", riskLevel: "medium" },
  "research-gap": { category: "C", riskLevel: "medium" },
};

function classify(finding) {
  const rule = RULES[finding.type];
  if (!rule) {
    // Unknown finding type: fail safe rather than guess.
    return {
      ...finding,
      category: "E",
      riskLevel: "unknown",
      autoApplyEligible: false,
    };
  }
  const autoApplyEligible = Boolean(finding.autoFix) && rule.riskLevel === "low";
  return {
    ...finding,
    category: rule.category,
    riskLevel: rule.riskLevel,
    autoApplyEligible,
  };
}

function classifyAll(findings) {
  return findings.map(classify);
}

module.exports = { classify, classifyAll, RULES };
