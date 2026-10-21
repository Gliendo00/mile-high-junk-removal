// Local, offline test harness for Phase 2 (Core Invoicing). Covers:
//   - api/admin/booking.js's ?resource=invoice (GET detail / POST create /
//     PATCH addLineItem|updateLineItem|removeLineItem|finalize|void).
//   - api/admin/bookings.js's ?view=invoices list.
//   - api/_lib/invoice-helpers.js's deriveInvoiceStatus() — exercised
//     indirectly through both endpoints above, confirming they can never
//     disagree about an invoice's derived status.
//
// Per Rocky's explicit instruction for this phase ("Do not assume a
// separate non-production Supabase project exists. Use offline/mocked
// verification first."), this file is the whole of this phase's
// verification before sql/2026-10-19_invoice-workflow.sql is ever run
// anywhere. Same approach as every prior phase's test file:
// "@supabase/supabase-js" is intercepted at require-time and replaced with
// an in-memory fake — never the real network, never production Supabase.
//
// Run with:  node tests/phase2-invoice-workflow.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

// ---------------------------------------------------------------------
// Fake Supabase query builder — union of estimate-workflow.test.js's
// (insert/update -> filtered rows survive into single()/maybeSingle(),
// matching real Postgres UPDATE...WHERE semantics) and
// phase3c-batch5-intake-endpoint.test.js's (delete(), count+head selects),
// plus .neq() (used by the finalize/void conditional updates) and a
// minimal simulation of invoices_booking_id_active_uniq (the one
// constraint this phase's handlers actually depend on for idempotent
// create) — see its insert-time check below.
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "dddddddd-dddd-dddd-dddd-" + String(400000000000 + nextId++).padStart(12, "0");
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
  // Phase 3 — minimal PostgREST-style .or() support: comma-separated
  // "field.op.value" clauses, OR'd together as ONE filter (so it combines
  // with every other .eq()/.is()/.in() call via the existing AND-of-
  // filters semantics below). Only the two operators the Phase 3 claim-
  // acquisition queries actually use are implemented.
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
      if (this._db.__insertError && this._db.__insertError[this._table]) {
        return { data: null, error: this._db.__insertError[this._table] };
      }
      // Simulates invoices_booking_id_active_uniq (sql/2026-10-19_invoice-
      // workflow.sql §1) — the one real-DB constraint handleCreateInvoice()
      // depends on for its idempotent-create path (insert; on
      // unique_violation, re-fetch and return the existing row).
      if (this._table === "invoices" && this._insertData.booking_id) {
        const conflict = (this._db.invoices || []).some((r) => r.booking_id === this._insertData.booking_id && r.status !== "void");
        if (conflict) {
          return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "invoices_booking_id_active_uniq"' } };
        }
      }
      // Real Postgres returns NULL for every nullable column the INSERT
      // didn't set, once re-selected via the handlers' own SELECT column
      // list — mirrored here so e.g. a freshly-created invoice's
      // invoice_number/finalized_at/voided_at come back null, not
      // undefined (the handlers' own callers, and these assertions,
      // distinguish the two).
      const NULLABLE_DEFAULTS = {
        invoices: { invoice_number: null, due_date: null, notes: null, finalized_at: null, voided_at: null, voided_reason: null, updated_at: null, updated_by: null },
        invoice_line_items: { updated_at: null },
        job_payments: { stripe_payment_intent_id: null, reverses_payment_id: null, voided_at: null, voided_reason: null, notes: null },
      };
      const row = Object.assign(
        { id: makeId(), created_at: "2026-10-19T12:00:00Z", updated_at: null, updated_by: null, sort_order: 0 },
        NULLABLE_DEFAULTS[this._table] || {},
        this._insertData
      );
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));

    if (this._deleteFlag) {
      if (this._db.__deleteError && this._db.__deleteError[this._table]) {
        return { data: null, error: this._db.__deleteError[this._table] };
      }
      const toDeleteIds = new Set(filtered.map((r) => r.id));
      this._db[this._table] = (this._db[this._table] || []).filter((r) => !toDeleteIds.has(r.id));
      return { data: null, error: null };
    }

    if (this._updateData !== undefined) {
      if (this._db.__updateError && this._db.__updateError[this._table]) {
        return { data: null, error: this._db.__updateError[this._table] };
      }
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
    // Fakes public.next_invoice_number() (sql/2026-10-19_invoice-
    // workflow.sql §4) — a plain incrementing counter starting at 1001,
    // same "gaps are acceptable, never gapless" posture as the real
    // sequence (see that migration's own header).
    async rpc(name) {
      if (name !== "next_invoice_number") throw new Error("Unexpected rpc() call in test: " + name);
      if (db.__rpcError && db.__rpcError.next_invoice_number) return { data: null, error: db.__rpcError.next_invoice_number };
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
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

const CUSTOMER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RENTAL_BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const JUNK_BOOKING_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PICKUP_BOOKING_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function freshDb() {
  return {
    customers: [{ id: CUSTOMER_ID, first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: "jamie@example.com", city: "Denver" }],
    bookings: [
      { id: RENTAL_BOOKING_ID, customer_id: CUSTOMER_ID, service_type: "dumpster_rental", appointment_date: "2026-11-01" },
      { id: JUNK_BOOKING_ID, customer_id: CUSTOMER_ID, service_type: "junk_removal", appointment_date: "2026-11-02" },
      { id: PICKUP_BOOKING_ID, customer_id: CUSTOMER_ID, service_type: "dumpster_pickup", appointment_date: "2026-11-06" },
    ],
    invoices: [],
    invoice_line_items: [],
    job_payments: [],
  };
}

function createInvoice(db, cookie, bookingId) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, query: { resource: "invoice" }, body: { bookingId: bookingId } }));
}
function patchInvoice(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "PATCH", cookie: cookie, query: { resource: "invoice" }, body: body }));
}
function getInvoice(db, cookie, id) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "GET", cookie: cookie, query: { resource: "invoice", id: id } }));
}
function getInvoiceByBooking(db, cookie, bookingId) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "GET", cookie: cookie, query: { resource: "invoice", bookingId: bookingId } }));
}
function postJobPayment(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, query: { resource: "job-payments" }, body: body }));
}
// Phase 3D Stage B — the invoice-specific manual payment path. Unlike
// postJobPayment() above (generic, booking-keyed, never touches any
// invoice's balance as of Stage B), this is what actually pays an
// invoice down.
function postInvoicePayment(db, cookie, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingHandler, makeReq({ method: "POST", cookie: cookie, query: { resource: "invoice-payment" }, body: body }));
}
function getInvoicesView(db, cookie, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ method: "GET", cookie: cookie, query: Object.assign({ view: "invoices" }, query || {}) }));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Create
// =======================================================================

