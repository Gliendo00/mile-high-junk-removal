// Site Improvement Agent — city/service coverage audit.
//
// Does NOT conclude "every service needs a page for every city" — that
// would be exactly the thin/doorway-page risk the product spec warns
// against. Instead, this identifies only combinations where the SITE'S
// OWN existing pattern suggests there may be a legitimate reason to look
// closer: a service that the site itself already contextually promotes
// on most of its city pages, but happens to be contextually absent from
// a few specific ones. That's evidence worth researching (is this
// specific city's market actually different, or is it just an
// oversight?) — never evidence enough to act on by itself, so this
// always routes to RESEARCH_MORE (category C).

const { makeFinding } = require("./findings");
const { isCityPage, SERVICE_PAGE_FILES } = require("./page-groups");
const { normalizeTarget } = require("./internal-linking-audit");

// A service must already be contextually promoted on at least this
// fraction of ALL city pages before its absence from a specific one is
// even worth raising — otherwise this is just "most city pages don't
// mention X," which is normal, not a gap.
const MAJORITY_THRESHOLD = 0.7;

function auditCoverage(pages) {
  const findings = [];
  const cityPages = pages.filter((p) => isCityPage(p.file));
  if (cityPages.length < 3) return findings; // too small a sample to call anything a site-wide "pattern"

  for (const serviceFile of SERVICE_PAGE_FILES) {
    const citiesLinkingToService = cityPages.filter((p) =>
      (p.contextualInternalLinks || []).map(normalizeTarget).includes(serviceFile)
    );
    const fraction = citiesLinkingToService.length / cityPages.length;
    if (fraction < MAJORITY_THRESHOLD) continue; // not a strong enough site-wide pattern to compare against

    const missingCities = cityPages.filter((p) => !citiesLinkingToService.includes(p));
    for (const page of missingCities) {
      findings.push(
        makeFinding({
          type: "coverage-gap-candidate",
          summary: `${serviceFile} is contextually promoted on ${citiesLinkingToService.length} of ${cityPages.length} city pages, but not on ${page.file}.`,
          pages: [page.file],
          evidence: [
            { field: "serviceFile", value: serviceFile },
            { field: "citiesPromotingService", value: citiesLinkingToService.map((p) => p.file) },
            { field: "fraction", value: Math.round(fraction * 100) / 100 },
          ],
          recommendation: `Research whether ${serviceFile.replace(".html", "").replace(/-/g, " ")} is genuinely relevant to ${page.file}'s market before considering a contextual mention — this is a site-pattern observation, not evidence of real local demand.`,
        })
      );
    }
  }

  return findings;
}

module.exports = { auditCoverage, MAJORITY_THRESHOLD };
