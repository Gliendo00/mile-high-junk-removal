// Site Improvement Agent — tests for agent/lib/page-identity.js's
// normalizePageIdentifierForComparison(): the shared helper that lets a
// repo-relative file name (a Finding's own `.pages` entries) be compared
// against whatever a Google API returns for the "same" page (typically a
// fully-qualified URL).
//
// Run with:  node tests/agent-page-identity.test.js

const assert = require("assert");
const { normalizePageIdentifierForComparison } = require("../agent/lib/page-identity");

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

test("a bare repo-relative file name is returned as-is (lowercased)", () => {
  assert.strictEqual(normalizePageIdentifierForComparison("privacy-policy.html"), "privacy-policy.html");
  assert.strictEqual(normalizePageIdentifierForComparison("Furniture-Removal.html"), "furniture-removal.html");
});

test("a fully-qualified URL (any scheme/host) normalizes to its path", () => {
  assert.strictEqual(normalizePageIdentifierForComparison("https://www.milehighjunkremoval.net/privacy-policy.html"), "privacy-policy.html");
  assert.strictEqual(normalizePageIdentifierForComparison("https://milehighjunkremoval.net/privacy-policy.html"), "privacy-policy.html");
  assert.strictEqual(normalizePageIdentifierForComparison("http://www.milehighjunkremoval.net/privacy-policy.html"), "privacy-policy.html");
});

test("leading and trailing slashes are stripped either way", () => {
  assert.strictEqual(normalizePageIdentifierForComparison("/privacy-policy.html"), "privacy-policy.html");
  assert.strictEqual(normalizePageIdentifierForComparison("/privacy-policy.html/"), "privacy-policy.html");
});

test("a root/homepage path (with or without a host) normalizes to \"index.html\", matching this repo's own homepage file-name convention", () => {
  assert.strictEqual(normalizePageIdentifierForComparison("https://www.milehighjunkremoval.net/"), "index.html");
  assert.strictEqual(normalizePageIdentifierForComparison("https://www.milehighjunkremoval.net"), "index.html");
  assert.strictEqual(normalizePageIdentifierForComparison("/"), "index.html");
  assert.strictEqual(normalizePageIdentifierForComparison(""), "");
});

test("empty/non-string input degrades to an empty string rather than throwing", () => {
  assert.strictEqual(normalizePageIdentifierForComparison(""), "");
  assert.strictEqual(normalizePageIdentifierForComparison(null), "");
  assert.strictEqual(normalizePageIdentifierForComparison(undefined), "");
  assert.strictEqual(normalizePageIdentifierForComparison(42), "");
});

test("a malformed string that merely LOOKS like a URL (fails URL parsing) falls back to being treated as a plain path, never throws", () => {
  assert.doesNotThrow(() => normalizePageIdentifierForComparison("http://"));
});

test("www vs apex and http vs https are treated as the SAME page (identity comparison, not canonicalization judgment)", () => {
  const a = normalizePageIdentifierForComparison("https://www.milehighjunkremoval.net/aurora-junk-removal.html");
  const b = normalizePageIdentifierForComparison("http://milehighjunkremoval.net/aurora-junk-removal.html");
  assert.strictEqual(a, b);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
