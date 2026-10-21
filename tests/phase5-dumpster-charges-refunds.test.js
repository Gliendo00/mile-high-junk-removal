// Local, offline test harness for Phase 5 (Dumpster Rental Extra Charges +
// Refunds). Covers:
//   - api/admin/booking.js's ?resource=charges POST (handleProposeCharge()) —
//     overweight_tonnage/additional_days server-computed amounts, the 3 new
//     flat charge types (relocation/blocked_pickup/rule_violation), "other",
//     overrideAmount/overrideReason audit trail, and Part 10's duplicate-
//     charge prevention (hasActiveChargeOfType()).
//   - ?resource=charges PATCH {action:"invoice"} (handleInvoiceCharges()) —
//     turning proposed charges into real invoice_line_items, auto-finalizing
//     only a brand-new invoice, appending to an already-finalized/paid one.
//   - ?resource=job-payments PATCH {action:"refund"} (handleRefundJobPayment())
//     — the Stripe-backed refund path, called-Stripe-first-then-write
//     ordering, computeRefundableBalance()/validateRefundAmount() bounds.
//   - ?resource=job-payments / ?resource=invoice-payment POST with
//     paymentType:"refund" — the manual refund path's
//     validateManualPaymentFields() requirement of reversesPaymentId +
//     confirmedExternalReturn:true.
//   - api/_lib/rental-pricing.js's additionalDaysCharge() (indirectly, via
//     handleProposeCharge()).
//   - api/_lib/job-payments-ledger.js's netCollectedFromLedgerRows()/
//     grossCollectedFromLedgerRows() — direct unit tests.
//   - api/_lib/invoice-helpers.js's deriveInvoiceStatus() "refunded" branch —
//     direct unit tests with constructed numbers.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// and "stripe" are intercepted at require-time and replaced with in-memory
// fakes — never the real network, never production Supabase/Stripe. The
// FakeQueryBuilder below is phase2-invoice-workflow.test.js's (insert/
// update -> filtered rows survive into single()/maybeSingle(), matching
// real Postgres UPDATE...WHERE semantics; count+head selects; .or() support)
// plus phase3c-stage2.5v2-stripe-rental-payments.test.js's .upsert() support
// (onConflict/ignoreDuplicates, returning the real inserted row on first
// insert) — needed by handleRefundJobPayment()'s idempotent
// job_payments_stripe_refund_idx upsert.
//
// Run with:  node tests/phase5-dumpster-charges-refunds.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

// ---------------------------------------------------------------------
// Fake Supabase query builder
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "dddddddd-dddd-dddd-dddd-" + String(500000000000 + nextId++).padStart(12, "0");
}

