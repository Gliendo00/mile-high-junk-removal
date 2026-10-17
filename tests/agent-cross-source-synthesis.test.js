// Site Improvement Agent, Phase 13a — tests for agent/lib/cross-source-
// synthesis.js: sufficiency classification, opportunity-class
// thresholds, verdict/confidence mapping, and the research.js schema
// additions (familyBreakdown/sufficiency/synthesisFingerprint) this
// module's output must validate against.
//
// Run with:  node tests/agent-cross-source-synthesis.test.js

const assert = require("assert");
const {
  classifySufficiency,
  meetsThreshold,
  buildSynthesisResultArgs,
  OPPORTUNITY_CLASS_RULES,
} = require("../agent/lib/cross-source-synthesis");
const { makeResearchResult, FAMILY_STATUSES, SUFFICIENCY_LEVELS, SOURCE_TYPES } = require("../agent/lib/research");

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

function family(status, detail = "detail", evidenceRefs = []) {
  return { status, detail, evidenceRefs };
}

function families(overrides = {}) {
  return {
    site: family("not-applicable"),
    gsc: family("unavailable"),
    ga4: family("unavailable"),
    completedJobs: family("not-applicable"),
    localSource: family("unavailable"),
    ...overrides,
  };
}

// --- classifySufficiency --------------------------------------------------

test("research.js exports the new source type and the two enums this module depends on", () => {
  assert.ok(SOURCE_TYPES.includes("cross-source-synthesis"));
  assert.deepStrictEqual(
    [...FAMILY_STATUSES].sort(),
    ["contradicts", "different-question", "insufficient-data", "not-applicable", "supports", "unavailable"].sort()
  );
  assert.deepStrictEqual([...SUFFICIENCY_LEVELS].sort(), ["contradicted", "corroborated", "partially-corroborated", "unsupported"].sort());
});

test("all families insufficient/unavailable/not-applicable (including site, which never votes) -> unsupported", () => {
  const { sufficiency, supportingFamilies } = classifySufficiency(families());
  assert.strictEqual(sufficiency, "unsupported");
  assert.deepStrictEqual(supportingFamilies, []);
});

test("site alone 'supporting' never counts — site is always not-applicable by construction, so this can't even be expressed, but a stray 'supports' on site would still be the ONLY vote (1), not enough to change the overall shape of the rule", () => {
  // Defensive: even if some future bug set site's status to "supports",
  // the counting logic treats it like any other family — it is
  // evidence-dossier.js's job (tested separately) to never actually do
  // this; this module's own counting logic is intentionally generic.
  const { sufficiency, supportingFamilies } = classifySufficiency(families({ site: family("supports") }));
  assert.strictEqual(sufficiency, "partially-corroborated");
  assert.deepStrictEqual(supportingFamilies, ["site"]);
});

test("exactly one non-site family supporting -> partially-corroborated", () => {
  const { sufficiency } = classifySufficiency(families({ gsc: family("supports") }));
  assert.strictEqual(sufficiency, "partially-corroborated");
});

test("two independent families supporting -> corroborated", () => {
  const { sufficiency, supportingFamilies } = classifySufficiency(families({ gsc: family("supports"), completedJobs: family("supports") }));
  assert.strictEqual(sufficiency, "corroborated");
  assert.strictEqual(supportingFamilies.length, 2);
});

test("any family contradicting -> contradicted, regardless of how many others support", () => {
  const { sufficiency } = classifySufficiency(families({ gsc: family("supports"), completedJobs: family("contradicts") }));
  assert.strictEqual(sufficiency, "contradicted");
});

test("different-question and insufficient-data never count as votes for either side", () => {
  const { sufficiency, supportingFamilies, contradictingFamilies } = classifySufficiency(
    families({ gsc: family("different-question"), ga4: family("different-question"), completedJobs: family("insufficient-data") })
  );
  assert.strictEqual(sufficiency, "unsupported");
  assert.deepStrictEqual(supportingFamilies, []);
  assert.deepStrictEqual(contradictingFamilies, []);
});

// --- opportunity-class thresholds ---------------------------------------

test("content-gap and coverage-gap-candidate accept partially-corroborated as sufficient", () => {
  assert.strictEqual(meetsThreshold("content-gap", "partially-corroborated"), true);
  assert.strictEqual(meetsThreshold("coverage-gap-candidate", "partially-corroborated"), true);
});

test("structural-inconsistency/duplicate-meta-description/overlapping-intent require full corroboration — partially-corroborated is NOT enough", () => {
  assert.strictEqual(meetsThreshold("structural-inconsistency", "partially-corroborated"), false);
  assert.strictEqual(meetsThreshold("duplicate-meta-description", "partially-corroborated"), false);
  assert.strictEqual(meetsThreshold("overlapping-intent", "partially-corroborated"), false);
  assert.strictEqual(meetsThreshold("structural-inconsistency", "corroborated"), true);
});

test("unsupported never meets any finding type's threshold", () => {
  for (const type of Object.keys(OPPORTUNITY_CLASS_RULES)) {
    assert.strictEqual(meetsThreshold(type, "unsupported"), false, `expected unsupported to fail for ${type}`);
  }
});

test("an out-of-scope/unknown finding type never meets any threshold (fail safe)", () => {
  assert.strictEqual(meetsThreshold("pageless-city-evaluation", "corroborated"), false);
  assert.strictEqual(meetsThreshold("totally-made-up", "corroborated"), false);
});

