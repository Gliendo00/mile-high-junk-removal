// Local, offline test harness for Phase 4, Stage 1 — Dumpster Pickup
// Auto-Job. Creating a dumpster_rental booking now automatically creates
// exactly one linked pickup booking (service_type: "dumpster_pickup",
// internal-only, never a second sale) via api/admin/booking.js's
// ensurePickupBooking()/syncPickupBookingDate()/
// propagatePickupCancellation()/propagatePickupArchive() helpers; every
// business-metric query in api/admin/bookings.js and api/admin/client.js
// excludes it.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project.
//
// Run with:  node tests/phase4-stage1-dumpster-pickup-auto-job.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let nextId = 1;
function makeId() {
  return "aaaaaaaa-aaaa-aaaa-aaaa-" + String(100000000000 + nextId++).padStart(12, "0");
}
function nowIso() {
  return new Date().toISOString();
}
function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  return parts.year + "-" + parts.month + "-" + parts.day;
}
function addDaysIso(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" + String(dt.getUTCDate()).padStart(2, "0");
}
const TODAY_ISO = denverTodayIso();
// Generous +30 days — comfortably future-proof without pinning a literal
// that could itself rot, same convention tests/phase3c-dumpster-rental-admin.test.js
// already established.
const FUTURE_DELIVERY_ISO = addDaysIso(TODAY_ISO, 30);
const FUTURE_DELIVERY_PLUS_5_ISO = addDaysIso(FUTURE_DELIVERY_ISO, 5);

// =======================================================================
// Fake Supabase — one query-builder shared by every handler under test
// (api/admin/booking.js, api/admin/bookings.js, api/admin/client.js all
// use only the methods implemented below). Partial-unique-index
// simulation (db.__uniquePartial) models the real
// bookings_source_rental_booking_id_uniq / dumpster_rentals_pickup_booking_id_uniq
// constraints from sql/2026-10-18_phase4-stage1-dumpster-pickup-auto-job.sql:
// any number of NULLs coexist freely, a duplicate non-null value conflicts.
// =======================================================================
class FakeQueryBuilder {
  constructor(table, db) {
    this.table = table;
    this.db = db;
    this._filters = [];
    this._order = null;
    this._range = null;
    this._insertPayload = null;
    this._updatePayload = null;
    this._upsertPayload = null;
    this._upsertOpts = null;
    this._delete = false;
    this._single = null;
  }
  select() { return this; }
  eq(col, val) { this._filters.push((r) => r[col] === val); return this; }
  neq(col, val) { this._filters.push((r) => r[col] !== val); return this; }
  is(col, val) { this._filters.push((r) => (r[col] === undefined ? null : r[col]) === val); return this; }
  // Phase 3 — minimal PostgREST-style .or(): comma-separated
  // "field.op.value" clauses, OR'd together as one predicate.
  or(expr) {
    const clauses = String(expr).split(",").map((c) => {
      const parts = c.split(".");
      return { col: parts[0], op: parts[1], val: parts.slice(2).join(".") };
    });
    this._filters.push((r) => clauses.some((c) => {
      const rowVal = r[c.col] === undefined ? null : r[c.col];
      if (c.op === "is") return c.val === "null" ? rowVal === null : rowVal === c.val;
      if (c.op === "lt") return rowVal !== null && rowVal < c.val;
      if (c.op === "eq") return rowVal === c.val;
      return false;
    }));
    return this;
  }
  limit(n) { this._limit = n; return this; }
  not(col, op, val) {
    if (op === "is" && val === null) this._filters.push((r) => r[col] !== undefined && r[col] !== null);
    return this;
  }
  in(col, arr) { const set = new Set(arr); this._filters.push((r) => set.has(r[col])); return this; }
  gte(col, val) { this._filters.push((r) => r[col] != null && r[col] >= val); return this; }
  lte(col, val) { this._filters.push((r) => r[col] != null && r[col] <= val); return this; }
  order(col, opts) { this._order = { col, asc: !opts || opts.ascending !== false }; return this; }
  range(from, to) { this._range = [from, to]; return this; }
  insert(payload) { this._insertPayload = payload; return this; }
  update(payload) { this._updatePayload = payload; return this; }
  upsert(payload, opts) { this._upsertPayload = payload; this._upsertOpts = opts || {}; return this; }
  delete() { this._delete = true; return this; }
  single() { this._single = "single"; return this._resolve(); }
  maybeSingle() { this._single = "maybeSingle"; return this._resolve(); }
  then(resolve, reject) { return this._resolve().then(resolve, reject); }

