// Site Improvement Agent, Phase 5 — static checks for the new
// /admin/agent-reports/ report-history page (admin/agent-reports.js +
// admin/agent-reports/index.html), and for the Home/Proposals UI changes
// this phase added on top of the existing, already-tested surfaces. Same
// source-level static-analysis convention as
// tests/agent-activity-home-ui.test.js/tests/agent-proposals-ui.test.js
// (no headless DOM runner in this project).
//
// Run with:  node tests/agent-reports-ui.test.js

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

const reportsJs = fs.readFileSync(path.join(__dirname, "..", "admin", "agent-reports.js"), "utf8");
const reportsHtml = fs.readFileSync(path.join(__dirname, "..", "admin", "agent-reports", "index.html"), "utf8");
const homeJs = fs.readFileSync(path.join(__dirname, "..", "admin", "home.js"), "utf8");
const homeHtml = fs.readFileSync(path.join(__dirname, "..", "admin", "home", "index.html"), "utf8");
const proposalsJs = fs.readFileSync(path.join(__dirname, "..", "admin", "agent-proposals.js"), "utf8");

test("admin/agent-reports.js never uses innerHTML/insertAdjacentHTML/document.write", () => {
  assert.ok(!/\.innerHTML\s*=/.test(reportsJs));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(reportsJs));
  assert.ok(!/document\.write\s*\(/.test(reportsJs));
});

test("admin/agent-reports.js fetches the list view and the per-run detail view, never any write endpoint — this page is read-only", () => {
  assert.ok(reportsJs.includes("/api/admin/bookings?view=agent-reports"));
  assert.ok(reportsJs.includes("/api/admin/bookings?view=agent-report&runId="));
  assert.ok(!/method:\s*['"]PATCH['"]/.test(reportsJs), "the report-history page must never PATCH anything — approving/rejecting lives only on admin/agent-proposals/");
  assert.ok(!/method:\s*['"]POST['"]/.test(reportsJs));
});

test("admin/agent-reports.js redirects to login on a 401, same convention as every other admin page", () => {
  assert.ok(/window\.location\.href\s*=\s*['"]\/admin\/login\/['"]/.test(reportsJs));
});

test("admin/agent-reports/index.html loads admin-chrome.js/admin-fetch.js and its own script, and is noindex,nofollow like the other secondary admin pages", () => {
  assert.ok(reportsHtml.includes('src="../admin-chrome.js"'));
  assert.ok(reportsHtml.includes('src="../admin-fetch.js"'));
  assert.ok(reportsHtml.includes('src="../agent-reports.js"'));
  assert.ok(/name="robots" content="noindex, nofollow"/.test(reportsHtml));
});

test("admin/home/index.html's connected marketing card links to BOTH the new report-history page and the existing proposals review page", () => {
  assert.ok(homeHtml.includes('href="/admin/agent-reports/"'));
  assert.ok(homeHtml.includes('href="/admin/agent-proposals/"'));
});

test("admin/home.js's renderAgentActivity degrades gracefully (hides the new summary/stats) when `latest` is absent — an older-shaped log entry from before Phase 5 must not break the Home card", () => {
  assert.ok(/if\s*\(\s*!latest\s*\)/.test(homeJs));
});

test("admin/home.js's health-status rendering reuses a named status class (all-clear/needs-attention/failed), never a raw numeric score", () => {
  assert.ok(homeJs.includes("admin-home-marketing-summary-health-"));
  assert.ok(!/healthScore|siteScore|seoScore/i.test(homeJs));
});

test("admin/agent-proposals.js's Adjust button requires non-empty feedback before submitting (client-side guard, in addition to the server-side 400)", () => {
  assert.ok(/noteInput\.value\.trim\(\)/.test(proposalsJs));
});

test("admin/agent-proposals.js's STATUS_LABELS covers 'adjust_requested'", () => {
  const match = proposalsJs.match(/var STATUS_LABELS = \{([^}]*)\}/);
  assert.ok(match);
  assert.ok(match[1].includes("adjust_requested"));
});

test("admin/agent-proposals.js states, for a proposed card, that Approve/Reject/Adjust only ever record a decision — never that the website changes", () => {
  assert.ok(/Approve\/Reject\/Adjust only records your decision here/.test(proposalsJs));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
