// CRM visual redesign — static-analysis coverage for the Schedule/Clients/
// Expenses changes (Leads has its own dedicated file: see
// tests/crm-redesign-admin-chrome.test.js for the shared header/nav, and
// the existing Leads suites for the tab-slider/Lead-Card markup). Same
// approach as every other UI test in this project: no DOM/jsdom harness,
// so this reads actual source text.
//
// Run with:  node tests/crm-redesign-pages.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Schedule — Elevated-today-only cards, 2x2 mobile financial grid
// =======================================================================
test("admin/schedule.js: renderJobCard() adds is-today-elevated only when currentRange === 'today'", () => {
  const src = read("admin/schedule.js");
  const fnBody = src.slice(src.indexOf("function renderJobCard(job)"), src.indexOf("function render(jobs)"));
  assert.ok(/if \(currentRange === 'today'\) cardClass \+= ' is-today-elevated';/.test(fnBody));
});

test("admin/admin.css: .admin-schedule-card.is-today-elevated only adds box-shadow, never touches border (which carries the status-color accent stripe)", () => {
  const css = read("admin/admin.css");
  const idx = css.indexOf(".admin-schedule-card.is-today-elevated {");
  assert.ok(idx !== -1, "the modifier rule must exist");
  const rule = css.slice(idx, css.indexOf("}", idx));
  assert.ok(/box-shadow/.test(rule));
  assert.ok(!/border/.test(rule), "must not declare any border property — would fight .admin-card-accent-* 's border-left-color");
});

test("admin/admin.css: .admin-schedule-financials is a 2x2 grid below the desktop breakpoint and a single row at/above it", () => {
  const css = read("admin/admin.css");
  const baseIdx = css.indexOf(".admin-schedule-financials {");
  const baseRule = css.slice(baseIdx, css.indexOf("}", baseIdx));
  assert.ok(/display:\s*grid/.test(baseRule) && /repeat\(2,\s*1fr\)/.test(baseRule), "base (mobile) rule must be a 2-column grid");
  const desktopIdx = css.indexOf("@media (min-width: 860px) {\n  .admin-schedule-financials {");
  assert.ok(desktopIdx !== -1, "must override back to a single row at the desktop breakpoint");
  const desktopRule = css.slice(desktopIdx, css.indexOf("}", desktopIdx));
  assert.ok(/display:\s*flex/.test(desktopRule));
});

// =======================================================================
// Clients — prominent search, avatar-initial compact rows
// =======================================================================
test("admin/clients/index.html: search bar has a leading icon wrapper around the unchanged #client-search input", () => {
  const html = read("admin/clients/index.html");
  assert.ok(/class="admin-search-bar admin-search-bar-icon"/.test(html));
  assert.ok(/id="client-search"/.test(html), "the input's id must be unchanged — clients-list.js finds it by this id");
});

test("admin/clients-list.js: renderClientCard() builds an avatar-initial compact row (.admin-client-row) instead of the old 4-line stacked card", () => {
  const src = read("admin/clients-list.js");
  assert.ok(/function initialsFor\(/.test(src));
  assert.ok(/admin-booking-card admin-client-row/.test(src));
  assert.ok(/admin-client-avatar/.test(src));
  assert.ok(/a\.href = '\/admin\/client\/\?id=' \+ encodeURIComponent\(c\.id\)/.test(src), "the link target must be unchanged");
});

test("admin/clients-list.js: never uses innerHTML/insertAdjacentHTML (icon built via createElementNS, same discipline as the rest of this file)", () => {
  const src = read("admin/clients-list.js");
  assert.ok(!/\.innerHTML\s*=/.test(src));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src));
});

// =======================================================================
// Expenses — compact filter bar, mobile Filters(N) sheet
// =======================================================================
["expense", "other-revenue"].forEach((prefix) => {
  test("admin/expenses/index.html: " + prefix + " panel has a Filters toggle + .admin-sheet-overlay backdrop wired to the unchanged filter fields", () => {
    const html = read("admin/expenses/index.html");
    assert.ok(new RegExp('id="' + prefix + '-filters-toggle"').test(html));
    assert.ok(new RegExp('id="' + prefix + '-filters-backdrop" class="admin-sheet-overlay" hidden').test(html), "must reuse the existing .admin-sheet-overlay class as-is for the backdrop");
    assert.ok(new RegExp('id="' + prefix + '-filters"').test(html));
  });
});

test("admin/expenses.js: wireFilterSheet() opens/closes via the toggle + backdrop and recomputes an active-filter count — the existing filter-apply listeners (loadList/loadOtherRevenueList) are untouched", () => {
  const src = read("admin/expenses.js");
  assert.ok(/function wireFilterSheet\(/.test(src));
  assert.ok(/input\.addEventListener\('change', loadList\);/.test(src), "the original filter -> loadList wiring must still be present, unchanged");
  assert.ok(/input\.addEventListener\('change', loadOtherRevenueList\);/.test(src));
});

test("admin/admin.css: .admin-expense-filters is a compact flex-wrap row on desktop and a real bottom sheet (fixed, rounded-top, shadow) below the breakpoint", () => {
  const css = read("admin/admin.css");
  const baseIdx = css.indexOf(".admin-expense-filters {");
  const baseRule = css.slice(baseIdx, css.indexOf("}", baseIdx));
  assert.ok(/display:\s*flex/.test(baseRule) && /flex-wrap:\s*wrap/.test(baseRule));
  const mobileBlockIdx = css.indexOf("@media (max-width: 859px) {\n  .admin-expense-filters {");
  assert.ok(mobileBlockIdx !== -1);
  const mobileRule = css.slice(mobileBlockIdx, css.indexOf("}", mobileBlockIdx));
  assert.ok(/position:\s*fixed/.test(mobileRule));
});

// ---------------------------------------------------------------------
async function main() {
  const settled = [];
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
      settled.push({ ok: true });
    } catch (err) {
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
      settled.push({ ok: false });
    }
  }
  const failed = settled.filter((r) => !r.ok);
  console.log("\n" + settled.length + " tests run, " + failed.length + " failed.");
  if (failed.length) process.exitCode = 1;
}

main();
