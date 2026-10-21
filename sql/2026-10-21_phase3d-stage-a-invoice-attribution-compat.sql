-- Phase 3D Stage A — Invoice ledger attribution: backwards-compatible
-- schema foundation ONLY. Second half (historical backfill, the
-- canonical invoice_id balance-read switch, Attach-to-Job) is a
-- SEPARATE, later file: sql/2026-10-21_phase3d-stage-b-invoice-
-- attribution-canonical.sql. Do not run that file until this one has
-- been live, with Stage A application code promoted and stable, for a
-- comfortable period — see that file's own preflight/header for exactly
-- what it assumes.
--
-- NOT executed by this session — drafted for Rocky's review per the
-- architecture discussion that preceded this file.
--
-- =======================================================================
-- Why Stage A changes NOTHING about what "paying the job" means
-- =======================================================================
--
-- Every invoice balance read in this codebase today
-- (api/_lib/invoice-helpers.js's computeInvoiceBalanceCents(),
-- api/admin/booking.js's handleGetInvoice(), api/admin/bookings.js's
-- handleInvoicesView(), api/book.js's invoice-public view) stays exactly
-- as it is: booking_id-keyed, summing every non-voided job_payments row
-- for the booking. This file does not touch any of those reads. It only
-- adds the columns/constraints/trigger that make it POSSIBLE for a
-- future write to also record invoice_id — and, separately (documented
-- below, NOT built in this file), requires Stage A's application code to
-- actually do so in a way that mirrors today's booking-wide outcome
-- exactly, so that when Stage B later switches reads to invoice_id-only,
-- nothing changes.
--
-- What this file adds:
--   invoices.booking_id            -> nullable (no standalone invoice is
--                                     created by Stage A's app — that is
--                                     a Stage B feature — this is pure
--                                     schema groundwork)
--   invoices.invoice_kind          -> 'original' | 'supplemental',
--                                     default 'original' (groundwork for
--                                     supplemental invoices; no creation
--                                     path for a supplemental exists yet)
--   invoices_booking_id_active_original_uniq
--                                   -> re-scoped uniqueness: at most one
--                                     non-void ORIGINAL invoice per
--                                     booking (identical in effect to
--                                     today's constraint, since every
--                                     existing row defaults to
--                                     'original')
--   job_payments.booking_id        -> nullable (no row is ever written
--                                     with it NULL by Stage A's app —
--                                     standalone invoices/Attach-to-Job
--                                     are Stage B features — this is
--                                     schema groundwork only)
--   job_payments.invoice_id        -> new, nullable FK to invoices
--   job_payments.invoice_id_classified
--                                   -> new, NOT NULL DEFAULT false. The
--                                     old (pre-Stage-A) application has
--                                     no idea this column exists, so
--                                     every row it writes gets the
--                                     default automatically — this is
--                                     exactly how invoice_kind's default
--                                     already works for old invoice-
--                                     creation code, applied here to
--                                     make "was this row ever written by
--                                     code that knows about invoice_id"
--                                     a provable, structural fact rather
--                                     than a guess about timing. Stage B
--                                     removes the default once every row
--                                     has been finally classified.
--   job_payments_source_chk        -> at least one of booking_id/
--                                     invoice_id must be set
--   job_payments_invoice_id_requires_classified_chk
--                                   -> if invoice_id is set, the row
--                                     must be classified=true (the old
--                                     app never sets invoice_id at all,
--                                     so this can never fire against a
--                                     legacy row — it only guards against
--                                     a future bug writing invoice_id
--                                     without going through the
--                                     classification contract)
--   job_payments_validate_attribution_trg
--                                   -> the one rule a plain CHECK can't
--                                     express (it has to read
--                                     public.invoices): an invoice-
--                                     attributed row's booking_id must
--                                     equal that invoice's CURRENT
--                                     booking_id EXACTLY, including NULL
--                                     (NULL for standalone, the
--                                     invoice's own booking_id when
--                                     attached) — never diverge. This is
--                                     what makes it impossible for an
--                                     attached invoice's money to
--                                     silently vanish from job/revenue
--                                     reporting.
--
-- What this file deliberately does NOT do:
--   - No historical backfill of any kind.
--   - No change to any balance-read code path (not built here, not
--     switched here — reads stay booking_id-keyed until Stage B).
--   - No attach_invoice_to_booking() RPC — nothing can call it until
--     Stage B's application features exist.
--   - No grant changes on job_payments beyond the new trigger
--     function's own lockdown. Stage A's application only ever INSERTs
--     new job_payments rows (never UPDATEs invoice_id, booking_id, or
--     invoice_id_classified after the fact), and INSERT is already
--     granted table-wide — it automatically covers the two new columns
--     with no new GRANT statement needed. The service_role UPDATE grant
--     is extended (to booking_id, for the Attach RPC's own backfill
--     step) only in Stage B, exactly when something first needs it —
--     Stage A enables no new write capability, only new write
--     *vocabulary* for the existing write paths.
--   - No change to job_payments.amount/payment_method/payment_type/
--     payment_date/voided_at/voided_reason/stripe_payment_intent_id/
--     reverses_payment_id, or any invoices column other than
--     booking_id's nullability and the two new invoice_kind-related
--     additions.
--
-- =======================================================================
-- Stage A application contract (documented here, NOT implemented in
-- this file or in this pass at all — application code changes are a
-- separate, later step)
-- =======================================================================
--
-- One centralized resolver, call it resolveJobPaymentAttribution({
-- bookingId, explicitInvoiceId }), becomes the ONLY way any code path
-- computes the (invoice_id, booking_id) pair before inserting into
-- job_payments:
--
--   if explicitInvoiceId is given:
--     use it directly, no lookup (the caller already knows exactly
--     which invoice this payment is for — e.g. a confirmed Stripe Pay
--     Now PaymentIntent). bookingId is whatever the caller already
--     knows (the invoice's own booking_id).
--   else (bookingId given, no explicit invoice):
--     look up: SELECT id FROM invoices
--              WHERE booking_id = bookingId AND status <> 'void'
--                AND invoice_kind = 'original'
--     (at most one row — invoices_booking_id_active_original_uniq
--     guarantees it)
--     if found: attribute to it (preserves today's booking-wide
--     balance outcome for this payment).
--     if not found: invoice_id = NULL.
--
-- Every insert explicitly sets invoice_id_classified = true — Stage A's
-- code never relies on the column default; the default only ever
-- applies to a row written by code that has no idea this contract
-- exists.
--
-- Confirmed by a full-repository search (no other job_payments insert/
-- upsert path exists anywhere in this codebase as of this writing) —
-- exactly two functions need to be changed to route through the
-- resolver, and both are touched to cover every current call site:
--
--   1. api/_lib/job-payments-ledger.js's mirrorStripePaymentToLedger() —
--      the single shared INSERT (upsert) statement every Stripe-
--      confirmed mirror goes through. Gains an optional invoiceId
--      parameter. Its six current call sites all funnel through this
--      one function, so fixing it here covers all of them:
--        - api/book.js (initial rental deposit capture) — bookingId
--          only today; after the change, goes through the resolver's
--          lookup branch.
--        - api/stripe-webhook.js, reconcileSucceeded() — TWO call
--          sites (the rental_payments success branch and the
--          rental_additional_charges success branch) — both bookingId
--          only; both go through the lookup branch.
--        - api/admin/booking.js's handleApprove() (admin-approved
--          off-session additional charge) — bookingId only; lookup
--          branch.
--        - api/admin/booking.js's handleCheckStatus() (re-check of an
--          off-session additional charge) — bookingId only; lookup
--          branch.
--        - api/_lib/invoice-helpers.js's reconcileInvoicePaymentIntent()
--          (the ONE invoice-originated caller — Stripe Pay Now) —
--          already has an explicit invoiceId; short-circuit branch,
--          unchanged in substance from today except for also setting
--          invoice_id_classified = true.
--   2. api/admin/booking.js's handleCreateJobPayment() — the one direct
--      manual-entry INSERT (cash/check/Zelle/Venmo/other recorded by an
--      admin against a booking). bookingId only; lookup branch.
--
-- No other file in this repository performs a job_payments insert or
-- upsert — confirmed by searching every .js file for
-- `from("job_payments")` combined with `.insert(`/`.upsert(` and for
-- every call site of mirrorStripePaymentToLedger(). There is no third
-- path to find later and no caller left outside the resolver's reach.

