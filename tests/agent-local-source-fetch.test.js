// Site Improvement Agent, Phase 10 — tests for
// agent/lib/local-source-fetch.js: the ONE module that touches the
// network for Curated Official Source Evidence. ALL network access here
// is MOCKED (fetchImpl injected) — these tests never hit the real
// Denver site; the real site was verified separately, by hand, during
// design (see agent/context/local-source-registry.json's own
// verificationNotes, and this file's "REAL DENVER SMOKE TEST" section
// below, which is SKIPPED by default specifically so the ordinary test
// suite never hammers the real network).
//
// Run with:  node tests/agent-local-source-fetch.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  fetchLocalSourceEvidence,
  writeLocalSourceEvidence,
  stripHtmlToText,
  extractAnchorText,
  boundSnippet,
  EVIDENCE_DIR,
  USER_AGENT,
} = require("../agent/lib/local-source-fetch");
const { MAX_SNIPPET_CHARS } = require("../agent/lib/local-source-evidence");

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

const ENTRY = {
  id: "example-entry",
  locality: "Example, CO",
  domain: "example.gov",
  url: "https://www.example.gov/My-Property/Seasonal-Programs/LeafDrop",
  topic: "example-program",
  authorityClass: "official-government",
  expectedTemporality: "temporary",
};

const SAMPLE_PAGE = "<html><head><title>LeafDrop - City of Example</title></head><body><nav>Skip to content Quick Links</nav><h1>LeafDrop</h1><p>The City of Example runs a seasonal leaf drop-off program each fall.</p></body></html>";

function mockFetch({ robotsBody = "User-agent: *\n", robotsStatus = 200, pageStatus = 200, pageBody = SAMPLE_PAGE, pageHeaders, onPageRequest } = {}) {
  return async (url, options) => {
    if (String(url).endsWith("/robots.txt")) {
      return { ok: robotsStatus >= 200 && robotsStatus < 300, status: robotsStatus, text: async () => robotsBody };
    }
    if (onPageRequest) onPageRequest(url, options);
    return {
      ok: pageStatus >= 200 && pageStatus < 300,
      status: pageStatus,
      headers: { get: () => (pageHeaders && pageHeaders.location) || null },
      text: async () => pageBody,
    };
  };
}

