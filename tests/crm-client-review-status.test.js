// Client review status — the star next to a client's name on every CRM
// screen, plus the "Review received" toggle on the client page.
//   api/_lib/review-status.js   — derives received/requested/none, fails open
//   api/admin/client.js         — GET exposes it; PATCH action review-received/review-clear
//   admin/review-badge.js       — the shared star element
//
// Offline only: "@supabase/supabase-js" is replaced with an in-memory fake
// (same approach as tests/phase3c-client-edit-archive.test.js).
//
// Run with:  node tests/crm-client-review-status.test.js

const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let nextId = 1;
function makeId() {
  return "dddddddd-dddd-dddd-dddd-" + String(100000000000 + nextId++).padStart(12, "0");
}
function nowIso() {
  return new Date().toISOString();
}

// db.__missingColumns: simulate sql/2026-11-26_client-review-received.sql
// not having been run yet (Postgres 42703 undefined_column).
class FakeQueryBuilder {
  constructor(table, db) {
    this.table = table;
    this.db = db;
    this.eqFilters = [];
    this.inFilters = [];
    this.isFilters = [];
    this.notIsFilters = [];
    this._select = "";
    this._insertPayload = null;
    this._updatePayload = null;
    this._single = null;
    this._range = null;
  }
  select(cols) {
    if (typeof cols === "string") this._select = cols;
    return this;
  }
  eq(col, val) {
    this.eqFilters.push({ col, val });
    return this;
  }
  in(col, vals) {
    this.inFilters.push({ col, vals });
    return this;
  }
  is(col, val) {
    this.isFilters.push({ col, val });
    return this;
  }
  not(col, op, val) {
    if (op === "is" && val === null) this.notIsFilters.push({ col });
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  range(from, to) {
    this._range = [from, to];
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
    const missing = (this.db.__missingColumns || []).filter(
      (c) => this._select.indexOf(c) !== -1 || (this._updatePayload && Object.prototype.hasOwnProperty.call(this._updatePayload, c))
    );
    if (this.table === "customers" && missing.length) {
      return { data: null, error: { code: "42703", message: "column customers." + missing[0] + " does not exist" } };
    }
    const rows = (this.db[this.table] = this.db[this.table] || []);
    if (this._insertPayload) {
      const row = Object.assign({ id: makeId(), created_at: nowIso() }, this._insertPayload);
      rows.push(row);
      return this._single ? { data: row, error: null } : { data: [row], error: null };
    }
    let matched = rows.filter(
      (r) =>
        this.eqFilters.every((f) => r[f.col] === f.val) &&
        this.inFilters.every((f) => f.vals.indexOf(r[f.col]) !== -1) &&
        this.isFilters.every((f) => (r[f.col] === undefined ? null : r[f.col]) === f.val) &&
        this.notIsFilters.every((f) => r[f.col] !== undefined && r[f.col] !== null)
    );
    if (this._updatePayload) {
      matched.forEach((r) => Object.assign(r, this._updatePayload));
      if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
      return { data: matched, error: null };
    }
    if (this._range) matched = matched.slice(this._range[0], this._range[1] + 1);
    if (this._single === "maybeSingle") return { data: matched[0] || null, error: null };
    if (this._single === "single") return matched.length ? { data: matched[0], error: null } : { data: null, error: { message: "no rows" } };
    return { data: matched, error: null, count: matched.length };
  }
}

function createFakeServiceClient(db) {
  return { from: (table) => new FakeQueryBuilder(table, db) };
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
          throw new Error("Unexpected Supabase key in test: " + key);
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

const clientHandler = require("../api/admin/client.js");
const { fetchReviewStatusMap, deriveReviewStatus } = require("../api/_lib/review-status.js");

const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
currentFakeAnon = {
  auth: {
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
    refreshSession: async () => ({ data: null, error: { message: "no" } }),
  },
};

function makeReq(opts) {
  const json = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  return {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)), cookie: "mhjr_admin_at=at-good" },
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
    getHeader: (n) => headers[n.toLowerCase()],
    setHeader: (n, v) => {
      headers[n.toLowerCase()] = v;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(obj) {
      res.body = obj;
      return res;
    },
  };
  return res;
}
async function call(db, opts) {
  currentFakeService = createFakeServiceClient(db);
  const res = makeRes();
  await clientHandler(makeReq(opts), res);
  return res;
}