-- =======================================================================
-- 0. PREFLIGHT — run this FIRST, by itself. Read-only.
-- =======================================================================

-- 1. None of the new invoices columns/constraints already exist.
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoices' and column_name = 'invoice_kind';
-- select conname from pg_constraint where conrelid = 'public.invoices'::regclass
--   and conname in ('invoices_invoice_kind_chk', 'invoices_supplemental_requires_booking_chk');
-- -- both expect: zero rows

-- 2. None of the new job_payments columns/constraints already exist.
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'job_payments'
--   and column_name in ('invoice_id', 'invoice_id_classified');
-- select conname from pg_constraint where conrelid = 'public.job_payments'::regclass
--   and conname in ('job_payments_source_chk', 'job_payments_invoice_id_requires_classified_chk');
-- -- both expect: zero rows

-- 3. The attribution trigger function does not already exist.
-- select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'job_payments_validate_attribution';
-- -- expect: zero rows

-- 4. invoices_booking_id_active_uniq exists with exactly the expected
--    definition — confirms what this migration is about to drop/replace.
-- select indexname, indexdef from pg_indexes where schemaname = 'public'
--   and indexname = 'invoices_booking_id_active_uniq';
-- -- expect one row, indexdef containing: UNIQUE (booking_id) WHERE (status <> 'void'::text)

