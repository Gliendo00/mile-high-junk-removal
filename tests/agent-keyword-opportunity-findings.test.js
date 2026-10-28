// Site Improvement Agent, Phase 15 — tests for agent/lib/
// keyword-opportunity-findings.js: reshapes keyword-opportunities.js's
// (Phase 2) authoritative output into ordinary Findings, and attaches
// automatic first-party research so decision.js's existing category-C
// branch can resolve them.
//
// Run with:  node tests/agent-keyword-opportunity-findings.test.js

const assert = require("assert");
const { buildKeywordOpportunityFindings, attachAutomaticResearch, CATEGORY_TO_FINDING_TYPE } = require("../agent/lib/keyword-opportunity-findings");
const { classify } = require("../agent/lib/risk");
const { decide } = require("../agent/lib/decision");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

function sampleItem(overrides = {}) {
  return {
    query: "junk removal denver",
    category: "ctr-opportunity",
    categoryLabel: "CTR Opportunity",
    alsoQualifiesFor: [],
    priority: "HIGH",
    score: 5,
    reasons: ["Commercial service-intent query — matches a core service this business offers."],
    metrics: { impressions: 120, clicks: 2, ctr: 0.0167, position: 3.4 },
    evidenceStrength: "strong",
    evidenceConfidence: "HIGH",
    landingPage: { url: "https://www.milehighjunkremoval.net/denver-junk-removal.html", file: "denver-junk-removal.html", label: "Denver city page", type: "city", relevance: "topic-match" },
    trend: { state: "available", landingPageChanged: false, positionDelta: 0.5, impressionsDelta: 10, clicksDelta: 0, ctrDelta: 0 },
    ga4: null,
    recommendedAction: "Investigate before changing anything.",
    likelyLocalPack: false,
    contentGapSeverity: null,
    contentGapSeverityLabel: null,
    intent: { branded: false, commercial: true, local: true },
    ...overrides,
  };
}

function sampleAnalysis(itemsByCategory) {
  const categories = {};
  for (const [cat, items] of Object.entries(itemsByCategory)) {
    categories[cat] = { label: cat, total: items.length, items };
  }
  return {
    available: true,
    state: "success",
    period: { start: "2026-09-28", end: "2026-10-26", property: "sc-domain:milehighjunkremoval.net", collectedAt: "2026-10-26T06:00:00Z" },
    previousPeriod: null,
    generatedAt: "2026-10-26T06:00:00Z",
    totalQueriesAnalyzed: 1,
    excludedLowEvidenceCount: 0,
    categories,
  };
}

