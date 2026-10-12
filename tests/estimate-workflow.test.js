// Local, offline test harness for the Estimate workflow: LEAD -> ESTIMATE
// SCHEDULED -> ESTIMATE COMPLETED -> JOB BOOKED -> JOB COMPLETED, plus
// LEAD -> JOB direct and NEW ESTIMATE -> JOB. Covers:
//   - api/admin/booking.js's ?resource=estimate (GET/POST/PATCH) and the
//     sourceLeadId/sourceEstimateId handling added to handleCreate() (the
//     plain POST — "+ New Job"/Convert-to-Job/Book-Job-direct).
//   - api/admin/bookings.js's fetchScheduleEstimates() (merged into
//     ?view=schedule's response as a sibling `estimates` array).
//   - api/admin/lead.js's pipelineEstimate/pipelineBooking read-only
//     enrichment.
//   - Structural/source guarantees on the client side (admin/schedule.js,
//     admin/estimate-detail.js, admin/booking-new.js, admin/lead-detail.js,
//     admin.css) that can't be exercised without a real browser — financial
//     isolation, estimate/job visual distinction, and "estimate completion
//     never reaches job-closeout.js."
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project.
//
// Run with:  node tests/estimate-workflow.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase query builder — union of phase3c-job-editing.test.js's
// (insert/update/select/eq/is/in/order/maybeSingle/single) and
// phase3c-stage2.4-calendar.test.js's (gte/lte), plus limit() (used by
// api/admin/lead.js's pipeline enrichment).
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "eeeeeeee-eeee-eeee-eeee-" + String(900000000000 + nextId++).padStart(12, "0");
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
    this._updateData = null;
    this._limit = null;
  }
  select() {
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
  gte(field, val) {
    this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] >= val);
    return this;
  }
  lte(field, val) {
    this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] <= val);
    return this;
  }
  order(field, opts) {
    this._order = { field: field, ascending: !opts || opts.ascending !== false };
    return this;
  }
  limit(n) {
    this._limit = n;
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
    if (this._insertRow) {
      if (this._db.__insertError && this._db.__insertError[this._table]) {
        return { data: null, error: this._db.__insertError[this._table] };
      }
      const row = Object.assign({ id: makeId(), created_at: "2026-10-12T12:00:00Z", updated_at: null, updated_by: null }, this._insertRow);
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));

    if (this._updateData) {
      if (this._db.__updateError && this._db.__updateError[this._table]) {
        return { data: null, error: this._db.__updateError[this._table] };
      }
      filtered.forEach((row) => Object.assign(row, this._updateData));
    }

    if (this._order) {
      const field = this._order.field;
      const asc = this._order.ascending;
      filtered = filtered.slice().sort((a, b) => {
        if (a[field] < b[field]) return asc ? -1 : 1;
        if (a[field] > b[field]) return asc ? 1 : -1;
        return 0;
      });
    }
    if (this._limit !== null) filtered = filtered.slice(0, this._limit);

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
const bookingsHandler = require("../api/admin/bookings.js");
const leadHandler = require("../api/admin/lead.js");

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
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

