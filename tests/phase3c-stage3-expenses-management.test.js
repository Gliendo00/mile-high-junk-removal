// Local, offline test harness for Phase 3C Stage 3 — full Expense
// Management (edit/void, financial-audit history, job-linking search,
// category expansion, and the extended filter/search/sort on the existing
// expenses list). See docs/phase-3/stage3-payments-expenses-proposal.md.
//
// Same approach as every prior phase's test file: "@supabase/supabase-js"
// is intercepted at require-time and replaced with an in-memory fake —
// never the real network, never the production Supabase project. The
// database-enforced audit TRIGGER itself (see the migration SQL's §3) is
// real PL/pgSQL and cannot be exercised by this offline fake — that trigger
// can only be verified against a real Postgres instance (staging), same
// honesty this project's other docs already apply to untestable-offline
// pieces. What IS tested here: that handlePatchExpense() sends the correct
// update payload (including updated_by, which the trigger reads directly
// off NEW rather than a session variable — see the migration SQL for why),
// that a voided expense can never be edited or re-voided, and that no
// hard-delete path exists anywhere in this file.
//
// Run with:  node tests/phase3c-stage3-expenses-management.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

let nextId = 1;
function makeId() {
  return "eeeeeeee-eeee-eeee-eeee-" + String(100000000000 + nextId++).padStart(12, "0");
}
function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------
// Fake Supabase — a fuller builder than Stage 2.4's own (that file's fake
// gained is()/ilike()/limit()/maybeSingle()/update() alongside this stage's
// work; this file's copy additionally supports in()/upsert() for the
// job-search picker and future ledger-adjacent tests).
// ---------------------------------------------------------------------
class FakeQueryBuilder {
  constructor(table, db) {
    this.table = table;
    this.db = db;
    this.eqFilters = [];
    this.isFilters = [];
    this.ilikeFilters = [];
    this.inFilters = [];
    this.rangeFilters = [];
    this._orders = [];
    this._limit = null;
    this._insertPayload = null;
    this._updatePayload = null;
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
  ilike(col, pattern) {
    const needle = String(pattern).replace(/^%|%$/g, "").toLowerCase();
    this.ilikeFilters.push({ col, needle });
    return this;
  }
  in(col, values) {
    const set = new Set(values);
    this.inFilters.push({ col, set });
    return this;
  }
  gte(col, val) {
    this.rangeFilters.push({ col, val, op: "gte" });
    return this;
  }
  lte(col, val) {
    this.rangeFilters.push({ col, val, op: "lte" });
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

    let matched = rows.filter(
      (r) =>
        this.eqFilters.every((f) => r[f.col] === f.val) &&
        this.isFilters.every((f) => (r[f.col] === undefined ? null : r[f.col]) === f.val) &&
        this.ilikeFilters.every((f) => typeof r[f.col] === "string" && r[f.col].toLowerCase().indexOf(f.needle) !== -1) &&
        this.inFilters.every((f) => f.set.has(r[f.col])) &&
        this.rangeFilters.every((f) => (f.op === "gte" ? r[f.col] >= f.val : r[f.col] <= f.val))
    );

    if (this._updatePayload) {
      if (this.db.__fkTables && this.db.__fkTables[this.table]) {
        for (const [col, refTable] of Object.entries(this.db.__fkTables[this.table])) {
          const val = this._updatePayload[col];
          if (val != null && !(this.db[refTable] || []).some((r) => r.id === val)) {
            return { data: null, error: { code: "23503", message: "foreign key violation on " + col } };
          }
        }
      }
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
  return { from: (table) => new FakeQueryBuilder(table, db) };
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
  return Object.assign({ expenses: [], bookings: [], customers: [], expense_audit_log: [], __fkTables: { expenses: { booking_id: "bookings" } } }, overrides || {});
}
function req(db, opts) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq(Object.assign({ cookie: AUTH_COOKIE }, opts)));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

function makeExpense(overrides) {
  return Object.assign(
    {
      id: makeId(),
      expense_date: "2026-09-10",
      category: "fuel",
      amount: 68,
      note: null,
      vendor: null,
      payment_method: null,
      booking_id: null,
      receipt_reference: null,
      voided_at: null,
      voided_reason: null,
      created_by: "owner@milehighjunkremoval.net",
      updated_by: null,
      created_at: "2026-09-10T12:00:00Z",
      updated_at: "2026-09-10T12:00:00Z",
    },
    overrides || {}
  );
}

// =======================================================================
// PATCH — edit
// =======================================================================
test("PATCH expense (update): requires auth (no cookie -> 401)", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await req(freshDb(), { method: "PATCH", body: { resource: "expense", id: "x", amount: 76 } });
  assert.strictEqual(res.statusCode, 401);
});

test("PATCH expense (update): missing resource discriminator is rejected (400)", async () => {
  adminAuthed();
  const res = await req(freshDb(), { method: "PATCH", body: { id: "x", amount: 76 } });
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH expense (update): unknown id -> 404", async () => {
  adminAuthed();
  const res = await req(freshDb(), { method: "PATCH", body: { resource: "expense", id: makeId(), amount: 76 } });
  assert.strictEqual(res.statusCode, 404);
});

test("PATCH expense (update): amount is corrected in place, and updated_by is written from the session (the trigger reads this column directly — see the migration SQL)", async () => {
  adminAuthed();
  const e = makeExpense({ amount: 68 });
  const db = freshDb({ expenses: [e] });
  const res = await req(db, { method: "PATCH", body: { resource: "expense", id: e.id, amount: 76 } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.expense.amount, 76);
  assert.strictEqual(db.expenses[0].amount, 76);
  assert.strictEqual(db.expenses[0].updated_by, ADMIN_EMAIL);
});

test("PATCH expense (update): a partial edit (only note sent) leaves every other field untouched", async () => {
  adminAuthed();
  const e = makeExpense({ amount: 68, category: "fuel", vendor: "Shell" });
  const db = freshDb({ expenses: [e] });
  const res = await req(db, { method: "PATCH", body: { resource: "expense", id: e.id, note: "corrected note" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.expense.amount, 68);
  assert.strictEqual(res.body.expense.category, "fuel");
  assert.strictEqual(res.body.expense.vendor, "Shell");
  assert.strictEqual(res.body.expense.note, "corrected note");
});

test("PATCH expense (update): an invalid category is rejected (400), row unchanged", async () => {
  adminAuthed();
  const e = makeExpense();
  const db = freshDb({ expenses: [e] });
  const res = await req(db, { method: "PATCH", body: { resource: "expense", id: e.id, category: "not-a-real-category" } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(db.expenses[0].category, "fuel");
});

test("PATCH expense (update): a zero/negative amount is rejected (400)", async () => {
  adminAuthed();
  const e = makeExpense();
  const db = freshDb({ expenses: [e] });
  const res = await req(db, { method: "PATCH", body: { resource: "expense", id: e.id, amount: 0 } });
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH expense (update): a voided expense can never be edited (409) — the correction path is void-then-new-entry, never mutate-a-closed-record", async () => {
  adminAuthed();
  const e = makeExpense({ voided_at: nowIso(), voided_reason: "duplicate entry" });
  const db = freshDb({ expenses: [e] });
  const res = await req(db, { method: "PATCH", body: { resource: "expense", id: e.id, amount: 100 } });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(db.expenses[0].amount, e.amount, "the voided row's amount must be untouched");
});

test("PATCH expense (update): linking to a nonexistent job is rejected (400) via the FK check", async () => {
  adminAuthed();
  const e = makeExpense();
  const db = freshDb({ expenses: [e] });
  const res = await req(db, { method: "PATCH", body: { resource: "expense", id: e.id, bookingId: "00000000-0000-0000-0000-000000000000" } });
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH expense (update): linking to a real job succeeds", async () => {
  adminAuthed();
  const booking = { id: makeId(), appointment_date: "2026-09-01", service_type: "junk_removal", customer_id: null };
  const e = makeExpense();
  const db = freshDb({ expenses: [e], bookings: [booking] });
  const res = await req(db, { method: "PATCH", body: { resource: "expense", id: e.id, bookingId: booking.id } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.expense.bookingId, booking.id);
});

// =======================================================================
// PATCH — void
// =======================================================================
test("PATCH expense (void): a reason is required (400)", async () => {
  adminAuthed();
  const e = makeExpense();
  const db = freshDb({ expenses: [e] });
  const res = await req(db, { method: "PATCH", body: { resource: "expense", id: e.id, action: "void" } });
  assert.strictEqual(res.statusCode, 400);
});

test("PATCH expense (void): voids the row (sets voided_at/voided_reason), amount/category untouched — the ONLY removal mechanism, never a hard delete", async () => {
  adminAuthed();
  const e = makeExpense({ amount: 68, category: "fuel" });
  const db = freshDb({ expenses: [e] });
  const res = await req(db, { method: "PATCH", body: { resource: "expense", id: e.id, action: "void", reason: "entered twice by mistake" } });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.expense.isVoided);
  assert.strictEqual(res.body.expense.voidedReason, "entered twice by mistake");
  assert.strictEqual(res.body.expense.amount, 68, "voiding must never change the amount — the row is preserved, not corrected");
  assert.strictEqual(db.expenses.length, 1, "voiding never removes the row");
});

test("PATCH expense (void): voiding an already-voided expense is rejected (409), not silently repeated", async () => {
  adminAuthed();
  const e = makeExpense({ voided_at: nowIso(), voided_reason: "first void" });
  const db = freshDb({ expenses: [e] });
  const res = await req(db, { method: "PATCH", body: { resource: "expense", id: e.id, action: "void", reason: "second attempt" } });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(db.expenses[0].voided_reason, "first void", "the original void reason must not be overwritten");
});

test("admin/expenses.js never uses innerHTML/insertAdjacentHTML/document.write", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "admin", "expenses.js"), "utf8");
  assert.ok(!/\.innerHTML\s*=/.test(src), "must not assign innerHTML");
  assert.ok(!/\.insertAdjacentHTML\s*\(/.test(src), "must not call insertAdjacentHTML(...)");
  assert.ok(!/document\.write\s*\(/.test(src), "must not call document.write(...)");
});

test("admin/expenses/index.html exists, wires expenses.js, and has the Expenses nav tab active", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "admin", "expenses", "index.html"), "utf8");
  assert.ok(src.includes('src="../expenses.js"'));
  assert.ok(/class="admin-nav-tab is-active"[^>]*>Expenses</.test(src));
});

test("no hard-delete path exists anywhere in api/admin/bookings.js for expenses — grep guard", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "bookings.js"), "utf8");
  assert.ok(!/\.from\(["']expenses["']\)[^;]*\.delete\s*\(/s.test(src), "no code path may call .delete( on the expenses table — void (soft-delete) is the only removal mechanism");
});

// =======================================================================
// GET ?view=expenses — Stage 3 filters/search/sort/totals
// =======================================================================
function getExpenses(db, query) {
  return req(db, { query: Object.assign({ view: "expenses" }, query || {}) });
}

test("GET expenses: voided rows are excluded by default", async () => {
  adminAuthed();
  const active = makeExpense({ amount: 20 });
  const voided = makeExpense({ amount: 30, voided_at: nowIso(), voided_reason: "oops" });
  const db = freshDb({ expenses: [active, voided] });
  const res = await getExpenses(db, { startDate: "2026-09-01", endDate: "2026-09-30" });
  assert.strictEqual(res.body.expenses.length, 1);
  assert.strictEqual(res.body.expenses[0].id, active.id);
  assert.strictEqual(res.body.totalAmount, 20);
});

test("GET expenses: includeVoided=1 brings voided rows back, each flagged isVoided", async () => {
  adminAuthed();
  const active = makeExpense({ amount: 20 });
  const voided = makeExpense({ amount: 30, voided_at: nowIso(), voided_reason: "oops" });
  const db = freshDb({ expenses: [active, voided] });
  const res = await getExpenses(db, { startDate: "2026-09-01", endDate: "2026-09-30", includeVoided: "1" });
  assert.strictEqual(res.body.expenses.length, 2);
  const voidedItem = res.body.expenses.find((e) => e.id === voided.id);
  assert.ok(voidedItem.isVoided);
});

test("GET expenses: category filter narrows results", async () => {
  adminAuthed();
  const fuel = makeExpense({ category: "fuel" });
  const labor = makeExpense({ category: "labor" });
  const db = freshDb({ expenses: [fuel, labor] });
  const res = await getExpenses(db, { startDate: "2026-09-01", endDate: "2026-09-30", category: "labor" });
  assert.strictEqual(res.body.expenses.length, 1);
  assert.strictEqual(res.body.expenses[0].id, labor.id);
});

test("GET expenses: paymentMethod filter narrows results", async () => {
  adminAuthed();
  const cash = makeExpense({ payment_method: "cash" });
  const zelle = makeExpense({ payment_method: "zelle" });
  const db = freshDb({ expenses: [cash, zelle] });
  const res = await getExpenses(db, { startDate: "2026-09-01", endDate: "2026-09-30", paymentMethod: "zelle" });
  assert.strictEqual(res.body.expenses.length, 1);
  assert.strictEqual(res.body.expenses[0].id, zelle.id);
});

test("GET expenses: bookingId filter returns only expenses linked to that job", async () => {
  adminAuthed();
  const booking = { id: makeId(), appointment_date: "2026-09-01", service_type: "junk_removal", customer_id: null };
  const linked = makeExpense({ booking_id: booking.id });
  const unlinked = makeExpense({ booking_id: null });
  const db = freshDb({ expenses: [linked, unlinked], bookings: [booking] });
  const res = await getExpenses(db, { startDate: "2026-09-01", endDate: "2026-09-30", bookingId: booking.id });
  assert.strictEqual(res.body.expenses.length, 1);
  assert.strictEqual(res.body.expenses[0].id, linked.id);
});

test("GET expenses: search matches vendor OR note (case-insensitive substring)", async () => {
  adminAuthed();
  const byVendor = makeExpense({ vendor: "Denver Dump Co" });
  const byNote = makeExpense({ note: "paid the Denver landfill fee" });
  const neither = makeExpense({ vendor: "Shell", note: "gas" });
  const db = freshDb({ expenses: [byVendor, byNote, neither] });
  const res = await getExpenses(db, { startDate: "2026-09-01", endDate: "2026-09-30", search: "denver" });
  const ids = res.body.expenses.map((e) => e.id).sort();
  assert.deepStrictEqual(ids, [byNote.id, byVendor.id].sort());
});

test("GET expenses: sort by amount ascending/descending", async () => {
  adminAuthed();
  const low = makeExpense({ amount: 10 });
  const high = makeExpense({ amount: 90 });
  const db = freshDb({ expenses: [high, low] });
  const asc = await getExpenses(db, { startDate: "2026-09-01", endDate: "2026-09-30", sort: "amount", sortDir: "asc" });
  assert.deepStrictEqual(
    asc.body.expenses.map((e) => e.amount),
    [10, 90]
  );
  const desc = await getExpenses(db, { startDate: "2026-09-01", endDate: "2026-09-30", sort: "amount", sortDir: "desc" });
  assert.deepStrictEqual(
    desc.body.expenses.map((e) => e.amount),
    [90, 10]
  );
});

test("GET expenses: an expense linked to a job carries a job label (customer name + date) for display", async () => {
  adminAuthed();
  const customer = { id: makeId(), first_name: "Jane", last_name: "Doe" };
  const booking = { id: makeId(), appointment_date: "2026-09-12", service_type: "junk_removal", customer_id: customer.id };
  const e = makeExpense({ booking_id: booking.id });
  const db = freshDb({ expenses: [e], bookings: [booking], customers: [customer] });
  const res = await getExpenses(db, { startDate: "2026-09-01", endDate: "2026-09-30" });
  assert.ok(res.body.expenses[0].job);
  assert.strictEqual(res.body.expenses[0].job.appointmentDate, "2026-09-12");
  assert.ok(res.body.expenses[0].job.label.indexOf("Jane Doe") !== -1);
});

// =======================================================================
// GET ?view=expense-audit — read-only history
// =======================================================================
test("GET expense-audit: requires auth (401)", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await req(freshDb(), { query: { view: "expense-audit", expenseId: makeId() } });
  assert.strictEqual(res.statusCode, 401);
});

test("GET expense-audit: missing expenseId -> 400", async () => {
  adminAuthed();
  const res = await req(freshDb(), { query: { view: "expense-audit" } });
  assert.strictEqual(res.statusCode, 400);
});

test("GET expense-audit: returns this expense's history, oldest first, with human-readable field labels", async () => {
  adminAuthed();
  const expenseId = makeId();
  const db = freshDb({
    expense_audit_log: [
      { id: makeId(), expense_id: expenseId, changed_at: "2026-09-10T12:05:00Z", changed_by: ADMIN_EMAIL, change_type: "update", field_name: "amount", old_value: "68", new_value: "76" },
      { id: makeId(), expense_id: expenseId, changed_at: "2026-09-10T12:00:00Z", changed_by: ADMIN_EMAIL, change_type: "create", field_name: null, old_value: null, new_value: null },
    ],
  });
  const res = await req(db, { query: { view: "expense-audit", expenseId: expenseId } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.history.length, 2);
  assert.strictEqual(res.body.history[0].changeType, "create", "history must be ordered oldest-first");
  assert.strictEqual(res.body.history[1].fieldLabel, "Amount");
  assert.strictEqual(res.body.history[1].oldValue, "68");
  assert.strictEqual(res.body.history[1].newValue, "76");
});

test("GET expense-audit: an expense with no history yet returns an empty array, not an error", async () => {
  adminAuthed();
  const res = await req(freshDb(), { query: { view: "expense-audit", expenseId: makeId() } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.history, []);
});

// =======================================================================
// GET ?view=job-search — the "link to a job" picker
// =======================================================================
test("GET job-search: requires auth (401)", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await req(freshDb(), { query: { view: "job-search", q: "jane" } });
  assert.strictEqual(res.statusCode, 401);
});

test("GET job-search: a query under 2 characters returns no results without querying the database", async () => {
  adminAuthed();
  const res = await req(freshDb(), { query: { view: "job-search", q: "j" } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.jobs, []);
});

test("GET job-search: matches by customer first/last name and returns that customer's bookings", async () => {
  adminAuthed();
  const customer = { id: makeId(), first_name: "Jane", last_name: "Doe", phone: "3035551212" };
  const booking = { id: makeId(), appointment_date: "2026-09-12", service_type: "junk_removal", customer_id: customer.id };
  const db = freshDb({ customers: [customer], bookings: [booking] });
  const res = await req(db, { query: { view: "job-search", q: "doe" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.jobs.length, 1);
  assert.strictEqual(res.body.jobs[0].id, booking.id);
  assert.ok(res.body.jobs[0].label.indexOf("Jane Doe") !== -1);
});

test("GET job-search: no matching customer -> empty jobs array, not an error", async () => {
  adminAuthed();
  const db = freshDb({ customers: [{ id: makeId(), first_name: "Bob", last_name: "Smith", phone: "111" }], bookings: [] });
  const res = await req(db, { query: { view: "job-search", q: "nomatch" } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.jobs, []);
});

// =======================================================================
// POST create — Stage 3's new optional fields
// =======================================================================
test("POST expense: vendor/paymentMethod/receiptReference are accepted and persisted", async () => {
  adminAuthed();
  const db = freshDb();
  const res = await req(db, {
    method: "POST",
    body: { resource: "expense", expenseDate: "2026-09-10", category: "fuel", amount: 42, vendor: "Shell", paymentMethod: "cash", receiptReference: "rcpt-001" },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.expense.vendor, "Shell");
  assert.strictEqual(res.body.expense.paymentMethod, "cash");
  assert.strictEqual(res.body.expense.receiptReference, "rcpt-001");
  assert.strictEqual(db.expenses[0].created_by, ADMIN_EMAIL);
});

test("POST expense: an invalid paymentMethod is rejected (400)", async () => {
  adminAuthed();
  const res = await req(freshDb(), { method: "POST", body: { resource: "expense", expenseDate: "2026-09-10", category: "fuel", amount: 42, paymentMethod: "bitcoin" } });
  assert.strictEqual(res.statusCode, 400);
});

test("POST expense: linking to a real job at creation time succeeds", async () => {
  adminAuthed();
  const booking = { id: makeId(), appointment_date: "2026-09-01", service_type: "junk_removal", customer_id: null };
  const db = freshDb({ bookings: [booking] });
  const res = await req(db, { method: "POST", body: { resource: "expense", expenseDate: "2026-09-10", category: "fuel", amount: 42, bookingId: booking.id } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.expense.bookingId, booking.id);
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
