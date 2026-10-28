// Site Improvement Agent, Phase 15 — tests for agent/lib/
// opportunity-classification.js: the importance-classification layer
// (IMPORTANT/WATCH/LOW_SUPPRESS/PROTECT) that sits on top of decision.js
// without modifying it.
//
// Run with:  node tests/agent-opportunity-classification.test.js

const assert = require("assert");
const {
  classifyOpportunity,
  classifyAllOpportunities,
  challengeFieldsFromResearch,
  computeClassificationFingerprint,
  isStaleSnapshot,
  STALE_ANALYTICS_DAYS,
} = require("../agent/lib/opportunity-classification");
const { makeFinding } = require("../agent/lib/findings");
const { classify } = require("../agent/lib/risk");
const { decide } = require("../agent/lib/decision");
const { makeResearchResult } = require("../agent/lib/research");
const { attachAutomaticResearch } = require("../agent/lib/keyword-opportunity-findings");

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

function decidedFinding(args, researchResults) {
  const f = classify(makeFinding(args));
  f.research = researchResults || [];
  Object.assign(f, decide(f));
  return f;
}

function keywordOppFinding(type, evidenceOverrides, pages) {
  const base = {
    query: "junk removal denver",
    category: type.replace("keyword-opportunity-", ""),
    priority: "HIGH",
    score: 7,
    evidenceConfidence: "HIGH",
    evidenceStrength: "strong",
    metrics: { impressions: 200, clicks: 3, ctr: 0.015, position: 4.2 },
    intent: { branded: false, commercial: true, local: true },
    landingPage: { file: pages ? pages[0] : "denver-junk-removal.html", label: "Denver city page", type: "city", relevance: "topic-match" },
    reasons: ["Commercial service-intent query."],
    likelyLocalPack: false,
  };
  const evidence = { ...base, ...(evidenceOverrides || {}) };
  const finding = classify(
    makeFinding({
      type,
      summary: "test keyword opportunity",
      pages: pages || ["denver-junk-removal.html"],
      evidence: Object.entries(evidence).map(([field, value]) => ({ field, value })),
      recommendation: "Strengthen the existing Denver page.",
    })
  );
  finding.research = [];
  return finding;
}