  async _resolve() {
    const rows = (this.db[this.table] = this.db[this.table] || []);

    if (this._insertPayload) {
      const uniqueCols = (this.db.__uniquePartial && this.db.__uniquePartial[this.table]) || [];
      for (const col of uniqueCols) {
        const val = this._insertPayload[col];
        if (val != null && rows.some((r) => r[col] === val)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint on " + col } };
        }
      }
      const row = Object.assign({ id: makeId(), created_at: nowIso(), updated_at: nowIso() }, this._insertPayload);
      rows.push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    if (this._upsertPayload) {
      const conflictCol = this._upsertOpts.onConflict;
      const existing = conflictCol ? rows.find((r) => r[conflictCol] === this._upsertPayload[conflictCol]) : null;
      let row;
      if (existing) {
        Object.assign(existing, this._upsertPayload);
        row = existing;
      } else {
        row = Object.assign({ id: makeId(), created_at: nowIso() }, this._upsertPayload);
        rows.push(row);
      }
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let matched = rows.filter((r) => this._filters.every((f) => f(r)));
    if (this._limit !== undefined && this._limit !== null) matched = matched.slice(0, this._limit);

    if (this._delete) {
      matched.forEach((r) => {
        const idx = rows.indexOf(r);
        if (idx !== -1) rows.splice(idx, 1);
      });
      return { data: matched, error: null };
    }

    if (this._updatePayload) {
      matched.forEach((r) => Object.assign(r, this._updatePayload));
      if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
      return { data: matched, error: null };
    }

    if (this._order) {
      const { col, asc } = this._order;
      matched = matched.slice().sort((a, b) => {
        if (a[col] < b[col]) return asc ? -1 : 1;
        if (a[col] > b[col]) return asc ? 1 : -1;
        return 0;
      });
    }
    if (this._range) matched = matched.slice(this._range[0], this._range[1] + 1);

    if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
    if (this._single === "single") return matched.length ? { data: matched[0], error: null } : { data: null, error: { message: "no rows" } };
    return { data: matched, error: null };
  }
}

function createFakeServiceClient(db) {
  return {
    from: (table) => new FakeQueryBuilder(table, db),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://mock/signed" }, error: null }) }) },
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

const bookingHandler = require("../api/admin/booking.js");
const bookingsHandler = require("../api/admin/bookings.js");
const clientHandler = require("../api/admin/client.js");

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

function freshDb(overrides) {
  return Object.assign(
    { bookings: [], customers: [], dumpster_rentals: [], job_payments: [], booking_audit_log: [], leads: [] },
    { __uniquePartial: { bookings: ["source_rental_booking_id"], dumpster_rentals: ["pickup_booking_id"] } },
    overrides || {}
  );
}
function callBooking(db, opts) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq(Object.assign({ cookie: AUTH_COOKIE }, opts)));
}
function callBookings(db, opts) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq(Object.assign({ cookie: AUTH_COOKIE }, opts)));
}
function callClient(db, opts) {
  currentFakeService = createFakeServiceClient(db);
  return run(clientHandler, makeReq(Object.assign({ cookie: AUTH_COOKIE }, opts)));
}
function makeCustomer(overrides) {
  return Object.assign({ id: makeId(), first_name: "Jamie", last_name: "Rivera", phone: "3035551234" }, overrides || {});
}
function rentalBody(overrides) {
  return Object.assign(
    {
      mode: "new",
      serviceType: "dumpster_rental",
      appointmentDate: FUTURE_DELIVERY_ISO,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
    },
    overrides || {}
  );
}

async function createRental(db, cust, overrides) {
  adminAuthed();
  const res = await callBooking(db, { method: "POST", body: rentalBody(Object.assign({ customerId: cust.id }, overrides || {})) });
  assert.strictEqual(res.statusCode, 200, "rental create failed: " + JSON.stringify(res.body));
  return res;
}
function findPickup(db, rentalId) {
  return db.bookings.find((b) => b.source_rental_booking_id === rentalId);
}
// Edit Job's real optimistic-concurrency contract (handleUpdate()): the
// caller must submit the exact updatedAt it most recently read. handleCreate()'s
// own response never includes updated_at (not in BOOKING_SELECT_COLS) — a
// real Edit Job page always does its own GET first, same as this helper.
async function getUpdatedAt(db, id) {
  const r = await callBooking(db, { method: "GET", query: { id } });
  assert.strictEqual(r.statusCode, 200, "GET booking detail failed: " + JSON.stringify(r.body));
  return r.body.booking.updatedAt;
}

const registered = [];
function test(name, fn) { registered.push({ name, fn }); }

// =======================================================================
// 1. Creating a dumpster rental creates exactly one linked pickup booking
// =======================================================================
test("creating a dumpster_rental booking creates exactly one linked pickup booking", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await createRental(db, cust);

  const pickups = db.bookings.filter((b) => b.service_type === "dumpster_pickup");
  assert.strictEqual(pickups.length, 1, "exactly one pickup booking must exist");
  assert.strictEqual(db.bookings.length, 2, "exactly 2 bookings rows total (rental + pickup)");

  const pickup = pickups[0];
  assert.strictEqual(pickup.source_rental_booking_id, res.body.booking.id);
  assert.strictEqual(pickup.status, "booked");
  assert.strictEqual(pickup.customer_id, cust.id);
  assert.strictEqual(pickup.service_address, "1 Main St");
  assert.strictEqual(pickup.service_city, "Denver");
  assert.strictEqual(pickup.estimated_price, null);
  assert.strictEqual(pickup.estimated_price_max, null);
  assert.strictEqual(pickup.final_price, null);
  assert.strictEqual(pickup.tip_amount, null);

  const dumpster = db.dumpster_rentals.find((d) => d.booking_id === res.body.booking.id);
  assert.strictEqual(dumpster.pickup_booking_id, pickup.id, "dumpster_rentals.pickup_booking_id must be backfilled to the pickup's own id");
  assert.strictEqual(res.body.dumpster.pickupBookingId, pickup.id, "the create response must expose the linked pickup's id");
  assert.strictEqual(res.body.pickupError, null);
});

