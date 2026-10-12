// Site Improvement Agent — internal link, sitemap, and robots audit.
//
// Pure, read-only: takes the scanner's PageRecords plus the site's own
// routing files (vercel.json redirects, sitemap.xml, robots.txt) and
// produces findings about broken links, redirect hops, orphan pages, and
// sitemap/robots inconsistencies. No network access, no file writes.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { makeFinding } = require("./findings");

function loadVercelJson() {
  const raw = fs.readFileSync(config.VERCEL_JSON_PATH, "utf8");
  return JSON.parse(raw);
}

function loadRedirects() {
  return loadVercelJson().redirects || [];
}

// Rewrites are invisible to the browser (the URL bar keeps showing the
// rewrite's `source`, which is the real, intended public URL for that
// content) — unlike a redirect, linking to a rewrite source is correct,
// not a hop to fix. vercel.json's one content-page rewrite,
// "/privacy-policy" -> "/privacy-policy.html", is exactly this: the clean
// URL is canonical for that page even though every other page on the site
// uses its .html filename as canonical (see agent/README.md).
function loadRewrites() {
  return loadVercelJson().rewrites || [];
}

// Maps an on-disk file (e.g. "privacy-policy.html") to the clean URL a
// rewrite serves it under (e.g. "privacy-policy"), when one exists.
function buildRewriteCleanUrlMap() {
  const rewrites = loadRewrites();
  const map = new Map();
  for (const r of rewrites) {
    const destFile = normalizeHref(r.destination);
    if (fileExistsOnDisk(destFile)) {
      map.set(destFile, normalizeHref(r.source));
    }
  }
  return map;
}

function loadSitemapUrls() {
  const raw = fs.readFileSync(config.SITEMAP_PATH, "utf8");
  return [...raw.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => m[1].trim());
}

function loadRobotsDisallows() {
  const raw = fs.readFileSync(config.ROBOTS_PATH, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^disallow:/i.test(l))
    .map((l) => l.replace(/^disallow:\s*/i, "").trim())
    .filter(Boolean);
}

// Normalize an href to a path relative to the site root, with no query
// string or hash fragment. Returns null for things that aren't a path we
// can resolve on disk (e.g. a bare "/").
function normalizeHref(href) {
  let clean = href.split("#")[0].split("?")[0];
  // An absolute link to this site's own domain (any scheme/www variant) is
  // just as internal as a relative one — strip the origin before
  // resolving it the same way.
  clean = clean.replace(/^https?:\/\/(www\.)?milehighjunkremoval\.net/i, "");
  if (clean === "" || clean === "/") return "index.html";
  if (clean.startsWith("/")) clean = clean.slice(1);
  if (clean.endsWith("/")) clean = clean + "index.html";
  return clean;
}

// Deliberately case-SENSITIVE, even on a case-insensitive local filesystem
// (Windows/macOS default): this project deploys to Vercel's Linux-based
// static hosting, where a case mismatch is a real 404. fs.existsSync alone
// would silently hide that bug during local development.
function fileExistsOnDisk(relPath) {
  const fullPath = path.join(config.SITE_ROOT, relPath);
  if (!fs.existsSync(fullPath)) return false;
  const dir = path.dirname(fullPath);
  const base = path.basename(fullPath);
  const entries = fs.readdirSync(dir);
  return entries.includes(base);
}

// Case-insensitive match against files actually on disk in the same
// directory — catches simple typos (wrong case, stray dash) with high
// confidence, since there is exactly one unambiguous candidate.
function findCaseInsensitiveMatch(relPath) {
  const dir = path.dirname(relPath);
  const base = path.basename(relPath).toLowerCase();
  const searchDir = path.join(config.SITE_ROOT, dir === "." ? "" : dir);
  if (!fs.existsSync(searchDir)) return null;
  const entries = fs.readdirSync(searchDir);
  const match = entries.find((e) => e.toLowerCase() === base);
  if (!match || match === path.basename(relPath)) return null;
  return dir === "." ? match : path.join(dir, match);
}

function buildRedirectResolver(redirects) {
  const bySource = new Map();
  for (const r of redirects) {
    bySource.set(normalizeHref(r.source), normalizeHref(r.destination));
  }
  return function resolve(relPath, maxHops = 5) {
    let current = relPath;
    let hops = 0;
    while (bySource.has(current) && hops < maxHops) {
      current = bySource.get(current);
      hops += 1;
    }
    return { finalPath: current, hops };
  };
}

