// Local, offline test harness for the Phase 3B Step 3 read-only Clients
// section (api/admin/clients.js, api/admin/client.js), plus the small
// client-profile-navigation addition to api/admin/booking.js.
//
// Same approach as tests/phase2-admin-api.test.js: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake query
// builder that supports exactly the operations these routes actually use —
// phase2's builder plus .ilike() and .limit(), since the Clients search
// path is the first code in this repo to use either.
//
// Run with:  node tests/phase3b-clients.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase: query builder (phase2's plus .ilike() and .limit())
// ---------------------------------------------------------------------
class FakeQueryBuilder {
  constructor(rows) {
    this._rows = rows || [];
    this._filters = [];
    this._order = null;
    this._range = null;
    this._limit = null;
    this._count = null;
    this._single = null;
  }
  select(_cols, opts) {
    if (opts && opts.count) this._count = opts;
    return this;
  }
  eq(field, val) {
    this._filters.push((row) => row[field] === val);
    return this;
  }
  in(field, arr) {
    const set = new Set(arr);
    this._filters.push((row) => set.has(row[field]));
    return this;
  }
  is(field, val) {
    this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val);
    return this;
  }
  // Only the shape this codebase actually uses: .not(col, "is", null).
  not(field, op, val) {
    if (op === "is" && val === null) this._filters.push((row) => row[field] !== undefined && row[field] !== null);
    return this;
  }
  // Minimal ILIKE emulation sufficient for exercising the endpoint's own
  // logic: unescapes the "\%"/"\_"/"\\" the real sanitizer produces, then
  // does a plain case-insensitive substring test. This does not need to be
  // a byte-perfect Postgres ILIKE implementation — the escaping/wildcard
  // *safety* is api/admin/clients.js's job (sanitizeSearchTerm), not this
  // fake's; this only needs to prove the endpoint queries/merges correctly.
  ilike(field, pattern) {
    this._filters.push((row) => {
      const value = row[field];
      if (value === null || value === undefined) return false;
      const raw = String(pattern);
      const inner = raw.startsWith("%") && raw.endsWith("%") ? raw.slice(1, -1) : raw;
      const unescaped = inner.replace(/\\(.)/g, "$1");
      return String(value).toLowerCase().includes(unescaped.toLowerCase());
    });
    return this;
  }
  order(field, opts) {
    this._order = { field: field, ascending: !opts || opts.ascending !== false };
    return this;
  }
  range(from, to) {
    this._range = [from, to];
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  maybeSingle() {
    this._single = "maybeSingle";
    return this._resolve();
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));
    if (this._order) {
      const field = this._order.field;
      const asc = this._order.ascending;
      filtered = filtered.slice().sort((a, b) => {
        if (a[field] < b[field]) return asc ? -1 : 1;
        if (a[field] > b[field]) return asc ? 1 : -1;
        return 0;
      });
    }
    const countTotal = filtered.length;
    if (this._range) {
      filtered = filtered.slice(this._range[0], this._range[1] + 1);
    } else if (this._limit) {
      filtered = filtered.slice(0, this._limit);
    }
    if (this._count && this._count.head) {
      return { data: null, count: countTotal, error: null };
    }
    if (this._single === "maybeSingle") {
      if (filtered.length > 1) return { data: null, error: { message: "multiple rows returned for maybeSingle" } };
      return { data: filtered[0] || null, error: null };
    }
    return { data: filtered, error: null };
  }
}

