// Site Improvement Agent — risk/category classification.
//
// Assigns every finding one of five categories (per the product spec), a
// risk level, and (Phase 3) a `tier` distinguishing how much weight the
// finding itself carries:
//
//   "observation"  - a true, recorded fact that is NOT, on its own,
//                     sufficient evidence to warrant a change. Logged for
//                     transparency; decision.js always resolves this to
//                     NO_CHANGE, with an honest reason, never silently
//                     dropped and never inflated into busywork.
//   "opportunity"   - category C: plausible, but needs external evidence
//                     before it's known whether it's worth acting on.
//   "actionable"    - enough evidence already exists (internally, or
//                     because research confirmed it) to propose or apply
//                     a real change.
//
// This is a pure function over a finding's `type` plus a small amount of
// finding-specific context — it never looks at business content, so it
// cannot be swayed by anything an audit module "wants" to be true.
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
// Most low-risk findings are still propose-only; only the one mechanical,
// text-preserving fix registered in agent/lib/apply/ is eligible, and
// only when the finding itself says so via `autoFix`.

const RULES = {
  "broken-internal-link": { category: "A", riskLevel: "medium", tier: "actionable" },
  "broken-internal-link-fixable": { category: "A", riskLevel: "low", tier: "actionable" },
  "redirect-hop-internal-link": { category: "B", riskLevel: "low", tier: "actionable" },
  // Whether a page is linked from anywhere else is itself an internal,
  // mechanically-checkable fact (category A) — deciding whether that's a
  // real problem (vs. an intentionally unlinked page like a legal page)
  // needs a human judgment call, not external research, so this stays
  // propose-only without routing through the research layer.
  "orphan-page": { category: "A", riskLevel: "medium", tier: "actionable" },
  "sitemap-missing-file": { category: "A", riskLevel: "medium", tier: "actionable" },
  "sitemap-missing-url": { category: "A", riskLevel: "low", tier: "actionable" },
  // A page's own stated indexing intent (noindex) disagreeing with its
  // presence in sitemap.xml — worth a human's attention, but never
  // auto-resolved in either direction (see link-audit.js's
  // auditSitemapAndRobots() header on why this stops short of
  // automatic sitemap cleanup).
  "noindex-page-in-sitemap": { category: "A", riskLevel: "low", tier: "observation" },
  "robots-sitemap-conflict": { category: "A", riskLevel: "medium", tier: "actionable" },
  "missing-title": { category: "A", riskLevel: "medium", tier: "actionable" },
  "missing-meta-description": { category: "A", riskLevel: "medium", tier: "actionable" },

  // Phase 3 fix: length alone is weak evidence (see agent/README.md's
  // "Weak-finding semantics" section) — merely falling outside the
  // conventional character-count window is an OBSERVATION, not grounds
  // for a proposal. "title-malformed"/"description-malformed" (below) are
  // the escalated, actually-actionable versions seo-audit.js emits
  // instead when there's a stronger, specific reason (empty after trim,
  // placeholder-looking text, or severe enough truncation to plausibly
  // hide the page's distinguishing information).
  "title-length": { category: "B", riskLevel: "low", tier: "observation" },
  "description-length": { category: "B", riskLevel: "low", tier: "observation" },
  "title-malformed": { category: "A", riskLevel: "medium", tier: "actionable" },
  "description-malformed": { category: "A", riskLevel: "medium", tier: "actionable" },

  "duplicate-title": { category: "D", riskLevel: "high", tier: "actionable" },
  "duplicate-meta-description": { category: "C", riskLevel: "medium", tier: "opportunity" },
  "missing-canonical": { category: "A", riskLevel: "medium", tier: "actionable" },
  // Phase 14B — the first real finding type with an autoFix (see
  // seo-audit.js's auditSeo()). Deliberately stays "medium", not "low":
  // classify() below requires riskLevel "low" for autoApplyEligible, so
  // this always reaches PROPOSE_CHANGE and needs owner Approve + Execute
  // — never silently auto-applied, even though a mechanical fix exists.
  "canonical-mismatch": { category: "A", riskLevel: "medium", tier: "actionable" },
  "missing-json-ld": { category: "A", riskLevel: "medium", tier: "actionable" },
  "missing-h1": { category: "A", riskLevel: "medium", tier: "actionable" },
  "multiple-h1": { category: "B", riskLevel: "low", tier: "actionable" },
  "structural-inconsistency": { category: "C", riskLevel: "medium", tier: "opportunity" },
  "research-gap": { category: "C", riskLevel: "medium", tier: "opportunity" },

  // Phase 3 audit-surface expansion (see link-finding-audit.js,
  // cannibalization-audit.js, content-gap-audit.js, coverage-audit.js,
  // ux-audit.js, factual-consistency-audit.js).
  "weak-internal-support": { category: "A", riskLevel: "medium", tier: "observation" },
  "missing-contextual-link": { category: "B", riskLevel: "low", tier: "opportunity" },
  "overlapping-intent": { category: "C", riskLevel: "medium", tier: "opportunity" },
  "content-gap": { category: "C", riskLevel: "medium", tier: "opportunity" },
  "coverage-gap-candidate": { category: "C", riskLevel: "medium", tier: "opportunity" },
  "weak-cta": { category: "B", riskLevel: "low", tier: "observation" },
  "inconsistent-contact-info": { category: "A", riskLevel: "medium", tier: "actionable" },
  "no-next-action": { category: "B", riskLevel: "low", tier: "observation" },
  "factual-contradiction": { category: "D", riskLevel: "high", tier: "actionable" },
};

function classify(finding) {
  const rule = RULES[finding.type];
  if (!rule) {
    // Unknown finding type: fail safe rather than guess.
    return {
      ...finding,
      category: "E",
      riskLevel: "unknown",
      tier: "observation",
      autoApplyEligible: false,
    };
  }
  const autoApplyEligible = Boolean(finding.autoFix) && rule.riskLevel === "low" && rule.tier === "actionable";
  return {
    ...finding,
    category: rule.category,
    riskLevel: rule.riskLevel,
    tier: rule.tier,
    autoApplyEligible,
  };
}

function classifyAll(findings) {
  return findings.map(classify);
}

module.exports = { classify, classifyAll, RULES };
