-- Site Improvement Agent, Phase 14 — wires the Approved / Pending
-- Execution queue into a real execution pipeline. Extends the EXISTING
-- agent_proposals table (sql/2026-10-12_phase3-agent-proposals.sql)
-- rather than creating a second, parallel one.
--
-- Two additive changes:
--
-- 1. `status` CHECK constraint gains five new values covering the
--    execution lifecycle requested for the dashboard: 'applying',
--    'validating', 'deploying', 'deployed', 'needs_review'. 'approved'
--    itself IS "Approved / Pending Execution" (no separate value needed
--    — that's just a UI label for "approved, execution not started
--    yet"). The existing 'applied'/'validated'/'failed' values are left
--    exactly as they were (never written by any code path today — see
--    that migration's own header — so they're harmless to leave in
--    place; removing them would be an unrelated cleanup this phase
--    doesn't need to make). 'failed' IS reused by the new execution
--    engine (agent/lib/execute-proposal.js) for an execution that ran
--    and did not succeed.
--
-- 2. Two new nullable/defaulted columns:
--    - `proposed_fix` (jsonb, nullable) — the deterministic, mechanical
--      change description (same {kind, file, from, to} shape findings
--      already carry as `.autoFix` — see agent/lib/findings.js) that
--      agent/lib/proposals-sync.js now also copies onto the proposal
--      row whenever the finding happens to have one. NULL for every
--      current real finding type (PROPOSE_CHANGE findings today never
--      have `autoFix` set — see agent/lib/decision.js: any finding with
--      autoFix AND low risk AND actionable tier is auto-applied
--      instead, never reaching this table) — this column exists so the
--      execution engine has something concrete to act on WHEN a finding
--      does carry one (e.g. a higher-risk/non-auto-apply-eligible
--      mechanical rewrite), rather than ever guessing what "the
--      approved change" was from prose alone.
--    - `execution` (jsonb, NOT NULL, default '{}') — the structured
--      record of what the execution engine actually did: requestedAt/
--      requestedBy, startedAt/finishedAt, commitSha, filesChanged,
--      validation result, test result, failureReason. Never raw HTML,
--      never a credential — see execute-proposal.js's own header for
--      the exact shape.
--
-- Nothing here changes what Approve/Reject do (still exactly: record a
-- decision). Execution is a distinct, explicit, separately-gated action
-- — see api/admin/bookings.js's resource:"agent-proposal" action:"execute"
-- and .github/workflows/execute-proposal.yml.

ALTER TABLE public.agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_status_check;
ALTER TABLE public.agent_proposals ADD CONSTRAINT agent_proposals_status_check
  CHECK (status IN (
    'proposed', 'approved', 'rejected', 'applied', 'validated', 'failed',
    'applying', 'validating', 'deploying', 'deployed', 'needs_review'
  ));

ALTER TABLE public.agent_proposals ADD COLUMN IF NOT EXISTS proposed_fix jsonb NULL DEFAULT NULL;
ALTER TABLE public.agent_proposals ADD COLUMN IF NOT EXISTS execution jsonb NOT NULL DEFAULT '{}'::jsonb;

-- service_role already has UPDATE on a fixed column list (see the
-- original migration's own REVOKE-ALL-then-GRANT-specific-columns
-- pattern) — re-grant that exact list PLUS the two new columns, rather
-- than ALTER-ing the existing grant (Postgres has no "ALTER ... ADD
-- COLUMN to an existing column-level GRANT" — a column-level GRANT is
-- just re-issued with the full desired list, which is idempotent).
GRANT UPDATE (
  category, risk_level, decision, decision_reason, summary, evidence,
  research, status, reviewed_by, reviewed_at, review_note, last_run_id,
  updated_at, proposed_fix, execution
) ON public.agent_proposals TO service_role;

-- =======================================================================
-- Verification (reference only — not executed as part of this file)
-- =======================================================================
-- select has_column_privilege('service_role', 'public.agent_proposals', 'proposed_fix', 'UPDATE'); -- expect true
-- select has_column_privilege('service_role', 'public.agent_proposals', 'execution', 'UPDATE');     -- expect true
-- insert into public.agent_proposals (finding_key, finding_type, category, decision, summary, pages)
--   values ('test::x.html', 'test', 'A', 'PROPOSE_CHANGE', 'test', array['x.html'])
--   returning status; -- expect 'proposed' (DEFAULT unaffected)
-- update public.agent_proposals set status = 'applying' where finding_key = 'test::x.html'; -- expect success
-- update public.agent_proposals set status = 'bogus' where finding_key = 'test::x.html'; -- expect CHECK violation
-- delete from public.agent_proposals where finding_key = 'test::x.html'; -- cleanup

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- ALTER TABLE public.agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_status_check;
-- ALTER TABLE public.agent_proposals ADD CONSTRAINT agent_proposals_status_check
--   CHECK (status IN ('proposed', 'approved', 'rejected', 'applied', 'validated', 'failed'));
-- ALTER TABLE public.agent_proposals DROP COLUMN IF EXISTS proposed_fix;
-- ALTER TABLE public.agent_proposals DROP COLUMN IF EXISTS execution;
-- GRANT UPDATE (
--   category, risk_level, decision, decision_reason, summary, evidence,
--   research, status, reviewed_by, reviewed_at, review_note, last_run_id,
--   updated_at
-- ) ON public.agent_proposals TO service_role;
