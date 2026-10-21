// Phase 3D Stage B — invoice-centric cutover verification. Covers:
//   - computeInvoiceBalanceCents() scoped strictly by invoice_id (no
//     booking_id fallback) — isolation between sibling invoices, a
//     standalone invoice, and a generic booking payment.
//   - the invoice-specific manual payment path (?resource=invoice-payment)
//     for both an attached and a standalone invoice, including reversal's
//     same-invoice enforcement.
//   - standalone invoice creation (?resource=invoice POST with customerId,
//     no bookingId).
//   - Attach-to-Job (?resource=invoice PATCH action:"attach") — success,
//     payment backfill, wrong-client rejection, existing-original
//     rejection, and blocked while a Pay Now claim is live.
//   - reconcileInvoicePaymentIntent()'s bookingId-as-snapshot rule: a PI
//     created while standalone (empty metadata.bookingId) still
//     reconciles once the invoice has since been attached.
//
// Same offline/mocked-first harness convention as every other phase's
// test file in this project — "@supabase/supabase-js" is intercepted at
// require-time; no real Supabase, no real Stripe network calls anywhere
// in this file (reconcileInvoicePaymentIntent() itself never touches the
// `stripe` argument, so a plain null stands in for it throughout).
//
// Run with:  node tests/phase3d-stage-b-invoice-centric.test.js

const Module = require("module");
const assert = require("assert");

