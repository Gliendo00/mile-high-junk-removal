// Local, offline test harness for the Phase 4 Stage 1 hardening pass —
// (1) a dumpster_rental with a linked pickup can no longer be freely
// switched to another service_type while the rental is still active, and
// (2) a re-confirmation that Month/Tomorrow schedule metrics still
// correctly exclude a rental's auto-generated pickup after rebasing onto
// origin/main's 3 (agent-log-only) commits.
//
// Same approach/harness as tests/phase4-stage1-dumpster-pickup-auto-job.test.js
// — duplicated here (not shared) on purpose, matching this codebase's own
// established "one independent FakeQueryBuilder per test file, no shared
// fixture" convention (confirmed across all 32 pre-existing test files
// that mock @supabase/supabase-js).
//
// Run with:  node tests/phase4-stage1-hardening.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

let nextId = 1;
function makeId() {
  return "aaaaaaaa-aaaa-aaaa-aaaa-" + String(200000000000 + nextId++).padStart(12, "0");
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
const FUTURE_DELIVERY_ISO = addDaysIso(TODAY_ISO, 30);
const FUTURE_DELIVERY_PLUS_5_ISO = addDaysIso(FUTURE_DELIVERY_ISO, 5);

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
  is(col, val) { this._filters.push((r) => (r[col] === undefined ? null : r[col]) === val); return this; }
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
async function getUpdatedAt(db, id) {
  const r = await callBooking(db, { method: "GET", query: { id } });
  assert.strictEqual(r.statusCode, 200, "GET booking detail failed: " + JSON.stringify(r.body));
  return r.body.booking.updatedAt;
}

const registered = [];
function test(name, fn) { registered.push({ name, fn }); }

// =======================================================================
// Service-type orphan prevention
// =======================================================================
test("changing service_type away from dumpster_rental is BLOCKED while an active rental still has a linked pickup", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;
  const pickup = findPickup(db, rentalId);

  const res = await callBooking(db, {
    method: "PATCH",
    body: {
      id: rentalId,
      updatedAt: await getUpdatedAt(db, rentalId),
      serviceType: "junk_removal",
      appointmentDate: FUTURE_DELIVERY_ISO,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
    },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/linked pickup job/i.test(res.body.error));

  // Nothing changed — not silently deleted, not silently orphaned.
  const freshRental = db.bookings.find((b) => b.id === rentalId);
  assert.strictEqual(freshRental.service_type, "dumpster_rental");
  const freshPickup = db.bookings.find((b) => b.id === pickup.id);
  assert.strictEqual(freshPickup.status, "booked");
  assert.strictEqual(freshPickup.source_rental_booking_id, rentalId);
});

test("changing service_type away from dumpster_rental is ALLOWED once the rental has been cancelled ('lost') first", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;

  const cancelRes = await callBooking(db, { method: "PATCH", query: { resource: "status" }, body: { id: rentalId, status: "lost" } });
  assert.strictEqual(cancelRes.statusCode, 200, JSON.stringify(cancelRes.body));

  const res = await callBooking(db, {
    method: "PATCH",
    body: {
      id: rentalId,
      updatedAt: await getUpdatedAt(db, rentalId),
      serviceType: "junk_removal",
      appointmentDate: FUTURE_DELIVERY_ISO,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
    },
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings.find((b) => b.id === rentalId).service_type, "junk_removal");
});

test("changing service_type away from dumpster_rental is ALLOWED once the rental has been archived first", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;

  const archiveRes = await callBooking(db, { method: "PATCH", query: { resource: "archive" }, body: { id: rentalId, action: "archive", reason: "client_canceled" } });
  assert.strictEqual(archiveRes.statusCode, 200, JSON.stringify(archiveRes.body));

  const res = await callBooking(db, {
    method: "PATCH",
    body: {
      id: rentalId,
      updatedAt: await getUpdatedAt(db, rentalId),
      serviceType: "light_demo",
      appointmentDate: FUTURE_DELIVERY_ISO,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
    },
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(db.bookings.find((b) => b.id === rentalId).service_type, "light_demo");
});

test("a completed pickup is never retroactively altered by the orphan-prevention block itself (the block only ever refuses the rental's edit)", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;
  const pickup = findPickup(db, rentalId);
  await callBooking(db, { method: "PATCH", query: { resource: "status" }, body: { id: pickup.id, status: "completed" } });

  const res = await callBooking(db, {
    method: "PATCH",
    body: {
      id: rentalId,
      updatedAt: await getUpdatedAt(db, rentalId),
      serviceType: "junk_removal",
      appointmentDate: FUTURE_DELIVERY_ISO,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
    },
  });
  assert.strictEqual(res.statusCode, 400, "a completed pickup existing is not itself a carve-out — the rental must still be cancelled/archived first");
  const freshPickup = db.bookings.find((b) => b.id === pickup.id);
  assert.strictEqual(freshPickup.status, "completed");
  assert.strictEqual(freshPickup.appointment_date, pickup.appointment_date);
});

test("editing a dumpster_rental's OTHER fields (not service_type) is completely unaffected by the orphan guard", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const createRes = await createRental(db, cust);
  const rentalId = createRes.body.booking.id;

  const res = await callBooking(db, {
    method: "PATCH",
    body: {
      id: rentalId,
      updatedAt: await getUpdatedAt(db, rentalId),
      serviceType: "dumpster_rental",
      appointmentDate: FUTURE_DELIVERY_ISO,
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "1 Main St", city: "Denver", state: "CO", zip: "80202" },
      description: "Updated description, same service type",
      pickupDateManual: false,
    },
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.booking.description, "Updated description, same service type");
});

