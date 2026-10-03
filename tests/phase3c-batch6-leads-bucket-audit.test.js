// Read-only pre-Preview audit — Batch 6 (Leads consolidation).
// api/admin/bookings.js's GET ?view=leads is NOT modified by this file;
// it only proves properties about the mapping that already shipped in
// commit 5a8f276. Same fake-Supabase approach as
// tests/phase3c-batch6-leads-view.test.js (same FakeQueryBuilder, inlined
// rather than shared — this project's established per-file convention).
//
// Four things Rocky asked to have proven before Preview:
//   1. a single website booking can never appear in more than one Leads
//      bucket at the same time;
//   2. archived bookings stay excluded — for EVERY status, not just NULL;
//   3. NULL/contacted/quoted/lost/booked/rental_out/completed each map
//      deterministically to exactly one bucket (no status silently
//      dropped, none silently duplicated);
//   4. (documented in this file's own comments, not a test — see the
//      bottom of this file) whether Booked/Won is a historical bucket or
//      only a transition reference.
//
// Run with:  node tests/phase3c-batch6-leads-bucket-audit.test.js
// Exits with a non-zero code if any assertion fails.

const Module = require("module");
const assert = require("assert");

class FakeQueryBuilder {
  constructor(table, db) {
    this._table = table;
    this._db = db;
    this._rows = (db[table] || []).slice();
    this._filters = [];
    this._order = null;
  }
  select() {
    return this;
  }
  eq(field, val) {
    this._filters.push((row) => row[field] === val);
    return this;
  }
  in(field, arr) {
    const set = new Set(arr);
    this._filters.push((row) => set.has(row[field]));
    return this;
  }
  is(field, val) {
    this._filters.push((row) => (row[field] === undefined ? null : row[field]) === val);
    return this;
  }
  order(field, opts) {
    this._order = { field: field, ascending: !opts || opts.ascending !== false };
    return this;
  }
  then(resolve, reject) {
    return this._resolve().then(resolve, reject);
  }
  async _resolve() {
    let filtered = this._rows.filter((row) => this._filters.every((f) => f(row)));
    if (this._order) {
      const field = this._order.field;
      const asc = this._order.ascending;
      filtered = filtered.slice().sort((a, b) => {
        if (a[field] < b[field]) return asc ? -1 : 1;
        if (a[field] > b[field]) return asc ? 1 : -1;
        return 0;
      });
    }
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
  return {
    method: opts.method || "GET",
    headers: Object.assign({ cookie: opts.cookie || "", "x-forwarded-proto": "https" }, opts.headers || {}),
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
function run(req) {
  const res = makeRes();
  return Promise.resolve(bookingsHandler(req, res)).then(() => res);
}
const ADMIN_EMAIL = "owner@milehighjunkremoval.net";
function adminAuthed() {
  currentFakeAnon = createFakeAnonClient({
    getUser: async (token) => (token === "at-good" ? { data: { user: { email: ADMIN_EMAIL } }, error: null } : { data: null, error: { message: "no" } }),
  });
}
const AUTH_COOKIE = "mhjr_admin_at=at-good";

const CUST_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
// All 7 real bookings.status values this project's status machine has —
// see api/admin/booking.js's own STATUS_ALLOWED_STATUSES (minus "new",
// which is never stored as a literal string — see that constant's own
// surrounding comments — represented here as JS `null`, the actual
// column value).
const ALL_STATUSES = [null, "contacted", "quoted", "booked", "rental_out", "completed", "lost"];
const EXPECTED_BUCKET = {
  "null": "websiteRequests", // JSON.stringify(null) === "null", used as a map key below
  contacted: "contacted",
  quoted: "estimateSent",
  booked: "bookedWon",
  rental_out: "bookedWon",
  completed: "bookedWon",
  lost: "lost",
};
const ALL_8_SECTION_KEYS = ["websiteRequests", "new", "contacted", "waitingOnPhotos", "estimateSent", "followUp", "bookedWon", "lost"];

function bookingId(status, archived) {
  return "b-" + (archived ? "arch-" : "") + String(status);
}

function freshDb(opts) {
  opts = opts || {};
  const bookings = ALL_STATUSES.map((status) => ({
    id: bookingId(status, false),
    customer_id: CUST_ID,
    service_type: "junk_removal",
    service_city: "Denver",
    status: status,
    archived_at: null,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:00:00Z",
  }));
  if (opts.includeArchived) {
    ALL_STATUSES.forEach((status) => {
      bookings.push({
        id: bookingId(status, true),
        customer_id: CUST_ID,
        service_type: "junk_removal",
        service_city: "Denver",
        status: status,
        archived_at: "2026-09-01T00:00:00Z",
        created_at: "2026-08-01T10:00:00Z",
        updated_at: "2026-08-01T10:00:00Z",
      });
    });
  }
  return {
    customers: [{ id: CUST_ID, first_name: "Jamie", last_name: "Rivera", phone: "303-555-0100", city: "Denver" }],
    bookings: bookings,
    leads: [],
  };
}

function findIdInSections(sections, id) {
  return ALL_8_SECTION_KEYS.filter((key) => (sections[key] || []).some((item) => item.id === id));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// 1. Mutual exclusivity — a single booking id never appears in more than
//    one of the 8 sections, for EVERY one of the 7 real status values
//    (including the 3 — booked/rental_out/completed — that all route to
//    the SAME bucket, the subtlest case: two queries feeding one array
//    must still never double-list the one row that could only match one
//    of them).
// =======================================================================
test("audit 1: every status value's booking appears in EXACTLY ONE Leads section, never two", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));
  assert.strictEqual(res.statusCode, 200);

  ALL_STATUSES.forEach((status) => {
    const id = bookingId(status, false);
    const foundIn = findIdInSections(res.body.sections, id);
    assert.strictEqual(foundIn.length, 1, "booking with status " + JSON.stringify(status) + " (id " + id + ") appeared in " + foundIn.length + " sections: [" + foundIn.join(", ") + "] — expected exactly 1");
    assert.strictEqual(foundIn[0], EXPECTED_BUCKET[String(status)], "booking with status " + JSON.stringify(status) + " landed in '" + foundIn[0] + "', expected '" + EXPECTED_BUCKET[String(status)] + "'");
  });
});

test("audit 1b: the bookedWon section itself contains no duplicate ids, even though 3 separate queries (booked/rental_out/completed) all feed it", async () => {
  adminAuthed();
  const db = freshDb();
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));
  const bookedWonIds = res.body.sections.bookedWon.map((item) => item.id);
  const uniqueIds = new Set(bookedWonIds);
  assert.strictEqual(bookedWonIds.length, uniqueIds.size, "bookedWon must never list the same booking id twice");
  assert.strictEqual(bookedWonIds.length, 3, "exactly the 3 fixture bookings (booked/rental_out/completed) must be present, no more");
});