function createFakeServiceClient(db) {
  return {
    from(table) {
      return new FakeQueryBuilder((db[table] || []).slice());
    },
    storage: {
      from() {
        return {
          async createSignedUrl(objectPath, ttl) {
            return { data: { signedUrl: "https://mock-signed.example/" + encodeURIComponent(objectPath) + "?ttl=" + ttl }, error: null };
          },
        };
      },
    },
  };
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

const clientsHandler = require("../api/admin/clients.js");
const clientHandler = require("../api/admin/client.js");
const bookingHandler = require("../api/admin/booking.js");

// ---------------------------------------------------------------------
// req/res mocks (identical shape to phase2's/phase3a's)
// ---------------------------------------------------------------------
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
    getHeaders: () => headers,
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

// ---------------------------------------------------------------------
// Fixtures — two real-shaped clients plus one client with zero bookings,
// covering: multi-field search, IDOR isolation, booking-count/last-job-date
// aggregation, newest-first ordering, and the booking-level service-address
// snapshot with its legacy-NULL fallback (same behavior as
// api/admin/booking.js, reused here — see api/admin/client.js).
// ---------------------------------------------------------------------
const JEN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ALEX_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NOJOBS_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const NONEXISTENT_ID = "99999999-9999-9999-9999-999999999999";

function freshDb() {
  return {
    customers: [
      {
        id: JEN_ID,
        first_name: "Jen",
        last_name: "Whitfield",
        phone: "303-555-0100",
        email: "jen@example.com",
        address: "123 Main St",
        city: "Denver",
        state: "CO",
        zip: "80202",
        created_at: "2026-01-01T10:00:00Z",
      },
      {
        id: ALEX_ID,
        first_name: "Alex",
        last_name: "Doe",
        phone: "303-555-0101",
        email: null,
        address: "456 Oak Ave",
        city: "Aurora",
        state: "CO",
        zip: "80010",
        created_at: "2026-01-02T10:00:00Z",
      },
      {
        id: NOJOBS_ID,
        first_name: "Riley",
        last_name: "NoJobsYet",
        phone: "303-555-0102",
        email: "riley@example.com",
        address: "789 Pine St",
        city: "Golden",
        state: "CO",
        zip: "80401",
        created_at: "2026-01-03T10:00:00Z",
      },
    ],
    bookings: [
      // Jen's older booking — has its own service_* snapshot, different
      // from her current customer address, proving the booking's own
      // snapshot (not the customer row) is what the client profile shows.
      {
        id: "11111111-1111-1111-1111-111111111111",
        customer_id: JEN_ID,
        service_type: "junk_removal",
        appointment_date: "2026-01-05",
        time_window: "w_0800_1000",
        status: "completed",
        estimated_price: 250,
        final_price: 275,
        service_address: "999 Old Job Site Rd",
        service_city: "Golden",
        service_state: "CO",
        service_zip: "80401",
        created_at: "2026-01-04T12:00:00Z",
      },
      // Jen's newer booking — no service_* snapshot (simulates a legacy
      // row), must fall back to her current customer address.
      {
        id: "22222222-2222-2222-2222-222222222222",
        customer_id: JEN_ID,
        service_type: "dumpster_rental",
        appointment_date: "2026-01-20",
        time_window: "morning",
        status: null,
        estimated_price: 450,
        final_price: null,
        created_at: "2026-01-15T09:00:00Z",
      },
      // Alex's booking — must never appear in Jen's history (IDOR check).
      {
        id: "33333333-3333-3333-3333-333333333333",
        customer_id: ALEX_ID,
        service_type: "light_demo",
        appointment_date: "2026-01-10",
        time_window: "w_1000_1200",
        status: "booked",
        estimated_price: 800,
        final_price: null,
        service_address: "456 Oak Ave",
        service_city: "Aurora",
        service_state: "CO",
        service_zip: "80010",
        created_at: "2026-01-09T12:00:00Z",
      },
    ],
  };
}

// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// 1. Authentication — requireAdmin() must gate both new routes exactly
// like every other admin route, before any query runs.
test("clients list: no cookies at all -> 401, Cache-Control no-store", async () => {
  // A valid-but-unused anon client, so this exercises admin-auth.js's
  // actual "no cookies present" branch rather than its separate
  // "SUPABASE_ANON_KEY not configured" branch (mirrors the same setup in
  // tests/phase3a-admin-status-write.test.js).
  currentFakeAnon = createFakeAnonClient();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientsHandler, makeReq({ query: {} }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
});

test("client detail: no cookies at all -> 401 (even for a real client id)", async () => {
  currentFakeAnon = createFakeAnonClient();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientHandler, makeReq({ query: { id: JEN_ID } }));
  assert.strictEqual(res.statusCode, 401);
});

test("clients list: valid token but non-allowlisted email -> 401", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: { user: { email: "someone-else@example.com" } }, error: null }) });
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientsHandler, makeReq({ cookie: "mhjr_admin_at=at-nonadmin", query: {} }));
  assert.strictEqual(res.statusCode, 401);
});