// =======================================================================
// Reconfirm Day/Tomorrow/Week/Month metrics after the origin/main rebase
// =======================================================================
test("Month view: jobCountsByDate excludes the pickup's date, while the day's own `jobs` array still carries it for the day panel", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  await createRental(db, cust);

  const year = Number(FUTURE_DELIVERY_PLUS_5_ISO.slice(0, 4));
  const month = Number(FUTURE_DELIVERY_PLUS_5_ISO.slice(5, 7));
  const monthRes = await callBookings(db, { query: { view: "schedule", range: "month", year: String(year), month: String(month) } });
  assert.strictEqual(monthRes.statusCode, 200, JSON.stringify(monthRes.body));

  const pickupDayCount = monthRes.body.jobCountsByDate[FUTURE_DELIVERY_PLUS_5_ISO] || 0;
  assert.strictEqual(pickupDayCount, 0, "the pickup's own day must not be counted as a business job total");

  const pickupJobInMonth = monthRes.body.jobs.find((j) => j.serviceType === "dumpster_pickup");
  assert.ok(pickupJobInMonth, "the pickup must still be present in the raw jobs array the day panel renders from");
  assert.strictEqual(pickupJobInMonth.appointmentDate, FUTURE_DELIVERY_PLUS_5_ISO);
});

test("Tomorrow view: a rental delivered tomorrow shows exactly 1 job (its pickup, 5 days later, is not 'tomorrow')", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  const tomorrow = addDaysIso(TODAY_ISO, 1);
  await createRental(db, cust, { appointmentDate: tomorrow });

  const res = await callBookings(db, { query: { view: "schedule", range: "tomorrow" } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.jobs.length, 1);
  assert.strictEqual(res.body.jobs[0].serviceType, "dumpster_rental");
});

test("business metrics are still exactly correct post-rebase: 1 total, 1 booked, 1 bookedWon lead-conversion entry, 1 client job-on-file count", async () => {
  const cust = makeCustomer();
  const db = freshDb({ customers: [cust] });
  await createRental(db, cust);

  const countsRes = await callBookings(db, { query: { countsOnly: "1" } });
  assert.strictEqual(countsRes.body.summary.total, 1);
  assert.strictEqual(countsRes.body.summary.booked, 1);

  const leadsRes = await callBookings(db, { query: { view: "leads" } });
  assert.strictEqual(leadsRes.body.sections.bookedWon.length, 1);
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
