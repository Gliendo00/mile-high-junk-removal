// Site Improvement Agent, Phase 5 — canonical business/service-area
// context (agent/lib/business-profile.js, backed by agent/context/
// business-profile.json). Proves: the profile loads and validates, the
// WHOLE service area is represented (not just Denver/the cities with
// pages), and agent/lib/page-groups.js's pre-existing exports (relied on
// by every Phase 1-3 audit module) are byte-identical to before, now that
// they're derived from this file instead of being hardcoded a second
// time.
//
// Run with:  node tests/agent-business-profile.test.js

const assert = require("assert");
const businessProfile = require("../agent/lib/business-profile");
const pageGroups = require("../agent/lib/page-groups");

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

test("loadProfile() returns a validated object with every required section", () => {
  const profile = businessProfile.loadProfile();
  assert.ok(profile.identity && profile.identity.name);
  assert.ok(Array.isArray(profile.services.pages) && profile.services.pages.length > 0);
  assert.ok(Array.isArray(profile.serviceArea.citiesWithPages) && profile.serviceArea.citiesWithPages.length > 0);
});

test("getCitiesWithPages() matches page-groups.js's pre-existing CITY_SLUGS exactly (same count, same order) — the refactor changed WHERE the data comes from, never WHAT it is", () => {
  const slugs = businessProfile.getCitySlugs();
  assert.deepStrictEqual(slugs, pageGroups.CITY_SLUGS);
  assert.strictEqual(slugs.length, 13);
});

test("getServicePageFiles() matches page-groups.js's pre-existing SERVICE_PAGE_FILES exactly", () => {
  assert.deepStrictEqual(businessProfile.getServicePageFiles(), pageGroups.SERVICE_PAGE_FILES);
});

test("getUtilityPageFiles() matches page-groups.js's pre-existing UTILITY_PAGE_FILES exactly", () => {
  assert.deepStrictEqual(businessProfile.getUtilityPageFiles(), pageGroups.UTILITY_PAGE_FILES);
});

test("cityPageFile() derives the exact filename pattern page-groups.js's CITY_PAGE_RE expects", () => {
  const file = businessProfile.cityPageFile("castle-rock");
  assert.strictEqual(file, "castle-rock-junk-removal.html");
  assert.ok(pageGroups.CITY_PAGE_RE.test(file));
});

test("getAllServiceAreaCities() covers the WHOLE claimed service area (citiesWithPages + claimedCitiesWithoutPages), not just the cities with pages — the site's own homepage JSON-LD areaServed claims more cities than it has pages for", () => {
  const withPages = businessProfile.getCitiesWithPages();
  const withoutPages = businessProfile.getClaimedCitiesWithoutPages();
  const all = businessProfile.getAllServiceAreaCities();
  assert.strictEqual(all.length, withPages.length + withoutPages.length);
  assert.ok(withoutPages.length > 0, "expected at least one claimed-but-pageless city — this is real, verified site data (e.g. Golden, Brighton), not a placeholder");
  // No city should appear in both lists.
  const withPageSlugs = new Set(withPages.map((c) => c.slug));
  for (const city of withoutPages) {
    assert.ok(!withPageSlugs.has(city.slug), `${city.slug} should not appear in both citiesWithPages and claimedCitiesWithoutPages`);
  }
});

test("getCoreCities() is a non-empty subset of getCitiesWithPages()", () => {
  const core = businessProfile.getCoreCities();
  const withPageSlugs = new Set(businessProfile.getCitiesWithPages().map((c) => c.slug));
  assert.ok(core.length > 0);
  for (const c of core) assert.ok(withPageSlugs.has(c.slug));
});

test("getOperationalConstraints() returns a non-empty list of business-accuracy rules (never invent reviews/pricing/etc.)", () => {
  const constraints = businessProfile.getOperationalConstraints();
  assert.ok(Array.isArray(constraints) && constraints.length > 0);
  assert.ok(constraints.some((c) => /invent/i.test(c)));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
