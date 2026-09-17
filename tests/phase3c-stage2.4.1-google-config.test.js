// Local, offline test harness for Phase 3C Stage 2.4.1's Google Maps
// browser-key config endpoint — GET /api/admin/bookings?view=google-config.
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project. This
// mode never touches Supabase at all, but bookings.js still requires the
// module at load time, so the interception is still needed to import it.
//
// SECURITY NOTE FOR ANYONE EDITING THIS FILE: never hardcode a real-shaped
// Google API key anywhere in this suite. Every test below uses a plainly
// fake placeholder value (e.g. "fake-test-key-not-real") specifically so
// nothing resembling a real credential could ever end up in test output,
// CI logs, or a diff — matching the stage's explicit "never in test
// snapshots/output" requirement.
//
// Run with:  node tests/phase3c-stage2.4.1-google-config.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const FAKE_TEST_KEY = "fake-test-key-not-real";

function createFakeServiceClient() {
  // Never actually called by this endpoint, but bookings.js's module-level
  // requires still need a working factory shape for other code paths.
  return { from() { throw new Error("google-config must never touch Supabase"); } };
}
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
let currentFakeService = null;

function interceptSupabaseModule() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return {
        createClient: function (_url, key) {
          if (key === process.env.SUPABASE_ANON_KEY) return currentFakeAnon;
          if (key === process.env.SUPABASE_SECRET_KEY) return currentFakeService;
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
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";

const bookingsHandler = require("../api/admin/bookings.js");

function makeReq(opts) {
  opts = opts || {};
  return {
    method: opts.method || "GET",
    headers: Object.assign({ cookie: opts.cookie || "" }, opts.headers || {}),
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
function run(handler, req) {
  const res = makeRes();
  return Promise.resolve(handler(req, res)).then(() => res);
}

const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

function getGoogleConfig(cookie) {
  currentFakeService = createFakeServiceClient();
  return run(bookingsHandler, makeReq({ cookie: cookie || "", query: { view: "google-config" } }));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}
// fn() is always async (returns a Promise) — the cleanup must happen AFTER
// that promise settles, not synchronously right after fn() is invoked, or
// the env var gets restored before the handler ever reads it.
async function withEnvKey(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "ADMIN_GOOGLE_MAPS_API_KEY");
  const prev = process.env.ADMIN_GOOGLE_MAPS_API_KEY;
  if (value === undefined) delete process.env.ADMIN_GOOGLE_MAPS_API_KEY;
  else process.env.ADMIN_GOOGLE_MAPS_API_KEY = value;
  try {
    return await fn();
  } finally {
    if (had) process.env.ADMIN_GOOGLE_MAPS_API_KEY = prev;
    else delete process.env.ADMIN_GOOGLE_MAPS_API_KEY;
  }
}

// =======================================================================
// Auth
// =======================================================================
test("GET ?view=google-config: no cookie at all -> 401, response body identical in shape to every other unauthenticated admin request (never reveals whether a key exists)", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await withEnvKey(FAKE_TEST_KEY, () => getGoogleConfig(""));
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(res.body, { error: "Not authenticated." });
  assert.ok(!("googleMapsApiKey" in res.body), "an unauthenticated response must never carry this field, present or absent-but-named");
});

test("GET ?view=google-config: a forged/garbage access token -> 401, key configured or not makes no difference", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: null, error: { message: "invalid JWT" } }) });
  const resWithKey = await withEnvKey(FAKE_TEST_KEY, () => getGoogleConfig("mhjr_admin_at=not-a-real-token"));
  assert.strictEqual(resWithKey.statusCode, 401);
  const resNoKey = await withEnvKey(undefined, () => getGoogleConfig("mhjr_admin_at=not-a-real-token"));
  assert.strictEqual(resNoKey.statusCode, 401);
  assert.deepStrictEqual(resWithKey.body, resNoKey.body, "the 401 response must be byte-identical whether or not a key is configured — no side channel");
});

test("GET ?view=google-config: a real session but a non-allowlisted email -> 401", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: { user: { email: "someone-else@example.com" } }, error: null }) });
  const res = await withEnvKey(FAKE_TEST_KEY, () => getGoogleConfig("mhjr_admin_at=at-nonadmin"));
  assert.strictEqual(res.statusCode, 401);
});