class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._order = [];
    this._count = null;
    this._single = null;
    this._insertData = undefined;
    this._updateData = undefined;
    this._upsertData = undefined;
    this._upsertOpts = undefined;
    this._deleteFlag = false;
  }
  select(_cols, opts) {
    if (opts && opts.count) this._count = opts;
    return this;
  }
  eq(field, val) {
    this._filters.push((row) => row[field] === val);
    return this;
  }
  neq(field, val) {
    this._filters.push((row) => row[field] !== val);
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
  or(expr) {
    const clauses = String(expr)
      .split(",")
      .map((c) => {
        const parts = c.split(".");
        return { field: parts[0], op: parts[1], value: parts.slice(2).join(".") };
      });
    this._filters.push((row) =>
      clauses.some((c) => {
        const rowVal = row[c.field] === undefined ? null : row[c.field];
        if (c.op === "is") return c.value === "null" ? rowVal === null : rowVal === c.value;
        if (c.op === "lt") return rowVal !== null && rowVal < c.value;
        if (c.op === "eq") return rowVal === c.value;
        return false;
      })
    );
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  order(field, opts) {
    this._order.push({ field: field, ascending: !opts || opts.ascending !== false });
    return this;
  }
  insert(data) {
    this._insertData = data;
    return this;
  }
  update(data) {
    this._updateData = data;
    return this;
  }
  // Phase 5 — job_payments_stripe_refund_idx's idempotent-upsert shape
  // (handleRefundJobPayment()). Returns the actual inserted row on first
  // insert (not just a bare success signal); a conflicting retry with
  // ignoreDuplicates:true returns zero rows, matching real Postgres
  // ON CONFLICT DO NOTHING semantics — the caller re-selects by the unique
  // column itself, exactly like mirrorStripePaymentToLedger()'s own upsert.
  upsert(data, opts) {
    this._upsertData = data;
    this._upsertOpts = opts || {};
    return this;
  }
  delete() {
    this._deleteFlag = true;
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
    if (this._insertData !== undefined) {
      // Simulates invoices_booking_id_active_uniq — the one real-DB
      // constraint handleInvoiceCharges()'s idempotent-create-or-find
      // depends on.
      if (this._table === "invoices" && this._insertData.booking_id) {
        const conflict = (this._db.invoices || []).some((r) => r.booking_id === this._insertData.booking_id && r.status !== "void");
        if (conflict) {
          return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "invoices_booking_id_active_uniq"' } };
        }
      }
      const NULLABLE_DEFAULTS = {
        invoices: { invoice_number: null, due_date: null, notes: null, finalized_at: null, voided_at: null, voided_reason: null, updated_at: null, updated_by: null },
        invoice_line_items: { updated_at: null },
        job_payments: { stripe_payment_intent_id: null, stripe_refund_id: null, reverses_payment_id: null, voided_at: null, voided_reason: null, notes: null },
        rental_additional_charges: {
          quantity: null,
          rate: null,
          approved_by: null,
          approved_at: null,
          stripe_payment_intent_id: null,
          failure_reason: null,
          dispute_status: null,
          invoice_line_item_id: null,
          calculated_amount: null,
          override_reason: null,
          overridden_by: null,
          overridden_at: null,
        },
      };
      const row = Object.assign(
        { id: makeId(), created_at: "2026-10-21T12:00:00Z", updated_at: null, updated_by: null, sort_order: 0 },
        NULLABLE_DEFAULTS[this._table] || {},
        this._insertData
      );
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    if (this._upsertData !== undefined) {
      const conflictCol = this._upsertOpts.onConflict;
      const conflictVal = conflictCol ? this._upsertData[conflictCol] : undefined;
      const rows = (this._db[this._table] = this._db[this._table] || []);
      const existing = conflictCol && conflictVal != null ? rows.find((r) => r[conflictCol] === conflictVal) : null;
      if (existing && this._upsertOpts.ignoreDuplicates) {
        return { data: [], error: null };
      }
      const row = Object.assign({ id: makeId(), created_at: "2026-10-21T12:00:00Z", updated_at: null, voided_at: null, voided_reason: null, notes: null, reverses_payment_id: null, invoice_id: null, stripe_payment_intent_id: null, stripe_refund_id: null }, this._upsertData);
      rows.push(row);
      return { data: [row], error: null };
    }

    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));

    if (this._deleteFlag) {
      const toDeleteIds = new Set(filtered.map((r) => r.id));
      this._db[this._table] = (this._db[this._table] || []).filter((r) => !toDeleteIds.has(r.id));
      return { data: null, error: null };
    }

    if (this._updateData !== undefined) {
      filtered.forEach((row) => Object.assign(row, this._updateData));
    }

    this._order.forEach((o) => {
      const field = o.field;
      const asc = o.ascending;
      filtered = filtered.slice().sort((a, b) => {
        if (a[field] < b[field]) return asc ? -1 : 1;
        if (a[field] > b[field]) return asc ? 1 : -1;
        return 0;
      });
    });

    if (this._limit !== undefined && this._limit !== null) {
      filtered = filtered.slice(0, this._limit);
    }

    if (this._count && this._count.head) {
      return { data: null, count: filtered.length, error: null };
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
    async rpc(name) {
      if (name !== "next_invoice_number") throw new Error("Unexpected rpc() call in test: " + name);
      db.__invoiceSeq = (db.__invoiceSeq || 1000) + 1;
      return { data: "INV-2026-" + db.__invoiceSeq, error: null };
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

// ---------------------------------------------------------------------
// Fake Stripe — only refunds.create is exercised by this phase; swappable
// per test via refundsCreateImpl, same "module-level log + swappable impl,
// reset between tests" shape as phase3c-stage2.5v2's fake.
// ---------------------------------------------------------------------
let refundCallLog = [];
let refundsCreateImpl = null; // (params, options) => refund | throws

function makeStripeId(prefix) {
  return prefix + "_test" + String(nextId++).padStart(6, "0");
}

const fakeStripeClient = {
  refunds: {
    create: async function (params, options) {
      refundCallLog.push({ params: params, options: options });
      if (refundsCreateImpl) return refundsCreateImpl(params, options);
      return { id: makeStripeId("re"), amount: params.amount, status: "succeeded" };
    },
  },
  paymentIntents: {
    retrieve: async function () {
      throw new Error("paymentIntents.retrieve not configured in this test — no fixture ever sets invoice.activeStripePaymentIntentId");
    },
    cancel: async function () {
      throw new Error("paymentIntents.cancel not configured in this test — no fixture ever sets invoice.activeStripePaymentIntentId");
    },
  },
};

function resetStripe() {
  refundCallLog = [];
  refundsCreateImpl = null;
}

function interceptModules() {
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
    if (request === "stripe") {
      return function FakeStripe() {
        return fakeStripeClient;
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
interceptModules();

// --- env --------------------------------------------------------------
process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";
process.env.STRIPE_SECRET_KEY = "sk_test_mock";

const bookingHandler = require("../api/admin/booking.js");
const rentalPricing = require("../api/_lib/rental-pricing.js");
const { netCollectedFromLedgerRows, grossCollectedFromLedgerRows } = require("../api/_lib/job-payments-ledger.js");
const { deriveInvoiceStatus } = require("../api/_lib/invoice-helpers.js");

// ---------------------------------------------------------------------
// req/res mocks
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
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
    getHeaders: () => headers,
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
function configureAdminAuth() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-admin" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "invalid token" } }),
  });
}
function adminCookie() {
  return "mhjr_admin_at=at-admin; mhjr_admin_rt=rt-admin";
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
const CUSTOMER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RENTAL_BOOKING_ID = "11111111-1111-1111-1111-111111111111";
const PICKUP_BOOKING_ID = "22222222-2222-2222-2222-222222222222";

// INCLUDED_DAYS is 5 — delivery/pickup 5 days apart by default (no extra-day
// charge out of the box; individual tests override pickup_date when they
// need extra days). INCLUDED_TONS is 2 (4000 lbs) — actual_weight_lbs starts
// null (not yet scaled).
function freshDb() {
  return {
    customers: [{ id: CUSTOMER_ID, first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", city: "Denver" }],
    bookings: [
      { id: RENTAL_BOOKING_ID, customer_id: CUSTOMER_ID, service_type: "dumpster_rental", appointment_date: "2026-01-01" },
      { id: PICKUP_BOOKING_ID, customer_id: CUSTOMER_ID, service_type: "dumpster_pickup", appointment_date: "2026-01-06" },
    ],
    dumpster_rentals: [{ id: "dr-1", booking_id: RENTAL_BOOKING_ID, delivery_date: "2026-01-01", pickup_date: "2026-01-06", actual_weight_lbs: null }],
    rental_payments: [],
    rental_additional_charges: [],
    invoices: [],
    invoice_line_items: [],
    job_payments: [],
  };
}

function proposeCharge(db, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: adminCookie(), query: { resource: "charges" }, body: body }));
}
function patchCharges(db, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "PATCH", cookie: adminCookie(), query: { resource: "charges" }, body: body }));
}
function postJobPayment(db, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: adminCookie(), query: { resource: "job-payments" }, body: body }));
}
function patchJobPayment(db, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "PATCH", cookie: adminCookie(), query: { resource: "job-payments" }, body: body }));
}
function postInvoicePayment(db, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: adminCookie(), query: { resource: "invoice-payment" }, body: body }));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Dumpster closeout — overweight_tonnage
// =======================================================================

