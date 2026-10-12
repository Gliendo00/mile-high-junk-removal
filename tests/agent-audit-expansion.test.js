// Site Improvement Agent, Phase 3 — tests for the six new audit modules
// (internal-linking, cannibalization, content-gap, coverage, ux,
// factual-consistency). Synthetic PageRecord fixtures, same isolation
// convention as tests/agent-seo-and-consistency-audit.test.js, so these
// are tested independently of whatever the real site happens to contain
// today (which the real dry run — see agent/README.md — already covers).
//
// Run with:  node tests/agent-audit-expansion.test.js

const assert = require("assert");
const { auditInternalLinking, normalizeTarget } = require("../agent/lib/internal-linking-audit");
const { auditCannibalization, jaccard } = require("../agent/lib/cannibalization-audit");
const { auditContentGaps, faqQuestionCount } = require("../agent/lib/content-gap-audit");
const { auditCoverage } = require("../agent/lib/coverage-audit");
const { auditUx, hasContextualBookingLink } = require("../agent/lib/ux-audit");
const { auditFactualConsistency, findBusinessBlock } = require("../agent/lib/factual-consistency-audit");
const { SERVICE_PAGE_FILES } = require("../agent/lib/page-groups");

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
    title: "A Perfectly Reasonable Title",
    metaDescription: "A perfectly reasonable, sufficiently long meta description for this sample page.",
    canonical: "https://www.milehighjunkremoval.net/sample.html",
    h1s: ["A Perfectly Reasonable Heading"],
    jsonLd: [{ "@type": "WebPage" }],
    internalLinks: [],
    contextualInternalLinks: [],
    telLinks: ["3039901812"],
    wordCount: 900,
    mtime: new Date().toISOString(),
    bytes: 1000,
    ...overrides,
  };
}

// -----------------------------------------------------------------------
// internal-linking-audit.js
// -----------------------------------------------------------------------
test("normalizeTarget strips leading slash/query/hash and maps '/' to index.html", () => {
  assert.strictEqual(normalizeTarget("/foo.html?x=1#y"), "foo.html");
  assert.strictEqual(normalizeTarget("/"), "index.html");
});

test("weak-internal-support fires for a page with few contextual inbound links (observation-tier type)", () => {
  const pages = [
    page({ file: "hub.html", contextualInternalLinks: [] }), // nobody links to hub either, but we only assert on orphan.html below
    page({ file: "orphan.html", contextualInternalLinks: [] }),
  ];
  const findings = auditInternalLinking(pages);
  assert.ok(findings.some((f) => f.type === "weak-internal-support" && f.pages.includes("orphan.html")));
});

test("weak-internal-support does NOT fire for index.html regardless of inbound count", () => {
  const pages = [page({ file: "index.html", contextualInternalLinks: [] }), page({ file: "other.html", contextualInternalLinks: [] })];
  const findings = auditInternalLinking(pages);
  assert.ok(!findings.some((f) => f.type === "weak-internal-support" && f.pages.includes("index.html")));
});

test("missing-contextual-link fires for a city page with zero contextual link to any service page", () => {
  const pages = [
    page({ file: "denver-junk-removal.html", contextualInternalLinks: ["/about.html"] }),
    page({ file: "aurora-junk-removal.html", contextualInternalLinks: [SERVICE_PAGE_FILES[0]] }),
  ];
  const findings = auditInternalLinking(pages);
  assert.ok(findings.some((f) => f.type === "missing-contextual-link" && f.pages.includes("denver-junk-removal.html")));
  assert.ok(!findings.some((f) => f.type === "missing-contextual-link" && f.pages.includes("aurora-junk-removal.html")));
});

// -----------------------------------------------------------------------
// cannibalization-audit.js
// -----------------------------------------------------------------------
test("jaccard similarity is 0 for disjoint text and 1 for identical text", () => {
  assert.strictEqual(jaccard("alpha beta", "gamma delta"), 0);
  assert.strictEqual(jaccard("alpha beta", "alpha beta"), 1);
});

test("overlapping-intent requires at least TWO independently-high signals, not just one", () => {
  // Title overlaps heavily, but description/H1 are totally different —
  // only one signal clears the threshold, so this must NOT fire.
  const pages = [
    page({ file: "a.html", title: "Denver Junk Removal Services Today", metaDescription: "Completely different description one.", h1s: ["Totally different heading one"] }),
    page({ file: "b.html", title: "Denver Junk Removal Services Today Too", metaDescription: "Something else entirely for page two here.", h1s: ["A different heading altogether"] }),
  ];
  const findings = auditCannibalization(pages);
  assert.deepStrictEqual(findings, []);
});

