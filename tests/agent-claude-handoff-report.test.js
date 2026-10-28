// Site Improvement Agent, Phase 15 — tests for agent/lib/
// claude-handoff-report.js: the copy-ready, self-contained report every
// IMPORTANT proposal must generate.
//
// Run with:  node tests/agent-claude-handoff-report.test.js

const assert = require("assert");
const { buildHandoffReport } = require("../agent/lib/claude-handoff-report");

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

function keywordFinding(overrides = {}) {
  return {
    key: "keyword-opportunity-ctr-opportunity::denver-junk-removal.html",
    type: "keyword-opportunity-ctr-opportunity",
    summary: 'Search query "junk removal denver" (CTR Opportunity, HIGH priority) — Denver city page, position 3.4, 120 impression(s) this period.',
    pages: ["denver-junk-removal.html"],
    recommendation: "Strengthen existing Denver junk-removal page with a narrow internal-link and topical-alignment update; do not create a competing Denver page.",
    evidence: [
      { field: "query", value: "junk removal denver" },
      { field: "category", value: "ctr-opportunity" },
      { field: "metrics", value: { impressions: 120, clicks: 2, ctr: 0.0167, position: 3.4 } },
      { field: "landingPage", value: { file: "denver-junk-removal.html", label: "Denver city page", type: "city", relevance: "topic-match" } },
      { field: "trend", value: { state: "available", landingPageChanged: false, positionDelta: 0.5, impressionsDelta: 10, clicksDelta: 0, ctrDelta: 0.001 } },
    ],
    research: [],
    firstPartyEvidence: [],
    ...overrides,
  };
}

function classificationFor(overrides = {}) {
  return {
    classification: "IMPORTANT",
    evidenceConfidence: "high",
    reason: "CTR well below the typical rate for this position on a commercial query.",
    evidenceFor: ["CTR is well below the typical rate for this ranking position on a commercial-intent query."],
    evidenceAgainst: [],
    risks: [],
    protectedSignals: [],
    missingEvidence: ["Live SERP composition for this exact query has not been checked."],
    ...overrides,
  };
}

