// Regression test for the About page build (About/Founder/Entity project,
// 2026-09-23, revised 2026-09-25 once Gerardo clarified the BBB/founding-date
// question: the LLC was formed in 2021, but Mile High Junk Removal itself
// began operating in late 2023 - so foundingDate is intentionally omitted
// from #business rather than guessing between the two years). Guards against
// the specific facts and constraints Gerardo approved for this page: exact
// founder names, no invented surname for Ruby, no fabricated foundingDate, no
// competing Organization/Person entity outside the canonical business node,
// no competitor criticism, no named former employer, and the presence of the
// approved founder photo with real alt text.
//
// This only reads public HTML files — it makes no network calls and touches
// no admin/API code.
//
// Run with:  node tests/about-page.test.js
// Exits with a non-zero code if any assertion fails.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SITE_DIR = path.join(__dirname, "..");
const BUSINESS_ID = "https://www.milehighjunkremoval.net/#business";
const WEBSITE_ID = "https://www.milehighjunkremoval.net/#website";
const ABOUT_URL = "https://www.milehighjunkremoval.net/about.html";
const FOUNDER_PHOTO = "images/gerardo-ruby-mile-high-junk-removal.webp";

const ABOUT_PATH = path.join(SITE_DIR, "about.html");
assert.ok(fs.existsSync(ABOUT_PATH), "about.html must exist at the site root");
const html = fs.readFileSync(ABOUT_PATH, "utf8");

function extractGraph(content) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(content))) blocks.push(m[1]);
  let graph = [];
  for (const raw of blocks) {
    const parsed = JSON.parse(raw); // throws (and fails the run) if invalid
    graph = graph.concat(Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed]);
  }
  return graph;
}

// --- Canonical / meta / H1 -------------------------------------------------

assert.match(html, /<link rel="canonical" href="https:\/\/www\.milehighjunkremoval\.net\/about\.html">/,
  "about.html must self-canonicalize to /about.html");

const titleMatch = html.match(/<title>([^<]+)<\/title>/);
assert.ok(titleMatch, "about.html must have a <title>");
assert.ok(/Mile High Junk Removal/.test(titleMatch[1]), "title must name the business");

const descMatch = html.match(/<meta name="description" content="([^"]+)">/);
assert.ok(descMatch, "about.html must have a meta description");
assert.ok(descMatch[1].length > 50 && descMatch[1].length < 300, "meta description should be a reasonable length");

const h1Matches = html.match(/<h1[^>]*>([^<]+)<\/h1>/g) || [];
assert.strictEqual(h1Matches.length, 1, "about.html must have exactly one H1");

// Title must be unique among the other top-level pages (no accidental copy/paste).
const otherTitles = fs.readdirSync(SITE_DIR)
  .filter((f) => f.endsWith(".html") && f !== "about.html")
  .map((f) => {
    const c = fs.readFileSync(path.join(SITE_DIR, f), "utf8");
    const t = c.match(/<title>([^<]+)<\/title>/);
    return t ? t[1] : null;
  });
assert.ok(!otherTitles.includes(titleMatch[1]), "about.html's <title> must not duplicate another page's <title>");

// --- Structured data ---------------------------------------------------

const graph = extractGraph(html);

const business = graph.find((n) => n && n["@id"] === BUSINESS_ID);
assert.ok(business, "about.html must include the canonical #business node");

// No competing Organization/Person/LocalBusiness entity outside the
// canonical node — founders must be nested under #business, not top-level.
const disallowedTopLevel = graph.filter(
  (n) => n && ["Organization", "LocalBusiness", "Person"].includes(n["@type"]) && n["@id"] !== BUSINESS_ID
);
assert.strictEqual(disallowedTopLevel.length, 0,
  `about.html must not add a competing top-level Organization/LocalBusiness/Person node; found: ${JSON.stringify(disallowedTopLevel)}`);

