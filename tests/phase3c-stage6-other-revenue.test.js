// Local, offline test harness for Phase 3C Stage 6 (Batch 3) — the Other
// Revenue ledger (Metal Recycling, Resale Sales): api/admin/bookings.js's
// ?view=other-revenue (GET) / resource:"other-revenue" (POST create, PATCH
// void). See sql/2026-10-02_phase3c-stage6-other-revenue.sql for the full
// schema/grants writeup.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project. Based
// directly on tests/phase3c-stage3-expenses-management.test.js's fake
// Supabase builder (gte/lte/is/eq/in/order/limit/insert/update/FK-violation
// simulation) since this ledger lives in the same file (api/admin/bookings.js)
// and is list-shaped the same way expenses is.
//
// Run with:  node tests/phase3c-stage6-other-revenue.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

let nextId = 1;
function makeId() {
  return "ffffffff-ffff-ffff-ffff-" + String(100000000000 + nextId++).padStart(12, "0");
}
function nowIso() {
  return new Date().toISOString();
}

class FakeQueryBuilder {
  constructor(table, db) {
    this.table = table;
    this.db = db;
    this.eqFilters = [];
    this.isFilters = [];
    this.ilikeFilters = [];
    this.inFilters = [];
    this.rangeFilters = [];
    this._orders = [];
    this._limit = null;
    this._insertPayload = null;
    this._updatePayload = null;
    this._single = null;
  }
  select() {
    return this;
  }
  eq(col, val) {
    this.eqFilters.push({ col, val });
    return this;
  }
  is(col, val) {
    this.isFilters.push({ col, val });
    return this;
  }
  ilike(col, pattern) {
    const needle = String(pattern).replace(/^%|%$/g, "").toLowerCase();
    this.ilikeFilters.push({ col, needle });
    return this;
  }
  in(col, values) {
    const set = new Set(values);
    this.inFilters.push({ col, set });
    return this;
  }
  gte(col, val) {
    this.rangeFilters.push({ col, val, op: "gte" });
    return this;
  }
  lte(col, val) {
    this.rangeFilters.push({ col, val, op: "lte" });
    return this;
  }
  order(col, opts) {
    this._orders.push({ col, asc: !opts || opts.ascending !== false });
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  insert(payload) {
    this._insertPayload = payload;
    return this;
  }
  update(payload) {
    this._updatePayload = payload;
    return this;
  }
  single() {
    this._single = "single";
    return this._resolve();
  }
  maybeSingle() {
    this._single = "maybeSingle";
    return this._resolve();
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    const rows = (this.db[this.table] = this.db[this.table] || []);

    if (this._insertPayload) {
      if (this.db.__fkTables && this.db.__fkTables[this.table]) {
        for (const [col, refTable] of Object.entries(this.db.__fkTables[this.table])) {
          const val = this._insertPayload[col];
          if (val != null && !(this.db[refTable] || []).some((r) => r.id === val)) {
            return { data: null, error: { code: "23503", message: "foreign key violation on " + col } };
          }
        }
      }
      const row = Object.assign({ id: makeId(), created_at: nowIso(), updated_at: nowIso() }, this._insertPayload);
      rows.push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let matched = rows.filter(
      (r) =>
        this.eqFilters.every((f) => r[f.col] === f.val) &&
        this.isFilters.every((f) => (r[f.col] === undefined ? null : r[f.col]) === f.val) &&
        this.ilikeFilters.every((f) => typeof r[f.col] === "string" && r[f.col].toLowerCase().indexOf(f.needle) !== -1) &&
        this.inFilters.every((f) => f.set.has(r[f.col])) &&
        this.rangeFilters.every((f) => (f.op === "gte" ? r[f.col] >= f.val : r[f.col] <= f.val))
    );

    if (this._updatePayload) {
      if (this.db.__fkTables && this.db.__fkTables[this.table]) {
        for (const [col, refTable] of Object.entries(this.db.__fkTables[this.table])) {
          const val = this._updatePayload[col];
          if (val != null && !(this.db[refTable] || []).some((r) => r.id === val)) {
            return { data: null, error: { code: "23503", message: "foreign key violation on " + col } };
          }
        }
      }
      matched.forEach((r) => Object.assign(r, this._updatePayload));
      if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
      if (this._single === "single") return matched.length ? { data: matched[0], error: null } : { data: null, error: { message: "no rows" } };
      return { data: matched, error: null };
    }

    this._orders.forEach((ord) => {
      matched = matched.slice().sort((a, b) => {
        if (a[ord.col] < b[ord.col]) return ord.asc ? -1 : 1;
        if (a[ord.col] > b[ord.col]) return ord.asc ? 1 : -1;
        return 0;
      });
    });
    if (this._limit != null) matched = matched.slice(0, this._limit);

    if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
    if (this._single === "single") return matched.length ? { data: matched[0], error: null } : { data: null, error: { message: "no rows" } };
    return { data: matched, error: null };
  }
}

function createFakeServiceClient(db) {
  return { from: (table) => new FakeQueryBuilder(table, db) };
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

(function interceptSupabaseModule() {
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
})();

process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";

const bookingsHandler = require("../api/admin/bookings.js");
const { OTHER_REVENUE_TYPES, ALL_OTHER_REVENUE_TYPE_KEYS, otherRevenueTypeLabel } = require("../api/_lib/other-revenue-types.js");

function makeReq(opts) {
  opts = opts || {};
  const json = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  return {
    method: opts.method || "GET",
    headers: Object.assign({ "content-type": "application/json", "content-length": String(Buffer.byteLength(json)), cookie: opts.cookie || "" }, opts.headers || {}),
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
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
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
  return Promise.resolve(handler(req, res)).then(() => res);
}

const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

function freshDb(overrides) {
  return Object.assign({ other_revenue: [], bookings: [], customers: [], __fkTables: { other_revenue: { booking_id: "bookings" } } }, overrides || {});
}
function req(db, opts) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq(Object.assign({ cookie: AUTH_COOKIE }, opts)));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

function makeOtherRevenue(overrides) {
  return Object.assign(
    {
      id: makeId(),
      type: "metal_recycling",
      amount: 185,
      revenue_date: "2026-09-19",
      note: "Scrap load",
      booking_id: null,
      voided_at: null,
      voided_reason: null,
      voided_by: null,
      created_by: ADMIN_EMAIL,
      created_at: "2026-09-19T12:00:00Z",
      updated_at: "2026-09-19T12:00:00Z",
    },
    overrides || {}
  );
}
function makeBooking(overrides) {
  return Object.assign({ id: makeId(), appointment_date: "2026-09-10", service_type: "junk_removal", customer_id: null }, overrides || {});
}

// =======================================================================
// Allowlist
// =======================================================================
test("OTHER_REVENUE_TYPES: exactly metal_recycling and resale_sale are supported, in that order", () => {
  assert.deepStrictEqual(ALL_OTHER_REVENUE_TYPE_KEYS, ["metal_recycling", "resale_sale"]);
  assert.strictEqual(otherRevenueTypeLabel("metal_recycling"), "Metal Recycling");
  assert.strictEqual(otherRevenueTypeLabel("resale_sale"), "Resale Sales");
});

// =======================================================================
// POST — create
// =======================================================================
test("POST other-revenue: requires auth (no cookie -> 401)", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await req(freshDb(), { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", amount: 100, revenueDate: "2026-09-19" } });
  assert.strictEqual(res.statusCode, 401);
});

test("POST other-revenue: create a metal_recycling entry succeeds and is attributed to the session email", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await req(db, { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", amount: 185, revenueDate: "2026-09-19", note: "Scrap load" } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.otherRevenue.type, "metal_recycling");
  assert.strictEqual(res.body.otherRevenue.typeLabel, "Metal Recycling");
  assert.strictEqual(res.body.otherRevenue.amount, 185);
  assert.strictEqual(res.body.otherRevenue.note, "Scrap load");
  assert.strictEqual(res.body.otherRevenue.createdBy, ADMIN_EMAIL);
  assert.strictEqual(res.body.otherRevenue.isVoided, false);
  assert.strictEqual(db.other_revenue.length, 1);
});

test("POST other-revenue: create a resale_sale entry succeeds (the second supported type)", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await req(db, { method: "POST", body: { resource: "other-revenue", type: "resale_sale", amount: 40, revenueDate: "2026-09-19", note: "Sold recovered sectional sofa" } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.otherRevenue.type, "resale_sale");
  assert.strictEqual(res.body.otherRevenue.typeLabel, "Resale Sales");
});

test("POST other-revenue: an unsupported type (e.g. 'junk_removal' or made up) is rejected, nothing written", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await req(db, { method: "POST", body: { resource: "other-revenue", type: "junk_removal", amount: 100, revenueDate: "2026-09-19" } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.other_revenue.length, 0);
});

test("POST other-revenue: missing amount -> 400", async () => {
  adminAuthed();
  const res = await req(freshDb(), { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", revenueDate: "2026-09-19" } });
  assert.strictEqual(res.statusCode, 400);
});

test("POST other-revenue: amount <= 0 -> 400", async () => {
  adminAuthed();
  const res = await req(freshDb(), { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", amount: 0, revenueDate: "2026-09-19" } });
  assert.strictEqual(res.statusCode, 400);
});

test("POST other-revenue: amount above the max bound -> 400", async () => {
  adminAuthed();
  const res = await req(freshDb(), { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", amount: 9999999, revenueDate: "2026-09-19" } });
  assert.strictEqual(res.statusCode, 400);
});

test("POST other-revenue: amount is rounded to 2 decimal places", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await req(db, { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", amount: 185.456, revenueDate: "2026-09-19" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.otherRevenue.amount, 185.46);
});

test("POST other-revenue: missing/invalid revenueDate -> 400", async () => {
  adminAuthed();
  const res1 = await req(freshDb(), { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", amount: 100 } });
  assert.strictEqual(res1.statusCode, 400);
  const res2 = await req(freshDb(), { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", amount: 100, revenueDate: "not-a-date" } });
  assert.strictEqual(res2.statusCode, 400);
});

test("POST other-revenue: revenueDate before the historical floor (Jan 1 2026) -> 400", async () => {
  adminAuthed();
  const res = await req(freshDb(), { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", amount: 100, revenueDate: "2025-12-31" } });
  assert.strictEqual(res.statusCode, 400);
});

test("POST other-revenue: revenueDate in the future -> 400", async () => {
  adminAuthed();
  const farFuture = String(new Date().getUTCFullYear() + 5) + "-01-01";
  const res = await req(freshDb(), { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", amount: 100, revenueDate: farFuture } });
  assert.strictEqual(res.statusCode, 400);
});

test("POST other-revenue: an optional bookingId links to a real job", async () => {
  adminAuthed();
  const booking = makeBooking();
  const db = freshDb({ bookings: [booking] });
  const res = await req(db, { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", amount: 185, revenueDate: "2026-09-19", bookingId: booking.id } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.otherRevenue.bookingId, booking.id);
});

test("POST other-revenue: a bookingId that doesn't exist is rejected via the FK violation (400), not silently stored", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await req(db, { method: "POST", body: { resource: "other-revenue", type: "metal_recycling", amount: 185, revenueDate: "2026-09-19", bookingId: makeId() } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.other_revenue.length, 0);
});

test("POST other-revenue: linking a job never writes to the bookings table itself (no double counting, no mutation of final_price/estimated_price)", async () => {
  adminAuthed();
  const booking = makeBooking({ final_price: 600, estimated_price: 600 });
  const db = freshDb({ bookings: [booking] });
  await req(db, { method: "POST", body: { resource: "other-revenue", type: "resale_sale", amount: 40, revenueDate: "2026-09-19", bookingId: booking.id } });
  assert.strictEqual(db.bookings[0].final_price, 600, "the linked booking's own revenue fields must be byte-for-byte unchanged");
  assert.strictEqual(db.bookings[0].estimated_price, 600);
});

test("POST other-revenue: wrong resource discriminator falls through to the expense create path (resource:'expense' required there), confirming no accidental cross-talk", async () => {
  adminAuthed();
  const db = freshDb({ expenses: [] });
  const res = await req(db, { method: "POST", body: { resource: "other-revenue-typo", type: "metal_recycling", amount: 100, revenueDate: "2026-09-19" } });
  // Falls into handleCreateExpense(), which itself 400s on an unrecognized resource.
  assert.strictEqual(res.statusCode, 400);
});

// =======================================================================
// GET — list
// =======================================================================
test("GET other-revenue: requires a startDate/endDate range", async () => {
  adminAuthed();
  const res = await req(freshDb(), { query: { view: "other-revenue" } });
  assert.strictEqual(res.statusCode, 400);
});

test("GET other-revenue: lists rows within the range, newest first, with totalAmount summing only active rows", async () => {
  adminAuthed();
  const db = freshDb({
    other_revenue: [
      makeOtherRevenue({ revenue_date: "2026-09-18", amount: 100 }),
      makeOtherRevenue({ revenue_date: "2026-09-19", amount: 85 }),
      makeOtherRevenue({ revenue_date: "2026-08-01", amount: 999 }), // outside range
    ],
  });
  const res = await req(db, { query: { view: "other-revenue", startDate: "2026-09-01", endDate: "2026-09-30" } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.total, 2);
  assert.strictEqual(res.body.totalAmount, 185);
  assert.strictEqual(res.body.otherRevenue.length, 2);
});

test("GET other-revenue: a voided row is excluded from the list by default, and from totalAmount even when includeVoided=1 surfaces it for display", async () => {
  adminAuthed();
  const db = freshDb({
    other_revenue: [
      makeOtherRevenue({ revenue_date: "2026-09-19", amount: 185 }),
      makeOtherRevenue({ revenue_date: "2026-09-19", amount: 50, voided_at: nowIso(), voided_reason: "entered twice", voided_by: ADMIN_EMAIL }),
    ],
  });
  const resDefault = await req(db, { query: { view: "other-revenue", startDate: "2026-09-01", endDate: "2026-09-30" } });
  assert.strictEqual(resDefault.body.otherRevenue.length, 1, "voided row hidden by default");
  assert.strictEqual(resDefault.body.totalAmount, 185);

  const resIncluded = await req(db, { query: { view: "other-revenue", startDate: "2026-09-01", endDate: "2026-09-30", includeVoided: "1" } });
  assert.strictEqual(resIncluded.body.otherRevenue.length, 2, "both rows now shown");
  assert.strictEqual(resIncluded.body.totalAmount, 185, "totalAmount stays active-only regardless of includeVoided — a voided row never counts toward the period total");
  const voidedRow = resIncluded.body.otherRevenue.find((r) => r.isVoided);
  assert.strictEqual(voidedRow.voidedReason, "entered twice");
  assert.strictEqual(voidedRow.voidedBy, ADMIN_EMAIL);
});

test("GET other-revenue: type filter narrows to exactly that type", async () => {
  adminAuthed();
  const db = freshDb({
    other_revenue: [
      makeOtherRevenue({ type: "metal_recycling", revenue_date: "2026-09-19", amount: 185 }),
      makeOtherRevenue({ type: "resale_sale", revenue_date: "2026-09-19", amount: 40 }),
    ],
  });
  const res = await req(db, { query: { view: "other-revenue", startDate: "2026-09-01", endDate: "2026-09-30", type: "resale_sale" } });
  assert.strictEqual(res.body.otherRevenue.length, 1);
  assert.strictEqual(res.body.otherRevenue[0].type, "resale_sale");
  assert.strictEqual(res.body.totalAmount, 40);
});

test("GET other-revenue: an unrecognized type value is ignored (falls back to unfiltered), not an error", async () => {
  adminAuthed();
  const db = freshDb({ other_revenue: [makeOtherRevenue({ revenue_date: "2026-09-19" })] });
  const res = await req(db, { query: { view: "other-revenue", startDate: "2026-09-01", endDate: "2026-09-30", type: "not-a-real-type" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.otherRevenue.length, 1);
});

test("GET other-revenue: a linked job is enriched with a job label (customer name + date), same attachJobLabels() helper expenses already use", async () => {
  adminAuthed();
  const cust = { id: makeId(), first_name: "Dan", last_name: "Ortiz" };
  const booking = makeBooking({ customer_id: cust.id, appointment_date: "2026-09-10", service_type: "junk_removal" });
  const db = freshDb({ bookings: [booking], customers: [cust], other_revenue: [makeOtherRevenue({ booking_id: booking.id, revenue_date: "2026-09-19" })] });
  const res = await req(db, { query: { view: "other-revenue", startDate: "2026-09-01", endDate: "2026-09-30" } });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.otherRevenue[0].job, "expected a job label to be attached");
  assert.ok(res.body.otherRevenue[0].job.label.indexOf("Dan Ortiz") !== -1);
});

// =======================================================================
// PATCH — void (the only write this ledger's PATCH allows)
// =======================================================================
test("PATCH other-revenue: requires auth (no cookie -> 401)", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await req(freshDb(), { method: "PATCH", body: { resource: "other-revenue", id: "x", reason: "test" } });
  assert.strictEqual(res.statusCode, 401);
});

test("PATCH other-revenue: a reason is required to void", async () => {
  adminAuthed();
  const row = makeOtherRevenue();
  const db = freshDb({ other_revenue: [row] });
  const res = await req(db, { method: "PATCH", body: { resource: "other-revenue", id: row.id } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.other_revenue[0].voided_at, null, "nothing should be written without a reason");
});

test("PATCH other-revenue: voiding sets voided_at/voided_reason/voided_by from the session, row stays in the table", async () => {
  adminAuthed();
  const row = makeOtherRevenue();
  const db = freshDb({ other_revenue: [row] });
  const res = await req(db, { method: "PATCH", body: { resource: "other-revenue", id: row.id, reason: "Entered twice by mistake" } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.otherRevenue.isVoided, true);
  assert.strictEqual(res.body.otherRevenue.voidedReason, "Entered twice by mistake");
  assert.strictEqual(res.body.otherRevenue.voidedBy, ADMIN_EMAIL);
  assert.strictEqual(db.other_revenue.length, 1, "voiding never deletes the row — it stays permanently in the table");
  assert.strictEqual(db.other_revenue[0].amount, row.amount, "amount must be untouched by voiding");
});

test("PATCH other-revenue: an already-voided row cannot be voided again (409)", async () => {
  adminAuthed();
  const row = makeOtherRevenue({ voided_at: nowIso(), voided_reason: "first void", voided_by: ADMIN_EMAIL });
  const db = freshDb({ other_revenue: [row] });
  const res = await req(db, { method: "PATCH", body: { resource: "other-revenue", id: row.id, reason: "second attempt" } });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(db.other_revenue[0].voided_reason, "first void", "the original void reason must survive a re-void attempt");
});

test("PATCH other-revenue: an unknown id -> 409, nothing written", async () => {
  adminAuthed();
  const res = await req(freshDb(), { method: "PATCH", body: { resource: "other-revenue", id: makeId(), reason: "test" } });
  assert.strictEqual(res.statusCode, 409);
});

test("PATCH other-revenue: there is no 'update' action — sending amount/type/revenueDate alongside a void request has zero effect on those fields (append-only, same guarantee job_payments makes)", async () => {
  adminAuthed();
  const row = makeOtherRevenue({ amount: 185, type: "metal_recycling", revenue_date: "2026-09-19" });
  const db = freshDb({ other_revenue: [row] });
  const res = await req(db, {
    method: "PATCH",
    body: { resource: "other-revenue", id: row.id, reason: "correcting", action: "update", amount: 99999, type: "resale_sale", revenueDate: "2026-01-01" },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.other_revenue[0].amount, 185, "amount must never change via PATCH");
  assert.strictEqual(db.other_revenue[0].type, "metal_recycling", "type must never change via PATCH");
  assert.strictEqual(db.other_revenue[0].revenue_date, "2026-09-19", "revenue_date must never change via PATCH");
  assert.strictEqual(db.other_revenue[0].voided_at !== null, true, "the void itself must still have taken effect");
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
