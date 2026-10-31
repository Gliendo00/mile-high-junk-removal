// CRM phase (2026-10-31) — Dump Fee Tonnage Tracking + Paid Invoice /
// Receipt. Covers:
//
//   Tonnage (api/_lib/dump-tonnage.js + api/admin/bookings.js expense
//   create/update + ?view=tonnage):
//     - a normal expense has no tonnage requirement (and never stores one)
//     - a Dump Fee saves with or without a weight; clearing -> NULL, never 0
//     - 5,000 lbs = 2.50 tons
//     - month / year / all-time totals, voided + unweighed rows excluded
//     - existing expense rows (no dump_weight_lbs key at all) stay valid
//
//   Invoices (api/admin/booking.js invoice-payment / send, api/book.js
//   invoice-public):
//     - Cash / Zelle / split Cash+Zelle / partial payments on the ledger
//     - full payment derives PAID (no manual toggle)
//     - a payment can be recorded on a DRAFT invoice that was never sent
//       (auto-finalized on the spot, due date defaulted)
//     - Send Paid Invoice / Receipt reuses the existing send flow + secure
//       /invoice/ link; the email is worded as a paid receipt
//     - the public paid page shows payment history, methods, dates, Total
//       Paid, Balance Due $0.00 — never payment notes
//     - an invoice that was already paid before this feature can send its
//       receipt
//     - existing Stripe/card behavior: card_stripe still can't be entered
//       manually, and a mirrored Stripe ledger row still counts toward PAID
//
// Same offline/mocked harness convention as every other test file here:
// "@supabase/supabase-js" is intercepted at require-time; Resend's HTTP
// call is a stubbed global fetch. No network, no real database.
//
// Run with:  node tests/crm-tonnage-paid-receipt.test.js

const Module = require("module");
const assert = require("assert");

let nextId = 1;
function makeId() {
  return "abababab-abab-abab-abab-" + String(700000000000 + nextId++).padStart(12, "0");
}
function nowIso() {
  return new Date().toISOString();
}
function denverToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}

// ---------------------------------------------------------------------
// Fake Supabase query builder — same shape/semantics as
// tests/phase3d-stage-b-invoice-centric.test.js's, plus the few extra
// operators the expense/tonnage paths use (gte/lte/not/limit/ilike/delete).
// ---------------------------------------------------------------------
class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._order = [];
    this._limit = null;
    this._single = null;
    this._insertData = undefined;
    this._updateData = undefined;
    this._delete = false;
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
  not(field, op, val) {
    if (op !== "is") throw new Error("fake .not() only supports 'is'");
    this._filters.push((row) => (row[field] === undefined ? null : row[field]) !== val);
    return this;
  }
  in(field, arr) {
    const set = new Set(arr);
    this._filters.push((row) => set.has(row[field]));
    return this;
  }
  gte(field, val) {
    this._filters.push((row) => row[field] >= val);
    return this;
  }
  lte(field, val) {
    this._filters.push((row) => row[field] <= val);
    return this;
  }
  ilike(field, pattern) {
    const needle = String(pattern).replace(/%/g, "").toLowerCase();
    this._filters.push((row) => String(row[field] || "").toLowerCase().indexOf(needle) !== -1);
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
  order(field, opts) {
    this._order.push({ field: field, ascending: !opts || opts.ascending !== false });
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  insert(data) {
    this._insertData = data;
    return this;
  }
  upsert(data, opts) {
    this._insertData = data;
    this._upsertOpts = opts || {};
    return this;
  }
  update(data) {
    this._updateData = data;
    return this;
  }
  delete() {
    this._delete = true;
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
        if (existing && this._upsertOpts.ignoreDuplicates) return { data: null, error: null };
      }
      if (this._table === "invoices" && this._insertData.booking_id) {
        const conflict = (this._db.invoices || []).some((r) => r.booking_id === this._insertData.booking_id && r.status !== "void");
        if (conflict) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      const NULLABLE_DEFAULTS = {
        invoices: {
          invoice_number: null,
          due_date: null,
          notes: null,
          finalized_at: null,
          voided_at: null,
          voided_reason: null,
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
        expenses: { voided_at: null, voided_reason: null, updated_by: null },
      };
      const row = Object.assign({ id: makeId(), created_at: nowIso(), updated_at: null, updated_by: null, sort_order: 0 }, NULLABLE_DEFAULTS[this._table] || {}, this._insertData);
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));

    if (this._delete) {
      this._db[this._table] = (this._db[this._table] || []).filter((r) => filtered.indexOf(r) === -1);
      return { data: null, error: null };
    }
    if (this._updateData !== undefined) {
      filtered.forEach((row) => Object.assign(row, this._updateData));
    }

    this._order
      .slice()
      .reverse()
      .forEach((o) => {
        filtered = filtered.slice().sort((a, b) => {
          if (a[o.field] < b[o.field]) return o.ascending ? -1 : 1;
          if (a[o.field] > b[o.field]) return o.ascending ? 1 : -1;
          return 0;
        });
      });
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

// Delivery-attempt RPCs — re-implemented to the observable contract
// handleSendInvoice() relies on (create a pending generation under the
// caller's send claim; accept it, superseding older generations, and
// release the claim). Proves the application drives the EXISTING send
// pipeline, not a parallel one.
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
      if (name === "create_invoice_delivery_attempt") {
        const invoice = db.invoices.find((i) => i.id === params.p_invoice_id);
        if (!invoice || invoice.send_claim_token !== params.p_send_claim_token) return { data: null, error: { message: "claim not owned" } };
        db.invoice_delivery_attempts = db.invoice_delivery_attempts || [];
        const generation = db.invoice_delivery_attempts.filter((a) => a.invoice_id === invoice.id).length + 1;
        const row = {
          id: params.p_attempt_id,
          invoice_id: invoice.id,
          generation: generation,
          status: "pending",
          access_token_hash: params.p_access_token_hash,
          access_token_ciphertext: params.p_access_token_ciphertext,
          recipient_email: params.p_recipient_email,
          balance_due_cents: params.p_balance_due_cents,
          started_at: nowIso(),
          accepted_at: null,
          resolved_at: null,
          provider_email_id: null,
        };
        db.invoice_delivery_attempts.push(row);
        return { data: [{ id: row.id, generation: generation }], error: null };
      }
      if (name === "accept_invoice_delivery_attempt") {
        const invoice = db.invoices.find((i) => i.id === params.p_invoice_id);
        const attempt = (db.invoice_delivery_attempts || []).find((a) => a.id === params.p_attempt_id);
        if (!invoice || !attempt || invoice.send_claim_token !== params.p_send_claim_token) return { data: null, error: { message: "cannot accept" } };
        db.invoice_delivery_attempts.forEach((a) => {
          if (a.invoice_id === invoice.id && a.id !== attempt.id && a.status === "accepted") {
            a.status = "superseded";
            a.resolved_at = nowIso();
          }
        });
        attempt.status = "accepted";
        attempt.accepted_at = nowIso();
        attempt.provider_email_id = params.p_provider_email_id;
        invoice.send_claim_token = null;
        invoice.send_claimed_at = null;
        return { data: null, error: null };
      }
      throw new Error("Unexpected rpc() call in test: " + name);
    },
  };
}
function createFakeAnonClient(overrides) {
  overrides = overrides || {};
  return { auth: { getUser: overrides.getUser || (async () => ({ data: null, error: { message: "not configured" } })) } };
}