test("pickup date defaults to exactly 5 calendar days after delivery, and the pickup booking's own appointment_date mirrors it", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await createRental(db, cust);
  assert.strictEqual(res.body.dumpster.pickupDate, FUTURE_DELIVERY_PLUS_5_ISO);
  assert.strictEqual(res.body.dumpster.pickupDateIsManual, false);

  const pickup = findPickup(db, res.body.booking.id);
  assert.strictEqual(pickup.appointment_date, FUTURE_DELIVERY_PLUS_5_ISO, "pickup booking's own appointment_date must mirror dumpster_rentals.pickup_date");
});

// Audit fix (2026-10-21): the auto-generated pickup used to ALWAYS carry
// time_window: null, exact_time: null, regardless of the rental's own
// delivery time — the pickup's Schedule card showed no time at all by
// default. It now preserves the rental's own time_window/exact_time at
// creation (a one-time copy, never re-synced afterward — see
// ensurePickupBooking()'s own comment in api/admin/booking.js), so the
// pickup leg genuinely "preserves the relevant scheduled time/window" as
// the business expects, unless/until something later sets the pickup's
// own time directly.
test("the auto-generated pickup preserves the rental's own time_window at creation, instead of always null/null", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await createRental(db, cust, { timeWindow: "w_0800_1000" });
  const pickup = findPickup(db, res.body.booking.id);
  assert.strictEqual(pickup.time_window, "w_0800_1000", "the pickup must mirror the rental's own delivery time window, not default to null");
  assert.strictEqual(pickup.exact_time, null);
});

test("the auto-generated pickup preserves the rental's own exact_time (not a time window) at creation", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await createRental(db, cust, { timeWindow: undefined, exactTime: "09:00" });
  const pickup = findPickup(db, res.body.booking.id);
  assert.strictEqual(pickup.exact_time, "09:00", "the pickup must mirror the rental's own exact delivery time");
  assert.strictEqual(pickup.time_window, null);
});

// =======================================================================
// Audit fix (2026-10-21) — literal cross-month/cross-year/DST test cases,
// exactly as specified in the bug report, rather than only the relative-
// to-"today" FUTURE_DELIVERY_PLUS_5_ISO cases above. "Past Job" mode
// (mode: "past") is used for a delivery date on/before today (the
// HISTORICAL_FLOOR_ISO = 2026-01-01 floor still applies); "new" mode is
// used for a delivery date in the future — the +5-day arithmetic under
// test (addDaysIso()) is identical in both modes.
// =======================================================================
test("literal case 1: delivery Oct 20, 2026 -> pickup Oct 25, 2026 (the exact dates from the confirmed production bug report)", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await createRental(db, cust, { mode: "past", appointmentDate: "2026-10-20" });
  assert.strictEqual(res.body.dumpster.pickupDate, "2026-10-25");
  const pickup = findPickup(db, res.body.booking.id);
  assert.strictEqual(pickup.appointment_date, "2026-10-25");
});

test("literal case 2: delivery Oct 30, 2026 -> pickup Nov 4, 2026 (cross-month boundary)", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await createRental(db, cust, { appointmentDate: "2026-10-30" });
  assert.strictEqual(res.body.dumpster.pickupDate, "2026-11-04");
  const pickup = findPickup(db, res.body.booking.id);
  assert.strictEqual(pickup.appointment_date, "2026-11-04");
});

test("literal case 3: delivery Dec 29, 2026 -> pickup Jan 3, 2027 (cross-year boundary)", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await createRental(db, cust, { appointmentDate: "2026-12-29" });
  assert.strictEqual(res.body.dumpster.pickupDate, "2027-01-03");
  const pickup = findPickup(db, res.body.booking.id);
  assert.strictEqual(pickup.appointment_date, "2027-01-03");
});

test("literal case 4: delivery Oct 29, 2026 -> pickup Nov 3, 2026, spanning America/Denver's Nov 1, 2026 DST 'fall back' transition — the local calendar date stays exactly +5 days, never shifted by an hour/day", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const res = await createRental(db, cust, { appointmentDate: "2026-10-29" });
  assert.strictEqual(res.body.dumpster.pickupDate, "2026-11-03");
  const pickup = findPickup(db, res.body.booking.id);
  assert.strictEqual(pickup.appointment_date, "2026-11-03");
});

test("same client/address/rental context is carried onto the pickup booking", async () => {
  const cust = makeCustomer({ first_name: "Pat", last_name: "Lee" });
  const db = freshDb({ customers: [cust] });
  const res = await createRental(db, cust, { serviceAddress: { address: "900 Elm Ct", city: "Aurora", state: "CO", zip: "80010" } });
  const pickup = findPickup(db, res.body.booking.id);
  assert.strictEqual(pickup.customer_id, cust.id);
  assert.strictEqual(pickup.service_address, "900 Elm Ct");
  assert.strictEqual(pickup.service_city, "Aurora");
  assert.strictEqual(pickup.service_state, "CO");
  assert.strictEqual(pickup.service_zip, "80010");
});