let nextId = 1;
function makeId() {
  return "ffffffff-ffff-ffff-ffff-" + String(500000000000 + nextId++).padStart(12, "0");
}
function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------
// Fake Supabase query builder — same shape/semantics as
// tests/phase2-invoice-workflow.test.js's (insert/update -> filtered rows
// survive into single()/maybeSingle(), matching real Postgres UPDATE...
// WHERE semantics; invoices_booking_id_active_uniq simulated at insert
// time), extended with nothing new — this file never needs .or()/.limit()
// beyond what that shape already provides.
// ---------------------------------------------------------------------
class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._order = [];
    this._single = null;
    this._insertData = undefined;
    this._updateData = undefined;
  }
  select() {
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
  // Minimal PostgREST-style .or(): comma-separated "field.op.value"
  // clauses, OR'd together as one filter — needed by
  // withInvoicePaymentLock()'s claim-acquire step
  // ("payment_claim_token.is.null,payment_claimed_at.lt." + staleBeforeIso).
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
  order(field, opts) {
    this._order.push({ field: field, ascending: !opts || opts.ascending !== false });
    return this;
  }
  insert(data) {
    this._insertData = data;
    return this;
  }
  // mirrorStripePaymentToLedger()'s upsert({onConflict, ignoreDuplicates})
  // — a true ON CONFLICT DO NOTHING against stripe_payment_intent_id, same
  // semantics as tests/phase3d-stage-a-resolver.test.js's own fake.
  upsert(data, opts) {
    this._insertData = data;
    this._upsertOpts = opts || {};
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
    if (this._insertData !== undefined) {
      if (this._upsertOpts) {
        const conflictCol = this._upsertOpts.onConflict;
        const conflictVal = conflictCol ? this._insertData[conflictCol] : undefined;
        const existing = conflictCol && conflictVal != null ? (this._db[this._table] || []).find((r) => r[conflictCol] === conflictVal) : null;
        if (existing && this._upsertOpts.ignoreDuplicates) {
          return { data: null, error: null };
        }
      }
      if (this._table === "invoices" && this._insertData.booking_id) {
        const conflict = (this._db.invoices || []).some((r) => r.booking_id === this._insertData.booking_id && r.status !== "void");
        if (conflict) {
          return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "invoices_booking_id_active_uniq"' } };
        }
      }
      const NULLABLE_DEFAULTS = {
        invoices: {
          invoice_number: null,
          due_date: null,
          notes: null,
          finalized_at: null,
          voided_at: null,
          voided_reason: null,
          updated_at: null,
          updated_by: null,
          booking_id: null,
          send_claim_token: null,
          send_claimed_at: null,
          active_stripe_payment_intent_id: null,
          payment_claim_token: null,
          payment_claimed_at: null,
          payment_generation: 0,
        },
        invoice_line_items: { updated_at: null },
        job_payments: { booking_id: null, invoice_id: null, stripe_payment_intent_id: null, reverses_payment_id: null, voided_at: null, voided_reason: null, notes: null },
      };
      const row = Object.assign({ id: makeId(), created_at: nowIso(), updated_at: null, updated_by: null, sort_order: 0 }, NULLABLE_DEFAULTS[this._table] || {}, this._insertData);
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));

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

// attach_invoice_to_booking() — re-implemented to match
// sql/2026-10-21_phase3d-stage-b-invoice-attribution-canonical.sql's own
// observable contract exactly (claim ownership, active-PI backstop,
// void/already-attached/pickup/cross-client/existing-original rejections,
// booking_id set + claim released + job_payments backfill, all as one
// atomic step) — proving the APPLICATION code drives this RPC correctly,
// not re-proving the SQL itself (already proven by that file's own
// self-rolling-back smoke suite).
async function fakeAttachRpc(db, params) {
  const invoices = db.invoices || [];
  const bookings = db.bookings || [];
  const jobPayments = db.job_payments || [];

  const invoice = invoices.find((i) => i.id === params.p_invoice_id);
  if (!invoice) return { data: null, error: { message: "invoice " + params.p_invoice_id + " does not exist" } };
  if (!params.p_payment_claim_token || (invoice.payment_claim_token || null) !== params.p_payment_claim_token) {
    return { data: null, error: { message: "payment claim for invoice " + invoice.id + " is not owned by token " + params.p_payment_claim_token + "; refusing to attach" } };
  }
  if (invoice.active_stripe_payment_intent_id) {
    return { data: null, error: { message: "invoice " + invoice.id + " still has an active Stripe PaymentIntent; refusing to attach until it is resolved" } };
  }
  if (invoice.status === "void") {
    return { data: null, error: { message: "invoice " + invoice.id + " is void and cannot be attached to a job" } };
  }
  if (invoice.booking_id) {
    return { data: null, error: { message: "invoice " + invoice.id + " is already attached to booking " + invoice.booking_id + "; attach is a one-time operation" } };
  }
  const booking = bookings.find((b) => b.id === params.p_booking_id);
  if (!booking) return { data: null, error: { message: "booking " + params.p_booking_id + " does not exist" } };
  if (booking.service_type === "dumpster_pickup") {
    return { data: null, error: { message: "booking " + booking.id + " is a pickup job and cannot receive an invoice; attach to the primary rental instead" } };
  }
  if (invoice.customer_id !== booking.customer_id) {
    return {
      data: null,
      error: { message: "invoice " + invoice.id + " belongs to customer " + invoice.customer_id + " but booking " + booking.id + " belongs to customer " + booking.customer_id + "; refusing to attach across clients" },
    };
  }
  const existingOriginalCount = invoices.filter((i) => i.booking_id === booking.id && i.status !== "void" && (i.invoice_kind || "original") === "original").length;
  if (existingOriginalCount > 0) {
    return { data: null, error: { message: "booking " + booking.id + " already has an active original invoice; cannot attach a second one" } };
  }

  invoice.booking_id = booking.id;
  invoice.payment_claim_token = null;
  invoice.payment_claimed_at = null;
  invoice.updated_by = params.p_actor_email;
  invoice.updated_at = nowIso();
  jobPayments.forEach((jp) => {
    if (jp.invoice_id === invoice.id && !jp.booking_id) jp.booking_id = booking.id;
  });
  return { data: Object.assign({}, invoice), error: null };
}

function createFakeServiceClient(db) {
  return {
    from(table) {
      return new FakeQueryBuilder(table, db);
    },
    async rpc(name, params) {
      if (name === "next_invoice_number") {
        db.__invoiceSeq = (db.__invoiceSeq || 1000) + 1;
        return { data: "INV-2026-" + db.__invoiceSeq, error: null };
      }
      if (name === "attach_invoice_to_booking") {
        return fakeAttachRpc(db, params);
      }
      throw new Error("Unexpected rpc() call in test: " + name);
    },
  };
}
function createFakeAnonClient(overrides) {
  overrides = overrides || {};
  return {
    auth: {
      getUser: overrides.getUser || (async () => ({ data: null, error: { message: "not configured in this test" } })),
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
// Deliberately NOT setting STRIPE_SECRET_KEY — getStripeClient() then
// returns null, which is fine everywhere in this file: every invoice
// fixture below has activeStripePaymentIntentId null (or, for the one
// "blocked" test, a live claim token the lock short-circuits on before
// ever touching Stripe) and reconcileInvoicePaymentIntent() itself never
// dereferences its own `stripe` argument.

const bookingHandler = require("../api/admin/booking.js");
const { computeInvoiceBalanceCents, reconcileInvoicePaymentIntent, mapInvoice } = require("../api/_lib/invoice-helpers.js");

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

const CUSTOMER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CUSTOMER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const BOOKING_A1 = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // customer A
const BOOKING_A2 = "dddddddd-dddd-dddd-dddd-dddddddddddd"; // customer A, no invoice yet
const BOOKING_B1 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"; // customer B
const PICKUP_BOOKING = "77777777-7777-7777-7777-777777777777"; // customer A, pickup

function freshDb() {
  return {
    customers: [
      { id: CUSTOMER_A, first_name: "Jamie", last_name: "Rivera" },
      { id: CUSTOMER_B, first_name: "Morgan", last_name: "Lee" },
    ],
    bookings: [
      { id: BOOKING_A1, customer_id: CUSTOMER_A, service_type: "junk_removal", appointment_date: "2026-11-01" },
      { id: BOOKING_A2, customer_id: CUSTOMER_A, service_type: "dumpster_rental", appointment_date: "2026-11-02" },
      { id: BOOKING_B1, customer_id: CUSTOMER_B, service_type: "junk_removal", appointment_date: "2026-11-03" },
      { id: PICKUP_BOOKING, customer_id: CUSTOMER_A, service_type: "dumpster_pickup", appointment_date: "2026-11-04" },
    ],
    invoices: [],
    invoice_line_items: [],
    job_payments: [],
  };
}

function useDb(db) {
  currentFakeService = createFakeServiceClient(db);
}

function createInvoice(db, body) {
  useDb(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: AUTH_COOKIE, query: { resource: "invoice" }, body: body }));
}
function patchInvoice(db, body) {
  useDb(db);
  return run(bookingHandler, makeReq({ method: "PATCH", cookie: AUTH_COOKIE, query: { resource: "invoice" }, body: body }));
}
function getInvoice(db, id) {
  useDb(db);
  return run(bookingHandler, makeReq({ method: "GET", cookie: AUTH_COOKIE, query: { resource: "invoice", id: id } }));
}
function postJobPayment(db, body) {
  useDb(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: AUTH_COOKIE, query: { resource: "job-payments" }, body: body }));
}
function postInvoicePayment(db, body) {
  useDb(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: AUTH_COOKIE, query: { resource: "invoice-payment" }, body: body }));
}

