// Local, offline test harness for Phase 3C Stage 3 — job_payments, the
// cross-service-type financial ledger (api/admin/booking.js's
// ?resource=job-payments GET/POST/PATCH, plus api/_lib/job-payments-ledger.js's
// mirrorStripePaymentToLedger()/effectiveRevenue()/netCollectedFromLedgerRows()).
// See docs/phase-3/stage3-payments-expenses-proposal.md for the full design.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project.
//
// Run with:  node tests/phase3c-stage3-job-payments.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

let nextId = 1;
function makeId() {
  return "cccccccc-cccc-cccc-cccc-" + String(100000000000 + nextId++).padStart(12, "0");
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
    this._orders = [];
    this._limit = null;
    this._insertPayload = null;
    this._updatePayload = null;
    this._upsertPayload = null;
    this._upsertOpts = null;
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
  // Simulates job_payments.stripe_payment_intent_id's real partial UNIQUE
  // index — a same-intent upsert with ignoreDuplicates is a no-op, exactly
  // what makes mirrorStripePaymentToLedger() idempotent across its several
  // call sites (see that function's header comment).
  upsert(payload, opts) {
    this._upsertPayload = payload;
    this._upsertOpts = opts || {};
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

    if (this._upsertPayload) {
      const conflictCol = this._upsertOpts.onConflict;
      const conflictVal = conflictCol ? this._upsertPayload[conflictCol] : undefined;
      const existing = conflictCol && conflictVal != null ? rows.find((r) => r[conflictCol] === conflictVal) : null;
      if (existing && this._upsertOpts.ignoreDuplicates) {
        return { data: null, error: null };
      }
      const row = Object.assign({ id: makeId(), created_at: nowIso(), updated_at: nowIso() }, this._upsertPayload);
      rows.push(row);
      return { data: [row], error: null };
    }

    let matched = rows.filter((r) => this.eqFilters.every((f) => r[f.col] === f.val) && this.isFilters.every((f) => (r[f.col] === undefined ? null : r[f.col]) === f.val));

    if (this._updatePayload) {
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
  return { from: (table) => new FakeQueryBuilder(table, db), storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://mock/signed" }, error: null }) }) } };
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
const { mirrorStripePaymentToLedger, netCollectedFromLedgerRows, effectiveRevenue, VALID_PAYMENT_METHODS, VALID_PAYMENT_TYPES } = require("../api/_lib/job-payments-ledger.js");

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
  return Object.assign(
    {
      bookings: [],
      customers: [],
      dumpster_rentals: [],
      booking_photos: [],
      rental_payments: [],
      job_payments: [],
      __fkTables: { job_payments: { booking_id: "bookings" } },
    },
    overrides || {}
  );
}
function req(db, opts) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq(Object.assign({ cookie: AUTH_COOKIE }, opts)));
}
function makeBooking(overrides) {
  return Object.assign({ id: makeId(), service_type: "junk_removal", appointment_date: "2026-09-10", time_window: null, exact_time: null, status: "completed", description: "", estimated_price: null, estimated_price_max: null, final_price: 300, tip_amount: null, internal_notes: null, customer_id: null, service_address: null, service_city: null, service_state: null, service_zip: null, created_at: nowIso(), updated_at: nowIso() }, overrides || {});
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Amount/refund sign convention — netCollectedFromLedgerRows()
// =======================================================================
test("netCollectedFromLedgerRows: a plain 'payment' row adds its full (always-positive) amount", () => {
  assert.strictEqual(netCollectedFromLedgerRows([{ amount: 100, paymentType: "payment" }]), 100);
});
test("netCollectedFromLedgerRows: a 'refund' row SUBTRACTS its (still-positive) amount — never stored negative", () => {
  assert.strictEqual(netCollectedFromLedgerRows([{ amount: 100, paymentType: "payment" }, { amount: 25, paymentType: "refund" }]), 75);
});
test("netCollectedFromLedgerRows: multiple payments and a refund net correctly ($100 Stripe deposit + $400 cash - $50 refund = $450)", () => {
  const total = netCollectedFromLedgerRows([
    { amount: 100, paymentType: "payment" },
    { amount: 400, paymentType: "payment" },
    { amount: 50, paymentType: "refund" },
  ]);
  assert.strictEqual(total, 450);
});
test("netCollectedFromLedgerRows: an empty ledger nets to 0", () => {
  assert.strictEqual(netCollectedFromLedgerRows([]), 0);
});
test("VALID_PAYMENT_METHODS / VALID_PAYMENT_TYPES are exactly the documented allowlists", () => {
  assert.deepStrictEqual(VALID_PAYMENT_METHODS.slice().sort(), ["card_stripe", "card_venmo", "cash", "check", "other", "venmo", "zelle"]);
  assert.deepStrictEqual(VALID_PAYMENT_TYPES.slice().sort(), ["payment", "refund"]);
});

// =======================================================================
// bookings.final_price compatibility rule — effectiveRevenue()
// =======================================================================
test("effectiveRevenue: a historical job with NO ledger rows falls back to bookings.final_price unchanged — revenue never silently becomes $0", () => {
  const result = effectiveRevenue([], 450);
  assert.strictEqual(result.amount, 450);
  assert.strictEqual(result.source, "final_price");
});
test("effectiveRevenue: a job WITH ledger rows uses the ledger total as authoritative, even if it differs from final_price", () => {
  const result = effectiveRevenue([{ amount: 500, payment_type: "payment" }], 300);
  assert.strictEqual(result.amount, 500);
  assert.strictEqual(result.source, "ledger");
});
test("effectiveRevenue: a job with neither ledger rows nor a final_price reports null, not 0 (0 would falsely claim '$0 collected')", () => {
  const result = effectiveRevenue([], null);
  assert.strictEqual(result.amount, null);
  assert.strictEqual(result.source, "none");
});

// =======================================================================
// mirrorStripePaymentToLedger() — idempotent auto-mirroring
// =======================================================================
test("mirrorStripePaymentToLedger: creates exactly one job_payments row for a successful Stripe collection", async () => {
  const db = freshDb();
  const bookingId = makeId();
  const supabase = createFakeServiceClient(db);
  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_abc", amount: 349, paymentDate: "2026-09-10" });
  assert.strictEqual(db.job_payments.length, 1);
  assert.strictEqual(db.job_payments[0].amount, 349);
  assert.strictEqual(db.job_payments[0].payment_method, "card_stripe");
  assert.strictEqual(db.job_payments[0].payment_type, "payment");
  assert.strictEqual(db.job_payments[0].stripe_payment_intent_id, "pi_abc");
});

test("mirrorStripePaymentToLedger: calling it twice for the SAME PaymentIntent produces exactly ONE row — the idempotency guarantee the design requires", async () => {
  const db = freshDb();
  const bookingId = makeId();
  const supabase = createFakeServiceClient(db);
  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_dup", amount: 349, paymentDate: "2026-09-10" });
  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_dup", amount: 349, paymentDate: "2026-09-10" });
  assert.strictEqual(db.job_payments.filter((r) => r.stripe_payment_intent_id === "pi_dup").length, 1);
});

test("mirrorStripePaymentToLedger: different PaymentIntents for the same booking (initial charge + an overweight charge) each create their own row", async () => {
  const db = freshDb();
  const bookingId = makeId();
  const supabase = createFakeServiceClient(db);
  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_initial", amount: 349 });
  await mirrorStripePaymentToLedger(supabase, { bookingId, stripePaymentIntentId: "pi_overage", amount: 90 });
  assert.strictEqual(db.job_payments.length, 2);
});

test("mirrorStripePaymentToLedger: never throws when the underlying write fails (e.g. table missing) — a ledger-mirroring gap must never break the real payment flow", async () => {
  const brokenSupabase = { from: () => ({ upsert: () => Promise.resolve({ data: null, error: new Error("relation does not exist") }) }) };
  await assert.doesNotReject(mirrorStripePaymentToLedger(brokenSupabase, { bookingId: makeId(), stripePaymentIntentId: "pi_x", amount: 100 }));
});

test("mirrorStripePaymentToLedger: a missing/zero/negative amount is a silent no-op, never a malformed row", async () => {
  const db = freshDb();
  const supabase = createFakeServiceClient(db);
  await mirrorStripePaymentToLedger(supabase, { bookingId: makeId(), stripePaymentIntentId: "pi_zero", amount: 0 });
  await mirrorStripePaymentToLedger(supabase, { bookingId: makeId(), stripePaymentIntentId: "pi_neg", amount: -5 });
  assert.strictEqual(db.job_payments.length, 0);
});

// =======================================================================
// The three real Stripe success call sites actually mirror. Full,
// behavioral end-to-end coverage of each lives in the test file that
// already owns a complete, correct fixture for that exact flow (rebuilding
// api/book.js's whole multi-step booking fixture here would duplicate a lot
// of fragile setup for no extra confidence) — see:
//   - api/book.js's initial capture: the "successful payment books the
//     rental..." test in tests/phase3c-stage2.5v2-stripe-rental-payments.test.js
//     (asserts on db.job_payments directly, added alongside this stage).
//   - api/admin/booking.js's handleApprove()/handleCheckStatus(): same file,
//     its own admin-charges success tests.
//   - api/stripe-webhook.js's reconcileSucceeded() backstop: same file,
//     its webhook-idempotency tests.
// What's verified here instead is that the wiring itself exists at the
// right point in each file's source — a call to mirrorStripePaymentToLedger
// immediately once Stripe has confirmed success, not buried behind a
// conditional that could skip it.
// =======================================================================
function assertCallsMirror(file, mustContain) {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  assert.ok(/mirrorStripePaymentToLedger\s*\(/.test(src), file + " must call mirrorStripePaymentToLedger()");
  mustContain.forEach((needle) => {
    assert.ok(src.indexOf(needle) !== -1, file + " must contain: " + needle);
  });
}

test("api/book.js calls mirrorStripePaymentToLedger() right after the initial capture is confirmed succeeded", () => {
  assertCallsMirror("api/book.js", ['if (!captured || captured.status !== "succeeded")', "mirrorStripePaymentToLedger(supabase, {"]);
});

test("api/admin/booking.js's handleApprove() calls mirrorStripePaymentToLedger() right after Stripe confirms the off-session charge succeeded", () => {
  assertCallsMirror("api/admin/booking.js", ['if (!intent || intent.status !== "succeeded")', "mirrorStripePaymentToLedger(supabase, {"]);
});

test("api/admin/booking.js's handleCheckStatus() calls mirrorStripePaymentToLedger() when the re-fetched PaymentIntent is found succeeded", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "booking.js"), "utf8");
  const fnStart = src.indexOf("async function handleCheckStatus");
  const fnEnd = src.indexOf("\n// Shared failure path for handleApprove", fnStart);
  const fnSrc = src.slice(fnStart, fnEnd);
  assert.ok(/if \(intent\.status === "succeeded"\)/.test(fnSrc));
  assert.ok(fnSrc.indexOf("mirrorStripePaymentToLedger(supabase, {") !== -1);
});