const CUSTOMER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_CUSTOMER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const LEAD_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function freshDb() {
  return {
    customers: [
      { id: CUSTOMER_ID, first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", city: "Denver", created_at: "2026-01-01T10:00:00Z" },
      { id: OTHER_CUSTOMER_ID, first_name: "Someone", last_name: "Else", phone: "303-555-0200", email: "someone@example.com", city: "Denver", created_at: "2026-01-01T10:00:00Z" },
    ],
    leads: [
      { id: LEAD_ID, created_by: ADMIN_EMAIL, created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z", source: "manual", status: "new", first_name: "Jamie", last_name: "Rivera", matched_customer_id: CUSTOMER_ID, resulting_booking_id: null },
    ],
    estimates: [],
    bookings: [],
    dumpster_rentals: [],
  };
}

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function validEstimateBody(overrides) {
  return Object.assign(
    {
      customerId: CUSTOMER_ID,
      appointmentDate: futureDate(2),
      timeWindow: "w_0800_1000",
      serviceAddress: { address: "123 Main St", city: "Denver", state: "CO", zip: "80202" },
    },
    overrides || {}
  );
}

function postEstimate(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, query: { resource: "estimate" }, body: body }));
}
function patchEstimate(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "PATCH", cookie: cookie, query: { resource: "estimate" }, body: body }));
}
function getEstimate(db, cookie, id) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "GET", cookie: cookie, query: { resource: "estimate", id: id } }));
}
function postBooking(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, body: body }));
}
function getSchedule(db, cookie, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ method: "GET", cookie: cookie, query: Object.assign({ view: "schedule" }, query) }));
}
function getLead(db, cookie, id) {
  currentFakeService = createFakeServiceClient(db);
  return run(leadHandler, makeReq({ method: "GET", cookie: cookie, query: { id: id } }));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// PART A — Scheduling an estimate (independent, and from a Lead)
// =======================================================================

test("Independent New Estimate: creates a scheduled estimate with no lead linkage", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postEstimate(db, AUTH_COOKIE, validEstimateBody());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.estimate.status, "scheduled");
  assert.strictEqual(res.body.estimate.sourceLeadId, null);
  assert.strictEqual(db.estimates.length, 1);
  assert.strictEqual(db.bookings.length, 0, "scheduling an estimate must never create a bookings row");
});

test("Lead -> Schedule Estimate: carries sourceLeadId, preserves the original Lead untouched", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postEstimate(db, AUTH_COOKIE, validEstimateBody({ sourceLeadId: LEAD_ID }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.estimate.sourceLeadId, LEAD_ID);
  const lead = db.leads.find((l) => l.id === LEAD_ID);
  assert.strictEqual(lead.status, "new", "scheduling an estimate must never change the Lead's own status");
  assert.strictEqual(lead.resulting_booking_id, null);
  assert.strictEqual(db.leads.length, 1, "the Lead row itself is never deleted/replaced");
});

test("Schedule Estimate: rejects an unknown lead id (never silently links to nothing)", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postEstimate(db, AUTH_COOKIE, validEstimateBody({ sourceLeadId: "99999999-9999-9999-9999-999999999999" }));
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(db.estimates.length, 0);
});

test("New Estimate: requires a client, an address, and a date/time — rejects a bare request", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postEstimate(db, AUTH_COOKIE, {});
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.estimates.length, 0);
});

test("New Estimate: a quotedAmount is accepted and stored, purely informational", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postEstimate(db, AUTH_COOKIE, validEstimateBody({ quotedAmount: 350 }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.estimate.quotedAmount, 350);
});

// =======================================================================
// PART B — Estimate appears on Schedule, visually distinct, financially inert
// =======================================================================

test("Estimate appears on Schedule: merged into ?view=schedule as a sibling `estimates` array, never inside `jobs`", async () => {
  adminAuthed();
  const db = freshDb();
  const date = futureDate(3);
  db.estimates.push({
    id: makeId(), created_by: ADMIN_EMAIL, created_at: "2026-10-12T10:00:00Z", updated_at: "2026-10-12T10:00:00Z",
    status: "scheduled", customer_id: CUSTOMER_ID, source_lead_id: null, service_type: "junk_removal",
    appointment_date: date, time_window: "w_0800_1000", exact_time: null,
    service_address: "123 Main St", service_city: "Denver", service_state: "CO", service_zip: "80202",
    quoted_amount: 400,
  });
  const res = await getSchedule(db, AUTH_COOKIE, { range: "day", date: date });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobs.length, 0, "no job exists yet — jobs must stay empty");
  assert.strictEqual(res.body.estimates.length, 1);
  assert.strictEqual(res.body.estimates[0].status, "scheduled");
  assert.strictEqual(res.body.estimates[0].quotedAmount, 400);
});

