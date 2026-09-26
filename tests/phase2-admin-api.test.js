// Local, offline test harness for the Phase 2 admin auth + read-only
// dashboard API (api/admin/auth.js — login+logout, consolidated in Phase
// 3C Stage 2.5-v2, see that file's header — bookings.js, booking.js, and
// the shared helpers in api/_lib/admin-auth.js, supabase-admin.js,
// booking-format.js).
//
// Like tests/phase1-api.test.js, this never touches the real network or the
// production Supabase project: "@supabase/supabase-js" is intercepted at
// require-time and replaced with an in-memory fake — a small hand-built
// query-builder that supports exactly the operations this codebase's admin
// routes actually use (.select/.eq/.in/.order/.range/.maybeSingle, plus
// count-only head queries and storage.createSignedUrl), and a mockable
// `auth` namespace for signInWithPassword/getUser/refreshSession/
// setSession/signOut.
//
// Run with:  node tests/phase2-admin-api.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase: query builder
// ---------------------------------------------------------------------
class FakeQueryBuilder {
  constructor(rows) {
    this._rows = rows || [];
    this._filters = [];
    this._order = null;
    this._range = null;
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
  is(field, val) {
    this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val);
    return this;
  }
  in(field, arr) {
    const set = new Set(arr);
    this._filters.push((row) => set.has(row[field]));
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
      signCalls: [],
      from(bucket) {
        const self = this;
        return {
          async createSignedUrl(objectPath, ttl) {
            self.signCalls = self.signCalls || [];
            self.signCalls.push({ bucket: bucket, path: objectPath, ttl: ttl });
            if (db.__signError) return { data: null, error: db.__signError };
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
      signInWithPassword: overrides.signInWithPassword || (async () => ({ data: null, error: { message: "not configured in this test" } })),
      getUser: overrides.getUser || (async () => ({ data: null, error: { message: "not configured in this test" } })),
      refreshSession: overrides.refreshSession || (async () => ({ data: null, error: { message: "not configured in this test" } })),
      setSession: overrides.setSession || (async () => ({ data: {}, error: null })),
      signOut: overrides.signOut || (async () => ({ error: null })),
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
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net, Second.Admin@Example.com";

// login and logout are now one consolidated handler (api/admin/auth.js),
// dispatched on ?action=login|logout — see that file's header for why.
// Kept as two names here so every existing call site below (which already
// reads clearly as "the login handler" / "the logout handler") needs no
// further change beyond adding the query param each now requires.
const authHandler = require("../api/admin/auth.js");
const loginHandler = authHandler;
const logoutHandler = authHandler;
const bookingsHandler = require("../api/admin/bookings.js");
const bookingHandler = require("../api/admin/booking.js");
const { normalizedStatus, statusLabel, timeWindowLabel } = require("../api/_lib/booking-format");

// ---------------------------------------------------------------------
// req/res mocks
// ---------------------------------------------------------------------
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
    getHeader: function (name) {
      return headers[name.toLowerCase()];
    },
    setHeader: function (name, value) {
      headers[name.toLowerCase()] = value;
    },
    getHeaders: function () {
      return headers;
    },
    status: function (code) {
      res.statusCode = code;
      return res;
    },
    json: function (obj) {
      res.body = obj;
      return res;
    },
  };
  return res;
}

function run(handler, req) {
  const res = makeRes();
  return Promise.resolve(handler(req, res)).then(function () {
    return res;
  });
}

function cookieHeaderFromSetCookie(setCookieHeader) {
  // Turns a Set-Cookie response header (array of "name=value; attr...")
  // into a Cookie request header ("name=value; name2=value2"), the way a
  // real browser would after receiving the login response.
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return arr
    .filter(Boolean)
    .map((c) => c.split(";")[0])
    .join("; ");
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
const NON_ADMIN_EMAIL = "someone-else@example.com";

function freshDb() {
  return {
    bookings: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        customer_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        service_type: "junk_removal",
        appointment_date: "2026-01-15",
        time_window: "w_0800_1000",
        status: null, // NULL status — must display as "New"
        description: "Old couch and mattress",
        estimated_price: 250,
        final_price: null,
        internal_notes: null,
        created_at: "2026-01-01T12:00:00Z",
        // Phase 3B Step 2 — has its own service-address snapshot, deliberately
        // different from the customer's on-file address (Denver/123 Main St)
        // below, so tests can prove the booking's own snapshot is used and
        // never overridden by the customer's (possibly since-changed) address.
        service_address: "999 Job Site Rd",
        service_city: "Golden",
        service_state: "CO",
        service_zip: "80401",
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        customer_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        service_type: "dumpster_rental",
        appointment_date: "2026-01-10",
        time_window: "morning", // legacy window — must map to a readable label
        status: "booked",
        description: "15-yard dumpster",
        estimated_price: 450,
        final_price: 450,
        internal_notes: "Gate code 1234",
        created_at: "2026-01-02T09:30:00Z",
        // No service_* snapshot — simulates a legacy booking created before
        // Phase 3B Step 2, which must fall back to the customer's address.
      },
    ],
    customers: [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        first_name: "Jamie",
        last_name: "Rivera",
        phone: "303-555-0100",
        email: "jamie@example.com",
        address: "123 Main St",
        city: "Denver",
        state: "CO",
        zip: "80202",
      },
      {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        first_name: "<script>alert(1)</script>",
        last_name: "Doe",
        phone: "303-555-0101",
        email: null,
        address: "456 Oak Ave",
        city: "Aurora",
        state: "CO",
        zip: "80010",
      },
    ],
    dumpster_rentals: [
      {
        booking_id: "22222222-2222-2222-2222-222222222222",
        delivery_date: "2026-01-10",
        pickup_date: "2026-01-13",
        material_type: "Household junk",
        placement_notes: "Driveway",
      },
    ],
    booking_photos: [
      { id: "p1", booking_id: "11111111-1111-1111-1111-111111111111", storage_path: "bookings/1111/p1.jpg", created_at: "2026-01-01T12:05:00Z" },
    ],
  };
}

// Configures the fake Supabase Auth "ground truth" (the one email+password
// combination that will actually succeed) independently of whatever
// credentials a test later submits — so a test can deliberately submit the
// WRONG password and observe a real mismatch, rather than the mock trivially
// accepting anything it's given.
function configureAuthWithCredentials(trueEmail, truePassword) {
  currentFakeAnon = createFakeAnonClient({
    signInWithPassword: async ({ email: e, password: p }) => {
      if (e !== trueEmail || p !== truePassword) return { data: null, error: { message: "Invalid login credentials" } };
      return {
        data: {
          user: { email: e },
          session: { access_token: "at-" + e, refresh_token: "rt-" + e, expires_in: 3600 },
        },
        error: null,
      };
    },
    getUser: async (token) => {
      if (token === "at-" + trueEmail) return { data: { user: { email: trueEmail } }, error: null };
      return { data: null, error: { message: "invalid token" } };
    },
  });
}

// Convenience for the common case: submit exactly the credentials that will
// succeed.
async function loginAs(email, password) {
  configureAuthWithCredentials(email, password);
  return run(loginHandler, makeReq({ method: "POST", query: { action: "login" }, body: { email: email, password: password } }));
}

// ---------------------------------------------------------------------
// Test registry — run strictly sequentially (shared mutable fakes)
// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// 1. Unit: booking-format helpers (NULL status, legacy + current windows)
test("booking-format: NULL/empty status normalizes and labels as New", async () => {
  assert.strictEqual(normalizedStatus(null), "new");
  assert.strictEqual(normalizedStatus(""), "new");
  assert.strictEqual(normalizedStatus(undefined), "new");
  assert.strictEqual(statusLabel(null), "New");
  assert.strictEqual(statusLabel(""), "New");
});

test("booking-format: legacy time window maps to a readable label", async () => {
  assert.strictEqual(timeWindowLabel("morning"), "Morning (8am–11am)");
  assert.strictEqual(timeWindowLabel("evening"), "Evening (5pm–7pm)");
});

test("booking-format: current 2-hour time window maps to a readable label", async () => {
  assert.strictEqual(timeWindowLabel("w_0800_1000"), "8:00 AM – 10:00 AM");
  assert.strictEqual(timeWindowLabel("w_1800_2000"), "6:00 PM – 8:00 PM");
});

test("booking-format: unrecognized window falls back to the raw value, never crashes", async () => {
  assert.strictEqual(timeWindowLabel("some_future_window"), "some_future_window");
  assert.strictEqual(timeWindowLabel(null), "—");
});

// 2. Login: happy path, wrong password, non-admin email
test("login: valid admin credentials succeed and set session cookies", async () => {
  const res = await loginAs(ADMIN_EMAIL, "correct-password");
  assert.strictEqual(res.statusCode, 200);
  const setCookie = res.getHeader("Set-Cookie");
  assert.ok(setCookie, "expected Set-Cookie header");
  const joined = (Array.isArray(setCookie) ? setCookie : [setCookie]).join(" | ");
  assert.ok(joined.includes("mhjr_admin_at="), "expected access token cookie");
  assert.ok(joined.includes("mhjr_admin_rt="), "expected refresh token cookie");
  assert.ok(joined.includes("HttpOnly"), "cookies must be HttpOnly");
  assert.ok(joined.includes("Secure"), "cookies must be Secure over https");
  assert.ok(joined.includes("SameSite=Lax"), "cookies must be SameSite=Lax");
});

test("login: wrong password is rejected with a generic error and no cookies", async () => {
  configureAuthWithCredentials(ADMIN_EMAIL, "correct-password");
  const res = await run(loginHandler, makeReq({ method: "POST", query: { action: "login" }, body: { email: ADMIN_EMAIL, password: "wrong-password" } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error, "Invalid email or password.");
  assert.strictEqual(res.getHeader("Set-Cookie"), undefined);
});

test("login: real Supabase account but non-allowlisted email is rejected identically to wrong password", async () => {
  currentFakeAnon = createFakeAnonClient({
    signInWithPassword: async () => ({
      data: { user: { email: NON_ADMIN_EMAIL }, session: { access_token: "at-x", refresh_token: "rt-x", expires_in: 3600 } },
      error: null,
    }),
  });
  const res = await run(loginHandler, makeReq({ method: "POST", query: { action: "login" }, body: { email: NON_ADMIN_EMAIL, password: "whatever" } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error, "Invalid email or password.");
  assert.strictEqual(res.getHeader("Set-Cookie"), undefined, "a non-admin must never receive a session cookie");
});

test("login: allowlist comparison is case-insensitive and trims whitespace", async () => {
  currentFakeAnon = createFakeAnonClient({
    signInWithPassword: async () => ({
      data: { user: { email: "SECOND.ADMIN@EXAMPLE.COM" }, session: { access_token: "at-y", refresh_token: "rt-y", expires_in: 3600 } },
      error: null,
    }),
  });
  const res = await run(loginHandler, makeReq({ method: "POST", query: { action: "login" }, body: { email: "second.admin@example.com", password: "whatever" } }));
  assert.strictEqual(res.statusCode, 200);
});

test("login: missing email/password is a 400, not a Supabase call", async () => {
  const res = await run(loginHandler, makeReq({ method: "POST", query: { action: "login" }, body: { email: "", password: "" } }));
  assert.strictEqual(res.statusCode, 400);
});

// 3. Unauthenticated access to admin data APIs -> denied
test("bookings list: no cookies at all -> 401", async () => {
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingsHandler, makeReq({ query: {} }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
});

test("booking detail: no cookies at all -> 401 (even for a real booking id)", async () => {
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingHandler, makeReq({ query: { id: "11111111-1111-1111-1111-111111111111" } }));
  assert.strictEqual(res.statusCode, 401);
});

test("bookings list: garbage/forged access token cookie -> 401, not a crash", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: null, error: { message: "invalid JWT" } }) });
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=not-a-real-token", query: {} }));
  assert.strictEqual(res.statusCode, 401);
});

