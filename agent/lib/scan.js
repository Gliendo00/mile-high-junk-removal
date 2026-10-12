// Site Improvement Agent — page scanner.
//
// Pure, read-only, synchronous: reads every top-level *.html file and
// extracts the structural facts other modules reason about. Never fetches
// the network, never writes anything. Every field here is literally
// present in the file — there is no inference or generation, so a
// PageRecord can never itself be a fabrication.

const fs = require("fs");
const path = require("path");
const config = require("../config");

function listPageFiles() {
  return fs
    .readdirSync(config.PAGE_GLOB_DIR)
    .filter((name) => name.endsWith(".html"))
    .filter((name) => !config.EXCLUDED_DIRS.has(name))
    .sort();
}

function urlForFile(file) {
  if (file === "index.html") return config.SITE_ORIGIN + "/";
  return config.SITE_ORIGIN + "/" + file;
}

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractTitle(html) {
  return decodeEntities(firstMatch(html, /<title>([\s\S]*?)<\/title>/i));
}

function extractMeta(html, name) {
  const re = new RegExp(
    `<meta\\s+name=["']${name}["']\\s+content=["']([\\s\\S]*?)["']\\s*/?>`,
    "i"
  );
  let value = firstMatch(html, re);
  if (value) return decodeEntities(value);
  // Attribute order can be reversed (content before name) — handle both.
  const reReversed = new RegExp(
    `<meta\\s+content=["']([\\s\\S]*?)["']\\s+name=["']${name}["']\\s*/?>`,
    "i"
  );
  return decodeEntities(firstMatch(html, reReversed));
}

function extractCanonical(html) {
  return firstMatch(
    html,
    /<link\s+rel=["']canonical["']\s+href=["']([\s\S]*?)["']\s*\/?>/i
  );
}

function extractH1s(html) {
  const matches = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)];
  return matches.map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "").trim()));
}

function extractJsonLdBlocks(html) {
  const matches = [
    ...html.matchAll(
      /<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi
    ),
  ];
  const blocks = [];
  for (const m of matches) {
    try {
      blocks.push(JSON.parse(m[1]));
    } catch (e) {
      blocks.push({ __parseError: e.message });
    }
  }
  return blocks;
}

function extractInternalLinks(html) {
  const matches = [...html.matchAll(/<a\s+[^>]*href=["']([^"']+)["']/gi)];
  const links = [];
  for (const m of matches) {
    const href = m[1].trim();
    if (!href) continue;
    if (/^(https?:)?\/\//i.test(href) && !href.includes("milehighjunkremoval.net")) {
      continue; // external link
    }
    if (/^(mailto:|tel:|sms:|javascript:|#)/i.test(href)) continue;
    links.push(href);
  }
  return links;
}

// Strips the shared global chrome — the <header> (which on every page
// here contains the full nav, including the services dropdown and
// mobile menu) and <footer> — plus any other top-level <nav> (e.g. a
// breadcrumb trail), leaving only the page's own body content. Used to
// separate "linked from this page's nav/footer, which is identical on
// every page" from "linked from this page's own written content" — the
// latter is the actual contextual-relevance signal internal-linking.js
// cares about; the former tells us nothing about THIS page's content.
function stripChrome(html) {
  return html
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ");
}

// Every tel: link on the page, raw (e.g. "tel:+13039901812") — used by
// factual-consistency-audit.js to check the phone number is the same
// everywhere, and by ux-audit.js to confirm a phone CTA actually exists.
function extractTelLinks(html) {
  const matches = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)];
  return [...new Set(matches.map((m) => m[1].trim()))];
}

function wordCount(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ");
  const words = text.split(/\s+/).filter(Boolean);
  return words.length;
}

function scanPage(file) {
  const fullPath = path.join(config.PAGE_GLOB_DIR, file);
  const html = fs.readFileSync(fullPath, "utf8");
  const stat = fs.statSync(fullPath);
  return {
    file,
    url: urlForFile(file),
    title: extractTitle(html),
    metaDescription: extractMeta(html, "description"),
    canonical: extractCanonical(html),
    h1s: extractH1s(html),
    jsonLd: extractJsonLdBlocks(html),
    internalLinks: extractInternalLinks(html),
    // Phase 3 — internal-linking-audit.js's contextual-relevance signal:
    // links found OUTSIDE the shared header/nav/footer chrome (which is
    // identical on every page and therefore says nothing about THIS
    // page's own content). See stripChrome()'s header comment.
    contextualInternalLinks: extractInternalLinks(stripChrome(html)),
    telLinks: extractTelLinks(html),
    wordCount: wordCount(html),
    mtime: stat.mtime.toISOString(),
    bytes: stat.size,
  };
}

function scanAllPages() {
  return listPageFiles().map(scanPage);
}

module.exports = {
  listPageFiles,
  urlForFile,
  scanPage,
  scanAllPages,
};