test("overlapping-intent fires when title AND description (two signals) are both highly similar but not identical", () => {
  const pages = [
    page({
      file: "a.html",
      title: "Denver Junk Removal Hauling Services Upfront Pricing Fast Same Day",
      metaDescription: "Denver junk removal and hauling services with upfront pricing and fast same day scheduling available",
      h1s: ["Different enough heading one"],
    }),
    page({
      file: "b.html",
      title: "Denver Junk Removal Hauling Services Upfront Pricing Fast Next Day",
      metaDescription: "Denver junk removal and hauling services with upfront pricing and fast next day scheduling available",
      h1s: ["A completely unrelated heading two"],
    }),
  ];
  const findings = auditCannibalization(pages);
  assert.ok(findings.some((f) => f.type === "overlapping-intent" && f.pages.includes("a.html") && f.pages.includes("b.html")));
});

test("overlapping-intent never fires for an EXACT title match (that's duplicate-title's job, a stronger category-D finding)", () => {
  const pages = [
    page({ file: "a.html", title: "Exact Same Title Here", metaDescription: "desc one is different enough from desc two to not match on its own.", h1s: ["h1 a"] }),
    page({ file: "b.html", title: "Exact Same Title Here", metaDescription: "desc two is different enough from desc one to not match on its own.", h1s: ["h1 b"] }),
  ];
  const findings = auditCannibalization(pages);
  assert.deepStrictEqual(findings, []);
});

test("auditCannibalization never emits a pair twice", () => {
  const pages = [
    page({ file: "a.html", title: "Same similar title words here", metaDescription: "Same similar description words here too", h1s: ["x"] }),
    page({ file: "b.html", title: "Same similar title words there", metaDescription: "Same similar description words there also", h1s: ["y"] }),
    page({ file: "c.html", title: "completely unrelated", metaDescription: "nothing matching", h1s: ["z"] }),
  ];
  const findings = auditCannibalization(pages);
  const pairs = findings.map((f) => f.pages.slice().sort().join("::"));
  assert.strictEqual(pairs.length, new Set(pairs).size);
});

// -----------------------------------------------------------------------
// content-gap-audit.js
// -----------------------------------------------------------------------
function faqPage(file, questionCount, cityLike) {
  const fileName = cityLike ? `${file}-junk-removal.html` : `blog-${file}.html`;
  return page({
    file: fileName,
    jsonLd: [{ "@graph": [{ "@type": "FAQPage", mainEntity: Array.from({ length: questionCount }, (_, i) => ({ name: `Q${i}` })) }] }],
  });
}

test("faqQuestionCount reads mainEntity length from an @graph-nested FAQPage", () => {
  assert.strictEqual(faqQuestionCount(faqPage("denver", 5, true)), 5);
});

test("content-gap fires for a page well below its comparable siblings' FAQ-question average", () => {
  const pages = [faqPage("spring-cleaning", 6, false), faqPage("garage-cleanout", 6, false), faqPage("thin-topic", 1, false)];
  const findings = auditContentGaps(pages);
  assert.ok(findings.some((f) => f.type === "content-gap" && f.pages.includes("blog-thin-topic.html")));
});

test("content-gap does NOT fire when every comparable page has a similar FAQ-question count", () => {
  const pages = [faqPage("a", 3, false), faqPage("b", 4, false), faqPage("c", 3, false)];
  const findings = auditContentGaps(pages);
  assert.deepStrictEqual(findings, []);
});

test("content-gap is never computed from fewer than 2 pages that actually have an FAQ", () => {
  const pages = [faqPage("only-one", 1, false)];
  const findings = auditContentGaps(pages);
  assert.deepStrictEqual(findings, []);
});

// -----------------------------------------------------------------------
// coverage-audit.js
// -----------------------------------------------------------------------
test("coverage-gap-candidate fires only when a service is a clear majority pattern AND missing from a specific city page", () => {
  const svc = SERVICE_PAGE_FILES[0];
  const pages = [
    page({ file: "denver-junk-removal.html", contextualInternalLinks: [svc] }),
    page({ file: "aurora-junk-removal.html", contextualInternalLinks: [svc] }),
    page({ file: "parker-junk-removal.html", contextualInternalLinks: [svc] }),
    page({ file: "littleton-junk-removal.html", contextualInternalLinks: [] }), // the odd one out
  ];
  const findings = auditCoverage(pages);
  assert.ok(findings.some((f) => f.type === "coverage-gap-candidate" && f.pages.includes("littleton-junk-removal.html")));
});

