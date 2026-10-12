// Site Improvement Agent — UX/conversion audit (statically detectable
// only).
//
// This explicitly does NOT pretend static markup inspection replaces
// actual browser usability testing — it only flags what's reliably
// determinable from the HTML itself: whether a page's own body content
// contains a path to booking (not just the global nav, which is
// identical everywhere and tells us nothing page-specific), and whether
// a page is both thin AND has no such path — a real "dead end" page a
// visitor could land on with nothing obvious to do next. Both are
// OBSERVATIONS (see risk.js) — real, recorded facts, not confirmed UX
// failures; confirming an actual usability problem needs a human (or a
// browser) looking at the rendered page, not just its markup.

const { makeFinding } = require("./findings");
const { isUtilityPage } = require("./page-groups");
const { normalizeTarget } = require("./internal-linking-audit");

const THIN_PAGE_WORD_COUNT = 400;

function hasContextualBookingLink(page) {
  return (page.contextualInternalLinks || []).some((href) => normalizeTarget(href).startsWith("book/"));
}

function auditUx(pages) {
  const findings = [];

  for (const page of pages) {
    if (isUtilityPage(page.file)) continue; // e.g. privacy-policy.html — no conversion intent by design

    const hasBookingCta = hasContextualBookingLink(page);

    if (!hasBookingCta) {
      findings.push(
        makeFinding({
          type: "weak-cta",
          summary: `${page.file} has no contextual (body-content) link to the booking flow — only the global nav would get a visitor there.`,
          pages: [page.file],
          evidence: [{ field: "hasContextualBookingLink", value: false, file: page.file }],
          recommendation: `Confirm whether ${page.file} should have its own in-content call to action, or relies intentionally on the nav/sticky call bar.`,
        })
      );

      if (page.wordCount < THIN_PAGE_WORD_COUNT) {
        findings.push(
          makeFinding({
            type: "no-next-action",
            summary: `${page.file} is thin (${page.wordCount} words) AND has no contextual booking link — a visitor could land here with no obvious next step beyond the global nav.`,
            pages: [page.file],
            evidence: [
              { field: "wordCount", value: page.wordCount, file: page.file },
              { field: "hasContextualBookingLink", value: false, file: page.file },
            ],
            recommendation: `Review ${page.file} for whether it needs a clearer next action for a visitor.`,
          })
        );
      }
    }
  }

  return findings;
}

module.exports = { auditUx, THIN_PAGE_WORD_COUNT, hasContextualBookingLink };