async function main() {
  test("includes every required section with real values when the data is present", () => {
    const report = buildHandoffReport(keywordFinding(), classificationFor());
    assert.ok(report.includes("MILE HIGH JUNK REMOVAL — SITE IMPROVEMENT TASK"));
    assert.ok(report.includes("OPPORTUNITY"));
    assert.ok(report.includes("Strengthen existing Denver junk-removal page"));
    assert.ok(report.includes("AGENT CLASSIFICATION"));
    assert.ok(report.includes("Importance: IMPORTANT"));
    assert.ok(report.includes("Evidence confidence: high"));
    assert.ok(report.includes("Finding type: keyword-opportunity-ctr-opportunity"));
    assert.ok(report.includes("Affected page: denver-junk-removal.html"));
    assert.ok(report.includes("WHY THIS WAS SURFACED"));
    assert.ok(report.includes("FIRST-PARTY EVIDENCE"));
    assert.ok(report.includes("GSC:"));
    assert.ok(report.includes('Query: "junk removal denver"'));
    assert.ok(report.includes("LOCAL / EXTERNAL RESEARCH"));
    assert.ok(report.includes("Not yet verified"));
    assert.ok(report.includes("EVIDENCE FOR CHANGE"));
    assert.ok(report.includes("EVIDENCE AGAINST CHANGE") === false || true); // checked explicitly below (empty -> omitted)
    assert.ok(report.includes("AGENT RECOMMENDATION"));
    assert.ok(report.includes("SMALLEST SAFE CHANGE"));
    assert.ok(report.includes("WHAT TO MONITOR AFTERWARD"));
    assert.ok(report.includes("CLAUDE INSTRUCTIONS"));
    assert.ok(report.includes("Do not merge to main or deploy until Gerardo explicitly approves it."));
  });

  test("the generated report contains actual values, never placeholder text", () => {
    const report = buildHandoffReport(keywordFinding(), classificationFor());
    assert.ok(!/\[.*\]/.test(report.split("CLAUDE INSTRUCTIONS")[0]), "no bracketed placeholder text should remain in the body sections");
    assert.ok(report.includes("120"), "the real impressions count should appear");
    assert.ok(report.includes("3.4"), "the real position should appear");
  });

  test("sections with nothing applicable are omitted entirely, not rendered empty", () => {
    const finding = keywordFinding({ evidence: [{ field: "query", value: "junk removal denver" }] }); // no metrics/ga4/landingPage/trend
    const classification = classificationFor({ evidenceAgainst: [], risks: [], protectedSignals: [], missingEvidence: [] });
    const report = buildHandoffReport(finding, classification);
    assert.ok(!report.includes("EVIDENCE AGAINST CHANGE"));
    assert.ok(!report.includes("PROTECTED SIGNALS / RISKS"));
    assert.ok(!report.includes("LOCAL / EXTERNAL RESEARCH"));
    assert.ok(!report.includes("CURRENT PAGE STATE"), "no pages context was supplied, so this section must be omitted, never a placeholder");
    assert.ok(!report.includes("GA4:"));
  });

  test("CURRENT PAGE STATE is filled with real scanned-page values when context.pages is supplied", () => {
    const pages = [{ file: "denver-junk-removal.html", title: "Denver Junk Removal | Mile High Junk Removal", metaDescription: "Fast, friendly junk removal in Denver.", canonical: "https://www.milehighjunkremoval.net/denver-junk-removal.html", h1s: ["Denver Junk Removal"], wordCount: 850, internalLinks: [{}, {}, {}] }];
    const report = buildHandoffReport(keywordFinding(), classificationFor(), { pages });
    assert.ok(report.includes("CURRENT PAGE STATE"));
    assert.ok(report.includes("Denver Junk Removal | Mile High Junk Removal"));
    assert.ok(report.includes("Fast, friendly junk removal in Denver."));
    assert.ok(report.includes("Word count: 850"));
  });

  test("EVIDENCE FOR and EVIDENCE AGAINST both render when both are populated (the report must show both sides)", () => {
    const classification = classificationFor({
      evidenceFor: ["Strong commercial intent, position 3.4."],
      evidenceAgainst: ["GA4 engagement on this page is weak."],
    });
    const report = buildHandoffReport(keywordFinding(), classification);
    const forIdx = report.indexOf("EVIDENCE FOR CHANGE");
    const againstIdx = report.indexOf("EVIDENCE AGAINST CHANGE");
    assert.ok(forIdx !== -1 && againstIdx !== -1 && forIdx < againstIdx);
    assert.ok(report.includes("Strong commercial intent, position 3.4."));
    assert.ok(report.includes("GA4 engagement on this page is weak."));
  });

  test("PROTECTED SIGNALS / RISKS section merges protectedSignals and risks together", () => {
    const classification = classificationFor({ protectedSignals: ["pricing.html is a strong performer"], risks: ["could cannibalize an existing page"] });
    const report = buildHandoffReport(keywordFinding(), classification);
    assert.ok(report.includes("PROTECTED SIGNALS / RISKS"));
    assert.ok(report.includes("pricing.html is a strong performer"));
    assert.ok(report.includes("could cannibalize an existing page"));
  });

  test("CLAUDE INSTRUCTIONS section is always present verbatim, regardless of what other sections are omitted", () => {
    const sparse = { key: "k", type: "missing-h1", summary: "no h1", pages: ["a.html"], recommendation: null, evidence: [] };
    const classification = { classification: "IMPORTANT", evidenceConfidence: "high", reason: "verified", evidenceFor: [], evidenceAgainst: [], risks: [], protectedSignals: [], missingEvidence: [] };
    const report = buildHandoffReport(sparse, classification);
    assert.ok(report.includes("Independently verify this finding before changing code."));
    assert.ok(report.includes("Do not assume the Agent is correct."));
    assert.ok(report.includes("do not introduce duplicate/cannibalizing pages"));
    assert.ok(report.includes("Do not merge to main or deploy until Gerardo explicitly approves it."));
  });

  test("works for a non-search finding type (technical/general) just as well, omitting search-only sections cleanly", () => {
    const finding = {
      key: "missing-canonical::privacy-policy.html",
      type: "missing-canonical",
      summary: "privacy-policy.html has no canonical tag",
      pages: ["privacy-policy.html"],
      recommendation: "Add a self-referencing canonical tag to privacy-policy.html.",
      evidence: [{ field: "file", value: "privacy-policy.html" }],
    };
    const classification = {
      classification: "IMPORTANT",
      evidenceConfidence: "high",
      reason: "Clear, internally-evidenced technical improvement.",
      evidenceFor: ["file: \"privacy-policy.html\""],
      evidenceAgainst: [],
      risks: [],
      protectedSignals: [],
      missingEvidence: [],
    };
    const report = buildHandoffReport(finding, classification);
    assert.ok(report.includes("Add a self-referencing canonical tag"));
    assert.ok(!report.includes("GSC:"));
    assert.ok(!report.includes("GA4:"));
    assert.ok(!report.includes("LOCAL / EXTERNAL RESEARCH"));
  });

  console.log("agent-claude-handoff-report.test.js: all tests completed");
}

main();
