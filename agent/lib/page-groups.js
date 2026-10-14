// Site Improvement Agent — shared page-group classification.
//
// Several Phase 3 audit modules (internal-linking, content-gap, coverage,
// ux, factual-consistency) need to know "is this a city page / a general
// service page / a utility page with no conversion intent," the same
// distinction consistency-audit.js's Phase 2 correctness fix already
// established for CITY_SLUGS. Single-sourced here instead of each module
// re-deriving (or worse, re-guessing) its own filename pattern.
//
// Phase 5 (daily/weekly operating system): the actual lists below are now
// DERIVED from agent/lib/business-profile.js (backed by agent/context/
// business-profile.json), the one canonical business/service-area config,
// instead of being hardcoded here a second time. The exported names and
// values are unchanged on purpose — every existing audit module keeps
// working exactly as before; only where the data comes from changed.

const businessProfile = require("./business-profile");

const CITY_SLUGS = businessProfile.getCitySlugs();
const CITY_PAGE_RE = new RegExp(`^(${CITY_SLUGS.join("|")})-junk-removal\\.html$`);

const BLOG_PAGE_RE = /^blog-.+\.html$/; // excludes blog.html itself (the index)

// General service-type pages — deliberately excludes the city pages
// above even though several share the "-junk-removal.html" suffix (see
// consistency-audit.js's Phase 2 fix for the bug this caused once
// already), and excludes hoa/commercial/office/contractor-remodeler/
// property-management/same-day, which ARE real service pages but don't
// map to a single tidy "item removed" category the way the ones below do
// — kept to the pages coverage-audit.js can reason about most safely.
const SERVICE_PAGE_FILES = businessProfile.getServicePageFiles();

// Pages with no conversion/booking intent by design (legal, not a
// service/location page) — excluded from CTA-presence and business-
// identity-schema consistency checks, which would otherwise flag a
// non-issue every single run.
const UTILITY_PAGE_FILES = businessProfile.getUtilityPageFiles();

function isCityPage(file) {
  return CITY_PAGE_RE.test(file);
}
function isBlogPage(file) {
  return BLOG_PAGE_RE.test(file);
}
function isServicePage(file) {
  return SERVICE_PAGE_FILES.includes(file);
}
function isUtilityPage(file) {
  return UTILITY_PAGE_FILES.includes(file);
}

module.exports = {
  CITY_SLUGS,
  CITY_PAGE_RE,
  BLOG_PAGE_RE,
  SERVICE_PAGE_FILES,
  UTILITY_PAGE_FILES,
  isCityPage,
  isBlogPage,
  isServicePage,
  isUtilityPage,
};
