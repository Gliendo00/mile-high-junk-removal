// Static-analysis tests for Batch 5's admin UI: the Pending Intake queue
// (admin/intakes/), the upload/extract flow (admin/intake-new/), and the
// review/edit/save-pending screen (admin/intake/) — plus the shared nav tab
// added to every existing admin page and the Pending Intake badge in
// admin/nav-badge.js. Same approach as every other UI test in this suite
// (e.g. tests/phase3c-client-edit-archive-ui.test.js): this project has no
// DOM/jsdom harness, so client-side behavior is verified by reading the
// actual source text rather than executing it. The server-side endpoint
// these pages call is exercised for real in
// tests/phase3c-batch5-intake-endpoint.test.js.
//
// Run with:  node tests/phase3c-batch5-intake-ui.test.js
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
// Nav tab — added to every pre-existing admin page, per the same
// convention every prior section (Clients, Expenses, Requests) was added.
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
  test(rel + ": carries the Intake nav tab + badge, and loads nav-badge.js", () => {
    const html = readNormalized(rel);
    assert.ok(/href="\/admin\/intakes\/"\s+class="admin-nav-tab/.test(html), "missing the Intake nav tab link");
    assert.ok(/id="nav-badge-intake"/.test(html), "missing the Intake nav badge element");
    assert.ok(/src="(\.\.\/)*nav-badge\.js"/.test(html), "must still load nav-badge.js");
  });
});

test("the Intake nav tab appears BEFORE the Clients tab on every page (consistent tab order)", () => {
  PAGES_WITH_SHARED_NAV.forEach((rel) => {
    const html = readNormalized(rel);
    const intakeIdx = html.indexOf('href="/admin/intakes/"');
    const clientsIdx = html.indexOf('href="/admin/clients/"');
    assert.ok(intakeIdx !== -1 && clientsIdx !== -1 && intakeIdx < clientsIdx, rel + ": Intake tab must appear before Clients");
  });
});

test("admin/nav-badge.js: populates nav-badge-intake from /api/admin/intake?countsOnly=1, fails safe to hidden", () => {
  const src = readNormalized("admin/nav-badge.js");
  assert.ok(src.includes("nav-badge-intake"));
  assert.ok(src.includes("/api/admin/intake?countsOnly=1"));
  assert.ok(src.includes("pendingCount"));
  assert.ok(/intakeBadge\.hidden = true/.test(src), "must fail safe to hidden on any error, same as the Requests badge");
});

test("admin/nav-badge.js: the pre-existing Requests badge logic is unaffected (still reads body.summary.new)", () => {
  const src = readNormalized("admin/nav-badge.js");
  assert.ok(src.includes("bookings?countsOnly=1"));
  assert.ok(src.includes("body.summary && typeof body.summary.new"));
});

