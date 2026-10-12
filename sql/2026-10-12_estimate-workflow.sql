-- Estimate workflow — LEAD -> ESTIMATE SCHEDULED -> ESTIMATE COMPLETED ->
-- JOB BOOKED -> JOB COMPLETED, while keeping LEAD -> JOB direct and
-- NEW ESTIMATE -> JOB fully supported. To be run manually in the Supabase
-- SQL editor, same convention as every prior migration in this directory.
-- NOT executed by this session — drafted for Rocky's review, same posture
-- as every other not-yet-applied migration here.
--
-- Design: an Estimate is modeled as its OWN table, not a bookings.status
-- value. Reasons (see the proposal doc / final report for the full
-- writeup):
--   - Financial isolation is non-negotiable (explicit requirement). Every
--     revenue/booked counter in this codebase (admin/schedule-financials.js,
--     admin/home.js) is computed by filtering bookings.status. An estimate
--     living in a completely separate table is structurally incapable of
--     being picked up by that logic, by construction — not by a filter an
--     estimate could slip through if someone forgets to update it later.
--   - bookings.status already has a 'quoted' value and leads.status already
--     has an 'estimate_sent' value, both rendered today under the label
--     "Estimate Sent" (api/admin/bookings.js's LEADS_BUCKET_LABELS). Adding
--     estimate-lifecycle values to either of those vocabularies would
--     collide with existing, shipped meaning.
--   - An estimate's own lifecycle (Scheduled/Completed/Cancelled/Did Not
--     Book/Converted) doesn't fit bookings_status_check's CHECK constraint
--     cleanly without widening it for a kind of row that explicitly must
--     never be treated as a job everywhere else `bookings` is read.
--
-- What this migration deliberately does NOT do:
--   - It does not touch `leads.status`'s existing CHECK constraint or
--     values, and does not repurpose 'estimate_sent'.
--   - It does not touch `bookings.status`'s existing CHECK constraint or
--     values.
--   - It does not migrate any existing data.
--   - It does not implement Estimate photo/screenshot carry-forward beyond
--     an id pointer (source_intake_id) — screenshots themselves stay governed
--     by intake_sessions' own existing retention policy.

-- =======================================================================
-- 0. PREFLIGHT — run this FIRST, by itself. Read-only.
-- =======================================================================
-- select grantee, table_name, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public' and table_name = 'estimates' and grantee = 'service_role';
-- -- expect: zero rows (the table doesn't exist yet)
--
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'bookings'
--   and column_name in ('source_lead_id', 'source_estimate_id');
-- -- expect: zero rows (neither column exists yet)

-- =======================================================================
-- 1. estimates — one row per scheduled onsite estimate appointment. Never a
--    source of job/revenue data for any existing counter.
--
--    status lifecycle: scheduled -> completed -> converted
--                                 \-> cancelled    (from scheduled only)
--                       completed -> lost ("Did Not Book")
--                       {scheduled, completed} -> converted (Convert to Job)
--    Enforced at the application layer (api/admin/booking.js); the CHECK
--    below only bounds the allowed values, not the transition graph.
--
--    customer_id: required — same NOT NULL posture as bookings.customer_id.
--    An estimate always has a client by the time it's scheduled (reuses the
--    existing client lookup/creation picker, same as "+ New Job").
--
--    source_lead_id: set when this estimate was scheduled from an existing
--    Lead (Schedule Estimate action on Lead Detail). NULL for an
--    independent "+ New Estimate". Read-pointer only, same posture as
--    leads.matched_customer_id — never cascades, never deletes the lead.
--
--    source_intake_id: set only in the (currently unused by any shipped UI)
--    case an estimate is scheduled directly from a reviewed intake without
--    first confirming it as a Lead. Mirrors bookings.source_intake_id's
--    existing idempotency shape (partial unique index) for the same reason:
--    a retried "Schedule Estimate" submit must never create two estimates
--    for the same intake.
--
--    converted_booking_id: set by Convert to Job (api/admin/booking.js's
--    handleCreate(), when body.sourceEstimateId is provided) — the ONE
--    place this column is ever written. The partial unique index on
--    bookings.source_estimate_id (added in §3 below) is the actual
--    guarantee against a double-click/retry creating two jobs from the
--    same estimate; this column mirrors that same booking id back onto the
--    estimate purely for display/navigation.
--
--    quoted_amount: an optional estimated scope/quote value. Explicitly
--    informational — never read by admin/schedule-financials.js or
--    admin/home.js, and never copied into a resulting booking's
--    estimated_price automatically (the admin re-enters/confirms it on the
--    prefilled New Job form, same as every other Convert-to-Job field).
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NULL,

  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled', 'lost', 'converted')),

  customer_id uuid NOT NULL REFERENCES public.customers(id),
  source_lead_id uuid NULL REFERENCES public.leads(id),
  source_intake_id uuid NULL REFERENCES public.intake_sessions(id),

  service_type text NULL,
  appointment_date date NOT NULL,
  time_window text NULL,
  exact_time text NULL,

  service_address text NOT NULL,
  service_city text NOT NULL,
  service_state text NOT NULL,
  service_zip text NULL,

  description text NULL,
  estimate_notes text NULL,
  quoted_amount numeric NULL,

  outcome_note text NULL,
  cancelled_reason text NULL,

  converted_booking_id uuid NULL REFERENCES public.bookings(id)
);

