// Site Improvement Agent, Phase 4 (deployment-readiness hardening) —
// static production-readiness review checks for the two Phase 3 SQL
// migrations (sql/2026-10-12_phase3-agent-proposals.sql and
// sql/2026-10-12_phase3-agent-howd-it-go.sql). Neither migration is
// EXECUTED by this test (there is no real database connection anywhere
// in this test suite) — these are source-level checks that the
// migrations stay additive/idempotent, and specifically that their DB
// CHECK constraint enum lists never silently drift out of sync with the
// application code that actually produces those values (risk.js's
// categories, decision.js's DECISIONS, bookings.js's
// AGENT_PROPOSAL_STATUSES) — a drift there would mean the real Postgres
// CHECK constraint could reject a perfectly valid row the app produced,
// or (worse, if the constraint were ever loosened) silently accept a
// value the app never intended to allow.
//
// Run with:  node tests/agent-migrations-review.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { RULES } = require("../agent/lib/risk");
const { DECISIONS } = require("../agent/lib/decision");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const proposalsSql = fs.readFileSync(
  path.join(__dirname, "..", "sql", "2026-10-12_phase3-agent-proposals.sql"),
  "utf8"
);
const howdItGoSql = fs.readFileSync(
  path.join(__dirname, "..", "sql", "2026-10-12_phase3-agent-howd-it-go.sql"),
  "utf8"
);
// Phase 5 — the Adjust-workflow migration ALTERs the original
// agent_proposals table (widens the status CHECK, adds two columns,
// re-GRANTs UPDATE). Read alongside the original so the tests below can
// check the CUMULATIVE effect of applying both in order, not just the
// first file in isolation — applying only the first file's checks here
// would silently stop catching drift the moment a second migration
// changes the same constraint/grant.
const adjustSql = fs.readFileSync(
  path.join(__dirname, "..", "sql", "2026-10-14_phase5-agent-adjust-workflow.sql"),
  "utf8"
);