// =======================================================================
// XSS / rendering discipline — same grep guard every other admin JS file
// in this suite is held to.
// =======================================================================
test("new admin client JS (intakes-list.js, intake-new.js, intake-detail.js) never uses innerHTML/insertAdjacentHTML/document.write", () => {
  ["admin/intakes-list.js", "admin/intake-new.js", "admin/intake-detail.js"].forEach((rel) => {
    const src = readNormalized(rel);
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
});

// =======================================================================
// admin/intakes/ (Pending Intake queue)
// =======================================================================
test("admin/intakes/index.html: has the +New Intake link, list container, and loads intakes-list.js", () => {
  const html = readNormalized("admin/intakes/index.html");
  assert.ok(/href="\/admin\/intake-new\/"/.test(html));
  assert.ok(/id="intake-list"/.test(html));
  assert.ok(/src="\.\.\/intakes-list\.js"/.test(html));
});

test("admin/intakes-list.js: links each card to /admin/intake/?id=", () => {
  const src = readNormalized("admin/intakes-list.js");
  assert.ok(src.includes("/admin/intake/?id="));
});

// =======================================================================
// admin/intake-new/ (upload + extract)
// =======================================================================
test("admin/intake-new/index.html: has the file input, add button, and extract button", () => {
  const html = readNormalized("admin/intake-new/index.html");
  const fileInputTag = (html.match(/<input[^>]*id="file-input"[^>]*>/) || [])[0];
  assert.ok(fileInputTag, "no <input id=\"file-input\"> tag found");
  assert.ok(/type="file"/.test(fileInputTag));
  assert.ok(/multiple/.test(fileInputTag));
  assert.ok(/id="add-btn"/.test(html));
  assert.ok(/id="extract-btn"[^>]*disabled/.test(html), "extract button must start disabled until a screenshot is added");
});

test("admin/intake-new.js: client-side caps match the server's (4MB, 10 screenshots)", () => {
  const src = readNormalized("admin/intake-new.js");
  assert.ok(/MAX_BYTES = 4 \* 1024 \* 1024/.test(src));
  assert.ok(/MAX_SHOTS = 10/.test(src));
  const serverSrc = readNormalized("api/admin/intake.js");
  assert.ok(/MAX_SCREENSHOT_BYTES = 4 \* 1024 \* 1024/.test(serverSrc));
  assert.ok(/MAX_SCREENSHOTS_PER_SESSION = 10/.test(serverSrc));
});

test("admin/intake-new.js: uploads via raw octet-stream with X-Intake-Session-Id and X-Screenshot-Type headers, matching the server's contract", () => {
  const src = readNormalized("admin/intake-new.js");
  assert.ok(src.includes("action=upload-screenshot"));
  assert.ok(src.includes("'X-Intake-Session-Id'"));
  assert.ok(src.includes("'X-Screenshot-Type'"));
  assert.ok(src.includes("application/octet-stream"));
});

test("admin/intake-new.js: redirects to the review page on success", () => {
  const src = readNormalized("admin/intake-new.js");
  assert.ok(src.includes("/admin/intake/?id="));
});

// =======================================================================
// admin/intake/ (review/edit/save-pending)
// =======================================================================
test("admin/intake/index.html: has every required section container and the Save/Discard actions, but no Confirm action (Stage 5D not built)", () => {
  const html = readNormalized("admin/intake/index.html");
  [
    "match-banner",
    "matched-client-summary",
    "client-search-wrap",
    "client-fields",
    "classification-select",
    "job-fields",
    "scheduling-fields",
    "conflicts-section",
    "candidates-section",
    "notes-fields",
    "screenshot-grid",
    "save-btn",
    "discard-btn",
  ].forEach((id) => {
    assert.ok(new RegExp('id="' + id + '"').test(html), "missing #" + id);
  });
  assert.ok(!/confirm-btn|id="confirm"/.test(html), "must not expose a Confirm action yet — that's Stage 5D");
});

test("admin/intake/index.html: the classification <select> offers exactly the six locked classification values", () => {
  const html = readNormalized("admin/intake/index.html");
  const selectMatch = html.match(/<select id="classification-select">([\s\S]*?)<\/select>/);
  assert.ok(selectMatch, "classification-select not found");
  const values = Array.from(selectMatch[1].matchAll(/<option value="([a-z_]+)"/g)).map((m) => m[1]);
  assert.deepStrictEqual(values.sort(), ["booking_confirmed", "existing_job_update", "follow_up", "lead_only", "quote_discussion", "unclear"].sort());
});

test("admin/intake-detail.js: never calls a confirm/create-booking/create-client action — Stage 5D is genuinely not implemented client-side either", () => {
  const src = readNormalized("admin/intake-detail.js");
  assert.ok(!/action:\s*['"]confirm['"]/.test(src));
  assert.ok(!/\/api\/admin\/client['"]/.test(src), "must never call the client-creation endpoint directly");
  assert.ok(!/\/api\/admin\/booking['"]/.test(src), "must never call the booking-creation endpoint directly");
});

test("admin/intake-detail.js: its FIELD_LABELS keys exactly match the adapter's FIELD_KEYS (no drift between client and server field lists)", () => {
  const { FIELD_KEYS } = require("../api/_lib/intake-vision-provider.js");
  const src = readNormalized("admin/intake-detail.js");
  const labelsBlockMatch = src.match(/var FIELD_LABELS = \{([\s\S]*?)\n  \};/);
  assert.ok(labelsBlockMatch, "FIELD_LABELS block not found");
  const keys = Array.from(labelsBlockMatch[1].matchAll(/^\s*([a-zA-Z]+):/gm)).map((m) => m[1]);
  assert.deepStrictEqual(keys.sort(), FIELD_KEYS.slice().sort());
});

test("admin/intake-detail.js: its CLASSIFICATION_LABELS keys exactly match the adapter's CLASSIFICATIONS", () => {
  const { CLASSIFICATIONS } = require("../api/_lib/intake-vision-provider.js");
  const src = readNormalized("admin/intake-detail.js");
  const block = src.match(/var CLASSIFICATION_LABELS = \{([\s\S]*?)\n  \};/);
  assert.ok(block, "CLASSIFICATION_LABELS block not found");
  const keys = Array.from(block[1].matchAll(/^\s*([a-zA-Z_]+):/gm)).map((m) => m[1]);
  assert.deepStrictEqual(keys.sort(), CLASSIFICATIONS.slice().sort());
});

test("admin/intake-detail.js: confidence dots use only the four locked confidence states, matching api/_lib/intake-vision-provider.js's FIELD_CONFIDENCES", () => {
  const { FIELD_CONFIDENCES } = require("../api/_lib/intake-vision-provider.js");
  const src = readNormalized("admin/intake-detail.js");
  const block = src.match(/var CONFIDENCE_LABELS = \{([^}]*)\}/);
  assert.ok(block);
  const keys = Array.from(block[1].matchAll(/([a-zA-Z]+):/g)).map((m) => m[1]);
  assert.deepStrictEqual(keys.sort(), FIELD_CONFIDENCES.slice().sort());
});

test("admin/intake-detail.js: disables all inputs when the intake isn't pending_review (no editing a processing/discarded/extraction_failed intake)", () => {
  const src = readNormalized("admin/intake-detail.js");
  assert.ok(src.includes("intake.status === 'pending_review'"));
  assert.ok(src.includes("input.disabled = true"));
});

test("admin/intake-detail.js: discard requires two clicks (an inline arm/confirm step, never a single-click destructive action)", () => {
  const src = readNormalized("admin/intake-detail.js");
  assert.ok(src.includes("discardArmed"));
  assert.ok(src.includes("Click again to confirm"));
});

// =======================================================================
// CSS — confidence dot classes exist and are distinct colors, no bare
// percentage-style confidence indicator introduced anywhere.
// =======================================================================
test("admin.css: defines all four confidence-dot color classes, reusing the existing .admin-sheet-dot shape", () => {
  const css = readNormalized("admin/admin.css");
  ["confirmed", "likely", "uncertain", "missing"].forEach((state) => {
    assert.ok(new RegExp("\\.admin-confidence-dot-" + state + "\\s*\\{").test(css), "missing .admin-confidence-dot-" + state);
  });
});

// =======================================================================
// Screenshot retention (hardening pass) — the review screen must explain
// an empty screenshot grid caused by expiry, not just look broken.
// =======================================================================
test("admin/intake/index.html: has a screenshots-expired-note container, starting hidden, inside the Source Screenshots section", () => {
  const html = readNormalized("admin/intake/index.html");
  assert.ok(/id="screenshots-expired-note"[^>]*style="display:none"/.test(html));
  const sourceSectionIdx = html.indexOf("Source Screenshots");
  const noteIdx = html.indexOf('id="screenshots-expired-note"');
  const gridIdx = html.indexOf('id="screenshot-grid"');
  assert.ok(sourceSectionIdx < noteIdx && noteIdx < gridIdx, "the note must sit between the section heading and the screenshot grid");
});

test("admin/intake-detail.js: renders the screenshots-expired note only when screenshotsExpiredAt is set, mentioning the retention window rather than looking like a bug", () => {
  const src = readNormalized("admin/intake-detail.js");
  assert.ok(src.includes("renderScreenshotsExpiredNote"));
  assert.ok(src.includes("intake.screenshotsExpiredAt"));
  assert.ok(/automatically removed/.test(src));
});

// =======================================================================
// Vercel Cron (hardening pass) — cleanup reuses the EXISTING intake.js
// file, never a new Vercel function.
// =======================================================================
test("vercel.json: a cron job targets the existing api/admin/intake.js file (?action=cleanup-expired), not a new endpoint file", () => {
  const vercelConfig = JSON.parse(readNormalized("vercel.json"));
  assert.ok(Array.isArray(vercelConfig.crons) && vercelConfig.crons.length >= 1, "vercel.json must define at least one cron job");
  const cronPaths = vercelConfig.crons.map((c) => c.path);
  assert.ok(cronPaths.some((p) => p === "/api/admin/intake?action=cleanup-expired"), "expected a cron targeting /api/admin/intake?action=cleanup-expired");
  vercelConfig.crons.forEach((c) => {
    assert.ok(/^\/api\//.test(c.path), "a cron path must target an existing api/ route, not introduce a new one");
    assert.ok(typeof c.schedule === "string" && c.schedule.trim(), "every cron entry needs a schedule");
  });
});

test("vercel.json: the cron schedule runs at most once per day (Vercel Hobby plan's cron frequency limit)", () => {
  const vercelConfig = JSON.parse(readNormalized("vercel.json"));
  const cleanupCron = vercelConfig.crons.find((c) => c.path === "/api/admin/intake?action=cleanup-expired");
  assert.ok(cleanupCron);
  // A 5-field cron schedule "m h dom mon dow" runs at most once/day only
  // when both the day-of-month and month fields are "*" (every day) and
  // hour/minute are each a single fixed value, not a repeating */N pattern.
  const parts = cleanupCron.schedule.trim().split(/\s+/);
  assert.strictEqual(parts.length, 5, "expected a standard 5-field cron expression");
  const [minute, hour, dom, month] = parts;
  assert.ok(!/\*\/|,/.test(minute) && !/\*\/|,/.test(hour), "minute/hour must be fixed values, not a repeating or multi-value pattern, to stay within one run/day");
  assert.strictEqual(dom, "*");
  assert.strictEqual(month, "*");
});

// =======================================================================
// Mock vision provider (hardening pass) — a Preview/test-only, explicit
// opt-in, never a silent fallback from a failing/unconfigured real provider.
// =======================================================================
test("api/_lib/intake-vision-provider.js: mock is reachable only via explicit INTAKE_VISION_PROVIDER=mock, default stays openai", () => {
  const src = readNormalized("api/_lib/intake-vision-provider.js");
  assert.ok(/mock:\s*callMock/.test(src), "PROVIDERS map must register the mock provider");
  assert.ok(/process\.env\.INTAKE_VISION_PROVIDER \|\| "openai"/.test(src), "the default must remain openai even with mock implemented");
});

test("api/_lib/intake-vision-provider.js: the openai provider has no code path that invokes callMock on its own failure", () => {
  const src = readNormalized("api/_lib/intake-vision-provider.js");
  const openAiFnSrc = src.slice(src.indexOf("async function callOpenAi"), src.indexOf("async function callOpenAi") + 3000);
  assert.ok(!/callMock/.test(openAiFnSrc), "callOpenAi() must never reference callMock() — no fallback chain of any kind");
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
