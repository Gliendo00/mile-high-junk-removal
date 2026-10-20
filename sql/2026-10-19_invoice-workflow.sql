-- Invoice workflow — admin-only Phase 2 (draft -> finalized -> void;
-- partially paid/paid/overdue are derived, never stored). To be run
-- manually in the Supabase SQL editor, same convention as every prior
-- migration in this directory (see sql/2026-09-16_...customer-identity-
-- columns.sql for the established convention this file follows — this
-- project has no migration runner).
--
-- NOT executed by this session — drafted for Rocky's review per the
-- approved Phase 2 plan, same posture as every other not-yet-applied
-- migration here (e.g. sql/2026-10-12_estimate-workflow.sql).
--
-- Stripe Pay Now, client-facing delivery/email, and dumpster-overage
-- "supplemental invoices" are explicitly LATER phases — nothing below
-- builds toward them, and nothing below should make them harder to add.
--
-- =======================================================================
-- Design
-- =======================================================================
-- An Invoice is its OWN table (public.invoices), same rationale as
-- estimates (sql/2026-10-12_estimate-workflow.sql): financial isolation
-- by construction. job_payments (sql/2026-09-19_phase3c-stage3-job-
-- payments-and-expenses.sql) remains the ONE payment ledger — this
-- migration adds no write path to job_payments and no column anywhere
-- that duplicates a payment amount. Recording/voiding a payment continues
-- to go only through the existing api/admin/booking.js
-- ?resource=job-payments endpoints; an invoice's balance is always
-- computed as invoice total minus that booking's non-voided job_payments
-- (netCollectedFromLedgerRows(), existing, in
-- api/_lib/job-payments-ledger.js), never stored.
--
-- status lifecycle: draft -> finalized -> void
--                    draft -> void
-- "Finalized" (not "sent") is the deliberate name for the action that
-- assigns the permanent invoice number and locks the invoice — this
-- repo has no client-delivery/email mechanism yet, and the word "sent"
-- would wrongly imply the client was emailed. That remains a later
-- phase. "partially_paid"/"paid"/"overdue" are NEVER stored — computed
-- at read time from job_payments + due_date (see
-- api/_lib/invoice-helpers.js's deriveInvoiceStatus(), to be added when
-- the application code is built). The CHECK below only bounds the
-- allowed stored values, not the transition graph — transitions are
-- enforced in api/admin/booking.js's resource="invoice" PATCH handler,
-- never a DB trigger, same posture as estimates.status.
--
-- What this migration deliberately does NOT do:
--   - It does not add a tax/discount field, not even as an unused
--     placeholder — total_amount is the sum of line items only (nothing
--     in the requirements names a tax rule, and CLAUDE.md forbids
--     inventing one).
--   - It does not add any Stripe/Pay Now column — later phase.
--   - It does not add a DB-level constraint/trigger blocking invoices
--     against a dumpster_pickup booking — that rule ("a pickup booking
--     can never receive an invoice; bill the primary rental instead") is
--     enforced in handleCreateInvoice() at the application layer, the
--     same place and same posture as every other service_type-dependent
--     business rule in this codebase (e.g. the identical rule already
--     enforced for job_payments).
--   - It does not add an invoice_kind/supplemental-invoice column — the
--     "one active (non-void) invoice per booking" constraint below is
--     the thing to loosen to a composite key when dumpster-overage
--     supplemental invoices are designed later; nothing here assumes it
--     can't be.
--   - It does not touch job_payments or bookings in any way.
--   - It does not reset the invoice-number sequence per calendar year
--     (see §4's own comment for why — a deliberate simplicity choice,
--     flagged for Rocky, not an oversight).

-- =======================================================================
-- 0. PREFLIGHT — run this FIRST, by itself. Read-only; never calls
--    next_invoice_number() (that would consume a real, permanent sequence
--    value for nothing — see §4's own note on why this function can never
--    be "peeked" without advancing it).
-- =======================================================================

-- 1. invoices does not already exist.
-- select table_name from information_schema.tables
--   where table_schema = 'public' and table_name = 'invoices';
-- -- expect: zero rows

-- 2. invoice_line_items does not already exist.
-- select table_name from information_schema.tables
--   where table_schema = 'public' and table_name = 'invoice_line_items';
-- -- expect: zero rows

-- 3. invoice_number_seq does not already exist.
-- select relname from pg_class where relkind = 'S' and relname = 'invoice_number_seq';
-- -- expect: zero rows

-- 4. next_invoice_number() does not already exist.
-- select p.proname from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'next_invoice_number';
-- -- expect: zero rows

-- 5. No conflicting invoice-related index names already exist (every
--    CREATE INDEX below is already IF NOT EXISTS, which protects the
--    objects themselves — this check is for the rarer case of the NAME
--    being reused by some unrelated existing index, which IF NOT EXISTS
--    would silently leave untouched rather than creating the one this
--    migration actually wants).
-- select indexname from pg_indexes where schemaname = 'public'
--   and indexname in (
--     'invoices_booking_id_idx', 'invoices_customer_id_idx', 'invoices_status_idx',
--     'invoices_booking_id_active_uniq', 'invoices_invoice_number_uniq',
--     'invoice_line_items_invoice_id_idx'
--   );
-- -- expect: zero rows

-- 6. bookings.id and customers.id are both uuid — confirms invoices.
--    booking_id/customer_id below (declared uuid REFERENCES ...) will
--    actually match, rather than silently failing (or Postgres implicitly
--    rejecting) a FK against a differently-typed primary key.
-- select table_name, column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name in ('bookings', 'customers') and column_name = 'id'
--   order by table_name;
-- -- expect: two rows, both data_type = 'uuid'

-- 7. service_role exists and already carries the SAME grant shape
--    (SELECT/INSERT/UPDATE, no DELETE) on an existing comparable table —
--    confirms this migration's own REVOKE-ALL-then-GRANT-exact pattern
--    (§3 below) matches how the project already configures this role,
--    rather than introducing a new/different convention.
-- select rolname from pg_roles where rolname = 'service_role';
-- -- expect: one row
--
-- select privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'estimates' and grantee = 'service_role'
--   order by privilege_type;
-- -- informational — compare against this migration's own §3 grants
-- -- (expect the same SELECT/INSERT/UPDATE shape, no DELETE, confirming
-- -- estimates' already-applied migration used the identical convention)

-- =======================================================================
-- 1. invoices — one row per invoice, tied to exactly one booking/job.
--
--    booking_id: required, the job this invoice bills. No cascading
--    delete — a voided invoice is never removed, matching the no-hard-
--    delete posture every financial table in this codebase already uses
--    (job_payments, estimates).
--
--    customer_id: captured server-side from the booking at invoice-
--    creation time (handleCreateInvoice() re-fetches the booking itself
--    and never trusts a client-sent customer id — same IDOR-hardening
--    posture as Convert-to-Job) — lets the Invoices list page filter/
--    display by client without joining through bookings on every row.
--
--    invoice_number: NULL until finalized. Assigned exactly once, only
--    inside the "finalize" PATCH action (handlePatchInvoice(), to be
--    added), via next_invoice_number() below. A voided-then-replaced
--    invoice gets a brand new number if a replacement is ever created —
--    numbers are never reused or reassigned.
--
--    total_amount: denormalized sum of invoice_line_items.amount,
--    recomputed and written by the add/update/remove-line-item actions
--    in application code — not a generated column (no precedent for
--    those in this codebase) and not recomputed on every read, so the
--    Invoices list page's bulk query stays a single cheap select.
--
--    due_date: nullable while draft. Manual, per-invoice, set by the
--    admin before finalizing — no company-wide default payment term
--    (e.g. Net 15/30) is invented here; confirmed with Rocky as the
--    correct v1 behavior.
--
--    finalized_at: set once, at finalization, alongside invoice_number.
--    Deliberately NOT named sent_at — this table has no notion of the
--    invoice having been delivered to the client.
--
--    Only ever voided, never deleted — corrections are void + a new
--    invoice (supplemental-invoice design is a later phase), never an
--    edit to a finalized row. Line-item immutability once finalized is
--    enforced in handlePatchInvoice(), never a DB trigger, same posture
--    as estimates.
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NULL,

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'finalized', 'void')),

  booking_id uuid NOT NULL REFERENCES public.bookings(id),
  customer_id uuid NOT NULL REFERENCES public.customers(id),

  invoice_number text NULL,
  due_date date NULL,
  notes text NULL,
  total_amount numeric NOT NULL DEFAULT 0 CHECK (total_amount >= 0),

  finalized_at timestamptz NULL,
  voided_at timestamptz NULL,
  voided_reason text NULL
);

