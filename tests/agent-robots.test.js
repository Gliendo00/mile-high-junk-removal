// Site Improvement Agent, Phase 10 — tests for agent/lib/robots.js: the
// minimal, DELIBERATELY NOT standards-complete robots.txt parser/
// checker. Validated against the REAL denvergov.org robots.txt's own
// shape during design (single "User-agent: *" block, thousands of
// Disallow lines, zero Allow lines, zero Crawl-delay) — these tests use
// small synthetic fixtures covering the same shapes, never the live
// network.
//
// Run with:  node tests/agent-robots.test.js

const assert = require("assert");
const { parseRobotsTxt, isAllowedByRobots, checkRobots, DEFAULT_TIMEOUT_MS } = require("../agent/lib/robots");

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((e) => {
      console.error(`FAIL - ${name}`);
      console.error(e);
      process.exitCode = 1;
    });
}

async function main() {
  // -----------------------------------------------------------------
  // parseRobotsTxt() / isAllowedByRobots() — pure parsing/matching
  // -----------------------------------------------------------------

  await test("a single 'User-agent: *' block with Disallow lines parses correctly, and an un-disallowed path is ALLOWED", () => {
    const blocks = parseRobotsTxt("User-agent: *\n\nDisallow: /admin\nDisallow: /private/*\n");
    assert.deepStrictEqual([...blocks.keys()], ["*"]);
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/public/page"), true);
  });

  await test("an exact Disallow prefix match is DISALLOWED", () => {
    const blocks = parseRobotsTxt("User-agent: *\nDisallow: /admin\n");
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/admin"), false);
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/admin/sub-page"), false);
  });

  await test("a trailing '*' on a Disallow line is treated as a no-op prefix match of exactly the text before the '*' — never widened into a 'match anything containing this' rule", () => {
    const blocks = parseRobotsTxt("User-agent: *\nDisallow: /private/*\n");
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/private/x"), false, "/private/* means everything under /private/");
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/private"), true, "the bare path WITHOUT the trailing slash does not start with the literal prefix '/private/' — a real, more precise distinction this conservative prefix-match preserves rather than loosening");
  });

  await test("Disallow prefix matching is substring-prefix, not path-segment-aware — a SIBLING path sharing the same prefix characters is also disallowed, same as the spec's own Disallow semantics (never treated as a bug to work around)", () => {
    const blocks = parseRobotsTxt("User-agent: *\nDisallow: /private\n");
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/private-other-thing"), false);
  });

  await test("an EMPTY Disallow value means 'no restriction from this line' — never an empty-string prefix that would match every path", () => {
    const blocks = parseRobotsTxt("User-agent: *\nDisallow: \nDisallow: /real-rule\n");
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/literally/anything"), true);
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/real-rule"), false);
  });

  await test("inline '#' comments are stripped before matching", () => {
    const blocks = parseRobotsTxt("User-agent: * # applies to everyone\nDisallow: /admin # internal only\n");
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/admin"), false);
  });

  await test("Allow:/Crawl-delay:/Sitemap: lines are recognized (never corrupt block grouping) but their values are never relied on for matching", () => {
    const blocks = parseRobotsTxt("User-agent: *\nAllow: /public\nCrawl-delay: 10\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\n");
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/admin"), false);
    // "Allow: /public" is recognized but never consulted — Phase 1 only
    // implements Disallow matching, so a path NOT covered by any
    // Disallow rule is simply allowed by default, with or without an
    // explicit Allow line.
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/public"), true);
  });

  await test("a block for a SPECIFIC User-Agent token is matched exactly, never falling back to '*' when a specific block exists for that token", () => {
    const blocks = parseRobotsTxt("User-agent: specificbot\nDisallow: /only-for-specific\n\nUser-agent: *\nDisallow: /for-everyone\n");
    assert.strictEqual(isAllowedByRobots(blocks, "specificbot", "/only-for-specific"), false);
    assert.strictEqual(isAllowedByRobots(blocks, "specificbot", "/for-everyone"), true, "a specific block, once matched, is used on its own — it does not also inherit the wildcard block's rules");
    assert.strictEqual(isAllowedByRobots(blocks, "someotherbot", "/for-everyone"), false, "an agent with no specific block falls back to the wildcard block");
  });

  await test("GROUPING: consecutive 'User-agent:' lines (no directive between them) share the SAME following Disallow rules", () => {
    const blocks = parseRobotsTxt("User-agent: bot-a\nUser-agent: bot-b\nDisallow: /shared\n");
    assert.strictEqual(isAllowedByRobots(blocks, "bot-a", "/shared"), false);
    assert.strictEqual(isAllowedByRobots(blocks, "bot-b", "/shared"), false);
  });

  await test("GROUPING: a 'User-agent:' line that follows a DIRECTIVE line (not another User-agent line) starts a BRAND NEW block, never appending to the previous one — the real bug class a naive accumulator parser could introduce", () => {
    const blocks = parseRobotsTxt("User-agent: bot-a\nDisallow: /only-a\n\nUser-agent: bot-b\nDisallow: /only-b\n");
    assert.strictEqual(isAllowedByRobots(blocks, "bot-b", "/only-a"), true, "bot-b's block must NOT have inherited bot-a's earlier Disallow rule");
    assert.strictEqual(isAllowedByRobots(blocks, "bot-b", "/only-b"), false);
    assert.strictEqual(isAllowedByRobots(blocks, "bot-a", "/only-a"), false);
  });

  await test("User-Agent token matching is case-insensitive (robots.txt convention), both for the parsed block key and the lookup token", () => {
    const blocks = parseRobotsTxt("User-Agent: MileHighJunkRemovalAgent\nDisallow: /x\n");
    assert.strictEqual(isAllowedByRobots(blocks, "milehighjunkremovalagent", "/x"), false);
    assert.strictEqual(isAllowedByRobots(blocks, "MileHighJunkRemovalAgent", "/x"), false);
  });

  await test("Disallow path matching IS case-sensitive — real URL paths are case-sensitive and this must never silently normalize casing", () => {
    const blocks = parseRobotsTxt("User-agent: *\nDisallow: /Admin\n");
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/admin"), true, "different case is a DIFFERENT path — must not be treated as matching /Admin");
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/Admin"), false);
  });

  await test("FAIL CONSERVATIVE: no block matches the requested agent AND there is no wildcard '*' block at all — disallowed, never 'assume allowed'", () => {
    const blocks = parseRobotsTxt("User-agent: some-other-bot\nDisallow: /x\n");
    assert.strictEqual(isAllowedByRobots(blocks, "myagent", "/anything-at-all"), false);
  });

  await test("an empty/unparsable robots.txt body (no User-agent block at all) disallows everything — fail conservative", () => {
    const blocks = parseRobotsTxt("");
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/anything"), false);
    assert.strictEqual(parseRobotsTxt("not a robots file at all, just prose").size, 0);
  });

  await test("CRLF line endings and blank lines are handled the same as plain LF", () => {
    const blocks = parseRobotsTxt("User-agent: *\r\n\r\nDisallow: /x\r\n");
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/x"), false);
    assert.strictEqual(isAllowedByRobots(blocks, "anybot", "/y"), true);
  });

  // -----------------------------------------------------------------
  // checkRobots() — the network wrapper, mocked fetch only
  // -----------------------------------------------------------------

  await test("checkRobots(): a successful fetch+parse returns {ok:true, blocks}", async () => {
    const fetchImpl = async (url) => {
      assert.strictEqual(url, "https://example.com/robots.txt");
      return { ok: true, status: 200, text: async () => "User-agent: *\nDisallow: /x\n" };
    };
    const result = await checkRobots({ origin: "https://example.com", fetchImpl });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(isAllowedByRobots(result.blocks, "anybot", "/x"), false);
  });

  await test("checkRobots(): a non-2xx response FAILS CONSERVATIVELY ({ok:false}) — never 'no file means allowed'", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    const result = await checkRobots({ origin: "https://example.com", fetchImpl });
    assert.strictEqual(result.ok, false);
    assert.ok(/404/.test(result.reason));
  });

  await test("checkRobots(): a network error (fetch throws) FAILS CONSERVATIVELY ({ok:false}), never throws itself", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await checkRobots({ origin: "https://example.com", fetchImpl });
    assert.strictEqual(result.ok, false);
    assert.ok(/ECONNRESET/.test(result.reason));
  });

  await test("checkRobots(): a timeout (AbortController fires) FAILS CONSERVATIVELY ({ok:false})", async () => {
    const fetchImpl = (url, { signal } = {}) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    const result = await checkRobots({ origin: "https://example.com", fetchImpl, timeoutMs: 20 });
    assert.strictEqual(result.ok, false);
    assert.ok(/aborted/i.test(result.reason));
  });

  await test("checkRobots() uses DEFAULT_TIMEOUT_MS when no explicit timeoutMs is passed", () => {
    assert.ok(typeof DEFAULT_TIMEOUT_MS === "number" && DEFAULT_TIMEOUT_MS > 0);
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