function extractCheckInList(sql, column) {
  const re = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`, "i");
  const m = sql.match(re);
  assert.ok(m, `expected a CHECK (${column} IN (...)) constraint in the migration`);
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
}

// Statements that would be destructive if ever actually run — this test
// only confirms the EXECUTABLE (non-comment) SQL never contains them.
// Simple heuristic: strip `--` line comments first, since the Rollback
// sections are deliberately commented out and legitimately contain
// DROP TABLE/DROP COLUMN as reference-only text.
//
// Line endings: this file may be read back with CRLF (git's autocrlf
// rewrites LF -> CRLF on checkout on a Windows machine, even though the
// committed blob itself is unaffected) — strip any trailing \r PER LINE
// first, rather than relying on `.`/`$` to see through it. `.` does not
// match a line-terminator character (which includes \r) and, with no `m`
// flag, `$` only matches at the true end of the string — so a line like
// "-- comment\r" left the old version of this function's regex with no
// valid match at all, silently leaving the WHOLE line (including the
// comment) unstripped. Caught for real on first use in a freshly
// checked-out working tree, not just a theoretical concern.
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/\r$/, "").replace(/--.*$/, ""))
    .join("\n");
}

test("agent_proposals.sql: CREATE TABLE/CREATE INDEX use IF NOT EXISTS (idempotent, safe to re-run)", () => {
  assert.ok(/CREATE TABLE IF NOT EXISTS public\.agent_proposals/i.test(proposalsSql));
  assert.ok(/CREATE INDEX IF NOT EXISTS agent_proposals_status_idx/i.test(proposalsSql));
});

test("agent_proposals.sql: the executable SQL contains no DROP/TRUNCATE/DELETE statement (only additive DDL + grants)", () => {
  const executable = stripSqlComments(proposalsSql);
  assert.ok(!/\bDROP\s+TABLE\b/i.test(executable));
  assert.ok(!/\bTRUNCATE\b/i.test(executable));
  assert.ok(!/\bDELETE\s+FROM\b/i.test(executable));
});

test("agent_proposals.sql: category CHECK constraint matches exactly the categories risk.js's RULES table ever assigns (A-E)", () => {
  const sqlCategories = extractCheckInList(proposalsSql, "category").sort();
  const appCategories = [...new Set(Object.values(RULES).map((r) => r.category))].concat(["E"]).sort();
  const uniqueAppCategories = [...new Set(appCategories)].sort();
  assert.deepStrictEqual(sqlCategories, uniqueAppCategories, "the SQL CHECK constraint's allowed categories must match every category risk.js can actually assign (including E, the classify() fail-safe default)");
});

test("agent_proposals.sql: decision CHECK constraint matches exactly decision.js's DECISIONS list", () => {
  const sqlDecisions = extractCheckInList(proposalsSql, "decision").sort();
  const appDecisions = [...DECISIONS].sort();
  assert.deepStrictEqual(sqlDecisions, appDecisions);
});

// Phase 5: the Adjust-workflow migration widens this exact constraint
// (DROP + re-ADD, same constraint name) — the CUMULATIVE/final status
// list (after both migrations apply, in order, to a real database) comes
// from adjustSql, not proposalsSql alone. Checking proposalsSql in
// isolation here would stop reflecting the real deployed constraint the
// moment a second migration touches it.
test("agent_proposals.sql + phase5-agent-adjust-workflow.sql: the FINAL status CHECK constraint (after both migrations apply, in order) matches exactly api/admin/bookings.js's AGENT_PROPOSAL_STATUSES list", () => {
  const sqlStatuses = extractCheckInList(adjustSql, "status").sort();
  const bookingsJs = fs.readFileSync(path.join(__dirname, "..", "api", "admin", "bookings.js"), "utf8");
  const m = bookingsJs.match(/const AGENT_PROPOSAL_STATUSES = \[([^\]]*)\];/);
  assert.ok(m, "expected AGENT_PROPOSAL_STATUSES in api/admin/bookings.js");
  const appStatuses = m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).sort();
  assert.deepStrictEqual(sqlStatuses, appStatuses);
});

test("agent_proposals.sql: RLS is enabled with no policies defined (service_role-only access, same pattern as booking_audit_log/customer_audit_log)", () => {
  assert.ok(/ALTER TABLE public\.agent_proposals ENABLE ROW LEVEL SECURITY/i.test(proposalsSql));
  assert.ok(!/CREATE POLICY/i.test(proposalsSql), "no policy should exist — RLS-enabled-with-zero-policies is the intended lockdown, same as the existing audit-log tables");
});

test("agent_proposals.sql: service_role grants are REVOKE-first (deterministic end state) and UPDATE excludes identity columns (finding_key/finding_type/pages/created_at)", () => {
  assert.ok(/REVOKE ALL ON public\.agent_proposals FROM service_role/i.test(proposalsSql));
  const grantUpdateMatch = proposalsSql.match(/GRANT UPDATE \(([\s\S]*?)\) ON public\.agent_proposals/i);
  assert.ok(grantUpdateMatch);
  const updatableColumns = grantUpdateMatch[1].split(",").map((s) => s.trim().replace(/\n/g, "")).filter(Boolean);
  for (const protectedCol of ["finding_key", "finding_type", "pages", "created_at", "id"]) {
    assert.ok(!updatableColumns.includes(protectedCol), `${protectedCol} must never be in the UPDATE grant's column list`);
  }
});

// Phase 5: the Adjust-workflow migration re-REVOKEs/re-GRANTs with a
// widened column list (adds adjust_note/adjusted_at). The FINAL grant
// (after both migrations apply, in order) comes from adjustSql.
test("phase5-agent-adjust-workflow.sql: re-grants are REVOKE-first too, and the FINAL UPDATE grant still excludes identity columns", () => {
  assert.ok(/REVOKE ALL ON public\.agent_proposals FROM service_role/i.test(adjustSql));
  const grantUpdateMatch = adjustSql.match(/GRANT UPDATE \(([\s\S]*?)\) ON public\.agent_proposals/i);
  assert.ok(grantUpdateMatch);
  const updatableColumns = grantUpdateMatch[1].split(",").map((s) => s.trim().replace(/\n/g, "")).filter(Boolean);
  for (const protectedCol of ["finding_key", "finding_type", "pages", "created_at", "id"]) {
    assert.ok(!updatableColumns.includes(protectedCol), `${protectedCol} must never be in the UPDATE grant's column list`);
  }
});

