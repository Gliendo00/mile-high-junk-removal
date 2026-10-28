// Site Improvement Agent, Phase 15 — importance classification.
//
// The new default workflow: DISCOVER -> RESEARCH -> CLASSIFY IMPORTANCE
// -> propose only when justified -> Claude handoff report. This module
// is the CLASSIFY step — a new, separate axis from risk.js's
// category/tier and decision.js's DECISIONS enum (PROPOSE_CHANGE etc.),
// deliberately layered ON TOP of them rather than replacing either (see
// agent/README.md's own precedent for layering new phases on an
// unmodified decision engine). decision.js stays untouched: it is
// heavily tested and already correct for every existing finding type.
//
// Four classifications (never a numeric score):
//   IMPORTANT    - strong enough to create a proposal.
//   WATCH        - potentially useful, not strong enough yet; monitor,
//                  reconsider when evidence materially changes. Never a
//                  proposal.
//   LOW_SUPPRESS - not worth acting on. Never a proposal.
//   PROTECT      - evidence suggests avoiding unnecessary change here;
//                  stronger evidence could still override this later.
//                  Never a proposal (unless/until it does).
//
// Importance and evidence confidence are DELIBERATELY SEPARATE axes
// (same rule keyword-opportunities.js's own `priority` vs
// `evidenceConfidence` split already established) — an IMPORTANT finding
// with MEDIUM confidence is not the same as one with HIGH confidence,
// and this module never collapses the two.
//
// FAILURE HANDLING: classifyOpportunity() never throws. A failure
// anywhere in this module (a malformed finding, an unexpected shape)
// always resolves to WATCH, never IMPORTANT and never a crash — see
// classifyOpportunity()'s own try/catch. One finding's evidence being
// unavailable never affects another finding's classification; each is
// classified independently.
//
// Bypassed entirely (returns null, never WATCH/LOW_SUPPRESS/etc.):
// APPLY_SAFE_FIX findings (handled by the existing Phase 1/2 auto-apply
// loop, never a proposal) and observation-tier NO_CHANGE findings (never
// strong enough evidence to look into in the first place — risk.js's own
// weak-finding semantics, unchanged).

const { pickLatestResearch } = require("./decision");

const CLASSIFICATIONS = ["IMPORTANT", "WATCH", "LOW_SUPPRESS", "PROTECT"];

// GSC/GA4 snapshots are collected daily/weekly (agent/lib/search-
// snapshots.js) with a ~3-day Google-processing lag already baked into
// each period's own date range. A snapshot still older than this when a
// finding is classified means collection broke, not that the data is
// merely a little behind — classifying IMPORTANT off it would be acting
// on an analytics outage, not real evidence. A conservative, documented
// default (see research.js's FRESHNESS_WINDOWS_DAYS for the same style
// of constant), not a business fact.
const STALE_ANALYTICS_DAYS = 14;

function evidenceValue(finding, field) {
  const entry = (finding.evidence || []).find((e) => e.field === field);
  return entry ? entry.value : undefined;
}

function isStaleSnapshot(finding, now) {
  const collectedAt = evidenceValue(finding, "snapshotCollectedAt");
  if (!collectedAt) return false;
  const ageDays = (now.getTime() - new Date(collectedAt).getTime()) / (24 * 60 * 60 * 1000);
  return Number.isFinite(ageDays) && ageDays > STALE_ANALYTICS_DAYS;
}

// Reduces one research.js result to the for/against shape this module
// needs. Prefers the Phase 15 challenge fields when present (automatic
// first-party research, or a human/Claude file that chose to set them);
// otherwise derives a reasonable split from whatever the result DOES
// carry, so a pre-Phase-15 research file (cross-source-synthesis or
// human-authored) still participates honestly rather than contributing
// nothing.
function challengeFieldsFromResearch(latest) {
  const empty = { evidenceFor: [], evidenceAgainst: [], risks: [], protectedSignals: [], missingEvidence: [] };
  if (!latest) return empty;

  if (latest.evidenceFor || latest.evidenceAgainst || latest.risks || latest.protectedSignals || latest.missingEvidence) {
    return {
      evidenceFor: latest.evidenceFor || [],
      evidenceAgainst: latest.evidenceAgainst || [],
      risks: latest.risks || [],
      protectedSignals: latest.protectedSignals || [],
      missingEvidence: latest.missingEvidence || [],
    };
  }

  if (latest.sourceType === "cross-source-synthesis" && Array.isArray(latest.familyBreakdown)) {
    const evidenceFor = [];
    const evidenceAgainst = [];
    const missingEvidence = [];
    for (const fam of latest.familyBreakdown) {
      const line = `${fam.family}: ${fam.detail}`;
      if (fam.status === "supports") evidenceFor.push(line);
      else if (fam.status === "contradicts") evidenceAgainst.push(line);
      else missingEvidence.push(line);
    }
    return { evidenceFor, evidenceAgainst, risks: [], protectedSignals: [], missingEvidence };
  }

  const line = `${latest.source} (${latest.sourceType}, ${latest.confidence} confidence): ${latest.recommendation}`;
  if (latest.verdict === "supports-opportunity") return { ...empty, evidenceFor: [line] };
  if (latest.verdict === "contradicts-opportunity") return { ...empty, evidenceAgainst: [line] };
  return { ...empty, missingEvidence: [`inconclusive — ${line}`] };
}