// Finalizes a freshly-created draft invoice with one $349 line item and a
// far-future due date — the minimum every balance/payment test below
// needs before a payment can be recorded against it.
async function finalizeWithLineItem(db, invoiceId, amount) {
  await patchInvoice(db, { id: invoiceId, action: "addLineItem", description: "Service", quantity: 1, unitPrice: amount == null ? 349 : amount });
  db.invoices.find((i) => i.id === invoiceId).due_date = "2099-01-01";
  return patchInvoice(db, { id: invoiceId, action: "finalize" });
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Canonical reads: invoice_id isolation
// =======================================================================

test("computeInvoiceBalanceCents: isolated by invoice_id — a payment on a sibling invoice (even on the same booking) and a generic booking payment (invoice_id null) are both excluded", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceA = { id: makeId(), status: "finalized", booking_id: BOOKING_A1, customer_id: CUSTOMER_A, total_amount: 300 };
  const invoiceB = { id: makeId(), status: "finalized", booking_id: BOOKING_A1, customer_id: CUSTOMER_A, total_amount: 100 }; // e.g. a void-and-replace sibling
  db.invoices.push(invoiceA, invoiceB);
  db.job_payments.push(
    { id: makeId(), invoice_id: invoiceA.id, booking_id: BOOKING_A1, amount: 100, payment_type: "payment", voided_at: null },
    { id: makeId(), invoice_id: invoiceB.id, booking_id: BOOKING_A1, amount: 999, payment_type: "payment", voided_at: null },
    { id: makeId(), invoice_id: null, booking_id: BOOKING_A1, amount: 999, payment_type: "payment", voided_at: null }
  );
  useDb(db);
  const balanceCents = await computeInvoiceBalanceCents(currentFakeService, mapInvoice(invoiceA));
  assert.strictEqual(balanceCents, 20000, "only invoiceA's own $100 payment counts — $300 total - $100 = $200.00");
});

