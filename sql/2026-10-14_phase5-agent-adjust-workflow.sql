-- Site Improvement Agent, Phase 5 — "Adjust" workflow for agent_proposals.
--
-- Scoped deliberately narrow (see agent/README.md's "Adjust workflow"
-- section for the full design discussion of what was and wasn't built
-- here, and why): this adds exactly one new reviewable state
-- ('adjust_requested') plus the two columns needed to capture WHY an
-- owner asked for a revision, reusing every piece of machinery that
-- already exists rather than inventing new architecture:
--
--   Proposed -> owner clicks Adjust, writes feedback -> 'adjust_requested'
--   (adjust_note stores the feedback; adjusted_at records when).
--
--   A proposal sitting at 'adjust_requested' is picked up OUTSIDE this
--   mechanical pipeline — by a human, or a Claude-assisted session, the
--   same way "real research" already works (see research.js's header) —
--   who writes a revised `summary`/`recommendation` and re-syncs. That
--   re-sync is NOT new code: proposals-sync.js's EXISTING "reviewed row +
--   changed summary -> reset to proposed" logic (Phase 4 hardening)
--   already does exactly this reset whenever it next runs — it just
--   previously only ever fired for 'approved'/'rejected'. This migration
--   does not change that JS logic (a proposal at 'adjust_requested' is
--   simply "not yet reviewed" from sync's point of view and is left alone
--   until a human/Claude session acts on it), which is exactly what keeps
--   this addition clean instead of requiring a parallel content-override
--   mechanism (an `override_recommendation` column, special-cased sync
--   logic to never clobber it, etc. — evaluated and deliberately NOT
--   built; see the README section referenced above).
--
--   Adjust NEVER applies a website change — it only ever writes to this
--   one table, identical in that respect to approve/reject.

ALTER TABLE public.agent_proposals
  ADD COLUMN IF NOT EXISTS adjust_note text NULL,
  ADD COLUMN IF NOT EXISTS adjusted_at timestamptz NULL;

-- Widen the status CHECK constraint to include 'adjust_requested'. Named
-- explicitly (matching Postgres's own default name for the original
-- inline CHECK, so this stays the one canonical constraint rather than
-- accumulating a second, overlapping one) and dropped-then-recreated so
-- this file is idempotent/safe to re-run.
ALTER TABLE public.agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_status_check;
ALTER TABLE public.agent_proposals ADD CONSTRAINT agent_proposals_status_check
  CHECK (status IN ('proposed', 'approved', 'rejected', 'applied', 'validated', 'failed', 'adjust_requested'));

-- Re-grant UPDATE with the widened column list — same REVOKE-first-then-
-- GRANT convention as the original migration, and the same column-level
-- scoping test (tests/agent-migrations-review.test.js) covers this file
-- too, extended to read both migrations together.
REVOKE ALL ON public.agent_proposals FROM service_role;
GRANT SELECT, INSERT ON public.agent_proposals TO service_role;
GRANT UPDATE (
  category, risk_level, decision, decision_reason, summary, evidence,
  research, status, reviewed_by, reviewed_at, review_note, adjust_note,
  adjusted_at, last_run_id, updated_at
) ON public.agent_proposals TO service_role;

-- =======================================================================
-- Verification (reference only — not executed as part of this file)
-- =======================================================================
-- select has_column_privilege('service_role', 'public.agent_proposals', 'adjust_note', 'UPDATE');  -- expect true
-- select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.agent_proposals'::regclass and contype = 'c';

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- ALTER TABLE public.agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_status_check;
-- ALTER TABLE public.agent_proposals ADD CONSTRAINT agent_proposals_status_check
--   CHECK (status IN ('proposed', 'approved', 'rejected', 'applied', 'validated', 'failed'));
-- ALTER TABLE public.agent_proposals DROP COLUMN IF EXISTS adjust_note;
-- ALTER TABLE public.agent_proposals DROP COLUMN IF EXISTS adjusted_at;
