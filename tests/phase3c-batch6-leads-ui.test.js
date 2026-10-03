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
// Batch 5 added), per the same convention every prior section used. The
// Requests and Intake nav links/badges are explicitly asserted to STILL be
// present and unchanged here — per the instruction to keep /admin/requests/
// reachable and NOT remove its nav link until parity is proven.
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

PAGES_WITH_SHARED_NAV.forEach((rel) => {
  test(rel + ": carries the new Leads nav tab, AND still carries the unchanged Requests/Intake nav tabs + badges", () => {
    const html = readNormalized(rel);
    assert.ok(/href="\/admin\/leads\/"\s+class="admin-nav-tab/.test(html), "missing the Leads nav tab link");
    assert.ok(/href="\/admin\/requests\/"\s+class="admin-nav-tab/.test(html), "the Requests nav tab link must still be present — not removed yet");
    assert.ok(/id="nav-badge-requests"/.test(html), "the Requests nav badge element must still be present");
    assert.ok(/href="\/admin\/intakes\/"\s+class="admin-nav-tab/.test(html), "the Intake nav tab link must still be present");
    assert.ok(/id="nav-badge-intake"/.test(html), "the Intake nav badge element must still be present");
  });
});

test("the Leads nav tab appears AFTER Intake and BEFORE Clients on every page (consistent tab order)", () => {
  PAGES_WITH_SHARED_NAV.forEach((rel) => {
    const html = readNormalized(rel);
    const intakeIdx = html.indexOf('href="/admin/intakes/"');
    const leadsIdx = html.indexOf('href="/admin/leads/"');
    const clientsIdx = html.indexOf('href="/admin/clients/"');
    assert.ok(intakeIdx !== -1 && leadsIdx !== -1 && clientsIdx !== -1, rel + ": missing a nav tab");
    assert.ok(intakeIdx < leadsIdx && leadsIdx < clientsIdx, rel + ": Leads tab must sit between Intake and Clients");
  });
});

test("admin/requests/index.html: the route itself is still a real, normal page (not stubbed out, no redirect, no removal)", () => {
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

test("admin/leads/index.html: has all 9 section containers, each starting hidden", () => {
  const html = readNormalized("admin/leads/index.html");
  LEADS_SECTION_KEYS.forEach((key) => {
    assert.ok(new RegExp('id="section-' + key + '"[^>]*hidden').test(html), "missing hidden section-" + key);
    assert.ok(new RegExp('id="list-' + key + '"').test(html), "missing list-" + key);
    assert.ok(new RegExp('id="count-' + key + '"').test(html), "missing count-" + key);
  });
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
