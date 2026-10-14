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

test("admin/agent-proposals/index.html loads admin-chrome.js/admin-fetch.js and its own script, and states approving/rejecting/adjusting never writes to the website", () => {
  assert.ok(proposalsHtml.includes('src="../admin-chrome.js"'));
  assert.ok(proposalsHtml.includes('src="../admin-fetch.js"'));
  assert.ok(proposalsHtml.includes('src="../agent-proposals.js"'));
  // Phase 5: the intro paragraph's wording grew to cover the new Adjust
  // action too ("Approving, rejecting, or requesting an adjustment...")
  // — this checks the durable underlying claim (never writes to the
  // website) rather than the exact Phase-3-era sentence.
  assert.ok(/write anything to the website/i.test(proposalsHtml));
});

test("admin/home/index.html's connected marketing card links to the proposals review page", () => {
  assert.ok(homeHtml.includes('href="/admin/agent-proposals/"'));
});

test("Phase 4 hardening (extended in Phase 5 to cover Adjust): admin/agent-proposals.js states, right at the point of action, that Approve/Reject/Adjust only records a decision and never changes the website", () => {
  assert.ok(/Approve\/Reject\/Adjust only records your decision here — it does not change the website\./.test(proposalsJs));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
