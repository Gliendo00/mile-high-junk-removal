// Local, offline test harness for Phase 3C Stage 2.5-v2 — dumpster rental
// real booking + Braintree payments. See
// docs/phase-3/stage2.5-rental-payments-v2-proposal.md for the full design
// this exercises.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake — the
// fake's insert() also simulates the two real database constraints this
// stage's SQL migration adds (the partial unique index on
// bookings(appointment_date, time_window) for booked dumpster rentals, and
// rental_payments.idempotency_key's UNIQUE constraint) — never the real
// network, never the production Supabase project. "braintree" is
// intercepted the same way, with a swappable fake transaction.sale/
// webhookNotification.parse/verify implementation per test.
//
// Run with:  node tests/phase3c-stage2.5v2-rental-payments.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

// ---------------------------------------------------------------------
// Fake Supabase
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "dddddddd-dddd-dddd-dddd-" + String(100000000000 + nextId++).padStart(12, "0");
}
function nowIso() {
  return new Date().toISOString();
}

// Simulates the two real DB constraints this stage's migration adds.
// Returns { error } to short-circuit the insert, or null to allow it.
function checkInsertConstraints(table, payload, existingRows) {
  if (table === "bookings" && payload.service_type === "dumpster_rental" && payload.status === "booked") {
    const collision = existingRows.some(
      (r) => r.service_type === "dumpster_rental" && r.status === "booked" && r.appointment_date === payload.appointment_date && r.time_window === payload.time_window
    );
    if (collision) {
      return { error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_bookings_dumpster_delivery_slot"' } };
    }
  }
  if (table === "rental_payments" && payload.idempotency_key) {
    const collision = existingRows.some((r) => r.idempotency_key === payload.idempotency_key);
    if (collision) {
      return { error: { code: "23505", message: "duplicate key value violates unique constraint on rental_payments.idempotency_key" } };
    }
  }
  return null;
}

class FakeQueryBuilder {
  constructor(table, db) {
    this.table = table;
    this.db = db;
    this.filters = [];
    this.rangeFilters = [];
    this._order = null;
    this._insertPayload = null;
    this._updatePayload = null;
    this._deleteMode = false;
    this._single = null;
  }
  select() {
    return this;
  }
  eq(col, val) {
    this.filters.push({ col: col, val: val });
    return this;
  }
  in(col, values) {
    const set = new Set(values);
    this.filters.push({ col: col, in: set });
    return this;
  }
  gte(col, val) {
    this.rangeFilters.push({ col: col, val: val, op: "gte" });
    return this;
  }
  lte(col, val) {
    this.rangeFilters.push({ col: col, val: val, op: "lte" });
    return this;
  }
  order(col, opts) {
    this._order = { col: col, asc: !opts || opts.ascending !== false };
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
  delete() {
    this._deleteMode = true;
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
      const constraint = checkInsertConstraints(this.table, this._insertPayload, rows);
      if (constraint) return { data: null, error: constraint.error };
      const row = Object.assign({ id: makeId(), created_at: nowIso(), updated_at: nowIso() }, this._insertPayload);
      rows.push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let matched = rows.filter(
      (r) => this.filters.every((f) => (f.in ? f.in.has(r[f.col]) : r[f.col] === f.val)) && this.rangeFilters.every((f) => (f.op === "gte" ? r[f.col] >= f.val : r[f.col] <= f.val))
    );

    if (this._updatePayload) {
      matched.forEach((r) => Object.assign(r, this._updatePayload));
      if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
      if (this._single === "single") return matched.length ? { data: matched[0], error: null } : { data: null, error: { message: "no rows" } };
      return { data: matched, error: null };
    }

    if (this._deleteMode) {
      const toDelete = new Set(matched);
      this.db[this.table] = rows.filter((r) => !toDelete.has(r));
      return { data: null, error: null };
    }

    if (this._order) {
      const col = this._order.col;
      const asc = this._order.asc;
      matched = matched.slice().sort((a, b) => {
        if (a[col] < b[col]) return asc ? -1 : 1;
        if (a[col] > b[col]) return asc ? 1 : -1;
        return 0;
      });
    }

    if (this._single === "maybeSingle") {
      if (matched.length > 1) return { data: null, error: { message: "multiple rows returned for maybeSingle" } };
      return { data: matched[0] || null, error: null };
    }
    if (this._single === "single") {
      return matched.length ? { data: matched[0], error: null } : { data: null, error: { message: "no rows returned for single" } };
    }
    return { data: matched, error: null };
  }
}

let currentDb = null;
function freshDb() {
  currentDb = { customers: [], bookings: [], dumpster_rentals: [], rental_payments: [], rental_additional_charges: [] };
  currentFakeService = createFakeServiceClient(currentDb);
  return currentDb;
}

function createFakeServiceClient(db) {
  return {
    from: function (table) {
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

// ---------------------------------------------------------------------
// Fake Braintree — one static gateway object whose method bodies delegate
// to swappable module-level implementations, reset per test via
// resetBraintree(). This lets `new braintree.BraintreeGateway({...})`
// (called fresh inside getBraintreeGateway() on every request, matching
// real serverless-function statelessness) always return an object backed
// by whatever this test currently wants it to do.
// ---------------------------------------------------------------------
let saleCallLog = [];
let saleImpl = async () => defaultSaleSuccess();
let webhookParseImpl = async () => {
  throw new Error("webhookNotification.parse not configured in this test");
};
let webhookVerifyImpl = async (challenge) => "verified-" + challenge;

// Deliberately "submitted_for_settlement", never "settled" — a real
// synchronous transaction.sale() response never reports "settled" (that
// only happens hours later in a nightly batch). Per current Braintree
// documentation, a transaction in submitted_for_settlement/settling/
// settled is considered successful; api/book.js/handleApproveCharge()
// correctly mark payment_status "paid" straight from this response and
// never wait for anything more "final" than this.
function defaultSaleSuccess(overrides) {
  return Object.assign(
    {
      success: true,
      transaction: {
        id: "txn-" + nextId++,
        status: "submitted_for_settlement",
        processorResponseText: "Approved",
        customer: { id: "bt-cust-1" },
        creditCard: { token: "tok-visa-1", last4: "4242", cardType: "Visa" },
      },
    },
    overrides || {}
  );
}

function declineSaleResult(processorResponseText) {
  return {
    success: false,
    transaction: { status: "processor_declined", processorResponseText: processorResponseText || "Do Not Honor" },
  };
}

const fakeBraintreeGateway = {
  transaction: {
    sale: async function (options) {
      saleCallLog.push(options);
      return saleImpl(options);
    },
  },
  webhookNotification: {
    parse: function (sig, payload) {
      return webhookParseImpl(sig, payload);
    },
    verify: function (challenge) {
      return webhookVerifyImpl(challenge);
    },
  },
};

function resetBraintree() {
  saleCallLog = [];
  saleImpl = async () => defaultSaleSuccess();
  webhookParseImpl = async () => {
    throw new Error("webhookNotification.parse not configured in this test");
  };
  webhookVerifyImpl = async (challenge) => "verified-" + challenge;
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
    if (request === "braintree") {
      return {
        Environment: { Sandbox: "Sandbox", Production: "Production" },
        BraintreeGateway: function () {
          return fakeBraintreeGateway;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
interceptModules();

// --- fake fetch (Resend notification email) ------------------------------
let fetchCalls = [];
global.fetch = function (url, opts) {
  fetchCalls.push({ url: url, opts: opts });
  return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ id: "mock-resend-id" }); }, text: function () { return Promise.resolve("{}"); } });
};

// --- env ------------------------------------------------------------------
process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.UPLOAD_TOKEN_SECRET = "mock-upload-token-secret";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";
process.env.BRAINTREE_ENVIRONMENT = "Sandbox";
process.env.BRAINTREE_MERCHANT_ID = "mock-merchant-id";
process.env.BRAINTREE_PUBLIC_KEY = "mock-public-key";
process.env.BRAINTREE_PRIVATE_KEY = "mock-private-key";
process.env.BRAINTREE_TOKENIZATION_KEY = "mock_sandbox_tokenization_key";

const bookHandler = require("../api/book.js");
const webhookHandler = require("../api/braintree-webhook.js");
const bookingHandler = require("../api/admin/booking.js");
const rentalPricing = require("../api/_lib/rental-pricing");

// ---------------------------------------------------------------------
// req/res mocks
// ---------------------------------------------------------------------
// Each call gets its own IP by default (a fresh octet per call) — this
// project's rate limiter (api/_lib/spam-protection.js) keeps its bucket
// state in a module-level Map for the lifetime of this one test process,
// so many POSTs sharing one fixed fake IP would trip RATE_LIMIT_MAX partway
// through this file, same as it would for real distinct visitors sharing a
// NAT'd IP — nothing to do with the code under test.
let nextIpOctet = 1;
function makeReq(opts) {
  opts = opts || {};
  const isForm = opts.form === true;
  const bodyStr = opts.body !== undefined ? (isForm ? formEncode(opts.body) : JSON.stringify(opts.body)) : "";
  return {
    method: opts.method || "GET",
    headers: Object.assign(
      {
        "content-type": isForm ? "application/x-www-form-urlencoded" : "application/json",
        "content-length": String(Buffer.byteLength(bodyStr)),
        cookie: opts.cookie || "",
        "x-forwarded-proto": "https",
        "x-forwarded-for": opts.ip || "198.51." + Math.floor(nextIpOctet / 254) + "." + ((nextIpOctet++ % 254) + 1),
      },
      opts.headers || {}
    ),
    body: opts.body,
    query: opts.query || {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}
function formEncode(obj) {
  return Object.keys(obj)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]))
    .join("&");
}

function makeRes() {
  const headers = {};
  const res = {
    statusCode: null,
    body: null,
    getHeader: (n) => headers[n.toLowerCase()],
    setHeader: (n, v) => { headers[n.toLowerCase()] = v; },
    status: function (c) { res.statusCode = c; return res; },
    json: function (o) { res.body = o; return res; },
    send: function (o) { res.body = o; return res; },
    end: function () { if (res.statusCode === null) res.statusCode = 200; return res; },
    headersSent: false,
  };
  return res;
}

function run(handler, req) {
  const res = makeRes();
  return Promise.resolve(handler(req, res)).then(() => res);
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
const FAR_FUTURE_DATE = (function () {
  const d = new Date();
  d.setDate(d.getDate() + 20);
  return d.toISOString().slice(0, 10);
})();
const PICKUP_DATE = (function () {
  const d = new Date(FAR_FUTURE_DATE);
  d.setDate(d.getDate() + 5);
  return d.toISOString().slice(0, 10);
})();

// UUID-shaped fixture ids — api/admin/booking.js's UUID_RE rejects anything
// else (matching real behavior: a malformed id can never match a real row).
const BOOKING_ID = "11111111-1111-1111-1111-111111111111";
const CHARGE_ID = "22222222-2222-2222-2222-222222222222";

let idemCounter = 0;
function freshIdempotencyKey() {
  idemCounter += 1;
  return "test-idem-key-" + idemCounter + "-" + Date.now();
}

function validDumpsterPayload(overrides) {
  const base = {
    serviceType: "dumpster_rental",
    hp: "",
    elapsedMs: 10000,
    jobDetails: {
      materialType: "Household junk",
      deliveryDate: FAR_FUTURE_DATE,
      pickupDate: PICKUP_DATE,
      placementLocation: "Driveway",
      additionalDetails: "",
    },
    schedule: { date: FAR_FUTURE_DATE, timeWindow: "w_0800_1000" },
    customer: {
      firstName: "Jamie",
      lastName: "Rivera",
      phone: "303-555-0100",
      email: "jamie@example.com",
      streetAddress: "123 Main St",
      city: "Denver",
      state: "CO",
      zip: "80202",
    },
    payment: { nonce: "fake-valid-nonce", idempotencyKey: freshIdempotencyKey(), agreementAccepted: true },
  };
  return deepMerge(base, overrides || {});
}
function deepMerge(base, overrides) {
  const out = Object.assign({}, base);
  Object.keys(overrides).forEach((k) => {
    if (overrides[k] && typeof overrides[k] === "object" && !Array.isArray(overrides[k]) && base[k] && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], overrides[k]);
    } else {
      out[k] = overrides[k];
    }
  });
  return out;
}

// Admin auth fixture — same pattern as tests/phase2-admin-api.test.js.
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
// Test registry
// ---------------------------------------------------------------------
const registered = [];
function test(name, fn) {
  registered.push({ name: name, fn: fn });
}

// =======================================================================
// 1. api/_lib/rental-pricing.js — pure calculation correctness
// =======================================================================
test("rental-pricing: base rental amount is the flat $349 rate", () => {
  assert.strictEqual(rentalPricing.baseRentalAmount(), 349.0);
});
test("rental-pricing: overageRate returns the correct per-unit rate for each charge type", () => {
  assert.strictEqual(rentalPricing.overageRate("overweight_tonnage"), 90.0);
  assert.strictEqual(rentalPricing.overageRate("additional_days"), 15.0);
  assert.strictEqual(rentalPricing.overageRate("other"), null);
  assert.strictEqual(rentalPricing.overageRate("bogus"), null);
});
test("rental-pricing: round2 rounds to the nearest cent", () => {
  // 1.005 is deliberately avoided here — it isn't exactly representable in
  // binary floating point (it's actually stored fractionally below 1.005),
  // so *any* correct round-half-up implementation legitimately rounds it
  // to 1.00, not 1.01. That's a float-representation fact, not something
  // this function's rounding strategy could fix.
  assert.strictEqual(rentalPricing.round2(10.126), 10.13);
  assert.strictEqual(rentalPricing.round2(90 * 2.5), 225);
});

// =======================================================================
// 2. GET /api/book — public rental config
// =======================================================================
test("GET /api/book: returns tokenization key, pricing, agreement version", async () => {
  freshDb();
  const res = await run(bookHandler, makeReq({ method: "GET" }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.braintree.tokenizationKey, "mock_sandbox_tokenization_key");
  assert.strictEqual(res.body.pricing.baseRate, 349.0);
  assert.strictEqual(res.body.pricing.overageTonRate, 90.0);
  assert.strictEqual(res.body.pricing.overageDayRate, 15.0);
  assert.strictEqual(res.body.agreementVersion, rentalPricing.RENTAL_AGREEMENT_VERSION);
  assert.ok(Array.isArray(res.body.takenDeliverySlots));
});
test("GET /api/book: taken delivery slots reflect existing booked dumpster rentals only", async () => {
  const db = freshDb();
  db.bookings.push({ id: "b1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_1000_1200" });
  db.bookings.push({ id: "b2", service_type: "junk_removal", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_1200_1400" });
  const res = await run(bookHandler, makeReq({ method: "GET" }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.takenDeliverySlots, [{ date: FAR_FUTURE_DATE, timeWindow: "w_1000_1200" }]);
});

// =======================================================================
// 3. POST /api/book (dumpster_rental) — validation
// =======================================================================
test("POST dumpster_rental: missing payment.nonce is rejected with 400, no DB or Braintree calls", async () => {
  const db = freshDb();
  resetBraintree();
  const payload = validDumpsterPayload({ payment: { nonce: "", idempotencyKey: freshIdempotencyKey(), agreementAccepted: true } });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.bookings.length, 0);
  assert.strictEqual(saleCallLog.length, 0);
});
test("POST dumpster_rental: agreementAccepted !== true is rejected with 400", async () => {
  freshDb();
  resetBraintree();
  const payload = validDumpsterPayload({ payment: { nonce: "n", idempotencyKey: freshIdempotencyKey(), agreementAccepted: false } });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/agreement/i.test(res.body.error));
});
test("POST dumpster_rental: malformed idempotencyKey is rejected with 400", async () => {
  freshDb();
  resetBraintree();
  const payload = validDumpsterPayload({ payment: { nonce: "n", idempotencyKey: "!!!", agreementAccepted: true } });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 400);
});

// =======================================================================
// 4. POST /api/book (dumpster_rental) — successful payment
// =======================================================================
test("POST dumpster_rental: successful payment books the rental, charges the authoritative base rate, vaults the payment method", async () => {
  const db = freshDb();
  resetBraintree();
  const payload = validDumpsterPayload();
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.booked, true);
  assert.ok(res.body.uploadToken);

  assert.strictEqual(db.customers.length, 1);
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.bookings[0].status, "booked");
  assert.strictEqual(db.bookings[0].service_type, "dumpster_rental");
  assert.strictEqual(db.dumpster_rentals.length, 1);
  assert.strictEqual(db.rental_payments.length, 1);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");
  assert.strictEqual(db.rental_payments[0].amount_charged, 349.0);
  assert.strictEqual(db.rental_payments[0].braintree_payment_method_token, "tok-visa-1");
  assert.strictEqual(db.rental_payments[0].payment_method_summary, "Visa ending in 4242");
  assert.strictEqual(db.rental_payments[0].agreement_version, rentalPricing.RENTAL_AGREEMENT_VERSION);
  assert.ok(db.rental_payments[0].agreement_accepted_at);

  assert.strictEqual(saleCallLog.length, 1);
  assert.strictEqual(saleCallLog[0].amount, "349.00");
  assert.strictEqual(saleCallLog[0].options.submitForSettlement, true);
  assert.strictEqual(saleCallLog[0].options.storeInVaultOnSuccess, true);
});
test("POST dumpster_rental: a client-submitted price field is completely ignored — the server always charges its own authoritative rate", async () => {
  freshDb();
  resetBraintree();
  const payload = validDumpsterPayload();
  payload.amount = 1; // spoofed — not a real field this endpoint reads at all
  payload.jobDetails.amount = 0.01;
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(saleCallLog[0].amount, "349.00");
});
test("POST dumpster_rental: notification email includes a Payment section with amount/method/transaction id", async () => {
  freshDb();
  resetBraintree();
  fetchCalls = [];
  process.env.RESEND_API_KEY = "mock-resend-key";
  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(res.statusCode, 200);
  const emailCall = fetchCalls.find((c) => c.url === "https://api.resend.com/emails");
  assert.ok(emailCall, "expected a Resend API call");
  const body = JSON.parse(emailCall.opts.body);
  assert.ok(/PAID & CONFIRMED/.test(body.html));
  assert.ok(/Amount Charged/.test(body.html));
  assert.ok(/\$349\.00/.test(body.html));
  assert.ok(/Braintree Transaction ID/.test(body.html));
  delete process.env.RESEND_API_KEY;
});

// =======================================================================
// 5. POST /api/book (dumpster_rental) — decline / processor error
// =======================================================================
test("POST dumpster_rental: a declined payment rolls back every row and frees the slot — no booking is left behind", async () => {
  const db = freshDb();
  resetBraintree();
  saleImpl = async () => declineSaleResult("Do Not Honor");
  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));

  assert.strictEqual(res.statusCode, 402);
  assert.ok(/Do Not Honor/.test(res.body.error));
  assert.strictEqual(db.bookings.length, 0, "no booking should remain after a decline");
  assert.strictEqual(db.dumpster_rentals.length, 0);
  assert.strictEqual(db.rental_payments.length, 0);
  assert.strictEqual(db.customers.length, 0, "the customer created for this failed attempt must also be rolled back");
});
// 2026-09-18 hardening audit, §6: a THROWN Braintree call (network error/
// timeout) is an AMBIGUOUS outcome — Braintree may have actually charged
// the customer, and there's no transaction id to check or void. Rolling
// back here (as an earlier version of this code did) would be dangerous:
// it would delete the only record of a possibly-successful charge AND
// free the slot for someone else. The correct behavior is the opposite of
// the old test's assertion — preserve everything, mark it for review.
test("POST dumpster_rental: an ambiguous Braintree failure (thrown error) preserves every row instead of rolling back, and never claims a raw stack trace to the customer", async () => {
  const db = freshDb();
  resetBraintree();
  saleImpl = async () => {
    throw new Error("ECONNRESET");
  };
  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(res.statusCode, 502);
  assert.ok(!/ECONNRESET/.test(res.body.error));
  assert.ok(/call or text/i.test(res.body.error), "must direct the customer to call rather than silently retry");
  assert.strictEqual(db.bookings.length, 1, "the booking must NOT be rolled back — it may have actually been paid for");
  assert.strictEqual(db.bookings[0].status, "booked");
  assert.strictEqual(db.customers.length, 1, "the customer record must also be preserved");
  assert.strictEqual(db.rental_payments.length, 1);
  assert.strictEqual(db.rental_payments[0].payment_status, "error_pending_review");
  assert.ok(/outcome unknown/i.test(db.rental_payments[0].failure_reason));
});
test("POST dumpster_rental: resubmitting the same idempotency key after an ambiguous failure is blocked (never silently retried, never a second Braintree call)", async () => {
  const db = freshDb();
  resetBraintree();
  saleImpl = async () => {
    throw new Error("ECONNRESET");
  };
  const payload = validDumpsterPayload();
  const first = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(first.statusCode, 502);
  assert.strictEqual(saleCallLog.length, 1);

  const second = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(second.statusCode, 409);
  assert.ok(/call or text/i.test(second.body.error));
  assert.strictEqual(saleCallLog.length, 1, "must never call Braintree again for a key stuck in error_pending_review");
  assert.strictEqual(db.bookings.length, 1, "must not create a second booking either");
});
test("POST dumpster_rental: rate-schedule snapshot (base rate, included days/tons, overage rates) is durably stored on rental_payments at booking time", async () => {
  const db = freshDb();
  resetBraintree();
  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(res.statusCode, 200);
  const rp = db.rental_payments[0];
  assert.strictEqual(rp.base_rate, rentalPricing.BASE_RATE);
  assert.strictEqual(rp.included_days, rentalPricing.INCLUDED_DAYS);
  assert.strictEqual(rp.included_tons, rentalPricing.INCLUDED_TONS);
  assert.strictEqual(rp.overage_ton_rate, rentalPricing.OVERAGE_TON_RATE);
  assert.strictEqual(rp.overage_day_rate, rentalPricing.OVERAGE_DAY_RATE);
});
test("POST dumpster_rental: if the post-charge 'mark paid' DB update fails, the customer still gets a booked response — the charge already succeeded, so this must never be reported as a failure", async () => {
  const db = freshDb();
  resetBraintree();
  currentFakeService = {
    from: function (table) {
      const builder = new FakeQueryBuilder(table, db);
      if (table === "rental_payments") {
        const originalResolve = builder._resolve.bind(builder);
        builder._resolve = async function () {
          if (this._updatePayload && this._updatePayload.payment_status === "paid") {
            return { data: null, error: { message: "mock update failure" } };
          }
          return originalResolve();
        };
      }
      return builder;
    },
  };
  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.booked, true);
  assert.strictEqual(saleCallLog.length, 1, "must not attempt to charge a second time trying to recover from a local DB write failure");
});
test("POST dumpster_rental: after a decline, the SAME delivery slot can be booked again by a new attempt", async () => {
  const db = freshDb();
  resetBraintree();
  saleImpl = async () => declineSaleResult();
  const declined = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(declined.statusCode, 402);

  saleImpl = async () => defaultSaleSuccess();
  const succeeded = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(succeeded.statusCode, 200);
  assert.strictEqual(db.bookings.length, 1);
});