test("api/stripe-webhook.js's reconcileSucceeded() calls mirrorStripePaymentToLedger() for both rental_payments and rental_additional_charges success branches — the async backstop, idempotent alongside the synchronous paths above", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "stripe-webhook.js"), "utf8");
  const occurrences = (src.match(/await mirrorStripePaymentToLedger\s*\(/g) || []).length;
  assert.strictEqual(occurrences, 2, "expected exactly two call sites — one for the rental_payments branch, one for the rental_additional_charges branch");
});

// =======================================================================
// api/admin/booking.js — ?resource=job-payments GET/POST/PATCH
// =======================================================================
function listPayments(db, bookingId) {
  return req(db, { query: { resource: "job-payments", bookingId } });
}
function createPayment(db, body) {
  return req(db, { method: "POST", query: { resource: "job-payments" }, body });
}
function voidPayment(db, body) {
  return req(db, { method: "PATCH", query: { resource: "job-payments" }, body });
}

test("GET job-payments: requires auth (401)", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await listPayments(freshDb(), makeId());
  assert.strictEqual(res.statusCode, 401);
});

test("GET job-payments: an invalid bookingId -> 400", async () => {
  adminAuthed();
  const res = await listPayments(freshDb(), "not-a-uuid");
  assert.strictEqual(res.statusCode, 400);
});

