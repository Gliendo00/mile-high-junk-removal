-- Phase 3C Batch 5 (5B) — Screenshot AI Intake: intake_sessions +
-- intake_screenshots. To be run manually in the Supabase SQL editor, same
-- convention as every prior migration in this directory. NOT executed by
-- this session — drafted for Rocky's review alongside
-- docs/phase-3/batch5-screenshot-intake-proposal.md.
--
-- Full design writeup: docs/phase-3/batch5-screenshot-intake-proposal.md §4.
--
-- Adds, and nothing else:
--   1. intake_sessions — new table. One row per upload session (one or more
--      screenshots from the same client conversation). Tracks extraction
--      results, classification, client-match state, and (reserved, UNUSED
--      until Stage 5D) the eventual confirm outcome.
--   2. intake_screenshots — new table. One row per uploaded screenshot
--      image, FK'd to its session.
--   3. service_role grants for both — a newly created table has NO
--      privileges granted to service_role by default in this project
--      (confirmed repeatedly — see
--      sql/2026-09-19_phase3c-stage3-service-role-grants.sql's header).
--
-- Nothing in this file touches bookings, customers, dumpster_rentals,
-- job_payments, expenses, or any existing table — intake_sessions only
-- REFERENCES customers(id)/bookings(id), it never writes to them. No
-- customer/booking row is created or modified by anything this migration
-- enables; that write capability does not exist in the application yet
-- (Stage 5D, not built).
--
-- gen_random_uuid() is core PostgreSQL (13+) — no extension required.

-- =======================================================================
-- 0. PREFLIGHT — run this FIRST, by itself. Read-only. Confirms
--    service_role's baseline posture (same check every prior stage's
--    migration has run) before this file's own grants section assumes
--    nothing pre-exists for these two brand-new tables.
-- =======================================================================
-- select grantee, table_name, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in ('intake_sessions', 'intake_screenshots')
--   and grantee = 'service_role';
-- -- expect: zero rows (the tables don't exist yet) — confirms there is
-- -- nothing to REVOKE before this file's GRANT statements in §3.

-- =======================================================================
-- 1. intake_sessions — one row per upload session.
--
--    Lifecycle: processing (screenshots uploaded, extraction not yet run
--    or in flight) -> pending_review (extraction succeeded, awaiting admin
--    review) -> confirmed | discarded. extraction_failed is a dead end the
--    admin can only discard from (no retry-in-place in this stage — the
--    admin re-uploads as a new session; see proposal §5, action=extract).
--
--    ai_raw_extraction vs extracted_data: ai_raw_extraction is an immutable
--    snapshot of exactly what api/_lib/intake-vision-provider.js returned
--    the one time extraction ran — never written to again, kept for
--    debugging/audit ("what did the model actually say"). extracted_data
--    starts as a copy of it and is what PATCH ?action=update/reclassify
--    actually mutates — so an admin correction is always visible as a
--    correction (ai_raw_extraction still shows the original), never an
--    invisible overwrite of the only copy. Both are jsonb holding the
--    adapter's { fields, classification, classificationConfidence,
--    conflicts } shape (see api/_lib/intake-vision-provider.js) — kept
--    opaque at the database level deliberately (see
--    api/_lib/intake-vision-provider.js's own header: this is the only
--    module allowed to define that shape), never queried into with jsonb
--    operators from outside api/admin/intake.js.
--
--    classification/classification_confidence/match_status are pulled out
--    as real columns (denormalized from extracted_data at extraction time)
--    purely so the Pending Intake list/filter queries don't need to reach
--    into jsonb — not a second source of truth; intake.js always keeps
--    them in sync with extracted_data.classification/
--    extracted_data.classificationConfidence.
--
--    resulting_customer_id/resulting_booking_id/confirmed_at/confirmed_by
--    are RESERVED for Stage 5D (the confirm action) — present now so 5D
--    needs no further ALTER TABLE, but no application code in this stage
--    writes them (see §3's grant list, which deliberately excludes them).
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.intake_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'pending_review', 'confirmed', 'discarded', 'extraction_failed')),

  ai_raw_extraction jsonb NULL,
  extracted_data jsonb NULL,
  extraction_error text NULL,

  classification text NULL
    CHECK (classification IS NULL OR classification IN ('lead_only', 'quote_discussion', 'booking_confirmed', 'follow_up', 'existing_job_update', 'unclear')),
  classification_confidence text NULL
    CHECK (classification_confidence IS NULL OR classification_confidence IN ('confirmed', 'likely', 'uncertain')),

  match_status text NULL
    CHECK (match_status IS NULL OR match_status IN ('existing_exact', 'new_candidate', 'needs_confirmation')),
  matched_customer_id uuid NULL REFERENCES public.customers(id),
  extracted_phone_normalized text NULL,

  linked_existing_booking_id uuid NULL REFERENCES public.bookings(id),

  -- Reserved for Stage 5D. NULL/unused until that stage; not written by
  -- any code shipped in Batch 5 (5B/5C).
  confirmed_at timestamptz NULL,
  confirmed_by text NULL,
  resulting_customer_id uuid NULL REFERENCES public.customers(id),
  resulting_booking_id uuid NULL REFERENCES public.bookings(id)
);

CREATE INDEX IF NOT EXISTS intake_sessions_status_idx ON public.intake_sessions (status);
CREATE INDEX IF NOT EXISTS intake_sessions_created_at_idx ON public.intake_sessions (created_at);

ALTER TABLE public.intake_sessions ENABLE ROW LEVEL SECURITY;

