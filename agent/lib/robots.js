// Site Improvement Agent, Phase 10 -- minimal, DELIBERATELY NOT
// standards-complete robots.txt handling.
//
// Supports exactly the subset Phase 1's one verified host
// (denvergov.org -- a 7629-line file consisting of a single
// "User-agent: *" block, hundreds of "Disallow:" lines, zero "Allow:"
// lines, zero "Crawl-delay:" lines, and one "Sitemap:" line) actually
// needs: grouped "User-agent:" lines (the standard robots.txt grouping
// rule -- consecutive User-agent lines with no directive between them
// share one block), "Disallow:" (exact-prefix match -- the original
// robots.txt spec's own semantics; a trailing "*" is treated as a no-op
// rather than a real wildcard, since stripping it can only ever make a
// rule MORE restrictive, never less, than the real intent). "Allow:",
// "Crawl-delay:", and "Sitemap:" lines are recognized (so they don't
// corrupt block-grouping) but their VALUES are never read or relied on
// -- this phase never does sitemap-based discovery, and never attempts
// polite crawl-delay pacing beyond its own fixed per-call timeout.
//
// This is NOT a general-purpose robots.txt library, and must never be
// mistaken for one: do not reuse this against a host whose robots.txt
// behavior hasn't been separately, manually verified the same way
// agent/context/local-source-registry.json's own entries are.
//
// FAILS CONSERVATIVELY, ALWAYS: robots.txt unreachable, a non-2xx
// response, a read/parse failure, or simply no block matching either
// the exact requested User-Agent or the wildcard "*" -- every one of
// these is treated as DISALLOWED, never as "no file means fetch
// freely." Being wrong in the direction of "didn't fetch" is the only
// safe direction to be wrong in here.

const USER_AGENT_LINE = /^user-agent:\s*(.*)$/i;
const DISALLOW_LINE = /^disallow:\s*(.*)$/i;

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * @param {string} text - raw robots.txt content
 * @returns {Map<string, string[]>} lowercased user-agent token -> array of Disallow path-prefixes
 *   (never an empty-string prefix -- "Disallow:" with no value means "no restriction from this
 *   line" and is correctly skipped, never treated as disallowing every path)
 */
function parseRobotsTxt(text) {
  const blocks = new Map();
  let currentAgents = [];
  let lastLineWasUserAgent = false;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim(); // strip inline comments
    if (!line) continue;

    const uaMatch = line.match(USER_AGENT_LINE);
    if (uaMatch) {
      const agent = uaMatch[1].trim().toLowerCase();
      if (!agent) {
        lastLineWasUserAgent = true;
        continue;
      }
      // A User-agent line immediately following ANOTHER User-agent line
      // (no directive in between) joins the SAME block (the standard
      // grouping rule). Otherwise it starts a brand-new block.
      if (!lastLineWasUserAgent) currentAgents = [];
      currentAgents.push(agent);
      if (!blocks.has(agent)) blocks.set(agent, []);
      lastLineWasUserAgent = true;
      continue;
    }

    lastLineWasUserAgent = false;

    const disallowMatch = line.match(DISALLOW_LINE);
    if (disallowMatch) {
      let value = disallowMatch[1].trim();
      if (!value) continue; // empty Disallow value = no restriction, never an empty-prefix match-everything rule
      value = value.replace(/\*+$/, ""); // trailing "*" is a no-op under prefix matching
      for (const agent of currentAgents) blocks.get(agent).push(value);
      continue;
    }

    // Allow / Crawl-delay / Sitemap / any other directive — recognized
    // only so it correctly ends the current User-agent grouping; its
    // own value is never read.
  }

  return blocks;
}

/**
 * @param {Map<string, string[]>} blocks - parseRobotsTxt()'s output
 * @param {string} userAgentToken - the literal token to look up (e.g. "milehighjunkremovalagent") —
 *   NOT the full User-Agent header string; falls back to the wildcard "*" block when there is
 *   no block for this exact token, same as the spec's own precedence rule
 * @param {string} pathname - a URL pathname (e.g. "/My-Property/...") — never includes the query string
 */
function isAllowedByRobots(blocks, userAgentToken, pathname) {
  const specific = blocks.get(String(userAgentToken || "").toLowerCase());
  const rules = specific !== undefined ? specific : blocks.get("*");
  if (rules === undefined) return false; // no matching block at all — fail conservative, never "assume allowed"
  return !rules.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Fetches and parses robots.txt for `origin` exactly ONCE per call — see
 * agent/README.md's Phase 10 section ("robots retrieval cadence") for why
 * one retrieval per host per invocation, reused for every page checked
 * against that host within the SAME process run, is the chosen
 * granularity (not cached across separate process runs, and never
 * re-fetched per-page within one run).
 * @param {object} args
 * @param {string} args.origin - e.g. "https://www.denvergov.org"
 * @param {function} [args.fetchImpl]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ok:true, blocks:Map}|{ok:false, reason:string}>}
 */
async function checkRobots({ origin, fetchImpl, timeoutMs } = {}) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await doFetch(`${origin}/robots.txt`, { signal: controller.signal });
    } catch (e) {
      return { ok: false, reason: `robots.txt fetch failed: ${e && e.message ? e.message : e}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `robots.txt returned HTTP ${response.status}` };
    }
    let text;
    try {
      text = await response.text();
    } catch (e) {
      return { ok: false, reason: `could not read robots.txt body: ${e && e.message ? e.message : e}` };
    }
    return { ok: true, blocks: parseRobotsTxt(text) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { parseRobotsTxt, isAllowedByRobots, checkRobots, DEFAULT_TIMEOUT_MS };