// =======================================================================
// 2. Manual pickup-date override
// =======================================================================
test("an explicit manual pickupDate at create time is respected, and the pickup booking mirrors that exact date (not delivery+5)", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const manualPickup = addDaysIso(FUTURE_DELIVERY_ISO, 12);
  const res = await createRental(db, cust, { pickupDate: manualPickup });
  assert.strictEqual(res.body.dumpster.pickupDate, manualPickup);
  assert.strictEqual(res.body.dumpster.pickupDateIsManual, true);
  const pickup = findPickup(db, res.body.booking.id);
  assert.strictEqual(pickup.appointment_date, manualPickup);
});

// =======================================================================
// 3. Editing delivery date while auto-managed updates the pickup
// =======================================================================
test("editing the rental's delivery date while pickup is still auto-managed recomputes pickup_date AND updates the pickup booking's own date", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;

  const newDelivery = addDaysIso(FUTURE_DELIVERY_ISO, 10);
  const updateRes = await callBooking(db, {
    method: "PATCH",
    body: {
      id: rentalId,
      updatedAt: await getUpdatedAt(db, rentalId),
      serviceType: "dumpster_rental",
      appointmentDate: newDelivery,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
      pickupDateManual: false,
    },
  });
  assert.strictEqual(updateRes.statusCode, 200, JSON.stringify(updateRes.body));
  const expectedNewPickup = addDaysIso(newDelivery, 5);
  assert.strictEqual(updateRes.body.dumpster.pickupDate, expectedNewPickup);
  assert.strictEqual(updateRes.body.dumpster.pickupDateIsManual, false);

  const pickup = findPickup(db, rentalId);
  assert.strictEqual(pickup.appointment_date, expectedNewPickup, "pickup booking's date must follow the recomputed pickup_date");

  // Still exactly one pickup — editing never creates a second one.
  assert.strictEqual(db.bookings.filter((b) => b.service_type === "dumpster_pickup").length, 1);
});

test("manual pickup-date override stays respected (sticky) across an Edit Job save, even when delivery date also changes", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const manualPickup = addDaysIso(FUTURE_DELIVERY_ISO, 20);
  const createRes = await createRental(db, cust, { pickupDate: manualPickup });
  const rentalId = createRes.body.booking.id;

  const newDelivery = addDaysIso(FUTURE_DELIVERY_ISO, 3);
  const updateRes = await callBooking(db, {
    method: "PATCH",
    body: {
      id: rentalId,
      updatedAt: await getUpdatedAt(db, rentalId),
      serviceType: "dumpster_rental",
      appointmentDate: newDelivery,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
      pickupDateManual: true,
      pickupDate: manualPickup,
    },
  });
  assert.strictEqual(updateRes.statusCode, 200, JSON.stringify(updateRes.body));
  assert.strictEqual(updateRes.body.dumpster.pickupDate, manualPickup, "manual pickup date must not be recomputed to delivery+5");
  assert.strictEqual(updateRes.body.dumpster.pickupDateIsManual, true);

  const pickup = findPickup(db, rentalId);
  assert.strictEqual(pickup.appointment_date, manualPickup);
});

// =======================================================================
// 4. Repeated save/retry cannot create duplicate pickup jobs
// =======================================================================
test("saving Edit Job twice in a row (retry/double-click) never creates a second pickup booking", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;

  function body(updatedAt) {
    return {
      id: rentalId,
      updatedAt: updatedAt,
      serviceType: "dumpster_rental",
      appointmentDate: FUTURE_DELIVERY_ISO,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
      pickupDateManual: false,
    };
  }
  // Two genuine, independently-tokened saves in a row (e.g. the admin
  // reloads Edit Job and saves again) — not a literal double-submit of one
  // stale request, which the PRE-EXISTING optimistic-concurrency guard
  // (unrelated to this feature) would already correctly 409 on its own.
  const r1 = await callBooking(db, { method: "PATCH", body: body(await getUpdatedAt(db, rentalId)) });
  assert.strictEqual(r1.statusCode, 200, JSON.stringify(r1.body));
  const r2 = await callBooking(db, { method: "PATCH", body: body(await getUpdatedAt(db, rentalId)) });
  assert.strictEqual(r2.statusCode, 200, JSON.stringify(r2.body));

  assert.strictEqual(db.bookings.filter((b) => b.service_type === "dumpster_pickup").length, 1, "two saves of the same edit must never produce two pickups");
  assert.strictEqual(r1.body.dumpster.pickupBookingId, r2.body.dumpster.pickupBookingId, "both saves must resolve to the exact same pickup booking id");
});

