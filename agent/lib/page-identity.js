// Site Improvement Agent — shared page-identity normalization.
//
// Comparing "this finding's own page" (a repo-relative file name, e.g.
// "privacy-policy.html" — see findings.js's header) against a page
// identifier returned by an external API (Search Console's own "page"
// dimension, which returns a fully-qualified URL) needs ONE shared,
// tested normalization rather than each caller re-deriving its own.
// Handles:
//   - a full URL (any scheme/host) -> its path, leading/trailing
//     slashes stripped
//   - a bare path/file name -> used as-is, leading/trailing slashes
//     stripped
//   - an empty path ("/", "", or a bare host with no path) ->
//     "index.html", matching this repo's own homepage file-name
//     convention
// Deliberately permissive about host/scheme/www differences (http vs
// https, www vs apex, trailing slash) — this is an IDENTITY comparison
// ("is this the same page?"), not a canonicalization/SEO check
// (agent/lib/seo-audit.js already owns canonical-tag correctness; this
// module has no opinion on it and makes no claim about which form is
// "correct").

function normalizePageIdentifierForComparison(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let pathPart = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pathPart)) {
    try {
      pathPart = new URL(pathPart).pathname;
    } catch (e) {
      // Looked like a URL but failed to parse — fall through and treat
      // the original string as a plain path rather than guessing.
    }
  }
  pathPart = pathPart.replace(/^\/+/, "").replace(/\/+$/, "");
  if (pathPart === "") pathPart = "index.html";
  return pathPart.toLowerCase();
}

module.exports = { normalizePageIdentifierForComparison };
