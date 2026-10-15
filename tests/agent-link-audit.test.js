// Site Improvement Agent — tests for link-audit.js. Uses the repo's real
// vercel.json/sitemap.xml/robots.txt (read-only) combined with synthetic
// PageRecord fixtures that exercise specific scenarios deterministically,
// without depending on whatever links happen to exist on the live site
// today.
//
// Run with:  node tests/agent-link-audit.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const config = require("../agent/config");
const { normalizeHref, loadRedirects, auditLinks, auditSitemapAndRobots } = require("../agent/lib/link-audit");

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

function page(overrides) {
  return { file: "sample.html", internalLinks: [], ...overrides };
}

test("normalizeHref strips query/hash and leading slash, maps directories to index.html", () => {
  assert.strictEqual(normalizeHref("/about.html"), "about.html");
  assert.strictEqual(normalizeHref("about.html#faq"), "about.html");
  assert.strictEqual(normalizeHref("about.html?utm=1"), "about.html");
  assert.strictEqual(normalizeHref("/"), "index.html");
  assert.strictEqual(normalizeHref(""), "index.html");
  assert.strictEqual(normalizeHref("/book/"), "book/index.html");
});

test("a link to a real existing file produces no finding", () => {
  const findings = auditLinks([page({ file: "x.html", internalLinks: ["/about.html"] })]);
  assert.ok(!findings.some((f) => f.pages.includes("x.html") && f.type.startsWith("broken")));
});

test("a link to a known vercel.json redirect source is flagged as a fixable redirect hop", () => {
  const redirects = loadRedirects();
  assert.ok(redirects.length > 0, "expected vercel.json to have at least one redirect for this test to be meaningful");
  // Pick a redirect whose SOURCE does not itself already resolve to a real
  // file (otherwise it's not a "hop" at all, e.g. /index.html -> / both
  // resolve to the same on-disk file) and whose destination does exist.
  const sample = redirects.find((r) => {
    const sourcePath = path.join(config.SITE_ROOT, normalizeHref(r.source));
    const destPath = path.join(config.SITE_ROOT, normalizeHref(r.destination));
    return !fs.existsSync(sourcePath) && fs.existsSync(destPath);
  });
  assert.ok(sample, "expected at least one redirect whose source doesn't exist directly but whose destination does");

  const findings = auditLinks([page({ file: "x.html", internalLinks: [sample.source] })]);
  const hop = findings.find((f) => f.type === "redirect-hop-internal-link" && f.pages.includes("x.html"));
  assert.ok(hop, `expected a redirect-hop finding for ${sample.source}`);
  assert.ok(hop.autoFix, "redirect-hop finding must carry an autoFix");
  assert.strictEqual(hop.autoFix.kind, "rewrite-href");
  assert.strictEqual(hop.autoFix.from, sample.source);
});

test("a case-mismatched link to a real file is flagged as fixable, with the exact correct case suggested", () => {
  const findings = auditLinks([page({ file: "x.html", internalLinks: ["/About.html"] })]);
  const fixable = findings.find((f) => f.type === "broken-internal-link-fixable" && f.pages.includes("x.html"));
  assert.ok(fixable, "expected a fixable broken-link finding");
  assert.strictEqual(fixable.autoFix.to, "/about.html");
});

test("a link to a nonexistent page with no redirect and no case match is flagged as broken (no fix)", () => {
  const findings = auditLinks([page({ file: "x.html", internalLinks: ["/this-page-does-not-exist-anywhere.html"] })]);
  const broken = findings.find((f) => f.type === "broken-internal-link" && f.pages.includes("x.html"));
  assert.ok(broken, "expected an unfixable broken-link finding");
  assert.strictEqual(broken.autoFix, null);
});

test("a page not linked from anywhere else is flagged as an orphan; a linked one is not", () => {
  const pages = [
    page({ file: "hub.html", internalLinks: ["/linked.html"] }),
    page({ file: "linked.html", internalLinks: ["/orphan-candidate.html"] }),
    page({ file: "orphan-candidate.html", internalLinks: [] }),
    page({ file: "truly-orphaned.html", internalLinks: [] }),
  ];
  const findings = auditLinks(pages);
  assert.ok(findings.some((f) => f.type === "orphan-page" && f.pages.includes("truly-orphaned.html")));
  assert.ok(!findings.some((f) => f.type === "orphan-page" && f.pages.includes("linked.html")));
  assert.ok(!findings.some((f) => f.type === "orphan-page" && f.pages.includes("orphan-candidate.html")));
});