test("self-healing: a pickup booking that already exists via lineage, but whose dumpster_rentals.pickup_booking_id link is missing, is reused and backfilled — never duplicated", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;
  const existingPickup = findPickup(db, rentalId);

  // Simulate a prior attempt that created the pickup booking but crashed
  // before the dumpster_rentals.pickup_booking_id backfill ever ran.
  const dumpster = db.dumpster_rentals.find((d) => d.booking_id === rentalId);
  dumpster.pickup_booking_id = null;

  const updateRes = await callBooking(db, {
    method: "PATCH",
    body: {
      id: rentalId,
      updatedAt: await getUpdatedAt(db, rentalId),
      serviceType: "dumpster_rental",
      appointmentDate: FUTURE_DELIVERY_ISO,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
      pickupDateManual: false,
    },
  });
  assert.strictEqual(updateRes.statusCode, 200, JSON.stringify(updateRes.body));
  assert.strictEqual(db.bookings.filter((b) => b.service_type === "dumpster_pickup").length, 1, "the existing pickup must be reused, never duplicated");
  assert.strictEqual(updateRes.body.dumpster.pickupBookingId, existingPickup.id, "the backfilled link must point at the pre-existing pickup, not a new one");
  const freshDumpster = db.dumpster_rentals.find((d) => d.booking_id === rentalId);
  assert.strictEqual(freshDumpster.pickup_booking_id, existingPickup.id, "dumpster_rentals.pickup_booking_id must be backfilled");
});

// =======================================================================
// 5. Cancellation propagates to an unfinished pickup
// =======================================================================
test("marking the rental 'lost' (cancellation) propagates to its still-open pickup", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;
  const pickup = findPickup(db, rentalId);

  const statusRes = await callBooking(db, { method: "PATCH", query: { resource: "status" }, body: { id: rentalId, status: "lost" } });
  assert.strictEqual(statusRes.statusCode, 200, JSON.stringify(statusRes.body));

  const freshPickup = db.bookings.find((b) => b.id === pickup.id);
  assert.strictEqual(freshPickup.status, "lost", "an unfinished pickup must be cancelled alongside its rental");
});

test("completed pickup protection: cancelling the rental AFTER its pickup is already completed never reopens/changes the completed pickup", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;
  const pickup = findPickup(db, rentalId);

  const completePickupRes = await callBooking(db, { method: "PATCH", query: { resource: "status" }, body: { id: pickup.id, status: "completed" } });
  assert.strictEqual(completePickupRes.statusCode, 200, JSON.stringify(completePickupRes.body));

  const cancelRentalRes = await callBooking(db, { method: "PATCH", query: { resource: "status" }, body: { id: rentalId, status: "lost" } });
  assert.strictEqual(cancelRentalRes.statusCode, 200, JSON.stringify(cancelRentalRes.body));

  const freshPickup = db.bookings.find((b) => b.id === pickup.id);
  assert.strictEqual(freshPickup.status, "completed", "a completed pickup must never be retroactively reverted to lost");
});

test("completed pickup protection: a later delivery-date change never rewrites an already-completed pickup's own appointment_date", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;
  const pickup = findPickup(db, rentalId);
  const originalPickupDate = pickup.appointment_date;

  const completePickupRes = await callBooking(db, { method: "PATCH", query: { resource: "status" }, body: { id: pickup.id, status: "completed" } });
  assert.strictEqual(completePickupRes.statusCode, 200);

  const newDelivery = addDaysIso(FUTURE_DELIVERY_ISO, 15);
  const updateRes = await callBooking(db, {
    method: "PATCH",
    body: {
      id: rentalId,
      updatedAt: await getUpdatedAt(db, rentalId),
      serviceType: "dumpster_rental",
      appointmentDate: newDelivery,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
      pickupDateManual: false,
    },
  });
  assert.strictEqual(updateRes.statusCode, 200, JSON.stringify(updateRes.body));
  // dumpster_rentals.pickup_date itself DOES keep following the delivery
  // date (it's just a data field, always current) — only the already-
  // completed pickup JOB's own appointment_date must stay frozen.
  assert.strictEqual(updateRes.body.dumpster.pickupDate, addDaysIso(newDelivery, 5));

  const freshPickup = db.bookings.find((b) => b.id === pickup.id);
  assert.strictEqual(freshPickup.appointment_date, originalPickupDate, "a completed pickup's own appointment_date must never be retroactively altered");
  assert.strictEqual(freshPickup.status, "completed");
});

// =======================================================================
// 6. Archive/restore propagation
// =======================================================================
test("archiving the rental propagates to its pickup booking", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;
  const pickup = findPickup(db, rentalId);

  const archiveRes = await callBooking(db, {
    method: "PATCH",
    query: { resource: "archive" },
    body: { id: rentalId, action: "archive", reason: "client_canceled" },
  });
  assert.strictEqual(archiveRes.statusCode, 200, JSON.stringify(archiveRes.body));

  const freshPickup = db.bookings.find((b) => b.id === pickup.id);
  assert.ok(freshPickup.archived_at, "pickup must be archived alongside its rental");
  assert.strictEqual(freshPickup.archived_reason, "client_canceled");
  assert.strictEqual(freshPickup.archived_by, ADMIN_EMAIL);
});

