// Batch 1 (auth reliability) — local, offline test harness for
// admin/admin-fetch.js's adminFetch(): the shared retry-once-on-401 helper
// that fixes the actual concurrency bug this batch was scoped to fix.
//
// This app has no single-page-app shell, so each admin page loads several
// independent scripts that each fire their own /api/admin/* request on
// DOMContentLoaded (nav-badge.js plus whichever page-specific script(s) —
// see e.g. admin/index.html). When the access-token cookie has expired, two
// of those requests can race to use the SAME refresh-token cookie; Supabase
// rotates it on first use, so the loser gets a hard 401 even though the
// session is fine a moment later. See admin/admin-fetch.js's own header
// comment for the full design rationale (in short: wait for every OTHER
// in-flight adminFetch() call to actually settle — not an arbitrary timer —
// before retrying once, since a browser applies a response's Set-Cookie
// header before that response's fetch() promise ever resolves).
//
// admin-fetch.js is not server code, so it can't reuse the fake-Supabase
// harness tests/phase2-admin-api.test.js and tests/phase3c-admin-session-
// check.test.js share. It's plain global-scope browser JS (an IIFE that
// reads the ambient `fetch` and assigns `window.adminFetch`, no bundler/
// module system), so it's loaded here with Node's `vm` module into a fresh
// sandbox per test — never `require()`, which would cache module state
// across tests and defeat the point of re-testing a clean `inFlight`
// registry each time — with a hand-controlled, manually-resolved fake
// `fetch` standing in for the network so the exact interleaving described
// in each test (who resolves when, in what order) is deterministic, not
// timing-dependent.
//
// Run with:  node tests/phase3c-admin-fetch-retry.test.js
// Exits with a non-zero code if any assertion fails.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ADMIN_FETCH_SRC = fs.readFileSync(path.join(__dirname, "..", "admin", "admin-fetch.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise(function (res) { resolve = res; });
  return { promise: promise, resolve: resolve };
}

// One macrotask turn is enough for Node to have drained every microtask
// queued by the adminFetch() promise chain(s) under test (waitForSiblings's
// Promise.all, the .then chains, etc.) — deterministic given everything
// those chains await is itself resolved manually by the test, never a real
// timer or real network call.
function tick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

// Loads a fresh copy of admin-fetch.js into an isolated sandbox with a
// hand-controlled `fetch`, so `inFlight` starts empty every time and the
// exact call sequence (who resolves when) is fully test-controlled. Returns
// { adminFetch, calls } where `calls` is a log of every fetch(url, options)
// invocation, each with a `.resolve(responseLike)` to settle it on demand.
function loadAdminFetch() {
  const calls = [];
  const sandbox = {
    fetch: function (url, options) {
      const d = deferred();
      calls.push({ url: url, options: options, resolve: d.resolve });
      return d.promise;
    },
    window: {},
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(ADMIN_FETCH_SRC, sandbox, { filename: "admin-fetch.js" });
  return { adminFetch: sandbox.window.adminFetch, calls: calls };
}

const registered = [];
function test(name, fn) { registered.push({ name, fn }); }

test("adminFetch: no race, resolves the response directly on the first try", async () => {
  const { adminFetch, calls } = loadAdminFetch();
  const result = adminFetch("/api/admin/bookings?countsOnly=1");
  assert.strictEqual(calls.length, 1);
  calls[0].resolve({ status: 200, ok: true });
  const res = await result;
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 1, "a clean 200 must never trigger a retry");
});