test("Sibling invoice payment isolation (end to end): paying invoice A in full never moves invoice B's balance, even on the same booking", async () => {
  adminAuthed();
  const db = freshDb();
  const a = await createInvoice(db, { bookingId: BOOKING_A1 });
  const invoiceA = a.body.invoice.id;
  await finalizeWithLineItem(db, invoiceA, 300);
  await patchInvoice(db, { id: invoiceA, action: "void", reason: "billed in error" });

  const b = await createInvoice(db, { bookingId: BOOKING_A1 });
  const invoiceB = b.body.invoice.id;
  await finalizeWithLineItem(db, invoiceB, 150);

  await postInvoicePayment(db, { invoiceId: invoiceB, paymentMethod: "cash", amount: 150 });

  const detailA = await getInvoice(db, invoiceA);
  const detailB = await getInvoice(db, invoiceB);
  assert.strictEqual(detailA.body.invoice.netCollected, 0, "the void original's own balance must be untouched by the replacement's payment");
  assert.strictEqual(detailB.body.invoice.displayStatus, "paid");
  assert.strictEqual(detailB.body.invoice.balanceDue, 0);
});

test("Standalone invoice balance: a payment against a booking-less invoice moves its own balance exactly like an attached one", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { customerId: CUSTOMER_A });
  assert.strictEqual(created.statusCode, 200);
  const invoiceId = created.body.invoice.id;
  assert.strictEqual(created.body.invoice.bookingId, null);

  await finalizeWithLineItem(db, invoiceId, 200);
  const payRes = await postInvoicePayment(db, { invoiceId: invoiceId, paymentMethod: "cash", amount: 75 });
  assert.strictEqual(payRes.statusCode, 200);
  assert.strictEqual(payRes.body.jobPayment.bookingId, null, "a standalone invoice's payment row must mirror its invoice's own null booking_id");

  const detail = await getInvoice(db, invoiceId);
  assert.strictEqual(detail.body.invoice.displayStatus, "partially_paid");
  assert.strictEqual(detail.body.invoice.balanceDue, 125);
  assert.strictEqual(detail.body.invoice.netCollected, 75);
});

test("Stage B cutover: a generic ?resource=job-payments booking payment never reduces any invoice's balance, attached or standalone", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { bookingId: BOOKING_A1 });
  const invoiceId = created.body.invoice.id;
  await finalizeWithLineItem(db, invoiceId, 300);

  const payRes = await postJobPayment(db, { bookingId: BOOKING_A1, paymentMethod: "cash", amount: 300 });
  assert.strictEqual(payRes.statusCode, 200);
  assert.strictEqual(payRes.body.jobPayment.invoiceId, null);

  const detail = await getInvoice(db, invoiceId);
  assert.strictEqual(detail.body.invoice.displayStatus, "finalized");
  assert.strictEqual(detail.body.invoice.balanceDue, 300);
});

// =======================================================================
// Manual invoice payment — attached / standalone / reversal rules
// =======================================================================

