-- Interactive Pricing Calculator — saved itemized price breakdowns for a
-- CRM job ("Save to Job" on /admin/pricing-calculator/). To be run
-- manually in the Supabase SQL editor, same convention as every prior
-- migration in this directory. NOT executed by this session — drafted for
-- Rocky's review. The feature degrades safely without it: the calculator
-- itself works fully; only Save to Job reports "not set up yet" (HTTP 503)
-- and the job page simply shows no saved breakdown.
--
-- Why a NEW table instead of an existing one:
--   - bookings has only scalar price columns (estimated_price,
--     estimated_price_max, final_price). There is nowhere to keep load
--     tier, quantities, unit prices, discounts, and descriptions.
--   - invoice_line_items is billing, not estimating: a line there is part
--     of a document the customer is asked to pay (draft -> finalized ->
--     Stripe Pay Now). Writing estimate lines there would turn "show the
--     customer a price" into "create a bill" — exactly what Save to Job
--     must never do.
--   - estimates (sql/2026-10-12_estimate-workflow.sql) is the onsite
--     estimate APPOINTMENT, not a price breakdown, and is not a job.
--   - job_payments is the revenue ledger. Never touched.
--
-- Financial isolation, by construction: no revenue/booked counter, invoice,
-- payment, or Stripe code path reads this table. The ONLY place a saved
-- breakdown can affect any other number is the explicit, opt-in "also set
-- as this job's Quoted Amount" option, which writes bookings.estimated_price
-- (the same field Edit Job already writes) — and api/_lib/price-estimate.js
-- refuses that for completed/lost jobs, dumpster jobs, and complimentary
-- jobs, because admin/schedule-financials.js falls back to estimated_price
-- as revenue for a completed job with no final_price.
--
-- What this migration deliberately does NOT do:
--   - It does not alter bookings, invoices, invoice_line_items,
--     job_payments, or estimates in any way.
--   - It does not migrate any existing data.

-- =======================================================================
-- 0. PREFLIGHT — run this FIRST, by itself. Read-only.
-- =======================================================================
-- select table_name from information_schema.tables
--   where table_schema = 'public' and table_name = 'job_price_estimates';
-- -- expect: zero rows (the table doesn't exist yet)

-- =======================================================================
-- 1. job_price_estimates — at most ONE current saved breakdown per job
--    (UNIQUE booking_id). Re-saving replaces it in place, guarded by
--    `revision` (optimistic concurrency: the server only updates the row
--    whose revision matches what the editor loaded, so two devices can
--    never silently overwrite each other). Totals are integer cents and
--    are always computed by the server from `input`, never taken from the
--    browser.
-- =======================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.job_price_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  load_tier text NOT NULL CHECK (load_tier IN ('minimum','eighth','quarter','three_eighths','half','five_eighths','three_quarters','seven_eighths','full')),
  input jsonb NOT NULL,        -- normalized selections (re-opened into the calculator)
  line_items jsonb NOT NULL,   -- server-computed breakdown: description, quantity, unit/amount cents
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  confirmed_on_site boolean NOT NULL DEFAULT false,
  staff_notes text NULL CHECK (staff_notes IS NULL OR char_length(staff_notes) <= 2000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_request_key text NULL CHECK (last_request_key IS NULL OR char_length(last_request_key) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NULL,
  -- The UNIQUE constraint also creates the btree index on booking_id —
  -- the only column the app ever looks rows up by — so no separate
  -- CREATE INDEX is needed.
  CONSTRAINT job_price_estimates_booking_uniq UNIQUE (booking_id),
  CONSTRAINT job_price_estimates_total_check CHECK (total_cents = subtotal_cents - discount_cents),
  CONSTRAINT job_price_estimates_discount_check CHECK (discount_cents <= subtotal_cents),
  -- Shape + size guards. The server already bounds these (max 10 custom
  -- lines, 5 discounts, 80-char descriptions); these are defense in depth.
  CONSTRAINT job_price_estimates_input_shape CHECK (jsonb_typeof(input) = 'object' AND pg_column_size(input) <= 16384),
  CONSTRAINT job_price_estimates_lines_shape CHECK (jsonb_typeof(line_items) = 'array' AND pg_column_size(line_items) <= 32768)
);

ALTER TABLE public.job_price_estimates ENABLE ROW LEVEL SECURITY;

-- =======================================================================
-- 2. service_role grants — REVOKE-ALL-then-GRANT-exact, same deterministic
--    convention as estimates/invoices. No DELETE: a saved breakdown is
--    replaced (revision++), never removed through the app. No anon/
--    authenticated grants at all — only the server-side admin API (after
--    requireAdmin()) ever reads or writes this table.
-- =======================================================================
REVOKE ALL ON public.job_price_estimates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.job_price_estimates FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.job_price_estimates TO service_role;

COMMIT;

-- =======================================================================
-- 3. VERIFY — read-only, run after the above.
-- =======================================================================
-- select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'job_price_estimates' order by ordinal_position;
-- select privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'job_price_estimates' and grantee = 'service_role';
-- -- expect: SELECT, INSERT, UPDATE (no DELETE)
-- select relrowsecurity from pg_class where oid = 'public.job_price_estimates'::regclass;
-- -- expect: true (RLS on with NO policies: anon/authenticated can never read
-- --  or write rows even if a grant were added later; service_role bypasses RLS)
-- select grantee, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'job_price_estimates' and grantee in ('anon','authenticated');
-- -- expect: zero rows

-- =======================================================================
-- ROLLBACK (only if needed; drops every saved breakdown):
-- =======================================================================
-- DROP TABLE IF EXISTS public.job_price_estimates;