// 2. Authenticated list — default (unfiltered) shape and aggregation
test("clients list: authenticated admin sees every client with correct booking count and last job date", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: {} }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
  assert.strictEqual(res.body.clients.length, 3);

  const jen = res.body.clients.find((c) => c.id === JEN_ID);
  assert.strictEqual(jen.bookingCount, 2);
  assert.strictEqual(jen.lastJobDate, "2026-01-20", "most recent booking by created_at is the dumpster_rental (2026-01-15), whose appointment_date is 2026-01-20");
  assert.strictEqual(jen.firstName, "Jen");
  assert.strictEqual(jen.phone, "303-555-0100");

  const riley = res.body.clients.find((c) => c.id === NOJOBS_ID);
  assert.strictEqual(riley.bookingCount, 0);
  assert.strictEqual(riley.lastJobDate, null);
});

test("clients list: unfiltered order is newest-customer-first", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: {} }));
  assert.deepStrictEqual(res.body.clients.map((c) => c.id), [NOJOBS_ID, ALEX_ID, JEN_ID]);
});

test("clients list: pagination via limit/offset is honored", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const page1 = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { limit: "2", offset: "0" } }));
  assert.strictEqual(page1.body.clients.length, 2);
  assert.strictEqual(page1.body.hasMore, true);
  const page2 = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { limit: "2", offset: "2" } }));
  assert.strictEqual(page2.body.clients.length, 1);
  assert.strictEqual(page2.body.hasMore, false);
});

// 3. Search — bounded, server-side, multi-field
test("clients list: search matches by first name (case-insensitive)", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { search: "jen" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.clients.length, 1);
  assert.strictEqual(res.body.clients[0].id, JEN_ID);
});

test("clients list: search matches by last name", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { search: "Doe" } }));
  assert.strictEqual(res.body.clients.length, 1);
  assert.strictEqual(res.body.clients[0].id, ALEX_ID);
});

test("clients list: search matches by phone substring", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { search: "0101" } }));
  assert.strictEqual(res.body.clients.length, 1);
  assert.strictEqual(res.body.clients[0].id, ALEX_ID);
});

test("clients list: search matches by email", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { search: "riley@example.com" } }));
  assert.strictEqual(res.body.clients.length, 1);
  assert.strictEqual(res.body.clients[0].id, NOJOBS_ID);
});

test("clients list: search with no matches returns an empty (not error) result", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { search: "nobody-matches-this-xyz" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.clients, []);
  assert.strictEqual(res.body.hasMore, false);
});

test("clients list: empty search string behaves identically to no search param", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { search: "   " } }));
  assert.strictEqual(res.body.clients.length, 3, "whitespace-only search must fall back to the unfiltered list");
});

test("clients list: search input containing filter-syntax-shaped characters is treated as a literal, harmless substring", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const payloads = ["Jen,or,id.neq.0", "'; drop table customers; --", "%_\\", "(status.eq.new)", "a".repeat(500)];
  for (const p of payloads) {
    const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { search: p } }));
    assert.strictEqual(res.statusCode, 200, "search must never error or crash on: " + JSON.stringify(p));
    assert.ok(Array.isArray(res.body.clients), "must always return a clients array for: " + JSON.stringify(p));
  }
});

test("clients list: search result count is bounded, never the full table dumped for client-side filtering", async () => {
  adminAuthed();
  const db = freshDb();
  // Pad with many more customers than any reasonable page size to prove
  // the search path still returns a small, paginated slice, not everything.
  for (let i = 0; i < 50; i++) {
    db.customers.push({
      id: "dddddddd-dddd-dddd-dddd-" + String(100000000000 + i).padStart(12, "0"),
      first_name: "Pat",
      last_name: "Bulk" + i,
      phone: "303-555-9" + String(i).padStart(3, "0"),
      email: null,
      address: null,
      city: "Denver",
      state: "CO",
      zip: "80202",
      created_at: "2026-02-01T00:00:00Z",
    });
  }
  currentFakeService = createFakeServiceClient(db);
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { search: "Pat", limit: "10" } }));
  assert.strictEqual(res.body.clients.length, 10, "must respect the requested page size, not return all 50 matches at once");
  assert.strictEqual(res.body.hasMore, true);
});

// 3b. Batch 2D — archivedOnly=1 (default active-only vs. archived-only)
test("clients list: the default (no archivedOnly) never includes an archived client", async () => {
  adminAuthed();
  const db = freshDb();
  db.customers[0].archived_at = "2026-09-20T00:00:00Z";
  db.customers[0].archived_reason = "duplicate_client";
  currentFakeService = createFakeServiceClient(db);
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: {} }));
  assert.strictEqual(res.statusCode, 200);
  const ids = res.body.clients.map((c) => c.id);
  assert.ok(ids.indexOf(JEN_ID) === -1, "the archived client must not appear in the default list");
  assert.strictEqual(res.body.clients.length, 2);
});

