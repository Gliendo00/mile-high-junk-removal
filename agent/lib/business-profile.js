// Site Improvement Agent — canonical business/service-area context loader.
//
// Loads agent/context/business-profile.json once and exposes the narrow set
// of accessors the rest of the agent actually needs. This is the single
// place that reads that file — do not `require("../context/business-
// profile.json")` directly elsewhere; go through this module so every
// consumer gets the same validated shape and the same derived values
// (e.g. a city's page filename), rather than each re-deriving its own.
//
// agent/lib/page-groups.js (the pre-existing single source the Phase 1-3
// audits already use for CITY_SLUGS/SERVICE_PAGE_FILES/etc.) now derives
// its exports FROM this file, so there is exactly one place city/service
// lists live, not two.

const fs = require("fs");
const path = require("path");

const PROFILE_PATH = path.join(__dirname, "..", "context", "business-profile.json");

let cached = null;

function loadProfile(profilePath = PROFILE_PATH) {
  if (cached && profilePath === PROFILE_PATH) return cached;
  const raw = fs.readFileSync(profilePath, "utf8");
  const profile = JSON.parse(raw);
  validateProfile(profile);
  if (profilePath === PROFILE_PATH) cached = profile;
  return profile;
}

function validateProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("business-profile.json must contain an object");
  }
  for (const key of ["identity", "services", "serviceArea", "pageConventions"]) {
    if (!profile[key] || typeof profile[key] !== "object") {
      throw new Error(`business-profile.json is missing required section "${key}"`);
    }
  }
  if (!Array.isArray(profile.services.pages) || profile.services.pages.length === 0) {
    throw new Error("business-profile.json services.pages must be a non-empty array");
  }
  if (!Array.isArray(profile.serviceArea.citiesWithPages) || profile.serviceArea.citiesWithPages.length === 0) {
    throw new Error("business-profile.json serviceArea.citiesWithPages must be a non-empty array");
  }
}

function cityPageFile(slug, profile = loadProfile()) {
  return `${slug}${profile.pageConventions.cityPageSuffix}`;
}

function getIdentity(profile = loadProfile()) {
  return profile.identity;
}

function getServicePages(profile = loadProfile()) {
  return profile.services.pages;
}

function getServicePageFiles(profile = loadProfile()) {
  return profile.services.pages.map((s) => s.file);
}

function getCoreCities(profile = loadProfile()) {
  return profile.serviceArea.coreCities;
}

// Cities with a real, dedicated page today — the set the existing
// mechanical audits (consistency, internal-linking, coverage, etc.) are
// allowed to reason about directly.
function getCitiesWithPages(profile = loadProfile()) {
  return profile.serviceArea.citiesWithPages;
}

function getCityPageFiles(profile = loadProfile()) {
  return profile.serviceArea.citiesWithPages.map((c) => cityPageFile(c.slug, profile));
}

function getCitySlugs(profile = loadProfile()) {
  return profile.serviceArea.citiesWithPages.map((c) => c.slug);
}

// Real claimed service-area cities (the site's own JSON-LD areaServed /
// "+ all surrounding areas" section) that do NOT have a dedicated page —
// evidence for the weekly research rotation to evaluate, never a page
// backlog to mechanically fill in (see agent/README.md's new-page
// standard, and business-profile.json's own note on this field).
function getClaimedCitiesWithoutPages(profile = loadProfile()) {
  return profile.serviceArea.claimedCitiesWithoutPages || [];
}

// The WHOLE actual service area (claimed + paged), for anything that must
// not silently narrow its view to "just the cities with pages" — e.g. the
// weekly rotation's "time since this area was last reviewed" bookkeeping.
function getAllServiceAreaCities(profile = loadProfile()) {
  return [...getCitiesWithPages(profile), ...getClaimedCitiesWithoutPages(profile)];
}

function getUtilityPageFiles(profile = loadProfile()) {
  return profile.pageConventions.utilityPages || [];
}

function getBlogPagePrefix(profile = loadProfile()) {
  return profile.pageConventions.blogPagePrefix;
}

function getOperationalConstraints(profile = loadProfile()) {
  return profile.operationalConstraints || [];
}

module.exports = {
  PROFILE_PATH,
  loadProfile,
  cityPageFile,
  getIdentity,
  getServicePages,
  getServicePageFiles,
  getCoreCities,
  getCitiesWithPages,
  getCityPageFiles,
  getCitySlugs,
  getClaimedCitiesWithoutPages,
  getAllServiceAreaCities,
  getUtilityPageFiles,
  getBlogPagePrefix,
  getOperationalConstraints,
};
