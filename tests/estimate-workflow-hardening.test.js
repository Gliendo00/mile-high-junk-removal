// Local, offline test harness for the Estimate workflow HARDENING pass
// (post-architecture-approval): replacing window.prompt()/window.confirm()
// with the CRM-native admin/estimate-outcome-sheet.js bottom sheet,
// server-side Convert-to-Job customer-identity hardening in
// api/admin/booking.js's handleCreate(), and Month view estimate support.
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project.
//
// This file focuses on what's NEW/CHANGED this pass. The base Estimate
// workflow (scheduling, GET/PATCH ?resource=estimate, Lead -> Job direct,
// basic Convert to Job, duplicate-client/duplicate-job protection, Lead
// pipeline visibility, financial isolation for Day/Week) is already
// covered by tests/estimate-workflow.test.js and re-run unchanged
// alongside this file, not duplicated here.
//
// Run with:  node tests/estimate-workflow-hardening.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase query builder — same union as tests/estimate-workflow.test.js
// (insert/update/select/eq/is/in/gte/lte/order/limit/maybeSingle/single).
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "eeeeeeee-eeee-eeee-eeee-" + String(700000000000 + nextId++).padStart(12, "0");
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
  select() { return this; }
  eq(field, val) { this._filters.push((row) => row[field] === val); return this; }
  is(field, val) { this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val); return this; }
  in(field, arr) { const set = new Set(arr); this._filters.push((row) => set.has(row[field])); return this; }
  gte(field, val) { this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] >= val); return this; }
  lte(field, val) { this._filters.push((row) => row[field] !== null && row[field] !== undefined && row[field] <= val); return this; }
  order(field, opts) { this._order = { field: field, ascending: !opts || opts.ascending !== false }; return this; }
  limit(n) { this._limit = n; return this; }
  insert(data) { this._insertRow = data; return this; }
  update(data) { this._updateData = data; return this; }
  maybeSingle() { this._single = "maybeSingle"; return this._resolve(); }
  single() { this._single = "single"; return this._resolve(); }
  then(resolve, reject) { return this._resolve().then(resolve, reject); }
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
  return { from(table) { return new FakeQueryBuilder(table, db); } };
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

const CUSTOMER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // the estimate's REAL client
const ATTACKER_CUSTOMER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // a DIFFERENT, unrelated client
const LEAD_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function freshDb() {
  return {
    customers: [
      { id: CUSTOMER_ID, first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", city: "Denver", created_at: "2026-01-01T10:00:00Z" },
      { id: ATTACKER_CUSTOMER_ID, first_name: "Someone", last_name: "Else", phone: "303-555-0200", email: "someone@example.com", city: "Denver", created_at: "2026-01-01T10:00:00Z" },
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

function postBooking(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, body: body }));
}
function getSchedule(db, cookie, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ method: "GET", cookie: cookie, query: Object.assign({ view: "schedule" }, query) }));
}

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// PART A — Estimate status UX: no window.prompt()/window.confirm(), the
// shared CRM-native sheet is used instead, kept separate from job-closeout.
// =======================================================================

// A genuine CALL always passes an argument — "window.prompt('How did...')"
// — so requiring a non-")" character immediately after the opening paren
// distinguishes a real call from this pass's own explanatory comments
// (which reference the removed dialogs as "window.prompt()/window.confirm()",
// empty parens, e.g. "replaced window.prompt()/window.confirm() with the
// shared sheet") without needing to strip comments first.
const REAL_PROMPT_CALL = /window\.prompt\([^)]/;
const REAL_CONFIRM_CALL = /window\.confirm\([^)]/;

test("admin/estimate-detail.js: zero window.prompt()/window.confirm() calls anywhere in the file", () => {
  const src = read("admin/estimate-detail.js");
  assert.ok(!REAL_PROMPT_CALL.test(src), "must not use a browser prompt() dialog");
  assert.ok(!REAL_CONFIRM_CALL.test(src), "must not use a browser confirm() dialog");
});