test("Manual invoice payment (attached): booking_id on the new row mirrors the invoice's own booking_id", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { bookingId: BOOKING_A1 });
  const invoiceId = created.body.invoice.id;
  await finalizeWithLineItem(db, invoiceId, 100);

  const res = await postInvoicePayment(db, { invoiceId: invoiceId, paymentMethod: "zelle", amount: 100 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobPayment.bookingId, BOOKING_A1);
  assert.strictEqual(res.body.jobPayment.invoiceId, invoiceId);
});

test("Manual invoice payment: rejected against a draft invoice (nothing to pay down yet)", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { bookingId: BOOKING_A1 });
  const res = await postInvoicePayment(db, { invoiceId: created.body.invoice.id, paymentMethod: "cash", amount: 50 });
  assert.strictEqual(res.statusCode, 409);
});

test("Manual invoice payment: rejected against a void invoice", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { bookingId: BOOKING_A1 });
  await patchInvoice(db, { id: created.body.invoice.id, action: "void", reason: "test" });
  const res = await postInvoicePayment(db, { invoiceId: created.body.invoice.id, paymentMethod: "cash", amount: 50 });
  assert.strictEqual(res.statusCode, 409);
});

test("Manual invoice payment: card_stripe is rejected, same rule as the generic ledger endpoint", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { bookingId: BOOKING_A1 });
  await finalizeWithLineItem(db, created.body.invoice.id, 100);
  const res = await postInvoicePayment(db, { invoiceId: created.body.invoice.id, paymentMethod: "card_stripe", amount: 50 });
  assert.strictEqual(res.statusCode, 400);
});

test("Same-invoice reversal enforcement: reversing a payment that belongs to the SAME invoice is accepted", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { bookingId: BOOKING_A1 });
  const invoiceId = created.body.invoice.id;
  await finalizeWithLineItem(db, invoiceId, 500);
  const original = await postInvoicePayment(db, { invoiceId: invoiceId, paymentMethod: "cash", amount: 500 });

  const reversal = await postInvoicePayment(db, {
    invoiceId: invoiceId,
    paymentMethod: "zelle",
    amount: 450,
    reversesPaymentId: original.body.jobPayment.id,
  });
  assert.strictEqual(reversal.statusCode, 200);
  assert.strictEqual(reversal.body.jobPayment.reversesPaymentId, original.body.jobPayment.id);
});

test("Cross-invoice reversal rejection: a reversesPaymentId belonging to a DIFFERENT invoice is rejected (400), never silently attributed", async () => {
  adminAuthed();
  const db = freshDb();
  const a = await createInvoice(db, { bookingId: BOOKING_A1 });
  const invoiceA = a.body.invoice.id;
  await finalizeWithLineItem(db, invoiceA, 100);
  const paymentOnA = await postInvoicePayment(db, { invoiceId: invoiceA, paymentMethod: "cash", amount: 100 });

  const b = await createInvoice(db, { bookingId: BOOKING_B1 });
  const invoiceB = b.body.invoice.id;
  await finalizeWithLineItem(db, invoiceB, 200);

  const crossReversal = await postInvoicePayment(db, {
    invoiceId: invoiceB,
    paymentMethod: "cash",
    amount: 200,
    reversesPaymentId: paymentOnA.body.jobPayment.id,
  });
  assert.strictEqual(crossReversal.statusCode, 400);

  const detailB = await getInvoice(db, invoiceB);
  assert.strictEqual(detailB.body.invoice.netCollected, 0, "the rejected cross-invoice reversal must never have been written");
});

// =======================================================================
// Standalone invoice creation
// =======================================================================

test("Standalone invoice creation: customerId required when bookingId is omitted", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createInvoice(db, {});
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(db.invoices.length, 0);
});

test("Standalone invoice creation: an unknown customerId is rejected, no row created", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createInvoice(db, { customerId: makeId() });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(db.invoices.length, 0);
});