test("sitemap/robots audit runs against the real site files without throwing and returns an array", () => {
  const pages = [page({ file: "index.html" }), page({ file: "about.html" })];
  const findings = auditSitemapAndRobots(pages);
  assert.ok(Array.isArray(findings));
  for (const f of findings) {
    assert.ok(f.evidence.length > 0);
  }
});

// -----------------------------------------------------------------------
// Sitemap vs. noindex intent (fixes a real false positive this audit
// produced in production: privacy-policy.html declares noindex, so its
// absence from sitemap.xml is consistent with that intent, not a defect
// — see agent/README.md's "Sitemap vs. noindex intent" section). These
// use a synthetic filename guaranteed absent from the real sitemap.xml
// (for scenarios 1-2) and a REAL filename known to be IN the real
// sitemap.xml (pricing.html, for scenario 3) with `noindex` set
// synthetically — this audit's own loadSitemapUrls() always reads the
// real on-disk sitemap.xml (no injection point), so these tests work
// WITH that real file rather than mocking it.
// -----------------------------------------------------------------------

test("an indexable (non-noindex) page missing from sitemap.xml still produces an ACTIONABLE sitemap-missing-url finding", () => {
  const findings = auditSitemapAndRobots([page({ file: "__test-synthetic-indexable-missing-page.html", noindex: false })]);
  const finding = findings.find((f) => f.type === "sitemap-missing-url" && f.pages.includes("__test-synthetic-indexable-missing-page.html"));
  assert.ok(finding, "an indexable page missing from the sitemap must still be flagged");
  assert.ok(!findings.some((f) => f.type === "noindex-page-in-sitemap" && f.pages.includes("__test-synthetic-indexable-missing-page.html")));
});

test("an explicitly noindex page missing from sitemap.xml produces NO sitemap-missing-url finding — its absence is consistent with its own stated intent", () => {
  const findings = auditSitemapAndRobots([
    page({ file: "__test-synthetic-noindex-missing-page.html", robotsMeta: "noindex, follow", noindex: true }),
  ]);
  assert.ok(
    !findings.some((f) => f.type === "sitemap-missing-url" && f.pages.includes("__test-synthetic-noindex-missing-page.html")),
    "a noindex page's absence from the sitemap must never be treated as a defect/proposal opportunity"
  );
  // Also absent from the sitemap -> no "noindex-page-in-sitemap"
  // contradiction either (that type only fires when BOTH are true).
  assert.ok(!findings.some((f) => f.type === "noindex-page-in-sitemap"));
});

test("a noindex page that IS already in sitemap.xml is surfaced as an observation, never auto-removed or auto-fixed", () => {
  const { loadSitemapUrls } = require("../agent/lib/link-audit");
  assert.ok(
    loadSitemapUrls().some((u) => u.endsWith("/pricing.html")),
    "expected pricing.html to be in the real sitemap.xml for this test to be meaningful"
  );
  const findings = auditSitemapAndRobots([page({ file: "pricing.html", robotsMeta: "noindex, follow", noindex: true })]);
  const finding = findings.find((f) => f.type === "noindex-page-in-sitemap" && f.pages.includes("pricing.html"));
  assert.ok(finding, "expected the contradiction (noindex + listed in sitemap) to be surfaced");
  assert.ok(!finding.autoFix, "this finding must never carry a mechanical auto-fix");
  assert.ok(!findings.some((f) => f.type === "sitemap-missing-url" && f.pages.includes("pricing.html")));

  // Never actionable, never auto-resolved — risk.js's own classification
  // (not just this one audit module) guarantees NO_CHANGE, never a
  // proposal to silently remove it from the sitemap.
  const { classify } = require("../agent/lib/risk");
  const classified = classify(finding);
  assert.strictEqual(classified.tier, "observation");
  assert.strictEqual(classified.autoApplyEligible, false);
});

test("real site scan: privacy-policy.html (genuinely noindexed in production) produces no sitemap-missing-url finding, for the general noindex reason, not a special case", () => {
  const { scanAllPages } = require("../agent/lib/scan");
  const pages = scanAllPages();
  const privacyPage = pages.find((p) => p.file === "privacy-policy.html");
  assert.ok(privacyPage, "expected privacy-policy.html to exist on the real site");
  assert.strictEqual(privacyPage.noindex, true, "expected the real page to actually declare noindex (if this ever changes, this test should fail loudly, not silently)");

  const findings = auditSitemapAndRobots(pages);
  assert.ok(
    !findings.some((f) => f.type === "sitemap-missing-url" && f.pages.includes("privacy-policy.html")),
    "the real false positive this fix targets must not recur"
  );
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
