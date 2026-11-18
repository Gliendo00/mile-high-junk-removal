// Returning-client address fix — when a job or estimate is created for a
// client with NO address on file, its service address is copied onto the
// client (api/admin/booking.js backfillCustomerAddressIfMissing()); a client
// who already has an address is never overwritten. Also unit-tests the
// browser helper admin/client-address-prefill.js's address choice
// (address on file first, else the newest job with an address).
// Same offline in-memory Supabase fake as tests/phase3c-stage2-new-job.test.js
// (copied, plus update()/is()) — never the real network or database.
//
// Run with:  node tests/returning-client-address.test.js

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase: query builder with insert()/select()/eq()/single()/
// maybeSingle()/order() support — the union of what booking.js's and
// client.js's GET *and* new POST code paths actually use.
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  // Valid hex only (0-9a-f) — a real booking/client id must pass the
  // endpoints' own UUID_RE check on any later lookup, exactly like a real
  // Supabase-generated uuid would.
  return "eeeeeeee-eeee-eeee-eeee-" + String(100000000000 + nextId++).padStart(12, "0");
}

class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._order = null;
    this._single = null;
    this._insertRow = null;
  }
  select() {
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
  order(field, opts) {
    this._order = { field: field, ascending: !opts || opts.ascending !== false };
    return this;
  }
  insert(data) {
    this._insertRow = data;
    return this;
  }
  update(data) {
    this._updateData = data;
    return this;
  }
  is(field, val) {
    this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val);
    return this;
  }
  maybeSingle() {
    this._single = "maybeSingle";
    return this._resolve();
  }
  single() {
    this._single = "single";
    return this._resolve();
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    if (this._updateData) {
      const all = this._db[this._table] || [];
      const hits = all.filter((row) => this._filters.every((f) => f(row)));
      hits.forEach((row) => Object.assign(row, this._updateData));
      return { data: hits, error: null };
    }
    if (this._insertRow) {
      if (this._db.__insertError && this._db.__insertError[this._table]) {
        return { data: null, error: this._db.__insertError[this._table] };
      }
      const row = Object.assign({ id: makeId(), created_at: "2026-09-17T12:00:00Z" }, this._insertRow);
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

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
    if (this._single === "maybeSingle") {
      if (filtered.length > 1) return { data: null, error: { message: "multiple rows returned for maybeSingle" } };
      return { data: filtered[0] || null, error: null };
    }
    if (this._single === "single") {
      return filtered.length ? { data: filtered[0], error: null } : { data: null, error: { message: "no rows returned for single" } };
    }
    return { data: filtered, error: null };
  }
}

function createFakeServiceClient(db) {
  return {
    from(table) {
      return new FakeQueryBuilder(table, db);
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

const bookingHandler = require("../api/admin/booking.js");
const clientHandler = require("../api/admin/client.js");

// ---------------------------------------------------------------------
// req/res mocks (identical shape to every prior phase's)
// ---------------------------------------------------------------------
function makeReq(opts) {
  opts = opts || {};
  const json = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  return {
    method: opts.method || "GET",
    headers: Object.assign(
      { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)), cookie: opts.cookie || "", "x-forwarded-proto": "https" },
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
const NON_ADMIN_EMAIL = "someone-else@example.com";

function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

const EXISTING_CUSTOMER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NONEXISTENT_ID = "99999999-9999-9999-9999-999999999999";

function freshDb() {
  return {
    customers: [
      {
        id: EXISTING_CUSTOMER_ID,
        first_name: "Jamie",
        last_name: "Rivera",
        phone: "303-555-0100",
        email: "jamie@example.com",
        address: "123 Main St",
        city: "Denver",
        state: "CO",
        zip: "80202",
        phone_normalized: "3035550100",
        email_normalized: "jamie@example.com",
        created_at: "2026-01-01T10:00:00Z",
      },
    ],
    bookings: [],
    dumpster_rentals: [],
    booking_photos: [],
  };
}

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}
const VALID_APPOINTMENT_DATE = futureDate(3);

function validJobBody(overrides) {
  return Object.assign(
    {
      customerId: EXISTING_CUSTOMER_ID,
      serviceType: "junk_removal",
      appointmentDate: VALID_APPOINTMENT_DATE,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "555 Job Site Rd", city: "Aurora", state: "CO", zip: "80010" },
      description: "Old couch and a mattress",
      estimatedPrice: 250,
      internalNotes: "Gate code 4321",
    },
    overrides || {}
  );
}

function postBooking(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, body: body }));
}