test("Create: POST ?resource=invoice creates a $0 draft with no invoice number, customer_id taken from the booking", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.invoice.status, "draft");
  assert.strictEqual(res.body.invoice.totalAmount, 0);
  assert.strictEqual(res.body.invoice.invoiceNumber, null);
  assert.strictEqual(res.body.invoice.customerId, CUSTOMER_ID);
  assert.deepStrictEqual(res.body.lineItems, []);
  assert.strictEqual(db.invoices.length, 1);
});

test("Create: a dumpster_pickup booking can never receive an invoice", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await createInvoice(db, AUTH_COOKIE, PICKUP_BOOKING_ID);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.invoices.length, 0);
});

test("Create: idempotent — a second create for the same booking returns the SAME invoice, never a duplicate", async () => {
  adminAuthed();
  const db = freshDb();
  const first = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  const second = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  assert.strictEqual(second.statusCode, 200);
  assert.strictEqual(second.body.invoice.id, first.body.invoice.id);
  assert.strictEqual(db.invoices.length, 1);
});

test("Create: after the active invoice is voided, a new invoice CAN be created for the same booking", async () => {
  adminAuthed();
  const db = freshDb();
  const first = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  await patchInvoice(db, AUTH_COOKIE, { id: first.body.invoice.id, action: "void", reason: "test cleanup" });
  const second = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  assert.strictEqual(second.statusCode, 200);
  assert.notStrictEqual(second.body.invoice.id, first.body.invoice.id);
  assert.strictEqual(db.invoices.length, 2);
});

// =======================================================================
// updateDetails (draft only — due date / notes)
// =======================================================================

