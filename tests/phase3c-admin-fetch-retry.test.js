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
// { adminFetch, calls, fireTimers } where `calls` is a log of every
// fetch(url, options) invocation, each with a `.resolve(responseLike)` to
// settle it on demand.
//
// A `vm` context is a fresh JS realm with no host globals of its own —
// unlike `fetch`, `setTimeout`/`clearTimeout` are never called by anything
// in the small, well-defined scenarios the other tests below already
// drive, so a fake that just records scheduled/cleared callbacks (never
// auto-firing on a real clock) is enough to satisfy admin-fetch.js's
// `waitForSiblings()` circuit breaker without this suite ever waiting on a
// real 5-second timer. `fireTimers()` lets a test simulate "the deadline
// elapsed" on demand, deterministically, in the one test that needs to; a
// cleared timer is marked as such and `fireTimers()` skips it, mirroring
// real clearTimeout() semantics — this is what lets a test assert
// admin-fetch.js actually cleans up the timer it no longer needs once the
// real settlement wins the race.
function loadAdminFetch() {
  const calls = [];
  const timers = [];
  const sandbox = {
    fetch: function (url, options) {
      const d = deferred();
      calls.push({ url: url, options: options, resolve: d.resolve });
      return d.promise;
    },
    setTimeout: function (fn, delay) {
      const id = timers.length + 1;
      timers.push({ id: id, fn: fn, delay: delay, cleared: false, fired: false });
      return id;
    },
    clearTimeout: function (id) {
      const t = timers.find(function (t) { return t.id === id; });
      if (t) t.cleared = true;
    },
    window: {},
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(ADMIN_FETCH_SRC, sandbox, { filename: "admin-fetch.js" });
  return {
    adminFetch: sandbox.window.adminFetch,
    calls: calls,
    timers: timers,
    // Fires every not-yet-cleared timer callback (in scheduling order),
    // simulating every still-pending deadline having elapsed.
    fireTimers: function () {
      timers.filter(function (t) { return !t.cleared && !t.fired; }).forEach(function (t) {
        t.fired = true;
        t.fn();
      });
    },
  };
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
  const { adminFetch, calls, timers } = loadAdminFetch();

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

  await tick();
  assert.strictEqual(timers.length, 1, "the circuit-breaker deadline scheduled while waiting on A");
  assert.strictEqual(timers[0].cleared, true, "the deadline timer must be cleaned up once A's real settlement wins the race, not left dangling for 5s");
  assert.strictEqual(timers[0].fired, false, "the deadline itself must never have fired in the normal (non-hung) case");
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

// Regression: a sibling that never settles at all (a genuinely stalled
// connection — dead wifi, a black-holed request — fetch() has no built-in
// timeout of its own) must not block a 401's retry forever. waitForSiblings()
// races the real settlement against a bounded deadline (see
// SIBLING_WAIT_TIMEOUT_MS in admin-fetch.js) purely as a circuit breaker:
// this proves the deadline is what eventually lets the retry through when a
// sibling hangs, while the earlier race test above already proves that
// same deadline is never what determines retry timing in the normal case
// (there, the retry fires the instant the winning sibling settles, well
// before any timer could).
test("adminFetch: a sibling that never settles cannot block a 401's retry indefinitely (bounded circuit breaker, not a hang)", async () => {
  const { adminFetch, calls, timers, fireTimers } = loadAdminFetch();

  const resultA = adminFetch("/api/admin/bookings?countsOnly=1"); // hangs forever — never resolved in this test
  const resultB = adminFetch("/api/admin/auth?action=session"); // loses the race
  assert.strictEqual(calls.length, 2);

  calls[1].resolve({ status: 401 });
  await tick();
  assert.strictEqual(calls.length, 2, "B must wait for A rather than retrying immediately");
  assert.strictEqual(timers.length, 1, "a single bounded deadline must be scheduled while waiting on A");
  assert.strictEqual(timers[0].delay, 5000, "the circuit breaker must be a fixed, documented bound, not an ad-hoc value");

  // Simulate the deadline elapsing — A is still hung and never resolves.
  fireTimers();
  await tick();

  assert.strictEqual(calls.length, 3, "the deadline must let B's retry through even though A never settled");
  calls[2].resolve({ status: 200, ok: true });

  const resB = await resultB;
  assert.strictEqual(resB.status, 200, "B must still recover, not hang forever, when a sibling is stuck");

  // A is still pending and untouched by any of this — the fix only bounds
  // how long B *waits on* A, it never cancels or otherwise affects A itself.
  let aSettled = false;
  resultA.then(function () { aSettled = true; }, function () { aSettled = true; });
  await tick();
  assert.strictEqual(aSettled, false, "the hung sibling itself must be left alone, not force-settled");
  assert.strictEqual(timers[0].cleared, true, "the deadline must still be cleaned up after it fires, same as the normal-settlement path");
});

// Same setup as above, but the single retry ALSO comes back 401 — proving
// the circuit breaker doesn't turn into a second retry attempt, and the
// existing fail-closed contract (surface 401, let the caller's own
// redirect-to-login fire) is unchanged by a hung sibling being involved.
test("adminFetch: hung sibling + retry also 401 -> surfaces 401 normally, no third attempt", async () => {
  const { adminFetch, calls, fireTimers } = loadAdminFetch();

  const resultA = adminFetch("/api/admin/bookings?countsOnly=1"); // hangs forever
  const resultB = adminFetch("/api/admin/auth?action=session");
  calls[1].resolve({ status: 401 });
  await tick();

  fireTimers();
  await tick();
  assert.strictEqual(calls.length, 3, "exactly one retry, even with a hung sibling in play");
  calls[2].resolve({ status: 401 }); // the session really is dead — retry fails too

  const resB = await resultB;
  assert.strictEqual(resB.status, 401, "a genuinely-401 retry must still surface 401 (fail-closed preserved)");
  assert.strictEqual(calls.length, 3, "no third attempt");

  resultA.catch(function () {}); // avoid an unhandled-rejection warning for the still-pending hung promise
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
