// Site Improvement Agent, Phase 6 lifecycle-tightening — tests for
// agent/lib/firstparty-candidates.js: which findings are first-party-
// evidence CANDIDATES (narrow, deterministic, never imported by
// decision.js), and the narrow question/hint shape it produces.
//
// Run with:  node tests/agent-firstparty-candidates.test.js

const assert = require("assert");
const { CANDIDATE_TYPES, isFirstPartyEvidenceCandidate, buildFirstPartyEvidenceQuestion } = require("../agent/lib/firstparty-candidates");

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

function candidateFinding(overrides) {
  return {
    key: "sitemap-missing-url::x.html",
    type: "sitemap-missing-url",
    tier: "actionable",
    decision: "PROPOSE_CHANGE",
    pages: ["x.html"],
    summary: "x.html missing from sitemap",
    firstPartyEvidence: [],
    ...overrides,
  };
}

test("a listed candidate type, actionable tier, PROPOSE_CHANGE, no evidence yet, is eligible", () => {
  assert.strictEqual(isFirstPartyEvidenceCandidate(candidateFinding()), true);
});

test("a finding type NOT in CANDIDATE_TYPES is never eligible, regardless of tier/decision", () => {
  assert.strictEqual(isFirstPartyEvidenceCandidate(candidateFinding({ type: "title-length" })), false);
  assert.strictEqual(isFirstPartyEvidenceCandidate(candidateFinding({ type: "content-gap" })), false);
});

test("an observation-tier finding is never eligible — decision.js already resolved it to NO_CHANGE as 'not actionable on its own', and re-opening it just to fetch more evidence would be manufactured work", () => {
  assert.strictEqual(isFirstPartyEvidenceCandidate(candidateFinding({ tier: "observation", decision: "NO_CHANGE" })), false);
});

test("an APPLY_SAFE_FIX finding is never eligible — already mechanically resolved, nothing left to investigate", () => {
  assert.strictEqual(isFirstPartyEvidenceCandidate(candidateFinding({ decision: "APPLY_SAFE_FIX" })), false);
});

test("a finding that already has first-party evidence attached is never eligible again — once answered, it stays answered", () => {
  assert.strictEqual(isFirstPartyEvidenceCandidate(candidateFinding({ firstPartyEvidence: [{ source: "ga4" }] })), false);
});

test("options.isNewThisRun === false excludes an otherwise-eligible candidate — an older still-open finding does not keep re-blocking every subsequent run", () => {
  assert.strictEqual(isFirstPartyEvidenceCandidate(candidateFinding(), { isNewThisRun: false }), false);
});

test("options.isNewThisRun === true, or omitted entirely, does not exclude an otherwise-eligible candidate", () => {
  assert.strictEqual(isFirstPartyEvidenceCandidate(candidateFinding(), { isNewThisRun: true }), true);
  assert.strictEqual(isFirstPartyEvidenceCandidate(candidateFinding()), true);
});

test("CANDIDATE_TYPES is a small, fixed, non-category-C set — category-C findings keep their own existing RESEARCH_MORE path, not this one", () => {
  assert.ok(CANDIDATE_TYPES.size > 0 && CANDIDATE_TYPES.size <= 10);
  for (const type of CANDIDATE_TYPES) {
    assert.ok(!["content-gap", "coverage-gap-candidate", "overlapping-intent", "duplicate-meta-description", "research-gap"].includes(type), `${type} is a category-C type and must not be in CANDIDATE_TYPES`);
  }
});

test("buildFirstPartyEvidenceQuestion() returns a narrow question plus a source-type HINT — never a ready-made fetch request (scope/urls are the orchestrator's job, same as decision.js's research questions)", () => {
  const q = buildFirstPartyEvidenceQuestion(candidateFinding());
  assert.strictEqual(q.findingKey, "sitemap-missing-url::x.html");
  assert.strictEqual(q.findingType, "sitemap-missing-url");
  assert.deepStrictEqual(q.pages, ["x.html"]);
  assert.ok(typeof q.question === "string" && q.question.length > 0 && q.question.includes("x.html"));
  assert.ok(Array.isArray(q.suggestedRequestTypes) && q.suggestedRequestTypes.length > 0);
  assert.strictEqual(q.scope, undefined, "must not pre-fill a scope — the orchestrator derives the real one");
  assert.strictEqual(q.urls, undefined, "must not pre-fill a URL — the orchestrator derives the real one");
  assert.strictEqual(q.verdict, undefined, "must never carry a verdict/decision field");
});

test("every CANDIDATE_TYPES entry has its own specific question wording, not the generic fallback", () => {
  for (const type of CANDIDATE_TYPES) {
    const q = buildFirstPartyEvidenceQuestion(candidateFinding({ type, key: `${type}::x.html`, summary: "generic fallback summary text" }));
    assert.ok(!q.question.startsWith("generic fallback summary text"), `expected a type-specific question for "${type}", got the generic summary-based fallback`);
  }
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