async function main() {
  // --- bypass behavior ---------------------------------------------------

  test("APPLY_SAFE_FIX findings are bypassed entirely (classifyOpportunity returns null)", () => {
    const f = decidedFinding({ type: "redirect-hop-internal-link", summary: "x", pages: ["a.html"], evidence: [{ x: 1 }], autoFix: { kind: "rewrite-href", file: "a.html", from: "/x", to: "/y" } });
    assert.strictEqual(f.decision, "APPLY_SAFE_FIX");
    assert.strictEqual(classifyOpportunity(f), null);
  });

  test("observation-tier NO_CHANGE findings are bypassed entirely (never strong enough to look into)", () => {
    const f = decidedFinding({ type: "title-length", summary: "71 chars", pages: ["a.html"], evidence: [{ x: 1 }] });
    assert.strictEqual(f.decision, "NO_CHANGE");
    assert.strictEqual(f.tier, "observation");
    assert.strictEqual(classifyOpportunity(f), null);
  });

  // --- general (non-keyword-opportunity) findings -------------------------

  test("technical verified issue can become IMPORTANT without GSC — no research attached, category A, PROPOSE_CHANGE", () => {
    const f = decidedFinding({ type: "missing-canonical", summary: "no canonical", pages: ["a.html"], evidence: [{ field: "x", value: 1 }] });
    assert.strictEqual(f.decision, "PROPOSE_CHANGE");
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "IMPORTANT");
    assert.strictEqual(result.evidenceConfidence, "high");
  });

  test("REJECT_OPPORTUNITY findings classify LOW_SUPPRESS", () => {
    const research = [
      makeResearchResult({
        findingKey: "content-gap::blog.html",
        question: "q",
        source: "src",
        sourceType: "official-government",
        evidence: ["e"],
        confidence: "high",
        limitations: "l",
        verdict: "contradicts-opportunity",
        recommendation: "not a real opportunity",
      }),
    ];
    const f = decidedFinding({ type: "content-gap", summary: "gap", pages: ["blog.html"], evidence: [{ field: "x", value: 1 }] }, research);
    assert.strictEqual(f.decision, "REJECT_OPPORTUNITY");
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "LOW_SUPPRESS");
  });

  test("RESEARCH_MORE findings classify WATCH, not a proposal", () => {
    const f = decidedFinding({ type: "content-gap", summary: "gap", pages: ["blog.html"], evidence: [{ field: "x", value: 1 }] });
    assert.strictEqual(f.decision, "RESEARCH_MORE");
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "WATCH");
  });

  test("category E (unrecognized type) is bypassed — risk.js's fail-safe always pairs it with tier 'observation', never classified at all", () => {
    const f = decidedFinding({ type: "totally-unknown-type", summary: "x", pages: ["a.html"], evidence: [{ x: 1 }] });
    assert.strictEqual(f.category, "E");
    assert.strictEqual(f.tier, "observation");
    assert.strictEqual(classifyOpportunity(f), null);
  });

  test("cosmetic finding on a protected page becomes PROTECT when protected signals outweigh supporting evidence", () => {
    const research = [
      makeResearchResult({
        findingKey: "structural-inconsistency::pricing.html",
        question: "q",
        source: "cross-source-synthesis",
        sourceType: "cross-source-synthesis",
        evidence: ["gsc: supports — strong existing traffic"],
        confidence: "medium",
        limitations: "l",
        verdict: "supports-opportunity",
        recommendation: "r",
        sufficiency: "partially-corroborated",
        familyBreakdown: [{ family: "gsc", status: "supports", detail: "strong existing traffic" }],
        evidenceFor: ["minor structural difference noted"],
        evidenceAgainst: ["this page already converts well and ranks strongly — a rewrite risks disruption"],
        protectedSignals: ["pricing.html is a strong, stable performer for its primary query"],
      }),
    ];
    const f = decidedFinding({ type: "structural-inconsistency", summary: "diff", pages: ["pricing.html"], evidence: [{ field: "x", value: 1 }] }, research);
    assert.strictEqual(f.decision, "PROPOSE_CHANGE");
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "PROTECT");
    assert.ok(result.protectedSignals.length > 0);
  });

  test("evidence collects both FOR and AGAINST from a cross-source-synthesis familyBreakdown when the new challenge fields are absent (legacy-shaped research)", () => {
    const research = [
      makeResearchResult({
        findingKey: "content-gap::blog.html",
        question: "q",
        source: "cross-source-synthesis",
        sourceType: "cross-source-synthesis",
        evidence: ["gsc: supports", "completedJobs: contradicts"],
        confidence: "medium",
        limitations: "l",
        verdict: "supports-opportunity",
        recommendation: "r",
        sufficiency: "partially-corroborated",
        familyBreakdown: [
          { family: "gsc", status: "supports", detail: "real demand" },
          { family: "completedJobs", status: "contradicts", detail: "no operational signal" },
          { family: "ga4", status: "unavailable", detail: "never gathered" },
        ],
      }),
    ];
    const f = decidedFinding({ type: "content-gap", summary: "gap", pages: ["blog.html"], evidence: [{ field: "x", value: 1 }] }, research);
    const challenge = challengeFieldsFromResearch(research[0]);
    assert.deepStrictEqual(challenge.evidenceFor, ["gsc: real demand"]);
    assert.deepStrictEqual(challenge.evidenceAgainst, ["completedJobs: no operational signal"]);
    assert.strictEqual(challenge.missingEvidence.length, 1);
    const result = classifyOpportunity(f);
    assert.ok(result.evidenceFor.length > 0);
    assert.ok(result.evidenceAgainst.length > 0);
  });

  test("failed classification (a malformed finding) defaults to WATCH, never IMPORTANT, and never throws", () => {
    // `.pages` undefined makes `(finding.pages || []).join` fine, but a
    // deliberately broken `.research` (not an array, not null/undefined)
    // exercises classifyGeneralFinding's own pickLatestResearch() call —
    // this must still resolve to WATCH, never crash the caller.
    const broken = { decision: "PROPOSE_CHANGE", category: "A", tier: "actionable", key: "broken::x.html", type: "missing-title", get research() { throw new Error("boom"); } };
    const result = classifyOpportunity(broken);
    assert.strictEqual(result.classification, "WATCH");
    assert.ok(/failed/i.test(result.reason));
  });

  test("one finding's classification failure never affects another finding's classification (independent per finding)", () => {
    const broken = { decision: "PROPOSE_CHANGE", category: "A", tier: "actionable", key: "broken::x.html", type: "missing-title", get research() { throw new Error("boom"); } };
    const healthy = decidedFinding({ type: "missing-h1", summary: "no h1", pages: ["b.html"], evidence: [{ field: "x", value: 1 }] });
    const findings = [broken, healthy];
    classifyAllOpportunities(findings);
    assert.strictEqual(broken.opportunityClassification.classification, "WATCH");
    assert.strictEqual(healthy.opportunityClassification.classification, "IMPORTANT");
  });

  // --- keyword-opportunity-* findings --------------------------------------

  test("keyword-opportunity ctr-opportunity with HIGH confidence, not local-pack -> IMPORTANT", () => {
    const f = keywordOppFinding("keyword-opportunity-ctr-opportunity", { likelyLocalPack: false, evidenceConfidence: "HIGH" });
    f.category = "C";
    f.tier = "opportunity";
    f.decision = "PROPOSE_CHANGE";
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "IMPORTANT");
  });

  test("keyword-opportunity ctr-opportunity explained by a likely local pack -> WATCH, never an automatic proposal on low CTR alone", () => {
    const f = keywordOppFinding("keyword-opportunity-ctr-opportunity", { likelyLocalPack: true, evidenceConfidence: "HIGH" });
    f.decision = "PROPOSE_CHANGE";
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "WATCH");
    assert.ok(/local 3-pack|map-pack/i.test(result.reason));
  });

  test("LOW evidence confidence always classifies WATCH, regardless of category (tiny noisy sample must never propose)", () => {
    const f = keywordOppFinding("keyword-opportunity-priority-now", { evidenceConfidence: "LOW" });
    f.decision = "PROPOSE_CHANGE";
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "WATCH");
  });

  test("content-gap with an existing topically-matched page -> LOW_SUPPRESS (avoids a new-page proposal)", () => {
    const f = keywordOppFinding("keyword-opportunity-content-gap", {
      evidenceConfidence: "HIGH",
      landingPage: { file: "denver-junk-removal.html", label: "Denver page", type: "city", relevance: "topic-match" },
    });
    f.decision = "PROPOSE_CHANGE";
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "LOW_SUPPRESS");
  });

  test("content-gap with only a type-only-related page -> WATCH (unclear match, needs more evidence)", () => {
    const f = keywordOppFinding("keyword-opportunity-content-gap", {
      evidenceConfidence: "HIGH",
      landingPage: { file: "aurora-junk-removal.html", label: "Aurora page", type: "city", relevance: "type-only" },
    });
    f.decision = "PROPOSE_CHANGE";
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "WATCH");
  });

  test("content-gap with NO suitable existing page and strong evidence -> IMPORTANT (only this case seriously considers a new page)", () => {
    const f = keywordOppFinding("keyword-opportunity-content-gap", {
      evidenceConfidence: "HIGH",
      contentGapSeverity: "near-miss",
      landingPage: { file: "blog-post.html", label: "blog-post.html", type: "blog", relevance: "none" },
    });
    f.decision = "PROPOSE_CHANGE";
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "IMPORTANT");
  });

  test("content-gap with very-weak-visibility severity -> WATCH (longer-shot, lower-confidence signal)", () => {
    const f = keywordOppFinding("keyword-opportunity-content-gap", {
      evidenceConfidence: "HIGH",
      contentGapSeverity: "very-weak-visibility",
      landingPage: { file: "blog-post.html", label: "blog-post.html", type: "blog", relevance: "none" },
    });
    f.decision = "PROPOSE_CHANGE";
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "WATCH");
  });

  test("protect-maintain always classifies PROTECT — used as negative evidence, never a proposal", () => {
    const f = keywordOppFinding("keyword-opportunity-protect-maintain", { evidenceConfidence: "HIGH" });
    f.decision = "PROPOSE_CHANGE";
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "PROTECT");
  });

  test("GA4 enrichment contributes evidence but never controls importance by itself — strong GA4 engagement with LOW GSC confidence still classifies WATCH", () => {
    const f = keywordOppFinding("keyword-opportunity-priority-now", {
      evidenceConfidence: "LOW",
      ga4: { organicSessions: 500, organicUsers: 400, engagedSessions: 450, engagementRate: 0.9, keyEvents: 20, note: "engages well" },
    });
    attachAutomaticResearch([f]); // same pipeline step runner.js runs before decideAll()/classification
    f.decision = "PROPOSE_CHANGE";
    const result = classifyOpportunity(f);
    assert.strictEqual(result.classification, "WATCH", "LOW GSC confidence must still gate importance even with strong GA4 engagement");
    assert.ok(result.evidenceFor.some((l) => /GA4/.test(l)), "GA4's engagement signal should still be recorded as evidence");
  });

  // --- freshness guard -----------------------------------------------------

  test("isStaleSnapshot: a snapshot older than STALE_ANALYTICS_DAYS is stale; a fresh one is not", () => {
    const now = new Date("2026-10-26T00:00:00Z");
    const staleFinding = { evidence: [{ field: "snapshotCollectedAt", value: "2026-09-01T00:00:00Z" }] };
    const freshFinding = { evidence: [{ field: "snapshotCollectedAt", value: "2026-10-25T00:00:00Z" }] };
    const noneFinding = { evidence: [] };
    assert.strictEqual(isStaleSnapshot(staleFinding, now), true);
    assert.strictEqual(isStaleSnapshot(freshFinding, now), false);
    assert.strictEqual(isStaleSnapshot(noneFinding, now), false);
    assert.ok(STALE_ANALYTICS_DAYS > 0);
  });

  test("stale analytics prevents an otherwise-IMPORTANT keyword-opportunity finding from classifying IMPORTANT", () => {
    const now = new Date("2026-10-26T00:00:00Z");
    const staleDate = new Date(now.getTime() - (STALE_ANALYTICS_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    const f = keywordOppFinding("keyword-opportunity-content-gap", {
      evidenceConfidence: "HIGH",
      landingPage: { file: "blog-post.html", label: "blog-post.html", type: "blog", relevance: "none" },
      snapshotCollectedAt: staleDate,
    });
    f.decision = "PROPOSE_CHANGE";
    const result = classifyOpportunity(f, { now });
    assert.strictEqual(result.classification, "WATCH");
    assert.ok(result.missingEvidence.some((m) => /stale/i.test(m)));
  });

  // --- local/external research framed as an open question, not a live call

  test("a likely-local-pack CTR opportunity surfaces an explicit local/external open question, never a live SERP check", () => {
    const f = keywordOppFinding("keyword-opportunity-ctr-opportunity", { likelyLocalPack: true, evidenceConfidence: "HIGH" });
    attachAutomaticResearch([f]);
    f.decision = "PROPOSE_CHANGE";
    const result = classifyOpportunity(f);
    assert.ok(result.missingEvidence.some((m) => /SERP|local pack/i.test(m)), "expected an explicit open question about live SERP composition");
  });

  // --- fingerprint / dedup --------------------------------------------------

  test("fingerprint is deterministic for identical inputs, and changes when evidence materially changes", () => {
    const a = decidedFinding({ type: "missing-h1", summary: "no h1", pages: ["a.html"], evidence: [{ field: "x", value: 1 }] });
    const b = decidedFinding({ type: "missing-h1", summary: "no h1", pages: ["a.html"], evidence: [{ field: "x", value: 1 }] });
    const fpA = computeClassificationFingerprint(a, "IMPORTANT");
    const fpB = computeClassificationFingerprint(b, "IMPORTANT");
    assert.strictEqual(fpA, fpB);

    const c = decidedFinding({ type: "missing-h1", summary: "no h1", pages: ["a.html"], evidence: [{ field: "x", value: 2 }] });
    const fpC = computeClassificationFingerprint(c, "IMPORTANT");
    assert.notStrictEqual(fpA, fpC, "a materially different evidence value must change the fingerprint");
  });

  console.log("agent-opportunity-classification.test.js: all tests completed");
}

main();