test("bookings list: valid token but non-allowlisted email -> 401", async () => {
  currentFakeAnon = createFakeAnonClient({ getUser: async () => ({ data: { user: { email: NON_ADMIN_EMAIL } }, error: null }) });
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-nonadmin", query: {} }));
  assert.strictEqual(res.statusCode, 401);
});

// 4. Expired access token + refresh flow
test("bookings list: expired access token + valid refresh token -> allowed, cookies rotated", async () => {
  let refreshCalls = 0;
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-expired" ? { data: null, error: { message: "token expired" } } : { data: null, error: { message: "no" } }),
    refreshSession: async ({ refresh_token }) => {
      refreshCalls++;
      if (refresh_token !== "rt-valid") return { data: null, error: { message: "invalid refresh token" } };
      return { data: { session: { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }, user: { email: ADMIN_EMAIL } }, error: null };
    },
  });
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-expired; mhjr_admin_rt=rt-valid", query: {} }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(refreshCalls, 1);
  const setCookie = res.getHeader("Set-Cookie");
  const joined = (Array.isArray(setCookie) ? setCookie : [setCookie]).join(" | ");
  assert.ok(joined.includes("mhjr_admin_at=at-new"), "expected rotated access token cookie");
  assert.ok(joined.includes("mhjr_admin_rt=rt-new"), "expected rotated refresh token cookie");
});

