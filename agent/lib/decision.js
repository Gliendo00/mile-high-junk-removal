// Site Improvement Agent — decision engine.
//
// A classified finding (category + riskLevel + autoApplyEligible, from
// risk.js), possibly with research attached (from research-intake.js),
// does not automatically become a website edit. This module is the one
// place that turns "a finding" into one of five decisions, and records
// WHY — the reason is this module's own INFERENCE, kept visibly separate
// from the finding's internal evidence and any attached external research
// (see research.js's header for that three-way distinction).
//
// Only category-C findings ("content opportunity requiring research")
// are ever routed through the research question/answer loop — every other
// category is answerable from internal evidence alone, and sending it
// through research anyway would be exactly the wasted-research the
// product spec warns against ("DO I HAVE ENOUGH INTERNAL EVIDENCE? If
// yes: do not waste external research.").

const DECISIONS = [
  "APPLY_SAFE_FIX",
  "PROPOSE_CHANGE",
  "RESEARCH_MORE",
  "NO_CHANGE",
  "REJECT_OPPORTUNITY",
];

function needsExternalResearch(finding) {
  return finding.category === "C";
}

function buildResearchQuestion(finding) {
  return {
    findingKey: finding.key,
    findingType: finding.type,
    pages: finding.pages,
    question: `${finding.summary} ${finding.recommendation || ""}`.trim(),
    internalEvidence: finding.evidence,
    // A hint for whoever performs the research, not a requirement — see
    // research.js's SOURCE_TYPES for the full list.
    suggestedSourceTypes:
      finding.type === "structural-inconsistency"
        ? ["search-results-observation", "official-government", "competitor-website"]
        : ["internal-repo-review", "official-government"],
  };
}

// When more than one research result has accumulated for the same
// finding (e.g. re-researched later with better evidence), prefer the
// most recently accessed one rather than silently averaging confidence
// levels across results that may disagree.
function pickLatestResearch(researchList) {
  return [...researchList].sort((a, b) => new Date(b.accessedAt) - new Date(a.accessedAt))[0];
}

/**
 * @param {object} finding - a classified finding (risk.classify's output),
 *   with `.research` already attached (research-intake.attachResearch), or
 *   undefined/empty if none exists yet.
 * @returns {{decision:string, reason:string, researchQuestion?:object, requiresApproval?:boolean}}
 */
function decide(finding) {
  if (finding.autoApplyEligible) {
    return {
      decision: "APPLY_SAFE_FIX",
      reason: `mechanical, reversible fix available (${finding.autoFix.kind}) and risk is low — eligible for the Phase 1/2 auto-apply whitelist`,
    };
  }

  if (finding.category === "E") {
    return {
      decision: "NO_CHANGE",
      reason: "finding type not recognized by the risk model, or evidence too weak to classify — failing safe rather than guessing",
    };
  }

  if (needsExternalResearch(finding)) {
    const research = Array.isArray(finding.research) ? finding.research : [];
    if (research.length === 0) {
      return {
        decision: "RESEARCH_MORE",
        reason: "category-C content opportunity: internal evidence alone is not enough to decide whether this is worth acting on",
        researchQuestion: buildResearchQuestion(finding),
      };
    }

    const best = pickLatestResearch(research);

    if (best.confidence === "low" || best.verdict === "inconclusive") {
      return {
        decision: "NO_CHANGE",
        reason: `researched (${best.source}, confidence: ${best.confidence}, verdict: ${best.verdict}) but evidence remains too weak to act on. Limitations: ${best.limitations}`,
      };
    }

    if (best.verdict === "contradicts-opportunity") {
      return {
        decision: "REJECT_OPPORTUNITY",
        reason: `researched (${best.source}, confidence: ${best.confidence}) and the evidence indicates this isn't a real opportunity: ${best.recommendation}`,
      };
    }

    // verdict === "supports-opportunity" and confidence is medium/high
    return {
      decision: "PROPOSE_CHANGE",
      reason: `internal evidence plus external research (${best.source}, confidence: ${best.confidence}) support action: ${best.recommendation}`,
      requiresApproval: true,
    };
  }

  if (finding.category === "D") {
    return {
      decision: "PROPOSE_CHANGE",
      reason: "high-risk SEO change — internal evidence is clear, but this category always requires explicit owner approval before any action",
      requiresApproval: true,
    };
  }

  // category A or B, evidenced internally, no mechanical fix registered
  // for this specific finding — a human (or a future content-writing
  // step) still has to decide and execute it.
  return {
    decision: "PROPOSE_CHANGE",
    reason: "clear, internally-evidenced technical/low-risk improvement — needs a human (or content) decision to execute, no auto-fix registered for this finding",
  };
}

function decideAll(findings) {
  for (const f of findings) {
    Object.assign(f, decide(f));
  }
  return findings;
}

module.exports = { decide, decideAll, DECISIONS, needsExternalResearch, buildResearchQuestion, pickLatestResearch };