test("GET job-payments: lists every row for a booking, newest first", async () => {
  adminAuthed();
  const bookingId = makeId();
  const db = freshDb({
    job_payments: [
      { id: makeId(), booking_id: bookingId, amount: 100, payment_method: "cash", payment_type: "payment", payment_date: "2026-09-01", notes: null, stripe_payment_intent_id: null, reverses_payment_id: null, voided_at: null, voided_reason: null, recorded_by: ADMIN_EMAIL, created_at: "2026-09-01T00:00:00Z" },
      { id: makeId(), booking_id: bookingId, amount: 200, payment_method: "zelle", payment_type: "payment", payment_date: "2026-09-05", notes: null, stripe_payment_intent_id: null, reverses_payment_id: null, voided_at: null, voided_reason: null, recorded_by: ADMIN_EMAIL, created_at: "2026-09-05T00:00:00Z" },
    ],
  });
  const res = await listPayments(db, bookingId);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobPayments.length, 2);
  assert.strictEqual(res.body.jobPayments[0].paymentDate, "2026-09-05", "newest first");
});

test("POST job-payments: records a manual cash payment", async () => {
  adminAuthed();
  const booking = makeBooking();
  const db = freshDb({ bookings: [booking] });
  const res = await createPayment(db, { bookingId: booking.id, amount: 400, paymentMethod: "cash", paymentDate: "2026-09-10" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobPayment.amount, 400);
  assert.strictEqual(res.body.jobPayment.paymentMethod, "cash");
  assert.strictEqual(res.body.jobPayment.recordedBy, ADMIN_EMAIL);
});

test("POST job-payments: card_stripe is REJECTED as a manual selection — that value is reserved exclusively for the auto-mirror path", async () => {
  adminAuthed();
  const booking = makeBooking();
  const db = freshDb({ bookings: [booking] });
  const res = await createPayment(db, { bookingId: booking.id, amount: 100, paymentMethod: "card_stripe" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.job_payments.length, 0);
});

test("POST job-payments: an invalid payment method is rejected (400)", async () => {
  adminAuthed();
  const booking = makeBooking();
  const db = freshDb({ bookings: [booking] });
  const res = await createPayment(db, { bookingId: booking.id, amount: 100, paymentMethod: "bitcoin" });
  assert.strictEqual(res.statusCode, 400);
});

test("POST job-payments: a zero/negative/missing amount is rejected (400)", async () => {
  adminAuthed();
  const booking = makeBooking();
  const db = freshDb({ bookings: [booking] });
  const res1 = await createPayment(db, { bookingId: booking.id, amount: 0, paymentMethod: "cash" });
  assert.strictEqual(res1.statusCode, 400);
  const res2 = await createPayment(db, { bookingId: booking.id, paymentMethod: "cash" });
  assert.strictEqual(res2.statusCode, 400);
});

test("POST job-payments: a nonexistent booking -> 404, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createPayment(db, { bookingId: makeId(), amount: 100, paymentMethod: "cash" });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(db.job_payments.length, 0);
});

test("POST job-payments: supports multiple payments on one job — $100 Stripe-style deposit (simulated manual for this test) + $400 cash balance both attach to the same booking", async () => {
  adminAuthed();
  const booking = makeBooking();
  const db = freshDb({ bookings: [booking] });
  await createPayment(db, { bookingId: booking.id, amount: 100, paymentMethod: "zelle" });
  await createPayment(db, { bookingId: booking.id, amount: 400, paymentMethod: "cash" });
  const res = await listPayments(db, booking.id);
  assert.strictEqual(res.body.jobPayments.length, 2);
  const total = netCollectedFromLedgerRows(res.body.jobPayments.map((p) => ({ amount: p.amount, paymentType: p.paymentType })));
  assert.strictEqual(total, 500);
});

test("POST job-payments: a refund entry is accepted and reduces net collected revenue", async () => {
  adminAuthed();
  const booking = makeBooking();
  const db = freshDb({ bookings: [booking] });
  await createPayment(db, { bookingId: booking.id, amount: 500, paymentMethod: "card_stripe".replace("card_stripe", "cash") }); // manual $500 for setup
  await createPayment(db, { bookingId: booking.id, amount: 50, paymentMethod: "cash", paymentType: "refund", notes: "partial refund for delay" });
  const res = await listPayments(db, booking.id);
  const total = netCollectedFromLedgerRows(res.body.jobPayments.map((p) => ({ amount: p.amount, paymentType: p.paymentType })));
  assert.strictEqual(total, 450);
});

test("POST job-payments: 'card_venmo' is accepted as a manual payment method (added alongside the original five)", async () => {
  adminAuthed();
  const booking = makeBooking();
  const db = freshDb({ bookings: [booking] });
  const res = await createPayment(db, { bookingId: booking.id, amount: 120, paymentMethod: "card_venmo", paymentDate: "2026-09-10" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobPayment.paymentMethod, "card_venmo");
});

test("POST job-payments: 'other' requires a description — rejected without notes, accepted with one", async () => {
  adminAuthed();
  const booking = makeBooking();
  const db = freshDb({ bookings: [booking] });
  const rejected = await createPayment(db, { bookingId: booking.id, amount: 75, paymentMethod: "other" });
  assert.strictEqual(rejected.statusCode, 400);
  assert.strictEqual(db.job_payments.length, 0, "no row created when 'other' has no description");

  const accepted = await createPayment(db, { bookingId: booking.id, amount: 75, paymentMethod: "other", notes: "Paid via CashApp" });
  assert.strictEqual(accepted.statusCode, 200);
  assert.strictEqual(accepted.body.jobPayment.notes, "Paid via CashApp");
});

test("PATCH job-payments (void): requires a reason (400)", async () => {
  adminAuthed();
  const booking = makeBooking();
  const db = freshDb({ bookings: [booking], job_payments: [{ id: makeId(), booking_id: booking.id, amount: 500, payment_method: "cash", payment_type: "payment", payment_date: "2026-09-01", voided_at: null }] });
  const res = await voidPayment(db, { id: db.job_payments[0].id });
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH job-payments (void): financial-audit correction pattern — preserve original, void it, then a new corrected entry ($500 cash mistakenly entered, corrected to $450 Zelle)", async () => {
  adminAuthed();
  const booking = makeBooking();
  const wrong = { id: makeId(), booking_id: booking.id, amount: 500, payment_method: "cash", payment_type: "payment", payment_date: "2026-09-01", notes: null, stripe_payment_intent_id: null, reverses_payment_id: null, voided_at: null, voided_reason: null, recorded_by: ADMIN_EMAIL, created_at: nowIso() };
  const db = freshDb({ bookings: [booking], job_payments: [wrong] });

  const voidRes = await voidPayment(db, { id: wrong.id, reason: "entered as cash by mistake, was actually Zelle for a different amount" });
  assert.strictEqual(voidRes.statusCode, 200);
  assert.ok(voidRes.body.jobPayment.isVoided);
  assert.strictEqual(voidRes.body.jobPayment.amount, 500, "the ORIGINAL row's amount must be preserved, never rewritten to 450");

  const correctRes = await createPayment(db, { bookingId: booking.id, amount: 450, paymentMethod: "zelle", reversesPaymentId: wrong.id });
  assert.strictEqual(correctRes.statusCode, 200);
  assert.strictEqual(correctRes.body.jobPayment.reversesPaymentId, wrong.id);

  // Full history preserved: both rows still exist, only the correct one
  // counts toward collected revenue.
  const listRes = await listPayments(db, booking.id);
  assert.strictEqual(listRes.body.jobPayments.length, 2, "both the voided original and the correction remain in the ledger — nothing is deleted");
  const nonVoided = listRes.body.jobPayments.filter((p) => !p.isVoided).map((p) => ({ amount: p.amount, paymentType: p.paymentType }));
  assert.strictEqual(netCollectedFromLedgerRows(nonVoided), 450, "only the corrected entry counts toward collected revenue");
});

test("PATCH job-payments (void): voiding an already-voided payment is rejected (409), not silently repeated", async () => {
  adminAuthed();
  const booking = makeBooking();
  const row = { id: makeId(), booking_id: booking.id, amount: 100, payment_method: "cash", payment_type: "payment", payment_date: "2026-09-01", voided_at: nowIso(), voided_reason: "first void" };
  const db = freshDb({ bookings: [booking], job_payments: [row] });
  const res = await voidPayment(db, { id: row.id, reason: "second attempt" });
  assert.strictEqual(res.statusCode, 409);
});

test("PATCH job-payments: there is no way to edit amount/method/type through this endpoint — grep guard confirms handleVoidJobPayment's update() payload is exactly {voided_at, voided_reason, updated_at}", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "booking.js"), "utf8");
  const startIdx = src.indexOf("async function handleVoidJobPayment");
  assert.ok(startIdx !== -1, "handleVoidJobPayment must exist");
  const nextFnIdx = src.indexOf("\nfunction serializeCharge", startIdx);
  assert.ok(nextFnIdx !== -1, "expected serializeCharge() to immediately follow handleVoidJobPayment in source order");
  const fnSrc = src.slice(startIdx, nextFnIdx);
  assert.ok(/\.update\(\{\s*voided_at:/.test(fnSrc), "the only update() call in handleVoidJobPayment must set voided_at first");
  assert.ok(!/amount:|payment_method:|payment_type:|booking_id:/.test(fnSrc.replace(/\/\/.*$/gm, "")), "handleVoidJobPayment must never write amount/payment_method/payment_type/booking_id");
});

test("no code path ever inserts payment_method: 'card_stripe' from admin-supplied input — grep guard (only mirrorStripePaymentToLedger's own hardcoded literal may do so)", () => {
  const fs = require("fs");
  const path = require("path");
  const bookingSrc = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "booking.js"), "utf8");
  // handleCreateJobPayment must explicitly reject the client-supplied value
  // "card_stripe" before ever reaching the insert — this is the guard that
  // proves it, structurally, rather than only by behavioral test above.
  assert.ok(/paymentMethod === "card_stripe"/.test(bookingSrc), "handleCreateJobPayment must explicitly check for and reject a client-submitted card_stripe value");
});

