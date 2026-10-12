// Site Improvement Agent — cross-page structural consistency audit.
//
// This is the one module that emits category-C ("content opportunity
// requiring research") findings in Phase 1. It never invents content —
// it only compares structural facts already present across a group of
// clearly-related pages (e.g. the city/location pages) and flags outliers.
// Whether an outlier is actually worth fixing, and what to write, is left
// to a research-backed decision (human, or a future web-research-enabled
// run) — these findings exist to point at *where* that research would be
// useful, not to perform it.

const { makeFinding } = require("./findings");

const CITY_PAGE_RE = /-junk-removal\.html$/;

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

function auditConsistency(pages) {
  const findings = [];
  const cityPages = pages.filter((p) => CITY_PAGE_RE.test(p.file));
  if (cityPages.length < 2) return findings;

  const withFaq = cityPages.filter(hasFaqSchema);
  const withoutFaq = cityPages.filter((p) => !hasFaqSchema(p));

  // Only flag an outlier if FAQ schema is the norm (majority), not the
  // exception — otherwise there is no "inconsistency," just a format the
  // site hasn't adopted yet.
  if (withFaq.length >= cityPages.length / 2 && withoutFaq.length > 0) {
    for (const page of withoutFaq) {
      findings.push(
        makeFinding({
          type: "structural-inconsistency",
          summary: `${page.file} has no FAQPage structured data, unlike ${withFaq.length} of ${cityPages.length} comparable city pages.`,
          pages: [page.file],
          evidence: [
            { field: "hasFaqSchema", value: false, file: page.file },
            { field: "comparableCityPagesWithFaq", value: withFaq.map((p) => p.file) },
          ],
          recommendation: `Research whether ${page.file} should have an FAQ section matching its sibling city pages, and what questions would be genuinely useful there.`,
        })
      );
    }
  }

  const wordCounts = cityPages.map((p) => p.wordCount);
  const avg = wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length;
  for (const page of cityPages) {
    if (page.wordCount < avg * 0.5) {
      findings.push(
        makeFinding({
          type: "structural-inconsistency",
          summary: `${page.file} has ${page.wordCount} words, well below the ${Math.round(avg)}-word average of its ${cityPages.length} comparable city pages.`,
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

module.exports = { auditConsistency, hasFaqSchema };
