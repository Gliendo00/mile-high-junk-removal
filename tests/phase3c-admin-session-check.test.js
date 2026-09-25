// Batch 1 (auth reliability) — local, offline test harness for GET
// /api/admin/auth?action=session (api/admin/auth.js's handleSession()).
//
// This is the "am I already logged in?" check admin/login.js uses so it
// never shows a stale login form to someone who's still authenticated (see
// docs/phase-2/auth-architecture.md and this file's sibling,
// tests/phase2-admin-api.test.js, for the underlying requireAdmin()
// contract this is a thin wrapper around — same fake-Supabase harness
// approach as that file, kept self-contained here per this repo's test
// file convention).
//
// Run with:  node tests/phase3c-admin-session-check.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

function createFakeAnonClient(overrides) {
  overrides = overrides || {};
  return {
    auth: {
      signInWithPassword: overrides.signInWithPassword || (async () => ({ data: null, error: { message: "not configured in this test" } })),
      getUser: overrides.getUser || (async () => ({ data: null, error: { message: "not configured in this test" } })),
      refreshSession: overrides.refreshSession || (async () => ({ data: null, error: { message: "not configured in this test" } })),
      setSession: overrides.setSession || (async () => ({ data: {}, error: null })),
      signOut: overrides.signOut || (async () => ({ error: null })),
    },
  };
}

let currentFakeAnon = null;

function interceptSupabaseModule() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return {
        createClient: function (_url, key) {
          if (key === process.env.SUPABASE_ANON_KEY) return currentFakeAnon;
          throw new Error("Unexpected Supabase key passed to createClient() in test: " + key);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
interceptSupabaseModule();

process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";

const authHandler = require("../api/admin/auth.js");

function makeReq(opts) {
  opts = opts || {};
  const json = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  return {
    method: opts.method || "GET",
    headers: Object.assign(
      {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(json)),
        cookie: opts.cookie || "",
        "x-forwarded-proto": "https",
      },
      opts.headers || {}
    ),
    body: opts.body,
    query: opts.query || {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function makeRes() {
  const headers = {};
  const res = {
    statusCode: null,
    body: null,
    getHeader: function (name) { return headers[name.toLowerCase()]; },
    setHeader: function (name, value) { headers[name.toLowerCase()] = value; },
    getHeaders: function () { return headers; },
    status: function (code) { res.statusCode = code; return res; },
    json: function (obj) { res.body = obj; return res; },
  };
  return res;
}

function run(handler, req) {
  const res = makeRes();
  return Promise.resolve(handler(req, res)).then(function () { return res; });
}

const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
const NON_ADMIN_EMAIL = "someone-else@example.com";

const registered = [];
function test(name, fn) { registered.push({ name, fn }); }

test("session check: no cookies at all -> 401", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await run(authHandler, makeReq({ method: "GET", query: { action: "session" } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
});

test("session check: valid access token -> 200 { authenticated: true }, no cookie rotation", async () => {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
  const res = await run(authHandler, makeReq({ method: "GET", query: { action: "session" }, cookie: "mhjr_admin_at=at-good" }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { authenticated: true });
  assert.strictEqual(res.getHeader("Set-Cookie"), undefined);
});

test("session check: expired access token + valid refresh token -> 200, cookies rotated", async () => {
  let refreshCalls = 0;
  currentFakeAnon = createFakeAnonClient({
    getUser: async () => ({ data: null, error: { message: "token expired" } }),
    refreshSession: async ({ refresh_token }) => {
      refreshCalls++;
      if (refresh_token !== "rt-valid") return { data: null, error: { message: "invalid refresh token" } };
      return { data: { session: { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }, user: { email: ADMIN_EMAIL } }, error: null };
    },
  });
  const res = await run(authHandler, makeReq({ method: "GET", query: { action: "session" }, cookie: "mhjr_admin_at=at-expired; mhjr_admin_rt=rt-valid" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(refreshCalls, 1);
  const setCookie = res.getHeader("Set-Cookie");
  const joined = (Array.isArray(setCookie) ? setCookie : [setCookie]).join(" | ");
  assert.ok(joined.includes("mhjr_admin_at=at-new"));
  assert.ok(joined.includes("mhjr_admin_rt=rt-new"));
});

test("session check: expired access token + invalid refresh token -> fails closed (401)", async () => {
  currentFakeAnon = createFakeAnonClient({
    getUser: async () => ({ data: null, error: { message: "token expired" } }),
    refreshSession: async () => ({ data: null, error: { message: "refresh token expired or revoked" } }),
  });
  const res = await run(authHandler, makeReq({ method: "GET", query: { action: "session" }, cookie: "mhjr_admin_at=at-expired; mhjr_admin_rt=rt-expired" }));
  assert.strictEqual(res.statusCode, 401);
});

test("session check: valid token but non-allowlisted email -> 401", async () => {
  currentFakeAnon = createFakeAnonClient({
    getUser: async () => ({ data: { user: { email: NON_ADMIN_EMAIL } }, error: null }),
  });
  const res = await run(authHandler, makeReq({ method: "GET", query: { action: "session" }, cookie: "mhjr_admin_at=at-nonadmin" }));
  assert.strictEqual(res.statusCode, 401);
});

test("session check: POST is rejected (GET-only action) -> 405", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await run(authHandler, makeReq({ method: "POST", query: { action: "session" } }));
  assert.strictEqual(res.statusCode, 405);
});

test("login/logout actions are still POST-only -> GET is 405 (unchanged by adding ?action=session)", async () => {
  currentFakeAnon = createFakeAnonClient();
  const loginRes = await run(authHandler, makeReq({ method: "GET", query: { action: "login" } }));
  assert.strictEqual(loginRes.statusCode, 405);
  const logoutRes = await run(authHandler, makeReq({ method: "GET", query: { action: "logout" } }));
  assert.strictEqual(logoutRes.statusCode, 405);
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