test("Schedule: a cancelled/lost/converted estimate does not clutter the day view going forward", async () => {
  adminAuthed();
  const db = freshDb();
  const date = futureDate(3);
  ["cancelled", "lost", "converted"].forEach((status) => {
    db.estimates.push({
      id: makeId(), created_by: ADMIN_EMAIL, created_at: "2026-10-12T10:00:00Z", updated_at: "2026-10-12T10:00:00Z",
      status: status, customer_id: CUSTOMER_ID, source_lead_id: null, service_type: "junk_removal",
      appointment_date: date, time_window: "w_0800_1000", exact_time: null,
      service_address: "123 Main St", service_city: "Denver", service_state: "CO", service_zip: "80202", quoted_amount: null,
    });
  });
  const res = await getSchedule(db, AUTH_COOKIE, { range: "day", date: date });
  assert.strictEqual(res.body.estimates.length, 0);
});

test("admin/schedule.js: estimates are merged into the SAME rendered list as jobs (mergeJobsAndEstimates), never a separate calendar", () => {
  const src = read("admin/schedule.js");
  assert.ok(/function mergeJobsAndEstimates\(jobs, estimates\)/.test(src), "must expose a single merge point for jobs+estimates");
  assert.ok(/render\(mergeJobsAndEstimates\(body\.jobs, body\.estimates\)\)/.test(src), "applyDayResult() must render the merged list, not jobs alone");
});

test("admin/schedule.js: renderEstimateCard() is a distinct function from renderJobCard(), with its own ESTIMATE badge/class/detail link", () => {
  const src = read("admin/schedule.js");
  assert.ok(/function renderEstimateCard\(estimate\)/.test(src), "must have its own card renderer, not a parameterized job card");
  assert.ok(/admin-estimate-type-badge/.test(src), "must render a visible ESTIMATE type badge");
  assert.ok(/admin-schedule-card-estimate/.test(src), "must use a distinct card class from a job card");
  assert.ok(/\/admin\/estimate\/\?id=/.test(src), "an estimate card must open /admin/estimate/, never /admin/booking/");
});

test("admin.css: estimate card/badge/status classes exist, visually distinct from job status colors", () => {
  const css = read("admin/admin.css");
  assert.ok(/\.admin-schedule-card-estimate\s*\{/.test(css));
  assert.ok(/\.admin-estimate-type-badge\s*\{/.test(css));
  assert.ok(/\.admin-estimate-status-scheduled\s*\{/.test(css) || /\.admin-status-estimate-scheduled/.test(css));
});

test("Financial isolation: admin/schedule.js hands admin-schedule-financials.js only `body.jobs`, never the merged estimates list", () => {
  const src = read("admin/schedule.js");
  assert.ok(
    /window\.AdminScheduleFinancials\.show\(activeDateIso, activeDateIso, body\.jobs \|\| \[\]\)/.test(src),
    "Revenue/Booked/Net must be computed from body.jobs alone — an estimate must be structurally unreachable by this call"
  );
});

test("Financial isolation: estimates table has no revenue-shaped fields at all — mapEstimate() never exposes finalPrice/tipAmount/payment data", () => {
  const src = read("api/admin/booking.js");
  const mapFn = src.slice(src.indexOf("function mapEstimate("), src.indexOf("function mapEstimate(") + 1200);
  assert.ok(!/finalPrice|tipAmount|paymentMethod|collectedRevenue/.test(mapFn), "an estimate must never carry a job-shaped revenue/payment field");
});

test("Financial isolation: fetchScheduleEstimates() never reads/returns final_price, tip_amount, or any payment field", () => {
  const src = read("api/admin/bookings.js");
  const fn = src.slice(src.indexOf("async function fetchScheduleEstimates("), src.indexOf("async function fetchScheduleEstimates(") + 2500);
  assert.ok(!/final_price|tip_amount|job_payments/.test(fn));
});

// =======================================================================
// PART C — Lead -> Job direct (unaffected by the Estimate workflow)
// =======================================================================

test("Lead -> Job direct: Book Job without an estimate still works, marks the Lead booked", async () => {
  adminAuthed();
  const db = freshDb();
  const body = {
    customerId: CUSTOMER_ID,
    serviceType: "junk_removal",
    appointmentDate: futureDate(1),
    timeWindow: "w_0800_1000",
    serviceAddress: { address: "123 Main St", city: "Denver", state: "CO", zip: "80202" },
    sourceLeadId: LEAD_ID,
  };
  const res = await postBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.bookings[0].source_lead_id, LEAD_ID);
  assert.strictEqual(db.bookings[0].source_estimate_id, null);
  const lead = db.leads.find((l) => l.id === LEAD_ID);
  assert.strictEqual(lead.status, "booked");
  assert.strictEqual(lead.resulting_booking_id, db.bookings[0].id);
});

test("'+ New Job' with no sourceLeadId/sourceEstimateId is completely unaffected — zero new columns touched, zero lead/estimate writes attempted", async () => {
  adminAuthed();
  const db = freshDb();
  const body = {
    customerId: CUSTOMER_ID,
    serviceType: "junk_removal",
    appointmentDate: futureDate(1),
    timeWindow: "w_0800_1000",
    serviceAddress: { address: "123 Main St", city: "Denver", state: "CO", zip: "80202" },
  };
  const res = await postBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].source_lead_id, null);
  assert.strictEqual(db.bookings[0].source_estimate_id, null);
  assert.strictEqual(res.body.estimateUpdateError, null);
  assert.strictEqual(res.body.leadUpdateError, null);
  assert.strictEqual(db.leads[0].status, "new", "an unrelated Lead must never be touched by a plain New Job");
});