test("bookings list: expired access token + invalid/expired refresh token -> fails closed (401)", async () => {
  currentFakeAnon = createFakeAnonClient({
    getUser: async () => ({ data: null, error: { message: "token expired" } }),
    refreshSession: async () => ({ data: null, error: { message: "refresh token expired or revoked" } }),
  });
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-expired; mhjr_admin_rt=rt-expired", query: {} }));
  assert.strictEqual(res.statusCode, 401);
});

// 5. Authenticated access -> allowed, with correct data shape
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}

test("bookings list: authenticated admin sees correct summary counts and normalized fields", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: {} }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
  assert.strictEqual(res.body.summary.total, 2);
  assert.strictEqual(res.body.summary.new, 1, "the null-status booking must count as new");
  assert.strictEqual(res.body.summary.booked, 1);
  assert.strictEqual(res.body.bookings.length, 2);
  // Newest first: booking 2 (2026-01-02) before booking 1 (2026-01-01).
  assert.strictEqual(res.body.bookings[0].id, "22222222-2222-2222-2222-222222222222");
  const nullStatusBooking = res.body.bookings.find((b) => b.id === "11111111-1111-1111-1111-111111111111");
  assert.strictEqual(nullStatusBooking.status, "new");
  assert.strictEqual(nullStatusBooking.statusLabel, "New");
  assert.strictEqual(nullStatusBooking.timeWindowLabel, "8:00 AM – 10:00 AM");
  const legacyWindowBooking = res.body.bookings.find((b) => b.id === "22222222-2222-2222-2222-222222222222");
  assert.strictEqual(legacyWindowBooking.timeWindowLabel, "Morning (8am–11am)");
  assert.strictEqual(legacyWindowBooking.photoCount, 0);
  assert.strictEqual(nullStatusBooking.photoCount, 1);
});