test("overweight: under 2 tons records the weight but creates no charge", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 3000 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge, null);
  assert.strictEqual(res.body.weightRecorded, true);
  assert.strictEqual(res.body.overweightLbs, 0);
  assert.strictEqual(db.rental_additional_charges.length, 0);
  assert.strictEqual(db.dumpster_rentals[0].actual_weight_lbs, 3000);
});

test("overweight: exactly 2 tons (4000 lbs) is the boundary — still no charge", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 4000 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge, null);
  assert.strictEqual(db.rental_additional_charges.length, 0);
});

test("overweight: fractional overweight bills the exact prorated $/ton, never rounded up to a whole ton", async () => {
  configureAdminAuth();
  const db = freshDb();
  // overweightLbs 500 -> 0.25 tons -> 0.25 * 125 = 31.25
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 4500 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.quantity, 0.25);
  assert.strictEqual(res.body.charge.rate, 125.0);
  assert.strictEqual(res.body.charge.amount, 31.25);
  assert.strictEqual(res.body.charge.status, "proposed");
});

test("overweight: multiple tons overweight bills the full multiple", async () => {
  configureAdminAuth();
  const db = freshDb();
  // overweightLbs 4000 -> 2 tons -> 2 * 125 = 250
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 8000 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.quantity, 2);
  assert.strictEqual(res.body.charge.amount, 250);
});

// 2026-10-21 rate-correction audit — the project's current overweight rate
// is $125/ton (bumped from $90/ton on 2026-09-18-v2; see
// api/_lib/rental-pricing.js's own header). These pin the exact worked
// example from that audit, plus every other boundary it called out, so a
// future accidental revert to $90 (or any other rate) fails loudly here
// rather than only being noticed by eye.
test("overweight: the exact audited example — 5,240 lb actual, 4,000 lb included, 1,240 lb over, 0.62 tons, $125/ton = $77.50", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 5240 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.overweightLbs, undefined); // only present on the no-charge/weightRecorded response shape
  assert.strictEqual(res.body.charge.quantity, 0.62);
  assert.strictEqual(res.body.charge.rate, 125.0);
  assert.strictEqual(res.body.charge.amount, 77.5);
});

test("overweight: 6,000 lb actual = 1 ton over * $125/ton = $125.00 exactly", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 6000 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.quantity, 1);
  assert.strictEqual(res.body.charge.rate, 125.0);
  assert.strictEqual(res.body.charge.amount, 125.0);
});

test("overweight: below the included 4,000 lb (e.g. 3,999 lb) is $0 — no charge row, weight still recorded", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 3999 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge, null);
  assert.strictEqual(res.body.weightRecorded, true);
  assert.strictEqual(db.rental_additional_charges.length, 0);
});

test("overweight: fractional-pound precision is preserved exactly — 1 lb over bills $0.06 (rounded from $0.0625), never $0.00 or $0.07", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 4001 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.quantity, 0.0005);
  assert.strictEqual(res.body.charge.amount, 0.06);
});

test("api/_lib/rental-pricing.js: OVERAGE_TON_RATE is $125.00, not the superseded $90.00 rate", () => {
  assert.strictEqual(rentalPricing.OVERAGE_TON_RATE, 125.0);
});

// =======================================================================
// Dumpster closeout — additional_days
// =======================================================================

test("additional_days: within the included 5 days (exact boundary) creates no charge", async () => {
  configureAdminAuth();
  const db = freshDb(); // delivery 2026-01-01, pickup 2026-01-06 -> exactly 5 days
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "additional_days" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge, null);
  assert.strictEqual(res.body.extraDaysRecorded, true);
  assert.strictEqual(res.body.extraDays, 0);
  assert.strictEqual(db.rental_additional_charges.length, 0);
});

test("additional_days: extra days are computed from delivery/pickup dates, and a client-submitted quantity is ignored entirely", async () => {
  configureAdminAuth();
  const db = freshDb();
  db.dumpster_rentals[0].pickup_date = "2026-01-09"; // 8 days total -> 3 extra days -> 3 * 15 = 45
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "additional_days", quantity: 999 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.quantity, 3, "quantity must come from the date diff, not the client-submitted 999");
  assert.strictEqual(res.body.charge.rate, 15.0);
  assert.strictEqual(res.body.charge.amount, 45);
});

test("additional_days: a request body with NO quantity field at all works identically — the server never requires one", async () => {
  configureAdminAuth();
  const db = freshDb();
  db.dumpster_rentals[0].pickup_date = "2026-01-09";
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "additional_days" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.quantity, 3);
  assert.strictEqual(res.body.charge.amount, 45);
});

// =======================================================================
// Weight + extra days both charged on the same booking
// =======================================================================