CREATE INDEX IF NOT EXISTS estimates_status_idx ON public.estimates (status);
CREATE INDEX IF NOT EXISTS estimates_appointment_date_idx ON public.estimates (appointment_date);
CREATE INDEX IF NOT EXISTS estimates_source_lead_id_idx ON public.estimates (source_lead_id);
CREATE INDEX IF NOT EXISTS estimates_customer_id_idx ON public.estimates (customer_id);

-- One intake can never produce two estimates — same partial-unique shape as
-- leads_source_intake_id_uniq / bookings_source_intake_id_uniq.
CREATE UNIQUE INDEX IF NOT EXISTS estimates_source_intake_id_uniq ON public.estimates (source_intake_id) WHERE source_intake_id IS NOT NULL;

ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;

-- =======================================================================
-- 2. service_role grants — REVOKE-ALL-then-GRANT-exact, same deterministic
--    pattern as every table added since sql/2026-10-04_...sql. No DELETE,
--    ever: an estimate is only ever marked cancelled/lost/converted, never
--    hard-deleted.
-- =======================================================================
REVOKE ALL ON public.estimates FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.estimates TO service_role;

-- =======================================================================
-- 3. bookings.source_lead_id / bookings.source_estimate_id — the Job side of
--    the Lead -> Job (direct) and Estimate -> Job (convert) relationships.
--
--    source_lead_id: set when a job is booked directly from a Lead (Lead
--    Detail's "Book Job" action), OR copied through server-side from the
--    originating estimate's own source_lead_id when a job is created via
--    Convert to Job (api/admin/booking.js's handleCreate() derives this
--    from the estimate row itself in that case — never trusts a client-sent
--    value when sourceEstimateId is also present, so a caller cannot claim
--    a different lead than the one the estimate actually came from).
--
--    source_estimate_id + its partial unique index: the actual guarantee
--    against Convert to Job creating two bookings for the same estimate on
--    a double-click/retry — identical shape and reasoning to
--    bookings_source_intake_id_uniq (sql/2026-10-07_...sql). handleCreate()
--    gets the identical "insert; on a unique_violation against THIS
--    constraint, fetch and return the row that already exists" handling
--    that file already established.
--
--    No new GRANT needed — bookings has never used the REVOKE-ALL-then-
--    GRANT-exact convention (table-wide grants already in place since
--    Phase 1; see sql/2026-10-07_...sql's own identical note).
-- =======================================================================
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS source_lead_id uuid NULL REFERENCES public.leads(id);

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS source_estimate_id uuid NULL REFERENCES public.estimates(id);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_source_estimate_id_uniq ON public.bookings (source_estimate_id) WHERE source_estimate_id IS NOT NULL;

-- =======================================================================
-- Verification (re-run any of these any time to re-confirm current state)
-- =======================================================================
-- select column_name, data_type, is_nullable, column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'estimates'
--   order by ordinal_position;
--
-- select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'estimates';
-- select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'bookings'
--   and indexname in ('bookings_source_estimate_id_uniq');
--
-- select rolname, rolbypassrls from pg_roles where rolname = 'service_role'; -- expect true
-- select has_table_privilege('service_role', 'public.estimates', 'SELECT'); -- expect true
-- select has_table_privilege('service_role', 'public.estimates', 'INSERT'); -- expect true
-- select has_table_privilege('service_role', 'public.estimates', 'UPDATE'); -- expect true
-- select has_table_privilege('service_role', 'public.estimates', 'DELETE'); -- expect false
-- select has_column_privilege('service_role', 'public.bookings', 'source_lead_id', 'INSERT'); -- expect true, with no new grant run
-- select has_column_privilege('service_role', 'public.bookings', 'source_estimate_id', 'INSERT'); -- expect true, with no new grant run

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- ALTER TABLE public.bookings DROP COLUMN IF EXISTS source_estimate_id;
-- ALTER TABLE public.bookings DROP COLUMN IF EXISTS source_lead_id;
-- REVOKE ALL ON public.estimates FROM service_role;
-- DROP TABLE IF EXISTS public.estimates;