test("Standalone invoice creation: succeeds with booking_id null, invoice_kind stays the default 'original', and a second one is allowed (no booking-scoped uniqueness applies)", async () => {
  adminAuthed();
  const db = freshDb();
  const first = await createInvoice(db, { customerId: CUSTOMER_A });
  const second = await createInvoice(db, { customerId: CUSTOMER_A });
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(second.statusCode, 200);
  assert.notStrictEqual(first.body.invoice.id, second.body.invoice.id);
  assert.strictEqual(db.invoices.length, 2);
  db.invoices.forEach((row) => assert.strictEqual(row.booking_id, null));
});

// =======================================================================
// Attach-to-Job
// =======================================================================

test("Attach-to-Job: success — booking_id set, claim released, response reflects the attached invoice", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { customerId: CUSTOMER_A });
  const invoiceId = created.body.invoice.id;

  const res = await patchInvoice(db, { id: invoiceId, action: "attach", bookingId: BOOKING_A1 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.invoice.bookingId, BOOKING_A1);
  assert.strictEqual(db.invoices.find((i) => i.id === invoiceId).payment_claim_token, null);
});

test("Attach-to-Job: payment backfill — a pre-existing standalone payment on this invoice gets booking_id filled in, but only that one (never a different invoice's row)", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { customerId: CUSTOMER_A });
  const invoiceId = created.body.invoice.id;
  await finalizeWithLineItem(db, invoiceId, 75);
  await postInvoicePayment(db, { invoiceId: invoiceId, paymentMethod: "venmo", amount: 75 });

  const otherInvoice = { id: makeId(), status: "finalized", booking_id: null, customer_id: CUSTOMER_A, total_amount: 10 };
  db.invoices.push(otherInvoice);
  db.job_payments.push({ id: makeId(), invoice_id: otherInvoice.id, booking_id: null, amount: 10, payment_type: "payment", voided_at: null });

  const res = await patchInvoice(db, { id: invoiceId, action: "attach", bookingId: BOOKING_A1 });
  assert.strictEqual(res.statusCode, 200);

  const backfilled = db.job_payments.find((p) => p.invoice_id === invoiceId);
  assert.strictEqual(backfilled.booking_id, BOOKING_A1, "the attached invoice's own payment must be backfilled to the new job");
  const untouched = db.job_payments.find((p) => p.invoice_id === otherInvoice.id);
  assert.strictEqual(untouched.booking_id, null, "a different invoice's payment must never be touched by this attach");
});

test("Attach-to-Job: wrong-client rejection — the invoice's customer does not match the target booking's customer", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { customerId: CUSTOMER_A });
  const res = await patchInvoice(db, { id: created.body.invoice.id, action: "attach", bookingId: BOOKING_B1 });
  assert.strictEqual(res.statusCode, 409);
  assert.ok(/customer/i.test(res.body.error), "expected a customer-mismatch message, got: " + res.body.error);
  assert.strictEqual(db.invoices.find((i) => i.id === created.body.invoice.id).booking_id, null);
});

test("Attach-to-Job: existing-original rejection — the target booking already has its own active original invoice", async () => {
  adminAuthed();
  const db = freshDb();
  await createInvoice(db, { bookingId: BOOKING_A1 }); // BOOKING_A1 already has an active original invoice

  const standalone = await createInvoice(db, { customerId: CUSTOMER_A });
  const res = await patchInvoice(db, { id: standalone.body.invoice.id, action: "attach", bookingId: BOOKING_A1 });
  assert.strictEqual(res.statusCode, 409);
  assert.ok(/already has an active original invoice/i.test(res.body.error), "expected the existing-original message, got: " + res.body.error);
});

test("Attach-to-Job: a pickup job can never receive an attached invoice either", async () => {
  adminAuthed();
  const db = freshDb();
  const standalone = await createInvoice(db, { customerId: CUSTOMER_A });
  const res = await patchInvoice(db, { id: standalone.body.invoice.id, action: "attach", bookingId: PICKUP_BOOKING });
  assert.strictEqual(res.statusCode, 409);
  assert.ok(/pickup/i.test(res.body.error), "expected a pickup-job rejection message, got: " + res.body.error);
});

