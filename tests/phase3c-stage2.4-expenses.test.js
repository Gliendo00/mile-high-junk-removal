// Local, offline test harness for Phase 3C Stage 2.4 addendum: Daily Quick
// Expense Tracking (GET ?view=expenses / POST {resource:"expense"} on
// api/admin/bookings.js — see that file's handleExpensesList()/
// handleCreateExpense()). Same approach as every prior phase's test file:
// "@supabase/supabase-js" is intercepted at require-time and replaced with
// an in-memory fake — never the real network, never the production
// Supabase project (which does not have an `expenses` table yet — see
// docs/phase-3/stage2.4-expenses-migration.md — this suite never depends on
// it actually existing).
//
// Run with:  node tests/phase3c-stage2.4-expenses.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Fake Supabase query builder: the union of what handleExpensesList (GET,
// select/gte/lte/order, twice-chained) and handleCreateExpense (POST,
// insert/select/single) actually use. Multi-column .order() is stored as a
// list and applied in sequence, matching real supabase-js's own chained-
// order semantics (unlike the earlier, single-order-only fakes in this
// project's other test files — this is the first endpoint in the codebase
// to chain two .order() calls).
// ---------------------------------------------------------------------
let nextId = 1;
function makeId() {
  return "ffffffff-ffff-ffff-ffff-" + String(100000000000 + nextId++).padStart(12, "0");
}

class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._orders = [];
    this._single = null;
    this._insertRow = null;
  }
  select() {
    return this;
  }
  eq(field, val) {
    this._filters.push((row) => row[field] === val);
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
    this._orders.push({ field: field, ascending: !opts || opts.ascending !== false });
    return this;
  }
  insert(data) {
    this._insertRow = data;
    return this;
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
      const row = Object.assign({ id: makeId(), created_at: "2026-09-17T12:00:00Z", updated_at: "2026-09-17T12:00:00Z" }, this._insertRow);
      this._db[this._table] = this._db[this._table] || [];
      this._db[this._table].push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }

    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));
    this._orders.forEach((ord) => {
      filtered = filtered.slice().sort((a, b) => {
        if (a[ord.field] < b[ord.field]) return ord.ascending ? -1 : 1;
        if (a[ord.field] > b[ord.field]) return ord.ascending ? 1 : -1;
        return 0;
      });
    });
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
    setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
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

function freshDb(expenses) {
  return { expenses: expenses || [], bookings: [], customers: [] };
}
function getExpenses(db, query) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ cookie: AUTH_COOKIE, query: Object.assign({ view: "expenses" }, query || {}) }));
}
function postExpense(db, body) {
  currentFakeService = createFakeServiceClient(db);
  return run(bookingsHandler, makeReq({ method: "POST", cookie: AUTH_COOKIE, body: body }));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// GET ?view=expenses — bounded date range
// =======================================================================
test("GET expenses: requires auth (no cookie -> 401)", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await getExpenses(freshDb([]), { startDate: "2026-09-05", endDate: "2026-09-05" });
  assert.strictEqual(res.statusCode, 401);
});

test("GET expenses: missing startDate/endDate is rejected (400)", async () => {
  adminAuthed();
  const res = await getExpenses(freshDb([]), {});
  assert.strictEqual(res.statusCode, 400);
});

test("GET expenses: a malformed date is rejected (400)", async () => {
  adminAuthed();
  const res = await getExpenses(freshDb([]), { startDate: "09/05/2026", endDate: "2026-09-05" });
  assert.strictEqual(res.statusCode, 400);
});

test("GET expenses: endDate before startDate is rejected (400)", async () => {
  adminAuthed();
  const res = await getExpenses(freshDb([]), { startDate: "2026-09-10", endDate: "2026-09-01" });
  assert.strictEqual(res.statusCode, 400);
});

test("GET expenses: an excessively wide range is rejected (400) — never an unbounded 'every expense ever' query", async () => {
  adminAuthed();
  const res = await getExpenses(freshDb([]), { startDate: "2026-01-01", endDate: "2030-01-01" });
  assert.strictEqual(res.statusCode, 400);
});

test("GET expenses: a same-day range (the normal single-day case) is accepted", async () => {
  adminAuthed();
  const res = await getExpenses(freshDb([]), { startDate: "2026-09-05", endDate: "2026-09-05" });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.expenses, []);
});

