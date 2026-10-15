// Site Improvement Agent, Phase 10 -- Curated Official Source Evidence:
// the ONE module that touches the network to fetch a curated local
// source. Mirrors agent/lib/firstparty-fetch.js's architectural role
// exactly: never called by agent/runner.js/gatherFindings() (no network
// access there by design), invoked only via a separate, explicit CLI
// step (see agent/cli.js's --fetch-local-source-strict=).
//
// TIER A ONLY (Phase 1): fetches EXACTLY the `url` a
// local-source-registry.js entry declares -- never any other URL, never
// a caller-supplied override (fetchLocalSourceEvidence() takes a
// REGISTRY ENTRY OBJECT, never a raw URL string, so there is no
// parameter through which an arbitrary URL could ever reach this
// function), and never a URL discovered via a sitemap/search/redirect
// target. Redirects are NEVER followed (`redirect: "manual"`) -- if the
// registry's own known URL ever starts redirecting (to the same host OR
// a different one), that is treated as a `failed` outcome requiring a
// human to re-verify the registry entry, not as something to chase
// automatically.
//
// Robots.txt is fetched and checked exactly ONCE per call (one host per
// entry in Phase 1) -- see agent/README.md's Phase 10 "robots retrieval
// cadence" note for why once-per-invocation, reused for the single page
// fetched in that same call, is the chosen granularity. A fetch NEVER
// proceeds without an explicit robots ALLOW.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { checkRobots, isAllowedByRobots } = require("./robots");
const { makeLocalSourceEvidence, MAX_SNIPPET_CHARS } = require("./local-source-evidence");

const EVIDENCE_DIR = path.join(config.SITE_ROOT, "agent", "research", "local-sources");

// Identifies this agent honestly to any site operator who looks at
// their own access logs, with a real contact address -- see
// agent/README.md's Phase 10 "privacy/rate-limit" section. Never
// masquerades as a browser.
const USER_AGENT = "MileHighJunkRemovalAgent/1.0 (+contact@milehighjunkremoval.net)";

const FETCH_TIMEOUT_MS = 10000;

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Bounded, mechanical text extraction -- the same spirit as
 * agent/lib/scan.js's own regex-based extraction of THIS site's HTML
 * (no DOM/HTML-parser dependency added), applied to a third-party page
 * we do not control the structure of. Deliberately NOT structured field
 * extraction: this strips markup to plain text and nothing more. Never
 * parses dates/program rules into claimed structured facts (see
 * agent/README.md's Phase 10 section on why that stays a human/Claude
 * judgment call).
 */