test("restoring the rental propagates to its pickup booking", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;
  const pickup = findPickup(db, rentalId);

  await callBooking(db, { method: "PATCH", query: { resource: "archive" }, body: { id: rentalId, action: "archive", reason: "client_canceled" } });
  const restoreRes = await callBooking(db, { method: "PATCH", query: { resource: "archive" }, body: { id: rentalId, action: "restore" } });
  assert.strictEqual(restoreRes.statusCode, 200, JSON.stringify(restoreRes.body));

  const freshPickup = db.bookings.find((b) => b.id === pickup.id);
  assert.strictEqual(freshPickup.archived_at, null, "pickup must be restored alongside its rental");
});

// =======================================================================
// 7. Defense in depth — a pickup booking carries no price/revenue fields
// =======================================================================
test("a pickup booking cannot be edited directly via the full Edit Job form", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const pickup = findPickup(db, createRes.body.booking.id);

  const res = await callBooking(db, {
    method: "PATCH",
    body: {
      id: pickup.id,
      updatedAt: null,
      serviceType: "junk_removal",
      appointmentDate: FUTURE_DELIVERY_ISO,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
    },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/managed automatically/i.test(res.body.error));
});

test("a job-payments POST against a pickup booking is rejected", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const pickup = findPickup(db, createRes.body.booking.id);
  await callBooking(db, { method: "PATCH", query: { resource: "status" }, body: { id: pickup.id, status: "completed" } });

  const res = await callBooking(db, {
    method: "POST",
    query: { resource: "job-payments" },
    body: { bookingId: pickup.id, amount: 50, paymentMethod: "cash" },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.job_payments.length, 0, "no job_payments row may ever be created for a pickup booking");
});

test("a tip PATCH against a pickup booking is rejected", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const pickup = findPickup(db, createRes.body.booking.id);
  await callBooking(db, { method: "PATCH", query: { resource: "status" }, body: { id: pickup.id, status: "completed" } });

  const res = await callBooking(db, { method: "PATCH", query: { resource: "tip" }, body: { id: pickup.id, tipAmount: 10 } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.find((b) => b.id === pickup.id).tip_amount, null);
});

// =======================================================================
// 8. Public booking API must never accept dumpster_pickup
// =======================================================================
test("api/book.js's public SERVICE_TYPES never includes dumpster_pickup", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "book.js"), "utf8");
  const m = /const SERVICE_TYPES = (\[[^\]]*\]);/.exec(src);
  assert.ok(m, "api/book.js must define a literal SERVICE_TYPES array");
  const arr = JSON.parse(m[1].replace(/'/g, '"'));
  assert.deepStrictEqual(arr, ["junk_removal", "dumpster_rental", "light_demo"]);
});

test("the admin API itself also rejects dumpster_pickup as a submitted serviceType, even on Create", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  adminAuthed();
  const res = await callBooking(db, { method: "POST", body: rentalBody({ customerId: cust.id, serviceType: "dumpster_pickup" }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

// =======================================================================
// 9. Dashboard/job/revenue/lead metrics exclude dumpster_pickup
// =======================================================================
test("business metrics increase by exactly 1 job when a dumpster rental (and its auto-pickup) is created", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  await createRental(db, cust);
  assert.strictEqual(db.bookings.length, 2, "sanity: 2 rows exist (rental + pickup)");

  const countsRes = await callBookings(db, { query: { countsOnly: "1" } });
  assert.strictEqual(countsRes.statusCode, 200, JSON.stringify(countsRes.body));
  assert.strictEqual(countsRes.body.summary.total, 1, "total job count must be exactly 1, not 2");
  assert.strictEqual(countsRes.body.summary.booked, 1, "booked job count must be exactly 1, not 2");
});

test("booked revenue increases only by the primary rental amount, never doubled by the pickup", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  await createRental(db, cust, { estimatedPrice: 349 });
  const countsRes = await callBookings(db, { query: { countsOnly: "1" } });
  assert.strictEqual(countsRes.body.summary.booked, 1);
  // The pickup itself can never carry a price (enforced at creation — see
  // test #1 above), so there is no separate "booked revenue" field to
  // double here; this just reconfirms the booked COUNT stays 1 even with
  // a real quoted amount on the rental.
});

test("completing the pickup does not increment the completed-job count a second time", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;
  const pickup = findPickup(db, rentalId);

  await callBooking(db, { method: "PATCH", query: { resource: "status" }, body: { id: rentalId, status: "completed" } });
  await callBooking(db, { method: "PATCH", query: { resource: "status" }, body: { id: pickup.id, status: "completed" } });

  const countsRes = await callBookings(db, { query: { countsOnly: "1" } });
  assert.strictEqual(countsRes.body.summary.completed, 1, "completed count must stay 1 even after the pickup is ALSO marked completed");
  assert.strictEqual(countsRes.body.summary.total, 1);
});

test("the Requests/dashboard booking list never shows the pickup as its own row", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const listRes = await callBookings(db, { query: {} });
  assert.strictEqual(listRes.statusCode, 200, JSON.stringify(listRes.body));
  assert.strictEqual(listRes.body.bookings.length, 1);
  assert.strictEqual(listRes.body.bookings[0].id, createRes.body.booking.id);
});

