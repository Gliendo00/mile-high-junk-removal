// Batch 1 (auth reliability) — regression guard: every admin content page
// must force a clean reload when restored from the browser's back/forward
// cache (bfcache).
//
// Without this, pressing Back to one of these pages can show a frozen
// snapshot from before the visitor navigated away (e.g. a booking's status
// as it was before an edit, or a stale client record) — a bfcache restore
// never re-fires DOMContentLoaded, so a page's own initial data-fetch never
// re-runs on its own; only a `pageshow` listener checking `event.persisted`
// fires for it. admin/dashboard.js, admin/schedule.js, admin/clients-list.js
// and admin/expenses.js already had this (see each file's own comment);
// Batch 1 added it to the remaining detail/edit/create pages that were
// missing it — admin/booking-detail.js, admin/booking-edit.js,
// admin/booking-new.js, admin/booking-past.js, admin/client-detail.js.
//
// This is a static-analysis guard (same style as the existing
// "admin client JS never uses innerHTML" tests elsewhere in this suite),
// not a DOM-execution test: the actual reload behavior itself is exactly
// the one-line `if (e.persisted) window.location.reload();` already proven
// safe by every page that has carried it since before this batch. What
// matters here is that no admin page — present or, if this list is kept up
// to date, future — silently ships without it again.
//
// admin/login.js and admin/calendar-views.js are deliberately excluded:
// login.js's pageshow handler does something different (re-checks the
// session rather than reloading — see tests/phase3c-admin-login-session
// .test.js), and calendar-views.js isn't a page of its own — it renders
// inside admin/index.html alongside admin/schedule.js, which already
// covers that page's pageshow handling.
//
// Run with:  node tests/phase3c-admin-bfcache-reload.test.js
// Exits with a non-zero code if any assertion fails.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const PAGE_FILES = [
  "admin/dashboard.js",
  "admin/schedule.js",
  "admin/clients-list.js",
  "admin/expenses.js",
  "admin/booking-detail.js",
  "admin/booking-edit.js",
  "admin/booking-new.js",
  "admin/booking-past.js",
  "admin/client-detail.js",
];

const registered = [];
function test(name, fn) { registered.push({ name, fn }); }

PAGE_FILES.forEach((rel) => {
  test("bfcache reload: " + rel + " reloads on a persisted pageshow", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(/window\.addEventListener\(\s*['"]pageshow['"]/.test(src), rel + " must register a pageshow listener");
    assert.ok(/if\s*\(\s*e\.persisted\s*\)\s*window\.location\.reload\(\)/.test(src), rel + "'s pageshow listener must reload on event.persisted");
  });
});

test("bfcache reload: every page-level admin script registers pageshow exactly once (no duplicate/competing handlers)", () => {
  PAGE_FILES.forEach((rel) => {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    const matches = src.match(/window\.addEventListener\(\s*['"]pageshow['"]/g) || [];
    assert.strictEqual(matches.length, 1, rel + " should register pageshow exactly once");
  });
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
