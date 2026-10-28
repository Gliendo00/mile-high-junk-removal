-- Site Improvement Agent, Phase 16 — adds three new owner-decision
-- states to the EXISTING agent_proposals.status lifecycle (extends
-- sql/2026-10-12_phase3-agent-proposals.sql and sql/2026-10-21_phase14-
-- agent-proposal-execution.sql's CHECK constraint, same additive pattern
-- both of those already used — never a new table, never a new column).
--
-- Why these three and not more: the admin UI (admin/agent-proposals.js,
-- admin/website-agent.js) ships five owner actions on a proposal:
--   Approve & Execute    -> status 'approved'   (EXISTING value, unchanged)
--   Verified — No Change -> status 'no_change'  (NEW)
--   Needs Revision       -> status 'needs_revision' (NEW)
--   Recheck Later        -> status 'recheck'    (NEW)
--   Dismiss              -> status 'rejected'   (EXISTING value, reused —
--                            see below)
--
-- Dismiss deliberately REUSES 'rejected' rather than adding a fourth new
-- value: a dismissed proposal and a rejected one are the exact same
-- thing ("not useful, should be closed") the original Phase 3 'rejected'
-- value already meant — only its admin-UI label changes (from "Rejected"
-- to "Dismissed"). This is the safer-reuse path the Phase 16 spec itself
-- calls for ("if existing status constraints make a very similar
-- existing status safer to reuse, inspect that first, but keep the same
-- user-facing meaning") — it keeps every existing 'rejected' row, test,
-- and filter (RETRYABLE_STATUSES exclusion, the stale-detection
-- `stillActive` set, etc.) working unmodified, and avoids a fourth CHECK
-- value for a status that would behave identically to one that already
-- exists.
--
-- 'no_change' and 'dismissed'(~'rejected') are deliberately DISTINCT
-- values, never collapsed into one — see admin/agent-proposals.js's own
-- header: "no_change" is a reviewed, intentional, evidence-based decision
-- to leave the site as-is; "rejected" (Dismiss) is "this proposal isn't
-- useful/relevant." Collapsing them would lose exactly the distinction
-- the Site Improvement Agent's decision history is supposed to preserve.
--
-- Lifecycle note: all three new values, plus 'approved' and 'rejected',
-- are now treated by agent/lib/proposals-sync.js as "decided" states for
-- the EXISTING fingerprint-reset mechanism (see that file's own header
-- and computeReviewContentFingerprint()) — a 'no_change'/'needs_revision'/
-- 'recheck' proposal does NOT silently reset back to 'proposed' on every
-- re-sync; it only resets when the finding's content has materially
-- changed (or the finding_key reappears after a run where it didn't need
-- owner review at all). This is the existing Phase 4 hardening mechanism,
-- simply extended to the three new states — no new suppression system.

ALTER TABLE public.agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_status_check;
ALTER TABLE public.agent_proposals ADD CONSTRAINT agent_proposals_status_check
  CHECK (status IN (
    'proposed', 'approved', 'rejected', 'applied', 'validated', 'failed',
    'applying', 'validating', 'deploying', 'deployed', 'needs_review',
    'no_change', 'needs_revision', 'recheck'
  ));

-- No new/changed columns, no change to the existing column-level GRANT
-- (status is already in that list — see sql/2026-10-12_phase3-agent-
-- proposals.sql's own GRANT UPDATE) — this migration is purely a CHECK-
-- constraint widening.

-- =======================================================================
-- Verification (reference only — not executed as part of this file)
-- =======================================================================
-- insert into public.agent_proposals (finding_key, finding_type, category, decision, summary, pages)
--   values ('test::phase16.html', 'test', 'A', 'PROPOSE_CHANGE', 'test', array['phase16.html'])
--   returning status; -- expect 'proposed' (DEFAULT unaffected)
-- update public.agent_proposals set status = 'no_change' where finding_key = 'test::phase16.html'; -- expect success
-- update public.agent_proposals set status = 'needs_revision' where finding_key = 'test::phase16.html'; -- expect success
-- update public.agent_proposals set status = 'recheck' where finding_key = 'test::phase16.html'; -- expect success
-- update public.agent_proposals set status = 'bogus' where finding_key = 'test::phase16.html'; -- expect CHECK violation
-- delete from public.agent_proposals where finding_key = 'test::phase16.html'; -- cleanup

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- ALTER TABLE public.agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_status_check;
-- ALTER TABLE public.agent_proposals ADD CONSTRAINT agent_proposals_status_check
--   CHECK (status IN (
--     'proposed', 'approved', 'rejected', 'applied', 'validated', 'failed',
--     'applying', 'validating', 'deploying', 'deployed', 'needs_review'
--   ));
-- -- Note: rollback will fail with a constraint violation if any row has
-- -- already been set to 'no_change'/'needs_revision'/'recheck' — those
-- -- rows must be moved back to 'proposed' (or deleted) first.