async function main() {
  // -----------------------------------------------------------------
  // fetchLocalSourceEvidence() — happy path + structural guarantees
  // -----------------------------------------------------------------

  await test("a fully-allowed fetch returns {skipped:false, evidence} with the correct, bounded, anchored shape", async () => {
    const fetchImpl = mockFetch();
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.evidence.sourceUrl, ENTRY.url);
    assert.strictEqual(result.evidence.sourceDomain, ENTRY.domain);
    assert.strictEqual(result.evidence.discoveryMethod, "known-url");
    assert.strictEqual(result.evidence.robots.allowed, true);
    assert.ok(result.evidence.extractedSnippet.includes("seasonal leaf drop-off program"));
  });

  await test("ONLY the registry entry's own declared `url` is ever requested — never an arbitrary/caller-supplied URL (there is no parameter through which one could be passed)", async () => {
    const requestedUrls = [];
    const fetchImpl = mockFetch({ onPageRequest: (url) => requestedUrls.push(String(url)) });
    await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.deepStrictEqual(requestedUrls, [ENTRY.url]);
  });

  await test("an entry with no recognizable shape (null, not an object) is refused as skipped, never throws", async () => {
    const r1 = await fetchLocalSourceEvidence(null, { fetchImpl: mockFetch() });
    assert.strictEqual(r1.skipped, true);
    const r2 = await fetchLocalSourceEvidence("https://evil.example.com/arbitrary", { fetchImpl: mockFetch() });
    assert.strictEqual(r2.skipped, true, "a raw string (even URL-shaped) is never treated as a fetchable target — only a real entry object with its own .url is");
  });

  await test("an entry with an unparsable url is refused as skipped, never throws", async () => {
    const result = await fetchLocalSourceEvidence({ ...ENTRY, url: "not a url" }, { fetchImpl: mockFetch() });
    assert.strictEqual(result.skipped, true);
    assert.ok(/unparsable/.test(result.reason));
  });

  // -----------------------------------------------------------------
  // robots.txt gating
  // -----------------------------------------------------------------

  await test("ROBOTS ALLOW: a path not matched by any Disallow rule proceeds to fetch the page", async () => {
    const fetchImpl = mockFetch({ robotsBody: "User-agent: *\nDisallow: /somewhere-else\n" });
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, false);
  });

  await test("ROBOTS DISALLOW: the entry's own path matched by a Disallow rule refuses the fetch — the page is NEVER requested", async () => {
    let pageWasRequested = false;
    const fetchImpl = mockFetch({
      robotsBody: "User-agent: *\nDisallow: /My-Property/Seasonal-Programs/LeafDrop\n",
      onPageRequest: () => {
        pageWasRequested = true;
      },
    });
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/disallows/.test(result.reason));
    assert.strictEqual(result.robots.allowed, false);
    assert.strictEqual(pageWasRequested, false, "the actual page must never be requested once robots.txt disallows it");
  });

  await test("ROBOTS UNAVAILABLE (non-2xx): fails conservatively — refuses the fetch, never treats 'no robots.txt' as 'fetch freely'", async () => {
    const fetchImpl = mockFetch({ robotsStatus: 404 });
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/robots\.txt check failed/.test(result.reason));
  });

  await test("ROBOTS AMBIGUOUS (network error fetching robots.txt itself): fails conservatively, never throws", async () => {
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/robots.txt")) throw new Error("DNS resolution failed");
      throw new Error("should never reach the page fetch");
    };
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/robots\.txt check failed/.test(result.reason));
  });

  // -----------------------------------------------------------------
  // network/HTTP failure handling for the page fetch itself
  // -----------------------------------------------------------------

  await test("TIMEOUT: the page fetch is aborted after fetchTimeoutMs and reported as a skip, never throws uncaught", async () => {
    const fetchImpl = async (url, { signal } = {}) => {
      if (String(url).endsWith("/robots.txt")) return { ok: true, status: 200, text: async () => "User-agent: *\n" };
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    };
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl, fetchTimeoutMs: 20 });
    assert.strictEqual(result.skipped, true);
    assert.ok(/fetch failed/.test(result.reason));
  });

  await test("NETWORK ERROR fetching the page itself: reported as a skip, never throws", async () => {
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/robots.txt")) return { ok: true, status: 200, text: async () => "User-agent: *\n" };
      throw new Error("ECONNRESET");
    };
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/ECONNRESET/.test(result.reason));
  });

  await test("NON-2xx page response (e.g. 404/500): reported as a skip, never throws, never produces evidence", async () => {
    const fetchImpl = mockFetch({ pageStatus: 500 });
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/HTTP 500/.test(result.reason));
  });

  await test("REDIRECT (3xx) is NEVER followed automatically, even to the entry's OWN declared domain — treated as a skip requiring re-verification of the registry entry", async () => {
    const fetchImpl = mockFetch({ pageStatus: 302, pageHeaders: { location: "https://www.example.gov/My-Property/Seasonal-Programs/LeafDrop-Renamed" } });
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/redirect/.test(result.reason));
    assert.ok(/re-verify/.test(result.reason));
  });

  await test("REDIRECT to a NON-curated, completely different domain is likewise never followed — same refusal path as any other redirect", async () => {
    const fetchImpl = mockFetch({ pageStatus: 302, pageHeaders: { location: "https://evil.example.com/phishing" } });
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/redirect/.test(result.reason));
  });

  await test("a page response with no extractable text content is reported as a skip, never produces empty evidence", async () => {
    const fetchImpl = mockFetch({ pageBody: "<html><head></head><body><script>var x = 1;</script></body></html>" });
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, true);
    assert.ok(/no extractable text/.test(result.reason));
  });

  // -----------------------------------------------------------------
  // bounded extraction — never raw HTML, always capped
  // -----------------------------------------------------------------

  await test("stripHtmlToText() strips tags/scripts/styles/head and decodes common entities, collapsing whitespace", () => {
    const html = "<head><title>T</title></head><body><script>bad()</script><style>.x{}</style><h1>Hello &amp; Welcome</h1>   <p>Line&nbsp;one.</p></body>";
    const text = stripHtmlToText(html);
    assert.strictEqual(text, "Hello & Welcome Line one.");
  });

  await test("extractAnchorText() prefers <h1>, falling back to <title> only when no <h1> exists", () => {
    assert.strictEqual(extractAnchorText("<head><title>Page Title</title></head><body><h1>Real Heading</h1></body>"), "Real Heading");
    assert.strictEqual(extractAnchorText("<head><title>Only A Title</title></head><body><p>no heading here</p></body>"), "Only A Title");
    assert.strictEqual(extractAnchorText("<body><p>nothing at all</p></body>"), null);
  });

  await test("boundSnippet() starts from the anchor's position when found, and from 0 when the anchor is absent/not found", () => {
    const text = "some nav chrome here then Real Content starts and continues on";
    assert.strictEqual(boundSnippet(text, "Real Content", 11), "Real Conten");
    assert.strictEqual(boundSnippet(text, "text that never appears", 9), "some nav ");
    assert.strictEqual(boundSnippet(text, null, 9), "some nav ");
  });

  await test(`the extracted snippet is NEVER longer than MAX_SNIPPET_CHARS (${MAX_SNIPPET_CHARS}), even for a very large page`, async () => {
    const hugeBody = `<head><title>T</title></head><body><h1>LeafDrop</h1><p>${"word ".repeat(5000)}</p></body>`;
    const fetchImpl = mockFetch({ pageBody: hugeBody });
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, false);
    assert.ok(result.evidence.extractedSnippet.length <= MAX_SNIPPET_CHARS);
  });

  await test("RAW HTML IS NEVER PERSISTED: the evidence object (and its JSON serialization) never contains an HTML tag, <script> content, or the full original markup", async () => {
    const fetchImpl = mockFetch({ pageBody: SAMPLE_PAGE });
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(result.skipped, false);
    const serialized = JSON.stringify(result.evidence);
    assert.strictEqual(/<html|<head|<body|<script|<nav|<h1|<p>/i.test(serialized), false, "no HTML tag must survive into the persisted evidence");
  });

  // -----------------------------------------------------------------
  // USER_AGENT — honest identification, never a browser impersonation
  // -----------------------------------------------------------------

  await test("the page request carries the agent's own honest, identifying User-Agent header — never a browser impersonation", async () => {
    let seenHeader = null;
    const fetchImpl = mockFetch({
      onPageRequest: (url, options) => {
        seenHeader = options && options.headers && options.headers["User-Agent"];
      },
    });
    await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    assert.strictEqual(seenHeader, USER_AGENT);
    assert.ok(/contact@/.test(USER_AGENT), "the User-Agent must include a real contact address");
    assert.strictEqual(/mozilla|chrome|safari/i.test(USER_AGENT), false, "must never masquerade as a browser");
  });

  // -----------------------------------------------------------------
  // writeLocalSourceEvidence() — persistence
  // -----------------------------------------------------------------

  await test("writeLocalSourceEvidence() writes a new, distinct file per call (never a rolling overwrite), and never persists raw HTML", async () => {
    const fetchImpl = mockFetch();
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-source-fetch-test-"));
    try {
      const path1 = writeLocalSourceEvidence(result.evidence, undefined, tmpDir);
      const path2 = writeLocalSourceEvidence(result.evidence, undefined, tmpDir);
      assert.notStrictEqual(path1, path2);
      const written = JSON.parse(fs.readFileSync(path1, "utf8"));
      assert.strictEqual(written.sourceUrl, ENTRY.url);
      assert.strictEqual(/<html|<script/i.test(fs.readFileSync(path1, "utf8")), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test("writeLocalSourceEvidence() produces distinct files even when Date.now() is frozen to the SAME millisecond for both calls (pre-acceptance hardening, audit finding #6 — the prior millisecond-only filename was a reproducible collision/silent-overwrite risk)", async () => {
    const fetchImpl = mockFetch();
    const result = await fetchLocalSourceEvidence(ENTRY, { fetchImpl });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-source-fetch-collision-test-"));
    const originalNow = Date.now;
    const frozenMs = originalNow();
    Date.now = () => frozenMs;
    try {
      const path1 = writeLocalSourceEvidence(result.evidence, undefined, tmpDir);
      const path2 = writeLocalSourceEvidence(result.evidence, undefined, tmpDir);
      assert.notStrictEqual(path1, path2, "two writes in the identical millisecond must still produce distinct paths");
      assert.strictEqual(fs.readdirSync(tmpDir).length, 2, "both files must actually exist on disk — neither write may have silently overwritten the other");
      assert.ok(/-[0-9a-f]{6}\.json$/.test(path1) && /-[0-9a-f]{6}\.json$/.test(path2), "filenames must carry the random suffix, not just the raw timestamp");
    } finally {
      Date.now = originalNow;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test("EVIDENCE_DIR points at agent/research/local-sources/", () => {
    assert.ok(EVIDENCE_DIR.replace(/\\/g, "/").endsWith("agent/research/local-sources"));
  });

  // -----------------------------------------------------------------
  // REAL DENVER verification — SKIPPED by default; was run by hand
  // during design (see this file's own header and the registry's
  // verificationNotes). Set RUN_REAL_DENVER_SMOKE_TEST=1 to re-verify
  // against the live network manually; never run as part of the
  // ordinary suite.
  // -----------------------------------------------------------------

  if (process.env.RUN_REAL_DENVER_SMOKE_TEST === "1") {
    await test("REAL network: the actual Denver LeafDrop registry entry fetches successfully end to end", async () => {
      const { getEntryById } = require("../agent/lib/local-source-registry");
      const entry = getEntryById("denver-leafdrop");
      const result = await fetchLocalSourceEvidence(entry);
      assert.strictEqual(result.skipped, false, result.reason);
      assert.ok(result.evidence.extractedSnippet.length > 0);
    });
  }

  if (process.exitCode) process.exit(process.exitCode);
}

main();
