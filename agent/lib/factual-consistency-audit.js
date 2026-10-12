// Site Improvement Agent — factual-consistency audit.
//
// Looks for CONTRADICTIONS in business facts repeated across multiple
// pages — not merely different wording, which can be entirely
// intentional (see the product spec's explicit caution on this). Checks:
//
//   - phone number (tel: links) — every page should show the same one.
//   - business-identity JSON-LD (name, telephone, priceRange, areaServed)
//     — compared only across pages where this block is meant to carry
//     real meaning (utility pages like privacy-policy.html are excluded,
//     since a thinner/absent business block there isn't a contradiction,
//     it's just a different kind of page).
//
// Both are genuine CONTRADICTIONS when they differ (the same fact stated
// two different ways), not a style/wording difference, so both are
// actionable (see risk.js) rather than routed through research — no
// external evidence could change whether two pages agree with each
// other.

const { makeFinding } = require("./findings");
const { isUtilityPage } = require("./page-groups");

function findBusinessBlock(jsonLd) {
  for (const block of jsonLd || []) {
    const graph = block["@graph"];
    const nodes = Array.isArray(graph) ? graph : [block];
    const biz = nodes.find((n) => [].concat(n["@type"] || []).includes("HomeAndConstructionBusiness"));
    if (biz) return biz;
  }
  return null;
}

function auditFactualConsistency(pages) {
  const findings = [];

  // --- Phone number consistency -----------------------------------
  const phoneGroups = new Map(); // phone -> [files]
  for (const page of pages) {
    for (const tel of page.telLinks || []) {
      const files = phoneGroups.get(tel) || [];
      files.push(page.file);
      phoneGroups.set(tel, files);
    }
  }
  if (phoneGroups.size > 1) {
    const summary = [...phoneGroups.entries()].map(([tel, files]) => `${tel} (${files.length} page(s))`).join(" vs. ");
    findings.push(
      makeFinding({
        type: "inconsistent-contact-info",
        summary: `More than one phone number appears across the site's tel: links: ${summary}.`,
        pages: [...phoneGroups.values()].flat(),
        evidence: [...phoneGroups.entries()].map(([tel, files]) => ({ field: "telLink", value: tel, pages: files })),
        recommendation: `Confirm which phone number is correct and update every page that shows the other one.`,
      })
    );
  }

  // --- Business-identity JSON-LD consistency ----------------------
  const comparablePages = pages.filter((p) => !isUtilityPage(p.file));
  const identityGroups = new Map(); // serialized identity -> [files]
  for (const page of comparablePages) {
    const biz = findBusinessBlock(page.jsonLd);
    if (!biz) continue;
    const identity = {
      name: biz.name || null,
      telephone: biz.telephone || null,
      priceRange: biz.priceRange || null,
      areaServed: (biz.areaServed || []).map((a) => a.name).sort(),
    };
    const key = JSON.stringify(identity);
    const files = identityGroups.get(key) || [];
    files.push(page.file);
    identityGroups.set(key, files);
  }
  if (identityGroups.size > 1) {
    // Only worth flagging as a contradiction if there's a real majority
    // shape most pages agree on and at least one page disagrees with it
    // — otherwise this is just "every page differs slightly," which is
    // a weaker signal and more likely a template-evolution artifact than
    // a contradiction worth a confident claim about.
    const sorted = [...identityGroups.entries()].sort((a, b) => b[1].length - a[1].length);
    const [majorityKey, majorityFiles] = sorted[0];
    for (const [key, files] of sorted.slice(1)) {
      findings.push(
        makeFinding({
          type: "factual-contradiction",
          summary: `${files.join(", ")} carries different business-identity structured data (name/phone/priceRange/areaServed) than the ${majorityFiles.length} pages that agree with each other.`,
          pages: files,
          evidence: [
            { field: "majorityIdentity", value: JSON.parse(majorityKey), pageCount: majorityFiles.length },
            { field: "differingIdentity", value: JSON.parse(key), pages: files },
          ],
          recommendation: `Confirm whether this difference is intentional; if not, align ${files.join(", ")}'s structured data with the rest of the site.`,
        })
      );
    }
  }

  return findings;
}

module.exports = { auditFactualConsistency, findBusinessBlock };