// =======================================================================
// PART D — Estimate -> Job (Convert), client/address/lead preservation,
// duplicate-client and duplicate-job protection
// =======================================================================

function seedScheduledEstimate(db, overrides) {
  const row = Object.assign(
    {
      id: makeId(), created_by: ADMIN_EMAIL, created_at: "2026-10-12T10:00:00Z", updated_at: "2026-10-12T10:00:00Z", updated_by: null,
      status: "scheduled", customer_id: CUSTOMER_ID, source_lead_id: LEAD_ID, source_intake_id: null, service_type: "junk_removal",
      appointment_date: futureDate(1), time_window: "w_0800_1000", exact_time: null,
      service_address: "456 Oak Ave", service_city: "Aurora", service_state: "CO", service_zip: "80010",
      description: "Garage cleanout", estimate_notes: "Gate code 1234", quoted_amount: 450,
      outcome_note: null, cancelled_reason: null, converted_booking_id: null,
    },
    overrides || {}
  );
  db.estimates.push(row);
  return row;
}

test("Estimate -> Job: Convert creates a job preserving the SAME client and address", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  const body = {
    customerId: CUSTOMER_ID,
    serviceType: "junk_removal",
    appointmentDate: futureDate(5),
    timeWindow: "w_1000_1200",
    serviceAddress: { address: estimate.service_address, city: estimate.service_city, state: estimate.service_state, zip: estimate.service_zip },
    sourceEstimateId: estimate.id,
  };
  const res = await postBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.customerId, CUSTOMER_ID);
  assert.strictEqual(res.body.serviceAddress.address, "456 Oak Ave");
  assert.strictEqual(db.customers.length, 2, "converting must never create a new/duplicate client");
});

test("Estimate -> Job: Convert preserves the originating Lead relationship — job gets source_lead_id derived from the estimate, Lead marked booked", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db); // source_lead_id = LEAD_ID
  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: CUSTOMER_ID, serviceType: "junk_removal", appointmentDate: futureDate(5), timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" },
    sourceEstimateId: estimate.id,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].source_lead_id, LEAD_ID);
  const lead = db.leads.find((l) => l.id === LEAD_ID);
  assert.strictEqual(lead.status, "booked");
  assert.strictEqual(lead.resulting_booking_id, db.bookings[0].id);
  const updatedEstimate = db.estimates.find((e) => e.id === estimate.id);
  assert.strictEqual(updatedEstimate.status, "converted");
  assert.strictEqual(updatedEstimate.converted_booking_id, db.bookings[0].id);
});

