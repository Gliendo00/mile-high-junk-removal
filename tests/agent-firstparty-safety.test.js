// Site Improvement Agent, Phase 6 — the HARD safety-rule regression
// tests the brief explicitly asked for: "metrics are signals, not
// decisions." Every test here proves something structural (decision.js
// literally never reads first-party evidence; no finding type exists
// that could create a new page; the auto-apply whitelist is unchanged),
// never just "the agent currently chooses not to."
//
// Run with:  node tests/agent-firstparty-safety.test.js

const assert = require("assert");
const { makeFinding } = require("../agent/lib/findings");
const { classify } = require("../agent/lib/risk");
const { decide } = require("../agent/lib/decision");
const { makeFirstPartyEvidence } = require("../agent/lib/firstparty-evidence");
const { attachFirstPartyEvidence } = require("../agent/lib/firstparty-intake");

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

function extremeEvidence(findingKey, overrides) {
  return makeFirstPartyEvidence({
    findingKey,
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    scope: { type: "city", value: "Brighton" },
    window: { start: "2026-09-13", end: "2026-10-10", label: "28 days ending 2026-10-10" },
    // Deliberately extreme values — a huge impressions count, a
    // near-zero CTR, a steep decline — the kind of numbers a careless
    // system might be tempted to act on directly.
    observed: { totalRowsReturned: 1, topRows: [{ keys: ["brighton junk removal"], clicks: 1, impressions: 50000, ctr: 0.00002, position: 48.7 }] },
    context: "Targeted Search Analytics query for city \"Brighton\".",
    limitations: "Search behavior only — does not establish visitor intent, demand, or that a page is required.",
    ...overrides,
  });
}

test("decision.js's decide() produces byte-identical output whether or not a finding carries first-party evidence", () => {
  const base = makeFinding({
    type: "coverage-gap-candidate",
    summary: "furniture-removal.html is promoted on most city pages but absent from brighton context",
    pages: ["brighton-junk-removal.html"],
    evidence: [{ field: "serviceFile", value: "furniture-removal.html" }],
  });
  const classified = classify(base);

  const withoutFPE = { ...classified, research: [], firstPartyEvidence: [] };
  const withFPE = { ...classified, research: [], firstPartyEvidence: [extremeEvidence(classified.key)] };

  const decisionWithout = decide(withoutFPE);
  const decisionWith = decide(withFPE);
  assert.deepStrictEqual(decisionWith, decisionWithout, "attaching first-party evidence must never change decide()'s output");
});

test("decide()'s source code never references `firstPartyEvidence` at all — structural, not just empirically unchanged", () => {
  const decideSource = decide.toString();
  assert.strictEqual(/firstPartyEvidence/.test(decideSource), false, "decision.js must have zero code paths reading first-party evidence");
});

test("attachFirstPartyEvidence() is called strictly for display — it mutates `.firstPartyEvidence` only, never `.decision`/`.category`/`.tier`/`.autoApplyEligible`", () => {
  const finding = classify(
    makeFinding({ type: "title-length", summary: "short title", pages: ["a.html"], evidence: [{ field: "title", value: "x" }] })
  );
  const before = { ...finding };
  const decided = decide(finding);
  Object.assign(finding, decided);
  const snapshotBeforeAttach = { decision: finding.decision, category: finding.category, tier: finding.tier, autoApplyEligible: finding.autoApplyEligible };

  const { findings: out } = attachFirstPartyEvidence([finding], { entries: [extremeEvidence(finding.key)], warnings: [] });

  assert.strictEqual(out[0].decision, snapshotBeforeAttach.decision);
  assert.strictEqual(out[0].category, snapshotBeforeAttach.category);
  assert.strictEqual(out[0].tier, snapshotBeforeAttach.tier);
  assert.strictEqual(out[0].autoApplyEligible, snapshotBeforeAttach.autoApplyEligible);
  assert.ok(out[0].firstPartyEvidence.length === 1);
});

// -----------------------------------------------------------------------
// Service-area safety (brief §7): claimed service-area city != required
// city page, no matter how much first-party evidence piles up.
// -----------------------------------------------------------------------

test("first-party evidence has no field that could represent 'create this page' — scope is purely descriptive", () => {
  const evidence = extremeEvidence("some-key");
  assert.strictEqual(evidence.decision, undefined);
  assert.strictEqual(evidence.recommendation, undefined);
  assert.strictEqual(evidence.createPage, undefined);
  // scope.value is a free-text label ("Brighton"), never itself a
  // directive — there is no code anywhere that reads scope.value and
  // creates a file from it (grep confirms: only report.js/admin UI read
  // it, for DISPLAY).
  assert.strictEqual(typeof evidence.scope.value, "string");
});