test("analytics/source conversion (Leads 'Booked/Won' bucket) still sees exactly one converted job per rental", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  await createRental(db, cust);
  const leadsRes = await callBookings(db, { query: { view: "leads" } });
  assert.strictEqual(leadsRes.statusCode, 200, JSON.stringify(leadsRes.body));
  assert.strictEqual(leadsRes.body.sections.bookedWon.length, 1, "the pickup must never appear as a second converted/booked entry");
});

test("client lifetime job count (Clients list) excludes the pickup — one rental counts as exactly one job on file", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  await createRental(db, cust);
  const listRes = await callClient(db, { query: { resource: "list" } });
  assert.strictEqual(listRes.statusCode, 200, JSON.stringify(listRes.body));
  const row = listRes.body.clients.find((c) => c.id === cust.id);
  assert.ok(row, "the client must appear in the list");
  assert.strictEqual(row.bookingCount, 1, "bookingCount must represent paid jobs, excluding the auto-generated pickup");
});

// =======================================================================
// 10. Schedule still shows the pickup as its own operational appointment
// =======================================================================
test("Schedule shows 2 distinct operational appointments — delivery on its own date, pickup on its own date, 5 days later", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);

  const deliveryDayRes = await callBookings(db, { query: { view: "schedule", range: "day", date: FUTURE_DELIVERY_ISO } });
  assert.strictEqual(deliveryDayRes.statusCode, 200, JSON.stringify(deliveryDayRes.body));
  assert.strictEqual(deliveryDayRes.body.jobs.length, 1);
  assert.strictEqual(deliveryDayRes.body.jobs[0].serviceType, "dumpster_rental");

  const pickupDayRes = await callBookings(db, { query: { view: "schedule", range: "day", date: FUTURE_DELIVERY_PLUS_5_ISO } });
  assert.strictEqual(pickupDayRes.statusCode, 200, JSON.stringify(pickupDayRes.body));
  assert.strictEqual(pickupDayRes.body.jobs.length, 1);
  assert.strictEqual(pickupDayRes.body.jobs[0].serviceType, "dumpster_pickup");
  assert.strictEqual(pickupDayRes.body.jobs[0].serviceLabel, "Dumpster Pickup", "the pickup must render distinctly from the rental's own service label");
  assert.strictEqual(pickupDayRes.body.jobs[0].estimatedPrice, null);
  assert.strictEqual(pickupDayRes.body.jobs[0].finalPrice, null);

  void createRes;
});

// =======================================================================
// 11. Direct junk-removal bookings are completely unaffected
// =======================================================================
test("a direct junk_removal booking creates no dumpster_rentals row and no pickup job", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  adminAuthed();
  const res = await callBooking(db, {
    method: "POST",
    body: {
      mode: "new",
      serviceType: "junk_removal",
      appointmentDate: FUTURE_DELIVERY_ISO,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
      customerId: cust.id,
    },
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.dumpster, null);
  assert.strictEqual(res.body.pickupError, null);
  assert.strictEqual(db.bookings.length, 1, "no phantom pickup for a non-dumpster-rental booking");
  assert.strictEqual(db.dumpster_rentals.length, 0);
});

// =======================================================================
// 12. Dumpster rental pricing/payment logic unchanged
// =======================================================================
test("api/_lib/rental-pricing.js constants are byte-for-byte unchanged by this stage", () => {
  const rentalPricing = require("../api/_lib/rental-pricing");
  assert.strictEqual(rentalPricing.BASE_RATE, 349.0);
  assert.strictEqual(rentalPricing.INCLUDED_DAYS, 5);
  assert.strictEqual(rentalPricing.INCLUDED_TONS, 2);
  assert.strictEqual(rentalPricing.OVERAGE_TON_RATE, 125.0);
  assert.strictEqual(rentalPricing.OVERAGE_DAY_RATE, 15.0);
  assert.strictEqual(rentalPricing.RENTAL_AGREEMENT_VERSION, "2026-09-18-v2");
});

// Audit fix (2026-10-21): api/admin/booking.js's own DEFAULT_RENTAL_DAYS
// used to be an independent hardcoded `5`, with nothing enforcing it ever
// stayed in sync with rental-pricing.js's own INCLUDED_DAYS — two "5"s
// that happened to agree, not one. It is now literally derived from that
// same constant (rentalPricing.INCLUDED_DAYS), checked here via the
// actual pickup-date-default BEHAVIOR (not just a source-text grep),
// since the real risk this closes is "someone later changes the business
// policy in rental-pricing.js and the pickup default silently keeps
// using the old number."
test("the auto-pickup's +5-day default is driven by rental-pricing.js's INCLUDED_DAYS, not an independent constant — changing one changes the other", () => {
  const rentalPricing = require("../api/_lib/rental-pricing");
  const bookingModuleSrc = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "booking.js"), "utf8");
  assert.ok(/const DEFAULT_RENTAL_DAYS = rentalPricing\.INCLUDED_DAYS;/.test(bookingModuleSrc), "DEFAULT_RENTAL_DAYS must be derived from rentalPricing.INCLUDED_DAYS, not its own separate literal");
  assert.strictEqual(rentalPricing.INCLUDED_DAYS, 5, "sanity check — today's actual policy value, so the behavioral test above (+5 days) stays meaningful");
});