CREATE INDEX IF NOT EXISTS invoices_booking_id_idx ON public.invoices (booking_id);
CREATE INDEX IF NOT EXISTS invoices_customer_id_idx ON public.invoices (customer_id);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON public.invoices (status);

-- "At most one active (non-void) invoice per booking" — approved for
-- Phase 2 ONLY. Simplifies balance-due math, since job_payments is
-- booking-scoped, not invoice-scoped: with exactly zero-or-one active
-- invoice per booking, "this booking's collected payments" and "this
-- invoice's collected payments" are the same query. MUST be loosened
-- (e.g. to a composite key such as (booking_id, invoice_kind), or simply
-- dropped in favor of app-level rules once a real multi-invoice design
-- exists) before dumpster-overage supplemental invoices are built —
-- flagged here explicitly so that later phase doesn't quietly inherit a
-- constraint nobody remembers choosing. Nothing else in this schema
-- assumes single-invoice-per-booking.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_booking_id_active_uniq ON public.invoices (booking_id) WHERE status <> 'void';

-- Numbers are assigned once, at finalization, and never reused.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_invoice_number_uniq ON public.invoices (invoice_number) WHERE invoice_number IS NOT NULL;

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- =======================================================================
-- 2. invoice_line_items — editable only while the parent invoice is
--    draft (enforced in application code, not here). amount is the
--    app-computed qty*unit_price (Math.round(n*100)/100, same convention
--    as every other money value in this codebase) — not a generated
--    column. No tax/discount column, deliberately (see header).
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.invoice_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  sort_order integer NOT NULL DEFAULT 0,
  description text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price numeric NOT NULL CHECK (unit_price >= 0),
  amount numeric NOT NULL CHECK (amount >= 0)
);

