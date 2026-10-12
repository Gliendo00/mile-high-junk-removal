// Site Improvement Agent — unit tests for the finding factory and the
// risk/category classifier. Pure logic, no filesystem, no network.
//
// Run with:  node tests/agent-findings-and-risk.test.js

const assert = require("assert");
const { makeFinding } = require("../agent/lib/findings");
const { classify, classifyAll } = require("../agent/lib/risk");

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

test("makeFinding requires evidence — cannot assert something ungrounded", () => {
  assert.throws(() => {
    makeFinding({ type: "x", summary: "s", pages: ["a.html"], evidence: [] });
  }, /evidence/);
  assert.throws(() => {
    makeFinding({ type: "x", summary: "s", pages: ["a.html"] });
  }, /evidence/);
});

test("makeFinding requires at least one page", () => {
  assert.throws(() => {
    makeFinding({ type: "x", summary: "s", pages: [], evidence: [{ a: 1 }] });
  }, /page/);
});

test("makeFinding requires a summary", () => {
  assert.throws(() => {
    makeFinding({ type: "x", pages: ["a.html"], evidence: [{ a: 1 }] });
  }, /summary/);
});

test("makeFinding succeeds with valid input and assigns a stable id prefix", () => {
  const f = makeFinding({
    type: "missing-title",
    summary: "no title",
    pages: ["a.html"],
    evidence: [{ file: "a.html", field: "title", value: null }],
  });
  assert.ok(f.id.startsWith("missing-title-"));
  assert.strictEqual(f.autoFix, null);
});

test("classify assigns known categories/risk levels from the rule table", () => {
  const f = makeFinding({
    type: "duplicate-title",
    summary: "dup",
    pages: ["a.html", "b.html"],
    evidence: [{ field: "title", value: "Same Title" }],
  });
  const classified = classify(f);
  assert.strictEqual(classified.category, "D");
  assert.strictEqual(classified.riskLevel, "high");
  assert.strictEqual(classified.autoApplyEligible, false);
});

test("classify fails safe (category E) for an unrecognized finding type", () => {
  const f = makeFinding({
    type: "totally-unknown-type",
    summary: "mystery",
    pages: ["a.html"],
    evidence: [{ x: 1 }],
  });
  const classified = classify(f);
  assert.strictEqual(classified.category, "E");
  assert.strictEqual(classified.autoApplyEligible, false);
});

test("autoApplyEligible is true only when risk is low AND an autoFix is present", () => {
  const withFixLowRisk = classify(
    makeFinding({
      type: "redirect-hop-internal-link",
      summary: "hop",
      pages: ["a.html"],
      evidence: [{ x: 1 }],
      autoFix: { kind: "rewrite-href", file: "a.html", from: "/x", to: "/y" },
    })
  );
  assert.strictEqual(withFixLowRisk.autoApplyEligible, true);

  const noFixLowRisk = classify(
    makeFinding({
      type: "redirect-hop-internal-link",
      summary: "hop, no fix computed",
      pages: ["a.html"],
      evidence: [{ x: 1 }],
    })
  );
  assert.strictEqual(noFixLowRisk.autoApplyEligible, false);

  const withFixMediumRisk = classify(
    makeFinding({
      type: "broken-internal-link",
      summary: "broken",
      pages: ["a.html"],
      evidence: [{ x: 1 }],
      autoFix: { kind: "rewrite-href", file: "a.html", from: "/x", to: "/y" },
    })
  );
  assert.strictEqual(withFixMediumRisk.autoApplyEligible, false, "medium risk must never auto-apply even with a fix present");
});

test("classifyAll preserves order and count", () => {
  const findings = [
    makeFinding({ type: "missing-h1", summary: "a", pages: ["a.html"], evidence: [{ x: 1 }] }),
    makeFinding({ type: "missing-canonical", summary: "b", pages: ["b.html"], evidence: [{ x: 1 }] }),
  ];
  const out = classifyAll(findings);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].type, "missing-h1");
  assert.strictEqual(out[1].type, "missing-canonical");
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
