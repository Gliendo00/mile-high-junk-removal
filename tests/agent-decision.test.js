// Site Improvement Agent — tests for agent/lib/decision.js, the decision
// engine that turns a classified (risk.js) finding, with any research
// attached (research-intake.js), into one of APPLY_SAFE_FIX /
// PROPOSE_CHANGE / RESEARCH_MORE / NO_CHANGE / REJECT_OPPORTUNITY.
//
// Uses synthetic findings built via makeFinding + risk.classify, exactly
// the same objects runner.js produces, so this exercises the real
// decision logic the system actually runs — just against constructed
// scenarios rather than whatever happens to be true of the live site
// today (which, as of this Phase 2 run, has zero category-C findings —
// see agent/README.md).
//
// Run with:  node tests/agent-decision.test.js

const assert = require("assert");
const { makeFinding } = require("../agent/lib/findings");
const { classify } = require("../agent/lib/risk");
const { makeResearchResult } = require("../agent/lib/research");
const { decide, decideAll } = require("../agent/lib/decision");

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

function research(overrides) {
  return makeResearchResult({
    findingKey: "placeholder",
    question: "q",
    source: "https://example.gov/x",
    sourceType: "official-government",
    evidence: ["observed fact"],
    confidence: "medium",
    limitations: "does not establish demand",
    verdict: "supports-opportunity",
    recommendation: "do the thing",
    ...overrides,
  });
}

test("a finding with a mechanical autoFix and low risk -> APPLY_SAFE_FIX", () => {
  const f = classify(
    makeFinding({
      type: "redirect-hop-internal-link",
      summary: "hop",
      pages: ["a.html"],
      evidence: [{ x: 1 }],
      autoFix: { kind: "rewrite-href", file: "a.html", from: "/x", to: "/y" },
    })
  );
  f.research = [];
  const d = decide(f);
  assert.strictEqual(d.decision, "APPLY_SAFE_FIX");
});

test("category E (unrecognized type) -> NO_CHANGE, regardless of anything else", () => {
  const f = classify(makeFinding({ type: "totally-made-up", summary: "mystery", pages: ["a.html"], evidence: [{ x: 1 }] }));
  f.research = [];
  const d = decide(f);
  assert.strictEqual(d.decision, "NO_CHANGE");
});

test("category D (duplicate-title) -> PROPOSE_CHANGE, requiresApproval true, never auto-applied", () => {
  const f = classify(makeFinding({ type: "duplicate-title", summary: "dup", pages: ["a.html", "b.html"], evidence: [{ x: 1 }] }));
  f.research = [];
  const d = decide(f);
  assert.strictEqual(d.decision, "PROPOSE_CHANGE");
  assert.strictEqual(d.requiresApproval, true);
});

test("Phase 3: a tier:'observation' finding ALWAYS resolves to NO_CHANGE, even if its category is A or B and it could otherwise read as a technical issue", () => {
  const f = classify(makeFinding({ type: "title-length", summary: "71 chars", pages: ["a.html"], evidence: [{ x: 1 }] }));
  f.research = [];
  const d = decide(f);
  assert.strictEqual(f.tier, "observation");
  assert.strictEqual(d.decision, "NO_CHANGE");
  assert.ok(d.reason.includes("observation only"));
});

test("Phase 3: an ESCALATED malformed-title finding (not a mere length observation) IS actionable -> PROPOSE_CHANGE", () => {
  const f = classify(makeFinding({ type: "title-malformed", summary: "placeholder title", pages: ["a.html"], evidence: [{ x: 1 }] }));
  f.research = [];
  const d = decide(f);
  assert.strictEqual(f.tier, "actionable");
  assert.strictEqual(d.decision, "PROPOSE_CHANGE");
});

test("category A/B with no auto-fix -> PROPOSE_CHANGE, no research wasted on it", () => {
  const f = classify(makeFinding({ type: "missing-canonical", summary: "no canonical", pages: ["a.html"], evidence: [{ x: 1 }] }));
  f.research = [];
  const d = decide(f);
  assert.strictEqual(d.decision, "PROPOSE_CHANGE");
  assert.ok(!d.reason.includes("research"), "an internally-answerable A/B finding should never mention wasting research in its reasoning");
});

test("category C with no research attached -> RESEARCH_MORE, carrying a structured researchQuestion", () => {
  const f = classify(
    makeFinding({
      type: "structural-inconsistency",
      summary: "thin-page.html is unusually short",
      pages: ["thin-page.html"],
      evidence: [{ field: "wordCount", value: 200 }],
      recommendation: "Research whether this page needs expansion.",
    })
  );
  f.research = [];
  const d = decide(f);
  assert.strictEqual(d.decision, "RESEARCH_MORE");
  assert.ok(d.researchQuestion);
  assert.strictEqual(d.researchQuestion.findingKey, f.key);
  assert.ok(d.researchQuestion.question.length > 0);
  assert.ok(Array.isArray(d.researchQuestion.suggestedSourceTypes) && d.researchQuestion.suggestedSourceTypes.length > 0);
});

