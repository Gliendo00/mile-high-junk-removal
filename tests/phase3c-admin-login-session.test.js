// Batch 1 (auth reliability) — local, offline test harness for
// admin/login.js's Back-button/bfcache/history fix:
//
//   - On a normal load AND every time the page is restored from the
//     browser's back/forward cache (bfcache — the `pageshow` + `persisted`
//     hook), it checks GET /api/admin/auth?action=session and, if already
//     authenticated, redirects to /admin/ via location.replace() rather
//     than showing a stale login form. This is what fixes "press Back
//     enough times and the login page is stuck showing even though I'm
//     still logged in."
//   - A completed login also redirects via location.replace(), not
//     location.href, so the login page itself doesn't become a Back
//     destination immediately after signing in.
//
// admin/login.js is plain global-scope browser JS (no bundler/module
// system), so — same technique as tests/phase3c-admin-fetch-retry.test.js —
// it's loaded fresh per test with Node's `vm` module into a small hand-built
// fake DOM/window, never `require()`.
//
// Run with:  node tests/phase3c-admin-login-session.test.js
// Exits with a non-zero code if any assertion fails.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const LOGIN_JS_SRC = fs.readFileSync(path.join(__dirname, "..", "admin", "login.js"), "utf8");

function makeFakeElement() {
  const classes = new Set();
  const listeners = {};
  return {
    textContent: "",
    value: "",
    disabled: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    dispatchEvent(evt) {
      (listeners[evt.type] || []).forEach((fn) => fn(evt));
    },
  };
}

function tick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