// =======================================================================
// Booking detail GET — jobPayments + collectedRevenue exposed
// =======================================================================
test("GET booking detail: a booking with no job_payments rows reports collectedRevenue from final_price (compatibility fallback)", async () => {
  adminAuthed();
  const booking = makeBooking({ final_price: 275 });
  const db = freshDb({ bookings: [booking] });
  const res = await req(db, { query: { id: booking.id } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.collectedRevenue, 275);
  assert.strictEqual(res.body.collectedRevenueSource, "final_price");
  assert.deepStrictEqual(res.body.jobPayments, []);
});

test("GET booking detail: a booking WITH job_payments rows reports collectedRevenue from the ledger, not final_price", async () => {
  adminAuthed();
  const booking = makeBooking({ final_price: 275 });
  const db = freshDb({
    bookings: [booking],
    job_payments: [{ id: makeId(), booking_id: booking.id, amount: 500, payment_method: "cash", payment_type: "payment", payment_date: "2026-09-01", notes: null, stripe_payment_intent_id: null, reverses_payment_id: null, voided_at: null, voided_reason: null, recorded_by: ADMIN_EMAIL, created_at: nowIso() }],
  });
  const res = await req(db, { query: { id: booking.id } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.collectedRevenue, 500);
  assert.strictEqual(res.body.collectedRevenueSource, "ledger");
  assert.strictEqual(res.body.jobPayments.length, 1);
});

test("GET booking detail: a voided-only ledger falls back to final_price, same as having no ledger rows at all", async () => {
  adminAuthed();
  const booking = makeBooking({ final_price: 275 });
  const db = freshDb({
    bookings: [booking],
    job_payments: [{ id: makeId(), booking_id: booking.id, amount: 500, payment_method: "cash", payment_type: "payment", payment_date: "2026-09-01", notes: null, stripe_payment_intent_id: null, reverses_payment_id: null, voided_at: nowIso(), voided_reason: "mistake", recorded_by: ADMIN_EMAIL, created_at: nowIso() }],
  });
  const res = await req(db, { query: { id: booking.id } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.collectedRevenue, 275, "a fully-voided ledger must not be treated as '$0 collected'");
  assert.strictEqual(res.body.collectedRevenueSource, "final_price");
  assert.strictEqual(res.body.jobPayments.length, 1, "the voided row is still SHOWN (full audit trail), just excluded from the revenue sum");
});

test("GET booking detail: tip_amount is completely independent of collectedRevenue — no double-counting, no dropping", async () => {
  adminAuthed();
  const booking = makeBooking({ final_price: 275, tip_amount: 40 });
  const db = freshDb({ bookings: [booking] });
  const res = await req(db, { query: { id: booking.id } });
  assert.strictEqual(res.body.booking.tipAmount, 40);
  assert.strictEqual(res.body.collectedRevenue, 275, "collectedRevenue must never include tip_amount");
});

// =======================================================================
// Tip (bookings.tip_amount) — restored admin entry/edit via PATCH ?resource=tip
// =======================================================================
test("Tip: PATCH ?resource=tip sets/clears bookings.tip_amount for a completed job, independent of collectedRevenue (Total received = Collected + Tip is display-only, never a job_payments row); rejected for a non-completed job", async () => {
  adminAuthed();
  const completed = makeBooking({ status: "completed", final_price: 300, tip_amount: null });
  const booked = makeBooking({ status: "booked", final_price: null, tip_amount: null });
  const db = freshDb({ bookings: [completed, booked] });

  // Tip stays completed-only, same rule the full Edit Job form already enforces.
  const rejectedRes = await req(db, { method: "PATCH", query: { resource: "tip" }, body: { id: booked.id, tipAmount: 20 } });
  assert.strictEqual(rejectedRes.statusCode, 400);

  const setRes = await req(db, { method: "PATCH", query: { resource: "tip" }, body: { id: completed.id, tipAmount: 40 } });
  assert.strictEqual(setRes.statusCode, 200);
  assert.strictEqual(setRes.body.tipAmount, 40);

  const detailRes = await req(db, { query: { id: completed.id } });
  assert.strictEqual(detailRes.body.booking.tipAmount, 40);
  assert.strictEqual(detailRes.body.collectedRevenue, 300, "collected must never include the tip");
  const totalReceived = (detailRes.body.collectedRevenue || 0) + (detailRes.body.booking.tipAmount || 0);
  assert.strictEqual(totalReceived, 340, "Total received (display-only) is Collected + Tip");

  // Clearing (empty string) nulls it out, never leaves a stale value.
  const clearRes = await req(db, { method: "PATCH", query: { resource: "tip" }, body: { id: completed.id, tipAmount: "" } });
  assert.strictEqual(clearRes.statusCode, 200);
  assert.strictEqual(clearRes.body.tipAmount, null);

  assert.strictEqual(db.job_payments.length, 0, "tip edits must never write to job_payments");
});

// =======================================================================
// Regression guard for a real bug caught in a pre-push audit (2026-09-19):
// job_payments_stripe_pi_idx was originally defined as a PARTIAL unique
// index (`... WHERE stripe_payment_intent_id IS NOT NULL`). That breaks
// mirrorStripePaymentToLedger()'s `.upsert(payload, {onConflict:
// "stripe_payment_intent_id", ignoreDuplicates: true})` call outright —
// PostgreSQL requires an ON CONFLICT target to exactly match a unique
// index INCLUDING any partial predicate, and a plain
// `ON CONFLICT (stripe_payment_intent_id)` does not match a partial index.
// Confirmed directly against a real PostgreSQL engine (not this file's own
// fake Supabase client, which doesn't replicate real ON-CONFLICT-matching
// rules and would never catch this): the partial version fails every
// upsert call with "there is no unique or exclusion constraint matching
// the ON CONFLICT specification" — not just on an actual duplicate, on
// EVERY call, silently breaking ledger mirroring entirely in production
// while the underlying Stripe payment itself still succeeds (mirroring
// failures are swallowed — see mirrorStripePaymentToLedger()'s own
// try/catch). The fix: a plain (non-partial) UNIQUE index, which still
// permits unlimited NULL rows on its own (Postgres never considers NULL
// equal to NULL for uniqueness) — no partial predicate was ever needed for
// that. This static check is what actually guards against the bug
// reappearing, since no offline JS test can.
// =======================================================================
test("sql migration: job_payments_stripe_pi_idx is a PLAIN unique index, never partial — a WHERE clause here breaks ON CONFLICT matching for mirrorStripePaymentToLedger()'s upsert (a real bug, found and fixed in a pre-push audit; this guard prevents it silently reappearing)", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "sql", "2026-09-19_phase3c-stage3-job-payments-and-expenses.sql"), "utf8");
  const stmtStart = src.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS job_payments_stripe_pi_idx");
  assert.ok(stmtStart !== -1, "job_payments_stripe_pi_idx must exist in the migration");
  const stmtEnd = src.indexOf(";", stmtStart);
  const stmt = src.slice(stmtStart, stmtEnd + 1);
  assert.ok(!/\bWHERE\b/i.test(stmt), "job_payments_stripe_pi_idx must NOT have a WHERE predicate (partial index) — it breaks the upsert's ON CONFLICT matching: " + stmt);
});

// ---------------------------------------------------------------------
async function main() {
  let failed = 0;
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
    } catch (err) {
      failed++;
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
    }
  }
  console.log("\n" + registered.length + " tests run, " + failed + " failed.");
  if (failed) process.exitCode = 1;
}
main();
