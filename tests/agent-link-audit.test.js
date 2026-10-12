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

if (process.exitCode) {
  process.exit(process.exitCode);
}