// =======================================================================
// 6. POST /api/book (dumpster_rental) — idempotency / duplicate submission
// =======================================================================
test("POST dumpster_rental: resubmitting the same idempotency key after success returns the same booked response without charging again", async () => {
  const db = freshDb();
  resetBraintree();
  const payload = validDumpsterPayload();
  const first = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(saleCallLog.length, 1);

  const second = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(second.body.booked, true);
  assert.strictEqual(saleCallLog.length, 1, "must not call Braintree a second time for a repeated idempotency key");
  assert.strictEqual(db.bookings.length, 1, "must not create a second booking");
});
test("POST dumpster_rental: a concurrent duplicate (same idempotency key, still processing) gets a clean 409, never a second charge", async () => {
  const db = freshDb();
  resetBraintree();
  // Simulate the state right after the reservation rows are inserted but
  // before the (first, in-flight) request's Braintree call has resolved.
  db.rental_payments.push({ id: "rp1", booking_id: "b1", idempotency_key: "shared-key-123", payment_status: "processing" });

  const payload = validDumpsterPayload({ payment: { nonce: "n", idempotencyKey: "shared-key-123", agreementAccepted: true } });
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(saleCallLog.length, 0, "a concurrent duplicate must never itself call Braintree");
});

// =======================================================================
// 7. POST /api/book (dumpster_rental) — availability / slot collision
// =======================================================================
test("POST dumpster_rental: booking the exact same date+time window as an existing booked rental is rejected with 409, Braintree is never called", async () => {
  const db = freshDb();
  resetBraintree();
  db.bookings.push({ id: "existing-1", customer_id: "c1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_0800_1000" });

  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(res.statusCode, 409);
  assert.ok(/just booked/i.test(res.body.error));
  assert.strictEqual(saleCallLog.length, 0, "a losing race for a slot must never reach the payment processor");
  assert.strictEqual(db.bookings.length, 1, "only the pre-existing booking should remain — the loser's row and its customer are rolled back");
  assert.strictEqual(db.customers.length, 0);
});
test("POST dumpster_rental: a different time window on the same date is NOT blocked", async () => {
  const db = freshDb();
  resetBraintree();
  db.bookings.push({ id: "existing-1", customer_id: "c1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_1200_1400" });

  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload({ schedule: { date: FAR_FUTURE_DATE, timeWindow: "w_0800_1000" } }) }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings.length, 2);
});
test("POST dumpster_rental: server-side availability enforcement is independent of anything the client claims — a spoofed 'available' flag changes nothing", async () => {
  const db = freshDb();
  resetBraintree();
  db.bookings.push({ id: "existing-1", customer_id: "c1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_0800_1000" });
  const payload = validDumpsterPayload();
  payload.availabilityConfirmed = true; // not a real field — this endpoint never reads it
  const res = await run(bookHandler, makeReq({ method: "POST", body: payload }));
  assert.strictEqual(res.statusCode, 409);
});