test("a booking can carry both an overweight_tonnage charge AND an additional_days charge without either interfering with the other's math", async () => {
  configureAdminAuth();
  const db = freshDb();
  db.dumpster_rentals[0].pickup_date = "2026-01-09"; // 3 extra days -> $45

  const daysRes = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "additional_days" });
  assert.strictEqual(daysRes.statusCode, 200);
  assert.strictEqual(daysRes.body.charge.amount, 45);

  const weightRes = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 8000 }); // 2 tons -> $250
  assert.strictEqual(weightRes.statusCode, 200);
  assert.strictEqual(weightRes.body.charge.amount, 250);

  assert.strictEqual(db.rental_additional_charges.length, 2);
  const daysRow = db.rental_additional_charges.find((c) => c.charge_type === "additional_days");
  const weightRow = db.rental_additional_charges.find((c) => c.charge_type === "overweight_tonnage");
  assert.strictEqual(daysRow.amount, 45, "the days charge must be unaffected by the later weight charge");
  assert.strictEqual(weightRow.amount, 250, "the weight charge must be unaffected by the earlier days charge");
});

// =======================================================================
// Flat charge types: relocation / blocked_pickup / rule_violation / other
// =======================================================================

["relocation", "blocked_pickup", "rule_violation"].forEach((chargeType) => {
  test("flat charge type '" + chargeType + "' creates a charge exactly like 'other' does", async () => {
    configureAdminAuth();
    const db = freshDb();
    const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: chargeType, amount: 75, description: "Test description for " + chargeType });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.charge.chargeType, chargeType);
    assert.strictEqual(res.body.charge.amount, 75);
    assert.strictEqual(res.body.charge.status, "proposed");
    assert.strictEqual(res.body.charge.quantity, null, "flat types never get a rate-based quantity");
    assert.strictEqual(res.body.charge.rate, null);
  });
});

test("a custom ('other') charge is a flat, admin-entered amount requiring a description", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "other", amount: 42.5, description: "Disposal of a mattress found on-site" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.chargeType, "other");
  assert.strictEqual(res.body.charge.amount, 42.5);
});

test("a flat-type charge with no description is rejected", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "relocation", amount: 50 });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.rental_additional_charges.length, 0);
});

// =======================================================================
// Override (overrideAmount / overrideReason audit trail)
// =======================================================================

test("override: proposing overweight_tonnage with overrideAmount stores the override as amount, preserves the computed value as calculatedAmount, and stamps the audit trail", async () => {
  configureAdminAuth();
  const db = freshDb();
  // Computed amount would be 2 tons * 125 = 250; override to 300.
  const res = await proposeCharge(db, {
    bookingId: RENTAL_BOOKING_ID,
    chargeType: "overweight_tonnage",
    actualWeightLbs: 8000,
    overrideAmount: 300,
    overrideReason: "Customer negotiated a flat rate",
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.amount, 300, "amount actually billed must be the override");
  assert.strictEqual(res.body.charge.calculatedAmount, 250, "the original formula result must be preserved for history");
  assert.strictEqual(res.body.charge.overrideReason, "Customer negotiated a flat rate");
  assert.strictEqual(res.body.charge.overriddenBy, ADMIN_EMAIL);
  assert.ok(res.body.charge.overriddenAt, "overriddenAt must be stamped");
});

test("override: an override can rescue an otherwise-zero additional_days charge (within included days, but admin overrides to bill anyway)", async () => {
  configureAdminAuth();
  const db = freshDb(); // exactly 5 days -> computed amount 0
  const res = await proposeCharge(db, {
    bookingId: RENTAL_BOOKING_ID,
    chargeType: "additional_days",
    overrideAmount: 25,
    overrideReason: "Customer was late picking up personal items, dumpster blocked an extra half-day",
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.charge, "an override must create a real charge row even though the computed amount was 0");
  assert.strictEqual(res.body.charge.amount, 25);
  assert.strictEqual(res.body.charge.calculatedAmount, 0);
});

// =======================================================================
// Duplicate-charge prevention (Part 10 / hasActiveChargeOfType)
// =======================================================================

test("duplicate-charge prevention: a second propose of overweight_tonnage while an earlier non-voided one exists is rejected with 409, but succeeds once that one is voided", async () => {
  configureAdminAuth();
  const db = freshDb();

  const first = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 8000 });
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(db.rental_additional_charges.length, 1);

  const second = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 6000 });
  assert.strictEqual(second.statusCode, 409);
  assert.strictEqual(db.rental_additional_charges.length, 1, "the rejected propose must not create a second row");

  // Void the first charge directly (this codebase has no exposed "void a
  // charge" endpoint in this file — only the status value itself gates
  // hasActiveChargeOfType()).
  db.rental_additional_charges[0].status = "voided";

  const third = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "overweight_tonnage", actualWeightLbs: 6000 });
  assert.strictEqual(third.statusCode, 200, "proposing again must be allowed once the earlier charge of the same type is voided");
  assert.strictEqual(db.rental_additional_charges.length, 2);
});

test("duplicate-charge prevention: additional_days follows the same rule as overweight_tonnage", async () => {
  configureAdminAuth();
  const db = freshDb();
  db.dumpster_rentals[0].pickup_date = "2026-01-09";

  const first = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "additional_days" });
  assert.strictEqual(first.statusCode, 200);

  const second = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "additional_days" });
  assert.strictEqual(second.statusCode, 409);

  db.rental_additional_charges[0].status = "voided";
  const third = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "additional_days" });
  assert.strictEqual(third.statusCode, 200);
});

