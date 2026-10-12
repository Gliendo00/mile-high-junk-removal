// Site Improvement Agent — content-gap audit.
//
// Looks for gaps WITHIN existing pages — specifically, a page whose FAQ
// section answers meaningfully fewer practical questions than its
// comparable siblings (consistency-audit.js's FAQ-presence check already
// catches a page with NO FAQ at all; this catches a page that has one,
// but noticeably thinner than its peers — a real, structural signal that
// there may be unanswered practical questions, not a guess about what
// those questions are).
//
// Always routes to RESEARCH_MORE (category C) — per the product spec, a
// content-gap finding should trigger research, never an automatic
// content proposal on its own. This module never writes FAQ copy.

const { makeFinding } = require("./findings");
const { isCityPage, isBlogPage } = require("./page-groups");

function faqQuestionCount(page) {
  let count = 0;
  for (const block of page.jsonLd || []) {
    const graph = block["@graph"];
    const nodes = Array.isArray(graph) ? graph : [block];
    for (const node of nodes) {
      const types = [].concat(node["@type"] || []);
      if (types.includes("FAQPage") && Array.isArray(node.mainEntity)) {
        count += node.mainEntity.length;
      }
    }
  }
  return count;
}

function auditGroupForGaps(groupPages, groupLabel, findings) {
  const counts = groupPages.map((p) => ({ page: p, count: faqQuestionCount(p) }));
  const withFaq = counts.filter((c) => c.count > 0);
  if (withFaq.length < 2) return; // not enough of a group norm to compare against

  const avg = withFaq.reduce((sum, c) => sum + c.count, 0) / withFaq.length;
  for (const { page, count } of withFaq) {
    if (count < avg * 0.5) {
      findings.push(
        makeFinding({
          type: "content-gap",
          summary: `${page.file}'s FAQ answers only ${count} question(s), well below the ${Math.round(avg)}-question average of its comparable ${groupLabel}.`,
          pages: [page.file],
          evidence: [
            { field: "faqQuestionCount", value: count, file: page.file },
            { field: "comparableAverage", value: Math.round(avg) },
          ],
          recommendation: `Research what practical questions a visitor to ${page.file} is likely to have that aren't yet answered there.`,
        })
      );
    }
  }
}

function auditContentGaps(pages) {
  const findings = [];
  auditGroupForGaps(pages.filter((p) => isCityPage(p.file)), "city pages", findings);
  auditGroupForGaps(pages.filter((p) => isBlogPage(p.file)), "blog posts", findings);
  return findings;
}

module.exports = { auditContentGaps, faqQuestionCount };