-- 5. invoices.booking_id and job_payments.booking_id are both currently
--    NOT NULL (confirms the starting state this migration relaxes).
-- select table_name, is_nullable from information_schema.columns
--   where table_schema = 'public' and column_name = 'booking_id'
--   and table_name in ('invoices', 'job_payments');
-- -- expect: both 'NO'

-- 6. invoices' existing service_role grant shape — unchanged by this
--    file, confirmed here purely so the "no grant change" claim above is
--    verifiable, not assumed.
-- select privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'invoices' and grantee = 'service_role'
--   order by privilege_type;
-- -- expect: INSERT, SELECT, UPDATE

-- 7. job_payments' existing service_role grant shape — also unchanged by
--    this file.
-- select column_name, privilege_type from information_schema.role_column_grants
--   where table_schema = 'public' and table_name = 'job_payments' and grantee = 'service_role'
--   and privilege_type = 'UPDATE' order by column_name;
-- -- expect exactly: updated_at, voided_at, voided_reason (3 rows — unchanged)
-- select has_table_privilege('service_role', 'public.job_payments', 'UPDATE'); -- expect false (bare table-level)

-- 8. invoices.id / job_payments.id / bookings.id / customers.id are all
--    uuid (confirms the new FK will actually match).
-- select table_name, data_type from information_schema.columns
--   where table_schema = 'public' and column_name = 'id'
--   and table_name in ('invoices', 'job_payments', 'bookings', 'customers')
--   order by table_name;
-- -- expect: uuid for all four

-- =======================================================================
-- MIGRATION — one atomic transaction, same posture as
-- sql/2026-10-19_phase3-invoice-delivery-pay-now.sql: no CONCURRENTLY
-- operation anywhere below, so a syntax error or constraint violation on
-- any one statement rolls back everything. No IF NOT EXISTS/OR REPLACE —
-- preflight above already confirmed none of these objects exist, so any
-- unexpected drift fails loudly rather than being silently skipped or
-- overwritten.
-- =======================================================================
BEGIN;

-- -----------------------------------------------------------------------
-- 1. invoices — nullable booking_id + supplemental-invoice groundwork.
-- -----------------------------------------------------------------------
ALTER TABLE public.invoices
  ALTER COLUMN booking_id DROP NOT NULL;