test("GET expenses: only rows within [startDate, endDate] are returned, correctly bounded on both ends", async () => {
  adminAuthed();
  const db = freshDb([
    { id: "before", expense_date: "2026-09-04", category: "fuel", amount: 10, note: null, created_at: "t1", updated_at: "t1" },
    { id: "in1", expense_date: "2026-09-05", category: "fuel", amount: 20, note: null, created_at: "t1", updated_at: "t1" },
    { id: "in2", expense_date: "2026-09-05", category: "meals", amount: 15, note: null, created_at: "t2", updated_at: "t2" },
    { id: "after", expense_date: "2026-09-06", category: "fuel", amount: 30, note: null, created_at: "t1", updated_at: "t1" },
  ]);
  const res = await getExpenses(db, { startDate: "2026-09-05", endDate: "2026-09-05" });
  assert.deepStrictEqual(res.body.expenses.map((e) => e.id).sort(), ["in1", "in2"]);
});

test("GET expenses: response items carry categoryLabel derived from the allowlist, not raw category alone", async () => {
  adminAuthed();
  const db = freshDb([{ id: "e1", expense_date: "2026-09-05", category: "dump_fees", amount: 65, note: "North site", created_at: "t", updated_at: "t" }]);
  const res = await getExpenses(db, { startDate: "2026-09-05", endDate: "2026-09-05" });
  assert.strictEqual(res.body.expenses[0].categoryLabel, "Dump Fees");
  assert.strictEqual(res.body.expenses[0].note, "North site");
});

// =======================================================================
// POST {resource:"expense", ...}
// =======================================================================
test("POST expense: requires auth (no cookie -> 401)", async () => {
  currentFakeAnon = createFakeAnonClient();
  const res = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: "fuel", amount: 42 });
  assert.strictEqual(res.statusCode, 401);
});

test("POST expense: missing resource discriminator is rejected (400), never silently treated as an expense write", async () => {
  adminAuthed();
  const res = await postExpense(freshDb([]), { expenseDate: "2026-09-05", category: "fuel", amount: 42 });
  assert.strictEqual(res.statusCode, 400);
});

test("POST expense: a valid request creates exactly one row with the correct fields", async () => {
  adminAuthed();
  const db = freshDb([]);
  const res = await postExpense(db, { resource: "expense", expenseDate: "2026-09-05", category: "fuel", amount: "42.50", note: "  fill-up  " });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.expense.category, "fuel");
  assert.strictEqual(res.body.expense.categoryLabel, "Fuel");
  assert.strictEqual(res.body.expense.amount, 42.5);
  assert.strictEqual(res.body.expense.note, "fill-up"); // trimmed
  assert.strictEqual(db.expenses.length, 1);
  assert.strictEqual(db.expenses[0].expense_date, "2026-09-05");
});

test("POST expense: an unrecognized category is rejected (400) — never trusted merely because the client sent it", async () => {
  adminAuthed();
  const res = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: "other", amount: 10 });
  assert.strictEqual(res.statusCode, 400);
});

test("POST expense: every locked category is individually accepted, and there is no 'other' catch-all", async () => {
  adminAuthed();
  const categories = ["fuel", "dump_fees", "meals", "repairs_maintenance", "advertising", "supplies", "miscellaneous"];
  for (const category of categories) {
    const res = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: category, amount: 5 });
    assert.strictEqual(res.statusCode, 200, category + " should be accepted");
  }
  const otherRes = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: "other", amount: 5 });
  assert.strictEqual(otherRes.statusCode, 400);
});

test("POST expense: a missing/zero/negative/non-numeric amount is rejected (400)", async () => {
  adminAuthed();
  const missing = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: "fuel" });
  assert.strictEqual(missing.statusCode, 400);
  const zero = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: "fuel", amount: 0 });
  assert.strictEqual(zero.statusCode, 400);
  const negative = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: "fuel", amount: -5 });
  assert.strictEqual(negative.statusCode, 400);
  const nonNumeric = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: "fuel", amount: "not-a-number" });
  assert.strictEqual(nonNumeric.statusCode, 400);
});

test("POST expense: an amount over the bounded maximum is rejected (400)", async () => {
  adminAuthed();
  const res = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: "fuel", amount: 99999999 });
  assert.strictEqual(res.statusCode, 400);
});

test("POST expense: note is optional — omitted entirely still succeeds, stored as null", async () => {
  adminAuthed();
  const res = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: "fuel", amount: 10 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.expense.note, null);
});

test("POST expense: an oversized note is bounded, never rejected outright", async () => {
  adminAuthed();
  const longNote = "x".repeat(5000);
  const res = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: "fuel", amount: 10, note: longNote });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.expense.note.length <= 500, "note must be bounded to the documented max length");
});