CREATE INDEX IF NOT EXISTS invoice_line_items_invoice_id_idx ON public.invoice_line_items (invoice_id);

ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;

-- =======================================================================
-- 3. service_role grants — REVOKE-ALL-then-GRANT-exact, same
--    deterministic pattern as estimates. invoices itself: no DELETE,
--    ever (void + a new invoice is the only correction path).
--    invoice_line_items DOES get DELETE — deliberately asymmetric: a
--    draft invoice's line items are pre-financial scratch data (the
--    invoice hasn't been finalized/numbered yet), so removing a row
--    while still drafting doesn't violate the audit-trail principle the
--    way deleting a job_payments row or a finalized invoice would.
--    Editing/deleting a line item once the PARENT invoice is finalized
--    is blocked in the application layer (handlePatchInvoice()), not by
--    a DB-level status check.
-- =======================================================================
REVOKE ALL ON public.invoices FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.invoices TO service_role;

REVOKE ALL ON public.invoice_line_items FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_line_items TO service_role;

-- =======================================================================
-- 4. invoice_number_seq + next_invoice_number() — sequential display
--    numbers, formatted INV-YYYY-####, e.g. INV-2026-1001,
--    INV-2026-1002, .... First precedent in this codebase for a
--    human-readable number (everything else is a bare uuid in URLs).
--
--    Sequence starts at 1001 per Rocky's spec, so the first invoice ever
--    finalized is INV-2026-1001 (year = the America/Denver calendar year
--    at finalization time, matching this codebase's existing
--    denverTodayIso() convention for "today" rather than UTC).
--
--    Deliberately NOT reset per calendar year: the sequence just keeps
--    incrementing (INV-2026-1001, INV-2026-1002, ... INV-2027-1050, ...)
--    rather than restarting at 1001 every January. Resetting per year
--    would need either a second tracking column or per-year sequence
--    objects created on a schedule — real complexity for a cosmetic
--    requirement nobody asked for. Flagged explicitly: if a per-year
--    reset is actually wanted, say so and it can be added before this
--    runs, but the simpler always-incrementing form is what's built here
--    unless told otherwise.
--
--    Small numbering gaps from a failed/racing finalize attempt (the
--    sequence advances via nextval() even if the surrounding UPDATE then
--    fails/no-ops) are normal Postgres sequence behavior and are
--    explicitly acceptable per Rocky's spec — no gapless/transactional-
--    rollback logic is built here.
--
--    supabase-js has no client-side nextval() call, so this thin SQL
--    function is the call surface: the finalize action calls
--    supabase.rpc('next_invoice_number') exactly once, inside the same
--    conditional "update ... where status = 'draft'" write that assigns
--    it (to be built in application code) — never called speculatively
--    or more than once per finalize attempt.
--
--    LPAD(..., 4, '0') makes the INV-YYYY-#### format a literal guarantee
--    of this function's implementation, not just a coincidence of 1001
--    already being 4 digits — e.g. if this sequence were ever restarted
--    at a smaller number, 1 would render as INV-2026-0001, never the
--    bare, under-width INV-2026-1. (A number large enough to exceed 4
--    digits, e.g. 10000+, simply prints in full — LPAD never truncates —
--    so "####" is a MINIMUM width here, same as every zero-padded
--    reference number convention elsewhere, never a hard cap.)
--
--    Locked down to service_role only, explicitly: PUBLIC, anon, and
--    authenticated are REVOKEd first (defense in depth — a function
--    this strictly controlled by handlePatchInvoice()'s own gating
--    should never be callable by anything but the service-role key this
--    codebase's admin API already uses exclusively; see api/_lib/
--    supabase-admin.js's own header for why the anon/authenticated roles
--    exist in this project at all — the public booking form and any
--    future authenticated end-user surface, neither of which should ever
--    be able to mint an invoice number directly). Same REVOKE-ALL-then-
--    GRANT-exact determinism as §3's table grants above, just applied to
--    a function/sequence instead of a table.
-- =======================================================================
CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq START WITH 1001 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION public.next_invoice_number()
RETURNS text
LANGUAGE sql
AS $$
  SELECT 'INV-' || to_char(now() AT TIME ZONE 'America/Denver', 'YYYY') || '-' || LPAD(nextval('public.invoice_number_seq')::text, 4, '0');
