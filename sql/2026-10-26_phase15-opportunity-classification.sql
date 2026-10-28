-- Site Improvement Agent, Phase 15 — opportunity research/classification
-- and the Claude handoff report. Extends the EXISTING agent_proposals
-- table (sql/2026-10-12_phase3-agent-proposals.sql,
-- sql/2026-10-21_phase14-agent-proposal-execution.sql) rather than
-- creating a second, parallel one — same convention Phase 14 followed.
--
-- Context: the new default Agent workflow is DISCOVER -> RESEARCH
-- (for AND against) -> CLASSIFY IMPORTANCE -> propose only when
-- justified -> generate a copy-ready Claude handoff report. A proposal
-- now only reaches `agent_proposals` at all once
-- agent/lib/opportunity-classification.js has classified it IMPORTANT
-- (see agent/lib/proposals-sync.js's new needsProposal() gate —
-- needsOwnerReview() itself is unchanged) — these two columns are where
-- that classification record and its generated handoff report live.
--
-- Two additive, nullable columns — existing rows get NULL for both
-- (older proposals that predate this workflow stay readable as
-- "legacy": no classification, no handoff report, Approve/Reject/
-- Execute all keep working exactly as before):
--
--   - `opportunity_classification` (jsonb, nullable) — the full
--     classification record agent/lib/opportunity-classification.js
--     produced for the finding that became this proposal: {classification
--     (IMPORTANT, since only IMPORTANT findings ever sync — see
--     proposals-sync.js), evidenceConfidence, reason, evidenceFor,
--     evidenceAgainst, risks, protectedSignals, missingEvidence,
--     fingerprint, researchedAt}. WATCH/LOW_SUPPRESS/PROTECT
--     classifications never reach this table at all — those are
--     log-only, recorded in agent/history/log.ndjson (see
--     agent/lib/history.js's latestClassificationByKey()), not here.
--   - `claude_handoff_report` (text, nullable) — the pre-rendered,
--     copy-ready markdown report (agent/lib/claude-handoff-report.js),
--     generated once at proposal-sync time so the admin UI's "Copy
--     Claude Report" button never has to recompute it. NULL whenever
--     `opportunity_classification` is NULL (legacy proposals) or
--     generation is not yet wired for a given finding family.

ALTER TABLE public.agent_proposals ADD COLUMN IF NOT EXISTS opportunity_classification jsonb NULL DEFAULT NULL;
ALTER TABLE public.agent_proposals ADD COLUMN IF NOT EXISTS claude_handoff_report text NULL DEFAULT NULL;

-- service_role already has UPDATE on a fixed column list (phase3's
-- REVOKE-ALL-then-GRANT-specific-columns pattern, re-issued by phase14
-- with two more columns) — re-issue that exact list again, PLUS these
-- two new columns, same idempotent re-issue pattern phase14 used (there
-- is no "ALTER ... ADD COLUMN to an existing column-level GRANT" in
-- Postgres).
GRANT UPDATE (
  category, risk_level, decision, decision_reason, summary, evidence,
  research, status, reviewed_by, reviewed_at, review_note, last_run_id,
  updated_at, proposed_fix, execution, opportunity_classification,
  claude_handoff_report
) ON public.agent_proposals TO service_role;

-- =======================================================================
-- Verification (reference only — not executed as part of this file)
-- =======================================================================
-- select has_column_privilege('service_role', 'public.agent_proposals', 'opportunity_classification', 'UPDATE'); -- expect true
-- select has_column_privilege('service_role', 'public.agent_proposals', 'claude_handoff_report', 'UPDATE');       -- expect true
-- insert into public.agent_proposals (finding_key, finding_type, category, decision, summary, pages)
--   values ('test::x.html', 'test', 'A', 'PROPOSE_CHANGE', 'test', array['x.html'])
--   returning opportunity_classification, claude_handoff_report; -- expect both NULL (DEFAULT unaffected)
-- delete from public.agent_proposals where finding_key = 'test::x.html'; -- cleanup

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- ALTER TABLE public.agent_proposals DROP COLUMN IF EXISTS opportunity_classification;
-- ALTER TABLE public.agent_proposals DROP COLUMN IF EXISTS claude_handoff_report;
-- GRANT UPDATE (
--   category, risk_level, decision, decision_reason, summary, evidence,
--   research, status, reviewed_by, reviewed_at, review_note, last_run_id,
--   updated_at, proposed_fix, execution
-- ) ON public.agent_proposals TO service_role;
