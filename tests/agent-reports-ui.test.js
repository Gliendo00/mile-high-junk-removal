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

// Phase 5B — a run awaiting external research must be visibly
// distinguishable in the CRM, not silently indistinguishable from
// all-clear (the status class itself is generic/data-driven on both
// surfaces — see admin/home.js/admin/agent-reports.js's own status-class
// concatenation — so the CSS rule's existence is the actual proof the
// UI has a real rendering for this state rather than falling through to
// "unknown").
test("admin.css defines a distinct visual treatment for the 'research-pending' status on both the Home card and the report-history list", () => {
  const adminCss = fs.readFileSync(path.join(__dirname, "..", "admin", "admin.css"), "utf8");
  assert.ok(adminCss.includes("admin-home-marketing-summary-health-research-pending"));
  assert.ok(adminCss.includes("admin-report-row-outcome-research-pending"));
});

test("admin/agent-reports.js's report detail view surfaces the pending research questions (not a dead end) when a run is awaiting research", () => {
  assert.ok(/research_pending/.test(reportsJs));
  assert.ok(/questionsPending/.test(reportsJs));
});

// Phase 5B fix, caught by visual browser testing: .admin-status-badge is
// white-space:nowrap by design (every other badge in this app is a short
// label like "Daily"/"Approved"). outcomeLabel() originally returned the
// full healthSummary.text SENTENCE for the pill badge, which overflowed
// the row on any screen (worst on mobile — see agent/README.md's own
// Phase 5B section). The fix: the list row shows a SHORT label (matching
// the original CRM mockup: "All Clear" / "1 Proposal" / "2 Pending"); the
// full sentence is reserved for the unconstrained detail view below.
test("admin/agent-reports.js's list-row outcome label is short (never the full healthSummary sentence) — must not overflow the pill-shaped, nowrap status badge", () => {
  assert.ok(!/return entry\.healthSummary\.text/.test(reportsJs), "the list row must not use the full healthSummary.text sentence as a badge label");
  assert.ok(/Pending/.test(reportsJs) && /All Clear/.test(reportsJs), "expected short, mockup-matching labels like 'N Pending'/'All Clear'");
});

// Phase 5B — Adjust was evaluated in Phase 5 and deliberately DEFERRED
// (see agent/README.md's "Phase 5B" section: it required a separate
// human/Claude session to act on, which wasn't enough value yet to
// justify the production schema change). No Adjust UI/API/DB state
// should remain anywhere in this codebase — this is a hard regression
// guard against it silently creeping back in.
test("no 'adjust'/'adjust_requested' reference remains anywhere in the agent CRM surface (UI, API, or SQL) — Adjust was deferred in Phase 5B", () => {
  const proposalsJs = fs.readFileSync(path.join(__dirname, "..", "admin", "agent-proposals.js"), "utf8");
  const proposalsHtml = fs.readFileSync(path.join(__dirname, "..", "admin", "agent-proposals", "index.html"), "utf8");
  const bookingsJs = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "bookings.js"), "utf8");
  const proposalsSyncJs = fs.readFileSync(path.join(__dirname, "..", "agent", "lib", "proposals-sync.js"), "utf8");
  const adminCss = fs.readFileSync(path.join(__dirname, "..", "admin", "admin.css"), "utf8");
  const files = [
    ["admin/agent-reports.js", reportsJs],
    ["admin/agent-reports/index.html", reportsHtml],
    ["admin/home.js", homeJs],
    ["admin/home/index.html", homeHtml],
    ["admin/agent-proposals.js", proposalsJs],
    ["admin/agent-proposals/index.html", proposalsHtml],
    ["api/admin/bookings.js", bookingsJs],
    ["agent/lib/proposals-sync.js", proposalsSyncJs],
    ["admin/admin.css", adminCss],
  ];
  // Matches the Adjust-WORKFLOW-specific vocabulary only (not the bare
  // English word "adjust" — admin/home.js legitimately uses it elsewhere,
  // e.g. "the greeting adjusts to local time", unrelated to proposals).
  const ADJUST_WORKFLOW_PATTERN = /adjust_requested|adjustNote|adjust_note|adjustedAt|adjusted_at|action\s*===\s*['"]adjust['"]|'adjust'\s*,/i;
  for (const [name, src] of files) {
    assert.ok(!ADJUST_WORKFLOW_PATTERN.test(src), `${name} must not reference the Adjust proposal workflow — it was deferred in Phase 5B`);
  }
});

test("no Phase 5 Adjust-workflow SQL migration file exists in sql/", () => {
  const sqlFiles = fs.readdirSync(path.join(__dirname, "..", "sql"));
  assert.ok(!sqlFiles.some((f) => /adjust/i.test(f)), "the deferred Adjust migration must not exist in sql/");
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
