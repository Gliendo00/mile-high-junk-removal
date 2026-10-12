// Site Improvement Agent — cross-page structural consistency audit.
//
// This is the one module that emits category-C ("content opportunity
// requiring research") findings. It never invents content — it only
// compares structural facts already present across a group of clearly-
// related pages and flags outliers. Whether an outlier is actually worth
// fixing, and what to write, is left to a research-backed decision
// (agent/lib/decision.js, informed by agent/lib/research.js) — these
// findings exist to point at *where* that research would be useful, not
// to perform it themselves.

const { makeFinding } = require("./findings");

// Phase 2 fix: this used to be the filename pattern /-junk-removal\.html$/,
// which also matched several pages that are NOT city/location pages —
// commercial-junk-removal.html, office-junk-removal.html,
// hoa-junk-removal.html, contractor-remodeler-junk-removal.html,
// property-management-junk-removal.html, same-day-junk-removal.html are
// all service-type pages that happen to share the city pages' filename
// suffix. Comparing those against true city pages for FAQ/word-count
// "consistency" would have been comparing two different kinds of page.
// This explicit slug list is the actual set of Denver-metro city/location
// pages (matches vercel.json's /service-areas/* legacy redirects and the
// @graph areaServed list every page's JSON-LD already carries).
const CITY_SLUGS = [
  "denver", "aurora", "lakewood", "westminster", "broomfield", "arvada",
  "castle-rock", "thornton", "littleton", "englewood", "parker",
  "highlands-ranch", "centennial",
];
const CITY_PAGE_RE = new RegExp(`^(${CITY_SLUGS.join("|")})-junk-removal\\.html$`);

const BLOG_PAGE_RE = /^blog-.+\.html$/; // excludes blog.html itself (the index)

function hasFaqSchema(page) {
  return page.jsonLd.some((block) => {
    const types = [].concat(block["@type"] || []);
    if (types.includes("FAQPage")) return true;
    const graph = block["@graph"];
    if (Array.isArray(graph)) {
      return graph.some((node) => [].concat(node["@type"] || []).includes("FAQPage"));
    }
    return false;
  });
}

// Shared logic for any group of pages that are genuinely comparable to
// each other (true city pages, or blog posts) — flags a page lacking FAQ
// schema when it's the norm among its siblings, and a page far thinner
// than its siblings' average.
function auditGroup(groupPages, groupLabel) {
  const findings = [];
  if (groupPages.length < 2) return findings;

  const withFaq = groupPages.filter(hasFaqSchema);
  const withoutFaq = groupPages.filter((p) => !hasFaqSchema(p));

  if (withFaq.length >= groupPages.length / 2 && withoutFaq.length > 0) {
    for (const page of withoutFaq) {
      findings.push(
        makeFinding({
          type: "structural-inconsistency",
          summary: `${page.file} has no FAQPage structured data, unlike ${withFaq.length} of ${groupPages.length} comparable ${groupLabel}.`,
          pages: [page.file],
          evidence: [
            { field: "hasFaqSchema", value: false, file: page.file },
            { field: `comparable${groupLabel}WithFaq`, value: withFaq.map((p) => p.file) },
          ],
          recommendation: `Research whether ${page.file} should have an FAQ section matching its sibling ${groupLabel}, and what questions would be genuinely useful there.`,
        })
      );
    }
  }

  const wordCounts = groupPages.map((p) => p.wordCount);
  const avg = wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length;
  for (const page of groupPages) {
    if (page.wordCount < avg * 0.5) {
      findings.push(
        makeFinding({
          type: "structural-inconsistency",
          summary: `${page.file} has ${page.wordCount} words, well below the ${Math.round(avg)}-word average of its ${groupPages.length} comparable ${groupLabel}.`,
          pages: [page.file],
          evidence: [
            { field: "wordCount", value: page.wordCount, file: page.file },
            { field: "comparableAverage", value: Math.round(avg) },
          ],
          recommendation: `Research whether ${page.file} is thin relative to its siblings and would benefit from genuine, locally-specific expansion.`,
        })
      );
    }
  }

  return findings;
}

function auditConsistency(pages) {
  const cityPages = pages.filter((p) => CITY_PAGE_RE.test(p.file));
  const blogPages = pages.filter((p) => BLOG_PAGE_RE.test(p.file));
  return [
    ...auditGroup(cityPages, "city pages"),
    ...auditGroup(blogPages, "blog posts"),
  ];
}

module.exports = { auditConsistency, hasFaqSchema, CITY_SLUGS, CITY_PAGE_RE, BLOG_PAGE_RE };
