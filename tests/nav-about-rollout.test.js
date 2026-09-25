// Regression test for the global "Why Us" -> "About" navigation rollout
// (About/Founder/Entity project, 2026-09-25). Gerardo approved replacing the
// top-level "Why Us" nav/footer link with "About" -> about.html, site-wide,
// while keeping the homepage's #why-us section itself completely intact
// (only the global nav link that pointed at it was replaced).
//
// This only reads public HTML files — it makes no network calls and touches
// no admin/API code.
//
// Run with:  node tests/nav-about-rollout.test.js
// Exits with a non-zero code if any assertion fails.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SITE_DIR = path.join(__dirname, "..");

// The exact 52-file target set the rollout used: every top-level .html page
// (50 pre-existing pages + about.html) plus book/index.html. admin/ and
// .vercel/ are intentionally out of scope (no shared nav there).
const topLevelHtml = fs.readdirSync(SITE_DIR)
  .filter((f) => f.endsWith(".html"))
  .sort();
const files = topLevelHtml.concat(["book/index.html"]);

assert.ok(files.includes("about.html"), "about.html must exist in the target set");
assert.strictEqual(files.length, 52, `expected exactly 52 target files, found ${files.length}: ${files.join(", ")}`);

let checked = 0;

for (const rel of files) {
  const full = path.join(SITE_DIR, rel);
  const content = fs.readFileSync(full, "utf8");
  checked++;

  const isBook = rel === "book/index.html";
  const isAbout = rel === "about.html";
  const aboutHref = isBook ? "../about.html" : "about.html";

  // About must appear exactly 3 times: desktop nav, mobile nav, footer.
  const aboutLinkRe = new RegExp(`<a href="${aboutHref.replace(/\./g, "\\.")}"[^>]*>About</a>`, "g");
  const aboutMatches = content.match(aboutLinkRe) || [];
  assert.strictEqual(aboutMatches.length, 3,
    `${rel}: expected exactly 3 About links (desktop nav, mobile nav, footer), found ${aboutMatches.length}`);

  // The old "Why Us" global nav/footer link must be completely gone.
  assert.ok(!/<a href="[^"]*#why-us">Why Us<\/a>/.test(content),
    `${rel}: old "Why Us" nav/footer link must not remain`);

  // aria-current="page" on the About link only on about.html itself, and
  // only on the two NAV occurrences (desktop + mobile) — not the footer one,
  // matching how every other page's own nav link is marked (see pricing.html
  // convention: footer never carries aria-current).
  const currentCount = (content.match(/<a href="[^"]*about\.html"\s+aria-current="page">About<\/a>/g) || []).length;
  if (isAbout) {
    assert.strictEqual(currentCount, 2, `about.html: expected exactly 2 aria-current About links (desktop+mobile nav), found ${currentCount}`);
  } else {
    assert.strictEqual(currentCount, 0, `${rel}: must NOT mark its own About link as aria-current (only about.html should)`);
  }
}

assert.strictEqual(checked, 52, `expected to check 52 files, checked ${checked}`);

// --- Homepage #why-us section must remain completely intact ---------------

const indexHtml = fs.readFileSync(path.join(SITE_DIR, "index.html"), "utf8");
assert.ok(/<section id="why-us"/.test(indexHtml), "index.html must still have the #why-us section (id preserved)");

// --- No other page accidentally deleted/renamed the section id ------------

for (const f of topLevelHtml) {
  if (f === "index.html") continue;
  const content = fs.readFileSync(path.join(SITE_DIR, f), "utf8");
  assert.ok(!/id="why-us"/.test(content), `${f}: unexpectedly has a #why-us section id (should only exist on index.html)`);
}

// --- Sitemap still lists About ---------------------------------------------

const sitemap = fs.readFileSync(path.join(SITE_DIR, "sitemap.xml"), "utf8");
assert.ok(sitemap.includes("<loc>https://www.milehighjunkremoval.net/about.html</loc>"),
  "sitemap.xml must still list the About page");

console.log(`OK - ${checked} files carry the About nav/footer link correctly, #why-us section intact on index.html, sitemap unaffected`);
