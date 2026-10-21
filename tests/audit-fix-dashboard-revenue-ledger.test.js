// CRM cleanup/verification audit (2026-10-21) — regression coverage for
// the Dashboard Revenue fix: Day/Week/Month/Home all render from
// api/admin/bookings.js's fetchScheduleJobs(), which used to compute
// Revenue purely from bookings.final_price (an admin-typed snapshot) and
// never read job_payments at all. It now computes a ledger-authoritative
// revenueAmount/revenueSource per completed, non-pickup job via
// api/_lib/job-payments-ledger.js's effectiveRevenue() — the SAME rule
// the booking-detail/closeout page and Invoices list already trust — so
// a completed job's actual collected amount can no longer silently
// diverge between the dashboard and that job's own detail page.
//
// Same offline-fake-Supabase harness as tests/phase3c-schedule.test.js
// (this project's own established per-file-duplication convention —
// never a shared test module): "@supabase/supabase-js" is intercepted at
// require-time and replaced with an in-memory fake, never the real
// network or production project.
//
// Run with:  node tests/audit-fix-dashboard-revenue-ledger.test.js

const Module = require("module");
const assert = require("assert");

// ---------------------------------------------------------------------
// Fake Supabase: query builder — same shape as phase3c-schedule.test.js's
// own FakeQueryBuilder, since fetchScheduleJobs() now also queries
// job_payments via .in()/.is(), on top of the existing bookings/customers
// queries this harness already supported.
// ---------------------------------------------------------------------
class FakeQueryBuilder {
  constructor(rows) {
    this._rows = rows || [];
    this._filters = [];
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
  maybeSingle() {
    const filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));
    return Promise.resolve({ data: filtered[0] || null, error: null });
  }
  then(resolve, reject) {
    const filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));
    return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
  }
}

function createFakeServiceClient(db) {
  return {
    from(table) {
      return new FakeQueryBuilder((db[table] || []).slice());
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
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
    status: (code) => {
      res.statusCode = code;
      return res;
    },
    json: (obj) => {
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

function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date()).forEach((p) => {
    parts[p.type] = p.value;
  });
  return parts.year + "-" + parts.month + "-" + parts.day;
}
const TODAY = denverTodayIso();

function booking(overrides) {
  return Object.assign(
    {
      id: "00000000-0000-0000-0000-000000000000",
      customer_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      service_type: "junk_removal",
      appointment_date: TODAY,
      status: "completed",
      estimated_price: 250,
      final_price: 250,
      is_complimentary: false,
      service_address: "123 Main St",
      service_city: "Denver",
      service_state: "CO",
      service_zip: "80202",
    },
    overrides
  );
}

function payment(overrides) {
  return Object.assign(
    {
      booking_id: "00000000-0000-0000-0000-000000000000",
      invoice_id: null,
      amount: 100,
      payment_type: "payment",
      voided_at: null,
    },
    overrides
  );
}

function freshDb(bookings, jobPayments) {
  return {
    bookings: bookings,
    job_payments: jobPayments || [],
    customers: [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", city: "Denver" }],
  };
}

function getDay(db, dateIso) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { view: "schedule", range: "day", date: dateIso } }));
}
function getWeek(db) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { view: "schedule", range: "week" } }));
}
function getMonth(db) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ cookie: "mhjr_admin_at=at-good", query: { view: "schedule", range: "month" } }));
}

