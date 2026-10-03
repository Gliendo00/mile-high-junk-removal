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

test("admin-chrome.js: bottom nav mirrors the same 4 destinations in the same order as the desktop nav", () => {
  const bottomFn = chromeSrc.match(/function buildBottomNav[\s\S]*?\n  \}/)[0];
  const desktopFn = chromeSrc.match(/function buildDesktopNav[\s\S]*?\n  \}/)[0];
  assert.ok(/SECTIONS\.map/.test(bottomFn) && /SECTIONS\.map/.test(desktopFn), "both nav builders must derive from the same SECTIONS list, not separately hardcoded markup");
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
