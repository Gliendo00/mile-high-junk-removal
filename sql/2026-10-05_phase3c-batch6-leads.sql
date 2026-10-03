-- Phase 3C Batch 6 — Leads workspace: new `leads` table. To be run manually
-- in the Supabase SQL editor, same convention as every prior migration in
-- this directory. NOT executed by this session — drafted for Rocky's
-- review, same posture as sql/2026-10-04_phase3c-batch5-intake-sessions.sql
-- before it was approved.
--
-- Scope: one new table, and nothing else. See the Leads architecture
-- proposal (this session's chat history — not yet a committed doc file) for
-- the full design and why a new table was chosen over either (a) folding
-- website leads into this table too, or (b) reusing `customers`/`bookings`
-- directly.
--
-- What this migration deliberately does NOT do:
--   - It does not touch `customers`, `bookings`, `intake_sessions`, or any
--     other existing table. `leads` only ever REFERENCES customers(id) and
--     bookings(id) — read-pointers only, mirroring intake_sessions'
--     existing matched_customer_id/linked_existing_booking_id design.
--   - It does not migrate any existing data. Every website-origin lead
--     (public /book/ submission, status NULL/contacted/quoted/lost on
--     `bookings`) stays exactly where it is, written exactly how it is
--     today — see api/book.js, completely untouched by this batch. This
--     table is the destination for screenshot-intake-confirmed leads and
--     manual/phone-in leads ONLY; website submissions are never written
--     here, only read alongside this table at display time (see
--     api/admin/bookings.js's ?view=leads, added in this same batch).
--   - It does not implement Lead -> Booking conversion. resulting_booking_id
--     is reserved (present now so that stage needs no further ALTER TABLE)
--     but nothing in this batch writes it — same "reserved, unused" pattern
--     intake_sessions.confirmed_at/resulting_customer_id/resulting_booking_id
--     already established for Stage 5D.
--
-- gen_random_uuid() is core PostgreSQL (13+) — no extension required.

-- =======================================================================
-- 0. PREFLIGHT — run this FIRST, by itself. Read-only. Confirms
--    service_role's baseline posture (same check every prior stage's
--    migration has run) before this file's own grants section assumes
--    nothing pre-exists for this brand-new table.
-- =======================================================================
-- select grantee, table_name, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name = 'leads'
--   and grantee = 'service_role';
-- -- expect: zero rows (the table doesn't exist yet) — confirms there is
-- -- nothing to REVOKE before this file's GRANT statements in §2.

-- =======================================================================
-- 1. leads — one row per reviewed-and-confirmed screenshot-intake lead, or
--    one manually/phone-entered lead. NEVER a website-origin lead — see the
--    file header above.
--
--    source: three values only. 'website' is deliberately NOT one of
--    them — a website submission is never a row in this table; the merged
--    Leads view (api/admin/bookings.js's ?view=leads) tags a `bookings` row
--    source="website" only in its READ response, never by writing it here.
--
--    source_intake_id + the partial UNIQUE index below: makes "confirm this
--    intake into a lead" idempotent at the database level — one intake can
--    never produce two lead rows, structurally, not just by application
--    discipline. NULL for phone/manual leads, which have no intake to point
--    at.
--
--    status: the fuller Leads-workspace vocabulary (new/contacted/
--    waiting_on_photos/estimate_sent/follow_up/booked/lost) — richer than
--    bookings.status's own 7 values today, because this table exists
--    specifically to carry stages (waiting_on_photos, estimate_sent,
--    follow_up) that website-origin leads don't have a slot for yet. See
--    the proposal's status-mapping table for how the merged read view
--    reconciles the two vocabularies without changing bookings.status.
--
--    matched_customer_id / resulting_booking_id: read-pointers only, exact
--    same posture as intake_sessions.matched_customer_id/
--    linked_existing_booking_id — recording what an admin attached this
--    lead to, never a write to the customer/booking itself. Conversion
--    (the thing that would actually set resulting_booking_id) is explicitly
--    NOT built in this batch.
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NULL,

  source text NOT NULL CHECK (source IN ('screenshot_intake', 'phone', 'manual')),
  source_intake_id uuid NULL REFERENCES public.intake_sessions(id),

  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'waiting_on_photos', 'estimate_sent', 'follow_up', 'booked', 'lost')),

  first_name text NULL,
  last_name text NULL,
  phone text NULL,
  phone_normalized text NULL,
  email text NULL,
  address text NULL,
  city text NULL,
  state text NULL,
  zip text NULL,

  service_type text NULL,
  service_details text NULL,
  estimated_load_size text NULL,
  quoted_amount numeric NULL,

  notes text NULL,
  next_follow_up_date date NULL,

  matched_customer_id uuid NULL REFERENCES public.customers(id),
  -- Reserved for the future Lead -> Booking conversion action — not written
  -- by anything in this batch. See the file header.
  resulting_booking_id uuid NULL REFERENCES public.bookings(id)
);

CREATE INDEX IF NOT EXISTS leads_status_idx ON public.leads (status);
CREATE INDEX IF NOT EXISTS leads_created_at_idx ON public.leads (created_at);
CREATE INDEX IF NOT EXISTS leads_phone_normalized_idx ON public.leads (phone_normalized);

-- One intake can never be confirmed into more than one lead — structural,
-- not just application discipline. Partial (WHERE source_intake_id IS NOT
-- NULL) so any number of phone/manual leads (source_intake_id always NULL)
-- can coexist without colliding against this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS leads_source_intake_id_uniq ON public.leads (source_intake_id) WHERE source_intake_id IS NOT NULL;

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

-- =======================================================================
-- 2. service_role grants — REVOKE-ALL-then-GRANT-exact, same deterministic
--    pattern as sql/2026-10-04_phase3c-batch5-intake-sessions.sql (narrow,
--    explicit, idempotent; never assumes a prior/default grant).
--
--    No DELETE, ever: a lead is only ever marked 'lost' (or converted), never
--    hard-deleted — same archive-not-delete posture this project already
--    gives bookings/customers.
-- =======================================================================
REVOKE ALL ON public.leads FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.leads TO service_role;

-- =======================================================================
-- Verification (re-run any of these any time to re-confirm current state)
-- =======================================================================
-- select column_name, data_type, is_nullable, column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'leads'
--   order by ordinal_position;
--
-- select conname, contype, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.leads'::regclass;
-- -- expect leads_source_intake_id_uniq among the results, as a partial
-- -- unique index (not a plain table constraint, so it won't show here as
-- -- contype='u' — check via pg_indexes instead, below).
--
-- select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'leads';
-- -- expect leads_source_intake_id_uniq to show "WHERE (source_intake_id IS NOT NULL)".
--
-- -- DECISIVE RLS check (service_role must have BYPASSRLS — same posture
-- -- confirmed live for every other RLS-enabled, zero-policy table in this
-- -- project):
-- select rolname, rolbypassrls from pg_roles where rolname = 'service_role';  -- expect true
--
-- select has_table_privilege('service_role', 'public.leads', 'SELECT');  -- expect true
-- select has_table_privilege('service_role', 'public.leads', 'INSERT');  -- expect true
-- select has_table_privilege('service_role', 'public.leads', 'UPDATE');  -- expect true
-- select has_table_privilege('service_role', 'public.leads', 'DELETE');  -- expect false

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- REVOKE ALL ON public.leads FROM service_role;
-- DROP TABLE IF EXISTS public.leads;