test("admin/schedule.js: zero window.prompt()/window.confirm() calls in the estimate status code path", () => {
  const src = read("admin/schedule.js");
  const fn = src.slice(src.indexOf("function openEstimateStatusSheet("), src.indexOf("function openEstimateStatusSheet(") + 1500);
  assert.ok(!REAL_PROMPT_CALL.test(fn));
  assert.ok(!REAL_CONFIRM_CALL.test(fn));
});

test("admin/estimate-outcome-sheet.js: a real CRM-native bottom sheet (reuses .admin-sheet-overlay/.admin-sheet, not a browser dialog)", () => {
  const src = read("admin/estimate-outcome-sheet.js");
  assert.ok(/window\.AdminEstimateOutcome\s*=/.test(src));
  assert.ok(/admin-sheet-overlay/.test(src));
  assert.ok(/admin-sheet['"]/.test(src) || /className\s*=\s*['"]admin-sheet['"]/.test(src));
  assert.ok(!REAL_PROMPT_CALL.test(src));
  assert.ok(!REAL_CONFIRM_CALL.test(src));
});

test("admin/estimate-outcome-sheet.js: supports all three non-conversion outcomes (complete/cancel/lost) with distinct titles/labels", () => {
  const src = read("admin/estimate-outcome-sheet.js");
  ["complete", "cancel", "lost"].forEach((action) => {
    assert.ok(new RegExp("\\b" + action + ":").test(src), "must have a distinct title/label entry for action '" + action + "'");
  });
});