test("updateDetails: sets due date and notes on a draft invoice", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  const res = await patchInvoice(db, AUTH_COOKIE, { id: created.body.invoice.id, action: "updateDetails", dueDate: "2026-12-15", notes: "Net 15" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.invoice.dueDate, "2026-12-15");
  assert.strictEqual(res.body.invoice.notes, "Net 15");
});

test("updateDetails: an empty dueDate clears it back to null", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  await patchInvoice(db, AUTH_COOKIE, { id: created.body.invoice.id, action: "updateDetails", dueDate: "2026-12-15" });
  const res = await patchInvoice(db, AUTH_COOKIE, { id: created.body.invoice.id, action: "updateDetails", dueDate: "" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.invoice.dueDate, null);
});

test("updateDetails: rejects a malformed due date", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  const res = await patchInvoice(db, AUTH_COOKIE, { id: created.body.invoice.id, action: "updateDetails", dueDate: "not-a-date" });
  assert.strictEqual(res.statusCode, 400);
});

test("updateDetails: rejected once the invoice is finalized", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceId).due_date = "2026-12-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });

  const res = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "updateDetails", notes: "sneaky edit" });
  assert.strictEqual(res.statusCode, 409);
});

// =======================================================================
// Line items (draft only)
// =======================================================================

test("Line items: add two, total is the sum; remove one, total recomputes", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  const invoiceId = created.body.invoice.id;

  const add1 = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "addLineItem", description: "Dumpster rental", quantity: 1, unitPrice: 349 });
  assert.strictEqual(add1.statusCode, 200);
  assert.strictEqual(add1.body.invoice.totalAmount, 349);

  const add2 = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "addLineItem", description: "Extra day", quantity: 3, unitPrice: 15 });
  assert.strictEqual(add2.statusCode, 200);
  assert.strictEqual(add2.body.invoice.totalAmount, 394);
  assert.strictEqual(add2.body.lineItems.length, 2);

  const toRemove = add2.body.lineItems.find((li) => li.description === "Extra day");
  const removed = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "removeLineItem", lineItemId: toRemove.id });
  assert.strictEqual(removed.statusCode, 200);
  assert.strictEqual(removed.body.invoice.totalAmount, 349);
  assert.strictEqual(removed.body.lineItems.length, 1);
});

test("Line items: update recomputes the total", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  const invoiceId = created.body.invoice.id;
  const added = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "addLineItem", description: "Dumpster rental", quantity: 1, unitPrice: 349 });
  const lineItemId = added.body.lineItems[0].id;

  const updated = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "updateLineItem", lineItemId: lineItemId, description: "Dumpster rental", quantity: 1, unitPrice: 400 });
  assert.strictEqual(updated.statusCode, 200);
  assert.strictEqual(updated.body.invoice.totalAmount, 400);
});

// =======================================================================
// Finalize
// =======================================================================

async function draftWithOneLineItem(db, cookie, bookingId) {
  const created = await createInvoice(db, cookie, bookingId);
  const invoiceId = created.body.invoice.id;
  await patchInvoice(db, cookie, { id: invoiceId, action: "addLineItem", description: "Dumpster rental", quantity: 1, unitPrice: 349 });
  return invoiceId;
}

test("Finalize: rejected with no line items", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  const res = await patchInvoice(db, AUTH_COOKIE, { id: created.body.invoice.id, action: "finalize", dueDate: "2026-12-01" });
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/line item/i.test(res.body.error));
});

test("Finalize: rejected with no due date set — clear validation message", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  const res = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/due date/i.test(res.body.error), "expected a due-date validation message, got: " + res.body.error);
});

test("Finalize: with a due date set beforehand (addLineItem does not accept one — set it via a direct DB write in this test, matching the UI's own 'set due date, then finalize' two-step flow) assigns INV-YYYY-#### and locks the invoice", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  const invoiceRow = db.invoices.find((i) => i.id === invoiceId);
  invoiceRow.due_date = "2026-12-01";

  const res = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.invoice.status, "finalized");
  assert.ok(/^INV-\d{4}-\d+$/.test(res.body.invoice.invoiceNumber), "expected INV-YYYY-#### shape, got: " + res.body.invoice.invoiceNumber);
  assert.ok(res.body.invoice.finalizedAt);
});

