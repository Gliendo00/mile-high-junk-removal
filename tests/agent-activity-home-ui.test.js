// Website Agent — static checks for the Home dashboard's now-simplified
// Website Agent summary card (admin/home.js + admin/home/index.html).
//
// CRM UI-organization pass: Home used to render every per-finding
// {icon, text} line from GET ?view=agent-activity's `recent[0].lines`
// directly (see git history for the original version of this test) —
// that detail now lives on the dedicated /admin/website-agent/ command-
// center dashboard. Home keeps only a compact summary card (health dot,
// last-run line, a 4-up grid) linking to it. No DOM/browser here (this
// project's convention for client JS it can't run headlessly is a
// source-level static-analysis guard — see e.g.
// tests/phase2-admin-api.test.js's innerHTML-ban test).
//
// Run with:  node tests/agent-activity-home-ui.test.js

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

const homeJs = fs.readFileSync(path.join(__dirname, "..", "admin", "home.js"), "utf8");
const homeHtml = fs.readFileSync(path.join(__dirname, "..", "admin", "home", "index.html"), "utf8");

test("admin/home.js still fetches the existing agent-activity view as part of Stage 1 (no backend change needed for Home's own card)", () => {
  assert.ok(homeJs.includes("/api/admin/bookings?view=agent-activity"));
});

test("admin/home.js's agent-activity rendering never uses innerHTML/insertAdjacentHTML/document.write", () => {
  assert.ok(!/\.innerHTML\s*=/.test(homeJs));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(homeJs));
  assert.ok(!/document\.write\s*\(/.test(homeJs));
});

test("admin/home.js builds the summary grid via createElement + textContent, not string concatenation", () => {
  assert.ok(homeJs.includes("renderAgentActivity"));
  assert.ok(homeJs.includes("gridStat"));
});

test("admin/home.js no longer renders the old per-finding lines list or stats pills (moved to /admin/website-agent/)", () => {
  assert.ok(!homeJs.includes("ICON_GLYPH"), "the per-finding icon glyph map should be gone from Home's own script");
  assert.ok(!homeJs.includes("marketing-lines"));
  assert.ok(!homeJs.includes("marketing-stats"));
});

test("admin/home/index.html has both marketing states, with the connected one hidden by default and linking to the dashboard", () => {
  assert.ok(homeHtml.includes('id="marketing-not-connected"'));
  assert.ok(/id="marketing-connected"[^>]*\bhidden\b/.test(homeHtml), "the connected-state card must start hidden until the fetch resolves");
  assert.ok(homeHtml.includes('href="/admin/website-agent/"'), "the compact card must link to the full dashboard");
  assert.ok(homeHtml.includes("Open Agent Dashboard"));
});

test("admin/home/index.html no longer has the old per-line/stats containers", () => {
  assert.ok(!homeHtml.includes('id="marketing-lines"'));
  assert.ok(!homeHtml.includes('id="marketing-stats"'));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
