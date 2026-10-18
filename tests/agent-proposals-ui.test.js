// Site Improvement Agent, Phase 3 — static checks for
// admin/agent-proposals.js + admin/agent-proposals/index.html, and for
// the Home dashboard's "Review proposals" link wired to it. Same
// source-level static-analysis convention as
// tests/agent-activity-home-ui.test.js (no DOM/browser available in this
// project's test suite).
//
// Run with:  node tests/agent-proposals-ui.test.js

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

const proposalsJs = fs.readFileSync(path.join(__dirname, "..", "admin", "agent-proposals.js"), "utf8");
const proposalsHtml = fs.readFileSync(path.join(__dirname, "..", "admin", "agent-proposals", "index.html"), "utf8");
const homeHtml = fs.readFileSync(path.join(__dirname, "..", "admin", "home", "index.html"), "utf8");

test("admin/agent-proposals.js never uses innerHTML/insertAdjacentHTML/document.write", () => {
  assert.ok(!/\.innerHTML\s*=/.test(proposalsJs));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(proposalsJs));
  assert.ok(!/document\.write\s*\(/.test(proposalsJs));
});

test("Pre-acceptance hardening (audit finding #4): admin/agent-proposals.js renders a 'Stale' indicator from proposal.stale using the same safe el()/textContent helper, never innerHTML, and never hides/overrides the real status badge", () => {
  assert.ok(/proposal\.stale/.test(proposalsJs), "expected the card builder to read the derived `stale` flag");
  assert.ok(/admin-proposal-stale-badge/.test(proposalsJs), "expected a dedicated, neutral badge class — distinct from the colored status pills");
  // The stale badge must be appended ALONGSIDE the existing status
  // badge (both pushed onto `top`), never replacing it.
  const topBlockMatch = proposalsJs.match(/var top = el\('div', 'admin-proposal-card-top'\);([\s\S]*?)card\.appendChild\(top\);/);
  assert.ok(topBlockMatch, "expected to find the card-top assembly block");
  assert.ok(/top\.appendChild\(badge\)/.test(topBlockMatch[1]));
  assert.ok(/if \(proposal\.stale\)/.test(topBlockMatch[1]) && /top\.appendChild\(el\('span', 'admin-proposal-stale-badge'/.test(topBlockMatch[1]));
});

test("admin/agent-proposals.js fetches the list view and PATCHes the review resource", () => {
  assert.ok(proposalsJs.includes("/api/admin/bookings?view=agent-proposals"));
  assert.ok(proposalsJs.includes("/api/admin/bookings?resource=agent-proposal"));
  assert.ok(/method:\s*['"]PATCH['"]/.test(proposalsJs));
});

test("admin/agent-proposals.js's approve/reject buttons both call reviewProposal with the correct action string", () => {
  assert.ok(/reviewProposal\(proposal\.id,\s*'approve'/.test(proposalsJs));
  assert.ok(/reviewProposal\(proposal\.id,\s*'reject'/.test(proposalsJs));
});

test("admin/agent-proposals.js redirects to login on a 401, same convention as every other admin page", () => {
  assert.ok(proposalsJs.includes("/admin/login/"));
});

test("admin/agent-proposals/index.html loads admin-chrome.js/admin-fetch.js and its own script, and states approving never writes to the website", () => {
  assert.ok(proposalsHtml.includes('src="../admin-chrome.js"'));
  assert.ok(proposalsHtml.includes('src="../admin-fetch.js"'));
  assert.ok(proposalsHtml.includes('src="../agent-proposals.js"'));
  assert.ok(/never writes anything to the website/i.test(proposalsHtml));
});

// Website Agent dashboard pass — Home's card now links to the consolidated
// /admin/website-agent/ command-center dashboard (which embeds the
// approval queue directly, and itself still links on to this exact
// review page for the full list) rather than linking straight to
// /admin/agent-proposals/ itself. The approve/reject workflow this page
// hosts is unchanged — see the file-existence test below and
// tests/website-agent-dashboard-ui.test.js for the dashboard's own
// wiring checks.
test("admin/home/index.html's connected marketing card links to the Website Agent dashboard (which itself still links to proposals review)", () => {
  assert.ok(homeHtml.includes('href="/admin/website-agent/"'));
  const waHtml = fs.readFileSync(path.join(__dirname, "..", "admin", "website-agent", "index.html"), "utf8");
  assert.ok(waHtml.includes('href="/admin/agent-proposals/"'), "the dashboard must still link on to the full proposals review page");
});

test("Phase 4 hardening: admin/agent-proposals.js states, right at the point of action, that Approve/Reject only records a decision and never changes the website", () => {
  assert.ok(/Approve\/Reject only records your decision here — it does not change the website\./.test(proposalsJs));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
