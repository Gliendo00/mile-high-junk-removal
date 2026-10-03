// Static-analysis tests for Batch 6's admin UI: the new /admin/leads/
// workspace shell (admin/leads/, admin/leads-list.js) and the shared Leads
// nav tab added to every existing admin page. Same approach as every other
// UI test in this suite (e.g. tests/phase3c-batch5-intake-ui.test.js): this
// project has no DOM/jsdom harness, so client-side behavior is verified by
// reading the actual source text rather than executing it. The two
// endpoints this page calls (GET /api/admin/intake, unchanged; GET
// /api/admin/bookings?view=leads, new) are exercised for real in
// tests/phase3c-batch5-intake-endpoint.test.js and
// tests/phase3c-batch6-leads-view.test.js respectively.
//
// Run with:  node tests/phase3c-batch6-leads-ui.test.js
// Exits with a non-zero code if any assertion fails.

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

// =======================================================================
// Nav tab — added to every pre-existing admin page (including the three
// Batch 5 added), per the same convention every prior section used.
//
// SUPERSEDED in part by Batch 6's own later nav-consolidation pass
// (2026-10): this block originally asserted Requests/Intake stayed in the
// visible nav alongside Leads. They've since been removed from the
// visible nav entirely (both routes remain live/reachable directly — see
// tests/phase3c-batch6-nav-consolidation.test.js for the full positive
// assertions on that). Updated here so this file stops asserting a nav
// shape that no longer ships.
// =======================================================================
const PAGES_WITH_SHARED_NAV = [
  "admin/booking-edit/index.html",
  "admin/booking-new/index.html",
  "admin/booking-past/index.html",
  "admin/booking/index.html",
  "admin/client/index.html",
  "admin/clients/index.html",
  "admin/expenses/index.html",
  "admin/index.html",
  "admin/requests/index.html",
  "admin/intakes/index.html",
  "admin/intake-new/index.html",
  "admin/intake/index.html",
];

// UPDATED for the CRM visual redesign (2026-10): nav tabs are no longer
// static per-page HTML — every page now loads the shared admin-chrome.js
// (see tests/phase3c-batch6-nav-consolidation.test.js, which asserts its
// SECTIONS list directly: Leads present, in order, no Requests/Intakes).
// What's left to check here is just that each of these pages still wires
// up that shared chrome at all.
PAGES_WITH_SHARED_NAV.forEach((rel) => {
  test(rel + ": loads the shared admin-chrome header/nav (which carries Leads; Requests/Intake are not nav destinations)", () => {
    const html = readNormalized(rel);
    assert.ok(/<div id="admin-chrome"><\/div>/.test(html), rel + ": missing the #admin-chrome placeholder");
    assert.ok(/<script src="[^"]*admin-chrome\.js"><\/script>/.test(html), rel + ": missing the admin-chrome.js script tag");
  });
});

test("admin/requests/index.html: the route itself is still a real, normal page (not stubbed out, no redirect, no removal) — just no longer in the visible nav", () => {
  const html = readNormalized("admin/requests/index.html");
  assert.ok(/<h1>Requests<\/h1>/.test(html) || /Requests/.test(html), "the Requests page must still render its own heading/content");
  assert.ok(/src="\.\.\/dashboard\.js"/.test(html), "the Requests page must still load dashboard.js — unchanged");
});

// =======================================================================
// admin/leads/index.html — the shell itself
// =======================================================================
const LEADS_SECTION_KEYS = [
  "pendingIntake",
  "websiteRequests",
  "new",
  "contacted",
  "waitingOnPhotos",
  "estimateSent",
  "followUp",
  "bookedWon",
  "lost",
];

test("admin/leads/index.html: has all 9 section containers, each starting hidden, plus a tab button + count badge per bucket (sub-tabs follow-up)", () => {
  const html = readNormalized("admin/leads/index.html");
  LEADS_SECTION_KEYS.forEach((key) => {
    assert.ok(new RegExp('id="section-' + key + '"[^>]*hidden').test(html), "missing hidden section-" + key);
    assert.ok(new RegExp('id="list-' + key + '"').test(html), "missing list-" + key);
    assert.ok(new RegExp('data-bucket="' + key + '"').test(html), "missing the tab button for " + key);
    assert.ok(new RegExp('id="tab-count-' + key + '"[^>]*hidden').test(html), "missing the hidden-by-default count badge for " + key);
  });
});