-- =======================================================================
-- 2. intake_screenshots — one row per uploaded screenshot image.
--
--    ON DELETE CASCADE (unlike booking_audit_log/customer_audit_log's
--    deliberate ON DELETE SET NULL): an intake session is pre-confirmation
--    draft/review data, not a financial or business record that must
--    survive its parent's removal — there is nothing to "audit" about a
--    screenshot once its session is gone. This mirrors
--    booking_photos.booking_id's existing ON DELETE CASCADE (confirmed in
--    docs/phase-3/database-schema-updates.md) rather than the audit-log
--    tables' SET NULL pattern.
--
--    No UPDATE grant in §3 below — screenshots are immutable once
--    uploaded. "Remove a screenshot" (proposal §5, PATCH
--    ?action=remove-screenshot) is a real DELETE of its row (plus the
--    Storage object), not a soft-delete/status flag, since a still-pending
--    intake's screenshot list is draft state with no audit requirement —
--    same reasoning as the CASCADE above.
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.intake_screenshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_session_id uuid NOT NULL REFERENCES public.intake_sessions(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  -- One of the three types api/admin/intake.js's upload handler verifies by
  -- magic bytes (image/jpeg, image/png, image/webp) — stored explicitly
  -- rather than re-derived from storage_path's file extension, so the
  -- extraction step (which must pass an exact mime type to the vision
  -- adapter) never depends on string-parsing a file path.
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  sort_order int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intake_screenshots_session_idx ON public.intake_screenshots (intake_session_id);

ALTER TABLE public.intake_screenshots ENABLE ROW LEVEL SECURITY;

-- =======================================================================
-- 3. service_role grants — REVOKE-ALL-then-GRANT-exact, same deterministic
--    pattern as sql/2026-09-19_phase3c-stage3-service-role-grants.sql
--    (narrow, explicit, idempotent; never assumes a prior/default grant).
--
--    intake_sessions: SELECT/INSERT (full row), UPDATE only on the columns
--    api/admin/intake.js actually writes in THIS stage. Deliberately
--    EXCLUDES confirmed_at/confirmed_by/resulting_customer_id/
--    resulting_booking_id from the UPDATE column list — Stage 5D must add
--    its own explicit GRANT UPDATE for those when it actually needs them,
--    exactly like job_payments'/expenses' void-only UPDATE grants already
--    do for their own stage-gated columns. No DELETE, ever: a session is
--    only ever marked 'discarded', never hard-deleted (consistent with
--    this project's existing archive-not-delete posture for bookings/
--    customers).
--
--    intake_screenshots: SELECT/INSERT/DELETE (remove-screenshot is a real
--    row delete — see §2). No UPDATE: screenshot rows are write-once.
-- =======================================================================
REVOKE ALL ON public.intake_sessions FROM service_role;
GRANT SELECT, INSERT ON public.intake_sessions TO service_role;
GRANT UPDATE (
  updated_at, status, ai_raw_extraction, extracted_data, extraction_error,
  classification, classification_confidence, match_status,
  matched_customer_id, extracted_phone_normalized, linked_existing_booking_id
) ON public.intake_sessions TO service_role;

REVOKE ALL ON public.intake_screenshots FROM service_role;
GRANT SELECT, INSERT, DELETE ON public.intake_screenshots TO service_role;

-- =======================================================================
-- Verification (re-run any of these any time to re-confirm current state)
-- =======================================================================
-- select column_name, data_type, is_nullable, column_default from information_schema.columns
--   where table_schema = 'public' and table_name in ('intake_sessions', 'intake_screenshots')
--   order by table_name, ordinal_position;
--
-- select conname, contype, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid in ('public.intake_sessions'::regclass, 'public.intake_screenshots'::regclass);
--
-- -- DECISIVE RLS check (service_role must have BYPASSRLS — same posture
-- -- confirmed live for every other RLS-enabled, zero-policy table in this
-- -- project; see sql/2026-09-26_phase3c-stage5-archive-review-rental-client.sql's
-- -- equivalent verification block):
-- select rolname, rolbypassrls from pg_roles where rolname = 'service_role';  -- expect true
--
-- select has_table_privilege('service_role', 'public.intake_sessions', 'SELECT');  -- expect true
-- select has_table_privilege('service_role', 'public.intake_sessions', 'INSERT');  -- expect true
-- select has_table_privilege('service_role', 'public.intake_sessions', 'DELETE');  -- expect false
-- select has_column_privilege('service_role', 'public.intake_sessions', 'status', 'UPDATE');              -- expect true
-- select has_column_privilege('service_role', 'public.intake_sessions', 'extracted_data', 'UPDATE');      -- expect true
-- select has_column_privilege('service_role', 'public.intake_sessions', 'confirmed_at', 'UPDATE');        -- expect FALSE (Stage 5D only)
-- select has_column_privilege('service_role', 'public.intake_sessions', 'resulting_booking_id', 'UPDATE'); -- expect FALSE (Stage 5D only)
--
-- select has_table_privilege('service_role', 'public.intake_screenshots', 'SELECT');  -- expect true
-- select has_table_privilege('service_role', 'public.intake_screenshots', 'INSERT');  -- expect true
-- select has_table_privilege('service_role', 'public.intake_screenshots', 'DELETE');  -- expect true
-- select has_table_privilege('service_role', 'public.intake_screenshots', 'UPDATE');  -- expect false

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- REVOKE ALL ON public.intake_screenshots FROM service_role;
-- DROP TABLE IF EXISTS public.intake_screenshots;
-- REVOKE ALL ON public.intake_sessions FROM service_role;
-- DROP TABLE IF EXISTS public.intake_sessions;