test("coverage-gap-candidate never fires when a service isn't already a majority pattern (avoids 'every service everywhere')", () => {
  const svc = SERVICE_PAGE_FILES[0];
  const pages = [
    page({ file: "denver-junk-removal.html", contextualInternalLinks: [] }),
    page({ file: "aurora-junk-removal.html", contextualInternalLinks: [] }),
    page({ file: "parker-junk-removal.html", contextualInternalLinks: [svc] }), // only 1 of 3 — not a majority
  ];
  const findings = auditCoverage(pages);
  assert.deepStrictEqual(findings, []);
});

// -----------------------------------------------------------------------
// ux-audit.js
// -----------------------------------------------------------------------
test("hasContextualBookingLink recognizes a /book/ link regardless of leading slash", () => {
  assert.strictEqual(hasContextualBookingLink(page({ contextualInternalLinks: ["/book/"] })), true);
  assert.strictEqual(hasContextualBookingLink(page({ contextualInternalLinks: ["/about.html"] })), false);
});

test("weak-cta fires for a page with no contextual booking link; no-next-action additionally fires if it's also thin", () => {
  const thinNoBooking = page({ file: "thin.html", contextualInternalLinks: [], wordCount: 100 });
  const findings = auditUx([thinNoBooking]);
  assert.ok(findings.some((f) => f.type === "weak-cta" && f.pages.includes("thin.html")));
  assert.ok(findings.some((f) => f.type === "no-next-action" && f.pages.includes("thin.html")));
});

test("weak-cta/no-next-action never fire for a utility page (e.g. privacy-policy.html) by design", () => {
  const findings = auditUx([page({ file: "privacy-policy.html", contextualInternalLinks: [], wordCount: 50 })]);
  assert.deepStrictEqual(findings, []);
});

test("neither weak-cta nor no-next-action fire for a normal page with a booking link", () => {
  const findings = auditUx([page({ file: "normal.html", contextualInternalLinks: ["/book/"], wordCount: 100 })]);
  assert.deepStrictEqual(findings, []);
});

// -----------------------------------------------------------------------
// factual-consistency-audit.js
// -----------------------------------------------------------------------
test("findBusinessBlock finds a HomeAndConstructionBusiness node nested inside @graph", () => {
  const biz = findBusinessBlock([{ "@graph": [{ "@type": "HomeAndConstructionBusiness", name: "X" }] }]);
  assert.strictEqual(biz.name, "X");
});

test("inconsistent-contact-info fires when two different phone numbers appear across pages", () => {
  const pages = [page({ file: "a.html", telLinks: ["3039901812"] }), page({ file: "b.html", telLinks: ["3035551234"] })];
  const findings = auditFactualConsistency(pages);
  assert.ok(findings.some((f) => f.type === "inconsistent-contact-info"));
});

test("no inconsistent-contact-info finding when every page shows the same phone number", () => {
  const pages = [page({ file: "a.html", telLinks: ["3039901812"] }), page({ file: "b.html", telLinks: ["3039901812"] })];
  const findings = auditFactualConsistency(pages);
  assert.ok(!findings.some((f) => f.type === "inconsistent-contact-info"));
});

test("factual-contradiction fires when a page's business-identity JSON-LD disagrees with the site-wide majority", () => {
  const majorityBiz = { "@graph": [{ "@type": "HomeAndConstructionBusiness", name: "Mile High Junk Removal", telephone: "+13039901812", priceRange: "$100-$600", areaServed: [{ name: "Denver" }] }] };
  const differentBiz = { "@graph": [{ "@type": "HomeAndConstructionBusiness", name: "Mile High Junk Removal", telephone: "+13039901812", priceRange: "$999-$9999", areaServed: [{ name: "Denver" }] }] };
  const pages = [
    page({ file: "a.html", jsonLd: [majorityBiz] }),
    page({ file: "b.html", jsonLd: [majorityBiz] }),
    page({ file: "c.html", jsonLd: [differentBiz] }),
  ];
  const findings = auditFactualConsistency(pages);
  assert.ok(findings.some((f) => f.type === "factual-contradiction" && f.pages.includes("c.html")));
});

test("factual-contradiction excludes utility pages (e.g. privacy-policy.html) from the business-identity comparison", () => {
  const majorityBiz = { "@graph": [{ "@type": "HomeAndConstructionBusiness", name: "Mile High Junk Removal", areaServed: [{ name: "Denver" }] }] };
  const noAreaBiz = { "@graph": [{ "@type": "HomeAndConstructionBusiness", name: "Mile High Junk Removal", areaServed: [] }] };
  const pages = [
    page({ file: "a.html", jsonLd: [majorityBiz] }),
    page({ file: "b.html", jsonLd: [majorityBiz] }),
    page({ file: "privacy-policy.html", jsonLd: [noAreaBiz] }),
  ];
  const findings = auditFactualConsistency(pages);
  assert.ok(!findings.some((f) => f.pages.includes("privacy-policy.html")));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