// =======================================================================
// 7b. 2026-09-18 hardening audit §4/§5 — TRUE CONCURRENCY, not sequential
// duplicate POSTs. Both requests in each test below are fired together via
// Promise.all so their internal awaits genuinely interleave (Node's
// single-threaded microtask queue processes each call's pending step in
// turn, exactly the way two separate serverless invocations hitting the
// same real Postgres database would race at the DB level) — this is not
// simulating "request A fully finishes, then request B starts."
// =======================================================================
test("CONCURRENCY: two simultaneous requests with the SAME idempotency key never both call Braintree — exactly one sale(), no double charge", async () => {
  const db = freshDb();
  resetBraintree();
  const payload = validDumpsterPayload(); // same idempotency key AND same slot for both

  const [resA, resB] = await Promise.all([run(bookHandler, makeReq({ method: "POST", body: payload })), run(bookHandler, makeReq({ method: "POST", body: payload }))]);

  const statuses = [resA.statusCode, resB.statusCode].sort();
  assert.deepStrictEqual(statuses, [200, 409], "exactly one of the two concurrent identical requests must succeed");
  assert.strictEqual(saleCallLog.length, 1, "transaction.sale() must be invoked exactly once — this is the actual proof, not just the HTTP status codes");
  assert.strictEqual(db.bookings.length, 1);
  assert.strictEqual(db.rental_payments.length, 1);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");
});
test("CONCURRENCY: two simultaneous requests for the SAME delivery slot (different idempotency keys) — exactly one booking confirmed, the loser retains no charge at all", async () => {
  const db = freshDb();
  resetBraintree();
  const payloadA = validDumpsterPayload();
  const payloadB = validDumpsterPayload(); // fresh idempotency key, same default slot as A

  const [resA, resB] = await Promise.all([run(bookHandler, makeReq({ method: "POST", body: payloadA })), run(bookHandler, makeReq({ method: "POST", body: payloadB }))]);

  const statuses = [resA.statusCode, resB.statusCode].sort();
  assert.deepStrictEqual(statuses, [200, 409]);
  assert.strictEqual(saleCallLog.length, 1, "the losing request must be blocked at the DB slot-claim step and never reach Braintree at all — proves Client A and Client B can never BOTH be charged for the last remaining slot");
  assert.strictEqual(db.bookings.length, 1, "exactly one booking exists — no duplicate active slot");
  assert.strictEqual(db.rental_payments.length, 1, "exactly one payment record — the loser has no retained charge of any kind, not even a stray row");
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");
});
test("CONCURRENCY: two simultaneous admin Approve requests for the SAME charge never both call Braintree", async () => {
  const db = freshDb();
  resetBraintree();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, braintree_payment_method_token: "tok-vaulted-1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const [resA, resB] = await Promise.all([
    run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } })),
    run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } })),
  ]);

  const statuses = [resA.statusCode, resB.statusCode].sort();
  assert.deepStrictEqual(statuses, [200, 409]);
  assert.strictEqual(saleCallLog.length, 1, "transaction.sale() must be invoked exactly once for two concurrent Approve clicks on the same charge");
  assert.strictEqual(db.rental_additional_charges[0].status, "paid");
});