ALTER TABLE public.invoices
  ADD COLUMN invoice_kind text NOT NULL DEFAULT 'original';

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_invoice_kind_chk
    CHECK (invoice_kind IN ('original', 'supplemental')),
  ADD CONSTRAINT invoices_supplemental_requires_booking_chk
    CHECK (invoice_kind <> 'supplemental' OR booking_id IS NOT NULL);

-- Re-scope the uniqueness: at most one non-void ORIGINAL invoice per
-- booking (identical in effect to today's constraint, since every
-- existing row just defaulted to 'original' above); supplementals
-- unbounded (no creation path for one exists yet). Plain DROP, not DROP
-- INDEX IF EXISTS — preflight #4 already confirmed it exists with the
-- expected shape.
DROP INDEX public.invoices_booking_id_active_uniq;
CREATE UNIQUE INDEX invoices_booking_id_active_original_uniq
  ON public.invoices (booking_id)
  WHERE status <> 'void' AND invoice_kind = 'original';

-- No GRANT statement for invoices — see preflight #6; the existing
-- table-wide grant already covers invoice_kind.

-- -----------------------------------------------------------------------
-- 2. job_payments — nullable booking_id + the attribution vocabulary.
-- -----------------------------------------------------------------------
ALTER TABLE public.job_payments
  ALTER COLUMN booking_id DROP NOT NULL;

ALTER TABLE public.job_payments
  ADD COLUMN invoice_id uuid NULL REFERENCES public.invoices(id),
  ADD COLUMN invoice_id_classified boolean NOT NULL DEFAULT false;

ALTER TABLE public.job_payments
  ADD CONSTRAINT job_payments_source_chk
    CHECK (booking_id IS NOT NULL OR invoice_id IS NOT NULL),
  ADD CONSTRAINT job_payments_invoice_id_requires_classified_chk
    CHECK (invoice_id IS NULL OR invoice_id_classified = true);

CREATE INDEX job_payments_invoice_id_idx
  ON public.job_payments (invoice_id) WHERE invoice_id IS NOT NULL;

-- No GRANT statement for job_payments — see this file's header and
-- preflight #7. INSERT is already table-wide and covers both new
-- columns; UPDATE is extended only in Stage B, exactly when the Attach
-- RPC first needs it.