// foundingDate is intentionally omitted: the legal entity (2021) and the
// junk-removal operation's actual start (late 2023) are different dates, and
// neither year alone would be accurate for schema.org's single foundingDate
// property. Guard against either year quietly reappearing.
assert.ok(!("foundingDate" in business), 'business node must NOT have a foundingDate property (2021 LLC vs. late-2023 operational start are two different dates - neither belongs here)');

// founder: exactly Gerardo Liendo and Ruby (no invented surname for Ruby).
assert.ok(Array.isArray(business.founder), "business.founder must be an array");
const founderNames = business.founder.map((f) => f.name).sort();
assert.deepStrictEqual(founderNames, ["Gerardo Liendo", "Ruby"].sort(),
  "founder array must be exactly Gerardo Liendo and Ruby, with no invented surname for Ruby");
for (const f of business.founder) {
  assert.strictEqual(f["@type"], "Person", "each founder entry must be a Person");
}

// AboutPage node: about -> #business, isPartOf -> #website.
const aboutPage = graph.find((n) => n && n["@type"] === "AboutPage");
assert.ok(aboutPage, "about.html must include an AboutPage node");
assert.strictEqual(aboutPage.about && aboutPage.about["@id"], BUSINESS_ID, "AboutPage.about must reference the canonical #business node");
assert.strictEqual(aboutPage.isPartOf && aboutPage.isPartOf["@id"], WEBSITE_ID, "AboutPage.isPartOf must reference #website");
assert.strictEqual(aboutPage.url, ABOUT_URL, "AboutPage.url must match the canonical About URL");

// --- Founder photo -----------------------------------------------------

const photoPath = path.join(SITE_DIR, FOUNDER_PHOTO);
assert.ok(fs.existsSync(photoPath), `founder photo must exist at ${FOUNDER_PHOTO}`);

const imgMatch = html.match(new RegExp(`<img[^>]*src="${FOUNDER_PHOTO}"[^>]*>`));
assert.ok(imgMatch, "about.html must reference the founder photo in an <img> tag");
const altMatch = imgMatch[0].match(/alt="([^"]*)"/);
assert.ok(altMatch && altMatch[1].trim().length > 0, "founder photo must have non-empty alt text");
assert.ok(!/junk removal denver|best junk removal|#1|top rated/i.test(altMatch[1]),
  "founder photo alt text must be natural, not keyword-stuffed");

// --- Copy-safety: no competitor criticism -------------------------------

const bannedPhrases = [
  /\bscam(my)?\b/i,
  /bait[\s-]and[\s-]switch/i,
  /trailer fluffing/i,
  /rip[\s-]?off/i,
  /overcharg/i,
  /unlike (other|some) (junk|companies)/i,
  /corporate greed/i,
];
for (const re of bannedPhrases) {
  assert.ok(!re.test(html), `about.html must not contain competitor-critical language matching ${re}`);
}

// Gerardo asked that his prior employer never be named publicly on this page
// (2026-09-23 revision). The prior-experience story must stay generic.
assert.ok(!/1-800-GOT-JUNK/i.test(html), "about.html must not name 1-800-GOT-JUNK (or any prior employer) anywhere");

// --- Visible operational-start language (not schema) ---------------------
// The LLC was formed in 2021; the junk-removal operation began in late 2023.
// "founded" must not be used for the 2023 date (it would read as the legal
// founding date, which is 2021). This only checks the boundary, not exact
// wording, so small copy tweaks won't break it.
assert.ok(!/\bfounded\b/i.test(html),
  "about.html must not use \"founded\" for the 2023 operational start - use \"started\"/\"began\" language instead");
assert.ok(/late 2023/i.test(html),
  "about.html should still state the junk-removal operation's late-2023 start somewhere in visible copy");

// --- Sitemap -------------------------------------------------------------

const sitemap = fs.readFileSync(path.join(SITE_DIR, "sitemap.xml"), "utf8");
assert.ok(sitemap.includes("<loc>https://www.milehighjunkremoval.net/about.html</loc>"),
  "sitemap.xml must list the About page");

console.log("OK - about.html structure, schema, photo, sitemap, and copy-safety checks passed");