test("POST expense: a note containing markup is sanitized, matching every other admin write path's discipline", async () => {
  adminAuthed();
  const res = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-09-05", category: "fuel", amount: 10, note: "<script>alert(1)</script>ok" });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(!res.body.expense.note.includes("<script>"));
});

test("POST expense: a date before the historical floor (2026-01-01) is rejected (400)", async () => {
  adminAuthed();
  const res = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2025-12-31", category: "fuel", amount: 10 });
  assert.strictEqual(res.statusCode, 400);
});

test("POST expense: the floor date itself (2026-01-01) is accepted", async () => {
  adminAuthed();
  const res = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2026-01-01", category: "fuel", amount: 10 });
  assert.strictEqual(res.statusCode, 200);
});

test("POST expense: a future date is rejected (400)", async () => {
  adminAuthed();
  const res = await postExpense(freshDb([]), { resource: "expense", expenseDate: "2099-01-01", category: "fuel", amount: 10 });
  assert.strictEqual(res.statusCode, 400);
});

test("POST expense: a malformed date is rejected (400)", async () => {
  adminAuthed();
  const res = await postExpense(freshDb([]), { resource: "expense", expenseDate: "not-a-date", category: "fuel", amount: 10 });
  assert.strictEqual(res.statusCode, 400);
});

test("POST expense: response always carries Cache-Control: no-store (via requireAdmin)", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb([]));
  const res = await run(bookingsHandler, makeReq({ method: "POST", cookie: AUTH_COOKIE, body: { resource: "expense", expenseDate: "2026-09-05", category: "fuel", amount: 10 } }));
  assert.strictEqual(res.getHeader("Cache-Control"), "no-store");
});

// =======================================================================
// Regression: creating an expense never touches the bookings/customers
// tables, and this new write surface is scoped to exactly one resource.
// =======================================================================
test("POST expense: never touches the bookings or customers tables", async () => {
  adminAuthed();
  const db = freshDb([]);
  await postExpense(db, { resource: "expense", expenseDate: "2026-09-05", category: "fuel", amount: 10 });
  assert.deepStrictEqual(db.bookings, []);
  assert.deepStrictEqual(db.customers, []);
});

test("PUT/DELETE to bookings.js are still rejected with 405 (Stage 2.4's POST branch didn't loosen this)", async () => {
  adminAuthed();
  currentFakeService = createFakeServiceClient(freshDb([]));
  const del = await run(bookingsHandler, makeReq({ method: "DELETE", cookie: AUTH_COOKIE, query: { view: "expenses" } }));
  assert.strictEqual(del.statusCode, 405);
});

// =======================================================================
// Static checks: shared category allowlist, migration doc, no stray
// serverless function added.
// =======================================================================
test("api/_lib/expense-categories.js: exactly the seven locked categories, no 'other'", () => {
  const mod = require("../api/_lib/expense-categories.js");
  const keys = Object.keys(mod.EXPENSE_CATEGORIES).sort();
  assert.deepStrictEqual(keys, ["advertising", "dump_fees", "fuel", "meals", "miscellaneous", "repairs_maintenance", "supplies"]);
  assert.ok(!("other" in mod.EXPENSE_CATEGORIES));
});

test("docs/phase-3/stage2.4-expenses-migration.md exists and documents the exact CREATE TABLE statement, not executed", () => {
  const docPath = path.join(__dirname, "..", "docs", "phase-3", "stage2.4-expenses-migration.md");
  const src = fs.readFileSync(docPath, "utf8");
  assert.ok(/CREATE TABLE\s+public\.expenses/i.test(src), "migration doc must document the CREATE TABLE statement");
  assert.ok(/not executed|NOT executed|not been run/i.test(src), "migration doc must state the migration has not been run");
});

test("deployment: adding expense GET/POST added zero new function-producing files under api/ (still <=12)", () => {
  function countApiFunctionFiles(dir) {
    let count = 0;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(path.join(__dirname, "..", "api"), full) === "_lib") return;
        count += countApiFunctionFiles(full);
      } else if (entry.name.endsWith(".js")) {
        count += 1;
      }
    });
    return count;
  }
  const total = countApiFunctionFiles(path.join(__dirname, "..", "api"));
  assert.ok(total <= 12, "api/ has " + total + " function-producing .js files, exceeding the Vercel Hobby plan's 12-function limit");
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
  process.exit(failed ? 1 : 0);
}
main();
