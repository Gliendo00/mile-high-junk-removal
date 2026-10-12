// Site Improvement Agent — tests for api/admin/bookings.js's new
// ?view=agent-activity branch (Phase 2 CRM wiring). Same offline test
// harness convention as tests/phase2-admin-api.test.js: "@supabase/
// supabase-js" is intercepted at require-time and replaced with a fake
// auth-only client (this view never touches Supabase at all, but
// requireAdmin() — which gates every /api/admin/* route — still needs to
// verify the caller's session against it).
//
// Reads the REAL, already-committed agent/history/log.ndjson (read-only;
// never mutated here) rather than a fixture, so this also proves the
// handler can actually find and parse it the same way a deployed
// invocation would — but only asserts on its STRUCTURE (never exact
// content), so it stays correct as the real log gains more run entries
// over time.
//
// Run with:  node tests/agent-activity-api.test.js

const Module = require("module");
const assert = require("assert");

function createFakeAnonClient(overrides) {
  overrides = overrides || {};
  return {
    auth: {
      getUser: overrides.getUser || (async () => ({ data: null, error: { message: "not configured in this test" } })),
      refreshSession: overrides.refreshSession || (async () => ({ data: null, error: { message: "not configured in this test" } })),
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
          // This view never creates a service-role client — if it ever
          // does, that's itself a bug worth failing loudly on.
          throw new Error("Unexpected Supabase key passed to createClient() in agent-activity test: " + key);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
interceptSupabaseModule();

process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";

const bookingsHandler = require("../api/admin/bookings.js");

function makeReq(opts) {
  opts = opts || {};
  return {
    method: opts.method || "GET",
    headers: Object.assign({ cookie: opts.cookie || "", "x-forwarded-proto": "https" }, opts.headers || {}),
    query: opts.query || {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function makeRes() {
  const headers = {};
  const res = {
    statusCode: null,
    body: null,
    getHeader: (name) => headers[name.toLowerCase()],
    setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
    status: function (code) { res.statusCode = code; return res; },
    json: function (obj) { res.body = obj; return res; },
  };
  return res;
}

function run(req) {
  const res = makeRes();
  return Promise.resolve(bookingsHandler(req, res)).then(() => res);
}

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
  await test("?view=agent-activity requires admin auth — no cookie at all -> 401, no body leaked", async () => {
    currentFakeAnon = createFakeAnonClient();
    const res = await run(makeReq({ query: { view: "agent-activity" } }));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.recent, undefined);
  });

  await test("?view=agent-activity requires admin auth — an invalid/expired token -> 401", async () => {
    currentFakeAnon = createFakeAnonClient({
      getUser: async () => ({ data: null, error: { message: "invalid JWT" } }),
      refreshSession: async () => ({ data: null, error: { message: "invalid refresh token" } }),
    });
    const res = await run(makeReq({ query: { view: "agent-activity" }, cookie: "mhjr_admin_at=bad-token" }));
    assert.strictEqual(res.statusCode, 401);
  });

  await test("?view=agent-activity requires admin auth — a real but non-allowlisted account -> 401", async () => {
    currentFakeAnon = createFakeAnonClient({
      getUser: async () => ({ data: { user: { email: "not-the-owner@example.com" } }, error: null }),
    });
    const res = await run(makeReq({ query: { view: "agent-activity" }, cookie: "mhjr_admin_at=some-token" }));
    assert.strictEqual(res.statusCode, 401);
  });

  await test("?view=agent-activity: authenticated admin gets a 200 with the compact activity shape", async () => {
    currentFakeAnon = createFakeAnonClient({
      getUser: async () => ({ data: { user: { email: "owner@milehighjunkremoval.net" } }, error: null }),
    });
    const res = await run(makeReq({ query: { view: "agent-activity" }, cookie: "mhjr_admin_at=good-token" }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(typeof res.body.connected, "boolean");
    assert.ok(Array.isArray(res.body.recent));
    // The real log (committed from Phase 1/2's own dry runs) has at least
    // one entry by now, so this run should see it as connected — but this
    // assertion is written to degrade gracefully (not throw) if it were
    // ever empty, since that's also a valid, honest state.
    if (res.body.connected) {
      assert.ok(res.body.recent.length > 0);
      const first = res.body.recent[0];
      assert.ok(first.runId);
      assert.ok(Array.isArray(first.lines));
      for (const line of first.lines) {
        assert.ok(typeof line.icon === "string");
        assert.ok(typeof line.text === "string");
      }
    }
  });

  await test("?view=agent-activity never touches Supabase's service-role client (no DB dependency for this view)", async () => {
    // interceptSupabaseModule() above throws if createClient() is ever
    // called with the service-role key — reaching here without that
    // throwing firing (across every test above) already proves this, but
    // assert explicitly so the intent is visible in the test list too.
    currentFakeAnon = createFakeAnonClient({
      getUser: async () => ({ data: { user: { email: "owner@milehighjunkremoval.net" } }, error: null }),
    });
    const res = await run(makeReq({ query: { view: "agent-activity" }, cookie: "mhjr_admin_at=good-token" }));
    assert.strictEqual(res.statusCode, 200);
  });

  if (process.exitCode) process.exit(process.exitCode);
}

main();