test("a normal payment + tip flow on the RENTAL booking itself (not the pickup) still works exactly as before", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;

  const completeRes = await callBooking(db, { method: "PATCH", query: { resource: "status" }, body: { id: rentalId, status: "completed" } });
  assert.strictEqual(completeRes.statusCode, 200, JSON.stringify(completeRes.body));

  const paymentRes = await callBooking(db, {
    method: "POST",
    query: { resource: "job-payments" },
    body: { bookingId: rentalId, amount: 349, paymentMethod: "cash" },
  });
  assert.strictEqual(paymentRes.statusCode, 200, JSON.stringify(paymentRes.body));
  assert.strictEqual(db.job_payments.length, 1);
  assert.strictEqual(db.job_payments[0].booking_id, rentalId);

  const tipRes = await callBooking(db, { method: "PATCH", query: { resource: "tip" }, body: { id: rentalId, tipAmount: 25 } });
  assert.strictEqual(tipRes.statusCode, 200, JSON.stringify(tipRes.body));
  assert.strictEqual(db.bookings.find((b) => b.id === rentalId).tip_amount, 25);
});

// =======================================================================
// 13. Client-side static-source guards — same convention this codebase
// already uses elsewhere (phase3c-schedule.test.js, phase3c-stage2.4.1-
// schedule-ux.test.js) for verifying DOM-manipulating admin scripts
// without a real browser: regex assertions against the source text.
// =======================================================================
function read(rel) { return fs.readFileSync(path.join(__dirname, "..", rel), "utf8"); }

test("admin/schedule-financials.js excludes dumpster_pickup from Revenue/Booked/Complimentary", () => {
  const src = read("admin/schedule-financials.js");
  assert.ok(/function isCountableJob\(job\)/.test(src));
  assert.ok(/serviceType !== 'dumpster_pickup'/.test(src));
  assert.ok(/if \(!isCountableJob\(job\)\) return;/.test(src), "computeFromJobs() must skip a pickup job before summing revenue/booked");
});

test("admin/home.js excludes dumpster_pickup from every dashboard summary stat", () => {
  const src = read("admin/home.js");
  assert.ok(/function isCountableJob\(job\)/.test(src));
  assert.ok(/countableTodayJobs = todayJobs\.filter\(isCountableJob\)/.test(src));
  assert.ok(/isCountableJob\(j\) && \(j\.status === 'booked' \|\| j\.status === 'rental_out'\)/.test(src));
  assert.ok(/isCountableJob\(j\) && j\.status === 'completed'/.test(src));
});

test("admin/calendar-views.js excludes dumpster_pickup from the Week/Month count badges, while still rendering it as a card/line", () => {
  const src = read("admin/calendar-views.js");
  assert.ok(/function isCountableJob\(job\)/.test(src));
  assert.ok(/countableJobs = jobs\.filter\(isCountableJob\)/.test(src));
});

test("admin/client-detail.js's \"jobs on file\" count excludes dumpster_pickup while still listing it as a job card", () => {
  const src = read("admin/client-detail.js");
  assert.ok(/currentCountableJobCount = bookings\.filter\(function \(b\) \{ return b\.serviceType !== 'dumpster_pickup'; \}\)\.length;/.test(src));
});

test("admin/job-closeout.js hides Payment/Tip for a pickup job's own completion", () => {
  const src = read("admin/job-closeout.js");
  assert.ok(/isPickup = opts\.serviceType === 'dumpster_pickup'/.test(src));
  assert.ok(/if \(!isPickup\) \{/.test(src));
});

test("admin/schedule.js and admin/booking-detail.js both pass serviceType through to the shared closeout sheet", () => {
  const scheduleSrc = read("admin/schedule.js");
  const detailSrc = read("admin/booking-detail.js");
  assert.ok(/serviceType: job\.serviceType,/.test(scheduleSrc));
  assert.ok(/serviceType: currentServiceType,/.test(detailSrc));
});

// =======================================================================
// 14. Migration content — static guard, same convention as
// tests/phase3c-dumpster-rental-admin.test.js's own migration-content test.
// =======================================================================
test("sql migration: both new columns exist with their partial UNIQUE indexes", () => {
  const src = read("sql/2026-10-18_phase4-stage1-dumpster-pickup-auto-job.sql");
  assert.ok(/ADD COLUMN IF NOT EXISTS source_rental_booking_id uuid NULL REFERENCES public\.bookings\(id\);/.test(src));
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS bookings_source_rental_booking_id_uniq[\s\S]*WHERE source_rental_booking_id IS NOT NULL;/.test(src));
  assert.ok(/ADD COLUMN IF NOT EXISTS pickup_booking_id uuid NULL REFERENCES public\.bookings\(id\);/.test(src));
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS dumpster_rentals_pickup_booking_id_uniq[\s\S]*WHERE pickup_booking_id IS NOT NULL;/.test(src));
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
