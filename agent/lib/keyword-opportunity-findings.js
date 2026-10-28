// Site Improvement Agent, Phase 15 — turns the Phase 2 Keyword
// Opportunity Engine's output (agent/lib/keyword-opportunities.js) into
// ordinary Findings, so Search Console/GA4-driven search opportunities
// flow through the SAME discovery -> research -> classify -> propose ->
// handoff pipeline every other finding type already uses, instead of
// staying a dashboard-only read (see keyword-opportunities.js's own
// header: "EVIDENCE, NOT EXECUTION... never creates a Finding").
//
// keyword-opportunities.js's analyzeKeywordOpportunities() is AUTHORITATIVE
// and NEVER RECOMPUTED here — every score/priority/evidenceConfidence/
// intent/likelyLocalPack/contentGapSeverity/trend/recommendedAction this
// module emits is read verbatim from that engine's own output. This file
// only RESHAPES that output into findings.js's shared Finding schema; it
// contains no scoring logic of its own.
//
// One finding per classified query per category (keyword-opportunities.js
// already groups queries into exactly one of five categories —
// "excluded-low-evidence" queries are already dropped by that engine and
// never reach here at all). `pages` uses the item's own
// `landingPage.file` — already a repo-relative, query-string/hash/
// trailing-slash-stripped file name (keyword-opportunities.js's
// urlToFile()), the same canonicalization convention
// agent/lib/page-identity.js's normalizePageIdentifierForComparison()
// uses — no second normalization pass needed here.

const { makeFinding } = require("./findings");
const { makeResearchResult } = require("./research");

const CATEGORY_TO_FINDING_TYPE = {
  "priority-now": "keyword-opportunity-priority-now",
  "near-page-1": "keyword-opportunity-near-page-1",
  "ctr-opportunity": "keyword-opportunity-ctr-opportunity",
  "content-gap": "keyword-opportunity-content-gap",
  "protect-maintain": "keyword-opportunity-protect-maintain",
};

// Evidence entries are a bounded, inspectable restatement of exactly the
// fields keyword-opportunities.js already computed for this query — never
// a second scoring pass. `reasons`/`recommendedAction` carry the engine's
// own explanation text (its "EXPLAINABLE SCORING" guarantee — see that
// file's header), reused verbatim rather than re-derived.
function buildEvidence(item) {
  const evidence = [
    { field: "query", value: item.query },
    { field: "category", value: item.category },
    { field: "priority", value: item.priority },
    { field: "score", value: item.score },
    { field: "evidenceConfidence", value: item.evidenceConfidence },
    { field: "evidenceStrength", value: item.evidenceStrength },
    { field: "metrics", value: item.metrics },
    { field: "intent", value: item.intent },
    { field: "landingPage", value: { file: item.landingPage.file, label: item.landingPage.label, type: item.landingPage.type, relevance: item.landingPage.relevance } },
    { field: "reasons", value: item.reasons },
    { field: "likelyLocalPack", value: item.likelyLocalPack },
  ];
  if (item.contentGapSeverity) {
    evidence.push({ field: "contentGapSeverity", value: item.contentGapSeverity });
  }
  if (item.trend) {
    evidence.push({ field: "trend", value: item.trend });
  }
  if (item.ga4) {
    evidence.push({ field: "ga4", value: item.ga4 });
  }
  if (item.collectedAt) {
    // Phase 15 — the GSC/GA4 snapshot's own collection timestamp (from
    // analyzeKeywordOpportunities()'s `period.collectedAt`), copied onto
    // every finding it produced so opportunity-classification.js can
    // tell "this specific finding's evidence is fresh" apart from
    // "stale" without any extra plumbing — see that module's freshness
    // guard.
    evidence.push({ field: "snapshotCollectedAt", value: item.collectedAt });
  }
  return evidence;
}

function summaryFor(item) {
  return `Search query "${item.query}" (${item.categoryLabel}, ${item.priority} priority) — ${item.landingPage.label}, position ${item.metrics.position.toFixed(1)}, ${item.metrics.impressions} impression(s) this period.`;
}

/**
 * @param {object} analysis - keyword-opportunities.js's analyzeKeywordOpportunities()
 *   (or analyzeSnapshot()) return shape: { available, categories: { <category>: { items } } }.
 * @returns {object[]} findings, built via findings.js's makeFinding() — same
 *   shape/validation as every audit module's output.
 */
function buildKeywordOpportunityFindings(analysis) {
  if (!analysis || analysis.available === false || !analysis.categories) return [];

  const collectedAt = analysis.period && analysis.period.collectedAt;
  const findings = [];
  for (const [category, type] of Object.entries(CATEGORY_TO_FINDING_TYPE)) {
    const group = analysis.categories[category];
    if (!group || !Array.isArray(group.items)) continue;
    for (const item of group.items) {
      findings.push(
        makeFinding({
          type,
          summary: summaryFor(item),
          pages: [item.landingPage.file],
          evidence: buildEvidence({ ...item, collectedAt }),
          recommendation: item.recommendedAction,
        })
      );
    }
  }
  return findings;
}

