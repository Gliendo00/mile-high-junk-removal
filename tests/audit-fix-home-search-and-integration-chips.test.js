// CRM cleanup/verification audit (2026-10-21) — static checks for two
// unrelated UI fixes that happen to share this file for convenience:
//   1. admin/home.js's global client search (was a disabled "Coming
//      soon" visual shell, now wired to the existing GET
//      /api/admin/clients search endpoint — same contract admin/
//      clients-list.js and admin/client-picker.js already use).
//   2. admin/website-agent.js's GSC/GA4 integration chips (now a real
//      4-state status — connected/error/stale/not_configured — instead
//      of a plain configured-or-not boolean).
//
// No DOM/browser here — this project's convention for client JS it can't
// run headlessly is a source-level static-analysis guard (see e.g.
// tests/website-agent-dashboard-ui.test.js).
//
// Run with:  node tests/audit-fix-home-search-and-integration-chips.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

const homeJs = fs.readFileSync(path.join(__dirname, "..", "admin", "home.js"), "utf8");
const homeHtml = fs.readFileSync(path.join(__dirname, "..", "admin", "home", "index.html"), "utf8");
const waJs = fs.readFileSync(path.join(__dirname, "..", "admin", "website-agent.js"), "utf8");

// -----------------------------------------------------------------------
// 1. Home global client search
// -----------------------------------------------------------------------

test("admin/home/index.html: the search input is no longer disabled, and the 'Coming soon' badge/Ask button elements are gone (explanatory HTML comments mentioning the old behavior are fine — only the rendered elements matter)", () => {
  assert.ok(!/id="search-whisperer-input"[^>]*\bdisabled\b/.test(homeHtml), "the search input must no longer carry the disabled attribute");
  assert.ok(!/id="search-whisperer-note"/.test(homeHtml), "the 'Coming soon' badge element must be removed now that search is operational");
  assert.ok(!/admin-home-search-ask/.test(homeHtml), "the inert 'Ask' button must be removed");
});

test("admin/home/index.html: a results panel exists for the search box, reusing the existing .admin-typeahead-panel/.admin-picker-results classes rather than a new component", () => {
  assert.ok(/id="search-whisperer-panel"[^>]*class="admin-typeahead-panel"/.test(homeHtml));
  assert.ok(/id="search-whisperer-results"[^>]*class="admin-picker-results"/.test(homeHtml));
});

test("admin/home.js: the search is wired to the EXISTING GET /api/admin/clients endpoint — not a second search system", () => {
  assert.ok(/\/api\/admin\/clients\?limit=/.test(homeJs));
  assert.ok(/search=/.test(homeJs));
  assert.ok(/adminFetch\(/.test(homeJs), "must use the shared adminFetch() wrapper, same as every other admin page");
});

test("admin/home.js: the search is debounced and cancels a still-in-flight request before starting a newer one (AbortController), same pattern as admin/client-picker.js", () => {
  const searchBlock = homeJs.slice(homeJs.indexOf("function initSearch"));
  assert.ok(/setTimeout\(function \(\) \{\s*runSearch\(value\);\s*\}, SEARCH_DEBOUNCE_MS\)/.test(searchBlock));
  assert.ok(/new AbortController\(\)/.test(searchBlock));
  assert.ok(/abortInFlightSearch/.test(searchBlock));
});

test("admin/home.js: a result click navigates to the correct client profile route, matching admin/client-detail.js's own getClientId() contract", () => {
  assert.ok(/\/admin\/client\/\?id=' \+ encodeURIComponent\(c\.id\)/.test(homeJs));
});

test("admin/home.js: a 401 from the search endpoint redirects to login, never silently renders an empty 'no results' state", () => {
  const searchBlock = homeJs.slice(homeJs.indexOf("function initSearch"));
  assert.ok(/res\.status === 401/.test(searchBlock));
  assert.ok(/\/admin\/login\//.test(searchBlock));
});

test("admin/home.js: clearing the search input closes the panel and aborts any in-flight request, rather than leaving a stale result list open", () => {
  const searchBlock = homeJs.slice(homeJs.indexOf("function initSearch"));
  assert.ok(/if \(!value\) \{\s*abortInFlightSearch\(\);\s*closePanel\(\);/.test(searchBlock));
});

test("admin/home.js: Escape and an outside click both close the results panel — a single document-level listener each, same as admin/client-picker.js's own pattern (works identically for touch and mouse)", () => {
  const searchBlock = homeJs.slice(homeJs.indexOf("function initSearch"));
  assert.ok(/key === 'Escape'/.test(searchBlock));
  assert.ok(/addEventListener\('mousedown'/.test(searchBlock));
});

test("admin/home.js's search wiring never uses innerHTML/insertAdjacentHTML/document.write", () => {
  const searchBlock = homeJs.slice(homeJs.indexOf("function initSearch"), homeJs.indexOf("function initSearch") + 5000);
  assert.strictEqual(/innerHTML|insertAdjacentHTML|document\.write/.test(searchBlock), false);
});

// -----------------------------------------------------------------------
// 2. GSC/GA4 integration chips — 4-state status
// -----------------------------------------------------------------------

test("admin/website-agent.js's buildIntegrationChip() renders all 4 states (connected/error/stale/not_configured), not just a 2-state boolean", () => {
  assert.ok(/connected:\s*'CONNECTED'/.test(waJs));
  assert.ok(/error:\s*'ERROR'/.test(waJs));
  assert.ok(/stale:\s*'STALE'/.test(waJs));
  assert.ok(/not_configured:\s*'NOT CONFIGURED'/.test(waJs));
});

test("admin/website-agent.js's buildIntegrationChip() accepts EITHER a {state,...} object (GSC/GA4) or a plain boolean (CRM DATA/PROPOSAL SYNC) — backward compatible for the two integrations that stay simple booleans", () => {
  const fn = waJs.slice(waJs.indexOf("function buildIntegrationChip"), waJs.indexOf("function buildIntegrationChip") + 900);
  assert.ok(/typeof value === 'object'/.test(fn));
});

test("admin/website-agent.js never collapses an ERROR reason into an opaque chip — the reason string (when present) is exposed via a title attribute for the admin to actually read", () => {
  const fn = waJs.slice(waJs.indexOf("function buildIntegrationChip"), waJs.indexOf("function buildIntegrationChip") + 900);
  assert.ok(/chip\.title = reason/.test(fn));
});