$$;

REVOKE ALL ON SEQUENCE public.invoice_number_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.invoice_number_seq TO service_role;

REVOKE ALL ON FUNCTION public.next_invoice_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_invoice_number() TO service_role;

-- =======================================================================
-- Verification (re-run any of these any time to re-confirm current state).
-- Never calls next_invoice_number() — see the sequence-state query at the
-- bottom for how to confirm its starting position without consuming it.
-- =======================================================================

-- Columns, types, nullability.
-- select table_name, column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name in ('invoices','invoice_line_items')
--   order by table_name, ordinal_position;

-- CHECK constraints (status/total_amount/quantity/unit_price/amount).
-- select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where contype = 'c' and conrelid in ('public.invoices'::regclass, 'public.invoice_line_items'::regclass)
--   order by table_name, conname;

-- Foreign keys (invoices.booking_id -> bookings.id, invoices.customer_id ->
-- customers.id, invoice_line_items.invoice_id -> invoices.id).
-- select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where contype = 'f' and conrelid in ('public.invoices'::regclass, 'public.invoice_line_items'::regclass)
--   order by table_name, conname;

-- Indexes (expect invoices: booking_id_idx, customer_id_idx, status_idx,
-- booking_id_active_uniq, invoice_number_uniq, plus the PK; invoice_line_items:
-- invoice_id_idx, plus the PK).
-- select indexname, indexdef from pg_indexes where schemaname = 'public'
--   and tablename in ('invoices','invoice_line_items')
--   order by tablename, indexname;