test("agent_proposals.sql + phase5-agent-adjust-workflow.sql: the FINAL GRANT UPDATE column list matches EXACTLY proposals-sync.js's updatableFields() output, plus every column the approve/reject/adjust PATCH writes", () => {
  const { updatableFields } = require("../agent/lib/proposals-sync");
  const sampleFinding = { category: "A", riskLevel: "low", decision: "PROPOSE_CHANGE", reason: "x", summary: "x", evidence: [], research: [] };
  const syncColumns = Object.keys(updatableFields(sampleFinding, "run-1"));
  const reviewColumns = ["status", "reviewed_by", "reviewed_at", "review_note", "adjust_note", "adjusted_at"];

  const grantUpdateMatch = adjustSql.match(/GRANT UPDATE \(([\s\S]*?)\) ON public\.agent_proposals/i);
  const sqlColumns = grantUpdateMatch[1].split(",").map((s) => s.trim().replace(/\n/g, "")).filter(Boolean).sort();

  const expected = [...new Set([...syncColumns, ...reviewColumns])].sort();
  assert.deepStrictEqual(sqlColumns, expected, "the SQL grant must cover exactly what the sync step's UPDATE and the approve/reject/adjust PATCH actually write — no more, no less");
});

test("howd-it-go.sql: adds exactly one nullable column with no default, via ADD COLUMN IF NOT EXISTS (additive, idempotent, no backfill needed)", () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS operational_note text NULL/i.test(howdItGoSql));
  assert.ok(!/DEFAULT/i.test(stripSqlComments(howdItGoSql)), "no DEFAULT needed or wanted for a plain nullable text column — existing rows get NULL for free");
});

test("howd-it-go.sql: the executable SQL contains no DROP/ALTER COLUMN TYPE/NOT NULL statement", () => {
  const executable = stripSqlComments(howdItGoSql);
  assert.ok(!/\bDROP\s+(TABLE|COLUMN)\b/i.test(executable));
  assert.ok(!/SET\s+NOT\s+NULL/i.test(executable));
});

test("phase5-agent-adjust-workflow.sql: adds its two new columns via ADD COLUMN IF NOT EXISTS, and the status CHECK is dropped-then-recreated by name (idempotent, safe to re-run)", () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS adjust_note text NULL/i.test(adjustSql));
  assert.ok(/ADD COLUMN IF NOT EXISTS adjusted_at timestamptz NULL/i.test(adjustSql));
  assert.ok(/DROP CONSTRAINT IF EXISTS agent_proposals_status_check/i.test(adjustSql));
  assert.ok(/ADD CONSTRAINT agent_proposals_status_check/i.test(adjustSql));
});

test("phase5-agent-adjust-workflow.sql: the executable SQL contains no DROP TABLE/TRUNCATE/DELETE/DROP COLUMN statement (only an additive/idempotent ALTER + re-GRANT)", () => {
  const executable = stripSqlComments(adjustSql);
  assert.ok(!/\bDROP\s+TABLE\b/i.test(executable));
  assert.ok(!/\bTRUNCATE\b/i.test(executable));
  assert.ok(!/\bDELETE\s+FROM\b/i.test(executable));
  assert.ok(!/\bDROP\s+COLUMN\b/i.test(executable));
});

test("both migrations' rollback sections are commented out (reference-only), never part of the executable statement", () => {
  for (const sql of [proposalsSql, howdItGoSql]) {
    const executable = stripSqlComments(sql);
    assert.ok(!/DROP TABLE IF EXISTS public\.agent_proposals/i.test(executable) || sql.includes("-- DROP TABLE IF EXISTS public.agent_proposals"));
  }
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