// The exact scenario requested: two admin requests begin concurrently, the
// access token is expired, both start with the same refresh token, one
// (A) wins the refresh race, the other (B) initially fails auth because of
// the race, B's adminFetch() retry succeeds using the newly-written
// session, and B must resolve to that success — never to the original 401
// — so a caller's `if (res.status === 401) window.location.href =
// '/admin/login/'` never fires for B.
test("adminFetch: concurrent race — loser waits for the winner, then retries into success (no login redirect)", async () => {
  const { adminFetch, calls } = loadAdminFetch();

  const resultA = adminFetch("/api/admin/auth?action=session"); // wins the refresh
  const resultB = adminFetch("/api/admin/bookings?countsOnly=1"); // loses the refresh
  assert.strictEqual(calls.length, 2, "both concurrent requests should have fired immediately");

  // B's request reaches the server with the now-already-rotated refresh
  // token and comes back 401 FIRST — a real possibility, since a failed
  // verification can return faster than A's full successful round trip to
  // Supabase to actually rotate the token.
  calls[1].resolve({ status: 401 });
  await tick();
  assert.strictEqual(calls.length, 2, "B must wait for sibling A rather than retrying immediately");

  // A's refresh now completes and "writes" the new session (in the real
  // browser, this is the moment Set-Cookie for the rotated pair is applied
  // — before A's own fetch() promise resolves to this handler at all).
  calls[0].resolve({ status: 200, ok: true, __session: "rotated" });
  await tick();

  assert.strictEqual(calls.length, 3, "B should now have retried exactly once, only after A settled");
  assert.strictEqual(calls[2].url, "/api/admin/bookings?countsOnly=1");
  calls[2].resolve({ status: 200, ok: true, __session: "rotated" }); // retry uses the freshly rotated session

  const [resA, resB] = await Promise.all([resultA, resultB]);
  assert.strictEqual(resA.status, 200);
  assert.strictEqual(resB.status, 200, "B must resolve to the retry's success, not the original 401");
  assert.strictEqual(calls.length, 3, "exactly one retry — never more");
});

// Fail-closed regression: if EVERY concurrent request genuinely fails (a
// real expired/revoked session — nobody wins), the single retry must also
// fail, and adminFetch must still surface a 401 so the caller's existing
// redirect-to-login logic fires exactly as before.
test("adminFetch: concurrent race where both sides genuinely fail -> still one retry each, still surfaces 401 (fail-closed preserved)", async () => {
  const { adminFetch, calls } = loadAdminFetch();

  const resultA = adminFetch("/api/admin/auth?action=session");
  const resultB = adminFetch("/api/admin/bookings?countsOnly=1");
  assert.strictEqual(calls.length, 2);

  calls[0].resolve({ status: 401 });
  calls[1].resolve({ status: 401 });
  await tick();

  assert.strictEqual(calls.length, 4, "both A and B should retry exactly once each");
  calls[2].resolve({ status: 401 });
  calls[3].resolve({ status: 401 });

  const [resA, resB] = await Promise.all([resultA, resultB]);
  assert.strictEqual(resA.status, 401, "a genuinely dead session must still surface 401 after the retry");
  assert.strictEqual(resB.status, 401);
  assert.strictEqual(calls.length, 4, "no second retry / no retry loop");
});

test("adminFetch: solo 401 with nothing else in flight retries immediately (no sibling to wait for)", async () => {
  const { adminFetch, calls } = loadAdminFetch();
  const result = adminFetch("/api/admin/client?id=abc");
  assert.strictEqual(calls.length, 1);
  calls[0].resolve({ status: 401 });
  await tick();
  assert.strictEqual(calls.length, 2, "with no sibling in flight, the retry should fire without waiting");
  calls[1].resolve({ status: 401 });
  const res = await result;
  assert.strictEqual(res.status, 401);
  assert.strictEqual(calls.length, 2, "still only a single retry");
});

test("adminFetch: retry resends the exact same method/headers/body (safe because requireAdmin() never mutates data before a 401)", async () => {
  const { adminFetch, calls } = loadAdminFetch();
  const options = {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "abc", tipAmount: 5 }),
  };
  const result = adminFetch("/api/admin/booking?resource=tip", options);
  calls[0].resolve({ status: 401 });
  await tick();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].url, "/api/admin/booking?resource=tip");
  assert.strictEqual(calls[1].options, options, "retry must reuse the same options object (method/headers/body intact)");
  calls[1].resolve({ status: 200, ok: true });
  const res = await result;
  assert.strictEqual(res.status, 200);
});

// ---------------------------------------------------------------------
async function main() {
  const settled = [];
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
      settled.push({ name: t.name, ok: true });
    } catch (err) {
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
      settled.push({ name: t.name, ok: false });
    }
  }
  const failed = settled.filter((r) => !r.ok);
  console.log("\n" + settled.length + " tests run, " + failed.length + " failed.");
  if (failed.length) process.exitCode = 1;
}

main();