test("clients list: archivedOnly=1 returns ONLY archived clients, with their reason", async () => {
  adminAuthed();
  const db = freshDb();
  db.customers[0].archived_at = "2026-09-20T00:00:00Z";
  db.customers[0].archived_reason = "duplicate_client";
  currentFakeService = createFakeServiceClient(db);
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { archivedOnly: "1" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.clients.length, 1);
  assert.strictEqual(res.body.clients[0].id, JEN_ID);
  assert.strictEqual(res.body.clients[0].archivedReason, "duplicate_client");
});

test("clients list: search also respects archivedOnly — an archived client never surfaces in a normal search", async () => {
  adminAuthed();
  const db = freshDb();
  db.customers[0].archived_at = "2026-09-20T00:00:00Z";
  currentFakeService = createFakeServiceClient(db);
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { search: "Jen" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.clients.length, 0);
});

// This is also exactly what keeps an archived client out of the New/Past
// Job picker (admin/client-picker.js calls this same endpoint's default,
// active-only mode) — no separate change needed there.
test("clients list: an archived client is excluded from the client-picker's own default (active-only) search", async () => {
  adminAuthed();
  const db = freshDb();
  db.customers[1].archived_at = "2026-09-20T00:00:00Z"; // Alex
  currentFakeService = createFakeServiceClient(db);
  const res = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: { search: "Alex", limit: "8" } }));
  assert.strictEqual(res.body.clients.length, 0);
});

// 4. Client detail — happy path, history ordering, service-address source
test("client detail: authenticated admin sees contact info and job history newest first", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientHandler, makeReq({ cookie: AUTH_COOKIE, query: { id: JEN_ID } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
  assert.strictEqual(res.body.client.firstName, "Jen");
  assert.strictEqual(res.body.client.phone, "303-555-0100");
  assert.strictEqual(res.body.client.address, "123 Main St");

  assert.strictEqual(res.body.bookings.length, 2);
  assert.deepStrictEqual(
    res.body.bookings.map((b) => b.id),
    ["22222222-2222-2222-2222-222222222222", "11111111-1111-1111-1111-111111111111"],
    "newest booking (by created_at) must come first"
  );
});

test("client detail: a booking with its own service_* snapshot reports that, not the client's current address", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientHandler, makeReq({ cookie: AUTH_COOKIE, query: { id: JEN_ID } }));
  const oldJob = res.body.bookings.find((b) => b.id === "11111111-1111-1111-1111-111111111111");
  assert.deepStrictEqual(oldJob.serviceAddress, { address: "999 Old Job Site Rd", city: "Golden", state: "CO", zip: "80401" });
  assert.notStrictEqual(oldJob.serviceAddress.city, "Denver", "must not use the client's current city for a job with its own snapshot");
});

test("client detail: a legacy booking with no service_* snapshot falls back to the client's current address", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientHandler, makeReq({ cookie: AUTH_COOKIE, query: { id: JEN_ID } }));
  const newJob = res.body.bookings.find((b) => b.id === "22222222-2222-2222-2222-222222222222");
  assert.deepStrictEqual(newJob.serviceAddress, { address: "123 Main St", city: "Denver", state: "CO", zip: "80202" });
});

test("client detail: a client with zero bookings returns an empty history array, not an error", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientHandler, makeReq({ cookie: AUTH_COOKIE, query: { id: NOJOBS_ID } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.bookings, []);
});

// 5. IDOR — job history strictly scoped to the requested client
test("client detail: IDOR — one client's job history never includes another client's bookings", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const jenRes = await run(clientHandler, makeReq({ cookie: AUTH_COOKIE, query: { id: JEN_ID } }));
  const alexRes = await run(clientHandler, makeReq({ cookie: AUTH_COOKIE, query: { id: ALEX_ID } }));
  assert.ok(!jenRes.body.bookings.some((b) => b.id === "33333333-3333-3333-3333-333333333333"), "Jen's history must not include Alex's booking");
  assert.strictEqual(alexRes.body.bookings.length, 1);
  assert.strictEqual(alexRes.body.bookings[0].id, "33333333-3333-3333-3333-333333333333");
});