const vm = require("vm");

function postEstimate(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, body: body, query: { resource: "estimate" } }));
}

function dbWithBlankClient() {
  const db = freshDb();
  Object.assign(db.customers[0], { address: null, city: null, state: null, zip: null });
  db.estimates = [];
  return db;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log("PASS - " + name);
  } catch (err) {
    results.push(false);
    console.log("FAIL - " + name);
    console.log("       " + (err && err.stack ? err.stack : err));
  }
}

(async () => {
  adminAuthed();

  await test("new job for a client with no address copies the job address onto the client", async () => {
    const db = dbWithBlankClient();
    const res = await postBooking(db, AUTH_COOKIE, validJobBody());
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const c = db.customers[0];
    assert.strictEqual(c.address, "555 Job Site Rd");
    assert.strictEqual(c.city, "Aurora");
    assert.strictEqual(c.state, "CO");
    assert.strictEqual(c.zip, "80010");
  });

  await test("new job never overwrites an address already on file", async () => {
    const db = freshDb();
    const res = await postBooking(db, AUTH_COOKIE, validJobBody());
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const c = db.customers[0];
    assert.strictEqual(c.address, "123 Main St");
    assert.strictEqual(c.city, "Denver");
    assert.strictEqual(c.zip, "80202");
    assert.strictEqual(db.bookings[0].service_address, "555 Job Site Rd");
  });

  await test("a failing backfill never fails the job create", async () => {
    const db = dbWithBlankClient();
    currentFakeService = createFakeServiceClient(db);
    const realFrom = currentFakeService.from;
    currentFakeService.from = function (table) {
      const qb = realFrom.call(this, table);
      if (table === "customers") qb.update = () => { throw new Error("simulated update failure"); };
      return qb;
    };
    const res = await run(bookingHandler, makeReq({ method: "POST", cookie: AUTH_COOKIE, body: validJobBody() }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(db.bookings.length, 1);
  });

  await test("new estimate for a client with no address copies the estimate address onto the client", async () => {
    const db = dbWithBlankClient();
    const res = await postEstimate(db, AUTH_COOKIE, {
      customerId: EXISTING_CUSTOMER_ID,
      serviceType: "junk_removal",
      appointmentDate: VALID_APPOINTMENT_DATE,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "77 Estimate Ave", city: "Lakewood", state: "CO", zip: "80226" },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(db.customers[0].address, "77 Estimate Ave");
    assert.strictEqual(db.customers[0].city, "Lakewood");
  });

  // Browser helper — loaded into a sandbox; only pickAddress() is exercised.
  const helperSrc = fs.readFileSync(path.join(__dirname, "..", "admin", "client-address-prefill.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(helperSrc, sandbox);
  const pickAddress = sandbox.window.AdminClientAddressPrefill.pickAddress;

  await test("prefill prefers the client address on file", async () => {
    const a = pickAddress({ client: { address: "1 File St", city: "Denver", state: "CO", zip: "80202" }, bookings: [{ serviceAddress: { address: "9 Job Rd" } }] });
    assert.strictEqual(a.address, "1 File St");
    assert.strictEqual(a.source, "file");
  });

  await test("prefill falls back to the newest job that has an address", async () => {
    const a = pickAddress({ client: { address: null }, bookings: [{ serviceAddress: { address: null } }, { serviceAddress: { address: "9 Job Rd", city: "Aurora", state: "CO", zip: "80010" } }, { serviceAddress: { address: "old" } }] });
    assert.strictEqual(a.address, "9 Job Rd");
    assert.strictEqual(a.city, "Aurora");
    assert.strictEqual(a.source, "lastJob");
  });

  await test("prefill returns null when nothing is known", async () => {
    assert.strictEqual(pickAddress({ client: {}, bookings: [] }), null);
    assert.strictEqual(pickAddress(null), null);
  });

  const failed = results.filter((r) => !r).length;
  console.log("\n" + results.length + " tests run, " + failed + " failed.");
  process.exit(failed ? 1 : 0);
})();
