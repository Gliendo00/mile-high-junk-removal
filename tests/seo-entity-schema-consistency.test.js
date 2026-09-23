// Regression test for the Phase 1 entity/schema consolidation (SEO/entity
// disambiguation audit, 2026-09-23). Guards against the two failure modes
// that prompted that work: (1) a page's JSON-LD silently breaking, and
// (2) a page re-introducing a second, disconnected representation of the
// business (an anonymous Organization/LocalBusiness node not tied back to
// https://www.milehighjunkremoval.net/#business via @id).
//
// This only reads public HTML files — it makes no network calls and touches
// no admin/API code.
//
// Run with:  node tests/seo-entity-schema-consistency.test.js
// Exits with a non-zero code if any assertion fails.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SITE_DIR = path.join(__dirname, "..");
const BUSINESS_ID = "https://www.milehighjunkremoval.net/#business";
const LOGO_URL = "https://www.milehighjunkremoval.net/images/mile-high-junk-removal-logo.webp";
const BBB_SAMEAS_URL = "https://www.bbb.org/us/co/aurora/profile/junk-removal/mile-high-junk-removal-1296-1000200692/";
// Google Business Profile, verified 2026-09-23: this cid= link was checked by
// loading it and confirming it resolves to this exact listing (name, phone
// (303) 990-1812, milehighjunkremoval.net as the listed website, and reviews
// naming the same staff - Ruby, Gerardo - as this site's own testimonials).
const GBP_SAMEAS_URL = "https://www.google.com/maps?cid=14327598877393898794";

// privacy-policy.html is intentionally noindexed and has no sameAs/social
// block at all (pre-existing, unrelated to this work) - excluded from the
// sameAs/BBB checks below for that reason.
const SAMEAS_EXEMPT = new Set(["privacy-policy.html"]);

const files = fs.readdirSync(SITE_DIR)
  .filter((f) => f.endsWith(".html"))
  .concat(["book/index.html"]);

let checked = 0;

for (const rel of files) {
  const full = path.join(SITE_DIR, rel);
  const content = fs.readFileSync(full, "utf8");

  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(content))) blocks.push(m[1]);

  if (blocks.length === 0) continue; // non-schema pages (e.g. admin) not in scope
  checked++;

  let graph = [];
  for (const raw of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      assert.fail(`${rel}: JSON-LD block failed to parse: ${e.message}`);
    }
    graph = graph.concat(Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed]);
  }

  // Exactly one node should represent the business itself, and it must use
  // the single canonical @id - not a second, differently-anchored node.
  const businessNodes = graph.filter(
    (n) => n && n["@id"] === BUSINESS_ID
  );
  assert.strictEqual(
    businessNodes.length,
    1,
    `${rel}: expected exactly 1 node with @id "${BUSINESS_ID}", found ${businessNodes.length}`
  );
  const business = businessNodes[0];
  assert.strictEqual(business.name, "Mile High Junk Removal", `${rel}: business node name mismatch`);
  assert.strictEqual(business.logo, LOGO_URL, `${rel}: business node missing/incorrect "logo"`);

  // No second, anonymous representation of the business (the bug this test
  // guards against): any other node whose name is the business name must
  // still resolve back to the canonical entity via @id, not restate it.
  const otherSameNameNodes = graph.filter(
    (n) => n && n !== business && n.name === "Mile High Junk Removal" && !n["@id"]
  );
  assert.strictEqual(
    otherSameNameNodes.length,
    0,
    `${rel}: found ${otherSameNameNodes.length} anonymous node(s) also named "Mile High Junk Removal" ` +
      `with no @id - these should reference {"@id": "${BUSINESS_ID}"} instead`
  );

  // BlogPosting author/publisher must reference the canonical entity by @id.
  const blogPosting = graph.find((n) => n && n["@type"] === "BlogPosting");
  if (blogPosting) {
    assert.strictEqual(
      blogPosting.author && blogPosting.author["@id"],
      BUSINESS_ID,
      `${rel}: BlogPosting.author must be {"@id": "${BUSINESS_ID}"}`
    );
    assert.strictEqual(
      blogPosting.publisher && blogPosting.publisher["@id"],
      BUSINESS_ID,
      `${rel}: BlogPosting.publisher must be {"@id": "${BUSINESS_ID}"}`
    );
  }

  // sameAs: existing social entries must survive untouched, and BBB must be
  // present (except on the one exempt page).
  if (!SAMEAS_EXEMPT.has(rel)) {
    const sameAs = business.sameAs || [];
    for (const url of [
      "https://www.facebook.com/MileHighJunkRemoval/",
      "https://www.instagram.com/milehigh_junkremoval/",
      "https://www.tiktok.com/@mile.high.junk.removal",
      BBB_SAMEAS_URL,
      GBP_SAMEAS_URL,
    ]) {
      assert.ok(sameAs.includes(url), `${rel}: sameAs missing expected URL: ${url}`);
    }
  }

  // Service nodes, where present, must provide the business via @id (never
  // restate it), and any @id on the Service node itself must be unique to
  // that page (not accidentally equal to the business @id).
  const services = graph.filter((n) => n && n["@type"] === "Service");
  for (const svc of services) {
    assert.strictEqual(
      svc.provider && svc.provider["@id"],
      BUSINESS_ID,
      `${rel}: Service.provider must be {"@id": "${BUSINESS_ID}"}`
    );
    if (svc["@id"]) {
      assert.notStrictEqual(svc["@id"], BUSINESS_ID, `${rel}: Service @id must not collide with the business @id`);
    }
  }
}

assert.ok(checked > 40, `expected to check 40+ pages with JSON-LD, only checked ${checked}`);

console.log(`OK - ${checked} pages checked, entity graph resolves consistently to ${BUSINESS_ID}`);