// --- automatic research (Phase 15) -------------------------------------
//
// keyword-opportunity-* findings are category C (risk.js) — decision.js's
// existing needsExternalResearch() branch requires a research.js-shaped
// result before it can resolve to anything but RESEARCH_MORE. Unlike the
// five original category-C types (content-gap, structural-inconsistency,
// coverage-gap-candidate, duplicate-meta-description, overlapping-intent),
// which already get this from either a human/Claude-authored file or the
// separate, offline `--run-synthesis` step (agent/lib/run-synthesis.js —
// NOT duplicated here, on purpose, to avoid two mechanisms competing to
// write research for the same finding), nothing else ever produces
// research for a keyword-opportunity finding. This function is that
// source — deterministic, first-party-only (GSC/GA4/keyword-
// opportunities.js's own scoring already attached to the finding's own
// `.evidence` — see buildEvidence() above), never a network call. It
// explicitly does NOT touch any other finding type.
//
// Per the spec's "local/external research" decision: this NEVER calls a
// live SERP/map-pack API. Where that kind of verification would
// materially change the read (e.g. a likely-local-pack CTR gap), it is
// recorded as `missingEvidence` — an open question for Claude to resolve
// independently when the proposal's handoff report reaches it — never
// guessed at here.

const { CONFIDENCE_LEVELS } = require("./research");

function evidenceValue(finding, field) {
  const entry = (finding.evidence || []).find((e) => e.field === field);
  return entry ? entry.value : undefined;
}