// --- buildSynthesisResultArgs: unsupported/below-threshold -> null (preserve RESEARCH_MORE) --

test("unsupported sufficiency for content-gap -> null (no file written, decision.js's RESEARCH_MORE path is preserved)", () => {
  const finding = { key: "content-gap::x.html", type: "content-gap", summary: "gap" };
  const dossier = { families: families() };
  assert.strictEqual(buildSynthesisResultArgs(finding, dossier), null);
});

test("partially-corroborated for a type that requires full corroboration -> null, never a manufactured weak artifact", () => {
  const finding = { key: "overlapping-intent::a.html,b.html", type: "overlapping-intent", summary: "overlap" };
  const dossier = { families: families({ gsc: family("supports") }) };
  assert.strictEqual(buildSynthesisResultArgs(finding, dossier), null);
});

// --- buildSynthesisResultArgs: sufficient -> a valid research.js result ------

test("partially-corroborated for content-gap -> supports-opportunity, medium confidence, valid research.js shape", () => {
  const finding = { key: "content-gap::blog-x.html", type: "content-gap", summary: "gap", pages: ["blog-x.html"] };
  const dossier = { families: families({ gsc: family("supports", "real demand") }) };
  const args = buildSynthesisResultArgs(finding, dossier, { fingerprint: "fp1" });
  assert.ok(args);
  assert.strictEqual(args.verdict, "supports-opportunity");
  assert.strictEqual(args.confidence, "medium");
  assert.strictEqual(args.sufficiency, "partially-corroborated");
  assert.strictEqual(args.sourceType, "cross-source-synthesis");
  assert.strictEqual(args.synthesisFingerprint, "fp1");
  const validated = makeResearchResult(args); // must not throw
  assert.strictEqual(validated.kind, "cross-source-synthesis");
  assert.ok(Array.isArray(validated.familyBreakdown) && validated.familyBreakdown.length === 5);
});

test("corroborated (2 independent families) -> high confidence", () => {
  const finding = { key: "coverage-gap-candidate::denver-junk-removal.html", type: "coverage-gap-candidate", summary: "gap", pages: ["denver-junk-removal.html"] };
  const dossier = { families: families({ gsc: family("supports"), completedJobs: family("supports") }) };
  const args = buildSynthesisResultArgs(finding, dossier);
  assert.strictEqual(args.confidence, "high");
  assert.strictEqual(args.verdict, "supports-opportunity");
  makeResearchResult(args);
});

test("premise-aware contradiction -> contradicts-opportunity, bypassing the opportunity-class threshold entirely", () => {
  const finding = { key: "content-gap::blog-x.html", type: "content-gap", summary: "gap", pages: ["blog-x.html"] };
  // Synthetic: no real evidence family in Phase 13a ever mechanically
  // produces "contradicts" (see evidence-dossier.js's header) — this
  // directly exercises classifySufficiency()/buildSynthesisResultArgs()'s
  // OWN handling of the category, proving the machinery is correct even
  // though no live evidence path currently reaches it.
  const dossier = { families: families({ gsc: family("contradicts", "a fresh authoritative source affirmatively conflicts with the premise") }) };
  const args = buildSynthesisResultArgs(finding, dossier);
  assert.ok(args);
  assert.strictEqual(args.verdict, "contradicts-opportunity");
  makeResearchResult(args);
});

test("evidence[] on the built result is a bounded, inspectable array of strings — no chain-of-thought/raw-payload dump", () => {
  const finding = { key: "content-gap::blog-x.html", type: "content-gap", summary: "gap", pages: ["blog-x.html"] };
  const dossier = { families: families({ gsc: family("supports", "demand") }) };
  const args = buildSynthesisResultArgs(finding, dossier);
  assert.ok(Array.isArray(args.evidence));
  for (const e of args.evidence) assert.strictEqual(typeof e, "string");
});

// --- research.js schema validation for cross-source-synthesis ----------

test("makeResearchResult requires familyBreakdown/sufficiency when sourceType is cross-source-synthesis", () => {
  assert.throws(() =>
    makeResearchResult({
      findingKey: "x",
      question: "q",
      source: "s",
      sourceType: "cross-source-synthesis",
      evidence: ["e"],
      confidence: "medium",
      limitations: "l",
      verdict: "supports-opportunity",
      recommendation: "r",
      // missing sufficiency/familyBreakdown
    })
  );
});

test("makeResearchResult rejects an invalid familyBreakdown[].status", () => {
  assert.throws(() =>
    makeResearchResult({
      findingKey: "x",
      question: "q",
      source: "s",
      sourceType: "cross-source-synthesis",
      evidence: ["e"],
      confidence: "medium",
      limitations: "l",
      verdict: "supports-opportunity",
      recommendation: "r",
      sufficiency: "corroborated",
      familyBreakdown: [{ family: "gsc", status: "definitely-true", detail: "x" }],
    })
  );
});

test("makeResearchResult still works unchanged for an ordinary non-synthesis result (backward compatible)", () => {
  const r = makeResearchResult({
    findingKey: "x",
    question: "q",
    source: "https://example.gov",
    sourceType: "official-government",
    evidence: ["e"],
    confidence: "medium",
    limitations: "l",
    verdict: "supports-opportunity",
    recommendation: "r",
  });
  assert.strictEqual(r.familyBreakdown, null);
  assert.strictEqual(r.sufficiency, null);
  assert.strictEqual(r.kind, "external");
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