test("the auto-apply whitelist is unchanged by Phase 6 — link-audit.js still attaches `autoFix` to exactly the same two finding types, and autoApplyEligible still requires riskLevel low + tier actionable on top of that", () => {
  const fs = require("fs");
  const path = require("path");
  // autoApplyEligible = Boolean(finding.autoFix) && riskLevel==="low" && tier==="actionable"
  // (risk.js) — riskLevel/tier alone (several finding types share that
  // combination) is NOT sufficient; only a finding that ALSO carries a
  // mechanical `autoFix` descriptor can ever reach APPLY_SAFE_FIX. The
  // COMPLETE list of files allowed to attach `autoFix:` at all is
  // asserted by the Phase 14B test below (now two files, not one); this
  // test's own job is narrower — confirm link-audit.js itself still
  // attaches it to exactly these same two finding types, unwidened.
  const libDir = path.join(__dirname, "..", "agent", "lib");
  const linkAuditSource = fs.readFileSync(path.join(libDir, "link-audit.js"), "utf8");
  const typesWithAutoFix = [...linkAuditSource.matchAll(/type:\s*"([a-z-]+)"[\s\S]{0,800}?autoFix:\s*\{/g)].map((m) => m[1]);
  assert.deepStrictEqual(new Set(typesWithAutoFix), new Set(["redirect-hop-internal-link", "broken-internal-link-fixable"]));
});

test("Phase 14B — seo-audit.js is a deliberate, narrow SECOND file allowed to attach `autoFix`, to exactly one REAL finding type (canonical-mismatch), and that type must stay permanently ineligible for auto-apply", () => {
  const fs = require("fs");
  const path = require("path");
  // Named explicitly (not just by count) — this is now the ONE place
  // asserting the complete file list, so this test fails if a THIRD
  // file, or a different type within either file, ever attaches
  // `autoFix:` unnoticed.
  const libDir = path.join(__dirname, "..", "agent", "lib");
  const filesWithAutoFix = fs.readdirSync(libDir).filter((f) => {
    if (!f.endsWith(".js")) return false;
    const src = fs.readFileSync(path.join(libDir, f), "utf8");
    return /autoFix:\s*\{/.test(src);
  });
  assert.deepStrictEqual([...filesWithAutoFix].sort(), ["link-audit.js", "seo-audit.js"]);

  const seoAuditSource = fs.readFileSync(path.join(libDir, "seo-audit.js"), "utf8");
  const typesWithAutoFix = [...seoAuditSource.matchAll(/type:\s*"([a-z-]+)"[\s\S]{0,800}?autoFix:\s*\{/g)].map((m) => m[1]);
  assert.deepStrictEqual(new Set(typesWithAutoFix), new Set(["canonical-mismatch"]));

  const { RULES } = require("../agent/lib/risk");
  assert.strictEqual(RULES["canonical-mismatch"].riskLevel, "medium", "canonical-mismatch must never be riskLevel \"low\", or it would become autoApplyEligible");

  const { classify } = require("../agent/lib/risk");
  const classified = classify({
    type: "canonical-mismatch",
    autoFix: { kind: "rewrite-href", file: "sample.html", from: "https://www.milehighjunkremoval.net/wrong.html", to: "https://www.milehighjunkremoval.net/sample.html" },
  });
  assert.strictEqual(classified.autoApplyEligible, false, "canonical-mismatch must never be autoApplyEligible even though it now carries a real autoFix");
});

// -----------------------------------------------------------------------
// Cannibalization safety (brief §8): query/page overlap evidence is
// never itself a merge/delete/redirect trigger.
// -----------------------------------------------------------------------

test("overlapping-intent findings still only ever route through RESEARCH_MORE/PROPOSE_CHANGE — first-party overlap evidence cannot force an auto-merge/delete/redirect", () => {
  const finding = classify(
    makeFinding({
      type: "overlapping-intent",
      summary: "aurora-junk-removal.html and parker-junk-removal.html show high similarity",
      pages: ["aurora-junk-removal.html", "parker-junk-removal.html"],
      evidence: [{ field: "titleSimilarity", value: 0.8 }],
    })
  );
  const overlapEvidence = makeFirstPartyEvidence({
    findingKey: finding.key,
    source: "search-console-search-analytics",
    metric: "clicks-impressions-ctr-position",
    scope: { type: "query", value: "junk removal near me" },
    window: { start: "2026-09-13", end: "2026-10-10", label: "28 days ending 2026-10-10" },
    observed: { totalRowsReturned: 2, topRows: [{ keys: ["aurora-junk-removal.html"], clicks: 5 }, { keys: ["parker-junk-removal.html"], clicks: 4 }] },
    context: "Both pages receive impressions for a similar query.",
    limitations: "Query/page overlap alone does not establish cannibalization — intent and performance must be separately assessed.",
  });

  const withoutFPE = decide({ ...finding, research: [], firstPartyEvidence: [] });
  const withFPE = decide({ ...finding, research: [], firstPartyEvidence: [overlapEvidence] });
  assert.deepStrictEqual(withFPE, withoutFPE);
  assert.notStrictEqual(withFPE.decision, "APPLY_SAFE_FIX");
  assert.ok(["RESEARCH_MORE", "NO_CHANGE", "PROPOSE_CHANGE", "REJECT_OPPORTUNITY"].includes(withFPE.decision));
});

test("no fixer kind other than 'rewrite-href' exists anywhere — no merge/delete/redirect auto-fixer could exist for cannibalization even if a finding requested one", () => {
  const applyEligible = require("../agent/lib/apply/rewrite-href");
  assert.ok(typeof applyEligible.apply === "function");
  // agent/runner.js's applyEligible() hardcodes the single recognized
  // fixer kind — re-confirm that literal here so this test fails loudly
  // if a future change ever widens it without deliberate review.
  const runnerSource = require("fs").readFileSync(require.resolve("../agent/runner"), "utf8");
  const fixerKinds = [...runnerSource.matchAll(/autoFix\.kind !== "([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(fixerKinds, ["rewrite-href"]);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