-- RLS enabled on both tables.
-- select relname, relrowsecurity from pg_class
--   where relnamespace = 'public'::regnamespace and relname in ('invoices','invoice_line_items');
-- -- expect: relrowsecurity = true for both

-- Grants — full shape, not just a single privilege (expect invoices:
-- SELECT/INSERT/UPDATE only; invoice_line_items: SELECT/INSERT/UPDATE/DELETE).
-- select table_name, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name in ('invoices','invoice_line_items') and grantee = 'service_role'
--   order by table_name, privilege_type;
-- select has_table_privilege('service_role', 'public.invoices', 'DELETE'); -- expect false
-- select has_table_privilege('service_role', 'public.invoice_line_items', 'DELETE'); -- expect true

-- Sequence start/current state WITHOUT advancing it (reading last_value/
-- is_called is a plain row read — unlike nextval(), it never consumes a
-- value).
-- select last_value, is_called from public.invoice_number_seq;
-- -- expect: last_value = 1001, is_called = false (meaning the NEXT
-- -- nextval() call will return 1001, not that 1001 was already consumed)

-- The SQL function's own definition, WITHOUT executing it — pg_get_functiondef()
-- just returns the function's source text, same as reading a file; it never
-- calls the function itself.
-- select pg_get_functiondef(p.oid) from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'next_invoice_number';

-- next_invoice_number()/invoice_number_seq lockdown — anon and authenticated
-- (the two roles Supabase's PostgREST layer actually uses for any
-- non-service-role request) must both be denied; service_role (the only
-- key api/_lib/supabase-admin.js's getServiceClient() ever uses) must be
-- the one role that can.
-- select has_function_privilege('anon', 'public.next_invoice_number()', 'EXECUTE'); -- expect false
-- select has_function_privilege('authenticated', 'public.next_invoice_number()', 'EXECUTE'); -- expect false
-- select has_function_privilege('service_role', 'public.next_invoice_number()', 'EXECUTE'); -- expect true
-- select has_sequence_privilege('anon', 'public.invoice_number_seq', 'USAGE'); -- expect false
-- select has_sequence_privilege('authenticated', 'public.invoice_number_seq', 'USAGE'); -- expect false
-- select has_sequence_privilege('service_role', 'public.invoice_number_seq', 'USAGE'); -- expect true
-- -- Belt-and-suspenders cross-check: the full ACL as Postgres itself
-- -- records it, for a visual confirm alongside the has_*_privilege()
-- -- booleans above (aclexplode decodes the raw aclitem[] into readable
-- -- grantee/privilege rows; expect exactly one row here, service_role/EXECUTE).
-- select (aclexplode(proacl)).grantee::regrole::text as grantee, (aclexplode(proacl)).privilege_type
--   from pg_proc where pronamespace = 'public'::regnamespace and proname = 'next_invoice_number';

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- DROP FUNCTION IF EXISTS public.next_invoice_number();
-- DROP SEQUENCE IF EXISTS public.invoice_number_seq;
-- REVOKE ALL ON public.invoice_line_items FROM service_role;
-- DROP TABLE IF EXISTS public.invoice_line_items;
-- REVOKE ALL ON public.invoices FROM service_role;
-- DROP TABLE IF EXISTS public.invoices;