// =======================================================================
// 2. Archived exclusion — every one of the 7 statuses, not just NULL.
// =======================================================================
test("audit 2: an archived booking is excluded from every section, for ALL 7 status values (not just NULL)", async () => {
  adminAuthed();
  const db = freshDb({ includeArchived: true });
  currentFakeService = createFakeServiceClient(db);
  const res = await run(makeReq({ cookie: AUTH_COOKIE, query: { view: "leads" } }));

  ALL_STATUSES.forEach((status) => {
    const archivedId = bookingId(status, true);
    const foundIn = findIdInSections(res.body.sections, archivedId);
    assert.strictEqual(foundIn.length, 0, "an ARCHIVED booking with status " + JSON.stringify(status) + " must not appear in any Leads section, but was found in: [" + foundIn.join(", ") + "]");
  });

  // And the matching non-archived sibling (same status, same customer)
  // must still be present — proving archived_at, not status, is what's
  // actually doing the exclusion.
  ALL_STATUSES.forEach((status) => {
    const liveId = bookingId(status, false);
    const foundIn = findIdInSections(res.body.sections, liveId);
    assert.strictEqual(foundIn.length, 1, "the non-archived sibling for status " + JSON.stringify(status) + " must still appear exactly once");
  });
});

// =======================================================================
// 3. Deterministic, exhaustive status->bucket coverage.
// =======================================================================
test("audit 3: all 7 real bookings.status values are covered, each by exactly one query in handleLeadsView, each feeding exactly one section", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "bookings.js"), "utf8");
  const fnSrc = src.slice(src.indexOf("async function handleLeadsView"), src.indexOf("async function handleLeadsView") + 6000);

  // Exactly one predicate per status value inside this function — a
  // second occurrence would mean a status is queried twice (risk of
  // double-counting); a missing one would mean a status is silently
  // dropped from every Leads section.
  const PREDICATES = {
    "null": /\.is\("status", null\)/g,
    contacted: /\.eq\("status", "contacted"\)/g,
    quoted: /\.eq\("status", "quoted"\)/g,
    booked: /\.eq\("status", "booked"\)/g,
    rental_out: /\.eq\("status", "rental_out"\)/g,
    completed: /\.eq\("status", "completed"\)/g,
    lost: /\.eq\("status", "lost"\)/g,
  };
  Object.keys(PREDICATES).forEach((status) => {
    const matches = fnSrc.match(PREDICATES[status]) || [];
    assert.strictEqual(matches.length, 1, "status " + status + " must be queried exactly once inside handleLeadsView (found " + matches.length + ")");
  });

  // Every one of those 7 queries must also be scoped to non-archived rows
  // — a status predicate with no accompanying archived_at filter would
  // silently resurrect archived jobs into Leads.
  const archivedScopedCount = (fnSrc.match(/\.is\("archived_at", null\)/g) || []).length;
  assert.strictEqual(archivedScopedCount, 7, "all 7 bookings.status queries must each carry .is(\"archived_at\", null) — found " + archivedScopedCount);
});