test("duplicate-charge prevention does NOT apply to flat charge types — multiple relocation charges on one booking are all allowed", async () => {
  configureAdminAuth();
  const db = freshDb();
  const first = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "relocation", amount: 50, description: "First move" });
  const second = await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "relocation", amount: 60, description: "Second move" });
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(db.rental_additional_charges.length, 2);
});

// =======================================================================
// handleInvoiceCharges — "Create Final Charges"
// =======================================================================

test("invoice charges: proposed charges become real invoice_line_items rows, total_amount is recomputed, and charges flip to 'invoiced'", async () => {
  configureAdminAuth();
  const db = freshDb();
  await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "other", amount: 100, description: "Extra disposal fee" });

  const res = await patchCharges(db, { action: "invoice", bookingId: RENTAL_BOOKING_ID });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.invoice.totalAmount, 100);
  assert.strictEqual(res.body.lineItems.length, 1);
  assert.strictEqual(res.body.charges.length, 1);
  assert.strictEqual(res.body.charges[0].status, "invoiced");
  assert.ok(res.body.charges[0].invoiceLineItemId);

  assert.strictEqual(db.rental_additional_charges[0].status, "invoiced");
  assert.strictEqual(db.invoice_line_items.length, 1);
  assert.strictEqual(db.invoice_line_items[0].amount, 100);
});

test("invoice charges: a double-call with nothing left proposed is a clean no-op — it does not duplicate line items or corrupt the invoice", async () => {
  configureAdminAuth();
  const db = freshDb();
  await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "other", amount: 100, description: "Extra disposal fee" });
  const first = await patchCharges(db, { action: "invoice", bookingId: RENTAL_BOOKING_ID });
  assert.strictEqual(first.statusCode, 200);

  const second = await patchCharges(db, { action: "invoice", bookingId: RENTAL_BOOKING_ID });
  assert.strictEqual(second.statusCode, 400, "nothing proposed left to invoice is reported, not silently treated as success");

  // State must be unchanged by the no-op second call.
  assert.strictEqual(db.invoice_line_items.length, 1);
  assert.strictEqual(db.invoices[0].total_amount, 100);
  assert.strictEqual(db.rental_additional_charges[0].status, "invoiced");
});

test("invoice charges: a dumpster_pickup booking id is rejected, never invoiced", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await patchCharges(db, { action: "invoice", bookingId: PICKUP_BOOKING_ID });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.invoices.length, 0);
  assert.strictEqual(db.invoice_line_items.length, 0);
});

test("invoice charges: appending new charges to an already-finalized, already-fully-paid invoice correctly bumps total_amount so the balance is no longer zero", async () => {
  configureAdminAuth();
  const db = freshDb();
  await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "other", amount: 100, description: "First charge" });
  const firstInvoiceRes = await patchCharges(db, { action: "invoice", bookingId: RENTAL_BOOKING_ID });
  assert.strictEqual(firstInvoiceRes.statusCode, 200);
  assert.strictEqual(firstInvoiceRes.body.invoice.status, "finalized", "a brand-new invoice auto-finalizes");
  const invoiceId = firstInvoiceRes.body.invoice.id;
  assert.strictEqual(firstInvoiceRes.body.invoice.totalAmount, 100);

  // Pay it off in full (seeded directly — a manual-payment row attributed
  // to this invoice; this phase's refund tests exercise the ?resource=
  // job-payments/?resource=invoice-payment write paths themselves, this
  // test only needs an existing fully-paid invoice to append onto).
  db.job_payments.push({
    id: "33333333-3333-3333-3333-333333333331",
    booking_id: RENTAL_BOOKING_ID,
    invoice_id: invoiceId,
    amount: 100,
    payment_method: "cash",
    payment_type: "payment",
    payment_date: "2026-01-02",
    voided_at: null,
  });
  const netBefore = netCollectedFromLedgerRows(db.job_payments.filter((p) => !p.voided_at));
  assert.strictEqual(netBefore, 100);
  const balanceBefore = Math.max(Math.round((100 - netBefore) * 100) / 100, 0);
  assert.strictEqual(balanceBefore, 0, "sanity check: the invoice is indeed fully paid before the new charge is appended");

  // Now a second closeout charge comes in and gets added to the SAME
  // already-finalized invoice.
  await proposeCharge(db, { bookingId: RENTAL_BOOKING_ID, chargeType: "other", amount: 60, description: "Second charge, found after closeout" });
  const secondInvoiceRes = await patchCharges(db, { action: "invoice", bookingId: RENTAL_BOOKING_ID });
  assert.strictEqual(secondInvoiceRes.statusCode, 200);
  assert.strictEqual(secondInvoiceRes.body.invoice.id, invoiceId, "must append to the SAME invoice, not create a second one");
  assert.strictEqual(secondInvoiceRes.body.invoice.totalAmount, 160);
  assert.strictEqual(secondInvoiceRes.body.invoice.status, "finalized", "an already-finalized invoice is left finalized, never reverted to draft");

  const netAfter = netCollectedFromLedgerRows(db.job_payments.filter((p) => !p.voided_at));
  assert.strictEqual(netAfter, 100, "the collected amount is unchanged by appending a charge");
  const balanceAfter = Math.max(Math.round((160 - netAfter) * 100) / 100, 0);
  assert.strictEqual(balanceAfter, 60, "the new balance due reflects the appended charge — this invoice is now only PARTIALLY paid, not fully paid");

  const derived = deriveInvoiceStatus({ status: "finalized", totalAmount: 160, dueDate: null }, netAfter, "2026-01-05", 100);
  assert.strictEqual(derived.displayStatus, "partially_paid", "deriveInvoiceStatus must now report partially_paid, not paid, after the total_amount bump");
});

