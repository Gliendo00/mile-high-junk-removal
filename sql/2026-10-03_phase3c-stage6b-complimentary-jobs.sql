-- Phase 3C Stage 6b (Batch 3 addendum) — Complimentary/free job tracking.
-- To be run manually in the Supabase SQL editor, AFTER
-- sql/2026-10-02_phase3c-stage6-other-revenue.sql (independent of it —
-- order between the two doesn't actually matter, since neither touches a
-- table the other creates — but this file is numbered after it since it
-- was written second). This project has no migration runner (see
-- sql/2026-09-16_phase3b-step4a1-customer-identity-columns.sql for the
-- established convention this file follows).
--
-- A requirement from the original Batch 3 request was missed in the first
-- pass (other_revenue) and is being added now as a second, independent
-- migration rather than editing the already-reviewed Stage 6 file.
--
-- Goal: a completed job can be explicitly marked complimentary (given away
-- for free) while remaining a legitimate completed job. Its Job Revenue
-- must be exactly $0 — enforced by FORCING bookings.final_price to 0 at
-- write time whenever is_complimentary is true (see
-- api/admin/booking.js's parseComplimentary()), so every existing revenue
-- calculation in this codebase (admin/schedule-financials.js's
-- completedRevenueAmount(), api/_lib/job-payments-ledger.js's
-- effectiveRevenue()) already treats it exactly like any other real,
-- intentional $0 final_price — no new revenue-calculation code path was
-- needed. complimentary_value is a SEPARATE, purely informational column
-- for "what this job would have been worth" — never read by any revenue/
-- Net calculation anywhere in this codebase, only by the dashboard's
-- separate, non-summed "Complimentary Service" informational section.
--
-- Adds, and nothing else: 4 new columns on the existing bookings table,
-- plus 3 CHECK constraints enforcing the core invariants at the database
-- layer too (defense in depth — the application already enforces all
-- three independently).
--
-- Nothing in this file touches other_revenue, job_payments, expenses,
-- customers, dumpster_rentals, or any other table.

ALTER TABLE public.bookings
  -- Not complimentary by default — every existing row backfills to false
  -- with zero ambiguity (NOT NULL, no migration-time guessing about
  -- historical jobs; see the explicit "never infer historical $0 jobs as
  -- complimentary" requirement below).
  ADD COLUMN IF NOT EXISTS is_complimentary boolean NOT NULL DEFAULT false,

  -- Informational only: "what this job would have been worth." Never
  -- summed into Revenue/Net/Booked anywhere — see the header comment
  -- above. Nullable even when is_complimentary is true (the owner may not
  -- always have/want a dollar estimate for a specific complimentary job).
  ADD COLUMN IF NOT EXISTS complimentary_value numeric(10,2) NULL,

  ADD COLUMN IF NOT EXISTS complimentary_reason text NULL,

  ADD COLUMN IF NOT EXISTS complimentary_note text NULL;

-- =======================================================================
-- Invariants, enforced at the database layer (the application already
-- enforces all three independently in api/admin/booking.js's
-- parseComplimentary() — this is defense in depth, not the only guard).
-- =======================================================================

-- 1. complimentary_value, if set, is never negative.
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_complimentary_value_check
  CHECK (complimentary_value IS NULL OR complimentary_value >= 0);

-- 2. complimentary_reason, if set, must be one of the 5 allowed values —
--    mirrors api/_lib/complimentary-reasons.js's ALL_COMPLIMENTARY_REASON_KEYS,
--    which must stay in sync with this list.
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_complimentary_reason_check
  CHECK (complimentary_reason IS NULL OR complimentary_reason IN
    ('loyal_client', 'community_charity', 'service_recovery', 'friends_family', 'other'));

-- 3. is_complimentary=true requires a reason; reason='other' additionally
--    requires a non-blank note — the exact rule the app enforces at create/
--    edit time, repeated here so a row can never reach this shape via any
--    other path (a future direct SQL edit included).
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_complimentary_requires_reason_check
  CHECK (NOT is_complimentary OR complimentary_reason IS NOT NULL);

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_complimentary_other_requires_note_check
  CHECK (complimentary_reason IS DISTINCT FROM 'other' OR (complimentary_note IS NOT NULL AND length(trim(complimentary_note)) > 0));

-- 4. THE core revenue-safety invariant: a complimentary job's final_price
--    must be exactly 0 — never null (which would fall back to
--    estimated_price and leak a nonzero Job Revenue), never any other
--    number. This is what makes every existing revenue calculation in this
--    codebase automatically correct for a complimentary job with zero new
--    complimentary-aware logic in any of them.
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_complimentary_final_price_zero_check
  CHECK (NOT is_complimentary OR final_price = 0);

-- No index added: nothing queries bookings.is_complimentary directly today
-- — the Complimentary Service summary is computed client-side from the
-- same bounded Schedule-range job array admin/schedule-financials.js
-- already fetches for Job Revenue/Booked, exactly like Stage 4's own
-- Revenue/Booked counters. Add one later if a server-side complimentary
-- report is ever built.

-- =======================================================================
-- Verification (re-run any of these any time to re-confirm current state)
-- =======================================================================
-- select column_name, data_type, is_nullable, column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'bookings'
--     and column_name in ('is_complimentary', 'complimentary_value', 'complimentary_reason', 'complimentary_note')
--   order by ordinal_position;
-- -- expect is_complimentary: boolean, NOT NULL, default false.
--
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.bookings'::regclass and conname like 'bookings_complimentary%';
-- -- expect the 4 CHECK constraints above, verbatim.
--
-- -- Every EXISTING row must read back as NOT complimentary (false), with
-- -- every complimentary_* column NULL — confirms the DEFAULT/ADD COLUMN
-- -- never silently flags existing $0-or-null-final_price historical jobs
-- -- as complimentary (the explicit "never infer historical zero-dollar
-- -- jobs as complimentary" requirement).
-- select count(*) as rows_incorrectly_flagged
--   from bookings where is_complimentary = true;
-- -- expect 0 immediately after this migration runs.
--
-- -- Exercise the CHECK constraints directly (run in a throwaway
-- -- transaction, then ROLLBACK — never commit test data):
-- -- begin;
-- --   -- (1) missing reason, rejected:
-- --   update bookings set is_complimentary = true, final_price = 0 where id = (select id from bookings limit 1);
-- --   -- expect: ERROR violates check constraint "bookings_complimentary_requires_reason_check"
-- --   -- (2) reason='other' with no note, rejected:
-- --   update bookings set is_complimentary = true, complimentary_reason = 'other', final_price = 0 where id = (select id from bookings limit 1);
-- --   -- expect: ERROR violates check constraint "bookings_complimentary_other_requires_note_check"
-- --   -- (3) nonzero final_price while complimentary, rejected:
-- --   update bookings set is_complimentary = true, complimentary_reason = 'loyal_client', final_price = 150 where id = (select id from bookings limit 1);
-- --   -- expect: ERROR violates check constraint "bookings_complimentary_final_price_zero_check"
-- --   -- (4) the fully valid shape, accepted:
-- --   update bookings set is_complimentary = true, complimentary_reason = 'loyal_client', complimentary_value = 350, final_price = 0 where id = (select id from bookings limit 1);
-- --   -- expect: success
-- -- rollback;

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_complimentary_final_price_zero_check;
-- ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_complimentary_other_requires_note_check;
-- ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_complimentary_requires_reason_check;
-- ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_complimentary_reason_check;
-- ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_complimentary_value_check;
-- ALTER TABLE public.bookings
--   DROP COLUMN IF EXISTS complimentary_note,
--   DROP COLUMN IF EXISTS complimentary_reason,
--   DROP COLUMN IF EXISTS complimentary_value,
--   DROP COLUMN IF EXISTS is_complimentary;