test("Finalize: numbers are continuous across invoices, never reset — second invoice finalized gets the next sequence number", async () => {
  adminAuthed();
  const db = freshDb();
  const id1 = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === id1).due_date = "2026-12-01";
  const res1 = await patchInvoice(db, AUTH_COOKIE, { id: id1, action: "finalize" });

  const id2 = await draftWithOneLineItem(db, AUTH_COOKIE, JUNK_BOOKING_ID);
  db.invoices.find((i) => i.id === id2).due_date = "2026-12-05";
  const res2 = await patchInvoice(db, AUTH_COOKIE, { id: id2, action: "finalize" });

  const n1 = parseInt(res1.body.invoice.invoiceNumber.split("-")[2], 10);
  const n2 = parseInt(res2.body.invoice.invoiceNumber.split("-")[2], 10);
  assert.strictEqual(n2, n1 + 1);
});

test("Finalize: a second finalize attempt on an already-finalized invoice is rejected (409), never re-numbered", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceId).due_date = "2026-12-01";
  const first = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });
  const second = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });
  assert.strictEqual(second.statusCode, 409);
  assert.strictEqual(db.invoices.find((i) => i.id === invoiceId).invoice_number, first.body.invoice.invoiceNumber);
});

test("Finalize: line items are locked afterward — the server itself rejects an edit, not just the UI hiding the buttons", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceId).due_date = "2026-12-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });

  const res = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "addLineItem", description: "Sneaky extra", quantity: 1, unitPrice: 50 });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(db.invoice_line_items.filter((li) => li.invoice_id === invoiceId).length, 1);
});

// =======================================================================
// Derived status: partially paid / paid / overdue — computed from
// job_payments, never stored (this is the whole point of
// deriveInvoiceStatus()). Phase 3D Stage B cutover: moving an invoice's
// displayStatus now requires the invoice-specific ?resource=invoice-
// payment path (postInvoicePayment()) — the generic ?resource=job-
// payments endpoint (postJobPayment()) is booking-only and deliberately
// never touches any invoice's balance anymore (see "Stage B cutover"
// tests further down for that negative case explicitly).
// =======================================================================

test("Derived status: finalized + zero payments = 'finalized', not overdue when due date is in the future", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceId).due_date = "2099-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });

  const detail = await getInvoice(db, AUTH_COOKIE, invoiceId);
  assert.strictEqual(detail.body.invoice.displayStatus, "finalized");
  assert.strictEqual(detail.body.invoice.isOverdue, false);
  assert.strictEqual(detail.body.invoice.balanceDue, 349);
});

test("Derived status: a partial payment recorded via the invoice-specific endpoint flips displayStatus to partially_paid", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceId).due_date = "2099-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });

  const payRes = await postInvoicePayment(db, AUTH_COOKIE, { invoiceId: invoiceId, paymentMethod: "cash", amount: 100 });
  assert.strictEqual(payRes.statusCode, 200);

  const detail = await getInvoice(db, AUTH_COOKIE, invoiceId);
  assert.strictEqual(detail.body.invoice.displayStatus, "partially_paid");
  assert.strictEqual(detail.body.invoice.balanceDue, 249);
  assert.strictEqual(detail.body.invoice.netCollected, 100, "GET detail must return real netCollected money, not something the UI has to back out of totalAmount/balanceDue");
});

test("Derived status: a voided invoice's netCollected still reflects REAL job_payments money, never implied 'fully paid' by balanceDue's hardcoded 0", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceId).due_date = "2099-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });
  await postInvoicePayment(db, AUTH_COOKIE, { invoiceId: invoiceId, paymentMethod: "cash", amount: 100 });
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "void", reason: "test" });

  const detail = await getInvoice(db, AUTH_COOKIE, invoiceId);
  assert.strictEqual(detail.body.invoice.balanceDue, 0);
  assert.strictEqual(detail.body.invoice.netCollected, 100, "the real $100 collected must still be reported, not masked by balanceDue's void-time hardcoded 0");
});

