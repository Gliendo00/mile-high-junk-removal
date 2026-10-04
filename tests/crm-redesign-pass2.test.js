// CRM visual redesign — second pass (visual parity + Leads de-densification,
// 2026-10). Static-analysis coverage for the specific, named changes this
// pass made. Same approach as every other UI test in this project: no DOM/
// jsdom harness, so this reads actual source text.
//
// Run with:  node tests/crm-redesign-pass2.test.js

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
// Leads — 2-column desktop grid, exactly 2 chips, no redundant status text
// =======================================================================
// UPDATED for the Leads sidebar redesign (UI batch, 2026-10): "Website
// Requests" is no longer its own bucket <ul> — its items are merged
// client-side into "New" (a source, not a stage; see leads-list.js's own
// header) — leaving 8 real bucket <ul> lists. "Needs Attention" (the new
// smart combined view) has no <ul id="list-...">  of its own at all: it's
// a composite <section> leads-list.js's renderNeedsAttention() fills with
// grouped clones of the SAME 8 buckets' own cards, not a 9th data source.
test("admin/leads/index.html: all 8 real bucket <ul> lists carry .admin-leads-grid", () => {
  const html = read("admin/leads/index.html");
  const matches = html.match(/<ul class="admin-booking-list admin-leads-grid" id="list-\w+">/g) || [];
  assert.strictEqual(matches.length, 8, "expected all 8 real bucket lists to carry the grid class, found " + matches.length);
});

test("admin/admin.css: .admin-leads-grid is a single column by default and exactly 2 columns above its breakpoint (not 1, not 3)", () => {
  const css = read("admin/admin.css");
  const baseIdx = css.indexOf(".admin-leads-grid {");
  assert.ok(baseIdx !== -1);
  const baseRule = css.slice(baseIdx, css.indexOf("}", baseIdx));
  assert.ok(/grid-template-columns:\s*1fr;/.test(baseRule));
  const wideIdx = css.indexOf(".admin-leads-grid { grid-template-columns: repeat(2, 1fr)");
  assert.ok(wideIdx !== -1, "must widen to exactly repeat(2, 1fr) — not 3 — above the breakpoint");
});

test("admin/leads-list.js: renderLeadCard() renders exactly 2 chips (source + status) and no separate plain-text status element", () => {
  const src = read("admin/leads-list.js");
  const fnBody = src.slice(src.indexOf("function renderLeadCard("), src.indexOf("// Pending Intake card"));
  assert.ok(/admin-source-badge admin-source-badge-/.test(fnBody));
  assert.ok(/admin-status-badge ' \+ statusChipClass/.test(fnBody), "status must render as a real .admin-status-badge chip, not plain text");
  assert.ok(!/admin-lead-card-status/.test(fnBody), "the old redundant plain-text status span must be gone");
});

// UPDATED for the Leads sidebar redesign: "websiteRequests" is no longer a
// chip-color key of its own — a merged website-origin card now renders
// with bucketKey 'new' (it still carries its own distinct SOURCE badge,
// "Website", which is what actually communicates where it came from).
test("admin/leads-list.js: BUCKET_CHIP_CLASS covers all 8 real Leads buckets, each mapped to its own admin-lead-bucket-* chip color", () => {
  const src = read("admin/leads-list.js");
  const buckets = ["pendingIntake", "new", "contacted", "waitingOnPhotos", "estimateSent", "followUp", "bookedWon", "lost"];
  buckets.forEach((b) => {
    assert.ok(new RegExp(b + ": 'admin-lead-bucket-" + b + "'").test(src), "missing chip-class mapping for bucket: " + b);
  });
  const css = read("admin/admin.css");
  buckets.forEach((b) => {
    assert.ok(css.includes(".admin-lead-bucket-" + b + " {"), "missing CSS color rule for: .admin-lead-bucket-" + b);
  });
});

test("admin/admin.css: .admin-lead-card resets border-left-width back to 1px (removing the inherited 5px Schedule-style accent stripe, redundant now that status is a chip)", () => {
  const css = read("admin/admin.css");
  const idx = css.indexOf(".admin-lead-card {");
  const rule = css.slice(idx, css.indexOf("}", idx));
  assert.ok(/border-left-width:\s*1px/.test(rule));
});

// =======================================================================
// Global — stronger type hierarchy, stronger elevation, wider desktop use
// =======================================================================
test("admin/admin.css: page title (.admin-list-heading h1) is 22px, not the old 17px", () => {
  const css = read("admin/admin.css");
  const idx = css.indexOf(".admin-list-heading h1, .admin-list-heading h2 {");
  const rule = css.slice(idx, css.indexOf("}", idx));
  assert.ok(/font-size:\s*22px/.test(rule));
});

test("admin/admin.css: --admin-shadow-elevated is meaningfully stronger than a flat card's new resting shadow (real tier separation)", () => {
  const css = read("admin/admin.css");
  const m = css.match(/--admin-shadow-elevated:\s*([^;]+);/);
  assert.ok(m, "token must exist");
  assert.ok(/0\.2\d|0\.[2-9]\d*\)/.test(m[1]) || /rgba\([^)]*0\.2/.test(m[1]), "elevated shadow opacity should be visibly stronger than the ~0.06 flat-card resting shadow");
});

test("admin/admin.css: desktop .admin-main widened past the original 1040px", () => {
  const css = read("admin/admin.css");
  assert.ok(/\.admin-main \{ max-width: 1240px/.test(css));
});

// =======================================================================
// Expenses — structured totals hierarchy, Expenses vs Other Revenue color
// =======================================================================
test("admin/expenses.js: its totals handler builds structured label/value/count nodes instead of one plain-text string", () => {
  const src = read("admin/expenses.js");
  assert.ok(/admin-expense-total-label/.test(src));
  assert.ok(/admin-expense-total-value/.test(src));
});

// Other Revenue's own totals handler (same structured-nodes pattern, plus
// the distinct revenue color modifier) now lives in admin/other-revenue.js
// — split out of admin/expenses.js onto its own page.
test("admin/other-revenue.js: its totals handler builds structured label/value/count nodes, with the distinct revenue color modifier", () => {
  const src = read("admin/other-revenue.js");
  assert.ok(/admin-expense-total-label/.test(src));
  assert.ok(/admin-expense-total-value-revenue/.test(src), "Other Revenue's total must carry the distinct revenue color modifier");
});

test("admin/admin.css: .admin-expense-total-value is red (money out) by default and green via .admin-expense-total-value-revenue (money in)", () => {
  const css = read("admin/admin.css");
  const baseIdx = css.indexOf(".admin-expense-total-value {");
  const baseRule = css.slice(baseIdx, css.indexOf("}", baseIdx));
  assert.ok(/color:\s*#b91c1c/.test(baseRule));
  const revIdx = css.indexOf(".admin-expense-total-value-revenue {");
  assert.ok(revIdx !== -1);
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
