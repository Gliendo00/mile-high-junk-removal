// Site Improvement Agent, Phase 12 — tests for
// agent/lib/firstparty-sufficiency.js: the centralized, discrete
// minimum-data-sufficiency classifier (no numeric confidence score).
//
// Run with:  node tests/agent-firstparty-sufficiency.test.js

const assert = require("assert");
const { SUFFICIENCY_LEVELS, SUFFICIENCY_THRESHOLDS, classifySufficiency } = require("../agent/lib/firstparty-sufficiency");

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

test("SUFFICIENCY_LEVELS is exactly the three discrete named buckets — never a numeric score", () => {
  assert.deepStrictEqual(SUFFICIENCY_LEVELS, ["insufficient", "limited", "sufficient"]);
});

test("classifySufficiency() throws on an unknown metric family — never silently falls back to a guessed threshold", () => {
  assert.throws(() => classifySufficiency(100, "totally-made-up-family"), /unknown metric family/);
});

test("classifySufficiency(): below the family's own 'insufficient' threshold returns 'insufficient'", () => {
  const t = SUFFICIENCY_THRESHOLDS["gsc-impressions"];
  assert.strictEqual(classifySufficiency(t.insufficient - 1, "gsc-impressions"), "insufficient");
  assert.strictEqual(classifySufficiency(0, "gsc-impressions"), "insufficient");
});

test("classifySufficiency(): between the two thresholds returns 'limited'", () => {
  const t = SUFFICIENCY_THRESHOLDS["gsc-impressions"];
  assert.strictEqual(classifySufficiency(t.insufficient, "gsc-impressions"), "limited");
  assert.strictEqual(classifySufficiency(t.limited - 1, "gsc-impressions"), "limited");
});

test("classifySufficiency(): at or above the 'limited' threshold returns 'sufficient'", () => {
  const t = SUFFICIENCY_THRESHOLDS["gsc-impressions"];
  assert.strictEqual(classifySufficiency(t.limited, "gsc-impressions"), "sufficient");
  assert.strictEqual(classifySufficiency(t.limited + 1000, "gsc-impressions"), "sufficient");
});

test("classifySufficiency() works identically for the ga4-sessions family (a second, independently-documented threshold pair)", () => {
  const t = SUFFICIENCY_THRESHOLDS["ga4-sessions"];
  assert.strictEqual(classifySufficiency(0, "ga4-sessions"), "insufficient");
  assert.strictEqual(classifySufficiency(t.insufficient, "ga4-sessions"), "limited");
  assert.strictEqual(classifySufficiency(t.limited, "ga4-sessions"), "sufficient");
});

test("classifySufficiency() treats a non-numeric/NaN value as 0 (insufficient), never throws on bad input", () => {
  assert.strictEqual(classifySufficiency(NaN, "gsc-impressions"), "insufficient");
  assert.strictEqual(classifySufficiency(undefined, "gsc-impressions"), "insufficient");
});

test("thresholds are centralized in exactly one exported map (easy to inspect/change) — not duplicated constants scattered per caller", () => {
  assert.ok(typeof SUFFICIENCY_THRESHOLDS === "object");
  assert.ok(SUFFICIENCY_THRESHOLDS["gsc-impressions"].insufficient < SUFFICIENCY_THRESHOLDS["gsc-impressions"].limited);
  assert.ok(SUFFICIENCY_THRESHOLDS["ga4-sessions"].insufficient < SUFFICIENCY_THRESHOLDS["ga4-sessions"].limited);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