test("Estimate -> Job: a client-sent sourceLeadId is IGNORED when sourceEstimateId is present — the lead link always comes from the estimate itself", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db, { source_lead_id: null }); // this estimate has NO lead
  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: CUSTOMER_ID, serviceType: "junk_removal", appointmentDate: futureDate(5), timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" },
    sourceEstimateId: estimate.id,
    sourceLeadId: LEAD_ID, // attempting to claim a different lead than the estimate actually has
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].source_lead_id, null, "must derive from the estimate's own source_lead_id (null here), never trust the client-sent value");
  assert.strictEqual(db.leads[0].status, "new", "the unrelated Lead must never be marked booked by a mismatched claim");
});

test("Estimate -> Job: a cancelled estimate cannot be converted", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db, { status: "cancelled" });
  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: CUSTOMER_ID, serviceType: "junk_removal", appointmentDate: futureDate(5), timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" },
    sourceEstimateId: estimate.id,
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
});

test("Double-click protection: converting the same estimate twice never creates a second job — the second call replays the first", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  const body = {
    customerId: CUSTOMER_ID, serviceType: "junk_removal", appointmentDate: futureDate(5), timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" },
    sourceEstimateId: estimate.id,
  };
  const res1 = await postBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(db.bookings.length, 1);

  const res2 = await postBooking(db, AUTH_COOKIE, body);
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(db.bookings.length, 1, "a second Convert call must never insert a second bookings row");
  assert.strictEqual(res2.body.booking.id, res1.body.booking.id, "the replay must return the SAME job");
});

test("Double-click protection (race): a genuine unique_violation on bookings_source_estimate_id_uniq is caught and replayed, not surfaced as an error", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  // Simulate: another request already won the race and inserted the real
  // booking a moment ago, but THIS estimate row hasn't been marked
  // converted yet (e.g. that other request is still mid-flight) — the
  // insert itself must be the thing that's protected, not just the
  // converted_booking_id pre-check.
  const racedBooking = { id: makeId(), source_estimate_id: estimate.id, customer_id: CUSTOMER_ID, status: "booked", created_at: "2026-10-12T10:00:00Z" };
  db.bookings.push(racedBooking);
  db.__insertError = { bookings: { code: "23505", message: "duplicate key value violates unique constraint \"bookings_source_estimate_id_uniq\"" } };

  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: CUSTOMER_ID, serviceType: "junk_removal", appointmentDate: futureDate(5), timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" },
    sourceEstimateId: estimate.id,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.id, racedBooking.id, "must fetch and return the ALREADY-existing booking, never error");
  assert.strictEqual(db.bookings.length, 1, "no second row was ever inserted");
});

test("Estimate Completed does NOT automatically create a Job", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  const res = await patchEstimate(db, AUTH_COOKIE, { id: estimate.id, action: "complete", outcomeNote: "Looked at the garage, quoted $450." });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.estimate.status, "completed");
  assert.strictEqual(res.body.estimate.convertedBookingId, null);
  assert.strictEqual(db.bookings.length, 0, "marking an estimate completed must never, by itself, create a job");
});

test("Estimate Completed can later convert to a Job (the client called back)", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  await patchEstimate(db, AUTH_COOKIE, { id: estimate.id, action: "complete" });
  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: CUSTOMER_ID, serviceType: "junk_removal", appointmentDate: futureDate(5), timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" },
    sourceEstimateId: estimate.id,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.estimates.find((e) => e.id === estimate.id).status, "converted");
});

test("Cancelled Estimate does not delete or cancel the originating Lead", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db); // source_lead_id = LEAD_ID
  const res = await patchEstimate(db, AUTH_COOKIE, { id: estimate.id, action: "cancel", cancelledReason: "Client rescheduled indefinitely." });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.estimate.status, "cancelled");
  const lead = db.leads.find((l) => l.id === LEAD_ID);
  assert.strictEqual(lead.status, "new", "cancelling an estimate must never change the Lead's status");
  assert.strictEqual(db.leads.length, 1, "the Lead row must never be deleted");
});