function computeClassificationFingerprint(finding, classification) {
  const crypto = require("crypto");
  const latest = pickLatestResearch(Array.isArray(finding.research) ? finding.research : []);
  const basis = {
    findingKey: finding.key,
    decision: finding.decision,
    category: finding.category,
    classification,
    evidence: (finding.evidence || []).map((e) => `${e.field}=${JSON.stringify(e.value)}`).sort(),
    latestResearchVerdict: latest ? latest.verdict : null,
    latestResearchConfidence: latest ? latest.confidence : null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

// --- keyword-opportunity-* findings -------------------------------------
//
// Implements the spec's per-category Search Intelligence rules verbatim:
// CTR Opportunity (local-pack -> WATCH, never auto-propose on low CTR
// alone), Near Page 1 (prefer strengthening an existing page), Content
// Gap (A: existing relevant page underperforming -> suppress the
// new-page framing; B: unclear match -> WATCH; C: no suitable page ->
// candidate IMPORTANT), Protect/Maintain (always PROTECT, used as
// negative evidence). Reads keyword-opportunities.js's own
// category/evidenceConfidence/likelyLocalPack/landingPage.relevance/
// contentGapSeverity fields (via the finding's `.evidence` — see
// keyword-opportunity-findings.js) — never recomputes them.
function classifyKeywordOpportunity(finding, now, challenge) {
  const category = evidenceValue(finding, "category");
  const rawConfidence = String(evidenceValue(finding, "evidenceConfidence") || "LOW").toLowerCase();
  const confidence = ["low", "medium", "high"].includes(rawConfidence) ? rawConfidence : "low";
  const likelyLocalPack = Boolean(evidenceValue(finding, "likelyLocalPack"));
  const landingPage = evidenceValue(finding, "landingPage") || {};
  const contentGapSeverity = evidenceValue(finding, "contentGapSeverity");
  const reasons = evidenceValue(finding, "reasons") || [];
  const stale = isStaleSnapshot(finding, now);

  if (stale) {
    challenge.missingEvidence = [
      ...challenge.missingEvidence,
      `Analytics snapshot is more than ${STALE_ANALYTICS_DAYS} days old — too stale to support an IMPORTANT classification on its own.`,
    ];
  }

  let classification;
  let reason;

  if (category === "protect-maintain") {
    classification = "PROTECT";
    reason = "Protect/Maintain — already performing at or above the typical rate for this position; avoid unrelated rewrites unless stronger evidence overrides this.";
  } else if (category === "ctr-opportunity" && likelyLocalPack) {
    classification = "WATCH";
    reason = "Likely explained by Google's local 3-pack/map-pack absorbing clicks, not a listing defect — low CTR alone must never automatically produce a proposal.";
  } else if (category === "content-gap" && landingPage.relevance === "topic-match") {
    classification = "LOW_SUPPRESS";
    reason = "An existing relevant page already covers this topic — a content-gap/new-page proposal is not warranted; any real issue is a page-performance question, not a missing-content one.";
  } else if (confidence === "low") {
    classification = "WATCH";
    reason = "Evidence volume for this query is too low this period for a confident recommendation.";
  } else if (category === "content-gap" && landingPage.relevance === "type-only") {
    classification = "WATCH";
    reason = "Unclear whether the existing related page genuinely targets this exact query — needs more evidence before concluding either way.";
  } else if (category === "content-gap" && contentGapSeverity === "very-weak-visibility") {
    classification = "WATCH";
    reason = "Very weak ranking — a longer-shot, lower-confidence content-gap signal; monitor rather than propose yet.";
  } else if (stale) {
    classification = "WATCH";
    reason = "Would otherwise qualify, but the underlying analytics snapshot is stale — re-check once a fresher snapshot is available.";
  } else if (confidence === "medium" || confidence === "high") {
    classification = "IMPORTANT";
    reason = `${category || "search"} opportunity with ${confidence} evidence confidence — ${reasons[0] || "see evidence"}`;
  } else {
    classification = "WATCH";
    reason = "Not yet strong enough evidence to propose a change.";
  }

  return { classification, evidenceConfidence: confidence, reason };
}

// --- every other finding type -------------------------------------------
//
// Reuses decision.js's existing, unmodified decide() output as the base
// signal (risk.js's tier gate has already filtered cosmetic/weak
// findings to "observation" before this ever runs — see this module's
// header) and adds the evidence-for/against/protected split the spec
// requires on top of it.
function classifyGeneralFinding(finding, challenge) {
  const latest = pickLatestResearch(Array.isArray(finding.research) ? finding.research : []);

  if (finding.decision === "REJECT_OPPORTUNITY") {
    return {
      classification: "LOW_SUPPRESS",
      evidenceConfidence: latest ? latest.confidence : "low",
      reason: finding.reason || "Research indicates this isn't a real opportunity.",
    };
  }

  if (finding.decision === "NO_CHANGE") {
    // Note: category "E" (risk.js's unrecognized-finding-type fail-safe)
    // always carries tier "observation" too, so it's already bypassed by
    // classifyOpportunity() above before this function ever runs — there
    // is no category-E branch here because that case is unreachable, not
    // because it was overlooked.
    return {
      classification: "WATCH",
      evidenceConfidence: latest ? latest.confidence : "low",
      reason: finding.reason || "Evidence remains too weak to act on yet.",
    };
  }

  if (finding.decision === "RESEARCH_MORE") {
    return {
      classification: "WATCH",
      evidenceConfidence: "low",
      reason: "Category-C content opportunity still awaiting research.",
    };
  }

  // PROPOSE_CHANGE.
  if (latest) {
    // Came through decision.js's research branch (category C) — a
    // protected signal that outweighs the supporting evidence can still
    // downgrade this to PROTECT, even though decision.js itself already
    // said PROPOSE_CHANGE (decision.js has no concept of "protected";
    // this module adds it).
    if (challenge.protectedSignals.length > 0 && challenge.evidenceAgainst.length >= challenge.evidenceFor.length) {
      return {
        classification: "PROTECT",
        evidenceConfidence: latest.confidence,
        reason: "Protected signal(s) outweigh the evidence for changing this page/area — resist this change unless stronger evidence overrides it.",
      };
    }
    return {
      classification: "IMPORTANT",
      evidenceConfidence: latest.confidence,
      reason: finding.reason || "Internally evidenced and researched; evidence supports action.",
    };
  }

  // No research attached — category A/B/D, decided from internal
  // evidence alone. Internal evidence is always treated as HIGH
  // confidence here: it's a directly observed, mechanically-verified
  // fact (a broken link, a missing tag, a schema error against the
  // actual markup), not a sampled/inferred signal — see decision.js's
  // own category-A/B/D branches, none of which route through research.
  return {
    classification: "IMPORTANT",
    evidenceConfidence: "high",
    reason: finding.reason || "Clear, internally-evidenced technical/low-risk improvement.",
  };
}

/**
 * Classifies one finding's importance. Never throws — see this module's
 * header. Returns `null` for findings this pipeline never classifies at
 * all (APPLY_SAFE_FIX, observation-tier NO_CHANGE).
 * @param {object} finding - a fully decided finding (decision.js's decide()
 *   has already run, and — for keyword-opportunity-* types only —
 *   keyword-opportunity-findings.js's attachAutomaticResearch() has run).
 * @param {object} [context]
 * @param {Date} [context.now]
 */
function classifyOpportunity(finding, context = {}) {
  const now = context.now || new Date();
  try {
    if (finding.decision === "APPLY_SAFE_FIX") return null;
    if (finding.decision === "NO_CHANGE" && finding.tier === "observation") return null;

    const latest = pickLatestResearch(Array.isArray(finding.research) ? finding.research : []);
    const challenge = challengeFieldsFromResearch(latest);

    const isKeywordOpportunity = typeof finding.type === "string" && finding.type.startsWith("keyword-opportunity-");
    const base = isKeywordOpportunity
      ? classifyKeywordOpportunity(finding, now, challenge)
      : classifyGeneralFinding(finding, challenge);

    const result = {
      classification: base.classification,
      evidenceConfidence: base.evidenceConfidence,
      reason: base.reason,
      evidenceFor: challenge.evidenceFor,
      evidenceAgainst: challenge.evidenceAgainst,
      risks: challenge.risks,
      protectedSignals: challenge.protectedSignals,
      missingEvidence: challenge.missingEvidence,
      researchedAt: now.toISOString(),
    };
    result.fingerprint = computeClassificationFingerprint(finding, result.classification);
    return result;
  } catch (e) {
    // See this module's header — a classification failure always
    // resolves to WATCH, never IMPORTANT, and never propagates.
    return {
      classification: "WATCH",
      evidenceConfidence: "low",
      reason: `Classification failed (${e && e.message ? e.message : String(e)}) — defaulting to WATCH rather than guessing.`,
      evidenceFor: [],
      evidenceAgainst: [],
      risks: [],
      protectedSignals: [],
      missingEvidence: ["classification itself failed — see reason"],
      researchedAt: now.toISOString(),
      fingerprint: null,
    };
  }
}

/**
 * Classifies every finding in place, attaching `.opportunityClassification`
 * (or leaving it unset for bypassed findings — see classifyOpportunity()).
 */
function classifyAllOpportunities(findings, context = {}) {
  for (const finding of findings) {
    const result = classifyOpportunity(finding, context);
    if (result) finding.opportunityClassification = result;
  }
  return findings;
}

module.exports = {
  CLASSIFICATIONS,
  STALE_ANALYTICS_DAYS,
  classifyOpportunity,
  classifyAllOpportunities,
  challengeFieldsFromResearch,
  computeClassificationFingerprint,
  isStaleSnapshot,
};