// =======================================================================
// Refunds — Stripe-backed path (handleRefundJobPayment)
// =======================================================================

function seedStripePayment(db, overrides) {
  const row = Object.assign(
    {
      id: "33333333-3333-3333-3333-333333333332",
      booking_id: RENTAL_BOOKING_ID,
      invoice_id: null,
      amount: 349,
      payment_method: "card_stripe",
      payment_type: "payment",
      stripe_payment_intent_id: "pi_original_1",
      payment_date: "2026-01-01",
      notes: null,
      reverses_payment_id: null,
      voided_at: null,
      voided_reason: null,
    },
    overrides || {}
  );
  db.job_payments.push(row);
  return row;
}

test("refund: a full Stripe refund produces a job_payments row with payment_type 'refund', stripe_refund_id set, and reverses_payment_id pointing at the original", async () => {
  configureAdminAuth();
  resetStripe();
  const db = freshDb();
  const original = seedStripePayment(db, { amount: 349 });

  const res = await patchJobPayment(db, { action: "refund", paymentId: original.id, amount: 349, reason: "Customer cancelled after the fact", clientRequestId: "req-1" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobPayment.paymentType, "refund");
  assert.ok(res.body.jobPayment.stripeRefundId);
  assert.strictEqual(res.body.jobPayment.reversesPaymentId, original.id);
  assert.strictEqual(res.body.jobPayment.amount, 349);
  assert.strictEqual(refundCallLog.length, 1);
  assert.strictEqual(db.job_payments.length, 2);
});

test("refund: a partial Stripe refund succeeds for an amount less than the original payment", async () => {
  configureAdminAuth();
  resetStripe();
  const db = freshDb();
  const original = seedStripePayment(db, { amount: 349 });

  const res = await patchJobPayment(db, { action: "refund", paymentId: original.id, amount: 100, reason: "Partial dissatisfaction credit", clientRequestId: "req-1" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobPayment.amount, 100);
  assert.strictEqual(db.job_payments.length, 2);
});

test("refund: multiple partial Stripe refunds that together exactly exhaust the refundable balance all succeed", async () => {
  configureAdminAuth();
  resetStripe();
  const db = freshDb();
  const original = seedStripePayment(db, { amount: 349 });

  const first = await patchJobPayment(db, { action: "refund", paymentId: original.id, amount: 200, reason: "First partial refund", clientRequestId: "req-1" });
  assert.strictEqual(first.statusCode, 200);

  const second = await patchJobPayment(db, { action: "refund", paymentId: original.id, amount: 149, reason: "Second partial refund, exhausts the balance", clientRequestId: "req-2" });
  assert.strictEqual(second.statusCode, 200);

  assert.strictEqual(db.job_payments.length, 3);
  assert.strictEqual(refundCallLog.length, 2);
});

test("refund: a refund attempt exceeding the remaining refundable balance is rejected BEFORE any Stripe call is made — the fake Stripe's call log is empty", async () => {
  configureAdminAuth();
  resetStripe();
  const db = freshDb();
  const original = seedStripePayment(db, { amount: 349 });

  const over = await patchJobPayment(db, { action: "refund", paymentId: original.id, amount: 400, reason: "Exceeds the entire $349 original payment", clientRequestId: "req-1" });
  assert.strictEqual(over.statusCode, 400);
  assert.strictEqual(refundCallLog.length, 0, "the over-limit attempt must never reach Stripe at all");
  assert.strictEqual(db.job_payments.length, 1, "only the original seeded payment — no refund row was written");
});

test("refund: a SECOND refund attempt that exceeds the REMAINING balance (after an earlier valid partial refund) is also rejected before any further Stripe call", async () => {
  configureAdminAuth();
  resetStripe();
  const db = freshDb();
  const original = seedStripePayment(db, { amount: 349 });
  await patchJobPayment(db, { action: "refund", paymentId: original.id, amount: 300, reason: "First refund", clientRequestId: "req-1" });
  assert.strictEqual(refundCallLog.length, 1);

  const over = await patchJobPayment(db, { action: "refund", paymentId: original.id, amount: 100, reason: "Second refund, exceeds remaining $49 balance", clientRequestId: "req-2" });
  assert.strictEqual(over.statusCode, 400);
  assert.strictEqual(refundCallLog.length, 1, "the over-limit attempt must never reach Stripe at all — call log count stays exactly where the first, valid refund left it");
  assert.strictEqual(db.job_payments.length, 2, "only the first, valid refund was recorded");
});

test("refund: if the Stripe call itself throws/rejects, no job_payments row is written at all", async () => {
  configureAdminAuth();
  resetStripe();
  const db = freshDb();
  const original = seedStripePayment(db, { amount: 349 });
  const lengthBefore = db.job_payments.length;

  refundsCreateImpl = async () => {
    throw new Error("Your card was declined / network error.");
  };

  const res = await patchJobPayment(db, { action: "refund", paymentId: original.id, amount: 100, reason: "Attempted refund during a Stripe outage", clientRequestId: "req-1" });
  assert.strictEqual(res.statusCode, 402);
  assert.strictEqual(db.job_payments.length, lengthBefore, "a failed Stripe call must never produce a ledger row");
});

test("refund: the original payment row is never mutated by the Stripe refund path", async () => {
  configureAdminAuth();
  resetStripe();
  const db = freshDb();
  const original = seedStripePayment(db, { amount: 349 });
  const snapshotBefore = JSON.stringify(original);

  await patchJobPayment(db, { action: "refund", paymentId: original.id, amount: 100, reason: "Partial refund", clientRequestId: "req-1" });

  const afterRow = db.job_payments.find((p) => p.id === original.id);
  assert.strictEqual(JSON.stringify(afterRow), snapshotBefore, "the original row must be byte-for-byte unchanged after a refund against it");
});

// =======================================================================
// Refunds — manual path (?resource=job-payments / ?resource=invoice-payment)
// =======================================================================

test("manual refund: succeeds when both reversesPaymentId and confirmedExternalReturn:true are present", async () => {
  configureAdminAuth();
  const db = freshDb();
  const original = { id: "33333333-3333-3333-3333-333333333341", booking_id: RENTAL_BOOKING_ID, invoice_id: null, amount: 200, payment_method: "cash", payment_type: "payment", payment_date: "2026-01-01", voided_at: null };
  db.job_payments.push(original);

  const res = await postJobPayment(db, {
    bookingId: RENTAL_BOOKING_ID,
    paymentMethod: "cash",
    paymentType: "refund",
    amount: 200,
    reversesPaymentId: original.id,
    confirmedExternalReturn: true,
    notes: "Returned cash to the customer outside the system",
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobPayment.paymentType, "refund");
  assert.strictEqual(res.body.jobPayment.reversesPaymentId, original.id);
});

test("manual refund: rejected when reversesPaymentId is missing", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await postJobPayment(db, { bookingId: RENTAL_BOOKING_ID, paymentMethod: "cash", paymentType: "refund", amount: 200, confirmedExternalReturn: true });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.job_payments.length, 0);
});

test("manual refund: rejected when confirmedExternalReturn is missing even though reversesPaymentId is present", async () => {
  configureAdminAuth();
  const db = freshDb();
  const original = { id: "33333333-3333-3333-3333-333333333342", booking_id: RENTAL_BOOKING_ID, invoice_id: null, amount: 200, payment_method: "cash", payment_type: "payment", payment_date: "2026-01-01", voided_at: null };
  db.job_payments.push(original);

  const res = await postJobPayment(db, { bookingId: RENTAL_BOOKING_ID, paymentMethod: "cash", paymentType: "refund", amount: 200, reversesPaymentId: original.id });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.job_payments.length, 1, "only the original seeded row — no refund row created");
});

