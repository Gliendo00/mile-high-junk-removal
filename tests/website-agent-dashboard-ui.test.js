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

if (process.exitCode) {
  process.exit(process.exitCode);
}