// Loads a fresh copy of admin/login.js into an isolated sandbox: a fake
// document/window wired exactly the way admin/login/index.html's real DOM
// is (the same element ids), plain-object window.addEventListener support
// (so the pageshow listener login.js registers is capturable), and a
// hand-controlled `fetch` so every network response in a test is explicit
// and deterministic. Returns handles to drive and inspect the page.
function loadLoginPage() {
  const els = {
    "login-form": makeFakeElement(),
    "login-error": makeFakeElement(),
    "login-submit": makeFakeElement(),
    "login-email": makeFakeElement(),
    "login-password": makeFakeElement(),
  };

  const fetchCalls = [];
  const fetchQueue = []; // { match(url) -> bool, response }
  function fetchImpl(url) {
    fetchCalls.push({ url: url });
    for (let i = 0; i < fetchQueue.length; i++) {
      if (fetchQueue[i].match(url)) {
        const resp = fetchQueue[i].response;
        fetchQueue.splice(i, 1); // one-shot, like a real request settling once
        return Promise.resolve(resp);
      }
    }
    return Promise.reject(new Error("no mock response queued for " + url));
  }

  const locationCalls = { replace: [], hrefSets: [] };
  const documentListeners = {};
  const windowListeners = {};

  const sandbox = {
    fetch: fetchImpl,
    console: console,
    document: {
      getElementById: (id) => els[id] || null,
      addEventListener(type, fn) {
        documentListeners[type] = documentListeners[type] || [];
        documentListeners[type].push(fn);
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = function (type, fn) {
    windowListeners[type] = windowListeners[type] || [];
    windowListeners[type].push(fn);
  };
  Object.defineProperty(sandbox, "location", {
    value: {
      replace: (url) => locationCalls.replace.push(url),
      set href(url) { locationCalls.hrefSets.push(url); },
      get href() { return locationCalls.hrefSets[locationCalls.hrefSets.length - 1]; },
    },
  });

  vm.createContext(sandbox);
  vm.runInContext(LOGIN_JS_SRC, sandbox, { filename: "login.js" });

  return {
    els: els,
    fetchCalls: fetchCalls,
    queueResponse: function (urlSubstring, response) {
      fetchQueue.push({ match: (url) => url.indexOf(urlSubstring) !== -1, response: response });
    },
    locationCalls: locationCalls,
    // Fires the DOMContentLoaded handler the real browser would fire on
    // page load — this is when redirectIfAlreadyAuthenticated() runs the
    // first time, and the submit/pageshow listeners are wired up. Exposed
    // as an explicit step (rather than fired automatically at load time) so
    // a test can queue its first response before this synchronously calls
    // fetch(), exactly like a real page load's fetch has nothing racing to
    // consume a not-yet-queued response.
    fireLoad: function () {
      (documentListeners["DOMContentLoaded"] || []).forEach((fn) => fn());
    },
    firePageshow: function (persisted) {
      (windowListeners["pageshow"] || []).forEach((fn) => fn({ persisted: persisted }));
    },
    submit: function () {
      els["login-form"].dispatchEvent({ type: "submit", preventDefault: () => {} });
    },
  };
}

const registered = [];
function test(name, fn) { registered.push({ name, fn }); }

test("login page: already authenticated on load -> redirects via location.replace, never location.href", async () => {
  const page = loadLoginPage();
  page.queueResponse("action=session", { status: 200 });
  page.fireLoad();
  await tick();
  assert.deepStrictEqual(page.locationCalls.replace, ["/admin/"]);
  assert.strictEqual(page.locationCalls.hrefSets.length, 0, "must never fall back to location.href for this redirect");
});

test("login page: not authenticated on load -> no redirect, form stays usable", async () => {
  const page = loadLoginPage();
  page.queueResponse("action=session", { status: 401 });
  page.fireLoad();
  await tick();
  assert.deepStrictEqual(page.locationCalls.replace, []);
});

test("login page: session-check network failure fails OPEN (shows the form, never blocks a legitimate login attempt)", async () => {
  const page = loadLoginPage(); // no response queued for action=session -> fetchImpl rejects
  page.fireLoad();
  await tick();
  // Nothing to assert beyond "did not throw" — redirectIfAlreadyAuthenticated()
  // swallows the rejection via its own .catch(function () {}); the real
  // assertion is the next test proving a login attempt still works fine
  // after this. Included as an explicit named case so this fail-open
  // contract can't silently regress into fail-closed (blocking login) or
  // an unhandled rejection.
});

// The actual bug this batch fixes: pressing Back lands on this page
// restored from bfcache while the real session is still valid. A bfcache
// restore never re-fires DOMContentLoaded — only `pageshow` with
// `event.persisted === true` — so this is the hook that must re-check and
// redirect away from the stale cached form.
test("login page: bfcache restore (pageshow, persisted=true) while still authenticated -> redirects away from the stale form", async () => {
  const page = loadLoginPage();
  page.queueResponse("action=session", { status: 401 }); // not authenticated on the original load
  page.fireLoad();
  await tick();
  assert.deepStrictEqual(page.locationCalls.replace, [], "sanity: no redirect yet");

  page.fetchCalls.length = 0;
  page.queueResponse("action=session", { status: 200 }); // now authenticated (e.g. logged in in another tab)
  page.firePageshow(true);
  await tick();

  assert.strictEqual(page.fetchCalls.length, 1, "a bfcache restore must re-check the session");
  assert.deepStrictEqual(page.locationCalls.replace, ["/admin/"]);
});

test("login page: a normal pageshow (persisted=false) does not re-check — only a real bfcache restore does", async () => {
  const page = loadLoginPage();
  page.queueResponse("action=session", { status: 401 });
  page.fireLoad();
  await tick();
  page.fetchCalls.length = 0;

  page.firePageshow(false);
  await tick();
  assert.strictEqual(page.fetchCalls.length, 0);
});

test("login page: successful login redirects via location.replace, never location.href", async () => {
  const page = loadLoginPage();
  page.queueResponse("action=session", { status: 401 });
  page.fireLoad();
  await tick();

  page.els["login-email"].value = "owner@milehighjunkremoval.net";
  page.els["login-password"].value = "correct-password";
  page.queueResponse("/api/admin/login", { status: 200, ok: true, json: () => Promise.resolve({ ok: true }) });
  page.submit();
  await tick();

  assert.deepStrictEqual(page.locationCalls.replace, ["/admin/"]);
  assert.strictEqual(page.locationCalls.hrefSets.length, 0, "must never fall back to location.href on a successful login");
});

test("login page: failed login (wrong password) shows an error and never redirects", async () => {
  const page = loadLoginPage();
  page.queueResponse("action=session", { status: 401 });
  page.fireLoad();
  await tick();

  page.els["login-email"].value = "owner@milehighjunkremoval.net";
  page.els["login-password"].value = "wrong-password";
  page.queueResponse("/api/admin/login", { status: 401, ok: false, json: () => Promise.resolve({ error: "Invalid email or password." }) });
  page.submit();
  await tick();

  assert.deepStrictEqual(page.locationCalls.replace, []);
  assert.strictEqual(page.els["login-error"].textContent, "Invalid email or password.");
  assert.strictEqual(page.els["login-error"].classList.contains("is-visible"), true);
  assert.strictEqual(page.els["login-submit"].disabled, false, "the form must be re-enabled after a failed attempt");
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
