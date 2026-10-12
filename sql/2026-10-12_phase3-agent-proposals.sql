-- Site Improvement Agent, Phase 3 — agent_proposals: the CRM-visible,
-- live-mutable counterpart to the git-tracked agent/history/log.ndjson.
--
-- Why a new table, not just the log file: a deployed Vercel function's
-- filesystem is read-only (only /tmp is writable, and that's ephemeral
-- per invocation) — the log file can be bundled into a deployment and
-- READ at runtime (see vercel.json's includeFiles for
-- api/admin/bookings.js), but an owner clicking Approve/Reject in the CRM
-- needs something a live request can actually WRITE and have persist.
-- That's exactly what every other piece of mutable CRM state in this
-- project already uses Supabase for — this is the same architecture,
-- not a new one.
--
-- This table is synced TO by agent/lib/proposals-sync.js (optional —
-- gracefully no-ops when SUPABASE_URL/SUPABASE_SECRET_KEY aren't
-- configured, exactly like every other optional Supabase write path in
-- this codebase's api/_lib/supabase-admin.js convention) after a run that
-- produced at least one finding needing owner attention (decision
-- PROPOSE_CHANGE or REJECT_OPPORTUNITY with requiresApproval — see
-- decision.js). It is read/written FROM by api/admin/bookings.js's
-- ?view=agent-proposals (list) and ?resource=agent-proposal PATCH
-- (approve/reject) — no new Vercel function, same file that already
-- hosts ?view=agent-activity.
--
-- One row per Finding.key (findings.js's stable, content-derived key) —
-- re-syncing an already-reviewed proposal updates its content (summary,
-- evidence, decision) but never silently resets an owner's prior
-- approve/reject decision back to 'proposed'. See proposals-sync.js's
-- own header for the exact upsert rule.

CREATE TABLE IF NOT EXISTS public.agent_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- findings.js's stable key (type::sorted-pages) — the join key back to
  -- whatever run most recently produced/updated this exact observation.
  -- NOT the per-run `id` (a plain counter, meaningless across runs).
  finding_key text NOT NULL UNIQUE,
  finding_type text NOT NULL,
  category text NOT NULL CHECK (category IN ('A', 'B', 'C', 'D', 'E')),
  risk_level text NULL,
  -- The decision the agent reached THE LAST TIME this finding was synced
  -- — not necessarily the owner's final word; see `status` below for that.
  decision text NOT NULL CHECK (decision IN ('APPLY_SAFE_FIX', 'PROPOSE_CHANGE', 'RESEARCH_MORE', 'NO_CHANGE', 'REJECT_OPPORTUNITY')),
  decision_reason text NULL,
  summary text NOT NULL,
  pages text[] NOT NULL,
  -- Internal evidence (finding.evidence) and any attached external
  -- research (finding.research), kept as the agent produced them —
  -- never raw HTML, never anything from outside this agent's own schema.
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  research jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The actual approval-state machine. 'proposed' is the only state the
  -- sync step itself ever sets on a NEW row; every other transition is
  -- an explicit owner action via the PATCH endpoint (or, for 'applied'/
  -- 'validated'/'failed', the existing Phase 1/2 auto-apply+validate
  -- loop for the narrow mechanical-fix whitelist only — see
  -- agent/lib/validate.js). Approving a proposal does NOT grant the
  -- agent authority over anything beyond this one specific finding_key.
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'applied', 'validated', 'failed')),
  reviewed_by text NULL,
  reviewed_at timestamptz NULL,
  review_note text NULL,
  last_run_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_proposals_status_idx ON public.agent_proposals (status);

ALTER TABLE public.agent_proposals ENABLE ROW LEVEL SECURITY;

-- A newly created table has NO privileges granted to service_role by
-- default in this project (confirmed, twice, in prior stages' own
-- rollouts) — REVOKE-first for a deterministic end state regardless of
-- whatever (if anything) already exists, same convention as every other
-- brand-new table this project has added. UPDATE is scoped to exactly
-- the columns an approve/reject action (or the auto-apply/validate loop)
-- can ever touch — never finding_key/finding_type/category/pages/
-- evidence/research/created_at, which only the sync step (itself a
-- full-row upsert, i.e. INSERT or a complete replacement) ever writes.
REVOKE ALL ON public.agent_proposals FROM service_role;
GRANT SELECT, INSERT ON public.agent_proposals TO service_role;
GRANT UPDATE (
  decision, decision_reason, summary, evidence, research, risk_level,
  status, reviewed_by, reviewed_at, review_note, last_run_id, updated_at
) ON public.agent_proposals TO service_role;

-- =======================================================================
-- Verification (reference only — not executed as part of this file)
-- =======================================================================
-- select has_table_privilege('service_role', 'public.agent_proposals', 'SELECT');  -- expect true
-- select has_table_privilege('service_role', 'public.agent_proposals', 'INSERT');  -- expect true
-- select has_table_privilege('service_role', 'public.agent_proposals', 'DELETE');  -- expect false
-- select has_column_privilege('service_role', 'public.agent_proposals', 'status', 'UPDATE');       -- expect true
-- select has_column_privilege('service_role', 'public.agent_proposals', 'finding_key', 'UPDATE');  -- expect false

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- REVOKE ALL ON public.agent_proposals FROM service_role;
-- DROP TABLE IF EXISTS public.agent_proposals;