test("booking detail: authenticated admin can load an existing booking (with photos)", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { id: "11111111-1111-1111-1111-111111111111" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.status, "new");
  assert.strictEqual(res.body.booking.statusLabel, "New");
  assert.strictEqual(res.body.customer.firstName, "Jamie");
  assert.strictEqual(res.body.photos.length, 1);
  assert.ok(res.body.photos[0].url, "expected a signed photo URL");
  assert.ok(res.body.photos[0].url.startsWith("https://mock-signed.example/"));
});

test("booking detail: booking with zero photos returns an empty photos array, not an error", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { id: "22222222-2222-2222-2222-222222222222" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.photos, []);
  assert.ok(res.body.dumpster, "dumpster_rentals data should be present for a dumpster_rental booking");
  assert.strictEqual(res.body.dumpster.materialType, "Household junk");
});

test("booking detail: signed URLs are only generated after authentication succeeds", async () => {
  const db = freshDb();
  const svc = createFakeServiceClient(db);
  currentFakeService = svc;

  // Unauthenticated first — must be denied before any storage call happens.
  const unauth = await run(bookingHandler, makeReq({ query: { id: "11111111-1111-1111-1111-111111111111" } }));
  assert.strictEqual(unauth.statusCode, 401);
  assert.strictEqual((svc.storage.signCalls || []).length, 0, "no signed URL should be generated for an unauthenticated request");

  adminAuthed();
  const authed = await run(bookingHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { id: "11111111-1111-1111-1111-111111111111" } }));
  assert.strictEqual(authed.statusCode, 200);
  assert.strictEqual(svc.storage.signCalls.length, 1, "exactly one signed URL should now have been generated");
});

// 5b. Phase 3B Step 2 — booking-level service-address snapshot: the
// booking's own snapshot is primary, the customer's current address is only
// a fallback for a legacy row with no snapshot.
test("bookings list: card location comes from the booking's own service_city, not the customer's city", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: {} }));
  const booking1 = res.body.bookings.find((b) => b.id === "11111111-1111-1111-1111-111111111111");
  assert.strictEqual(booking1.serviceCity, "Golden", "must use the booking's own service_city snapshot");
  assert.strictEqual(booking1.customer.city, undefined, "customer object must no longer carry a city field");
});

