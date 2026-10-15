// CRM visual redesign — shared admin-chrome.js (header/nav/mobile bottom
// nav), now the single source of truth for /admin nav instead of 13
// hand-duplicated copies of the same static markup. Same static-analysis
// approach as every other UI test in this suite (no DOM/jsdom harness).
//
// Run with:  node tests/crm-redesign-admin-chrome.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function readNormalized(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

const ALL_ADMIN_PAGES = [
  "admin/index.html",
  "admin/leads/index.html",
  "admin/clients/index.html",
  "admin/expenses/index.html",
  "admin/booking/index.html",
  "admin/booking-new/index.html",
  "admin/booking-edit/index.html",
  "admin/booking-past/index.html",
  "admin/client/index.html",
  "admin/intake/index.html",
  "admin/intakes/index.html",
  "admin/intake-new/index.html",
  "admin/requests/index.html",
];

const chromeSrc = readNormalized("admin/admin-chrome.js");

test("admin-chrome.js never writes user/server-supplied data — only innerHTML's its own fixed nav strings", () => {
  // This file IS allowed to use innerHTML (unlike the rest of this project's
  // admin/*.js) because every string it builds is a hardcoded nav
  // destination, never anything from the server or a user. Guard that
  // invariant by making sure it never touches fetch/API response data.
  assert.ok(!/adminFetch|fetch\(/.test(chromeSrc), "admin-chrome.js must not fetch any data — it only renders the fixed nav shell");
});

// UPDATED (mobile nav/More-menu refinement pass, 2026-10-11): the bottom
// nav is no longer a 1:1 mirror of the desktop nav — it's now 4 direct
// links (Home/Schedule/Leads/Clients) plus a "More" button that opens a
// sheet containing Expenses/Other Revenue/Log Out. Desktop's inline nav is
// completely unchanged (still all 6 SECTIONS via SECTIONS.map, same order).
// The invariant this test protects — "bottom nav items are never
// separately hardcoded, they're looked up from the same SECTIONS list" —
// still holds, just via a SECTIONS-built lookup map (bySectionKey) instead
// of a direct .map() over the whole list, since the bottom nav now shows
// only a subset.
test("admin-chrome.js: desktop nav still derives from the SECTIONS list (unchanged)", () => {
  const desktopFn = chromeSrc.match(/function buildDesktopNav[\s\S]*?\n  \}/)[0];
  assert.ok(/SECTIONS\.map/.test(desktopFn), "desktop nav must derive from the SECTIONS list, not hardcoded markup");
});
test("admin-chrome.js: bottom nav's 4 link items are looked up from a SECTIONS-built map, not separately hardcoded", () => {
  const bottomFn = chromeSrc.match(/function buildBottomNav[\s\S]*?\n  \}/)[0];
  assert.ok(/SECTIONS\.forEach/.test(bottomFn) && /bySectionKey\[/.test(bottomFn), "bottom nav must source its items from a map built off SECTIONS, not re-type their own href/label");
});
test("admin-chrome.js: bottom nav is exactly Home, Schedule, Leads, Clients (in order) plus a More button — Expenses/Other Revenue moved into the More sheet", () => {
  const keysMatch = chromeSrc.match(/var BOTTOM_NAV_KEYS = \[([^\]]*)\];/);
  assert.ok(keysMatch, "admin-chrome.js must define BOTTOM_NAV_KEYS");
  const keys = Array.from(keysMatch[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
  assert.deepStrictEqual(keys, ["home", "schedule", "leads", "clients"]);
  assert.ok(/id="admin-more-toggle"/.test(chromeSrc), "bottom nav must render a More button");
});
// Website Agent dashboard pass — the More sheet now also carries Website
// Agent (no mascot asset for it, same reasoning "More" itself has always
// had — see admin-chrome.js's own header), so this project's existing
// invariant becomes "Expenses + Other Revenue + Website Agent", not
// "exactly those first two" forever.
test("admin-chrome.js: the More sheet contains Expenses + Other Revenue + Website Agent (from SECTIONS) plus Log Out, reusing the existing .admin-sheet-* chrome", () => {
  const moreKeysMatch = chromeSrc.match(/var MORE_SHEET_KEYS = \[([^\]]*)\];/);
  assert.ok(moreKeysMatch, "admin-chrome.js must define MORE_SHEET_KEYS");
  const keys = Array.from(moreKeysMatch[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
  assert.deepStrictEqual(keys, ["expenses", "other-revenue", "website-agent"]);
  assert.ok(
    /admin-sheet-overlay/.test(chromeSrc) && /admin-sheet-option/.test(chromeSrc) && /admin-sheet-cancel/.test(chromeSrc),
    "the More sheet must reuse the existing .admin-sheet-overlay/.admin-sheet-option/.admin-sheet-cancel chrome, not a new modal pattern"
  );
  assert.ok(
    /id="admin-more-logout"/.test(chromeSrc) && /realLogoutBtn\.click\(\)/.test(chromeSrc),
    "the More sheet's Log Out row must trigger the real #logout-btn's own existing click handler (click()), never duplicate the logout fetch/redirect logic"
  );
});

test("admin-chrome.js: Log Out button keeps id=\"logout-btn\" and admin-btn admin-btn-ghost classes (every page's own script wires its click handler by this id, unchanged)", () => {
  assert.ok(/id="logout-btn" class="admin-btn admin-btn-ghost"/.test(chromeSrc));
});

test("admin-chrome.js: is a no-op (returns early) when a page has no #admin-chrome placeholder, e.g. the login page", () => {
  assert.ok(/getElementById\('admin-chrome'\)/.test(chromeSrc));
  assert.ok(/if \(!mount\) return;/.test(chromeSrc));
});

test("admin/login/index.html does not load admin-chrome.js and has no #admin-chrome placeholder (unchanged standalone layout)", () => {
  const html = readNormalized("admin/login/index.html");
  assert.ok(!/admin-chrome/.test(html));
});

ALL_ADMIN_PAGES.forEach((rel) => {
  test(rel + ": admin-chrome.js is the FIRST script tag (must register its DOMContentLoaded listener before any page script looks for #logout-btn)", () => {
    const html = readNormalized(rel);
    const scripts = Array.from(html.matchAll(/<script src="([^"]+)"><\/script>/g)).map((m) => m[1]);
    assert.ok(scripts.length > 0, rel + ": must load at least one script");
    assert.ok(/admin-chrome\.js$/.test(scripts[0]), rel + ": first script must be admin-chrome.js, found " + scripts[0]);
  });

  test(rel + ": no leftover static topbar/nav-tabs markup (fully replaced by the shared chrome)", () => {
    const html = readNormalized(rel);
    assert.ok(!/admin-topbar/.test(html), rel + ": must not contain the old static .admin-topbar markup");
    assert.ok(!/class="admin-nav-tab/.test(html), rel + ": must not contain the old static .admin-nav-tab markup");
  });
});

test("admin/admin.css: new .admin-header/.admin-nav-item/.admin-bottom-nav rules exist; old .admin-topbar/.admin-nav-tab rules are gone", () => {
  const css = readNormalized("admin/admin.css");
  assert.ok(/\.admin-header\s*\{/.test(css));
  assert.ok(/\.admin-nav-item\s*\{/.test(css));
  assert.ok(/\.admin-bottom-nav\s*\{/.test(css));
  assert.ok(/\.admin-bottom-nav-item\s*\{/.test(css));
  assert.ok(!/\.admin-topbar\s*\{/.test(css), "old .admin-topbar rule should be removed, not left dead");
  assert.ok(!/\.admin-nav-tab\s*\{/.test(css), "old .admin-nav-tab rule should be removed, not left dead");
});

// ---------------------------------------------------------------------
async function main() {
  const settled = [];
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
      settled.push({ name: t.name, ok: true });
    } catch (err) {
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
      settled.push({ name: t.name, ok: false });
    }
  }
  const failed = settled.filter((r) => !r.ok);
  console.log("\n" + settled.length + " tests run, " + failed.length + " failed.");
  if (failed.length) process.exitCode = 1;
}

main();