test("Derived status: paying the remainder flips displayStatus to paid, balance $0", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceId).due_date = "2099-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });

  await postInvoicePayment(db, AUTH_COOKIE, { invoiceId: invoiceId, paymentMethod: "cash", amount: 100 });
  await postInvoicePayment(db, AUTH_COOKIE, { invoiceId: invoiceId, paymentMethod: "cash", amount: 249 });

  const detail = await getInvoice(db, AUTH_COOKIE, invoiceId);
  assert.strictEqual(detail.body.invoice.displayStatus, "paid");
  assert.strictEqual(detail.body.invoice.balanceDue, 0);
  assert.strictEqual(detail.body.invoice.isOverdue, false, "a fully-paid invoice is never shown as overdue, even past its due date");
});

test("Derived status (Stage B cutover): a generic booking payment via ?resource=job-payments no longer moves this invoice's displayStatus or balance at all", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceId).due_date = "2099-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });

  const payRes = await postJobPayment(db, AUTH_COOKIE, { bookingId: RENTAL_BOOKING_ID, paymentMethod: "cash", amount: 100 });
  assert.strictEqual(payRes.statusCode, 200, "the generic endpoint itself still works — it just no longer attributes to any invoice");
  assert.strictEqual(payRes.body.jobPayment.invoiceId, null);

  const detail = await getInvoice(db, AUTH_COOKIE, invoiceId);
  assert.strictEqual(detail.body.invoice.displayStatus, "finalized", "unchanged — a generic booking payment is never an invoice payment as of Stage B");
  assert.strictEqual(detail.body.invoice.balanceDue, 349);
  assert.strictEqual(detail.body.invoice.netCollected, 0);
});

test("Derived status: unpaid + due date in the past = isOverdue true, displayStatus still 'finalized' (overdue is a tag, not a bucket)", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceId).due_date = "2020-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });

  const detail = await getInvoice(db, AUTH_COOKIE, invoiceId);
  assert.strictEqual(detail.body.invoice.isOverdue, true);
  assert.strictEqual(detail.body.invoice.displayStatus, "finalized");
});

test("Derived status: draft is never shown as overdue even with a past due_date (not reachable via the API, but deriveInvoiceStatus() itself must not misreport it)", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === created.body.invoice.id).due_date = "2020-01-01";

  const detail = await getInvoice(db, AUTH_COOKIE, created.body.invoice.id);
  assert.strictEqual(detail.body.invoice.displayStatus, "draft");
  assert.strictEqual(detail.body.invoice.isOverdue, false);
});

// =======================================================================
// Void
// =======================================================================

test("Void: requires a reason", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  const res = await patchInvoice(db, AUTH_COOKIE, { id: created.body.invoice.id, action: "void" });
  assert.strictEqual(res.statusCode, 400);
});

test("Void: a finalized invoice can be voided; its booking's job_payments rows are completely untouched", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceId).due_date = "2099-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "finalize" });
  await postJobPayment(db, AUTH_COOKIE, { bookingId: RENTAL_BOOKING_ID, paymentMethod: "cash", amount: 100 });

  const res = await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "void", reason: "Billed in error" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.invoice.status, "void");
  assert.strictEqual(res.body.invoice.voidedReason, "Billed in error");

  assert.strictEqual(db.job_payments.length, 1);
  assert.strictEqual(db.job_payments[0].amount, 100);
  assert.strictEqual(db.job_payments[0].voided_at, null);
});

test("Void: voiding twice is rejected (409), not a silent no-op", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  await patchInvoice(db, AUTH_COOKIE, { id: created.body.invoice.id, action: "void", reason: "first" });
  const second = await patchInvoice(db, AUTH_COOKIE, { id: created.body.invoice.id, action: "void", reason: "second" });
  assert.strictEqual(second.statusCode, 409);
});

test("Void: a voided invoice's displayStatus is 'void', balance $0, regardless of due date or payments", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceId).due_date = "2020-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceId, action: "void", reason: "test" });

  const detail = await getInvoice(db, AUTH_COOKIE, invoiceId);
  assert.strictEqual(detail.body.invoice.displayStatus, "void");
  assert.strictEqual(detail.body.invoice.balanceDue, 0);
  assert.strictEqual(detail.body.invoice.isOverdue, false);
});

// =======================================================================
// GET ?resource=invoice&bookingId= — the booking-detail entry-point
// button's own lookup (never a mutating POST just to render a label)
// =======================================================================