test("category C with LOW-confidence research attached -> NO_CHANGE (evidence too weak to act on)", () => {
  const f = classify(makeFinding({ type: "structural-inconsistency", summary: "thin page", pages: ["p.html"], evidence: [{ x: 1 }] }));
  f.research = [research({ findingKey: f.key, confidence: "low", verdict: "supports-opportunity" })];
  const d = decide(f);
  assert.strictEqual(d.decision, "NO_CHANGE");
  assert.ok(d.reason.includes("low"));
});

test("category C with an INCONCLUSIVE verdict (even at high confidence) -> NO_CHANGE", () => {
  const f = classify(makeFinding({ type: "structural-inconsistency", summary: "thin page", pages: ["p.html"], evidence: [{ x: 1 }] }));
  f.research = [research({ findingKey: f.key, confidence: "high", verdict: "inconclusive" })];
  const d = decide(f);
  assert.strictEqual(d.decision, "NO_CHANGE");
});

test("category C with research that CONTRADICTS the opportunity -> REJECT_OPPORTUNITY", () => {
  const f = classify(makeFinding({ type: "structural-inconsistency", summary: "thin page", pages: ["p.html"], evidence: [{ x: 1 }] }));
  f.research = [research({ findingKey: f.key, confidence: "high", verdict: "contradicts-opportunity", recommendation: "page length is appropriate for its topic" })];
  const d = decide(f);
  assert.strictEqual(d.decision, "REJECT_OPPORTUNITY");
  assert.ok(d.reason.includes("appropriate for its topic"));
});

test("category C with medium/high-confidence SUPPORTING research -> PROPOSE_CHANGE (never auto-applied, requiresApproval true)", () => {
  const f = classify(makeFinding({ type: "structural-inconsistency", summary: "thin page", pages: ["p.html"], evidence: [{ x: 1 }] }));
  f.research = [research({ findingKey: f.key, confidence: "high", verdict: "supports-opportunity" })];
  const d = decide(f);
  assert.strictEqual(d.decision, "PROPOSE_CHANGE");
  assert.strictEqual(d.requiresApproval, true);
});

test("multiple research results attached -> the most recently accessed one wins, not the first or an average", () => {
  const f = classify(makeFinding({ type: "structural-inconsistency", summary: "thin page", pages: ["p.html"], evidence: [{ x: 1 }] }));
  f.research = [
    research({ findingKey: f.key, confidence: "high", verdict: "supports-opportunity", accessedAt: "2020-01-01T00:00:00.000Z" }),
    research({ findingKey: f.key, confidence: "low", verdict: "inconclusive", accessedAt: "2026-01-01T00:00:00.000Z" }),
  ];
  const d = decide(f);
  assert.strictEqual(d.decision, "NO_CHANGE", "the 2026 (more recent) low-confidence result should win over the older high-confidence one");
});

test("decideAll mutates and returns the same findings array it was given, each now carrying a decision", () => {
  const findings = [
    classify(makeFinding({ type: "missing-h1", summary: "a", pages: ["a.html"], evidence: [{ x: 1 }] })),
    classify(makeFinding({ type: "missing-canonical", summary: "b", pages: ["b.html"], evidence: [{ x: 1 }] })),
  ];
  findings.forEach((f) => { f.research = []; });
  const out = decideAll(findings);
  assert.strictEqual(out, findings);
  for (const f of out) {
    assert.ok(f.decision);
    assert.ok(f.reason);
  }
});

// Phase 4 hardening — "external research cannot bypass risk
// classification": a category A/B/D finding's decision must be
// completely unaffected by research attached to it (e.g. a misfiled
// research result whose findingKey happens to collide), because
// decide() only ever reads `.research` inside the needsExternalResearch()
// (category === "C") branch. category/tier, decided purely from
// risk.js's classification, remain the actual gate.
test("Phase 4 hardening: research attached to a non-category-C finding has ZERO effect on its decision — only category-C findings ever consult `.research`", () => {
  const strongSupportingResearch = [research({ findingKey: "whatever", confidence: "high", verdict: "supports-opportunity" })];

  const categoryA = classify(makeFinding({ type: "missing-canonical", summary: "no canonical", pages: ["a.html"], evidence: [{ x: 1 }] }));
  const categoryAWithResearch = { ...categoryA, research: strongSupportingResearch };
  const categoryAWithout = { ...categoryA, research: [] };
  assert.deepStrictEqual(decide(categoryAWithResearch), decide(categoryAWithout));

  const categoryD = classify(makeFinding({ type: "duplicate-title", summary: "dup", pages: ["a.html", "b.html"], evidence: [{ x: 1 }] }));
  const categoryDWithResearch = { ...categoryD, research: strongSupportingResearch };
  const categoryDWithout = { ...categoryD, research: [] };
  assert.deepStrictEqual(decide(categoryDWithResearch), decide(categoryDWithout));

  // An observation-tier finding stays NO_CHANGE even with "supporting"
  // research attached — observations never even reach the research
  // check (decide() returns before needsExternalResearch() is called).
  const observation = classify(makeFinding({ type: "title-length", summary: "71 chars", pages: ["a.html"], evidence: [{ x: 1 }] }));
  const observationWithResearch = { ...observation, research: strongSupportingResearch };
  assert.strictEqual(decide(observationWithResearch).decision, "NO_CHANGE");
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