let currentFakeAnon = null;
let currentFakeService = null;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@supabase/supabase-js") {
    return {
      createClient: function (_url, key) {
        if (key === process.env.SUPABASE_ANON_KEY) return currentFakeAnon;
        if (key === process.env.SUPABASE_SECRET_KEY) return currentFakeService;
        throw new Error("Unexpected Supabase key in test: " + key);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.ADMIN_ALLOWED_EMAILS = "owner@milehighjunkremoval.net";
process.env.RESEND_API_KEY = "re_test_mock";
process.env.INVOICE_LINK_SECRET = Buffer.alloc(32, 9).toString("base64");
// STRIPE_SECRET_KEY deliberately unset — getStripeClient() returns null;
// no fixture here has an active PaymentIntent, so Stripe is never needed.

const bookingHandler = require("../api/admin/booking.js");
const bookingsHandler = require("../api/admin/bookings.js");
const publicHandler = require("../api/book.js");
const tonnage = require("../api/_lib/dump-tonnage.js");
const { mirrorStripePaymentToLedger } = require("../api/_lib/job-payments-ledger.js");

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
    socket: { remoteAddress: "127.0.0." + ((nextId % 200) + 1) },
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
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(obj) {
      res.body = obj;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}
function run(handler, req) {
  const res = makeRes();
  return Promise.resolve(handler(req, res)).then(() => res);
}

currentFakeAnon = createFakeAnonClient({
  getUser: async (token) => (token === "at-good" ? { data: { user: { email: "owner@milehighjunkremoval.net" } }, error: null } : { data: null, error: { message: "no" } }),
});
const AUTH_COOKIE = "mhjr_admin_at=at-good";

const CUSTOMER = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
const BOOKING = "cccccccc-1111-1111-1111-cccccccccccc";

function freshDb() {
  return {
    customers: [{ id: CUSTOMER, first_name: "Pat", last_name: "Doe", email: "pat@example.com", phone: "3035550100", address: "1 Main St", city: "Denver", state: "CO", zip: "80202" }],
    bookings: [
      { id: BOOKING, customer_id: CUSTOMER, service_type: "junk_removal", appointment_date: "2026-10-30", service_address: "1 Main St", service_city: "Denver", service_state: "CO", service_zip: "80202" },
    ],
    invoices: [],
    invoice_line_items: [],
    job_payments: [],
    invoice_delivery_attempts: [],
    expenses: [],
  };
}
function useDb(db) {
  currentFakeService = createFakeServiceClient(db);
}

function adminCall(handler, db, method, query, body) {
  useDb(db);
  return run(handler, makeReq({ method: method, cookie: AUTH_COOKIE, query: query || {}, body: body }));
}
const createExpense = (db, body) => adminCall(bookingsHandler, db, "POST", {}, Object.assign({ resource: "expense" }, body));
const patchExpense = (db, body) => adminCall(bookingsHandler, db, "PATCH", {}, Object.assign({ resource: "expense" }, body));
const getTonnage = (db) => adminCall(bookingsHandler, db, "GET", { view: "tonnage" });
const createInvoice = (db, body) => adminCall(bookingHandler, db, "POST", { resource: "invoice" }, body);
const patchInvoice = (db, body) => adminCall(bookingHandler, db, "PATCH", { resource: "invoice" }, body);
const getInvoice = (db, id) => adminCall(bookingHandler, db, "GET", { resource: "invoice", id: id });
const postInvoicePayment = (db, body) => adminCall(bookingHandler, db, "POST", { resource: "invoice-payment" }, body);

// Draft invoice for BOOKING with one line item — never finalized, never sent.
async function draftInvoiceWithTotal(db, total) {
  const created = await createInvoice(db, { bookingId: BOOKING });
  assert.strictEqual(created.statusCode, 200, JSON.stringify(created.body));
  const id = created.body.invoice.id;
  const added = await patchInvoice(db, { id: id, action: "addLineItem", description: "Garage cleanout", quantity: 1, unitPrice: total });
  assert.strictEqual(added.statusCode, 200, JSON.stringify(added.body));
  return id;
}
async function finalizedInvoiceWithTotal(db, total) {
  const id = await draftInvoiceWithTotal(db, total);
  db.invoices.find((i) => i.id === id).due_date = "2099-01-01";
  const fin = await patchInvoice(db, { id: id, action: "finalize" });
  assert.strictEqual(fin.statusCode, 200, JSON.stringify(fin.body));
  return id;
}

// Stub Resend: records every email payload; returns a provider id.
const sentEmails = [];
global.fetch = async function (url, init) {
  if (String(url).indexOf("https://api.resend.com/emails") === 0) {
    const payload = JSON.parse(init.body);
    sentEmails.push({ headers: init.headers, payload: payload });
    return { ok: true, status: 200, json: async () => ({ id: "email_" + sentEmails.length }), text: async () => "" };
  }
  throw new Error("Unexpected fetch in test: " + url);
};
function tokenFromLastEmail() {
  const html = sentEmails[sentEmails.length - 1].payload.html;
  const m = /invoice\/#token=([A-Za-z0-9_\-]+)/.exec(html);
  assert.ok(m, "email should contain the secure /invoice/#token= link");
  return m[1];
}
function viewPublic(db, token) {
  useDb(db);
  return run(publicHandler, makeReq({ method: "POST", query: { resource: "invoice-public" }, body: { token: token } }));
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// =====================================================================
// Tonnage — pure helpers
// =====================================================================
test("5,000 lbs calculates to 2.50 tons", () => {
  assert.strictEqual(tonnage.lbsToTons(5000), 2.5);
  assert.strictEqual(tonnage.roundTons(tonnage.lbsToTons(5000)).toFixed(2), "2.50");
  assert.strictEqual(tonnage.roundTons(tonnage.lbsToTons(5240)), 2.62);
});

test("parseDumpWeightLbs: blank/null -> null (never 0), commas + decimals accepted, junk/negative/zero rejected", () => {
  assert.deepStrictEqual(tonnage.parseDumpWeightLbs(undefined), { value: null });
  assert.deepStrictEqual(tonnage.parseDumpWeightLbs(null), { value: null });
  assert.deepStrictEqual(tonnage.parseDumpWeightLbs(""), { value: null });
  assert.deepStrictEqual(tonnage.parseDumpWeightLbs("   "), { value: null });
  assert.deepStrictEqual(tonnage.parseDumpWeightLbs("5,000"), { value: 5000 });
  assert.deepStrictEqual(tonnage.parseDumpWeightLbs(4321.456), { value: 4321.46 });
  assert.deepStrictEqual(tonnage.parseDumpWeightLbs("1250.5"), { value: 1250.5 });
  ["0", 0, -5, "-5", "abc", "12lbs", 200001, {}].forEach((bad) => {
    assert.ok(tonnage.parseDumpWeightLbs(bad).error, "should reject " + JSON.stringify(bad));
  });
});

test("summarizeTonnage: month/year/all-time correct; voided, unweighed, and non-dump rows excluded", () => {
  const rows = [
    { expense_date: "2026-10-03", category: "dump_fees", dump_weight_lbs: 5000, voided_at: null }, // month+year
    { expense_date: "2026-10-20", category: "dump_fees", dump_weight_lbs: "3420.00", voided_at: null }, // month+year (numeric string, as PostgREST returns)
    { expense_date: "2026-03-15", category: "dump_fees", dump_weight_lbs: 10000, voided_at: null }, // year only
    { expense_date: "2025-12-30", category: "dump_fees", dump_weight_lbs: 4000, voided_at: null }, // all-time only
    { expense_date: "2026-10-05", category: "dump_fees", dump_weight_lbs: 99999, voided_at: "2026-10-06T00:00:00Z" }, // voided
    { expense_date: "2026-10-07", category: "dump_fees", dump_weight_lbs: null, voided_at: null }, // unweighed
    { expense_date: "2026-10-08", category: "fuel", dump_weight_lbs: 7777, voided_at: null }, // not a dump fee
    { expense_date: "2026-10-09", category: "dump_fees", voided_at: null }, // pre-feature row: key absent entirely
  ];
  const s = tonnage.summarizeTonnage(rows, "2026-10-31");
  assert.strictEqual(s.thisMonthTons, 4.21); // 8420 / 2000
  assert.strictEqual(s.thisYearTons, 9.21); // 18420 / 2000
  assert.strictEqual(s.allTimeTons, 11.21); // 22420 / 2000
  assert.strictEqual(s.weighedCount, 4);
  assert.deepStrictEqual(tonnage.summarizeTonnage([], "2026-10-31"), {
    thisMonthTons: 0,
    thisYearTons: 0,
    allTimeTons: 0,
    thisMonthLbs: 0,
    thisYearLbs: 0,
    allTimeLbs: 0,
    weighedCount: 0,
  });
});

// =====================================================================
// Tonnage — expense API
// =====================================================================
test("normal (non-dump) expense has no tonnage requirement and never stores a weight", async () => {
  const db = freshDb();
  const plain = await createExpense(db, { expenseDate: denverToday(), category: "fuel", amount: 61.25 });
  assert.strictEqual(plain.statusCode, 200, JSON.stringify(plain.body));
  assert.strictEqual(plain.body.expense.dumpWeightLbs, null);
  assert.strictEqual(plain.body.expense.amount, 61.25);
  // A stale client sending a weight on a non-dump category: ignored, not stored.
  const stale = await createExpense(db, { expenseDate: denverToday(), category: "meals", amount: 14, dumpWeightLbs: 5000 });
  assert.strictEqual(stale.statusCode, 200);
  assert.strictEqual(db.expenses.find((e) => e.id === stale.body.expense.id).dump_weight_lbs, null);
});

test("Dump Fee saves without a weight (NULL)", async () => {
  const db = freshDb();
  const r = await createExpense(db, { expenseDate: denverToday(), category: "dump_fees", amount: 68 });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(db.expenses[0].dump_weight_lbs, null);
  assert.strictEqual(r.body.expense.dumpWeightTons, null);
});

test("Dump Fee saves a weight; dollar amount unaffected; tons derived (5000 lbs -> 2.50)", async () => {
  const db = freshDb();
  const r = await createExpense(db, { expenseDate: denverToday(), category: "dump_fees", amount: 68, dumpWeightLbs: "5,000" });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(db.expenses[0].dump_weight_lbs, 5000);
  assert.strictEqual(db.expenses[0].amount, 68);
  assert.strictEqual(r.body.expense.dumpWeightLbs, 5000);
  assert.strictEqual(r.body.expense.dumpWeightTons, 2.5);
});

test("Dump Fee with an invalid weight is rejected (400) and nothing is written", async () => {
  const db = freshDb();
  const r = await createExpense(db, { expenseDate: denverToday(), category: "dump_fees", amount: 68, dumpWeightLbs: "-40" });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(db.expenses.length, 0);
});

test("editing: weight can be added, corrected, and cleared to NULL (not 0); omitting it leaves it alone", async () => {
  const db = freshDb();
  const created = await createExpense(db, { expenseDate: denverToday(), category: "dump_fees", amount: 70 });
  const id = created.body.expense.id;
  let r = await patchExpense(db, { id: id, dumpWeightLbs: 4800 });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(db.expenses[0].dump_weight_lbs, 4800);
  r = await patchExpense(db, { id: id, dumpWeightLbs: "5240" });
  assert.strictEqual(db.expenses[0].dump_weight_lbs, 5240);
  r = await patchExpense(db, { id: id, amount: 72 }); // weight not sent
  assert.strictEqual(db.expenses[0].dump_weight_lbs, 5240);
  assert.strictEqual(db.expenses[0].amount, 72);
  r = await patchExpense(db, { id: id, dumpWeightLbs: "" });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(db.expenses[0].dump_weight_lbs, null);
  assert.notStrictEqual(db.expenses[0].dump_weight_lbs, 0);
});

test("editing: changing category away from Dump Fee clears its weight", async () => {
  const db = freshDb();
  const created = await createExpense(db, { expenseDate: denverToday(), category: "dump_fees", amount: 70, dumpWeightLbs: 3000 });
  const r = await patchExpense(db, { id: created.body.expense.id, category: "disposal_recycling" });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(db.expenses[0].dump_weight_lbs, null);
});

test("existing (pre-feature) expense rows with no dump_weight_lbs key still list, edit, and void normally", async () => {
  const db = freshDb();
  const today = denverToday();
  db.expenses.push({ id: makeId(), expense_date: today, category: "dump_fees", amount: 55, note: null, vendor: null, payment_method: null, booking_id: null, receipt_reference: null, voided_at: null, voided_reason: null, created_at: nowIso(), updated_at: null });
  const listed = await adminCall(bookingsHandler, db, "GET", { view: "expenses", startDate: today, endDate: today });
  assert.strictEqual(listed.statusCode, 200, JSON.stringify(listed.body));
  assert.strictEqual(listed.body.expenses[0].dumpWeightLbs, null);
  assert.strictEqual(listed.body.totalAmount, 55);
  const edited = await patchExpense(db, { id: db.expenses[0].id, note: "Landfill" });
  assert.strictEqual(edited.statusCode, 200);
  assert.strictEqual(db.expenses[0].dump_weight_lbs, undefined, "an edit that doesn't send a weight never writes the column");
  const voided = await patchExpense(db, { id: db.expenses[0].id, action: "void", reason: "duplicate" });
  assert.strictEqual(voided.statusCode, 200);
});

test("?view=tonnage: totals + history; voided expenses and unweighed dump fees don't count; expense totals untouched", async () => {
  const db = freshDb();
  const today = denverToday();
  const year = today.slice(0, 4);
  const month = today.slice(0, 7);
  const lastYear = String(Number(year) - 1) + "-06-15";
  // A day this year but definitely not this month (Jan 1, unless today IS January).
  const otherMonthThisYear = month === year + "-01" ? null : year + "-01-02";
  const base = { amount: 70, note: null, vendor: null, payment_method: null, receipt_reference: null, voided_reason: null, created_at: nowIso(), updated_at: null };
  db.expenses.push(Object.assign({ id: makeId(), expense_date: today, category: "dump_fees", dump_weight_lbs: 5000, booking_id: BOOKING, voided_at: null }, base));
  db.expenses.push(Object.assign({ id: makeId(), expense_date: today, category: "dump_fees", dump_weight_lbs: 99999, booking_id: null, voided_at: nowIso() }, base));
  db.expenses.push(Object.assign({ id: makeId(), expense_date: today, category: "dump_fees", dump_weight_lbs: null, booking_id: null, voided_at: null }, base));
  db.expenses.push(Object.assign({ id: makeId(), expense_date: lastYear, category: "dump_fees", dump_weight_lbs: 4000, booking_id: null, voided_at: null }, base));
  if (otherMonthThisYear) db.expenses.push(Object.assign({ id: makeId(), expense_date: otherMonthThisYear, category: "dump_fees", dump_weight_lbs: 2000, booking_id: null, voided_at: null }, base));

  const r = await getTonnage(db);
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.thisMonthTons, 2.5);
  assert.strictEqual(r.body.thisYearTons, otherMonthThisYear ? 3.5 : 2.5);
  assert.strictEqual(r.body.allTimeTons, otherMonthThisYear ? 5.5 : 4.5);
  // History: weighed, non-voided only, newest first, with the linked job's label.
  assert.strictEqual(r.body.history.length, otherMonthThisYear ? 3 : 2);
  assert.strictEqual(r.body.history[0].dumpWeightLbs, 5000);
  assert.strictEqual(r.body.history[0].dumpWeightTons, 2.5);
  assert.strictEqual(r.body.history[0].amount, 70);
  assert.ok(r.body.history[0].job && /Pat Doe/.test(r.body.history[0].job.label), "linked job/client shown");
  assert.ok(r.body.history.every((h) => h.dumpWeightLbs !== 99999), "voided row never appears");

  // The ordinary expenses view (what Business Pulse/Net use) is unchanged:
  // still sums every non-voided expense's dollars, weighed or not.
  const listed = await adminCall(bookingsHandler, db, "GET", { view: "expenses", startDate: today, endDate: today });
  assert.strictEqual(listed.body.totalAmount, 140);
});

// =====================================================================
// Invoices — manual payments on the existing job_payments ledger
// =====================================================================
test("Cash payment records correctly against an invoice", async () => {
  const db = freshDb();
  const id = await finalizedInvoiceWithTotal(db, 550);
  const r = await postInvoicePayment(db, { invoiceId: id, amount: 550, paymentMethod: "cash" });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(db.job_payments.length, 1);
  assert.strictEqual(db.job_payments[0].payment_method, "cash");
  assert.strictEqual(db.job_payments[0].invoice_id, id);
  assert.strictEqual(db.job_payments[0].booking_id, BOOKING);
  assert.strictEqual(db.job_payments[0].payment_date, denverToday());
});

test("Zelle payment records correctly, with a reference note", async () => {
  const db = freshDb();
  const id = await finalizedInvoiceWithTotal(db, 300);
  const r = await postInvoicePayment(db, { invoiceId: id, amount: 300, paymentMethod: "zelle", notes: "Zelle conf #A1B2" });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(db.job_payments[0].payment_method, "zelle");
  assert.strictEqual(db.job_payments[0].notes, "Zelle conf #A1B2");
});

test("partial payment leaves the remaining balance and stays partially paid", async () => {
  const db = freshDb();
  const id = await finalizedInvoiceWithTotal(db, 550);
  await postInvoicePayment(db, { invoiceId: id, amount: 200, paymentMethod: "cash" });
  const g = await getInvoice(db, id);
  assert.strictEqual(g.body.invoice.displayStatus, "partially_paid");
  assert.strictEqual(g.body.invoice.balanceDue, 350);
  assert.strictEqual(g.body.invoice.netCollected, 200);
});

test("split Cash $300 + Zelle $250 on a $550 invoice -> PAID, balance $0, both rows in the ledger", async () => {
  const db = freshDb();
  const id = await finalizedInvoiceWithTotal(db, 550);
  await postInvoicePayment(db, { invoiceId: id, amount: 300, paymentMethod: "cash" });
  let g = await getInvoice(db, id);
  assert.strictEqual(g.body.invoice.displayStatus, "partially_paid");
  await postInvoicePayment(db, { invoiceId: id, amount: 250, paymentMethod: "zelle" });
  g = await getInvoice(db, id);
  assert.strictEqual(g.body.invoice.displayStatus, "paid");
  assert.strictEqual(g.body.invoice.balanceDue, 0);
  assert.strictEqual(g.body.invoice.netCollected, 550);
  assert.strictEqual(g.body.jobPayments.length, 2);
  // PAID is derived from the ledger — the stored status is still just "finalized".
  assert.strictEqual(db.invoices.find((i) => i.id === id).status, "finalized");
});

test("full payment marks invoice PAID; voiding a payment re-opens the balance (no paid flag to drift)", async () => {
  const db = freshDb();
  const id = await finalizedInvoiceWithTotal(db, 400);
  const p = await postInvoicePayment(db, { invoiceId: id, amount: 400, paymentMethod: "check" });
  let g = await getInvoice(db, id);
  assert.strictEqual(g.body.invoice.displayStatus, "paid");
  const v = await adminCall(bookingHandler, db, "PATCH", { resource: "job-payments" }, { id: p.body.jobPayment.id, reason: "bounced" });
  assert.strictEqual(v.statusCode, 200, JSON.stringify(v.body));
  g = await getInvoice(db, id);
  assert.strictEqual(g.body.invoice.displayStatus, "finalized");
  assert.strictEqual(g.body.invoice.balanceDue, 400);
});

test("payment can be recorded on a DRAFT invoice that was never sent: auto-finalized, due date defaulted, then PAID", async () => {
  const db = freshDb();
  const id = await draftInvoiceWithTotal(db, 550);
  assert.strictEqual(db.invoices[0].status, "draft");
  assert.strictEqual(db.invoices[0].due_date, null);
  const r = await postInvoicePayment(db, { invoiceId: id, amount: 300, paymentMethod: "cash" });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.autoFinalized, true);
  assert.ok(/^INV-2026-\d+$/.test(r.body.invoiceNumber));
  const inv = db.invoices.find((i) => i.id === id);
  assert.strictEqual(inv.status, "finalized");
  assert.strictEqual(inv.due_date, denverToday());
  assert.strictEqual(db.invoice_delivery_attempts.length, 0, "nothing was sent");
  // Second (split) payment on the now-finalized invoice — not re-finalized.
  const r2 = await postInvoicePayment(db, { invoiceId: id, amount: 250, paymentMethod: "zelle" });
  assert.strictEqual(r2.statusCode, 200);
  assert.strictEqual(r2.body.autoFinalized, undefined);
  const g = await getInvoice(db, id);
  assert.strictEqual(g.body.invoice.displayStatus, "paid");
  assert.strictEqual(g.body.invoice.balanceDue, 0);
});

test("draft auto-finalize keeps an explicitly set due date, and still refuses an empty draft", async () => {
  const db = freshDb();
  const id = await draftInvoiceWithTotal(db, 100);
  db.invoices[0].due_date = "2026-12-15";
  await postInvoicePayment(db, { invoiceId: id, amount: 100, paymentMethod: "cash" });
  assert.strictEqual(db.invoices[0].due_date, "2026-12-15");

  const db2 = freshDb();
  const empty = await createInvoice(db2, { bookingId: BOOKING });
  const r = await postInvoicePayment(db2, { invoiceId: empty.body.invoice.id, amount: 50, paymentMethod: "cash" });
  assert.strictEqual(r.statusCode, 400);
  assert.ok(/line item before recording a payment/.test(r.body.error), r.body.error);
  assert.strictEqual(db2.invoices[0].status, "draft");
  assert.strictEqual(db2.job_payments.length, 0);
});

test("a refund can't be recorded against a draft; a void invoice still can't take a payment", async () => {
  const db = freshDb();
  const id = await draftInvoiceWithTotal(db, 100);
  const r = await postInvoicePayment(db, { invoiceId: id, amount: 10, paymentMethod: "cash", paymentType: "refund", reversesPaymentId: makeId(), confirmedExternalReturn: true });
  assert.ok(r.statusCode === 400 || r.statusCode === 409, String(r.statusCode));
  assert.strictEqual(db.invoices[0].status, "draft");
  db.invoices[0].status = "void";
  const r2 = await postInvoicePayment(db, { invoiceId: id, amount: 10, paymentMethod: "cash" });
  assert.strictEqual(r2.statusCode, 409);
  assert.strictEqual(db.job_payments.length, 0);
});

test("explicit Finalize button still requires a due date (unchanged)", async () => {
  const db = freshDb();
  const id = await draftInvoiceWithTotal(db, 100);
  const r = await patchInvoice(db, { id: id, action: "finalize" });
  assert.strictEqual(r.statusCode, 400);
  assert.ok(/due date before finalizing/.test(r.body.error));
});

// =====================================================================
// Paid Invoice / Receipt — send + public page
// =====================================================================
test("Send Paid Invoice / Receipt uses the existing send flow + secure /invoice/ link; email worded as a paid receipt", async () => {
  const db = freshDb();
  const id = await draftInvoiceWithTotal(db, 550);
  await postInvoicePayment(db, { invoiceId: id, amount: 300, paymentMethod: "cash" });
  await postInvoicePayment(db, { invoiceId: id, amount: 250, paymentMethod: "zelle" });
  const before = sentEmails.length;
  const s = await patchInvoice(db, { id: id, action: "send" });
  assert.strictEqual(s.statusCode, 200, JSON.stringify(s.body));
  assert.strictEqual(s.body.sentTo, "pat@example.com");
  assert.strictEqual(sentEmails.length, before + 1);
  const email = sentEmails[sentEmails.length - 1];
  assert.ok(/^Paid Invoice \/ Receipt INV-2026-\d+ from Mile High Junk Removal$/.test(email.payload.subject), email.payload.subject);
  assert.ok(email.payload.html.indexOf("PAID") !== -1);
  assert.ok(email.payload.html.indexOf("Balance Due: $0.00") !== -1);
  assert.ok(email.payload.html.indexOf("View Paid Invoice / Receipt") !== -1);
  assert.ok(email.payload.html.indexOf("Pay Invoice") === -1, "no 'Pay' CTA on a paid receipt");
  assert.ok(String(email.headers["Idempotency-Key"]).indexOf("invoice-send:" + id + ":") === 0, "same idempotent send pipeline");
  // Exactly one delivery attempt, snapshotting a $0 balance.
  assert.strictEqual(db.invoice_delivery_attempts.length, 1);
  assert.strictEqual(db.invoice_delivery_attempts[0].balance_due_cents, 0);
  assert.strictEqual(db.invoice_delivery_attempts[0].status, "accepted");
});

test("unpaid invoice send is unchanged (Invoice subject, Balance Due + Pay CTA)", async () => {
  const db = freshDb();
  const id = await finalizedInvoiceWithTotal(db, 200);
  const s = await patchInvoice(db, { id: id, action: "send" });
  assert.strictEqual(s.statusCode, 200, JSON.stringify(s.body));
  const email = sentEmails[sentEmails.length - 1];
  assert.ok(/^Invoice INV-2026-\d+ from Mile High Junk Removal$/.test(email.payload.subject), email.payload.subject);
  assert.ok(email.payload.html.indexOf("View &amp; Pay Invoice") !== -1);
  assert.ok(email.payload.html.indexOf("$200.00") !== -1);
});

test("public paid page: payment history (methods + dates), Total Paid, Balance Due $0.00, PAID status, job details — never notes", async () => {
  const db = freshDb();
  const id = await draftInvoiceWithTotal(db, 550);
  await postInvoicePayment(db, { invoiceId: id, amount: 300, paymentMethod: "cash", notes: "INTERNAL-NOTE-DO-NOT-LEAK" });
  await postInvoicePayment(db, { invoiceId: id, amount: 250, paymentMethod: "zelle" });
  await patchInvoice(db, { id: id, action: "send" });
  const r = await viewPublic(db, tokenFromLastEmail());
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.strictEqual(b.displayStatus, "paid");
  assert.strictEqual(b.balanceDue, 0);
  assert.strictEqual(b.amountPaid, 550);
  assert.strictEqual(b.totalAmount, 550);
  assert.ok(/^INV-2026-\d+$/.test(b.invoiceNumber));
  assert.strictEqual(b.billTo.name, "Pat Doe");
  assert.strictEqual(b.lineItems[0].description, "Garage cleanout");
  assert.deepStrictEqual(
    b.payments.map((p) => [p.method, p.amount, p.type]),
    [
      ["Cash", 300, "payment"],
      ["Zelle", 250, "payment"],
    ]
  );
  b.payments.forEach((p) => assert.strictEqual(p.date, denverToday()));
  assert.strictEqual(b.service.label, "Junk Removal");
  assert.strictEqual(b.service.date, "2026-10-30");
  assert.ok(JSON.stringify(b).indexOf("INTERNAL-NOTE-DO-NOT-LEAK") === -1, "payment notes never reach the customer page");
  assert.ok(JSON.stringify(b).indexOf("recorded_by") === -1 && JSON.stringify(b).indexOf("owner@") === -1);
});

test("an invoice already paid BEFORE this feature shipped can send its paid receipt", async () => {
  const db = freshDb();
  // Seed exactly the shape existing production rows have: finalized
  // invoice + manual ledger rows written by the old code path.
  const invId = makeId();
  db.invoices.push({
    id: invId, booking_id: BOOKING, customer_id: CUSTOMER, status: "finalized", invoice_number: "INV-2026-0042", total_amount: 349, due_date: "2026-10-15",
    finalized_at: "2026-10-10T15:00:00Z", notes: null, voided_at: null, voided_reason: null, created_at: "2026-10-10T14:00:00Z", created_by: "owner@milehighjunkremoval.net",
    updated_at: null, updated_by: null, send_claim_token: null, send_claimed_at: null, active_stripe_payment_intent_id: null, payment_claim_token: null, payment_claimed_at: null,
    payment_generation: 0, invoice_kind: "original",
  });
  db.invoice_line_items.push({ id: makeId(), invoice_id: invId, sort_order: 0, description: "Junk removal — half load", quantity: 1, unit_price: 349, amount: 349, created_at: "2026-10-10T14:00:00Z", updated_at: null });
  db.job_payments.push({ id: makeId(), invoice_id: invId, booking_id: BOOKING, amount: 349, payment_method: "cash", payment_type: "payment", payment_date: "2026-10-12", notes: null, voided_at: null, voided_reason: null, stripe_payment_intent_id: null, reverses_payment_id: null, recorded_by: "owner@milehighjunkremoval.net", created_at: "2026-10-12T20:00:00Z" });

  const g = await getInvoice(db, invId);
  assert.strictEqual(g.body.invoice.displayStatus, "paid");
  const s = await patchInvoice(db, { id: invId, action: "send" });
  assert.strictEqual(s.statusCode, 200, JSON.stringify(s.body));
  assert.ok(/^Paid Invoice \/ Receipt INV-2026-0042/.test(sentEmails[sentEmails.length - 1].payload.subject));
  const pub = await viewPublic(db, tokenFromLastEmail());
  assert.strictEqual(pub.body.displayStatus, "paid");
  assert.deepStrictEqual(pub.body.payments, [{ date: "2026-10-12", method: "Cash", type: "payment", amount: 349 }]);
});

test("existing Stripe/card behavior: card_stripe still can't be entered manually; a mirrored Stripe row still counts toward PAID and reads 'Card' on the receipt", async () => {
  const db = freshDb();
  const id = await finalizedInvoiceWithTotal(db, 120);
  const manual = await postInvoicePayment(db, { invoiceId: id, amount: 120, paymentMethod: "card_stripe" });
  assert.strictEqual(manual.statusCode, 400);
  assert.strictEqual(db.job_payments.length, 0);

  // A Stripe-collected payment lands via the existing ledger mirror, never the manual path.
  useDb(db);
  await mirrorStripePaymentToLedger(currentFakeService, { bookingId: BOOKING, invoiceId: id, stripePaymentIntentId: "pi_test_123", amount: 120, paymentDate: denverToday() });
  const row = db.job_payments.find((p) => p.stripe_payment_intent_id === "pi_test_123");
  assert.ok(row, "mirrored Stripe row written: " + JSON.stringify(db.job_payments));
  assert.strictEqual(row.payment_method, "card_stripe");
  const g = await getInvoice(db, id);
  assert.strictEqual(g.body.invoice.displayStatus, "paid");
  await patchInvoice(db, { id: id, action: "send" });
  const pub = await viewPublic(db, tokenFromLastEmail());
  assert.strictEqual(pub.body.payments[0].method, "Card");
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log("  ok   " + t.name);
    } catch (err) {
      failed++;
      console.log("  FAIL " + t.name);
      console.log("       " + (err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n       ") : err));
    }
  }
  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed) process.exitCode = 1;
})();
