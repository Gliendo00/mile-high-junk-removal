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
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
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

test("agent_proposals.sql: status CHECK constraint matches exactly api/admin/bookings.js's AGENT_PROPOSAL_STATUSES list", () => {
  const sqlStatuses = extractCheckInList(proposalsSql, "status").sort();
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

test("agent_proposals.sql: the GRANT UPDATE column list matches EXACTLY proposals-sync.js's updatableFields() output, plus the review-state columns the approve/reject PATCH writes", () => {
  const { updatableFields } = require("../agent/lib/proposals-sync");
  const sampleFinding = { category: "A", riskLevel: "low", decision: "PROPOSE_CHANGE", reason: "x", summary: "x", evidence: [], research: [] };
  const syncColumns = Object.keys(updatableFields(sampleFinding, "run-1"));
  const reviewColumns = ["status", "reviewed_by", "reviewed_at", "review_note"];

  const grantUpdateMatch = proposalsSql.match(/GRANT UPDATE \(([\s\S]*?)\) ON public\.agent_proposals/i);
  const sqlColumns = grantUpdateMatch[1].split(",").map((s) => s.trim().replace(/\n/g, "")).filter(Boolean).sort();

  const expected = [...new Set([...syncColumns, ...reviewColumns])].sort();
  assert.deepStrictEqual(sqlColumns, expected, "the SQL grant must cover exactly what the sync step's UPDATE and the approve/reject PATCH actually write — no more, no less");
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

test("both migrations' rollback sections are commented out (reference-only), never part of the executable statement", () => {
  for (const sql of [proposalsSql, howdItGoSql]) {
    const executable = stripSqlComments(sql);
    assert.ok(!/DROP TABLE IF EXISTS public\.agent_proposals/i.test(executable) || sql.includes("-- DROP TABLE IF EXISTS public.agent_proposals"));
  }
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