test("Lookup by bookingId: a booking with no invoice yet returns { invoice: null }, not a 404", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await getInvoiceByBooking(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.invoice, null);
});

test("Lookup by bookingId: resolves to that booking's one active invoice, same shape as a direct id lookup", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  const res = await getInvoiceByBooking(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.invoice.id, created.body.invoice.id);
  assert.strictEqual(res.body.invoice.displayStatus, "draft");
});

test("Lookup by bookingId: after the active invoice is voided, resolves back to { invoice: null }", async () => {
  adminAuthed();
  const db = freshDb();
  const created = await createInvoice(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  await patchInvoice(db, AUTH_COOKIE, { id: created.body.invoice.id, action: "void", reason: "test" });
  const res = await getInvoiceByBooking(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.invoice, null);
});

// =======================================================================
// List (?view=invoices)
// =======================================================================

test("List: includes every invoice with its client name and derived status, filterable by ?status=", async () => {
  adminAuthed();
  const db = freshDb();

  const draft = await createInvoice(db, AUTH_COOKIE, JUNK_BOOKING_ID);

  const finalizedId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === finalizedId).due_date = "2099-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: finalizedId, action: "finalize" });

  const all = await getInvoicesView(db, AUTH_COOKIE);
  assert.strictEqual(all.statusCode, 200);
  assert.strictEqual(all.body.invoices.length, 2);
  assert.ok(all.body.invoices.every((inv) => inv.customerName === "Jamie Rivera"));

  const onlyDraft = await getInvoicesView(db, AUTH_COOKIE, { status: "draft" });
  assert.strictEqual(onlyDraft.body.invoices.length, 1);
  assert.strictEqual(onlyDraft.body.invoices[0].id, draft.body.invoice.id);

  const onlyFinalized = await getInvoicesView(db, AUTH_COOKIE, { status: "finalized" });
  assert.strictEqual(onlyFinalized.body.invoices.length, 1);
  assert.strictEqual(onlyFinalized.body.invoices[0].id, finalizedId);
});

test("List: ?status=overdue filters by the isOverdue FLAG, not a (nonexistent) displayStatus value", async () => {
  adminAuthed();
  const db = freshDb();

  const overdueId = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === overdueId).due_date = "2020-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: overdueId, action: "finalize" });

  const notOverdueId = await draftWithOneLineItem(db, AUTH_COOKIE, JUNK_BOOKING_ID);
  db.invoices.find((i) => i.id === notOverdueId).due_date = "2099-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: notOverdueId, action: "finalize" });

  const res = await getInvoicesView(db, AUTH_COOKIE, { status: "overdue" });
  assert.strictEqual(res.body.invoices.length, 1);
  assert.strictEqual(res.body.invoices[0].id, overdueId);
});

test("List: a payment recorded against one invoice never changes a sibling invoice's balance (per-invoice ledger scoping, not per-booking or global)", async () => {
  adminAuthed();
  const db = freshDb();
  const invoiceA = await draftWithOneLineItem(db, AUTH_COOKIE, RENTAL_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceA).due_date = "2099-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceA, action: "finalize" });

  const invoiceB = await draftWithOneLineItem(db, AUTH_COOKIE, JUNK_BOOKING_ID);
  db.invoices.find((i) => i.id === invoiceB).due_date = "2099-01-01";
  await patchInvoice(db, AUTH_COOKIE, { id: invoiceB, action: "finalize" });

  await postInvoicePayment(db, AUTH_COOKIE, { invoiceId: invoiceA, paymentMethod: "cash", amount: 349 });

  const list = await getInvoicesView(db, AUTH_COOKIE);
  const a = list.body.invoices.find((inv) => inv.id === invoiceA);
  const b = list.body.invoices.find((inv) => inv.id === invoiceB);
  assert.strictEqual(a.displayStatus, "paid");
  assert.strictEqual(b.displayStatus, "finalized");
  assert.strictEqual(b.balanceDue, 349);
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
      console.log("  " + (err && err.message ? err.message : err));
    }
  }
  console.log("\n" + (passed + failed) + " tests run, " + failed + " failed.");
  if (failed > 0) process.exitCode = 1;
})();