test("Estimate status transitions: invalid transitions are rejected (e.g. completing a cancelled estimate, cancelling a completed one)", async () => {
  adminAuthed();
  const db = freshDb();
  const cancelled = seedScheduledEstimate(db, { status: "cancelled" });
  const res1 = await patchEstimate(db, AUTH_COOKIE, { id: cancelled.id, action: "complete" });
  assert.strictEqual(res1.statusCode, 400);

  const completed = seedScheduledEstimate(db, { status: "completed" });
  const res2 = await patchEstimate(db, AUTH_COOKIE, { id: completed.id, action: "cancel" });
  assert.strictEqual(res2.statusCode, 400);

  const scheduled = seedScheduledEstimate(db, { status: "scheduled" });
  const res3 = await patchEstimate(db, AUTH_COOKIE, { id: scheduled.id, action: "lost" });
  assert.strictEqual(res3.statusCode, 400, "Did Not Book is only reachable from Completed, never straight from Scheduled");
});

test("Estimate Completed does NOT use job-closeout.js — handlePatchEstimate never writes to `bookings`, and never accepts payment/tip fields", () => {
  const src = read("api/admin/booking.js");
  const fn = src.slice(src.indexOf("async function handlePatchEstimate("), src.indexOf("async function handlePatchEstimate(") + 3200);
  assert.ok(!/\.from\("bookings"\)/.test(fn), "handlePatchEstimate must never touch the bookings table");
  assert.ok(!/paymentMethod|tipAmount|job-payments/.test(fn), "must never accept a payment/tip-shaped field");
});

test("admin/schedule.js: an estimate's status sheet is a completely separate code path from a job's — never calls openScheduleCloseout/window.AdminJobCloseout", () => {
  const src = read("admin/schedule.js");
  const fn = src.slice(src.indexOf("function openEstimateStatusSheet("), src.indexOf("function openEstimateStatusSheet(") + 2000);
  assert.ok(!/AdminJobCloseout|openScheduleCloseout/.test(fn), "an estimate status change must never route through the job payment/tip closeout sheet");
});

test("admin/estimate-detail.js never calls window.AdminJobCloseout (a bare mention in a header comment explaining why is fine)", () => {
  const src = read("admin/estimate-detail.js");
  assert.ok(!/AdminJobCloseout\.(open|close)\(/.test(src));
});

// =======================================================================
// PART E — GET estimate detail, Lead pipeline visibility
// =======================================================================

test("GET estimate detail: returns the estimate, its client, and its originating Lead", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  const res = await getEstimate(db, AUTH_COOKIE, estimate.id);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.estimate.id, estimate.id);
  assert.strictEqual(res.body.customer.id, CUSTOMER_ID);
  assert.strictEqual(res.body.sourceLead.id, LEAD_ID);
});

test("GET estimate detail: 404 for a nonexistent or malformed id", async () => {
  adminAuthed();
  const db = freshDb();
  const res1 = await getEstimate(db, AUTH_COOKIE, "99999999-9999-9999-9999-999999999999");
  assert.strictEqual(res1.statusCode, 404);
  const res2 = await getEstimate(db, AUTH_COOKIE, "not-a-uuid");
  assert.strictEqual(res2.statusCode, 404);
});

test("Lead pipeline visibility: no estimate/job yet", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await getLead(db, AUTH_COOKIE, LEAD_ID);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.lead.pipelineEstimate, null);
  assert.strictEqual(res.body.lead.pipelineBooking, null);
});

test("Lead pipeline visibility: shows the scheduled estimate once one exists", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  const res = await getLead(db, AUTH_COOKIE, LEAD_ID);
  assert.strictEqual(res.body.lead.pipelineEstimate.id, estimate.id);
  assert.strictEqual(res.body.lead.pipelineEstimate.status, "scheduled");
  assert.strictEqual(res.body.lead.pipelineBooking, null);
});

test("Lead pipeline visibility: shows the booked job once Convert to Job happens", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  await postBooking(db, AUTH_COOKIE, {
    customerId: CUSTOMER_ID, serviceType: "junk_removal", appointmentDate: futureDate(5), timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" },
    sourceEstimateId: estimate.id,
  });
  const res = await getLead(db, AUTH_COOKIE, LEAD_ID);
  assert.strictEqual(res.body.lead.pipelineBooking.status, "booked");
  assert.strictEqual(res.body.lead.pipelineEstimate.status, "converted");
});