test("manual refund: rejected when confirmedExternalReturn is present but not literally true", async () => {
  configureAdminAuth();
  const db = freshDb();
  const original = { id: "33333333-3333-3333-3333-333333333343", booking_id: RENTAL_BOOKING_ID, invoice_id: null, amount: 200, payment_method: "cash", payment_type: "payment", payment_date: "2026-01-01", voided_at: null };
  db.job_payments.push(original);

  const res = await postJobPayment(db, {
    bookingId: RENTAL_BOOKING_ID,
    paymentMethod: "cash",
    paymentType: "refund",
    amount: 200,
    reversesPaymentId: original.id,
    confirmedExternalReturn: "yes",
  });
  assert.strictEqual(res.statusCode, 400);
});

test("manual refund: also respects the refundable-balance bound, same as the Stripe path", async () => {
  configureAdminAuth();
  const db = freshDb();
  const original = { id: "33333333-3333-3333-3333-333333333344", booking_id: RENTAL_BOOKING_ID, invoice_id: null, amount: 200, payment_method: "cash", payment_type: "payment", payment_date: "2026-01-01", voided_at: null };
  db.job_payments.push(original);

  const res = await postJobPayment(db, {
    bookingId: RENTAL_BOOKING_ID,
    paymentMethod: "cash",
    paymentType: "refund",
    amount: 250,
    reversesPaymentId: original.id,
    confirmedExternalReturn: true,
  });
  assert.strictEqual(res.statusCode, 400);
});

test("manual refund via the invoice-payment path also requires both fields, and succeeds against an invoice-attributed payment", async () => {
  configureAdminAuth();
  const db = freshDb();
  const invoiceId = "44444444-4444-4444-4444-444444444441";
  db.invoices.push({
    id: invoiceId,
    booking_id: RENTAL_BOOKING_ID,
    customer_id: CUSTOMER_ID,
    status: "finalized",
    total_amount: 150,
    due_date: "2026-02-01",
    invoice_number: "INV-2026-9001",
    active_stripe_payment_intent_id: null,
    payment_claim_token: null,
    payment_claimed_at: null,
    payment_generation: 1,
    notes: null,
    finalized_at: "2026-01-02T00:00:00Z",
    voided_at: null,
    voided_reason: null,
  });
  const original = { id: "33333333-3333-3333-3333-333333333345", booking_id: RENTAL_BOOKING_ID, invoice_id: invoiceId, amount: 150, payment_method: "cash", payment_type: "payment", payment_date: "2026-01-02", voided_at: null };
  db.job_payments.push(original);

  const missingConfirm = await postInvoicePayment(db, { invoiceId: invoiceId, paymentMethod: "cash", paymentType: "refund", amount: 150, reversesPaymentId: original.id });
  assert.strictEqual(missingConfirm.statusCode, 400);

  const ok = await postInvoicePayment(db, { invoiceId: invoiceId, paymentMethod: "cash", paymentType: "refund", amount: 150, reversesPaymentId: original.id, confirmedExternalReturn: true });
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(ok.body.jobPayment.paymentType, "refund");
  assert.strictEqual(ok.body.jobPayment.invoiceId, invoiceId);
});

// =======================================================================
// Net collected after a refund (netCollectedFromLedgerRows integration)
// =======================================================================

