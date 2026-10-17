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

// Phase 3: research questions must be narrow enough to produce a
// decision ("Is there enough evidence that X would benefit from Y on
// page Z?"), not a vague "research this topic" — see agent/README.md.
// Each finding type that routes through research gets its own
// specifically-worded question, grounded in that finding's own evidence,
// rather than one generic template for every category-C type.
function questionTextFor(finding) {
  const page = finding.pages[0];
  switch (finding.type) {
    case "content-gap": {
      const faqCount = (finding.evidence.find((e) => e.field === "faqQuestionCount") || {}).value;
      const avg = (finding.evidence.find((e) => e.field === "comparableAverage") || {}).value;
      return `${page} answers only ${faqCount} FAQ question(s) versus a ${avg}-question average among its comparable siblings — is there enough evidence that this page's actual topic has specific, genuinely useful practical questions not yet answered there, that would justify adding to its FAQ?`;
    }
    case "coverage-gap-candidate": {
      const serviceFile = (finding.evidence.find((e) => e.field === "serviceFile") || {}).value;
      const serviceName = String(serviceFile || "").replace(".html", "").replace(/-/g, " ");
      return `${serviceFile} is contextually promoted on most other city pages but not on ${page} — is there enough evidence that ${page}'s local market/search demand for "${serviceName}" is similar enough to its siblings to justify a contextual mention there, or is its omission actually appropriate for this specific area?`;
    }
    case "overlapping-intent": {
      const other = finding.pages.find((p) => p !== page);
      return `${page} and ${other} show high title/description/H1 similarity — is there enough evidence (from how each currently ranks/appears in search, and what each page's content actually covers) that these two pages are genuinely redundant rather than legitimately differentiated for two different searcher intents?`;
    }
    case "structural-inconsistency":
      return `${page} differs structurally from its comparable siblings (${finding.summary}) — is there enough evidence that this specific difference reflects a real content gap worth closing, rather than being an appropriate difference for this page?`;
    case "duplicate-meta-description":
      return `${finding.pages.join(" and ")} share an identical meta description — is there enough evidence that these pages serve different enough search intents to justify writing two distinct descriptions, rather than one of them being a deliberate near-copy?`;
    default:
      return `${finding.summary} ${finding.recommendation || ""}`.trim();
  }
}

function buildResearchQuestion(finding) {
  return {
    findingKey: finding.key,
    findingType: finding.type,
    pages: finding.pages,
    question: questionTextFor(finding),
    internalEvidence: finding.evidence,
    // A hint for whoever performs the research, not a requirement — see
    // research.js's SOURCE_TYPES for the full list.
    suggestedSourceTypes:
      finding.type === "structural-inconsistency" || finding.type === "overlapping-intent"
        ? ["search-results-observation", "official-government", "competitor-website"]
        : finding.type === "coverage-gap-candidate"
        ? ["search-results-observation", "official-government"]
        : ["internal-repo-review", "official-government"],
  };
}

// When more than one research result has accumulated for the same
// finding (e.g. re-researched later with better evidence), prefer the
// most recently accessed one rather than silently averaging confidence
// levels across results that may disagree.
//
// Phase 13a addition — PRECEDENCE, not just recency: a
// "cross-source-synthesis" result (agent/lib/cross-source-synthesis.js)
// is a mechanical COMBINATION of already-gathered evidence; it can
// never read prose, never establish a semantic relationship, and never
// override a human/Claude session's own reading-comprehension judgment
// (research.js's every other sourceType). "newest file wins" is NOT
// automatically the epistemically correct rule once two different
// AUTHORITY LEVELS can coexist for the same finding — a human/Claude
// result dated BEFORE a later-running synthesis pass must still win,
// or an unattended `--run-synthesis` could silently bury a genuine
// semantic contradiction a person already established, merely because
// it happened to run afterward. So: any human/Claude-authored result
// (sourceType other than "cross-source-synthesis") is preferred over
// EVERY cross-source-synthesis result, regardless of `accessedAt`;
// "most recent" is only the tiebreaker WITHIN one authority tier (the
// human-authored set among themselves, or — only when there is no
// human-authored result at all — the synthesis set among themselves,
// which is exactly where agent/lib/run-synthesis.js's own stale-support
// supersession mechanism does its work). This is deliberately the
// smallest possible rule: two tiers, recency breaks ties within a
// tier, nothing more elaborate.
function pickLatestResearch(researchList) {
  const sorted = [...researchList].sort((a, b) => new Date(b.accessedAt) - new Date(a.accessedAt));
  const humanAuthored = sorted.filter((r) => r.sourceType !== "cross-source-synthesis");
  return humanAuthored.length > 0 ? humanAuthored[0] : sorted[0];
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

  // Phase 3 weak-finding fix: an "observation" is a true, recorded fact
  // that is not, on its own, sufficient evidence to warrant a change
  // (e.g. a title/description merely falling outside the conventional
  // character-count window — see risk.js's RULES comment). This is
  // checked BEFORE the category-based logic below so an observation can
  // never accidentally fall through to PROPOSE_CHANGE just because its
  // category happens to be A or B. It never reaches the research layer
  // either — research is for genuine category-C opportunities, not for
  // upgrading a weak signal into a question.
  if (finding.tier === "observation") {
    return {
      decision: "NO_CHANGE",
      reason: "observation only — this signal by itself is not sufficient evidence to warrant a change; no corroborating signal (duplication, malformed content, inconsistency, etc.) was found",
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