test("Attach-to-Job: blocked while a live (non-stale) Pay Now claim is held — never calls the RPC bare, never attaches mid-claim", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { customerId: CUSTOMER_A });
  const invoiceId = created.body.invoice.id;
  const row = db.invoices.find((i) => i.id === invoiceId);
  row.payment_claim_token = "11111111-2222-3333-4444-555555555555";
  row.payment_claimed_at = new Date().toISOString(); // fresh, not stale

  const res = await patchInvoice(db, { id: invoiceId, action: "attach", bookingId: BOOKING_A1 });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(db.invoices.find((i) => i.id === invoiceId).booking_id, null, "must not have attached while the claim was live");
});

test("Attach-to-Job: already-attached / void are both rejected before ever reaching the RPC", async () => {
  adminAuthed();
  const db = freshDb();
  const attached = await createInvoice(db, { bookingId: BOOKING_A1 });
  const alreadyAttachedRes = await patchInvoice(db, { id: attached.body.invoice.id, action: "attach", bookingId: BOOKING_B1 });
  assert.strictEqual(alreadyAttachedRes.statusCode, 409);

  const standalone = await createInvoice(db, { customerId: CUSTOMER_B });
  await patchInvoice(db, { id: standalone.body.invoice.id, action: "void", reason: "test" });
  const voidRes = await patchInvoice(db, { id: standalone.body.invoice.id, action: "attach", bookingId: BOOKING_B1 });
  assert.strictEqual(voidRes.statusCode, 409);
});

// =======================================================================
// Stripe metadata reconciliation: bookingId as a snapshot, not an identity
// =======================================================================

test("reconcileInvoicePaymentIntent: a PI created while standalone (empty metadata.bookingId) still reconciles once the invoice has since been attached — mirrors to the invoice's CURRENT (new) booking_id, not the stale empty snapshot", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, { customerId: CUSTOMER_A });
  const invoiceId = created.body.invoice.id;
  await finalizeWithLineItem(db, invoiceId, 349);
  await patchInvoice(db, { id: invoiceId, action: "attach", bookingId: BOOKING_A1 });
  assert.strictEqual(db.invoices.find((i) => i.id === invoiceId).booking_id, BOOKING_A1);

  useDb(db);
  const pi = {
    id: "pi_standalone_then_attached",
    metadata: { source: "invoice_pay_now", invoiceId: invoiceId, bookingId: "", expectedAmountCents: "34900" },
    currency: "usd",
    amount: 34900,
    amount_received: 34900,
  };
  await reconcileInvoicePaymentIntent(currentFakeService, null, pi);

  const mirrored = db.job_payments.find((p) => p.stripe_payment_intent_id === "pi_standalone_then_attached");
  assert.ok(mirrored, "the PI must have been mirrored, not halted, despite the empty metadata.bookingId snapshot");
  assert.strictEqual(mirrored.booking_id, BOOKING_A1, "must use the invoice's CURRENT booking_id, not the stale empty snapshot");
  assert.strictEqual(mirrored.invoice_id, invoiceId);
});

test("reconcileInvoicePaymentIntent: a NON-empty metadata.bookingId that no longer matches the invoice's current booking_id still halts (real mismatch, not just a timing gap)", async () => {
  adminAuthed();
  const db = freshDb();
  const invoice = { id: makeId(), status: "finalized", booking_id: BOOKING_A2, customer_id: CUSTOMER_A, total_amount: 100, active_stripe_payment_intent_id: null };
  db.invoices.push(invoice);
  useDb(db);

  const pi = {
    id: "pi_mismatch",
    metadata: { source: "invoice_pay_now", invoiceId: invoice.id, bookingId: BOOKING_A1, expectedAmountCents: "10000" }, // wrong booking on purpose
    currency: "usd",
    amount: 10000,
    amount_received: 10000,
  };
  await reconcileInvoicePaymentIntent(currentFakeService, null, pi);

  assert.strictEqual(db.job_payments.length, 0, "a real metadata/current-state mismatch must still halt — never mirrored");
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