async function main() {
  adminAuthed();

  await test("a completed job with NO job_payments rows still falls back to final_price (backward compatible) and reports source 'final_price'", async () => {
    const db = freshDb([booking({ id: "b1", final_price: 300 })]);
    const res = await getDay(db, TODAY);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, 300);
    assert.strictEqual(job.revenueSource, "final_price");
  });

  await test("partial payment: ledger total is authoritative even when it differs from final_price — a $500 job with only $200 actually collected reports $200, not $500", async () => {
    const db = freshDb([booking({ id: "b1", final_price: 500 })], [payment({ booking_id: "b1", amount: 200 })]);
    const res = await getDay(db, TODAY);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, 200);
    assert.strictEqual(job.revenueSource, "ledger");
  });

  await test("multiple payments sum correctly — a Stripe deposit + a cash payment both count", async () => {
    const db = freshDb(
      [booking({ id: "b1", final_price: 450 })],
      [payment({ booking_id: "b1", amount: 100 }), payment({ booking_id: "b1", amount: 350, payment_method: "cash" })]
    );
    const res = await getDay(db, TODAY);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, 450);
  });

  await test("a refund is subtracted from the collected total, never added", async () => {
    const db = freshDb(
      [booking({ id: "b1", final_price: 450 })],
      [payment({ booking_id: "b1", amount: 450 }), payment({ booking_id: "b1", amount: 50, payment_type: "refund" })]
    );
    const res = await getDay(db, TODAY);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, 400);
  });

  await test("a voided payment row is excluded from the collected total entirely", async () => {
    const db = freshDb(
      [booking({ id: "b1", final_price: 450 })],
      [payment({ booking_id: "b1", amount: 450 }), payment({ booking_id: "b1", amount: 450, voided_at: "2026-10-01T00:00:00.000Z" })]
    );
    const res = await getDay(db, TODAY);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, 450, "the voided duplicate must not be double-counted or counted at all");
  });

  await test("an invoice-attributed payment (invoice_id set) counts toward this booking's revenue exactly the same as a generic one — no separate/duplicate addition from any invoice-total read", async () => {
    const db = freshDb([booking({ id: "b1", final_price: 300 })], [payment({ booking_id: "b1", amount: 300, invoice_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" })]);
    const res = await getDay(db, TODAY);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, 300, "exactly one count of the $300 — not $300 (ledger) + $300 (some invoice-total addition)");
  });

  await test("a legacy/generic job_payments row (invoice_id null, pre-dating invoicing) is still counted", async () => {
    const db = freshDb([booking({ id: "b1", final_price: 150 })], [payment({ booking_id: "b1", amount: 150, invoice_id: null })]);
    const res = await getDay(db, TODAY);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, 150);
    assert.strictEqual(job.revenueSource, "ledger");
  });

  await test("a complimentary job reports $0 revenue even if it somehow has job_payments rows — isComplimentary is checked before the ledger", async () => {
    const db = freshDb([booking({ id: "b1", final_price: 0, is_complimentary: true })], [payment({ booking_id: "b1", amount: 500 })]);
    const res = await getDay(db, TODAY);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, 0);
    assert.strictEqual(job.revenueSource, "complimentary");
  });

  await test("a booked (not completed) job never gets a revenueAmount — it stays null, so it can never be mistaken for Revenue instead of Booked", async () => {
    const db = freshDb([booking({ id: "b1", status: "booked", final_price: null })], []);
    const res = await getDay(db, TODAY);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, null);
    assert.strictEqual(job.revenueSource, null);
  });

  await test("a dumpster_pickup helper job never gets a revenueAmount, even if marked completed with job_payments rows somehow attached to it — it is excluded from economic metrics entirely", async () => {
    const db = freshDb([booking({ id: "b1", service_type: "dumpster_pickup", status: "completed", final_price: null, estimated_price: null })], [payment({ booking_id: "b1", amount: 999 })]);
    const res = await getDay(db, TODAY);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, null, "a pickup leg must never contribute to Revenue, even defensively");
  });

  await test("two different completed bookings' ledgers never bleed into each other — each booking's revenueAmount reflects only its OWN job_payments rows", async () => {
    const db = freshDb(
      [booking({ id: "b1", final_price: 100 }), booking({ id: "b2", final_price: 100 })],
      [payment({ booking_id: "b1", amount: 100 }), payment({ booking_id: "b2", amount: 40 })]
    );
    const res = await getDay(db, TODAY);
    const job1 = res.body.jobs.find((j) => j.id === "b1");
    const job2 = res.body.jobs.find((j) => j.id === "b2");
    assert.strictEqual(job1.revenueAmount, 100);
    assert.strictEqual(job2.revenueAmount, 40, "must use b2's own ledger, not b1's, and not fall back to final_price just because a sibling booking's ledger exists");
  });

  await test("tips are never summed into revenueAmount — this ledger has never read tip_amount, and this fix does not change that", async () => {
    const db = freshDb([booking({ id: "b1", final_price: 300, tip_amount: 50 })], [payment({ booking_id: "b1", amount: 300 })]);
    const res = await getDay(db, TODAY);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, 300, "tip_amount must never be added on top of the ledger total");
  });

  await test("Week (admin/home.js's 'Revenue This Week' and the Schedule Week view) uses the SAME ledger-authoritative revenueAmount as Day — one consistent revenue source across every dashboard surface", async () => {
    const db = freshDb([booking({ id: "b1", final_price: 500 })], [payment({ booking_id: "b1", amount: 320 })]);
    const res = await getWeek(db);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, 320);
    assert.strictEqual(job.revenueSource, "ledger");
  });

  await test("Month uses the SAME ledger-authoritative revenueAmount as Day/Week", async () => {
    const db = freshDb([booking({ id: "b1", final_price: 500 })], [payment({ booking_id: "b1", amount: 320 })]);
    const res = await getMonth(db);
    const job = res.body.jobs.find((j) => j.id === "b1");
    assert.strictEqual(job.revenueAmount, 320);
    assert.strictEqual(job.revenueSource, "ledger");
  });

  // -----------------------------------------------------------------
  // Static source checks — admin/home.js duplicates admin/schedule-
  // financials.js's completedRevenueAmount() byte-for-byte (this
  // project's own established per-file-duplication convention), so both
  // copies must read job.revenueAmount, not just one.
  // -----------------------------------------------------------------
  const fs = require("fs");
  await test("admin/schedule-financials.js's completedRevenueAmount() reads job.revenueAmount before falling back to finalPrice", () => {
    const src = fs.readFileSync(require("path").join(__dirname, "..", "admin", "schedule-financials.js"), "utf8");
    const fn = src.slice(src.indexOf("function completedRevenueAmount"), src.indexOf("function completedRevenueAmount") + 600);
    assert.ok(/typeof job\.revenueAmount === 'number'/.test(fn));
    assert.ok(/job\.isComplimentary/.test(fn), "isComplimentary must still be checked (defense in depth, even though revenueAmount already encodes it server-side)");
  });

  await test("admin/home.js's completedRevenueAmount() reads job.revenueAmount before falling back to finalPrice — same rule as schedule-financials.js, never a drifting second copy", () => {
    const src = fs.readFileSync(require("path").join(__dirname, "..", "admin", "home.js"), "utf8");
    const fn = src.slice(src.indexOf("function completedRevenueAmount"), src.indexOf("function completedRevenueAmount") + 600);
    assert.ok(/typeof job\.revenueAmount === 'number'/.test(fn));
  });

  await test("admin/schedule.js's and admin/calendar-views.js's own 'Actual Collected' per-card price label also read job.revenueAmount, so a job's card can never show a different actual-collected number than the Revenue/Net counters above it", () => {
    const scheduleSrc = fs.readFileSync(require("path").join(__dirname, "..", "admin", "schedule.js"), "utf8");
    const calendarSrc = fs.readFileSync(require("path").join(__dirname, "..", "admin", "calendar-views.js"), "utf8");
    assert.ok(/typeof job\.revenueAmount === 'number' \? job\.revenueAmount : job\.finalPrice/.test(scheduleSrc));
    assert.ok(/typeof job\.revenueAmount === 'number' \? job\.revenueAmount : job\.finalPrice/.test(calendarSrc));
  });

  console.log(`\n${passCount} tests run, ${failCount} failed.`);
  if (failCount > 0) process.exitCode = 1;
}

let passCount = 0;
let failCount = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passCount++;
      console.log(`PASS - ${name}`);
    })
    .catch((e) => {
      failCount++;
      console.error(`FAIL - ${name}`);
      console.error(e);
    });
}

main();
