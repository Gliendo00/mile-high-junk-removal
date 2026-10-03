// Regression test — Batch 6 (Leads consolidation), added after a real
// Preview QA finding: GET /api/admin/bookings?view=leads 500'd with
// Postgres 42703 (undefined_column). See this session's investigation for
// the full writeup; summary below.
//
// Why this was possible at all, and why no PRIOR test caught it: every
// test in this project's suite replaces "@supabase/supabase-js" with an
// in-memory fake query builder, and EVERY one of those fakes' .select(...)
// implementations ignores its column-list argument outright — e.g. (see
// tests/phase3c-batch6-leads-view.test.js's own FakeQueryBuilder):
//   select(_cols, opts) { if (opts && opts.count) this._count = opts; return this; }
// The underscore-prefixed `_cols` parameter is a deliberate signal that it
// is received and discarded. This is correct for what those tests are
// actually verifying (business logic against fixture rows), but it means
// NO test in this repo has ever been able to catch a selected/filtered
// column that doesn't actually exist on the real table — that class of
// bug can only be caught by checking the literal column-name strings in
// the source against a maintained list of columns known to be real.
//
// This file is that check. It does NOT connect to any database (this
// project's tests never do). It extracts the exact column-list strings
// and .eq()/.is()/.order() column arguments handleLeadsView() uses,
// straight from api/admin/bookings.js's own source text, and asserts
// every single one is a member of a KNOWN_COLUMNS set below — each
// documented with exactly where its existence is proven.
//
// IMPORTANT caveat, stated plainly rather than silently assumed: `bookings`
// has NO tracked CREATE TABLE anywhere in this repo — sql/2026-09-19_
// phase3c-stage4-rental-out-status-check.sql's own header says so
// explicitly ("the table was created directly in the Supabase SQL editor
// before this project's sql/ directory convention started"). The same is
// true of `customers`. So BOOKINGS_KNOWN_COLUMNS/CUSTOMERS_KNOWN_COLUMNS
// below are NOT derived from a migration file for every entry — most are,
// but the ones that aren't are anchored to the single richest, already-
// proven-in-production SELECT list this repo has for that table (cited
// per entry group). This test proves "the code only ever references
// columns this repo has ALREADY established are real" — it cannot prove,
// and does not claim to prove, that any particular OTHER environment
// (Preview/staging) actually has every one of them. That gap is exactly
// what caused the 42703 this test was added in response to, and closing
// it is a database-side action for Rocky, not something fixable in code.
//
// Run with:  node tests/phase3c-batch6-leads-schema-contract.test.js
// Exits with a non-zero code if any assertion fails.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

// =======================================================================
// Known-good column sets.
// =======================================================================

// `bookings` — anchored to api/admin/booking.js's handleDetail() SELECT
// (the single richest, already-proven-live column list this repo has for
// this table — Booking Detail has been a core, daily-used admin feature
// since early Phase 3C), plus every ALTER TABLE ADD COLUMN this repo DOES
// track for bookings (archived_*/review_request_* — Stage 5).
const BOOKINGS_KNOWN_COLUMNS = new Set([
  "id",
  "customer_id",
  "service_type",
  "appointment_date",
  "time_window",
  "exact_time",
  "status",
  "description",
  "estimated_price",
  "estimated_price_max",
  "final_price",
  "tip_amount",
  "internal_notes",
  "is_complimentary",
  "complimentary_value",
  "complimentary_reason",
  "complimentary_note",
  "created_at",
  "updated_at",
  "service_address",
  "service_city",
  "service_state",
  "service_zip",
  // Stage 5 — tracked: sql/2026-09-26_phase3c-stage5-archive-review-rental-client.sql §1.
  "archived_at",
  "archived_reason",
  "archived_note",
  "archived_by",
  "review_request_sent_at",
  "review_request_sent_by",
]);

// `customers` — anchored to api/admin/client.js's handleDetail() SELECT
// (line ~79, the richest already-proven-live column list for this table),
// plus phone_normalized/email_normalized (Phase 3B Step 4a.1 — tracked:
// sql/2026-09-16_phase3b-step4a1-customer-identity-columns.sql) and
// updated_by (Stage 5, tracked alongside updated_at — see
// sql/2026-09-26_phase3c-stage5-archive-review-rental-client.sql §4).
const CUSTOMERS_KNOWN_COLUMNS = new Set([
  "id",
  "first_name",
  "last_name",
  "phone",
  "email",
  "address",
  "city",
  "state",
  "zip",
  "created_at",
  "phone_normalized",
  "email_normalized",
  // Stage 5 — tracked.
  "updated_at",
  "updated_by",
  "archived_at",
  "archived_reason",
  "archived_note",
  "archived_by",
]);

// `leads` — fully tracked: sql/2026-10-05_phase3c-batch6-leads.sql, run
// against Preview/staging and verification-confirmed (Rocky, 2026-10).
// Unlike bookings/customers above, every single column here DOES have a
// tracked CREATE TABLE statement in this repo.
const LEADS_KNOWN_COLUMNS = new Set([
  "id",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
  "source",
  "source_intake_id",
  "status",
  "first_name",
  "last_name",
  "phone",
  "phone_normalized",
  "email",
  "address",
  "city",
  "state",
  "zip",
  "service_type",
  "service_details",
  "estimated_load_size",
  "quoted_amount",
  "notes",
  "next_follow_up_date",
  "matched_customer_id",
  "resulting_booking_id",
]);

// =======================================================================
// Extraction helpers — pull the exact strings/arguments handleLeadsView()
// uses straight from api/admin/bookings.js's source, so this test can
// never drift from what the function actually does (no hand-copied
// duplicate list to go stale).
// =======================================================================
const bookingsSrc = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "bookings.js"), "utf8");