test("net collected is correct after a Stripe refund: original amount minus the refund amount", async () => {
  configureAdminAuth();
  resetStripe();
  const db = freshDb();
  const original = seedStripePayment(db, { amount: 349 });
  await patchJobPayment(db, { action: "refund", paymentId: original.id, amount: 100, reason: "Partial refund", clientRequestId: "req-1" });

  const net = netCollectedFromLedgerRows(db.job_payments.filter((p) => !p.voided_at).map((p) => ({ amount: p.amount, payment_type: p.payment_type })));
  assert.strictEqual(net, 249);
});

// =======================================================================
// Fully / partially refunded display status
// =======================================================================

test("fully refunded: grossCollectedFromLedgerRows > 0 and netCollectedFromLedgerRows <= 0, and deriveInvoiceStatus reports 'refunded'", async () => {
  const rows = [
    { amount: 349, payment_type: "payment" },
    { amount: 349, payment_type: "refund" },
  ];
  const gross = grossCollectedFromLedgerRows(rows);
  const net = netCollectedFromLedgerRows(rows);
  assert.ok(gross > 0);
  assert.ok(net <= 0);

  const derived = deriveInvoiceStatus({ status: "finalized", totalAmount: 349, dueDate: null }, net, "2026-01-05", gross);
  assert.strictEqual(derived.displayStatus, "refunded");
});

test("partially refunded: displayStatus is 'partially_paid', not 'paid'", async () => {
  const rows = [
    { amount: 349, payment_type: "payment" },
    { amount: 100, payment_type: "refund" },
  ];
  const gross = grossCollectedFromLedgerRows(rows);
  const net = netCollectedFromLedgerRows(rows);
  assert.strictEqual(gross, 349);
  assert.strictEqual(net, 249);

  const derived = deriveInvoiceStatus({ status: "finalized", totalAmount: 349, dueDate: null }, net, "2026-01-05", gross);
  assert.strictEqual(derived.displayStatus, "partially_paid");
});

test("fully refunded end-to-end via the real refund handler, on an invoice-attributed payment", async () => {
  configureAdminAuth();
  resetStripe();
  const db = freshDb();
  const invoiceId = "44444444-4444-4444-4444-444444444442";
  db.invoices.push({
    id: invoiceId,
    booking_id: RENTAL_BOOKING_ID,
    customer_id: CUSTOMER_ID,
    status: "finalized",
    total_amount: 349,
    due_date: "2026-02-01",
    invoice_number: "INV-2026-9002",
    active_stripe_payment_intent_id: null,
    payment_claim_token: null,
    payment_claimed_at: null,
    payment_generation: 1,
    notes: null,
    finalized_at: "2026-01-02T00:00:00Z",
    voided_at: null,
    voided_reason: null,
  });
  const original = seedStripePayment(db, { id: "33333333-3333-3333-3333-333333333346", amount: 349, invoice_id: invoiceId });

  const res = await patchJobPayment(db, { action: "refund", paymentId: original.id, amount: 349, reason: "Full refund, invoice fully reversed", clientRequestId: "req-1" });
  assert.strictEqual(res.statusCode, 200);

  const rows = db.job_payments.filter((p) => !p.voided_at).map((p) => ({ amount: p.amount, payment_type: p.payment_type }));
  const gross = grossCollectedFromLedgerRows(rows);
  const net = netCollectedFromLedgerRows(rows);
  assert.strictEqual(gross, 349);
  assert.strictEqual(net, 0);

  const derived = deriveInvoiceStatus({ status: "finalized", totalAmount: 349, dueDate: null }, net, "2026-01-05", gross);
  assert.strictEqual(derived.displayStatus, "refunded");
});

// =======================================================================
// Metrics — direct unit tests, no DB
// =======================================================================

test("metrics: a refund decreases netCollectedFromLedgerRows's result", async () => {
  const beforeRefund = netCollectedFromLedgerRows([{ amount: 100, payment_type: "payment" }]);
  const afterRefund = netCollectedFromLedgerRows([
    { amount: 100, payment_type: "payment" },
    { amount: 30, payment_type: "refund" },
  ]);
  assert.strictEqual(beforeRefund, 100);
  assert.strictEqual(afterRefund, 70);
  assert.ok(afterRefund < beforeRefund);
});

test("metrics: grossCollectedFromLedgerRows ignores refund rows entirely", async () => {
  const gross = grossCollectedFromLedgerRows([
    { amount: 100, payment_type: "payment" },
    { amount: 30, payment_type: "refund" },
    { amount: 50, payment_type: "payment" },
  ]);
  assert.strictEqual(gross, 150, "only the two 'payment' rows should be summed — the refund row must never reduce (or inflate) gross");
});

// =======================================================================
// dumpster_pickup bookings never get a rental_additional_charges row
// =======================================================================

test("a dumpster_pickup booking is rejected by handleProposeCharge — it never gets a rental_additional_charges row", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await proposeCharge(db, { bookingId: PICKUP_BOOKING_ID, chargeType: "other", amount: 50, description: "Should never be created" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.rental_additional_charges.length, 0);
});

test("a dumpster_pickup booking is also rejected by handleInvoiceCharges", async () => {
  configureAdminAuth();
  const db = freshDb();
  const res = await patchCharges(db, { action: "invoice", bookingId: PICKUP_BOOKING_ID });
  assert.strictEqual(res.statusCode, 400);
});

// ---------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of registered) {
    try {
      await fn();
      passed++;
      console.log("PASS - " + name);
    } catch (err) {
      failed++;
      console.log("FAIL - " + name);
      console.log("  " + (err && err.stack ? err.stack : err));
    }
  }
  console.log("\n" + (passed + failed) + " tests run, " + failed + " failed.");
  if (failed > 0) process.exitCode = 1;
})();
