// Site Improvement Agent — tests for agent/lib/validate.js, which closes
// the loop on an applied mechanical fix: re-scan, confirm the original
// issue is gone and nothing regressed, and — if it didn't — revert
// automatically using the same mechanical rewrite mechanism, rather than
// pretending the fix succeeded.
//
// Uses a throwaway fixture file under tests/fixtures/ (cleaned up after),
// never a real site page, and a hand-built `rescannedFindings` array for
// the pure-logic tests (validateAppliedFinding) rather than a real re-scan
// — the real-re-scan path is exercised by validateAndRevertIfNeeded's own
// tests further down, via a stub rescanFn.
//
// Run with:  node tests/agent-validate.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const config = require("../agent/config");
const { makeFinding } = require("../agent/lib/findings");
const rewriteHref = require("../agent/lib/apply/rewrite-href");
const { validateAppliedFinding, validateAndRevertIfNeeded } = require("../agent/lib/validate");

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

const FIXTURE_REL = "tests/fixtures/agent-validate-fixture.html";
const FIXTURE_ABS = path.join(config.SITE_ROOT, FIXTURE_REL);

function writeFixture(html) {
  fs.mkdirSync(path.dirname(FIXTURE_ABS), { recursive: true });
  fs.writeFileSync(FIXTURE_ABS, html, "utf8");
}
function cleanup() {
  if (fs.existsSync(FIXTURE_ABS)) fs.unlinkSync(FIXTURE_ABS);
}

function appliedFinding(overrides) {
  return {
    ...makeFinding({
      type: "redirect-hop-internal-link",
      summary: "hop",
      pages: [FIXTURE_REL],
      evidence: [{ x: 1 }],
      autoFix: { kind: "rewrite-href", file: FIXTURE_REL, from: "/service-areas/denver-co", to: "/denver-junk-removal.html" },
    }),
    status: "applied",
    ...overrides,
  };
}

try {
  test("validateAppliedFinding: confirmed-resolved when re-scan shows no trace of the old or new href as an issue", () => {
    const finding = appliedFinding();
    const rescanned = []; // nothing wrong found anywhere
    const result = validateAppliedFinding(finding, rescanned);
    assert.strictEqual(result.status, "confirmed-resolved");
  });

  test("validateAppliedFinding: fix-not-verified when the re-scan still reports the OLD href as an issue on the same page", () => {
    const finding = appliedFinding();
    const rescanned = [
      makeFinding({
        type: "broken-internal-link",
        summary: "still broken somehow",
        pages: [FIXTURE_REL],
        evidence: [{ file: FIXTURE_REL, field: "internalLinks", value: "/service-areas/denver-co" }],
      }),
    ];
    const result = validateAppliedFinding(finding, rescanned);
    assert.strictEqual(result.status, "fix-not-verified");
  });

  test("validateAppliedFinding: regression-detected when the NEW href now shows up as broken on the same page", () => {
    const finding = appliedFinding();
    const rescanned = [
      makeFinding({
        type: "broken-internal-link",
        summary: "the new link is somehow broken",
        pages: [FIXTURE_REL],
        evidence: [{ file: FIXTURE_REL, field: "internalLinks", value: "/denver-junk-removal.html" }],
      }),
    ];
    const result = validateAppliedFinding(finding, rescanned);
    assert.strictEqual(result.status, "regression-detected");
  });

  test("validateAppliedFinding: an issue on a DIFFERENT page doesn't false-trigger fix-not-verified/regression", () => {
    const finding = appliedFinding();
    const rescanned = [
      makeFinding({
        type: "broken-internal-link",
        summary: "unrelated issue elsewhere",
        pages: ["some-other-page.html"],
        evidence: [{ file: "some-other-page.html", field: "internalLinks", value: "/service-areas/denver-co" }],
      }),
    ];
    const result = validateAppliedFinding(finding, rescanned);
    assert.strictEqual(result.status, "confirmed-resolved");
  });

  test("validateAndRevertIfNeeded: a confirmed-resolved fix is left in place, not reverted", () => {
    writeFixture('<a href="/denver-junk-removal.html">Denver</a>'); // the fix already applied
    const finding = appliedFinding();
    const result = validateAndRevertIfNeeded([finding], () => []); // rescan finds nothing wrong
    assert.strictEqual(result.confirmed, 1);
    assert.strictEqual(result.reverted, 0);
    assert.strictEqual(finding.status, "applied");
    const content = fs.readFileSync(FIXTURE_ABS, "utf8");
    assert.ok(content.includes('href="/denver-junk-removal.html"'), "the fix must still be in place");
  });

  test("validateAndRevertIfNeeded: a failed validation triggers an automatic, deterministic revert back to the original href", () => {
    writeFixture('<a href="/denver-junk-removal.html">Denver</a>'); // the fix already applied
    const finding = appliedFinding();
    const rescanFn = () => [
      makeFinding({
        type: "broken-internal-link",
        summary: "the new link is somehow broken",
        pages: [FIXTURE_REL],
        evidence: [{ file: FIXTURE_REL, field: "internalLinks", value: "/denver-junk-removal.html" }],
      }),
    ];
    const result = validateAndRevertIfNeeded([finding], rescanFn);
    assert.strictEqual(result.reverted, 1);
    assert.strictEqual(result.confirmed, 0);
    assert.strictEqual(finding.status, "reverted");
    assert.ok(finding.revertResult.changed);
    const content = fs.readFileSync(FIXTURE_ABS, "utf8");
    assert.ok(content.includes('href="/service-areas/denver-co"'), "the file must be back to its original href after an automatic revert");
    assert.ok(!content.includes("/denver-junk-removal.html"));
  });

  test("validateAndRevertIfNeeded: if the revert itself can't proceed deterministically, it marks the finding for review rather than pretending success", () => {
    // Ambiguous on purpose: the "to" href now appears twice, so the
    // revert's own single-unambiguous-occurrence guard must refuse —
    // exactly the same safety property the forward fix has.
    writeFixture('<a href="/denver-junk-removal.html">A</a><a href="/denver-junk-removal.html">B</a>');
    const finding = appliedFinding();
    const rescanFn = () => [
      makeFinding({
        type: "broken-internal-link",
        summary: "broken",
        pages: [FIXTURE_REL],
        evidence: [{ file: FIXTURE_REL, field: "internalLinks", value: "/denver-junk-removal.html" }],
      }),
    ];
    const result = validateAndRevertIfNeeded([finding], rescanFn);
    assert.strictEqual(result.reverted, 0);
    assert.strictEqual(finding.status, "apply-failed-requires-review");
    assert.strictEqual(finding.revertResult.changed, false);
  });

  test("validateAndRevertIfNeeded: zero applied findings is a no-op that never calls rescanFn", () => {
    let called = false;
    const result = validateAndRevertIfNeeded([], () => { called = true; return []; });
    assert.strictEqual(called, false);
    assert.deepStrictEqual(result, { validated: [], reverted: 0, confirmed: 0 });
  });
} finally {
  cleanup();
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