function customer(overrides) {
  return Object.assign(
    { id: makeId(), first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", email: null, city: "Denver", created_at: nowIso(), archived_at: null },
    overrides || {}
  );
}
function booking(customerId, overrides) {
  return Object.assign(
    { id: makeId(), customer_id: customerId, service_type: "junk_removal", status: "completed", appointment_date: "2026-11-01", created_at: nowIso(), review_request_sent_at: null },
    overrides || {}
  );
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// --- derivation -----------------------------------------------------------

test("deriveReviewStatus: received beats requested beats none", () => {
  assert.strictEqual(deriveReviewStatus(true, true), "received");
  assert.strictEqual(deriveReviewStatus(true, false), "received");
  assert.strictEqual(deriveReviewStatus(false, true), "requested");
  assert.strictEqual(deriveReviewStatus(false, false), "none");
});

test("fetchReviewStatusMap: one entry per client from customers + bookings", async () => {
  const a = customer({ review_received_at: nowIso() });
  const b = customer();
  const c = customer();
  const db = { customers: [a, b, c], bookings: [booking(b.id, { review_request_sent_at: nowIso() }), booking(c.id)] };
  const map = await fetchReviewStatusMap(createFakeServiceClient(db), [a.id, b.id, c.id, a.id, null]);
  assert.deepStrictEqual(map, { [a.id]: "received", [b.id]: "requested", [c.id]: "none" });
});

test("fetchReviewStatusMap: fails open (still shows 'requested') when the migration hasn't been run", async () => {
  const b = customer();
  const db = { __missingColumns: ["review_received_at"], customers: [b], bookings: [booking(b.id, { review_request_sent_at: nowIso() })] };
  const origErr = console.error;
  console.error = () => {};
  try {
    const map = await fetchReviewStatusMap(createFakeServiceClient(db), [b.id]);
    assert.deepStrictEqual(map, { [b.id]: "requested" });
  } finally {
    console.error = origErr;
  }
});

test("fetchReviewStatusMap: empty input makes no query and returns {}", async () => {
  let called = false;
  const map = await fetchReviewStatusMap({ from: () => { called = true; } }, []);
  assert.deepStrictEqual(map, {});
  assert.strictEqual(called, false);
});

// --- client API -------------------------------------------------------------

test("GET client: exposes reviewStatus + review detail", async () => {
  const c = customer({ review_received_at: "2026-11-20T15:00:00.000Z", review_received_by: ADMIN_EMAIL });
  const db = { customers: [c], bookings: [booking(c.id, { review_request_sent_at: nowIso() })], job_payments: [] };
  const res = await call(db, { query: { id: c.id } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.client.reviewStatus, "received");
  assert.strictEqual(res.body.client.review.receivedBy, ADMIN_EMAIL);
  assert.strictEqual(res.body.client.review.requestSentCount, 1);
  assert.strictEqual(res.body.client.review.trackingAvailable, true);
});

test("GET client: still loads before the migration, with trackingAvailable false", async () => {
  const c = customer();
  const db = { __missingColumns: ["review_received_at"], customers: [c], bookings: [], job_payments: [] };
  const origErr = console.error;
  console.error = () => {};
  try {
    const res = await call(db, { query: { id: c.id } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.client.reviewStatus, "none");
    assert.strictEqual(res.body.client.review.trackingAvailable, false);
  } finally {
    console.error = origErr;
  }
});

test("GET clients list: every row carries reviewStatus", async () => {
  const a = customer({ review_received_at: nowIso() });
  const b = customer();
  const db = { customers: [a, b], bookings: [booking(b.id, { review_request_sent_at: nowIso() })] };
  const res = await call(db, { query: { resource: "list" } });
  assert.strictEqual(res.statusCode, 200);
  const byId = {};
  res.body.clients.forEach((c) => (byId[c.id] = c.reviewStatus));
  assert.deepStrictEqual(byId, { [a.id]: "received", [b.id]: "requested" });
});

test("PATCH review-received then review-clear: sets/clears only the review columns and audit-logs both", async () => {
  const c = customer();
  const before = JSON.stringify(c);
  const db = { customers: [c], bookings: [], customer_audit_log: [] };
  let res = await call(db, { method: "PATCH", body: { id: c.id, action: "review-received" } });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.reviewReceivedAt);
  assert.strictEqual(res.body.reviewReceivedBy, ADMIN_EMAIL);
  assert.strictEqual(c.review_received_by, ADMIN_EMAIL);

  res = await call(db, { method: "PATCH", body: { id: c.id, action: "review-clear" } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.reviewReceivedAt, null);
  assert.strictEqual(c.review_received_at, null);

  // Nothing but the two review columns changed on the customer row.
  const after = Object.assign({}, c);
  delete after.review_received_at;
  delete after.review_received_by;
  assert.strictEqual(JSON.stringify(after), before);
  assert.deepStrictEqual(db.customer_audit_log.map((r) => r.event_type), ["review_received", "review_received_cleared"]);
});

test("PATCH review-received: 503 with a clear message before the migration is run", async () => {
  const c = customer();
  const db = { __missingColumns: ["review_received_at"], customers: [c], customer_audit_log: [] };
  const res = await call(db, { method: "PATCH", body: { id: c.id, action: "review-received" } });
  assert.strictEqual(res.statusCode, 503);
  assert.ok(/database/i.test(res.body.error));
  assert.strictEqual(db.customer_audit_log.length, 0);
});

test("PATCH review-received: unknown/malformed id is a 404", async () => {
  const db = { customers: [customer()], customer_audit_log: [] };
  let res = await call(db, { method: "PATCH", body: { id: "not-a-uuid", action: "review-received" } });
  assert.strictEqual(res.statusCode, 404);
  res = await call(db, { method: "PATCH", body: { id: makeId(), action: "review-received" } });
  assert.strictEqual(res.statusCode, 404);
});

// --- front end --------------------------------------------------------------

test("review-badge.js: builds DOM nodes only (no innerHTML) and renders nothing for 'none'", () => {
  const src = read("admin/review-badge.js");
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(src));
  assert.ok(/status !== 'received' && status !== 'requested'\) return null/.test(src));
});

test("every name-showing page loads review-badge.js before its page script", () => {
  const pages = {
    "admin/index.html": "schedule.js",
    "admin/home/index.html": "home.js",
    "admin/requests/index.html": "dashboard.js",
    "admin/leads/index.html": "leads-list.js",
    "admin/clients/index.html": "clients-list.js",
    "admin/client/index.html": "client-detail.js",
    "admin/booking/index.html": "booking-detail.js",
  };
  Object.keys(pages).forEach((p) => {
    const html = read(p);
    const badge = html.indexOf('review-badge.js"></script>');
    const page = html.indexOf(pages[p] + '"></script>');
    assert.ok(badge !== -1, p + " is missing review-badge.js");
    assert.ok(page !== -1 && badge < page, p + ": review-badge.js must load before " + pages[p]);
  });
});

test("every screen renders the star next to the client name, guarded on window.ReviewBadge", () => {
  ["admin/schedule.js", "admin/calendar-views.js", "admin/home.js", "admin/dashboard.js", "admin/leads-list.js", "admin/clients-list.js", "admin/client-detail.js", "admin/booking-detail.js"].forEach((f) => {
    const src = read(f);
    const calls = src.match(/window\.ReviewBadge\.append\(/g) || [];
    assert.ok(calls.length > 0, f + " never renders the star");
    assert.ok(/if \(window\.ReviewBadge/.test(src) || /!window\.ReviewBadge/.test(src), f + " must guard on window.ReviewBadge");
  });
});

(async function main() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
    } catch (err) {
      failed++;
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n       ") : err));
    }
  }
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " passed");
  process.exit(failed ? 1 : 0);
})();