test("GET ?view=google-config: response always carries Cache-Control: no-store, authenticated or not", async () => {
  adminAuthed();
  const authedRes = await withEnvKey(FAKE_TEST_KEY, async () => {
    currentFakeService = createFakeServiceClient();
    return run(bookingsHandler, makeReq({ cookie: AUTH_COOKIE, query: { view: "google-config" } }));
  });
  assert.strictEqual(authedRes.getHeader("Cache-Control"), "no-store");

  currentFakeAnon = createFakeAnonClient();
  const unauthedRes = await getGoogleConfig("");
  assert.strictEqual(unauthedRes.getHeader("Cache-Control"), "no-store");
});

// =======================================================================
// Authenticated behavior
// =======================================================================
test("GET ?view=google-config: authenticated + configured env var -> 200 with the key returned", async () => {
  adminAuthed();
  const res = await withEnvKey(FAKE_TEST_KEY, () => getGoogleConfig(AUTH_COOKIE));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.googleMapsApiKey, FAKE_TEST_KEY);
});

test("GET ?view=google-config: authenticated + UNSET env var -> 200 with an empty string, never an error/crash (missing-env fallback)", async () => {
  adminAuthed();
  const res = await withEnvKey(undefined, () => getGoogleConfig(AUTH_COOKIE));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.googleMapsApiKey, "");
});

test("GET ?view=google-config: authenticated + whitespace-only env var -> 200 with an empty string (trimmed, treated as unconfigured)", async () => {
  adminAuthed();
  const res = await withEnvKey("   ", () => getGoogleConfig(AUTH_COOKIE));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.googleMapsApiKey, "");
});

test("GET ?view=google-config: never touches Supabase — the fake service client throws if .from() is ever called, and this endpoint must never trigger that", async () => {
  adminAuthed();
  // createFakeServiceClient()'s .from() throws by design (see its
  // definition above) — reaching 200 at all here proves handleGoogleConfig
  // never called supabase.from(...).
  const res = await withEnvKey(FAKE_TEST_KEY, () => getGoogleConfig(AUTH_COOKIE));
  assert.strictEqual(res.statusCode, 200);
});

test("POST/DELETE to ?view=google-config are still rejected — this mode is GET-only, dispatched after the method check", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient();
  const postRes = await run(bookingsHandler, makeReq({ method: "POST", cookie: AUTH_COOKIE, query: { view: "google-config" } }));
  // POST is dispatched to handleCreateExpense() before the view is ever
  // read (see bookings.js) — an empty body there is a 400, never a leak of
  // Google config through the wrong verb.
  assert.notStrictEqual(postRes.statusCode, 200);
  const deleteRes = await run(bookingsHandler, makeReq({ method: "DELETE", cookie: AUTH_COOKIE, query: { view: "google-config" } }));
  assert.strictEqual(deleteRes.statusCode, 405);
});

// =======================================================================
// Regression: no new function, no logging, no hardcoded key anywhere.
// =======================================================================
test("deployment: adding ?view=google-config added zero new function-producing files under api/ (still <=12)", () => {
  function countApiFunctionFiles(dir) {
    let count = 0;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(path.join(__dirname, "..", "api"), full) === "_lib") return;
        count += countApiFunctionFiles(full);
      } else if (entry.name.endsWith(".js")) {
        count += 1;
      }
    });
    return count;
  }
  const total = countApiFunctionFiles(path.join(__dirname, "..", "api"));
  assert.ok(total <= 12, "api/ has " + total + " function-producing .js files, exceeding the Vercel Hobby plan's 12-function limit");
});

test("api/admin/bookings.js: handleGoogleConfig() never calls console.log/console.error/console.warn with the key — the only failure mode here is 'unset', which is not an error", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "bookings.js"), "utf8");
  const start = src.indexOf("function handleGoogleConfig(req, res) {");
  assert.ok(start !== -1, "handleGoogleConfig must exist");
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);
  assert.ok(!/console\.(log|error|warn|info|debug)/.test(body), "must never log anything in this handler — there is nothing here worth logging and the key must never reach a log line");
});

test("api/admin/bookings.js: reads ADMIN_GOOGLE_MAPS_API_KEY, never the unrelated GOOGLE_PLACES_API_KEY api/reviews.js already uses for a different purpose", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "bookings.js"), "utf8");
  assert.ok(/process\.env\.ADMIN_GOOGLE_MAPS_API_KEY/.test(src));
  assert.ok(!/process\.env\.GOOGLE_PLACES_API_KEY/.test(src), "must never read or reuse the server-side Places Details key — a different credential with a different restriction model");
});

// ---------------------------------------------------------------------
async function main() {
  let failed = 0;
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
    } catch (err) {
      failed++;
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
    }
  }
  console.log("\n" + registered.length + " tests run, " + failed + " failed.");
  process.exit(failed ? 1 : 0);
}
main();