function extractConst(name) {
  // Matches both a single-line `const NAME = "...";` and the two-line
  // `const NAME =\n  "...";` form (LEADS_TABLE_COLS is written that way
  // for line-length reasons) — ([\s\S]*?) spans the possible newline.
  const re = new RegExp("const " + name + "\\s*=\\s*([\\s\\S]*?);");
  const m = bookingsSrc.match(re);
  assert.ok(m, name + " must be defined as a const in api/admin/bookings.js");
  // The matched group is a JS string literal (quotes included) — eval is
  // avoided; strip the surrounding quotes directly instead.
  const raw = m[1].trim();
  assert.ok(/^"[^"]*"$/.test(raw), name + "'s value must be a single plain double-quoted string literal");
  return raw.slice(1, -1);
}

function colsFromSelectString(str) {
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function handleLeadsViewSource() {
  const start = bookingsSrc.indexOf("async function handleLeadsView");
  assert.ok(start !== -1, "handleLeadsView must exist in api/admin/bookings.js");
  // Slices to the next top-level function definition — generous enough to
  // contain the whole function body without needing a real JS parser.
  const nextFn = bookingsSrc.indexOf("\nasync function ", start + 10);
  const nextFn2 = bookingsSrc.indexOf("\nfunction ", start + 10);
  const end = Math.min(...[nextFn, nextFn2].filter((n) => n !== -1));
  return bookingsSrc.slice(start, end > start ? end : start + 6000);
}

const fnSrc = handleLeadsViewSource();

// Every .eq("status", "x")/.is("status", null)/.eq("archived_at", ...) etc.
// column name referenced as a FILTER inside handleLeadsView — these need
// to exist on the table just as much as a selected column does; a filter
// on a nonexistent column 42703s identically to a bad SELECT entry.
function filterColumnsInSource(src) {
  const cols = new Set();
  const eqRe = /\.eq\("([a-z_]+)",/g;
  const isRe = /\.is\("([a-z_]+)",/g;
  const orderRe = /\.order\("([a-z_]+)"/g;
  let m;
  while ((m = eqRe.exec(src))) cols.add(m[1]);
  while ((m = isRe.exec(src))) cols.add(m[1]);
  while ((m = orderRe.exec(src))) cols.add(m[1]);
  return Array.from(cols);
}

// =======================================================================
// The actual checks.
// =======================================================================
test("schema contract: every column in LEADS_BOOKING_COLS exists on bookings per this repo's established schema knowledge", () => {
  const cols = colsFromSelectString(extractConst("LEADS_BOOKING_COLS"));
  assert.ok(cols.length > 0);
  cols.forEach((col) => {
    assert.ok(BOOKINGS_KNOWN_COLUMNS.has(col), "LEADS_BOOKING_COLS references '" + col + "', which is not in BOOKINGS_KNOWN_COLUMNS — update the migration/known-columns list, or this is exactly the class of bug that caused the 2026-10 Preview 42703");
  });
});

test("schema contract: every column in LEADS_TABLE_COLS exists on leads per sql/2026-10-05_phase3c-batch6-leads.sql", () => {
  const cols = colsFromSelectString(extractConst("LEADS_TABLE_COLS"));
  assert.ok(cols.length > 0);
  cols.forEach((col) => {
    assert.ok(LEADS_KNOWN_COLUMNS.has(col), "LEADS_TABLE_COLS references '" + col + "', which is not a column the leads migration actually creates");
  });
});

test("schema contract: handleLeadsView's inline customers SELECT only references known customers columns", () => {
  const m = fnSrc.match(/supabase\.from\("customers"\)\.select\("([^"]+)"\)/);
  assert.ok(m, "handleLeadsView must have exactly one customers select — if this changed shape, update this test's extraction regex too");
  const cols = colsFromSelectString(m[1]);
  assert.ok(cols.length > 0);
  cols.forEach((col) => {
    assert.ok(CUSTOMERS_KNOWN_COLUMNS.has(col), "handleLeadsView's customers select references '" + col + "', which is not in CUSTOMERS_KNOWN_COLUMNS");
  });
});

test("schema contract: every FILTER/ORDER column (.eq/.is/.order) inside handleLeadsView, against bookings OR leads, is a known column on that table", () => {
  const filterCols = filterColumnsInSource(fnSrc);
  assert.ok(filterCols.length > 0, "sanity: handleLeadsView must have at least one filter — an empty result here means the extraction regex broke, not that there's nothing to check");
  const combinedKnown = new Set([...BOOKINGS_KNOWN_COLUMNS, ...LEADS_KNOWN_COLUMNS]);
  filterCols.forEach((col) => {
    assert.ok(combinedKnown.has(col), "handleLeadsView filters/orders by '" + col + "', which is in neither BOOKINGS_KNOWN_COLUMNS nor LEADS_KNOWN_COLUMNS");
  });
  // And specifically, the exact column this incident's leading hypothesis
  // pointed at — archived_at — really is present in BOOKINGS_KNOWN_COLUMNS
  // and really is one of the filters this function uses on every one of
  // its 7 bookings-status queries (see the audit test file for the "used
  // exactly 7 times" proof) — this assertion exists so that if a future
  // edit ever REMOVES the archived_at filter from bookings queries (the
  // actual production-safety property, not the schema question), this
  // file fails loudly rather than silently losing coverage of it.
  assert.ok(filterCols.indexOf("archived_at") !== -1, "archived_at must still be a filter handleLeadsView applies");
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