function buildAutomaticResearchResult(finding) {
  const query = evidenceValue(finding, "query");
  const category = evidenceValue(finding, "category");
  const rawConfidence = String(evidenceValue(finding, "evidenceConfidence") || "LOW").toLowerCase();
  const confidence = CONFIDENCE_LEVELS.includes(rawConfidence) ? rawConfidence : "low";
  const likelyLocalPack = Boolean(evidenceValue(finding, "likelyLocalPack"));
  const landingPage = evidenceValue(finding, "landingPage") || {};
  const intent = evidenceValue(finding, "intent") || {};
  const reasons = (evidenceValue(finding, "reasons") || []).filter((r) => typeof r === "string" && r.trim());
  const contentGapSeverity = evidenceValue(finding, "contentGapSeverity");
  const trend = evidenceValue(finding, "trend");
  const ga4 = evidenceValue(finding, "ga4");

  const evidenceFor = [];
  const evidenceAgainst = [];
  const risks = [];
  const protectedSignals = [];
  const missingEvidence = [];
  let verdict = "inconclusive";

  if (trend && trend.state === "available" && !trend.landingPageChanged) {
    if (trend.positionDelta > 0) evidenceFor.push(`GSC trend: position improved ${trend.positionDelta.toFixed(1)} spot(s) vs. the prior period.`);
    else if (trend.positionDelta < 0) evidenceAgainst.push(`GSC trend: position declined ${Math.abs(trend.positionDelta).toFixed(1)} spot(s) vs. the prior period.`);
  } else {
    missingEvidence.push("No reliable period-over-period GSC trend available (insufficient data, no prior-period snapshot, or the ranking landing page changed between periods).");
  }

  if (ga4) {
    if (ga4.engagementRate >= 0.6) evidenceFor.push(`GA4: this landing page already engages organic visitors well (${Math.round(ga4.engagementRate * 100)}% engagement).`);
    else if (ga4.organicSessions > 0 && ga4.engagementRate <= 0.3) evidenceAgainst.push(`GA4: this landing page gets organic traffic but has weak engagement (${Math.round(ga4.engagementRate * 100)}%).`);
  } else {
    missingEvidence.push("No GA4 landing-page data available for this period.");
  }

  const intentLabel = intent.commercial ? "commercial" : intent.local ? "local" : "generic";

  switch (category) {
    case "ctr-opportunity":
      if (likelyLocalPack) {
        evidenceAgainst.push("Zero clicks at a top-3 local-intent ranking position is the classic signature of Google's local 3-pack/map-pack absorbing clicks — not necessarily a listing (title/meta) defect.");
        protectedSignals.push("Possible local-pack effect — an on-page listing rewrite would not fix a map-pack-absorbed click.");
        missingEvidence.push("Live SERP composition for this exact query has not been checked — would confirm whether a local pack is actually present.");
        verdict = "contradicts-opportunity";
      } else if (confidence === "low") {
        missingEvidence.push("Too few impressions this period for a confident CTR-gap read.");
        verdict = "inconclusive";
      } else {
        evidenceFor.push(`CTR is well below the typical rate for this ranking position on a ${intentLabel}-intent query.`);
        missingEvidence.push("Live SERP composition/snippet rendering for this exact query has not been checked.");
        verdict = "supports-opportunity";
      }
      break;
    case "priority-now":
      if (confidence === "low") {
        missingEvidence.push("Too few impressions this period for a confident read.");
        verdict = "inconclusive";
      } else {
        evidenceFor.push(`Already visible on page one for a ${intentLabel}-intent query with CTR headroom.`);
        verdict = "supports-opportunity";
      }
      break;
    case "near-page-1":
      if (landingPage.relevance === "topic-match") {
        evidenceFor.push(`${landingPage.label} is already topically matched to this query — strengthening it is lower-risk than creating a new page.`);
      } else if (landingPage.relevance === "type-only") {
        missingEvidence.push(`${landingPage.label} is a plausible page type, but exact topical match to this query's phrasing is unconfirmed.`);
      } else {
        missingEvidence.push("No clearly relevant existing page identified for this query.");
      }
      verdict = confidence === "low" ? "inconclusive" : "supports-opportunity";
      break;
    case "content-gap":
      if (landingPage.relevance === "topic-match") {
        evidenceAgainst.push(`An existing relevant page (${landingPage.label}) already covers this topic — the real gap, if any, is in that page's performance, not missing content.`);
        verdict = "contradicts-opportunity";
      } else if (landingPage.relevance === "type-only") {
        missingEvidence.push(`A page of a plausibly related type (${landingPage.label}) exists, but whether it genuinely targets this exact query is unconfirmed.`);
        verdict = "inconclusive";
      } else if (confidence === "low" || contentGapSeverity === "very-weak-visibility") {
        missingEvidence.push("Low evidence volume and/or very weak ranking — a longer-shot, lower-confidence content-gap signal.");
        verdict = "inconclusive";
      } else {
        evidenceFor.push("No suitable existing page covers this query, and ranking/evidence volume are strong enough to be worth a real look.");
        verdict = "supports-opportunity";
      }
      break;
    case "protect-maintain":
    default:
      evidenceAgainst.push("Already performing at or above the typical rate for this position/query.");
      protectedSignals.push(`${query ? `"${query}"` : "This query"} is a protected/well-performing signal for ${landingPage.label || "its landing page"} — avoid unrelated rewrites unless stronger evidence overrides this.`);
      verdict = "contradicts-opportunity";
      break;
  }

  return makeResearchResult({
    findingKey: finding.key,
    question: `Does keyword-opportunity finding "${finding.key}" (${category || "uncategorized"}) warrant a proposal?`,
    source: "agent/lib/keyword-opportunities.js (Phase 2 Keyword Opportunity Engine) — automatic first-party read",
    sourceType: "automatic-first-party-evidence",
    evidence: reasons.length ? reasons : [finding.summary],
    confidence,
    limitations: "Automatic first-party read only (GSC/GA4 snapshots + keyword-opportunities.js's own scoring) — no live SERP/local-pack verification was performed; see missingEvidence for what a human/Claude follow-up should check.",
    verdict,
    recommendation: finding.recommendation || "See finding evidence.",
    evidenceFor: evidenceFor.length ? evidenceFor : undefined,
    evidenceAgainst: evidenceAgainst.length ? evidenceAgainst : undefined,
    risks: risks.length ? risks : undefined,
    protectedSignals: protectedSignals.length ? protectedSignals : undefined,
    missingEvidence: missingEvidence.length ? missingEvidence : undefined,
  });
}

/**
 * Appends (never replaces — research-intake.js's attachResearch() already
 * ran and set `.research` to whatever file-based results matched, see
 * runner.js's gatherFindings()) an automatic research result to every
 * keyword-opportunity-* finding that doesn't already have one. Fails
 * safe per finding: a single malformed finding's research can never take
 * down the whole run (see decideAll()'s own category-C fallback —
 * worst case, that one finding simply stays RESEARCH_MORE rather than
 * resolving further).
 */
function attachAutomaticResearch(findings) {
  for (const finding of findings) {
    if (typeof finding.type !== "string" || !finding.type.startsWith("keyword-opportunity-")) continue;
    const existing = Array.isArray(finding.research) ? finding.research : [];
    if (existing.length > 0) continue;
    try {
      finding.research = [...existing, buildAutomaticResearchResult(finding)];
    } catch (e) {
      finding.research = existing;
    }
  }
  return findings;
}

module.exports = { buildKeywordOpportunityFindings, attachAutomaticResearch, CATEGORY_TO_FINDING_TYPE };