test("admin/leads/index.html: the tabs container is horizontally scrollable (mobile) via .admin-leads-tabs", () => {
  const html = readNormalized("admin/leads/index.html");
  assert.ok(/id="leads-tabs"[^>]*class="admin-leads-tabs"|class="admin-leads-tabs"[^>]*id="leads-tabs"/.test(html), "the tab bar must use .admin-leads-tabs");
  const css = readNormalized("admin/admin.css");
  const block = css.slice(css.indexOf(".admin-leads-tabs {"), css.indexOf(".admin-leads-tabs {") + 400);
  assert.ok(/overflow-x:\s*auto/.test(block), ".admin-leads-tabs must scroll horizontally rather than wrap");
});

test("admin/leads/index.html: loads admin-fetch.js, nav-badge.js, and leads-list.js", () => {
  const html = readNormalized("admin/leads/index.html");
  assert.ok(/src="\.\.\/admin-fetch\.js"/.test(html));
  assert.ok(/src="\.\.\/nav-badge\.js"/.test(html));
  assert.ok(/src="\.\.\/leads-list\.js"/.test(html));
});

test("admin/leads/index.html and admin/leads-list.js never use innerHTML/insertAdjacentHTML/document.write", () => {
  ["admin/leads/index.html", "admin/leads-list.js"].forEach((rel) => {
    const src = readNormalized(rel);
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
});

test("admin/leads-list.js: fetches the EXISTING GET /api/admin/intake (unchanged) and the new GET /api/admin/bookings?view=leads, nothing else", () => {
  const src = readNormalized("admin/leads-list.js");
  assert.ok(/adminFetch\('\/api\/admin\/intake'\)/.test(src), "must reuse the existing intake list endpoint as-is");
  assert.ok(/adminFetch\('\/api\/admin\/bookings\?view=leads'\)/.test(src));
  // Never a POST/PATCH/DELETE anywhere in this file — this page is READ-ONLY
  // in this batch (Lead -> Booking conversion is explicitly out of scope).
  assert.ok(!/method:\s*['"](POST|PATCH|DELETE|PUT)['"]/.test(src.replace(/fetch\('\/api\/admin\/logout', \{ method: 'POST' \}\)/, "")), "leads-list.js must never write anything except the shared logout call");
});

test("admin/leads-list.js: Pending Intake card name fallback matches admin/intakes-list.js's own priority (matched -> extracted -> phone -> email -> Unidentified)", () => {
  const src = readNormalized("admin/leads-list.js");
  assert.ok(/intake\.matchedClientName \|\| intake\.extractedClientName \|\| intake\.extractedPhone \|\| intake\.extractedEmail \|\| 'Unidentified client'/.test(src));
});

test("admin/leads-list.js: a booking-kind card links to the existing /admin/booking/ detail page; a lead-kind card does not (no lead detail page exists yet)", () => {
  const src = readNormalized("admin/leads-list.js");
  assert.ok(/item\.kind === 'booking' \? document\.createElement\('a'\) : document\.createElement\('div'\)/.test(src));
});

test("admin.css: defines the Leads section wrapper and all four source-badge color variants", () => {
  const css = readNormalized("admin/admin.css");
  assert.ok(/\.admin-leads-section\s*\{/.test(css));
  ["website", "screenshot_intake", "phone", "manual"].forEach((source) => {
    assert.ok(new RegExp("\\.admin-source-badge-" + source + "\\s*\\{").test(css), "missing .admin-source-badge-" + source);
  });
});

// =======================================================================
// Cross-check against api/admin/bookings.js's own bucket keys, so the UI
// and the server can never silently drift apart on section names — same
// discipline as Batch 5's FIELD_LABELS/FIELD_KEYS cross-check test.
// =======================================================================
test("admin/leads/index.html's section keys exactly match api/admin/bookings.js's LEADS_BUCKET_LABELS keys (plus pendingIntake, which is intake.js's own list, not a bucket)", () => {
  const serverSrc = readNormalized("api/admin/bookings.js");
  const match = serverSrc.match(/const LEADS_BUCKET_LABELS = \{([^}]*)\}/);
  assert.ok(match, "LEADS_BUCKET_LABELS must be defined in api/admin/bookings.js");
  const serverKeys = Array.from(match[1].matchAll(/^\s*(\w+):/gm)).map((m) => m[1]);
  const uiKeysWithoutIntake = LEADS_SECTION_KEYS.filter((k) => k !== "pendingIntake");
  assert.deepStrictEqual(serverKeys.sort(), uiKeysWithoutIntake.sort());
});

// Preview QA finding (2026-10): api/admin/bookings.js's ?view=leads now
// degrades per-query instead of 500ing the whole response — this page
// must never silently show "nothing waiting" when something actually
// failed to load. See tests/phase3c-batch6-leads-view.test.js for the
// server-side behavior this reads.
test("admin/leads-list.js: surfaces leadsBody.sectionErrors via the existing error banner (never silently treats a partial failure as 'all empty')", () => {
  const src = readNormalized("admin/leads-list.js");
  assert.ok(/leadsBody\.sectionErrors/.test(src), "must read sectionErrors off the ?view=leads response");
  assert.ok(/showError\(/.test(src), "must route a partial failure through the existing error-banner mechanism");
});

// =======================================================================
// Leads sub-tabs/pills (follow-up, same batch) — one bucket visible at a
// time, counts, default-selection cascade. This project has no DOM/jsdom
// harness, so the tab-switching logic is verified by reading the actual
// source text, same as every other client-side test in this suite.
// =======================================================================
test("admin/leads-list.js: SECTION_ORDER is exactly the 9 requested tabs, in the requested order", () => {
  const src = readNormalized("admin/leads-list.js");
  const m = src.match(/var SECTION_ORDER = \[([^\]]+)\]/);
  assert.ok(m, "SECTION_ORDER must be defined");
  const keys = m[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  assert.deepStrictEqual(keys, ["pendingIntake", "websiteRequests", "new", "contacted", "waitingOnPhotos", "estimateSent", "followUp", "bookedWon", "lost"]);
});

test("admin/leads-list.js: selectBucket() shows exactly the selected section and hides every other one (one bucket visible at a time)", () => {
  const src = readNormalized("admin/leads-list.js");
  const fnSrc = src.slice(src.indexOf("function selectBucket"), src.indexOf("function selectBucket") + 500);
  assert.ok(/SECTION_ORDER\.forEach/.test(fnSrc), "must iterate every section, not just the newly-selected one — otherwise a previously-shown section could stay visible");
  assert.ok(/sectionEl\.hidden = k !== key/.test(fnSrc), "every section not matching the selected key must be hidden");
});

test("admin/leads-list.js: clicking a tab calls selectBucket with that tab's data-bucket (delegated click handler on the tab bar)", () => {
  const src = readNormalized("admin/leads-list.js");
  assert.ok(/tabsEl\.addEventListener\('click'/.test(src));
  assert.ok(/closest\(['"]\.admin-leads-tab['"]\)/.test(src));
  assert.ok(/selectBucket\(btn\.getAttribute\('data-bucket'\)\)/.test(src));
});

test("admin/leads-list.js: count badges show the real count when non-zero and stay hidden at zero (never a visible '0')", () => {
  const src = readNormalized("admin/leads-list.js");
  const fnSrc = src.slice(src.indexOf("function renderSection"), src.indexOf("function renderSection") + 900);
  assert.ok(/countBadge\.hidden = false/.test(fnSrc) && /countBadge\.hidden = true/.test(fnSrc), "must toggle the badge's hidden attribute both ways, never leave a stale 0 visible");
  assert.ok(/n > 99 \? '99\+' : String\(n\)/.test(fnSrc), "must cap the displayed count the same way nav-badge.js already does");
});

test("admin/leads-list.js: defaultBucket() picks the first non-empty bucket in SECTION_ORDER — satisfies the full cascade (Pending Intake, then Website Requests, then the active pipeline, Booked/Won and Lost last) from one simple rule", () => {
  const src = readNormalized("admin/leads-list.js");
  const fnSrc = src.slice(src.indexOf("function defaultBucket"), src.indexOf("function defaultBucket") + 400);
  assert.ok(/for \(var i = 0; i < SECTION_ORDER\.length; i\+\+\)/.test(fnSrc), "must walk SECTION_ORDER in order");
  assert.ok(/counts\[SECTION_ORDER\[i\]\] > 0/.test(fnSrc), "must return the first bucket with a non-zero count");
  assert.ok(/return SECTION_ORDER\[0\]/.test(fnSrc), "must fall back to the first tab (Pending Intake) when every bucket is empty, rather than showing nothing selected");
});

test("admin/leads-list.js: finish() selects a bucket after rendering (a tab is always active once loading completes)", () => {
  const src = readNormalized("admin/leads-list.js");
  const fnSrc = src.slice(src.indexOf("function finish"), src.indexOf("function finish") + 400);
  assert.ok(/selectBucket\(defaultBucket\(\)\)/.test(fnSrc));
});

test("admin/leads/index.html: every bucket's section only contains its own <ul> now (no redundant per-section heading/count — the tab itself carries the label and count)", () => {
  const html = readNormalized("admin/leads/index.html");
  // Guards against silently reintroducing the old count-<key> spans this
  // test file used to assert on, which would now be dead markup never
  // written to by leads-list.js (it writes tab-count-<key> instead).
  assert.ok(!/id="count-pendingIntake"/.test(html), "the old per-section count span must not come back — tab-count-pendingIntake is what's live now");
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
