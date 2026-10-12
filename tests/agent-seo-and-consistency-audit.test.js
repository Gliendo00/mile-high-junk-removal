// Site Improvement Agent — unit tests for seo-audit.js and
// consistency-audit.js, using synthetic PageRecord fixtures so these
// modules' logic is tested in isolation from the real site content.
//
// Run with:  node tests/agent-seo-and-consistency-audit.test.js

const assert = require("assert");
const { auditSeo } = require("../agent/lib/seo-audit");
const { auditConsistency, hasFaqSchema } = require("../agent/lib/consistency-audit");

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

function page(overrides) {
  return {
    file: "sample.html",
    url: "https://www.milehighjunkremoval.net/sample.html",
    title: "A Perfectly Reasonable Title For SEO",
    metaDescription: "A perfectly reasonable meta description that falls comfortably inside the recommended length window for search engines.",
    canonical: "https://www.milehighjunkremoval.net/sample.html",
    h1s: ["A Perfectly Reasonable Heading"],
    jsonLd: [{ "@type": "WebPage" }],
    internalLinks: [],
    wordCount: 900,
    mtime: new Date().toISOString(),
    bytes: 1000,
    ...overrides,
  };
}

test("a fully well-formed page produces zero findings (no false positives)", () => {
  const findings = auditSeo([page({})]);
  assert.deepStrictEqual(findings, []);
});

test("missing title/description/canonical/h1/schema are each flagged once", () => {
  const findings = auditSeo([
    page({ title: null, metaDescription: null, canonical: null, h1s: [], jsonLd: [] }),
  ]);
  const types = findings.map((f) => f.type).sort();
  assert.deepStrictEqual(types, [
    "missing-canonical",
    "missing-h1",
    "missing-json-ld",
    "missing-meta-description",
    "missing-title",
  ]);
});

test("title and description length outliers are flagged (observation-tier — see risk.js)", () => {
  const findings = auditSeo([page({ title: "Hi", metaDescription: "Short." })]);
  const types = findings.map((f) => f.type);
  assert.ok(types.includes("title-length"));
  assert.ok(types.includes("description-length"));
  // Never ALSO escalated to -malformed for a merely-short-but-real value.
  assert.ok(!types.includes("title-malformed"));
  assert.ok(!types.includes("description-malformed"));
});

test("Phase 3: a placeholder-looking title/description escalates to -malformed, not a mere -length observation", () => {
  const findings = auditSeo([page({ title: "Untitled", metaDescription: "Lorem ipsum dolor sit amet" })]);
  const types = findings.map((f) => f.type);
  assert.ok(types.includes("title-malformed"));
  assert.ok(types.includes("description-malformed"));
  assert.ok(!types.includes("title-length"));
  assert.ok(!types.includes("description-length"));
});

test("Phase 3: a severely-over-length title/description escalates to -malformed", () => {
  const veryLongTitle = "A".repeat(95);
  const veryLongDesc = "B".repeat(225);
  const findings = auditSeo([page({ title: veryLongTitle, metaDescription: veryLongDesc })]);
  const types = findings.map((f) => f.type);
  assert.ok(types.includes("title-malformed"));
  assert.ok(types.includes("description-malformed"));
});

test("Phase 3: a real, specific title that's merely a BIT over the max is NOT escalated (stays an observation)", () => {
  // 71 chars — the actual real-site example that originally triggered this fix.
  const realisticTitle = "Furniture Donation Guide: Where to Donate & What's Accepted | MHJR";
  const findings = auditSeo([page({ title: realisticTitle })]);
  assert.ok(realisticTitle.length > 65 && realisticTitle.length < 90, "fixture must actually be in the mild-overage range for this test to be meaningful");
  const types = findings.map((f) => f.type);
  assert.ok(types.includes("title-length"));
  assert.ok(!types.includes("title-malformed"));
});

test("canonical mismatch is flagged when it points at a different URL", () => {
  const findings = auditSeo([page({ canonical: "https://www.milehighjunkremoval.net/other.html" })]);
  assert.ok(findings.some((f) => f.type === "canonical-mismatch"));
});

test("multiple h1s are flagged", () => {
  const findings = auditSeo([page({ h1s: ["One", "Two"] })]);
  assert.ok(findings.some((f) => f.type === "multiple-h1"));
});

test("duplicate titles across pages are flagged with every owning page listed", () => {
  const findings = auditSeo([
    page({ file: "a.html", title: "Same Title Everywhere Oddly" }),
    page({ file: "b.html", title: "Same Title Everywhere Oddly" }),
  ]);
  const dup = findings.find((f) => f.type === "duplicate-title");
  assert.ok(dup);
  assert.deepStrictEqual(dup.pages.sort(), ["a.html", "b.html"]);
});

test("duplicate meta descriptions across pages are flagged", () => {
  const sameDesc = "This exact description text appears on more than one page, which is a problem.";
  const findings = auditSeo([
    page({ file: "a.html", metaDescription: sameDesc }),
    page({ file: "b.html", metaDescription: sameDesc }),
  ]);
  assert.ok(findings.some((f) => f.type === "duplicate-meta-description"));
});

test("consistency audit: no finding when fewer than 2 city pages", () => {
  const findings = auditConsistency([page({ file: "denver-junk-removal.html" })]);
  assert.deepStrictEqual(findings, []);
});

test("consistency audit: flags a city page missing FAQ schema when siblings have it", () => {
  const withFaq = (file) =>
    page({ file, jsonLd: [{ "@graph": [{ "@type": "FAQPage" }] }] });
  const pages = [
    withFaq("denver-junk-removal.html"),
    withFaq("aurora-junk-removal.html"),
    page({ file: "parker-junk-removal.html", jsonLd: [{ "@type": "WebPage" }] }),
  ];
  const findings = auditConsistency(pages);
  const faqFinding = findings.find(
    (f) => f.type === "structural-inconsistency" && f.pages[0] === "parker-junk-removal.html"
  );
  assert.ok(faqFinding, "expected an outlier finding for the page missing FAQ schema");
});

test("consistency audit: does NOT flag FAQ absence when it isn't the norm", () => {
  const pages = [
    page({ file: "denver-junk-removal.html", jsonLd: [{ "@type": "WebPage" }] }),
    page({ file: "aurora-junk-removal.html", jsonLd: [{ "@type": "WebPage" }] }),
    page({ file: "parker-junk-removal.html", jsonLd: [{ "@graph": [{ "@type": "FAQPage" }] }] }),
  ];
  const findings = auditConsistency(pages);
  assert.ok(!findings.some((f) => f.summary.includes("FAQPage")));
});

test("consistency audit: flags a city page far below the sibling word-count average", () => {
  const pages = [
    page({ file: "denver-junk-removal.html", wordCount: 1200 }),
    page({ file: "aurora-junk-removal.html", wordCount: 1100 }),
    page({ file: "parker-junk-removal.html", wordCount: 200 }),
  ];
  const findings = auditConsistency(pages);
  assert.ok(
    findings.some((f) => f.type === "structural-inconsistency" && f.pages[0] === "parker-junk-removal.html" && f.summary.includes("words"))
  );
});

test("hasFaqSchema recognizes both top-level @type and @graph-nested FAQPage", () => {
  assert.strictEqual(hasFaqSchema(page({ jsonLd: [{ "@type": "FAQPage" }] })), true);
  assert.strictEqual(hasFaqSchema(page({ jsonLd: [{ "@graph": [{ "@type": "FAQPage" }] }] })), true);
  assert.strictEqual(hasFaqSchema(page({ jsonLd: [{ "@type": "WebPage" }] })), false);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
