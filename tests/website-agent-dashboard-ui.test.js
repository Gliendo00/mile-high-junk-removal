// Website Agent command-center dashboard (/admin/website-agent/) — static
// checks for admin/website-agent.js + admin/website-agent/index.html, and
// for the admin-chrome.js nav wiring that exposes it. No DOM/browser here
// (this project's convention for client JS it can't run headlessly is a
// source-level static-analysis guard — see e.g.
// tests/agent-activity-home-ui.test.js).
//
// Run with:  node tests/website-agent-dashboard-ui.test.js

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

const waJs = fs.readFileSync(path.join(__dirname, "..", "admin", "website-agent.js"), "utf8");
const waHtml = fs.readFileSync(path.join(__dirname, "..", "admin", "website-agent", "index.html"), "utf8");
const chromeJs = fs.readFileSync(path.join(__dirname, "..", "admin", "admin-chrome.js"), "utf8");

test("admin/website-agent.js fetches the new agent-dashboard view and the existing agent-proposals view, no new endpoints invented", () => {
  assert.ok(waJs.includes("/api/admin/bookings?view=agent-dashboard"));
  assert.ok(waJs.includes("/api/admin/bookings?view=agent-proposals"));
});

test("admin/website-agent.js's Approve/Reject reuses the EXISTING resource:\"agent-proposal\" PATCH contract unchanged", () => {
  assert.ok(waJs.includes("resource=agent-proposal"));
  assert.ok(/resource:\s*['"]agent-proposal['"]/.test(waJs));
  assert.ok(/action:\s*action/.test(waJs), "action must be passed through, not hardcoded to only approve");
});

test("admin/website-agent.js never uses innerHTML/insertAdjacentHTML/document.write", () => {
  assert.ok(!/\.innerHTML\s*=/.test(waJs));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(waJs));
  assert.ok(!/document\.write\s*\(/.test(waJs));
});

test("admin/website-agent.js never fabricates search-evidence numbers when none were gathered", () => {
  assert.ok(waJs.includes("Not yet collected"));
});

test("admin/website-agent/index.html includes the shared admin chrome + fetch scripts and its own script, same convention as every other admin page", () => {
  assert.ok(waHtml.includes('<div id="admin-chrome"></div>'));
  assert.ok(waHtml.includes('src="../admin-chrome.js"'));
  assert.ok(waHtml.includes('src="../admin-fetch.js"'));
  assert.ok(waHtml.includes('src="../website-agent.js"'));
});

test("admin/website-agent/index.html has a not-connected empty state distinct from the main body", () => {
  assert.ok(waHtml.includes('id="wa-not-connected"'));
  assert.ok(waHtml.includes('id="wa-body"'));
});

test("admin-chrome.js adds a Website Agent section pointing at /admin/website-agent/", () => {
  assert.ok(chromeJs.includes("website-agent"));
  assert.ok(chromeJs.includes("/admin/website-agent/"));
});

test("admin-chrome.js puts Website Agent in the mobile More sheet rather than bumping an item off the 4-item bottom nav", () => {
  const bottomNavMatch = chromeJs.match(/var BOTTOM_NAV_KEYS = \[([^\]]*)\];/);
  const moreSheetMatch = chromeJs.match(/var MORE_SHEET_KEYS = \[([^\]]*)\];/);
  assert.ok(bottomNavMatch && !bottomNavMatch[1].includes("website-agent"), "website-agent must not be one of the 4 direct bottom-nav links");
  assert.ok(moreSheetMatch && moreSheetMatch[1].includes("website-agent"), "website-agent must be reachable from the More sheet");
});

test("admin-chrome.js's currentSectionKey() marks /admin/website-agent/ (and its report/proposal sub-pages) as the active nav section", () => {
  assert.ok(/'\/admin\/website-agent\/'\)\s*===\s*0[\s\S]{0,80}return 'website-agent'/.test(chromeJs) || chromeJs.includes("return 'website-agent'"));
});

// =======================================================================
// Final-polish pass (metric timeframes, status reason, dark-slab fix) —
// see this pass's own commit for the full writeup.
// =======================================================================