test("admin/estimate-outcome-sheet.js: a Confirm with no note still saves (the note is genuinely optional)", () => {
  const src = read("admin/estimate-outcome-sheet.js");
  // The note is only ever added to the request body when non-empty —
  // never a required field, never blocks the Confirm button.
  assert.ok(/if \(note\) \{/.test(src), "must only attach the note field conditionally, never require it");
});

test("admin/estimate-outcome-sheet.js: the sheet PATCHes ?resource=estimate directly — never CALLS window.AdminJobCloseout or a job-shaped endpoint", () => {
  const src = read("admin/estimate-outcome-sheet.js");
  assert.ok(/resource=estimate/.test(src));
  assert.ok(!/AdminJobCloseout\.(open|close)\(/.test(src), "must never invoke window.AdminJobCloseout (a header-comment mention explaining why it's avoided is fine)");
  assert.ok(!/resource=job-payments|resource=tip|resource=status[^-]/.test(src), "must never touch a job-shaped write endpoint");
});

test("admin/estimate-detail.js: complete/lost/cancel buttons each open window.AdminEstimateOutcome with the matching action", () => {
  const src = read("admin/estimate-detail.js");
  assert.ok(/completeBtn\.addEventListener\(['"]click['"], function \(\) \{\s*window\.AdminEstimateOutcome\.open\(\{ estimateId: estimateId, action: ['"]complete['"]/.test(src));
  assert.ok(/lostBtn\.addEventListener\(['"]click['"], function \(\) \{\s*window\.AdminEstimateOutcome\.open\(\{ estimateId: estimateId, action: ['"]lost['"]/.test(src));
  assert.ok(/cancelBtn\.addEventListener\(['"]click['"], function \(\) \{\s*window\.AdminEstimateOutcome\.open\(\{ estimateId: estimateId, action: ['"]cancel['"]/.test(src));
});

test("admin/schedule.js: the estimate status sheet opens window.AdminEstimateOutcome on select, instead of PATCHing directly", () => {
  const src = read("admin/schedule.js");
  const fn = src.slice(src.indexOf("function openEstimateStatusSheet("), src.indexOf("function openEstimateStatusSheet(") + 1500);
  assert.ok(/window\.AdminEstimateOutcome\.open\(/.test(fn));
  assert.ok(!/adminFetch\(['"]\/api\/admin\/booking\?resource=estimate['"]/.test(fn), "must no longer PATCH directly from the status-select handler — the sheet owns the write now");
});

test("Preserves the 5-status vocabulary: scheduled, completed, converted, cancelled, lost all still appear across the estimate code", () => {
  const detail = read("admin/estimate-detail.js");
  const schedule = read("admin/schedule.js");
  const api = read("api/admin/booking.js");
  ["scheduled", "completed", "converted", "cancelled", "lost"].forEach((status) => {
    const present = detail.includes(status) || schedule.includes(status) || api.includes(status);
    assert.ok(present, "status '" + status + "' must still appear somewhere in the estimate workflow");
  });
});

test("Convert to Job remains an obviously separate action — never offered as a status-sheet option, never reachable via handlePatchEstimate", () => {
  const schedule = read("admin/schedule.js");
  const fn = schedule.slice(schedule.indexOf("function openEstimateStatusSheet("), schedule.indexOf("function openEstimateStatusSheet(") + 1500);
  assert.ok(!/['"]converted['"]/.test(fn), "the status-change sheet must never offer 'converted' as a selectable option");
  const api = read("api/admin/booking.js");
  const patchFn = api.slice(api.indexOf("async function handlePatchEstimate("), api.indexOf("async function handlePatchEstimate(") + 3200);
  assert.ok(!/"converted"/.test(patchFn), "handlePatchEstimate must never be able to set status to converted");
  const detail = read("admin/estimate-detail.js");
  assert.ok(/convertBtn\.href = ['"]\/admin\/booking-new\/\?estimateId=/.test(detail), "Convert to Job must stay its own distinct navigation action");
});

// =======================================================================
// PART B — Server-side Convert-to-Job customer-identity hardening
// =======================================================================

test("SECURITY: a manipulated customerId cannot convert an Estimate into a Job for a different client", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db); // real customer_id = CUSTOMER_ID
  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: ATTACKER_CUSTOMER_ID, // attempted manipulation
    serviceType: "junk_removal",
    appointmentDate: futureDate(5),
    timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" },
    sourceEstimateId: estimate.id,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.bookings[0].customer_id, CUSTOMER_ID, "the created job must belong to the ESTIMATE's own customer, never the client-sent one");
  assert.strictEqual(res.body.booking.customerId, CUSTOMER_ID);
  assert.notStrictEqual(db.bookings[0].customer_id, ATTACKER_CUSTOMER_ID);
});

test("SECURITY: the response itself never reflects the manipulated customerId back to the caller", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: ATTACKER_CUSTOMER_ID,
    serviceType: "junk_removal",
    appointmentDate: futureDate(5),
    timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" },
    sourceEstimateId: estimate.id,
  });
  assert.notStrictEqual(res.body.booking.customerId, ATTACKER_CUSTOMER_ID);
});

test("Legitimate Estimate -> Job (customerId matches the estimate's own client) still works exactly as before", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: CUSTOMER_ID, // matches — the normal UI-driven case
    serviceType: "junk_removal",
    appointmentDate: futureDate(5),
    timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" },
    sourceEstimateId: estimate.id,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].customer_id, CUSTOMER_ID);
  assert.strictEqual(db.estimates.find((e) => e.id === estimate.id).status, "converted");
});

test("Normal '+ New Job' (no sourceEstimateId) is completely unaffected by the hardening — customerId is used exactly as sent", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: ATTACKER_CUSTOMER_ID, // "attacker" here is just an ordinary second client — nothing wrong with booking them directly
    serviceType: "junk_removal",
    appointmentDate: futureDate(5),
    timeWindow: "w_1000_1200",
    serviceAddress: { address: "1 Random St", city: "Denver", state: "CO", zip: "80202" },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].customer_id, ATTACKER_CUSTOMER_ID, "an ordinary New Job must still honor the submitted customerId verbatim");
});

test("Duplicate-conversion protection still works after the hardening pass: converting twice never creates two jobs, and the second call's manipulated customerId still has no effect", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  const body1 = {
    customerId: CUSTOMER_ID, serviceType: "junk_removal", appointmentDate: futureDate(5), timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" }, sourceEstimateId: estimate.id,
  };
  const res1 = await postBooking(db, AUTH_COOKIE, body1);
  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(db.bookings.length, 1);

  // A second call, now ALSO trying a different customerId — must still
  // replay the SAME original job (same customer), never create a second
  // job for the attacker-supplied client.
  const res2 = await postBooking(db, AUTH_COOKIE, Object.assign({}, body1, { customerId: ATTACKER_CUSTOMER_ID }));
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(db.bookings.length, 1, "a retried Convert must never create a second job");
  assert.strictEqual(res2.body.booking.id, res1.body.booking.id);
  assert.strictEqual(res2.body.booking.customerId, CUSTOMER_ID);
});

test("Partial unique index guard (bookings_source_estimate_id_uniq) is still the backstop for a genuine race, independent of which customerId either request sent", async () => {
  adminAuthed();
  const db = freshDb();
  const estimate = seedScheduledEstimate(db);
  const racedBooking = { id: makeId(), source_estimate_id: estimate.id, customer_id: CUSTOMER_ID, status: "booked", created_at: "2026-10-12T10:00:00Z" };
  db.bookings.push(racedBooking);
  db.__insertError = { bookings: { code: "23505", message: "duplicate key value violates unique constraint \"bookings_source_estimate_id_uniq\"" } };

  const res = await postBooking(db, AUTH_COOKIE, {
    customerId: ATTACKER_CUSTOMER_ID, serviceType: "junk_removal", appointmentDate: futureDate(5), timeWindow: "w_1000_1200",
    serviceAddress: { address: "456 Oak Ave", city: "Aurora", state: "CO", zip: "80010" }, sourceEstimateId: estimate.id,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booking.id, racedBooking.id);
  assert.strictEqual(db.bookings.length, 1);
});

test("api/admin/booking.js: effectiveCustomerId is computed once, server-side, before the customer-existence check and the insert", () => {
  const src = read("api/admin/booking.js");
  assert.ok(/const effectiveCustomerId = sourceEstimate \? sourceEstimate\.customer_id : customerId;/.test(src));
  assert.ok(/customer_id: effectiveCustomerId,/.test(src), "the insert payload must use effectiveCustomerId, never the raw body customerId, for the actual write");
});

// =======================================================================
// PART C — Month view includes Estimates, financially isolated
// =======================================================================

test("Month view: ?view=schedule&range=month returns a sibling estimates array, including a FUTURE-dated scheduled estimate", async () => {
  adminAuthed();
  const db = freshDb();
  const future = futureDate(10);
  const year = Number(future.slice(0, 4));
  const month = Number(future.slice(5, 7));
  db.estimates.push({
    id: makeId(), created_by: ADMIN_EMAIL, created_at: "2026-10-12T10:00:00Z", updated_at: "2026-10-12T10:00:00Z",
    status: "scheduled", customer_id: CUSTOMER_ID, source_lead_id: null, service_type: "junk_removal",
    appointment_date: future, time_window: "w_0800_1000", exact_time: null,
    service_address: "456 Oak Ave", service_city: "Aurora", service_state: "CO", service_zip: "80010", quoted_amount: 450,
  });
  const res = await getSchedule(db, AUTH_COOKIE, { range: "month", year: String(year), month: String(month) });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.estimates), "Month response must carry an `estimates` array");
  assert.strictEqual(res.body.estimates.length, 1);
  assert.strictEqual(res.body.estimates[0].appointmentDate, future);
  assert.ok(res.body.estimateCountsByDate, "Month response must also carry estimateCountsByDate");
  assert.strictEqual(res.body.estimateCountsByDate[future], 1);
});

test("Month view: estimates never disappear just because the admin is viewing Month instead of Day/Week — same fetchScheduleEstimates(), same bounds", async () => {
  adminAuthed();
  const db = freshDb();
  const future = futureDate(15);
  const year = Number(future.slice(0, 4));
  const month = Number(future.slice(5, 7));
  db.estimates.push({
    id: makeId(), created_by: ADMIN_EMAIL, created_at: "2026-10-12T10:00:00Z", updated_at: "2026-10-12T10:00:00Z",
    status: "scheduled", customer_id: CUSTOMER_ID, source_lead_id: null, service_type: "junk_removal",
    appointment_date: future, time_window: "w_0800_1000", exact_time: null,
    service_address: "456 Oak Ave", service_city: "Aurora", service_state: "CO", service_zip: "80010", quoted_amount: null,
  });
  const dayRes = await getSchedule(db, AUTH_COOKIE, { range: "day", date: future });
  const monthRes = await getSchedule(db, AUTH_COOKIE, { range: "month", year: String(year), month: String(month) });
  assert.strictEqual(dayRes.body.estimates.length, 1);
  assert.strictEqual(monthRes.body.estimates.length, 1);
  assert.strictEqual(dayRes.body.estimates[0].id, monthRes.body.estimates[0].id);
});

test("Month view: a cancelled/lost/converted estimate is still excluded (same status filter as Day/Week)", async () => {
  adminAuthed();
  const db = freshDb();
  const future = futureDate(12);
  const year = Number(future.slice(0, 4));
  const month = Number(future.slice(5, 7));
  ["cancelled", "lost", "converted"].forEach((status) => {
    db.estimates.push({
      id: makeId(), created_by: ADMIN_EMAIL, created_at: "2026-10-12T10:00:00Z", updated_at: "2026-10-12T10:00:00Z",
      status: status, customer_id: CUSTOMER_ID, source_lead_id: null, service_type: "junk_removal",
      appointment_date: future, time_window: "w_0800_1000", exact_time: null,
      service_address: "456 Oak Ave", service_city: "Aurora", service_state: "CO", service_zip: "80010", quoted_amount: null,
    });
  });
  const res = await getSchedule(db, AUTH_COOKIE, { range: "month", year: String(year), month: String(month) });
  assert.strictEqual(res.body.estimates.length, 0);
});

test("FINANCIAL ISOLATION: Month's estimates never leak into `jobs`/`jobCountsByDate`, and admin/calendar-views.js hands financials only body.jobs", async () => {
  adminAuthed();
  const db = freshDb();
  const future = futureDate(8);
  const year = Number(future.slice(0, 4));
  const month = Number(future.slice(5, 7));
  db.estimates.push({
    id: makeId(), created_by: ADMIN_EMAIL, created_at: "2026-10-12T10:00:00Z", updated_at: "2026-10-12T10:00:00Z",
    status: "scheduled", customer_id: CUSTOMER_ID, source_lead_id: null, service_type: "junk_removal",
    appointment_date: future, time_window: "w_0800_1000", exact_time: null,
    service_address: "456 Oak Ave", service_city: "Aurora", service_state: "CO", service_zip: "80010", quoted_amount: 99999,
  });
  const res = await getSchedule(db, AUTH_COOKIE, { range: "month", year: String(year), month: String(month) });
  assert.strictEqual(res.body.jobs.length, 0, "no job exists — jobs must stay empty regardless of the $99,999 estimate");
  assert.deepStrictEqual(res.body.jobCountsByDate, {}, "jobCountsByDate must never count an estimate");

  const src = read("admin/calendar-views.js");
  assert.ok(/showFinancialsFor\(body\.startDate, body\.endDate, body\.jobs\);/.test(src), "loadMonth() must hand financials only body.jobs, never estimates");
});

test("Month estimate count badge never reads a dollar amount — purely a count, not a value", () => {
  const src = read("admin/calendar-views.js");
  const fn = src.slice(src.indexOf("function renderMonthGrid("), src.indexOf("function renderMonthGrid(") + 2200);
  assert.ok(/admin-month-grid-estimate-count/.test(fn));
  assert.ok(!/quotedAmount|estimatedPrice|finalPrice/.test(fn), "the Month grid cell must never render a financial value for an estimate");
});

test("Month day panel renders estimates via the shared renderDayPanel(), visually distinct (own card class + ESTIMATE badge), never mixed into the job list", () => {
  const src = read("admin/calendar-views.js");
  assert.ok(/function renderDailyEstimateCard\(estimate\)/.test(src));
  assert.ok(/admin-daily-estimate-card/.test(src));
  assert.ok(/admin-estimate-type-badge/.test(src));
  assert.ok(/renderDayPanel\(monthDayPanel, iso, state\.monthJobsByDate\[iso\] \|\| \[\], state\.monthEstimatesByDate\[iso\] \|\| \[\]/.test(src));
});

// =======================================================================
// PART D — Existing Job status / job-closeout behavior remains intact
// =======================================================================

test("admin/schedule.js: a job's status pill still opens window.AdminStatusUI with STATUS_ORDER and routes 'completed' through window.AdminJobCloseout, unchanged by this pass", () => {
  const src = read("admin/schedule.js");
  const fn = src.slice(src.indexOf("function openJobStatusSheet("), src.indexOf("function openJobStatusSheet(") + 1200);
  assert.ok(/window\.AdminStatusUI\.STATUS_ORDER/.test(fn));
  assert.ok(/openScheduleCloseout\(job\)/.test(fn));
});

test("admin/schedule.js: openScheduleCloseout() still calls window.AdminJobCloseout.open() for jobs — the job payment/tip/note flow is untouched", () => {
  const src = read("admin/schedule.js");
  const fn = src.slice(src.indexOf("function openScheduleCloseout("), src.indexOf("function openScheduleCloseout(") + 800);
  assert.ok(/window\.AdminJobCloseout\.open\(/.test(fn));
});

test("api/admin/booking.js: handleStatusAction() (job status PATCH ?resource=status) is untouched — same 7-value allowlist, same literal update payload", () => {
  const src = read("api/admin/booking.js");
  assert.ok(/const STATUS_ALLOWED_STATUSES = \["new", "contacted", "quoted", "booked", "rental_out", "completed", "lost"\];/.test(src));
});

test("admin/index.html: job-closeout.js and estimate-outcome-sheet.js are BOTH loaded, in a safe order, neither replacing the other", () => {
  const html = read("admin/index.html");
  assert.ok(/<script src="job-closeout\.js"><\/script>/.test(html));
  assert.ok(/<script src="estimate-outcome-sheet\.js"><\/script>/.test(html));
  assert.ok(/<script src="status-ui\.js"><\/script>/.test(html));
});

// =======================================================================
// PART E — Mobile structure remains valid
// =======================================================================

test("admin/estimate-outcome-sheet.js: builds its sheet via DOM APIs only — no innerHTML/insertAdjacentHTML/document.write", () => {
  const src = read("admin/estimate-outcome-sheet.js");
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(src));
});

test("admin/calendar-views.js: no innerHTML/insertAdjacentHTML/document.write was introduced by the Month estimate changes", () => {
  const src = read("admin/calendar-views.js");
  // Actual usage only (an assignment/call) — the file's own long-standing
  // header comment legitimately mentions "innerHTML/insertAdjacentHTML"
  // by name while explaining this exact discipline, which a bare
  // substring search would misfire on.
  assert.ok(!/\.innerHTML\s*=/.test(src));
  assert.ok(!/\.insertAdjacentHTML\(/.test(src));
  assert.ok(!/document\.write\(/.test(src));
});

test("admin.css: new Month/estimate classes introduce no fixed pixel widths that could force horizontal overflow at phone width", () => {
  const css = read("admin/admin.css");
  ["admin-month-grid-estimate-count", "admin-daily-estimate-card", "admin-daily-estimate-card-left"].forEach((cls) => {
    const idx = css.indexOf("." + cls);
    assert.ok(idx !== -1, "." + cls + " must exist");
    const block = css.slice(idx, css.indexOf("}", idx) + 1);
    assert.ok(!/width:\s*\d{3,}px/.test(block), "." + cls + " must not set a wide fixed-pixel width");
  });
});

test("admin/estimate-outcome-sheet.js reuses the existing .admin-sheet/.admin-field/.admin-btn primitives — no new bespoke layout system", () => {
  const src = read("admin/estimate-outcome-sheet.js");
  assert.ok(/admin-field/.test(src));
  assert.ok(/admin-btn admin-btn-primary/.test(src));
  assert.ok(/admin-btn admin-btn-outline/.test(src));
});

test("No new Vercel serverless function was added by this hardening pass — still exactly 12 files under api/ (excluding api/_lib)", () => {
  function listApiFiles(dir) {
    let out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "_lib") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out = out.concat(listApiFiles(full));
      else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
  }
  const files = listApiFiles(path.join(__dirname, "..", "api"));
  assert.strictEqual(files.length, 12);
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