-- -----------------------------------------------------------------------
-- 3. job_payments_validate_attribution() — the one rule a plain CHECK
--    can't express (it has to read public.invoices). Fires on every
--    INSERT, and on UPDATE only when invoice_id or booking_id is part of
--    the SET list (the `OF` column list only restricts the UPDATE case;
--    INSERT always fires regardless — every insert needs validating, but
--    nothing in Stage A ever UPDATEs these two columns, so in practice
--    this only ever fires on INSERT until Stage B exists).
--
--    Enforced shapes for an invoice-attributed row (NEW.invoice_id IS NOT
--    NULL): NEW.booking_id must equal that invoice's CURRENT booking_id
--    EXACTLY, including NULL — IS DISTINCT FROM (not "IS NOT NULL AND
--    IS DISTINCT FROM") is what makes NULL a value that must match NULL,
--    not an escape hatch. A standalone invoice's row must have
--    booking_id = NULL; an attached invoice's row must have booking_id =
--    that invoice's own booking_id; nothing else is legal.
--
--    A job-level-only row (NEW.invoice_id IS NULL) is untouched by this
--    function entirely — job_payments_source_chk alone governs it.
--
--    SECURITY INVOKER (the default — no DEFINER needed): this app only
--    ever writes job_payments as service_role, which already holds
--    SELECT on invoices (Phase 2's table-wide grant), so the internal
--    SELECT below needs no elevated privilege. Trigger firing is NOT
--    gated by EXECUTE privilege in Postgres (EXECUTE only gates a direct
--    function CALL) — the REVOKE ALL below is pure defense-in-depth
--    against anything ever calling it directly, not a requirement for it
--    to work as a trigger.
-- -----------------------------------------------------------------------
CREATE FUNCTION public.job_payments_validate_attribution() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice_booking_id uuid;
BEGIN
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT booking_id INTO v_invoice_booking_id FROM public.invoices WHERE id = NEW.invoice_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'job_payments.invoice_id % does not reference an existing invoice', NEW.invoice_id;
    END IF;

    IF NEW.booking_id IS DISTINCT FROM v_invoice_booking_id THEN
      RAISE EXCEPTION 'job_payments row booking_id % does not exactly match invoice %''s own booking_id % — an invoice-attributed row''s booking_id must mirror its invoice exactly (NULL for standalone, the invoice''s own booking_id when attached), never diverge',
        NEW.booking_id, NEW.invoice_id, v_invoice_booking_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER job_payments_validate_attribution_trg
  BEFORE INSERT OR UPDATE OF invoice_id, booking_id ON public.job_payments
  FOR EACH ROW EXECUTE FUNCTION public.job_payments_validate_attribution();

REVOKE ALL ON FUNCTION public.job_payments_validate_attribution() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.job_payments_validate_attribution() FROM anon;
REVOKE ALL ON FUNCTION public.job_payments_validate_attribution() FROM authenticated;
REVOKE ALL ON FUNCTION public.job_payments_validate_attribution() FROM service_role;
-- No EXECUTE grant to anyone, deliberately — nothing should ever call
-- this directly; its only caller is the trigger mechanism itself, which
-- is unaffected by this revocation.

COMMIT;

-- =======================================================================
-- 4. Verification (re-run any of these any time to re-confirm current
--    state; all read-only).
-- =======================================================================

-- invoices: new column/constraints.
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoices' and column_name in ('booking_id', 'invoice_kind')
--   order by column_name;
-- -- expect: booking_id -> uuid, is_nullable = YES; invoice_kind -> text, NOT NULL, default 'original'

-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where contype = 'c' and conrelid = 'public.invoices'::regclass
--   and conname in ('invoices_invoice_kind_chk', 'invoices_supplemental_requires_booking_chk')
--   order by conname;

-- invoices: re-scoped unique index.
-- select indexname, indexdef from pg_indexes where schemaname = 'public'
--   and indexname = 'invoices_booking_id_active_original_uniq';
-- -- expect indexdef to show: UNIQUE (booking_id) WHERE ((status <> 'void'::text) AND (invoice_kind = 'original'::text))
-- select indexname from pg_indexes where schemaname = 'public' and indexname = 'invoices_booking_id_active_uniq';
-- -- expect: zero rows (the old index is gone)

-- job_payments: new columns/constraints/index.
-- select column_name, data_type, is_nullable, column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'job_payments'
--   and column_name in ('booking_id', 'invoice_id', 'invoice_id_classified')
--   order by column_name;
-- -- expect: booking_id is_nullable = YES; invoice_id is_nullable = YES; invoice_id_classified NOT NULL, default false
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where contype = 'c' and conrelid = 'public.job_payments'::regclass
--   and conname in ('job_payments_source_chk', 'job_payments_invoice_id_requires_classified_chk')
--   order by conname;
-- select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = 'job_payments_invoice_id_idx';

-- job_payments: service_role's grant shape is UNCHANGED by this file.
-- select has_column_privilege('service_role', 'public.job_payments', 'booking_id', 'UPDATE');            -- expect false (still — extended in Stage B)
-- select has_column_privilege('service_role', 'public.job_payments', 'invoice_id', 'UPDATE');             -- expect false (permanently — never granted)
-- select has_column_privilege('service_role', 'public.job_payments', 'invoice_id_classified', 'UPDATE');  -- expect false (still — nothing updates it in Stage A)
-- select has_column_privilege('service_role', 'public.job_payments', 'voided_at', 'UPDATE');              -- expect true (unchanged)
-- select has_table_privilege('service_role', 'public.job_payments', 'DELETE');                            -- expect false

-- Trigger exists, correctly locked down.
-- select tgname, tgrelid::regclass from pg_trigger
--   where tgrelid = 'public.job_payments'::regclass and not tgisinternal;
-- select has_function_privilege('service_role', 'public.job_payments_validate_attribution()', 'EXECUTE'); -- expect false (trigger-only; nobody calls it directly)

-- =======================================================================
-- OPTIONAL functional smoke test — exercises every behavioral guarantee
-- this file's schema adds. Operates ENTIRELY on throwaway fixture rows
-- it creates itself and ends in ROLLBACK — nothing it does is ever kept,
-- and it never reads or touches any real production row. Safe to run
-- any time after the migration above has committed. Run it as its own
-- script, separate from everything above.
--
-- Column list note: the bookings/customers INSERTs below use only the
-- columns this codebase's own application code always provides
-- (customers: first_name, last_name, phone — phone is NOT NULL on the
-- live schema, confirmed when this smoke test was actually run against
-- production; bookings: customer_id, service_type — status is NOT NULL
-- DEFAULT 'new' per api/admin/bookings.js's own documented confirmation,
-- so it's omitted here). If this environment's live schema has further
-- NOT NULL columns without defaults on either table, this block fails
-- fast with a clear "null value in column ... violates not-null
-- constraint" error and the ROLLBACK at the end still discards
-- everything cleanly — a safe failure mode, not a risky one.
-- =======================================================================
-- BEGIN;
--
-- DO $$
-- DECLARE
--   v_cust1 uuid;
--   v_booking1 uuid; v_booking2 uuid;
--   v_invoice1 uuid;           -- attached to v_booking1
--   v_invoice_standalone uuid; -- no booking
-- BEGIN
--   INSERT INTO public.customers (first_name, last_name, phone) VALUES ('Smoke', 'TestOne', '555-555-0100') RETURNING id INTO v_cust1;
--   INSERT INTO public.bookings (customer_id, service_type) VALUES (v_cust1, 'junk_removal') RETURNING id INTO v_booking1;
--   INSERT INTO public.bookings (customer_id, service_type) VALUES (v_cust1, 'junk_removal') RETURNING id INTO v_booking2;
--
--   INSERT INTO public.invoices (created_by, status, booking_id, customer_id, invoice_number, total_amount, finalized_at)
--     VALUES ('smoke-test', 'finalized', v_booking1, v_cust1, 'SMOKE-A-1', 150.00, now())
--     RETURNING id INTO v_invoice1;
--   INSERT INTO public.invoices (created_by, status, customer_id, invoice_number, total_amount, finalized_at)
--     VALUES ('smoke-test', 'finalized', v_cust1, 'SMOKE-A-2', 75.00, now())
--     RETURNING id INTO v_invoice_standalone;
--
--   -- TEST 1: standalone invoice payment shape — invoice_id set, booking_id
--   -- NULL, classified true — must be accepted.
--   INSERT INTO public.job_payments (invoice_id, booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--     VALUES (v_invoice_standalone, NULL, 75.00, 'venmo', 'payment', current_date, true);
--   RAISE NOTICE 'TEST 1 (standalone shape): passed — insert accepted.';
--
--   -- TEST 2: attached invoice payment shape — invoice_id + matching
--   -- booking_id, classified true — must be accepted.
--   INSERT INTO public.job_payments (invoice_id, booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--     VALUES (v_invoice1, v_booking1, 25.00, 'zelle', 'payment', current_date, true);
--   RAISE NOTICE 'TEST 2 (attached shape): passed — insert accepted.';
--
--   -- TEST 3: mismatched booking rejection. invoice1 is attached to
--   -- booking1 — a row claiming invoice1 + booking2 must be rejected.
--   BEGIN
--     INSERT INTO public.job_payments (invoice_id, booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--       VALUES (v_invoice1, v_booking2, 10.00, 'cash', 'payment', current_date, true);
--     RAISE EXCEPTION 'TEST 3 (mismatched booking): expected rejection but insert succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%does not exactly match%' THEN RAISE; END IF;
--     RAISE NOTICE 'TEST 3 (mismatched booking rejection): passed.';
--   END;
--
--   -- TEST 4: missing booking on attached invoice rejection. invoice1 is
--   -- attached to booking1 — a row claiming invoice1 + booking_id NULL
--   -- must ALSO be rejected.
--   BEGIN
--     INSERT INTO public.job_payments (invoice_id, booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--       VALUES (v_invoice1, NULL, 10.00, 'cash', 'payment', current_date, true);
--     RAISE EXCEPTION 'TEST 4 (missing booking on attached invoice): expected rejection but insert succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%does not exactly match%' THEN RAISE; END IF;
--     RAISE NOTICE 'TEST 4 (missing booking on attached invoice rejection): passed.';
--   END;
--
--   -- TEST 5: job_payments_source_chk — booking_id AND invoice_id both
--   -- NULL must be rejected (no source at all).
--   BEGIN
--     INSERT INTO public.job_payments (invoice_id, booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--       VALUES (NULL, NULL, 10.00, 'cash', 'payment', current_date, true);
--     RAISE EXCEPTION 'TEST 5 (no source): expected rejection but insert succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%job_payments_source_chk%' THEN RAISE; END IF;
--     RAISE NOTICE 'TEST 5 (job_payments_source_chk rejection): passed.';
--   END;
--
--   -- TEST 6: job_payments_invoice_id_requires_classified_chk —
--   -- invoice_id set but invoice_id_classified = false must be rejected.
--   BEGIN
--     INSERT INTO public.job_payments (invoice_id, booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--       VALUES (v_invoice_standalone, NULL, 10.00, 'cash', 'payment', current_date, false);
--     RAISE EXCEPTION 'TEST 6 (invoice_id without classification): expected rejection but insert succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%job_payments_invoice_id_requires_classified_chk%' THEN RAISE; END IF;
--     RAISE NOTICE 'TEST 6 (invoice_id_requires_classified rejection): passed.';
--   END;
--
--   -- TEST 7: baseline unaffected case — a plain job-level-only row
--   -- (booking_id set, invoice_id NULL, classified true) must still be
--   -- accepted, even though booking1 already has invoice1 attached — the
--   -- SCHEMA has no opinion about whether this "should" also carry
--   -- invoice1 (that policy lives in the application resolver, not built
--   -- yet); the schema only enforces internal row consistency.
--   INSERT INTO public.job_payments (invoice_id, booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--     VALUES (NULL, v_booking1, 5.00, 'other', 'payment', current_date, true);
--   RAISE NOTICE 'TEST 7 (baseline job-level-only row): passed — insert accepted.';
--
--   RAISE NOTICE 'All Stage A smoke tests passed.';
-- END;
-- $$;
--
-- ROLLBACK;

-- =======================================================================
-- Rollback (reference only — not executed as part of this file; reverse
-- of the migration transaction above). Only clean if NO Stage A
-- application code has shipped yet — once Stage A's app is writing
-- invoice_id/invoice_id_classified, this rollback would discard that
-- attribution data, not just schema.
-- =======================================================================
-- DROP TRIGGER IF EXISTS job_payments_validate_attribution_trg ON public.job_payments;
-- DROP FUNCTION IF EXISTS public.job_payments_validate_attribution();
--
-- ALTER TABLE public.job_payments DROP CONSTRAINT IF EXISTS job_payments_invoice_id_requires_classified_chk;
-- ALTER TABLE public.job_payments DROP CONSTRAINT IF EXISTS job_payments_source_chk;
-- DROP INDEX IF EXISTS job_payments_invoice_id_idx;
-- ALTER TABLE public.job_payments DROP COLUMN IF EXISTS invoice_id_classified;
-- ALTER TABLE public.job_payments DROP COLUMN IF EXISTS invoice_id;
-- ALTER TABLE public.job_payments ALTER COLUMN booking_id SET NOT NULL;
--
-- DROP INDEX IF EXISTS invoices_booking_id_active_original_uniq;
-- CREATE UNIQUE INDEX invoices_booking_id_active_uniq ON public.invoices (booking_id) WHERE status <> 'void'; -- restores the pre-Phase-3D index
-- ALTER TABLE public.invoices
--   DROP CONSTRAINT IF EXISTS invoices_supplemental_requires_booking_chk,
--   DROP CONSTRAINT IF EXISTS invoices_invoice_kind_chk,
--   DROP COLUMN IF EXISTS invoice_kind;
-- ALTER TABLE public.invoices ALTER COLUMN booking_id SET NOT NULL;