test("final polish: top metrics are split into a Current Status group (latest-run/live numbers) and a separately labeled All-Time Totals group, never one undifferentiated row", () => {
  // Visual redesign pass (2026-10): section-label markup is now normal-
  // case text ("Current Status"/"All-Time Totals") with CSS doing the
  // uppercase display transform (text-transform: uppercase in admin.css),
  // same convention as .admin-home-metric-label elsewhere in this app —
  // so this checks the actual source text, not the rendered case.
  assert.ok(waHtml.includes("Current Status"));
  assert.ok(waHtml.includes("All-Time Totals"));
  assert.ok(waHtml.includes('id="wa-metrics-current"'));
  assert.ok(waHtml.includes('id="wa-metrics-lifetime"'));
  // Pages Monitored / Needs Review are current-state; the 4 cumulative
  // counters must NOT be rendered into the current-state container.
  assert.ok(/currentWrap\.appendChild\(buildMetricCard\('Pages Monitored'/.test(waJs));
  assert.ok(/currentWrap\.appendChild\(buildMetricCard\('Needs Review'/.test(waJs));
  assert.ok(/lifetimeWrap\.appendChild\(buildMetricCard\('Findings'/.test(waJs));
  assert.ok(!/currentWrap\.appendChild\(buildMetricCard\('Findings'/.test(waJs), "Findings is a lifetime total, must not render into the Current Status group");
});

test("final polish: the needs-attention reason line reuses the real healthSummary.text (no new/invented data) and hides for healthy/not-connected", () => {
  assert.ok(waHtml.includes('id="wa-status-reason"'));
  assert.ok(/healthSummary\s*&&\s*latestRun\.healthSummary\.text/.test(waJs) || /latestRun\.healthSummary\s*&&\s*latestRun\.healthSummary\.text/.test(waJs));
  assert.ok(/status === 'healthy'[\s\S]{0,40}reasonEl\.hidden = true/.test(waJs) || /reasonEl\.hidden = true/.test(waJs));
});

test("final polish: PROPOSAL SYNC label is unchanged (renaming it to CRM SYNC would blur it with the separate, already-distinct CRM DATA indicator)", () => {
  assert.ok(waJs.includes("'PROPOSAL SYNC'"));
  assert.ok(!waJs.includes("'CRM SYNC'"));
});

test("visual redesign (2026-10): the dark terminal-console wrapper is gone — the page uses the same light-card chrome as every other admin page, flowing directly in .admin-main with no separate dark/bordered box (so the old 'empty dark slab below Agent Activity' bug class can't recur, since there's no dark background left to leave a slab)", () => {
  assert.ok(!/class="[^"]*\badmin-wa-console\b/.test(waHtml), "the dark command-center wrapper should be removed, not just restyled");
  assert.ok(waHtml.includes('class="admin-list-heading admin-wa-heading"'), "the page title should reuse the shared .admin-list-heading component, same as every other admin page");
  const adminCss = fs.readFileSync(path.join(__dirname, "..", "admin", "admin.css"), "utf8");
  assert.ok(!/\.admin-wa-console\s*\{/.test(adminCss), "no .admin-wa-console rule should remain in admin.css");
  assert.ok(/\.admin-wa-panel\s*\{[^}]*background:\s*#fff/.test(adminCss), "Website Agent panels should be white cards like .admin-home-card/.admin-proposal-card elsewhere, not dark");
});

// =======================================================================
// Phase 14 hotfix — a proposal must never appear to vanish from this
// dashboard merely because Execute was clicked. See
// tests/agent-execute-proposal.test.js for the companion backend fix.
// =======================================================================

test("Phase 14 hotfix: the dashboard renders every execution-lifecycle status (applying/validating/deploying/deployed/failed/needs_review), not just 'proposed'", () => {
  ["applying", "validating", "deploying", "deployed", "failed", "needs_review"].forEach((status) => {
    assert.ok(waJs.includes(`${status}:`) || waJs.includes(`'${status}'`), `expected website-agent.js to reference status "${status}"`);
  });
  assert.ok(/EXECUTION_LIFECYCLE_STATUSES/.test(waJs), "expected a dedicated list of execution-lifecycle statuses, not an ad-hoc check");
  assert.ok(/renderExecutionStatus/.test(waJs), "expected a dedicated render function for execution-lifecycle proposals");
  assert.ok(/renderExecutionStatus\(\s*proposals\s*\)/.test(waJs), "renderExecutionStatus must be called with the FULL proposals list, not the 'proposed'-only filtered one");
});

test("Phase 14 hotfix: the execution-status section is hidden by default and only appears via JS when something is actually in progress — never a permanent empty panel", () => {
  assert.ok(waHtml.includes('id="wa-execution-section" hidden'), "the section must start hidden in markup, not rely on CSS alone");
  assert.ok(waHtml.includes('id="wa-execution-list"'));
  assert.ok(/section\.hidden\s*=\s*true/.test(waJs) && /section\.hidden\s*=\s*false/.test(waJs), "must explicitly toggle hidden based on whether any proposal is in progress");
});

test("Phase 14 hotfix: the execution-status card is read-only here (no Approve/Reject/Execute actions duplicated on this page) and links back to the full proposals page", () => {
  const fnMatch = waJs.match(/function buildExecutionCard[\s\S]*?\n  \}/);
  assert.ok(fnMatch, "expected a buildExecutionCard function");
  const fnBody = fnMatch[0];
  assert.ok(!/addEventListener\('click'/.test(fnBody), "this card must not wire up its own action buttons — actions stay on /admin/agent-proposals/");
  assert.ok(/\/admin\/agent-proposals\//.test(fnBody), "must link back to the full proposals page for whatever action comes next");
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