// 6. Missing / malformed / nonexistent client id
test("client detail: missing id -> safe 400, no query issued", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientHandler, makeReq({ cookie: AUTH_COOKIE, query: {} }));
  assert.strictEqual(res.statusCode, 400);
});

test("client detail: malformed id -> safe 404 (never reaches the database)", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientHandler, makeReq({ cookie: AUTH_COOKIE, query: { id: "'; drop table customers; --" } }));
  assert.strictEqual(res.statusCode, 404);
});

test("client detail: well-formed but nonexistent id -> safe 404", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientHandler, makeReq({ cookie: AUTH_COOKIE, query: { id: NONEXISTENT_ID } }));
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.error, "Client not found.");
});

// 7. No PII/secret leakage without auth; no secret leakage even with auth
test("clients APIs: unauthenticated responses never carry client data", async () => {
  currentFakeService = createFakeServiceClient(freshDb());
  const listRes = await run(clientsHandler, makeReq({ query: {} }));
  const detailRes = await run(clientHandler, makeReq({ query: { id: JEN_ID } }));
  assert.strictEqual(JSON.stringify(listRes.body).includes("Jen"), false);
  assert.strictEqual(JSON.stringify(detailRes.body).includes("Jen"), false);
});

test("clients APIs: no response ever contains the service-role key or anon key values", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const listRes = await run(clientsHandler, makeReq({ cookie: AUTH_COOKIE, query: {} }));
  const detailRes = await run(clientHandler, makeReq({ cookie: AUTH_COOKIE, query: { id: JEN_ID } }));
  [listRes, detailRes].forEach((r) => {
    const asText = JSON.stringify(r.body);
    assert.ok(!asText.includes(process.env.SUPABASE_SECRET_KEY));
    assert.ok(!asText.includes(process.env.SUPABASE_ANON_KEY));
  });
});

// 8. Booking detail -> client profile navigation (small addition to
// api/admin/booking.js made in this phase)
test("booking detail: response now includes customerId for client-profile navigation", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(bookingHandler, makeReq({ cookie: AUTH_COOKIE, query: { id: "11111111-1111-1111-1111-111111111111" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.customerId, JEN_ID);
});

// 9. No new write capability: neither new route accepts a non-GET method,
// and (see the dynamic write-audit test in tests/phase3a-admin-status-write
// .test.js, which globs every file in api/admin/* at run time) these two
// new files are automatically included in that "exactly one .update(...)
// in the whole admin API" assertion without needing any change there.
test("clients list: non-GET method is rejected with 405", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientsHandler, makeReq({ method: "POST", cookie: AUTH_COOKIE, query: {} }));
  assert.strictEqual(res.statusCode, 405);
});

// PATCH is now a legitimate method here (Batch 2D — edit/archive/restore,
// see tests/phase3c-client-edit-archive.test.js for its full coverage) —
// this guard now checks a genuinely unsupported method instead.
test("client detail: an unsupported method (DELETE) is rejected with 405", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(clientHandler, makeReq({ method: "DELETE", cookie: AUTH_COOKIE, query: { id: JEN_ID } }));
  assert.strictEqual(res.statusCode, 405);
});

// 10. Static-analysis guard: the new client-side files never build HTML
// from strings — same property already checked for dashboard.js/
// booking-detail.js/login.js/status-ui.js in phase2/phase3a.
test("admin client JS (Clients section) never uses innerHTML/insertAdjacentHTML/document.write", async () => {
  const files = ["admin/clients-list.js", "admin/client-detail.js"];
  files.forEach((rel) => {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
});

// Phase 3C Stage 4 follow-up: renderJobCard()'s STATUS_CLASSES fallback
// list must include 'rental_out', or a rental job in that status gets the
// wrong accent color/badge class (silently coerced to 'new') on a client's
// job history list here — the label itself (b.statusLabel, server-supplied)
// was already correct; only the class lookup was missing this value.
test("admin/client-detail.js: STATUS_CLASSES includes 'rental_out' (job history accent color isn't coerced to 'new')", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "admin/client-detail.js"), "utf8");
  const match = src.match(/var STATUS_CLASSES = \[[^\]]*\]/);
  assert.ok(match, "STATUS_CLASSES must be defined");
  assert.ok(/'rental_out'/.test(match[0]), "STATUS_CLASSES must include 'rental_out'");
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
