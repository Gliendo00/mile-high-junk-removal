// Site Improvement Agent — shared configuration.
//
// Deliberately tiny: the agent scans the public marketing pages of this
// repo (top-level *.html — the admin/booking apps are explicitly excluded,
// since they are product surface, not marketing content) plus the handful
// of site-wide files that describe them (sitemap.xml, robots.txt,
// vercel.json's redirects, nav.js). See agent/README.md for the full
// architecture.

const path = require("path");

const SITE_ROOT = path.resolve(__dirname, "..");

module.exports = {
  SITE_ROOT,

  // Only scan top-level HTML files — these are the public marketing pages.
  // admin/, book/, node_modules/, api/ are intentionally excluded: admin is
  // authenticated product surface, book/ is the booking app shell, and
  // neither is "content" an SEO agent should be proposing copy changes to.
  PAGE_GLOB_DIR: SITE_ROOT,
  EXCLUDED_DIRS: new Set(["admin", "book", "node_modules", "api", "agent", "tests", "docs", "sql", ".git", ".vercel"]),

  SITEMAP_PATH: path.join(SITE_ROOT, "sitemap.xml"),
  ROBOTS_PATH: path.join(SITE_ROOT, "robots.txt"),
  VERCEL_JSON_PATH: path.join(SITE_ROOT, "vercel.json"),

  HISTORY_LOG_PATH: path.join(SITE_ROOT, "agent", "history", "log.ndjson"),

  SITE_ORIGIN: "https://www.milehighjunkremoval.net",

  // Formulaic thresholds used by the SEO audit — these are widely-cited
  // technical conventions (SERP title/description truncation points), not
  // business facts, so they are safe to hardcode without research.
  TITLE_MIN: 15,
  TITLE_MAX: 65,
  DESCRIPTION_MIN: 50,
  DESCRIPTION_MAX: 160,

  // Phase 3 weak-finding fix (see agent/README.md's "Weak-finding
  // semantics" section): merely falling outside TITLE_MIN/MAX above is an
  // OBSERVATION, not grounds for a proposal — length alone isn't enough
  // evidence. These SEVERE thresholds are deliberately much wider than
  // the conventional window, representing "this plausibly hides the
  // page's distinguishing information in a search result, not just a
  // minor truncation risk" — crossing one of these escalates to an
  // actually-actionable "title-malformed"/"description-malformed"
  // finding instead of a mere observation.
  TITLE_SEVERE_MAX: 90,
  DESCRIPTION_SEVERE_MAX: 220,
};