function stripHtmlToText(html) {
  return String(html)
    // <head> (title/meta/head-scripts) is never visible page content a
    // visitor actually reads, and its <title> text frequently CONTAINS
    // the body's own <h1> text as a prefix (e.g. "H1 Text - Site Name")
    // -- leaving it in would make extractAnchorText()'s own anchor
    // match at position 0 every time, defeating the whole point of
    // anchoring past the nav/header chrome below.
    .replace(/<head[\s\S]*?<\/head>/i, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(?:#39|rsquo|lsquo|apos);/gi, "'")
    .replace(/&(?:ndash|mdash);/gi, "-")
    .replace(/&(?:quot|rdquo|ldquo);/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Same regex idiom agent/lib/scan.js already uses to read THIS site's
// own <h1> (never a new HTML-parser dependency) -- used here only to
// pick a better STARTING POINT for the bounded snippet, never to assert
// a structured fact. A real municipal page's content typically sits
// well past its own nav/header chrome; anchoring on the page's own H1
// (falling back to <title>) keeps the snippet honest while making it
// actually about the page's real topic instead of mostly nav boilerplate.
function firstMatch(html, re) {
  const m = html.match(re);
  return m ? m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
}

function extractAnchorText(html) {
  return firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
}

/**
 * Bounds `text` to at most `maxChars`, starting from wherever `anchor`
 * (a short phrase expected to appear verbatim in `text`, e.g. the page's
 * own H1) is first found -- or from the start if no anchor was found or
 * it doesn't appear in the stripped text at all (never throws, never
 * assumes).
 */
function boundSnippet(text, anchor, maxChars = MAX_SNIPPET_CHARS) {
  let start = 0;
  if (anchor) {
    const idx = text.indexOf(anchor);
    if (idx > -1) start = idx;
  }
  return text.slice(start, start + maxChars);
}

async function fetchWithTimeout(url, options, fetchImpl, timeoutMs) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await doFetch(url, { ...options, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} entry - a local-source-registry.js entry (from getEntryById()) -- NEVER a raw URL string
 * @param {object} [options]
 * @param {function} [options.fetchImpl] - injectable for tests
 * @param {Date} [options.now]
 * @param {number} [options.robotsTimeoutMs]
 * @param {number} [options.fetchTimeoutMs]
 * @returns {Promise<{skipped:true, reason:string, robots?:object}|{skipped:false, evidence:object}>}
 */
async function fetchLocalSourceEvidence(entry, options = {}) {
  const fetchImpl = options.fetchImpl;
  const now = options.now || new Date();

  if (!entry || typeof entry !== "object") {
    return { skipped: true, reason: "fetchLocalSourceEvidence requires a registry entry object" };
  }

  let targetUrl;
  try {
    targetUrl = new URL(entry.url);
  } catch (e) {
    return { skipped: true, reason: `registry entry "${entry.id}" has an unparsable url` };
  }

  const robotsResult = await checkRobots({
    origin: `${targetUrl.protocol}//${targetUrl.host}`,
    fetchImpl,
    timeoutMs: options.robotsTimeoutMs,
  });
  const robotsCheckedAt = now.toISOString();

  if (!robotsResult.ok) {
    return { skipped: true, reason: `robots.txt check failed for ${targetUrl.host}: ${robotsResult.reason}`, robots: { checkedAt: robotsCheckedAt, allowed: false } };
  }
  const allowed = isAllowedByRobots(robotsResult.blocks, USER_AGENT, targetUrl.pathname);
  if (!allowed) {
    return { skipped: true, reason: `robots.txt disallows "${targetUrl.pathname}" for this agent on ${targetUrl.host}`, robots: { checkedAt: robotsCheckedAt, allowed: false } };
  }

  let response;
  try {
    response = await fetchWithTimeout(targetUrl.toString(), { headers: { "User-Agent": USER_AGENT } }, fetchImpl, options.fetchTimeoutMs);
  } catch (e) {
    return { skipped: true, reason: `fetch failed: ${e && e.message ? e.message : e}`, robots: { checkedAt: robotsCheckedAt, allowed: true } };
  }

  if (response.status >= 300 && response.status < 400) {
    return {
      skipped: true,
      reason: `unexpected redirect (HTTP ${response.status}) — the registry's known URL no longer resolves directly; this must never be followed automatically, re-verify the registry entry`,
      robots: { checkedAt: robotsCheckedAt, allowed: true },
    };
  }
  if (!response.ok) {
    return { skipped: true, reason: `unexpected HTTP ${response.status} fetching ${targetUrl.toString()}`, robots: { checkedAt: robotsCheckedAt, allowed: true } };
  }

  let html;
  try {
    html = await response.text();
  } catch (e) {
    return { skipped: true, reason: `could not read response body: ${e && e.message ? e.message : e}`, robots: { checkedAt: robotsCheckedAt, allowed: true } };
  }

  const text = stripHtmlToText(html);
  if (!text) {
    return { skipped: true, reason: "page returned no extractable text content", robots: { checkedAt: robotsCheckedAt, allowed: true } };
  }
  const anchor = extractAnchorText(html);

  const evidence = makeLocalSourceEvidence({
    sourceUrl: entry.url,
    sourceDomain: entry.domain,
    authorityClass: entry.authorityClass,
    locality: entry.locality,
    topic: entry.topic,
    discoveryMethod: "known-url",
    retrievedAt: now.toISOString(),
    extractedSnippet: boundSnippet(text, anchor),
    expectedTemporality: entry.expectedTemporality,
    limitations:
      "A single, bounded text snippet mechanically extracted from one retrieval of this page — not a structured fact, not a verdict, and not confirmation that this remains the program's current/correct information. A human (or Claude session) must read this snippet and the live page itself before treating anything in it as a confirmed fact for site copy. Dates/locations for a temporary program are never safe to hardcode as evergreen text from this alone.",
    robots: { checkedAt: robotsCheckedAt, allowed: true },
  });

  return { skipped: false, evidence };
}

/**
 * Writes one evidence entry to its own file under
 * agent/research/local-sources/ — one file per fetch (never overwritten
 * — same convention as firstparty-fetch.js's writeFirstPartyEvidence()).
 */
function writeLocalSourceEvidence(evidence, outFile, dir = EVIDENCE_DIR) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fileName = outFile || `${slugify(evidence.sourceDomain)}__${slugify(evidence.topic)}-${Date.now()}.json`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  return filePath;
}

module.exports = {
  fetchLocalSourceEvidence,
  writeLocalSourceEvidence,
  stripHtmlToText,
  extractAnchorText,
  boundSnippet,
  EVIDENCE_DIR,
  USER_AGENT,
  FETCH_TIMEOUT_MS,
};
