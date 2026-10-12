// Site Improvement Agent — static checks for the Home dashboard's
// Website & Marketing Activity wiring (admin/home.js + admin/home/index.html).
// No DOM/browser here (this project's convention for client JS it can't
// run headlessly is a source-level static-analysis guard — see e.g.
// tests/phase2-admin-api.test.js's innerHTML-ban test), so this proves
// the wiring is present and follows the same no-innerHTML discipline
// every other admin page's JS already does, and that the two markup
// states actually exist with the right default visibility.
//
// Run with:  node tests/agent-activity-home-ui.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { iconForFinding } = require("../agent/lib/history");

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

test("admin/home.js fetches the new agent-activity view as part of Stage 1", () => {
  assert.ok(homeJs.includes("/api/admin/bookings?view=agent-activity"));
});

test("admin/home.js's agent-activity rendering never uses innerHTML/insertAdjacentHTML/document.write", () => {
  assert.ok(!/\.innerHTML\s*=/.test(homeJs));
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(homeJs));
  assert.ok(!/document\.write\s*\(/.test(homeJs));
});

test("admin/home.js builds each activity line via createElement + textContent, not string concatenation", () => {
  assert.ok(homeJs.includes("renderAgentActivity"));
  assert.ok(homeJs.includes("document.createElement('div')"));
  assert.ok(/text\.textContent\s*=\s*line\.text/.test(homeJs));
});

test("admin/home.js's icon glyph map covers every icon agent/lib/history.js can actually produce", () => {
  const sampleFindings = [
    { decision: "APPLY_SAFE_FIX", status: "applied" },
    { decision: "APPLY_SAFE_FIX", status: "proposed" },
    { decision: "RESEARCH_MORE" },
    { decision: "NO_CHANGE" },
    { decision: "NO_CHANGE", tier: "observation" },
    { decision: "REJECT_OPPORTUNITY" },
    { decision: "PROPOSE_CHANGE" },
  ];
  const possibleIcons = new Set(sampleFindings.map(iconForFinding));
  possibleIcons.add("check"); // the always-present "Checked N pages" line

  const match = homeJs.match(/var ICON_GLYPH = \{([^}]*)\};/);
  assert.ok(match, "expected an ICON_GLYPH map literal in admin/home.js");
  for (const icon of possibleIcons) {
    assert.ok(match[1].includes(icon + ":"), `ICON_GLYPH is missing an entry for icon "${icon}"`);
  }
});

test("admin/home/index.html has both marketing states, with the connected one hidden by default", () => {
  assert.ok(homeHtml.includes('id="marketing-not-connected"'));
  assert.ok(/id="marketing-connected"[^>]*\bhidden\b/.test(homeHtml), "the connected-state card must start hidden until the fetch resolves");
  assert.ok(homeHtml.includes('id="marketing-lines"'));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