test("bookings list: a legacy booking with no service_city snapshot falls back to the customer's city", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: {} }));
  const booking2 = res.body.bookings.find((b) => b.id === "22222222-2222-2222-2222-222222222222");
  assert.strictEqual(booking2.serviceCity, "Aurora", "a NULL snapshot must fall back to the customer's current city");
});

test("booking detail: address/directions data comes from the booking's own service_* snapshot, not the customer row", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { id: "11111111-1111-1111-1111-111111111111" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.serviceAddress, { address: "999 Job Site Rd", city: "Golden", state: "CO", zip: "80401" });
  // Identity/contact still comes from customer, which must no longer carry
  // any address field now that location is reported separately.
  assert.strictEqual(res.body.customer.firstName, "Jamie");
  assert.strictEqual(res.body.customer.phone, "303-555-0100");
  assert.strictEqual(res.body.customer.address, undefined, "customer must no longer carry an address field");
  assert.strictEqual(res.body.customer.city, undefined, "customer must no longer carry a city field");
});

test("booking detail: a legacy booking with no service_* snapshot falls back to the customer's address", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { id: "22222222-2222-2222-2222-222222222222" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.serviceAddress, { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" });
});

// 6. Missing / malformed / nonexistent booking id
test("booking detail: missing id -> safe 400, no query issued", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(bookingHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: {} }));
  assert.strictEqual(res.statusCode, 400);
});

test("booking detail: malformed id -> safe 404 (never reaches the database)", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { id: "'; drop table bookings; --" } }));
  assert.strictEqual(res.statusCode, 404);
});

test("booking detail: well-formed but nonexistent id -> safe 404", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const res = await run(bookingHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { id: "99999999-9999-9999-9999-999999999999" } }));
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.error, "Booking not found.");
});

// 7. Logout
test("logout: clears both cookies and calls Supabase sign-out", async () => {
  let signOutCalled = false;
  let setSessionArgs = null;
  currentFakeAnon = createFakeAnonClient({
    setSession: async (args) => {
      setSessionArgs = args;
      return { data: {}, error: null };
    },
    signOut: async () => {
      signOutCalled = true;
      return { error: null };
    },
  });
  const res = await run(logoutHandler, makeReq({ method: "POST", query: { action: "logout" }, cookie: "mhjr_admin_at=at-good; mhjr_admin_rt=rt-good" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(signOutCalled, true);
  assert.deepStrictEqual(setSessionArgs, { access_token: "at-good", refresh_token: "rt-good" });
  const setCookie = res.getHeader("Set-Cookie");
  const joined = (Array.isArray(setCookie) ? setCookie : [setCookie]).join(" | ");
  assert.ok(joined.includes("mhjr_admin_at=;"), "access cookie should be cleared");
  assert.ok(joined.includes("Max-Age=0"), "cleared cookies should have Max-Age=0");
});

// 8. No secret leakage in any admin response body
test("no admin API response ever contains the service-role key or anon key values", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb());
  const listRes = await run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: {} }));
  const detailRes = await run(bookingHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { id: "11111111-1111-1111-1111-111111111111" } }));
  const loginRes = await loginAs(ADMIN_EMAIL, "correct-password");
  [listRes, detailRes, loginRes].forEach((r) => {
    const asText = JSON.stringify(r.body);
    assert.ok(!asText.includes(process.env.SUPABASE_SECRET_KEY), "response must not contain the service-role key");
    assert.ok(!asText.includes(process.env.SUPABASE_ANON_KEY), "response must not contain the anon key");
  });
});

// 9. Static-analysis guard: the admin client-side JS never builds HTML from
// customer-controlled strings. This isn't a DOM test (there's no browser
// here), but the actual defense against stored XSS in these files IS this
// code-level property (textContent/attribute assignment only) — see
// docs/phase-2/security-review.md for the corresponding manual browser
// verification with a real crafted payload, which this guard complements
// by making a future regression (someone adding an innerHTML call) fail
// the test suite immediately, without needing a browser.
test("admin client JS never uses innerHTML/insertAdjacentHTML/document.write", async () => {
  const files = ["admin/dashboard.js", "admin/booking-detail.js", "admin/login.js"];
  files.forEach((rel) => {
    const full = path.join(__dirname, "..", rel);
    const src = fs.readFileSync(full, "utf8");
    assert.ok(!/\.innerHTML\s*=/.test(src), rel + " must not assign innerHTML");
    assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), rel + " must not call insertAdjacentHTML(...)");
    assert.ok(!/document\.write\s*\(/.test(src), rel + " must not call document.write(...)");
  });
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