async function main() {
  test("buildKeywordOpportunityFindings returns [] for an unavailable/null analysis (never throws)", () => {
    assert.deepStrictEqual(buildKeywordOpportunityFindings(null), []);
    assert.deepStrictEqual(buildKeywordOpportunityFindings(undefined), []);
    assert.deepStrictEqual(buildKeywordOpportunityFindings({ available: false, state: "storage_error" }), []);
  });

  test("one finding is produced per item, typed by category via CATEGORY_TO_FINDING_TYPE, never recomputing keyword-opportunities.js's own score/priority", () => {
    const analysis = sampleAnalysis({ "ctr-opportunity": [sampleItem({ score: 42, priority: "HIGH" })] });
    const findings = buildKeywordOpportunityFindings(analysis);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].type, CATEGORY_TO_FINDING_TYPE["ctr-opportunity"]);
    const scoreEntry = findings[0].evidence.find((e) => e.field === "score");
    const priorityEntry = findings[0].evidence.find((e) => e.field === "priority");
    assert.strictEqual(scoreEntry.value, 42);
    assert.strictEqual(priorityEntry.value, "HIGH");
  });

  test("pages uses the item's own already-canonical landingPage.file, no second normalization pass", () => {
    const analysis = sampleAnalysis({ "near-page-1": [sampleItem({ category: "near-page-1", landingPage: { url: "https://x/aurora-junk-removal.html", file: "aurora-junk-removal.html", label: "Aurora page", type: "city", relevance: "topic-match" } })] });
    const findings = buildKeywordOpportunityFindings(analysis);
    assert.deepStrictEqual(findings[0].pages, ["aurora-junk-removal.html"]);
  });

  test("recommendation reuses keyword-opportunities.js's own recommendedAction verbatim", () => {
    const analysis = sampleAnalysis({ "priority-now": [sampleItem({ category: "priority-now", recommendedAction: "Review the title and meta description." })] });
    const findings = buildKeywordOpportunityFindings(analysis);
    assert.strictEqual(findings[0].recommendation, "Review the title and meta description.");
  });

  test("the snapshot's collectedAt is copied onto every finding's evidence for the freshness guard", () => {
    const analysis = sampleAnalysis({ "ctr-opportunity": [sampleItem()] });
    const findings = buildKeywordOpportunityFindings(analysis);
    const entry = findings[0].evidence.find((e) => e.field === "snapshotCollectedAt");
    assert.strictEqual(entry.value, "2026-10-26T06:00:00Z");
  });

  test("findings are produced for all five categories when present, and NOT for excluded-low-evidence (which keyword-opportunities.js already drops before this module ever sees it)", () => {
    const analysis = sampleAnalysis({
      "priority-now": [sampleItem({ category: "priority-now" })],
      "near-page-1": [sampleItem({ category: "near-page-1" })],
      "ctr-opportunity": [sampleItem({ category: "ctr-opportunity" })],
      "content-gap": [sampleItem({ category: "content-gap" })],
      "protect-maintain": [sampleItem({ category: "protect-maintain" })],
    });
    const findings = buildKeywordOpportunityFindings(analysis);
    assert.strictEqual(findings.length, 5);
    const types = findings.map((f) => f.type).sort();
    assert.deepStrictEqual(types, Object.values(CATEGORY_TO_FINDING_TYPE).sort());
  });

  // --- attachAutomaticResearch ---------------------------------------------

  function decidedKeywordFinding(type, itemOverrides) {
    const analysis = sampleAnalysis({ [type.replace("keyword-opportunity-", "")]: [sampleItem(itemOverrides)] });
    const findings = buildKeywordOpportunityFindings(analysis);
    const f = classify(findings[0]);
    f.research = [];
    return f;
  }

  test("attachAutomaticResearch only touches keyword-opportunity-* findings, never any other finding type", () => {
    const kwFinding = decidedKeywordFinding("keyword-opportunity-ctr-opportunity");
    const otherFinding = { type: "missing-title", key: "missing-title::a.html", research: [] };
    attachAutomaticResearch([kwFinding, otherFinding]);
    assert.strictEqual(kwFinding.research.length, 1);
    assert.deepStrictEqual(otherFinding.research, []);
  });

  test("attachAutomaticResearch never overwrites research that's already attached (appends only when empty)", () => {
    const kwFinding = decidedKeywordFinding("keyword-opportunity-ctr-opportunity");
    kwFinding.research = [{ sourceType: "internal-repo-review", existing: true }];
    attachAutomaticResearch([kwFinding]);
    assert.strictEqual(kwFinding.research.length, 1);
    assert.strictEqual(kwFinding.research[0].existing, true);
  });

  test("the automatic research result lets decision.js resolve a ctr-opportunity finding to PROPOSE_CHANGE (not stuck at RESEARCH_MORE forever)", () => {
    const f = decidedKeywordFinding("keyword-opportunity-ctr-opportunity", { likelyLocalPack: false, evidenceConfidence: "HIGH" });
    attachAutomaticResearch([f]);
    assert.strictEqual(f.research.length, 1);
    assert.strictEqual(f.research[0].sourceType, "automatic-first-party-evidence");
    const decision = decide(f);
    assert.strictEqual(decision.decision, "PROPOSE_CHANGE");
  });

  test("a likely-local-pack ctr-opportunity resolves to REJECT_OPPORTUNITY via decision.js (contradicts-opportunity verdict), never PROPOSE_CHANGE on low CTR alone", () => {
    const f = decidedKeywordFinding("keyword-opportunity-ctr-opportunity", { likelyLocalPack: true, evidenceConfidence: "HIGH" });
    attachAutomaticResearch([f]);
    const decision = decide(f);
    assert.strictEqual(decision.decision, "REJECT_OPPORTUNITY");
  });

  test("a protect-maintain finding's automatic research always contradicts (never proposes)", () => {
    const f = decidedKeywordFinding("keyword-opportunity-protect-maintain", { category: "protect-maintain", evidenceConfidence: "HIGH" });
    attachAutomaticResearch([f]);
    assert.strictEqual(f.research[0].verdict, "contradicts-opportunity");
    assert.ok(Array.isArray(f.research[0].protectedSignals) && f.research[0].protectedSignals.length > 0);
  });

  test("a failing/malformed finding never crashes attachAutomaticResearch — it's left with empty research rather than throwing", () => {
    const broken = { type: "keyword-opportunity-ctr-opportunity", key: "x", evidence: null, research: [] };
    assert.doesNotThrow(() => attachAutomaticResearch([broken]));
    assert.deepStrictEqual(broken.research, []);
  });

  console.log("agent-keyword-opportunity-findings.test.js: all tests completed");
}

main();
