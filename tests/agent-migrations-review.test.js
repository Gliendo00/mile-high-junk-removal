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
// Phase 14 (execution pipeline) — additive migration that DROPs and
// recreates agent_proposals' `status` CHECK constraint (superset of the
// original) and re-issues GRANT UPDATE with two new columns
// (proposed_fix, execution) added to the original column list. This is
// now the AUTHORITATIVE/current source for both the status enum and the
// grant column list — see the two tests below that read this file
// instead of the original phase3 migration for exactly that reason.
const phase14Sql = fs.readFileSync(
  path.join(__dirname, "..", "sql", "2026-10-21_phase14-agent-proposal-execution.sql"),
  "utf8"
);
// Phase 15 (opportunity research/classification + Claude handoff report)
// — another additive migration, re-issuing GRANT UPDATE with two more
// columns (opportunity_classification, claude_handoff_report) added to
// phase14's list. Now the AUTHORITATIVE/current source for the grant
// column list — same "superseded by" pattern phase14 already
// established over phase3 (see that test's own comment below).
const phase15Sql = fs.readFileSync(
  path.join(__dirname, "..", "sql", "2026-10-26_phase15-opportunity-classification.sql"),
  "utf8"
);
// Phase 16 (proposal decision states: no_change/needs_revision/recheck) —
// another additive migration, this time widening the `status` CHECK
// constraint only (no new columns, so the grant-column-list tests below
// still read phase15Sql for that). Now the AUTHORITATIVE/current source
// for the status enum specifically — same "superseded by" pattern
// phase14 established over phase3's own status list.
const phase16Sql = fs.readFileSync(
  path.join(__dirname, "..", "sql", "2026-10-28_phase16-proposal-decision-states.sql"),
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

test("agent_proposals.sql (as superseded by phase16): status CHECK constraint matches exactly api/admin/bookings.js's AGENT_PROPOSAL_STATUSES list", () => {
  // Phase 16's migration DROPs and recreates this constraint with a
  // superset of values (see that file's own header) — it is now the
  // authoritative current constraint, not phase14's.
  const sqlStatuses = extractCheckInList(phase16Sql, "status").sort();
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

test("agent_proposals.sql (as superseded by phase15): the GRANT UPDATE column list matches EXACTLY proposals-sync.js's updatableFields() output, plus the review-state columns the approve/reject PATCH writes", () => {
  const { updatableFields } = require("../agent/lib/proposals-sync");
  const sampleFinding = { category: "A", riskLevel: "low", decision: "PROPOSE_CHANGE", reason: "x", summary: "x", evidence: [], research: [] };
  const syncColumns = Object.keys(updatableFields(sampleFinding, "run-1"));
  const reviewColumns = ["status", "reviewed_by", "reviewed_at", "review_note"];
  // Phase 14 — `execution` is written only by the execution engine
  // (agent/lib/execute-proposal.js), a third writer alongside sync and
  // the approve/reject PATCH, so it's not produced by either of the
  // two lists above.
  const executionColumns = ["execution"];

  // Phase 15's migration re-issues this GRANT with the full current
  // column list (phase3 + phase14 + opportunity_classification/
  // claude_handoff_report) — read THAT file, not phase14's, as the
  // authoritative current grant (see this file's phase15Sql comment
  // above).
  const grantUpdateMatch = phase15Sql.match(/GRANT UPDATE \(([\s\S]*?)\) ON public\.agent_proposals/i);
  assert.ok(grantUpdateMatch, "expected a GRANT UPDATE (...) ON public.agent_proposals statement in the phase15 migration");
  const sqlColumns = grantUpdateMatch[1].split(",").map((s) => s.trim().replace(/\n/g, "")).filter(Boolean).sort();

  const expected = [...new Set([...syncColumns, ...reviewColumns, ...executionColumns])].sort();
  assert.deepStrictEqual(sqlColumns, expected, "the SQL grant must cover exactly what the sync step's UPDATE and the approve/reject PATCH actually write — no more, no less");
});

test("phase15 migration: additive/idempotent only (ADD COLUMN IF NOT EXISTS, never DROP TABLE/TRUNCATE/DELETE/DROP COLUMN)", () => {
  const executable = stripSqlComments(phase15Sql);
  assert.ok(!/\bDROP\s+TABLE\b/i.test(executable));
  assert.ok(!/\bTRUNCATE\b/i.test(executable));
  assert.ok(!/\bDELETE\s+FROM\b/i.test(executable));
  assert.ok(!/\bDROP\s+COLUMN\b/i.test(executable));
  assert.ok(/ADD COLUMN IF NOT EXISTS opportunity_classification jsonb NULL/i.test(phase15Sql));
  assert.ok(/ADD COLUMN IF NOT EXISTS claude_handoff_report text NULL/i.test(phase15Sql));
});

test("phase15 migration: its re-issued GRANT UPDATE still excludes identity columns (finding_key/finding_type/pages/created_at/id)", () => {
  const grantUpdateMatch = phase15Sql.match(/GRANT UPDATE \(([\s\S]*?)\) ON public\.agent_proposals/i);
  assert.ok(grantUpdateMatch);
  const updatableColumns = grantUpdateMatch[1].split(",").map((s) => s.trim().replace(/\n/g, "")).filter(Boolean);
  for (const protectedCol of ["finding_key", "finding_type", "pages", "created_at", "id"]) {
    assert.ok(!updatableColumns.includes(protectedCol), `${protectedCol} must never be in the UPDATE grant's column list`);
  }
});

test("phase15 migration: rollback section is commented out (reference-only), never part of the executable statement", () => {
  const executable = stripSqlComments(phase15Sql);
  assert.ok(!/DROP COLUMN IF EXISTS opportunity_classification/i.test(executable) || phase15Sql.includes("-- ALTER TABLE public.agent_proposals DROP COLUMN IF EXISTS opportunity_classification;"));
});

test("phase16 migration: additive/idempotent only (DROP CONSTRAINT IF EXISTS before recreating it, no new columns — never DROP TABLE/TRUNCATE/DELETE/DROP COLUMN)", () => {
  const executable = stripSqlComments(phase16Sql);
  assert.ok(!/\bDROP\s+TABLE\b/i.test(executable));
  assert.ok(!/\bTRUNCATE\b/i.test(executable));
  assert.ok(!/\bDELETE\s+FROM\b/i.test(executable));
  assert.ok(!/\bDROP\s+COLUMN\b/i.test(executable));
  assert.ok(/DROP CONSTRAINT IF EXISTS agent_proposals_status_check/i.test(phase16Sql), "the status CHECK constraint must be dropped-if-exists before being recreated, so this migration is safe to re-run");
});

test("phase16 migration: the widened status CHECK constraint is a strict SUPERSET of phase14's (nothing removed, three values added)", () => {
  const phase14Statuses = extractCheckInList(phase14Sql, "status");
  const phase16Statuses = extractCheckInList(phase16Sql, "status");
  for (const s of phase14Statuses) {
    assert.ok(phase16Statuses.includes(s), `phase16 must not drop existing status value '${s}'`);
  }
  assert.deepStrictEqual(
    [...phase16Statuses].sort(),
    [...new Set([...phase14Statuses, "no_change", "needs_revision", "recheck"])].sort()
  );
});

test("phase16 migration: rollback section is commented out (reference-only), never part of the executable statement", () => {
  const executable = stripSqlComments(phase16Sql);
  assert.ok(!/ADD CONSTRAINT agent_proposals_status_check\s*\n\s*CHECK \(status IN \(\s*\n\s*'proposed', 'approved', 'rejected', 'applied', 'validated', 'failed',\s*\n\s*'applying', 'validating', 'deploying', 'deployed', 'needs_review'\s*\n\s*\)\);/i.test(executable), "the OLD (pre-phase16) constraint definition must only appear in the commented-out rollback section");
});

test("phase14 migration: additive/idempotent only (ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before recreating it — never DROP TABLE/TRUNCATE/DELETE)", () => {
  const executable = stripSqlComments(phase14Sql);
  assert.ok(!/\bDROP\s+TABLE\b/i.test(executable));
  assert.ok(!/\bTRUNCATE\b/i.test(executable));
  assert.ok(!/\bDELETE\s+FROM\b/i.test(executable));
  assert.ok(!/\bDROP\s+COLUMN\b/i.test(executable));
  assert.ok(/ADD COLUMN IF NOT EXISTS proposed_fix jsonb NULL/i.test(phase14Sql));
  assert.ok(/ADD COLUMN IF NOT EXISTS execution jsonb NOT NULL DEFAULT '\{\}'::jsonb/i.test(phase14Sql));
  assert.ok(/DROP CONSTRAINT IF EXISTS agent_proposals_status_check/i.test(phase14Sql), "the status CHECK constraint must be dropped-if-exists before being recreated, so this migration is safe to re-run");
});

test("phase14 migration: its re-issued GRANT UPDATE still excludes identity columns (finding_key/finding_type/pages/created_at/id)", () => {
  const grantUpdateMatch = phase14Sql.match(/GRANT UPDATE \(([\s\S]*?)\) ON public\.agent_proposals/i);
  assert.ok(grantUpdateMatch);
  const updatableColumns = grantUpdateMatch[1].split(",").map((s) => s.trim().replace(/\n/g, "")).filter(Boolean);
  for (const protectedCol of ["finding_key", "finding_type", "pages", "created_at", "id"]) {
    assert.ok(!updatableColumns.includes(protectedCol), `${protectedCol} must never be in the UPDATE grant's column list`);
  }
});

test("phase14 migration: rollback section is commented out (reference-only), never part of the executable statement", () => {
  const executable = stripSqlComments(phase14Sql);
  assert.ok(!/DROP COLUMN IF EXISTS proposed_fix/i.test(executable) || phase14Sql.includes("-- ALTER TABLE public.agent_proposals DROP COLUMN IF EXISTS proposed_fix;"));
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
