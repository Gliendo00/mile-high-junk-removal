// Site Improvement Agent — internal-linking audit.
//
// Looks at CONTEXTUAL links only — links that appear in a page's own
// written body content, not the shared header/nav/footer chrome every
// page carries identically (see scan.js's stripChrome()/
// contextualInternalLinks header for why that distinction matters: the
// global nav already "links everywhere," so counting it would make
// every page look equally well-supported regardless of its own content).
//
// Deliberately conservative, per the product spec: this never proposes
// adding a link "for SEO." weak-internal-support is an OBSERVATION (see
// risk.js) — a real, recorded fact, not an instruction to go add links.
// missing-contextual-link only fires for the one relationship explicitly
// in scope (a city page with literally zero contextual link to ANY
// general service page) and is a category-B opportunity, still never
// auto-applied.

const { makeFinding } = require("./findings");
const { isCityPage, SERVICE_PAGE_FILES } = require("./page-groups");

// Below this many contextual (non-chrome) inbound links, a page is
// relying almost entirely on the global nav to be found — worth
// recording, not necessarily worth action (plenty of legitimate pages
// are nav-only destinations, e.g. a single utility page).
const WEAK_INTERNAL_SUPPORT_THRESHOLD = 2;

function normalizeTarget(href) {
  let clean = href.split("#")[0].split("?")[0];
  if (clean.startsWith("/")) clean = clean.slice(1);
  if (clean === "" || clean === "/") return "index.html";
  return clean;
}

function auditInternalLinking(pages) {
  const findings = [];
  const contextualInboundCount = new Map();
  for (const page of pages) contextualInboundCount.set(page.file, 0);

  for (const page of pages) {
    const targets = new Set((page.contextualInternalLinks || []).map(normalizeTarget));
    for (const target of targets) {
      if (contextualInboundCount.has(target)) {
        contextualInboundCount.set(target, contextualInboundCount.get(target) + 1);
      }
    }
  }

  for (const page of pages) {
    if (page.file === "index.html") continue; // the homepage is linked everywhere by design
    const count = contextualInboundCount.get(page.file) || 0;
    if (count < WEAK_INTERNAL_SUPPORT_THRESHOLD) {
      findings.push(
        makeFinding({
          type: "weak-internal-support",
          summary: `${page.file} receives contextual (body-content) links from only ${count} other page(s) — most of its reach depends on the global nav alone.`,
          pages: [page.file],
          evidence: [{ field: "contextualInboundLinks", value: count, file: page.file }],
          recommendation: `Consider whether ${page.file} would naturally benefit from a contextual mention on a related page — only where it would make sense to an actual visitor, not purely for internal-linking volume.`,
        })
      );
    }
  }

  // The one specific relationship explicitly in scope: a city page with
  // no contextual link at all to any general service page, meaning a
  // visitor reading that city page's own content has no path into what
  // services are actually offered beyond the global nav.
  const cityPages = pages.filter((p) => isCityPage(p.file));
  for (const page of cityPages) {
    const targets = new Set((page.contextualInternalLinks || []).map(normalizeTarget));
    const hasServiceLink = SERVICE_PAGE_FILES.some((f) => targets.has(f));
    if (!hasServiceLink) {
      findings.push(
        makeFinding({
          type: "missing-contextual-link",
          summary: `${page.file} has no contextual link to any general service page (e.g. ${SERVICE_PAGE_FILES[0]}), unlike its comparable city-page siblings.`,
          pages: [page.file],
          evidence: [{ field: "contextualServiceLinks", value: [], file: page.file }],
          recommendation: `If it would read naturally to a visitor, consider a contextual link from ${page.file} to a relevant service page — not purely for SEO.`,
        })
      );
    }
  }

  return findings;
}

module.exports = { auditInternalLinking, WEAK_INTERNAL_SUPPORT_THRESHOLD, normalizeTarget };