// =======================================================================
// PART F — Lead Detail / New Estimate / New Job client-side prefill wiring
// =======================================================================

test("admin/lead-detail.js: Schedule Estimate and Book Job buttons are always wired, independent of pipeline state", () => {
  const src = read("admin/lead-detail.js");
  assert.ok(/\/admin\/estimate-new\/\?leadId=/.test(src));
  assert.ok(/\/admin\/booking-new\/\?leadId=/.test(src));
});

test("admin/estimate-new.js: carries forward the Lead's client (preselect or autoOpenCreate) and address/service/notes, and never writes to leads itself", () => {
  const src = read("admin/estimate-new.js");
  assert.ok(/preselect:/.test(src) && /autoOpenCreate:/.test(src), "must use the client-picker's preselect/autoOpenCreate, not a second create flow");
  assert.ok(/sourceLeadId/.test(src));
  assert.ok(!/method:\s*['"]PATCH['"][\s\S]{0,200}lead/i.test(src), "this page must only ever READ the lead, never PATCH it");
});

test("admin/booking-new.js: Convert to Job (?estimateId=) preselects the estimate's own client and sends sourceEstimateId, never sourceLeadId, in that case", () => {
  const src = read("admin/booking-new.js");
  const fn = src.slice(src.indexOf("function applyEstimatePrefill("), src.indexOf("function applyEstimatePrefill(") + 1500);
  assert.ok(/preselect:/.test(fn));
  assert.ok(!/autoOpenCreate/.test(fn), "an estimate always already has a real customer — never falls back to creating one");
  assert.ok(/if \(estimateId\) body\.sourceEstimateId = estimateId;\s*else if \(leadId\) body\.sourceLeadId = leadId;/.test(src));
});

test("admin/client-picker.js: preselect/autoOpenCreate are additive — mount() still works with neither option (every pre-existing caller unaffected)", () => {
  const src = read("admin/client-picker.js");
  assert.ok(/if \(opts\.preselect\) \{/.test(src));
  assert.ok(/else if \(opts\.autoOpenCreate\) \{/.test(src));
});

test("admin/status-ui.js: labels override is additive — defaults to STATUS_TEXT when not passed, so every pre-existing caller is unaffected", () => {
  const src = read("admin/status-ui.js");
  assert.ok(/var labels = opts\.labels \|\| STATUS_TEXT;/.test(src));
});

// =======================================================================
// PART G — Mobile UI / structure, Vercel function count
// =======================================================================

test("New admin pages exist and wire their script/CSS correctly", () => {
  ["admin/estimate-new/index.html", "admin/estimate/index.html"].forEach((rel) => {
    const html = read(rel);
    assert.ok(/<link rel="stylesheet" href="\.\.\/admin\.css">/.test(html), rel + " must load admin.css");
    assert.ok(/<meta name="viewport" content="width=device-width, initial-scale=1">/.test(html), rel + " must have a mobile viewport meta tag");
  });
  assert.ok(/estimate-new\.js/.test(read("admin/estimate-new/index.html")));
  assert.ok(/estimate-detail\.js/.test(read("admin/estimate/index.html")));
});

test("admin.css: .admin-detail-actions wraps instead of overflowing at phone width", () => {
  const css = read("admin/admin.css");
  const block = css.slice(css.indexOf(".admin-detail-actions {"), css.indexOf(".admin-detail-actions {") + 300);
  assert.ok(/flex-wrap:\s*wrap/.test(block));
});

test("No new Vercel serverless function was added — still exactly 12 files under api/ (excluding api/_lib)", () => {
  function listApiFiles(dir, base) {
    let out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "_lib") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out = out.concat(listApiFiles(full, base));
      else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
  }
  const files = listApiFiles(path.join(__dirname, "..", "api"));
  assert.strictEqual(files.length, 12, "api/ must still contain exactly 12 function-producing files (Vercel Hobby plan's limit)");
  assert.ok(!files.some((f) => /estimate/i.test(f)), "the Estimate workflow must be a branch on an existing file, never a new api/ file");
});

// ---------------------------------------------------------------------
function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

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