// =======================================================================
// 8. POST /api/book (dumpster_rental) — insert-step failures
// =======================================================================
test("POST dumpster_rental: dumpster_rentals insert failure rolls back the booking and customer, never calls Braintree", async () => {
  const db = freshDb();
  resetBraintree();
  const originalFrom = createFakeServiceClient(db).from;
  currentFakeService = {
    from: function (table) {
      const builder = new FakeQueryBuilder(table, db);
      if (table === "dumpster_rentals") {
        const originalResolve = builder._resolve.bind(builder);
        builder._resolve = async function () {
          if (this._insertPayload) return { data: null, error: { message: "mock insert failure for dumpster_rentals" } };
          return originalResolve();
        };
      }
      return builder;
    },
  };
  const res = await run(bookHandler, makeReq({ method: "POST", body: validDumpsterPayload() }));
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(db.bookings.length, 0);
  assert.strictEqual(db.customers.length, 0);
  assert.strictEqual(saleCallLog.length, 0);
});

// =======================================================================
// 9. Braintree webhook
//
// 2026-09-18 hardening audit correction: transaction_settled/
// transaction_settlement_declined are ACH/SEPA-only per current Braintree
// docs, not fired for the card/Venmo transactions this app actually
// creates — see api/braintree-webhook.js's header. The two tests below
// covering those kinds exist only to prove the (currently dead, harmless,
// future-proofing) handler code is itself correct, not because real
// traffic exercises it. Dispute tests are the ones that matter for actual
// card/Venmo traffic.
// =======================================================================
test("webhook GET ?bt_challenge=: answers with webhookNotification.verify()'s output", async () => {
  resetBraintree();
  const res = await run(webhookHandler, makeReq({ method: "GET", query: { bt_challenge: "abc123" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body, "verified-abc123");
});
test("webhook POST: an invalid signature is rejected with 400 and nothing is written", async () => {
  const db = freshDb();
  resetBraintree();
  webhookParseImpl = async () => {
    throw new Error("signature does not match");
  };
  db.rental_payments.push({ id: "rp1", booking_id: "b1", braintree_transaction_id: "txn-1", payment_status: "paid" });
  const res = await run(webhookHandler, makeReq({ method: "POST", form: true, body: { bt_signature: "bad", bt_payload: "x" } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid", "must be untouched");
});
test("webhook POST: transaction_settlement_declined marks the matching rental_payments row failed", async () => {
  const db = freshDb();
  resetBraintree();
  db.rental_payments.push({ id: "rp1", booking_id: "b1", braintree_transaction_id: "txn-1", payment_status: "paid" });
  webhookParseImpl = async () => ({ kind: "transaction_settlement_declined", transaction: { id: "txn-1" } });
  const res = await run(webhookHandler, makeReq({ method: "POST", form: true, body: { bt_signature: "sig", bt_payload: "payload" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].payment_status, "failed");
});
test("webhook POST: processing the same transaction_settled notification twice is idempotent (Braintree's at-least-once delivery)", async () => {
  const db = freshDb();
  resetBraintree();
  db.rental_payments.push({ id: "rp1", booking_id: "b1", braintree_transaction_id: "txn-2", payment_status: "processing" });
  webhookParseImpl = async () => ({ kind: "transaction_settled", transaction: { id: "txn-2" } });

  const first = await run(webhookHandler, makeReq({ method: "POST", form: true, body: { bt_signature: "sig", bt_payload: "payload" } }));
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");

  const second = await run(webhookHandler, makeReq({ method: "POST", form: true, body: { bt_signature: "sig", bt_payload: "payload" } }));
  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].payment_status, "paid", "re-processing the same delivery must land on the same end state, not error or duplicate anything");
});
test("webhook POST: dispute_opened records dispute_status without changing payment_status", async () => {
  const db = freshDb();
  resetBraintree();
  db.rental_payments.push({ id: "rp1", booking_id: "b1", braintree_transaction_id: "txn-3", payment_status: "paid" });
  webhookParseImpl = async () => ({ kind: "dispute_opened", dispute: { transaction: { id: "txn-3" } } });
  const res = await run(webhookHandler, makeReq({ method: "POST", form: true, body: { bt_signature: "sig", bt_payload: "payload" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.rental_payments[0].dispute_status, "opened");
  assert.strictEqual(db.rental_payments[0].payment_status, "paid");
});
test("webhook POST: settlement events also update a matching rental_additional_charges row when no rental_payments row matches", async () => {
  const db = freshDb();
  resetBraintree();
  db.rental_additional_charges.push({ id: "rac1", booking_id: "b1", braintree_transaction_id: "txn-4", status: "processing" });
  webhookParseImpl = async () => ({ kind: "transaction_settled", transaction: { id: "txn-4" } });
  const res = await run(webhookHandler, makeReq({ method: "POST", form: true, body: { bt_signature: "sig", bt_payload: "payload" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.rental_additional_charges[0].status, "paid");
});

// =======================================================================
// 10. Admin additional-charge propose/approve workflow
// =======================================================================
test("admin charges: no admin session -> 401, no DB or Braintree calls", async () => {
  const db = freshDb();
  resetBraintree();
  currentFakeService = createFakeServiceClient(db);
  currentFakeAnon = createFakeAnonClient();
  const res = await run(bookingHandler, makeReq({ method: "POST", query: { resource: "charges" }, body: { bookingId: "x" } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(saleCallLog.length, 0);
});
test("admin charges: proposing an overweight_tonnage charge computes amount from the current rate and never calls Braintree", async () => {
  const db = freshDb();
  resetBraintree();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "dumpster_rental" });

  const res = await run(
    bookingHandler,
    makeReq({ method: "POST", query: { resource: "charges" }, cookie: adminCookie(), body: { bookingId: BOOKING_ID, chargeType: "overweight_tonnage", quantity: 1.5 } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "proposed");
  assert.strictEqual(res.body.charge.quantity, 1.5);
  assert.strictEqual(res.body.charge.rate, 90.0);
  assert.strictEqual(res.body.charge.amount, 135.0);
  assert.strictEqual(saleCallLog.length, 0, "a proposal must never move money");
});
test("admin charges: proposing an additional_days charge computes amount from the day rate", async () => {
  const db = freshDb();
  resetBraintree();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "dumpster_rental" });
  const res = await run(
    bookingHandler,
    makeReq({ method: "POST", query: { resource: "charges" }, cookie: adminCookie(), body: { bookingId: BOOKING_ID, chargeType: "additional_days", quantity: 3 } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.amount, 45.0);
});
test("admin charges: proposing on a non-dumpster-rental booking is rejected", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "junk_removal" });
  const res = await run(
    bookingHandler,
    makeReq({ method: "POST", query: { resource: "charges" }, cookie: adminCookie(), body: { bookingId: BOOKING_ID, chargeType: "additional_days", quantity: 1 } })
  );
  assert.strictEqual(res.statusCode, 400);
});
test("admin charges: approving a proposed charge charges the vaulted payment method and marks it paid", async () => {
  const db = freshDb();
  resetBraintree();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "dumpster_rental" });
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, braintree_payment_method_token: "tok-vaulted-1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "paid");
  assert.strictEqual(saleCallLog.length, 1);
  assert.strictEqual(saleCallLog[0].amount, "90.00");
  assert.strictEqual(saleCallLog[0].paymentMethodToken, "tok-vaulted-1");
  assert.strictEqual(db.rental_additional_charges[0].approved_by, ADMIN_EMAIL);
  assert.ok(db.rental_additional_charges[0].approved_at);
});
test("admin charges: approving ignores any client-submitted amount — only the row's own snapshotted amount is ever charged", async () => {
  const db = freshDb();
  resetBraintree();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, braintree_payment_method_token: "tok-vaulted-1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const res = await run(
    bookingHandler,
    makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve", amount: 1 } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(saleCallLog[0].amount, "90.00");
});
test("admin charges: a second concurrent Approve on the same charge is rejected with 409, never a second charge", async () => {
  const db = freshDb();
  resetBraintree();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, braintree_payment_method_token: "tok-vaulted-1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const first = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(saleCallLog.length, 1);

  const second = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(second.statusCode, 409);
  assert.strictEqual(saleCallLog.length, 1, "approving an already-processed charge must never call Braintree again");
});
test("admin charges: a declined approved charge is recorded as failed with a reason, admin can see it and retry later", async () => {
  const db = freshDb();
  resetBraintree();
  saleImpl = async () => declineSaleResult("Insufficient Funds");
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, braintree_payment_method_token: "tok-vaulted-1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "failed");
  assert.ok(/Insufficient Funds/.test(res.body.charge.failureReason));
});
test("admin charges: a 'failed' (cleanly declined) charge IS safely retryable — a second Approve after the decline succeeds and charges exactly once more", async () => {
  const db = freshDb();
  resetBraintree();
  saleImpl = async () => declineSaleResult("Insufficient Funds");
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, braintree_payment_method_token: "tok-vaulted-1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const first = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(first.body.charge.status, "failed");
  assert.strictEqual(saleCallLog.length, 1);

  // Customer presumably fixed their card — admin clicks Approve again.
  saleImpl = async () => defaultSaleSuccess();
  const second = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(second.body.charge.status, "paid");
  assert.strictEqual(saleCallLog.length, 2, "exactly one more call for the retry — not a duplicate of the first, not blocked");
  assert.strictEqual(db.rental_additional_charges[0].failure_reason, null, "the stale decline reason must be cleared once the retry succeeds");
});
test("admin charges: an ambiguous Braintree failure (thrown error) during approval is marked error_pending_review and is NOT retryable via Approve again", async () => {
  const db = freshDb();
  resetBraintree();
  saleImpl = async () => {
    throw new Error("ECONNRESET");
  };
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, braintree_payment_method_token: "tok-vaulted-1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const first = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(first.body.charge.status, "error_pending_review");
  assert.ok(/outcome unknown/i.test(first.body.charge.failureReason));
  assert.strictEqual(saleCallLog.length, 1);

  // Admin (or a naive double-click) tries Approve again — must be refused,
  // never silently retried, since the first attempt's outcome is unknown.
  saleImpl = async () => defaultSaleSuccess();
  const second = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(second.statusCode, 409);
  assert.strictEqual(saleCallLog.length, 1, "must never call Braintree again for a charge stuck in error_pending_review");
});
test("admin charges: if the post-charge 'mark paid' DB update fails, the response still reports success — the charge already succeeded, so this must never be reported as a failure", async () => {
  const db = freshDb();
  resetBraintree();
  currentFakeService = {
    from: function (table) {
      const builder = new FakeQueryBuilder(table, db);
      if (table === "rental_additional_charges") {
        const originalResolve = builder._resolve.bind(builder);
        builder._resolve = async function () {
          if (this._updatePayload && this._updatePayload.status === "paid") {
            return { data: null, error: { message: "mock update failure" } };
          }
          return originalResolve();
        };
      }
      return builder;
    },
  };
  configureAdminAuth();
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, braintree_payment_method_token: "tok-vaulted-1" });
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });

  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "paid");
  assert.ok(res.body.warning, "should note the record couldn't be confirmed even though the charge succeeded");
  assert.strictEqual(saleCallLog.length, 1, "must not attempt to charge a second time trying to recover from a local DB write failure");
});
test("admin charges: proposing overweight_tonnage uses THIS booking's own locked-in rate, not the current global rate, when they differ", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "dumpster_rental" });
  // Simulates a booking paid under an OLD rate schedule, before a global
  // pricing change to $120/ton (rentalPricing.OVERAGE_TON_RATE is still
  // $90 in the current global config — this row's own $75 must win).
  db.rental_payments.push({ id: "rp1", booking_id: BOOKING_ID, overage_ton_rate: 75, overage_day_rate: 10 });

  const res = await run(
    bookingHandler,
    makeReq({ method: "POST", query: { resource: "charges" }, cookie: adminCookie(), body: { bookingId: BOOKING_ID, chargeType: "overweight_tonnage", quantity: 2 } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.rate, 75, "must use this booking's own locked-in rate, not the current global $90 rate");
  assert.strictEqual(res.body.charge.amount, 150);
});
test("admin charges: proposing on a booking with no rental_payments row of its own falls back to the current global rate", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, service_type: "dumpster_rental" });
  const res = await run(
    bookingHandler,
    makeReq({ method: "POST", query: { resource: "charges" }, cookie: adminCookie(), body: { bookingId: BOOKING_ID, chargeType: "overweight_tonnage", quantity: 1 } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.rate, rentalPricing.OVERAGE_TON_RATE);
});
test("admin charges: approving a booking with no payment method on file fails cleanly without calling Braintree", async () => {
  const db = freshDb();
  resetBraintree();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, charge_type: "overweight_tonnage", quantity: 1, rate: 90, amount: 90, status: "proposed" });
  const res = await run(bookingHandler, makeReq({ method: "PATCH", query: { resource: "charges" }, cookie: adminCookie(), body: { id: CHARGE_ID, action: "approve" } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charge.status, "failed");
  assert.strictEqual(saleCallLog.length, 0);
});
test("admin charges: GET lists charges for a booking, newest first", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.rental_additional_charges.push({ id: CHARGE_ID, booking_id: BOOKING_ID, status: "proposed", created_at: "2026-01-01T00:00:00Z" });
  db.rental_additional_charges.push({ id: "rac2", booking_id: BOOKING_ID, status: "paid", created_at: "2026-02-01T00:00:00Z" });
  const res = await run(bookingHandler, makeReq({ method: "GET", query: { resource: "charges", bookingId: BOOKING_ID }, cookie: adminCookie() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.charges.length, 2);
  assert.strictEqual(res.body.charges[0].id, "rac2");
});
test("admin booking detail (GET, no resource param): includes payment info for a booking that was paid online", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, customer_id: "cust-1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_0800_1000" });
  db.customers.push({ id: "cust-1", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com" });
  db.rental_payments.push({
    id: "rp1",
    booking_id: BOOKING_ID,
    payment_status: "paid",
    amount_charged: 349,
    payment_method_summary: "Visa ending in 4242",
    braintree_transaction_id: "txn-9",
    agreement_version: "2026-09-18",
    agreement_accepted_at: "2026-09-18T12:00:00Z",
    dispute_status: null,
  });
  const res = await run(bookingHandler, makeReq({ method: "GET", query: { id: BOOKING_ID }, cookie: adminCookie() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.payment.status, "paid");
  assert.strictEqual(res.body.payment.amountCharged, 349);
  assert.strictEqual(res.body.payment.methodSummary, "Visa ending in 4242");
  assert.strictEqual(res.body.payment.transactionId, "txn-9");
});
test("admin booking detail (GET): payment is null for a booking with no rental_payments row (e.g. an admin-created dumpster rental)", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, customer_id: "cust-1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_0800_1000" });
  db.customers.push({ id: "cust-1", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com" });
  const res = await run(bookingHandler, makeReq({ method: "GET", query: { id: BOOKING_ID }, cookie: adminCookie() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.payment, null);
});
test("admin booking detail (GET): exposes failureReason for a payment stuck in error_pending_review, so the admin sees why without opening Braintree first", async () => {
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  configureAdminAuth();
  db.bookings.push({ id: BOOKING_ID, customer_id: "cust-1", service_type: "dumpster_rental", status: "booked", appointment_date: FAR_FUTURE_DATE, time_window: "w_0800_1000" });
  db.customers.push({ id: "cust-1", first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com" });
  db.rental_payments.push({
    id: "rp1",
    booking_id: BOOKING_ID,
    payment_status: "error_pending_review",
    amount_charged: 349,
    failure_reason: "Braintree request failed/timed out before a response was received. Outcome unknown — check the Braintree dashboard for a matching transaction before taking any action.",
  });
  const res = await run(bookingHandler, makeReq({ method: "GET", query: { id: BOOKING_ID }, cookie: adminCookie() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.payment.status, "error_pending_review");
  assert.ok(/outcome unknown/i.test(res.body.payment.failureReason));
});

// =======================================================================
// 11. Existing junk_removal/light_demo behavior is unaffected
// =======================================================================
test("POST /api/book: junk_removal booking still succeeds exactly as before, no payment fields required, status left unset", async () => {
  const db = freshDb();
  resetBraintree();
  const res = await run(
    bookHandler,
    makeReq({
      method: "POST",
      body: {
        serviceType: "junk_removal",
        hp: "",
        elapsedMs: 10000,
        jobDetails: { itemsDescription: "Old couch", location: "Garage", stairs: "none", additionalDetails: "" },
        schedule: { date: FAR_FUTURE_DATE, timeWindow: "w_0800_1000" },
        customer: { firstName: "Jamie", lastName: "Rivera", phone: "303-555-0100", email: "jamie@example.com", streetAddress: "123 Main St", city: "Denver", state: "CO", zip: "80202" },
      },
    })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.bookings[0].status, undefined, "junk_removal must still never set status explicitly");
  assert.strictEqual(saleCallLog.length, 0);
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
      console.error("FAIL - " + t.name);
      console.error("      " + (err && err.message ? err.message : err));
      if (err && err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
    }
  }
  console.log("\n" + registered.length + " tests run, " + failed + " failed.");
  process.exit(failed ? 1 : 0);
}
main();