function auditLinks(pages) {
  const redirects = loadRedirects();
  const resolveRedirect = buildRedirectResolver(redirects);
  const rewriteSources = new Set(loadRewrites().map((r) => normalizeHref(r.source)));
  const findings = [];
  const linkedTargets = new Set(["index.html"]);

  for (const page of pages) {
    for (const href of page.internalLinks) {
      const normalized = normalizeHref(href);
      linkedTargets.add(normalized);

      const existsDirectly = fileExistsOnDisk(normalized);
      const isRewriteSource = rewriteSources.has(normalized);
      const { finalPath, hops } = resolveRedirect(normalized);

      if (existsDirectly || isRewriteSource) {
        continue; // links straight to a real file, or to the clean URL an
        // invisible rewrite serves it under — both are correct, nothing to do
      }

      if (hops > 0) {
        // The href is a redirect source, not the final destination.
        const destExists = fileExistsOnDisk(finalPath);
        if (destExists) {
          findings.push(
            makeFinding({
              type: "redirect-hop-internal-link",
              summary: `${page.file} links to "${href}", which redirects to "${finalPath}" instead of linking there directly.`,
              pages: [page.file],
              evidence: [
                { file: page.file, field: "internalLinks", value: href },
                { file: "vercel.json", field: "redirects", value: `${normalized} -> ${finalPath}` },
              ],
              recommendation: `Update the href in ${page.file} to point directly at /${finalPath === "index.html" ? "" : finalPath} to avoid an unnecessary redirect hop.`,
              autoFix: {
                kind: "rewrite-href",
                file: page.file,
                from: href,
                to: finalPath === "index.html" ? "/" : "/" + finalPath,
              },
            })
          );
          continue;
        }
      }

      // Not a real file, and not (fully) covered by a redirect.
      const caseMatch = findCaseInsensitiveMatch(normalized);
      if (caseMatch) {
        findings.push(
          makeFinding({
            type: "broken-internal-link-fixable",
            summary: `${page.file} links to "${href}", which does not exist, but "${caseMatch}" does (case/typo mismatch).`,
            pages: [page.file],
            evidence: [
              { file: page.file, field: "internalLinks", value: href },
              { file: caseMatch, field: "existsOnDisk", value: true },
            ],
            recommendation: `Update the href in ${page.file} from "${href}" to match the actual file "${caseMatch}".`,
            autoFix: {
              kind: "rewrite-href",
              file: page.file,
              from: href,
              to: href.replace(path.basename(normalized), path.basename(caseMatch)),
            },
          })
        );
      } else {
        findings.push(
          makeFinding({
            type: "broken-internal-link",
            summary: `${page.file} links to "${href}", which does not resolve to any file or redirect.`,
            pages: [page.file],
            evidence: [{ file: page.file, field: "internalLinks", value: href }],
            recommendation: `Confirm the intended destination for "${href}" in ${page.file} and correct or remove the link.`,
          })
        );
      }
    }
  }

  // Orphan pages: scanned pages never referenced by any other page's links.
  for (const page of pages) {
    if (page.file === "index.html") continue;
    const referenced = [...linkedTargets].some(
      (t) => t === page.file || t === page.file.replace(/\.html$/, "")
    );
    if (!referenced) {
      findings.push(
        makeFinding({
          type: "orphan-page",
          summary: `${page.file} is not linked from any other scanned page.`,
          pages: [page.file],
          evidence: [{ file: page.file, field: "inboundLinks", value: 0 }],
          recommendation: `Confirm whether ${page.file} should be reachable via internal navigation, or is intentionally unlinked (e.g. a legal page).`,
        })
      );
    }
  }

  return findings;
}

function auditSitemapAndRobots(pages) {
  const findings = [];
  const sitemapUrls = loadSitemapUrls();
  const sitemapPaths = new Set(
    sitemapUrls.map((u) => normalizeHref(u.replace(config.SITE_ORIGIN, "")))
  );
  const pageFiles = new Set(pages.map((p) => p.file));
  const cleanUrlMap = buildRewriteCleanUrlMap();

  for (const loc of sitemapUrls) {
    const relPath = normalizeHref(loc.replace(config.SITE_ORIGIN, ""));
    if (!fileExistsOnDisk(relPath)) {
      findings.push(
        makeFinding({
          type: "sitemap-missing-file",
          summary: `sitemap.xml lists ${loc}, which does not correspond to an existing file.`,
          pages: ["sitemap.xml"],
          evidence: [{ file: "sitemap.xml", field: "loc", value: loc }],
          recommendation: `Confirm whether ${loc} should exist, or remove it from sitemap.xml.`,
        })
      );
    }
  }

  for (const file of pageFiles) {
    const cleanUrl = cleanUrlMap.get(file);
    const inSitemap = sitemapPaths.has(file) || (cleanUrl && sitemapPaths.has(cleanUrl));
    if (!inSitemap) {
      const expectedUrl = cleanUrl ? "/" + cleanUrl : "/" + file;
      findings.push(
        makeFinding({
          type: "sitemap-missing-url",
          summary: `${file} exists and is not excluded by robots.txt, but is not listed in sitemap.xml.`,
          pages: [file],
          evidence: [{ file: "sitemap.xml", field: "contains", value: false }],
          recommendation: `Consider adding ${expectedUrl} to sitemap.xml if it should be indexed.`,
        })
      );
    }
  }

  const disallows = loadRobotsDisallows();
  for (const loc of sitemapUrls) {
    const relPath = "/" + normalizeHref(loc.replace(config.SITE_ORIGIN, ""));
    for (const dis of disallows) {
      if (dis !== "/" && relPath.startsWith(dis)) {
        findings.push(
          makeFinding({
            type: "robots-sitemap-conflict",
            summary: `${loc} is listed in sitemap.xml but falls under robots.txt's "Disallow: ${dis}".`,
            pages: ["sitemap.xml", "robots.txt"],
            evidence: [
              { file: "sitemap.xml", field: "loc", value: loc },
              { file: "robots.txt", field: "disallow", value: dis },
            ],
            recommendation: `Resolve the conflict: either remove ${loc} from the sitemap, or adjust the Disallow rule.`,
          })
        );
      }
    }
  }

  return findings;
}

module.exports = {
  normalizeHref,
  loadRedirects,
  loadRewrites,
  buildRewriteCleanUrlMap,
  loadSitemapUrls,
  loadRobotsDisallows,
  auditLinks,
  auditSitemapAndRobots,
};