// ---------------------------------------------------------------------
async function main() {
  const settled = [];
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
      settled.push({ name: t.name, ok: true });
    } catch (err) {
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
      settled.push({ name: t.name, ok: false });
    }
  }
  const failed = settled.filter((r) => !r.ok);
  console.log("\n" + settled.length + " tests run, " + failed.length + " failed.");
  if (failed.length) process.exitCode = 1;
}

main();

// =======================================================================
// 4. Documentation (not a test): is Booked/Won historical, or a
//    transition reference?
//
// As shipped (commit 5a8f276), Booked/Won is a PERMANENT, UNBOUNDED
// historical mirror, not a transient "just converted" pointer:
//   - The three queries feeding it (status = booked/rental_out/completed)
//     carry no date range, no LIMIT, and no "recently changed" filter —
//     every non-archived booking that has EVER reached one of those three
//     statuses will appear here, for as long as it exists and isn't
//     archived. A job booked eight months ago and completed six months
//     ago is just as present in this section today as one booked
//     yesterday.
//   - This is intentional, not an oversight: the same three statuses
//     already populate Schedule's SCHEDULABLE_STATUSES unconditionally
//     (see that constant, unchanged by this batch), so Leads' Booked/Won
//     is a READ-ONLY MIRROR of exactly what Schedule already shows,
//     tagged with the Leads vocabulary — never a separate, pruned, or
//     time-boxed view.
//   - Consequence worth flagging before this grows large in real usage:
//     over time this section's row count approaches "every job this
//     business has ever booked, minus archived ones" — effectively the
//     same unbounded set Schedule's own Month/Year views already
//     paginate/bucket by date. If Rocky wants Booked/Won to instead read
//     as "won in the last N days" (a sales-funnel snapshot rather than an
//     operational ledger), that needs an explicit date filter — a
//     deliberate scope change, not a bug, and NOT made in this audit per
//     "do not change the mapping unless a bug is found." No bug was
//     found in this area; this section documents intended behavior.
// =======================================================================
