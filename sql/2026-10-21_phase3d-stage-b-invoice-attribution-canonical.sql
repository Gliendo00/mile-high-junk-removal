-- Phase 3D Stage B — Invoice ledger attribution: canonical switch.
--
-- Requires Stage A (sql/2026-10-21_phase3d-stage-a-invoice-attribution-
-- compat.sql) to have been applied AND Stage A's application code
-- (the centralized job_payments write resolver documented in that
-- file's header) to have been promoted and live for a comfortable
-- period before this runs. The hard, SQL-checkable requirement is
-- narrower than that, though — see "Preconditions" below.
--
-- NOT executed by this session — drafted for Rocky's review.
--
-- =======================================================================
-- Why this is safe to run whenever, with no timing guesswork
-- =======================================================================
--
-- The question this whole design answers is: how do we tell apart a
-- job_payments row that NEEDS backfilling (written by code with no idea
-- invoice_id exists) from one that's INTENTIONALLY unattributed under
-- the new model (a generic job payment, deliberately not paying down
-- any invoice)? The answer is temporal, not structural, and the
-- ordering of SQL vs application releases is what makes it provable:
--
--   - Stage A's application (once promoted) attributes EVERY payment to
--     a booking's live original invoice, whenever one exists at write
--     time — it never intentionally leaves such a payment unattributed.
--     The ONLY unattributed rows Stage A's app can produce are for
--     bookings that genuinely have no live original invoice, or payments
--     written in the brief window before an invoice is created.
--   - This file's SQL runs and COMMITS before Stage B's application —
--     the only thing that will ever intentionally write
--     invoice_id = NULL for a booking that DOES have a live invoice —
--     is promoted.
--   - Therefore, at the exact moment this file's backfill runs, nothing
--     in the system has EVER produced an "intentionally unattributed
--     despite a live invoice" row. Every currently-NULL row for a
--     booking with a live original invoice is unconditionally a gap to
--     close — not a guess, a structural fact about what code has
--     existed up to this point.
--
-- invoice_id_classified's role here is narrower than it might first
-- appear: it is NOT what decides which rows the live-invoice sweep
-- touches (that sweep is deliberately unconditional — see §1 below). It
-- exists to (a) retire the "unreviewed" state permanently once this file
-- finishes, and (b) make a FUTURE insert path that forgets to set it
-- fail loudly rather than silently recreating ambiguity (see §5).
--
-- The one case this file does NOT try to fix automatically: an original
-- invoice that was voided and replaced during Stage A, with payments
-- already attributed to the voided one. Reassigning invoice_id from one
-- real invoice to another would violate the "invoice_id is permanent
-- once set" guarantee this whole design depends on, and would rewrite
-- a historical attribution no one asked to rewrite. §2's mandatory
-- assertion detects this by name and refuses to commit rather than
-- silently papering over it — a human decides what to do, this file
-- never guesses.
--
-- =======================================================================
-- Preconditions (read before running) — a hard release gate, not advice
-- =======================================================================
--
-- SQL-checkable (the preflight below confirms these):
--   - Stage A's schema (invoice_kind, job_payments.invoice_id,
--     invoice_id_classified, both new CHECKs, the attribution trigger)
--     is live.
--   - This file has not already been run (the lockdown CHECK and the
--     attach RPC don't exist yet; invoice_id_classified still has its
--     DEFAULT false).
--
-- NOT SQL-checkable — operational facts that MUST be confirmed before
-- running this file, not merely recommended. A still-live pre-Stage-A
-- application is NOT safe here: that safety only ever held DURING this
-- file's own transaction, while invoice_id_classified still carried its
-- DEFAULT false. The instant §5's lockdown commits, the default is
-- gone, the column stays NOT NULL, and
-- job_payments_invoice_id_classified_true_chk requires true — a
-- pre-Stage-A INSERT that omits this column (every one of them does;
-- that code has never heard of it) would then fail outright on the
-- very next booking payment anyone tries to record. This file's
-- correctness proof (see header above) depends entirely on Stage A's
-- application already being the one live and writing — a hard
-- requirement, not a nice-to-have:
--
--   - Stage A's application — the version whose every job_payments
--     insert/upsert path explicitly sets invoice_id_classified = true
--     via the centralized resolver — is CONFIRMED live in production.
--     Not "should be," not "probably is": confirmed, via the release
--     gate immediately below.
--   - Stage B's OWN application (reading invoice_id canonically, writing
--     deliberate NULLs) is NOT yet promoted.
--
-- =======================================================================
-- RELEASE GATE — confirm every item below before running this file.
-- None of these are SQL-checkable; this is a human sign-off, not a
-- preflight query.
-- =======================================================================
--   [ ] Production's currently-deployed SHA is the approved Stage A
--       application SHA (the one that added the centralized
--       resolveJobPaymentAttribution()-style resolver) — checked
--       against the actual deployment, not assumed.
--   [ ] A repo audit at that SHA confirms only the two known
--       job_payments write functions exist —
--       mirrorStripePaymentToLedger() (api/_lib/job-payments-ledger.js)
--       and handleCreateJobPayment() (api/admin/booking.js) — no third
--       insert/upsert path has been added since Stage A's own file was
--       drafted.
--   [ ] Both of those functions are confirmed using the centralized
--       Stage A attribution resolver (explicit invoiceId short-circuit,
--       else the live-original-invoice lookup) — not a partial or
--       ad hoc version of it.
--   [ ] Stage A's application test suite is passing at that SHA.
--
-- =======================================================================
-- 0. PREFLIGHT — run this FIRST, by itself. Read-only.
-- =======================================================================

-- 1. Stage A's schema is live.
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'job_payments'
--   and column_name in ('invoice_id', 'invoice_id_classified');
-- -- expect: two rows
-- select column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'job_payments' and column_name = 'invoice_id_classified';
-- -- expect: 'false' — confirms this file has not already run (its own
-- -- §5 removes this default)
-- select conname from pg_constraint where conrelid = 'public.job_payments'::regclass
--   and conname in ('job_payments_source_chk', 'job_payments_invoice_id_requires_classified_chk');
-- -- expect: two rows
-- select tgname from pg_trigger
--   where tgrelid = 'public.job_payments'::regclass and tgname = 'job_payments_validate_attribution_trg';
-- -- expect: one row
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoices' and column_name = 'invoice_kind';
-- -- expect: one row

-- 2. This file has not already been run.
-- select conname from pg_constraint where conrelid = 'public.job_payments'::regclass
--   and conname = 'job_payments_invoice_id_classified_true_chk';
-- select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'attach_invoice_to_booking';
-- -- both expect: zero rows

-- 3. job_payments' current service_role grant shape (confirms what §4
--    below is about to extend).
-- select column_name, privilege_type from information_schema.role_column_grants
--   where table_schema = 'public' and table_name = 'job_payments' and grantee = 'service_role'
--   and privilege_type = 'UPDATE' order by column_name;
-- -- expect exactly: updated_at, voided_at, voided_reason (3 rows, unchanged from Stage A)

-- 4. Informational only — how many rows currently need the sweeps below.
--    Not a pass/fail gate, just a sanity read before committing to run.
-- select count(*) filter (where invoice_id_classified = false) as unclassified_rows,
--        count(*) filter (where invoice_id IS NULL) as unattributed_rows
-- from public.job_payments;

-- =======================================================================
-- MIGRATION — one atomic transaction. No CONCURRENTLY anywhere below.
-- Every load-bearing assertion in §2 below runs INSIDE this transaction,
-- before COMMIT — a RAISE EXCEPTION there rolls back everything in this
-- file (sweeps, RPC, lockdown — none of it), leaving production exactly
-- as it was. No IF NOT EXISTS/OR REPLACE — preflight already confirmed
-- none of these objects exist.
-- =======================================================================
BEGIN;

-- -----------------------------------------------------------------------
-- 1. Backfill — two sweeps.
-- -----------------------------------------------------------------------

-- Sweep A — live-invoice attribution. Deliberately UNCONDITIONAL, not
-- filtered by invoice_id_classified — see this file's header for why
-- that's safe specifically here (this runs before Stage B's app exists,
-- so nothing yet intentionally leaves such a row unattributed). This is
-- the sweep that actually does the balance-preserving work, covering
-- both pre-Stage-A legacy rows AND any Stage-A-era "payment written
-- moments before its invoice" race.
UPDATE public.job_payments jp
SET invoice_id = i.id, invoice_id_classified = true
FROM public.invoices i
WHERE i.booking_id = jp.booking_id
  AND i.status <> 'void'
  AND i.invoice_kind = 'original'
  AND jp.invoice_id IS NULL;

-- Sweep B — blanket classification. Retires `false` for every row that
-- genuinely has no eligible invoice to attribute to (nothing left to do
-- for them; this just closes out their lifecycle so §5's lockdown can
-- proceed).
UPDATE public.job_payments
SET invoice_id_classified = true
WHERE invoice_id_classified = false;

-- -----------------------------------------------------------------------
-- 2. MANDATORY ASSERTIONS — load-bearing, not advisory. Every one of
--    these RAISEs (and rolls back the whole transaction) rather than
--    letting an unproven state reach COMMIT.
-- -----------------------------------------------------------------------
DO $$
DECLARE
  v_void_replace_count integer;
  v_unattributed_count integer;
  v_unclassified_count integer;
  v_drift_count integer;
  v_trigger_inconsistent_count integer;
BEGIN
  -- (a) Void-original -> replacement-original detection — named and
  -- specific, checked first so its diagnostic message (not a generic
  -- "balance drift") is what Rocky sees if this is the cause. Finds any
  -- job_payments row attributed to a VOID original invoice whose
  -- booking currently has a DIFFERENT, live original invoice — the one
  -- case this file deliberately does not auto-fix (see header).
  SELECT count(*) INTO v_void_replace_count
  FROM public.job_payments jp
  JOIN public.invoices i_voided ON i_voided.id = jp.invoice_id
  JOIN public.invoices i_live
    ON i_live.booking_id = i_voided.booking_id
    AND i_live.status <> 'void'
    AND i_live.invoice_kind = 'original'
    AND i_live.id <> i_voided.id
  WHERE i_voided.status = 'void'
    AND i_voided.invoice_kind = 'original';

  IF v_void_replace_count > 0 THEN
    RAISE EXCEPTION 'VOID-AND-REPLACE EDGE CASE DETECTED: % job_payments row(s) are attributed to a now-void original invoice whose booking has a different, live original invoice. This is the known edge case this migration deliberately does not auto-resolve — reassigning invoice_id would violate its permanence guarantee and rewrite historical attribution. Refusing to commit. Inspect: select jp.id, jp.invoice_id, jp.booking_id, i.status from job_payments jp join invoices i on i.id = jp.invoice_id where i.status = ''void'' and i.invoice_kind = ''original'' and exists (select 1 from invoices i2 where i2.booking_id = i.booking_id and i2.status <> ''void'' and i2.invoice_kind = ''original'' and i2.id <> i.id); — decide manually whether to re-point, void the duplicate history, or document and proceed, then re-run this file.',
      v_void_replace_count;
  END IF;

  -- (b) Row-completeness — UNCONDITIONAL (not classified-filtered, same
  -- reasoning as sweep A): every job_payments row for a booking with a
  -- live original invoice must carry that invoice's id. Catches PARTIAL
  -- omission that a sum-only comparison can mask (e.g. one omitted
  -- +$100 and one omitted -$100 net to zero but are still both gaps).
  SELECT count(*) INTO v_unattributed_count
  FROM public.job_payments jp
  JOIN public.invoices i ON i.booking_id = jp.booking_id AND i.status <> 'void' AND i.invoice_kind = 'original'
  WHERE jp.invoice_id IS DISTINCT FROM i.id;

  IF v_unattributed_count > 0 THEN
    RAISE EXCEPTION 'ROW-COMPLETENESS ASSERTION FAILED: % job_payments row(s) for a booking with a live non-void original invoice do not carry that invoice''s id after the backfill. Refusing to commit — investigate before re-running.',
      v_unattributed_count;
  END IF;

  -- (c) Zero remaining unclassified rows — confirms sweeps A+B together
  -- actually finished the job.
  SELECT count(*) INTO v_unclassified_count FROM public.job_payments WHERE invoice_id_classified = false;

  IF v_unclassified_count > 0 THEN
    RAISE EXCEPTION 'CLASSIFICATION ASSERTION FAILED: % job_payments row(s) still have invoice_id_classified = false after both backfill sweeps. Refusing to commit.',
      v_unclassified_count;
  END IF;

  -- (d) Old booking-wide net balance == new invoice_id-keyed net balance,
  -- for every existing non-void original invoice with a booking — an
  -- independent proof via sums, using a completely different
  -- computation path than (b) above.
  SELECT count(*) INTO v_drift_count
  FROM public.invoices i
  WHERE i.status <> 'void' AND i.invoice_kind = 'original' AND i.booking_id IS NOT NULL
    AND (
      SELECT coalesce(sum(CASE WHEN jp.payment_type = 'refund' THEN -jp.amount ELSE jp.amount END), 0)
      FROM public.job_payments jp WHERE jp.booking_id = i.booking_id AND jp.voided_at IS NULL
    ) <> (
      SELECT coalesce(sum(CASE WHEN jp.payment_type = 'refund' THEN -jp.amount ELSE jp.amount END), 0)
      FROM public.job_payments jp WHERE jp.invoice_id = i.id AND jp.voided_at IS NULL
    );

  IF v_drift_count > 0 THEN
    RAISE EXCEPTION 'ZERO-DRIFT ASSERTION FAILED: % non-void original invoice(s) have a different net balance under the new invoice_id-keyed formula than the old booking_id-keyed formula. Refusing to commit — investigate before re-running.',
      v_drift_count;
  END IF;

  -- (e) Attribution-trigger consistency, table-wide, independent of the
  -- trigger having fired correctly on any one write: for every row with
  -- invoice_id set, booking_id must exactly equal that invoice's own
  -- booking_id, right now, for the whole table.
  SELECT count(*) INTO v_trigger_inconsistent_count
  FROM public.job_payments jp
  JOIN public.invoices i ON i.id = jp.invoice_id
  WHERE jp.booking_id IS DISTINCT FROM i.booking_id;

  IF v_trigger_inconsistent_count > 0 THEN
    RAISE EXCEPTION 'TRIGGER-CONSISTENCY ASSERTION FAILED: % job_payments row(s) have an invoice_id whose booking_id does not match that invoice''s own booking_id. This should be structurally impossible given the attribution trigger — refusing to commit; this indicates the trigger was bypassed or altered.',
      v_trigger_inconsistent_count;
  END IF;

  RAISE NOTICE 'All Stage B assertions passed: no void-and-replace conflicts, row-complete, fully classified, zero balance drift, trigger-consistent.';
END;
$$;

-- -----------------------------------------------------------------------
-- 3. attach_invoice_to_booking() — the one atomic, service-role-only RPC
--    the application layer calls for Attach-to-Job, AFTER (not instead
--    of) resolving the invoice's own Pay Now PaymentIntent/claim state at
--    the application layer via the existing withInvoicePaymentLock()/
--    resolveInvoicePaymentIntentForMutation() machinery in
--    api/_lib/invoice-helpers.js — this RPC is the mutation that function
--    wraps, not a replacement for it. It additionally re-verifies the
--    payment claim token it's handed (never trusting "the caller says it
--    already checked"), matching the exact established pattern of
--    create_invoice_delivery_attempt()/accept_invoice_delivery_attempt()
--    in sql/2026-10-19_phase3-invoice-delivery-pay-now.sql.
--
--    p_payment_claim_token: must be non-null and must exactly match
--    invoices.payment_claim_token (NULL-safe IS DISTINCT FROM). A
--    successful attach always ends with the claim released, in the same
--    transaction.
--
--    active_stripe_payment_intent_id IS NOT NULL is rejected outright —
--    the hard backstop; the application layer's claim-acquire step
--    should already guarantee this is null by the time a claim token
--    exists to present here.
--
--    booking_id backfill on job_payments runs AFTER invoices.booking_id
--    is set, in that order — required, not arbitrary, given Stage A's
--    attribution trigger (reversing the order would make this very
--    UPDATE trip it, since the invoice's booking_id would still read as
--    the old value at the moment the trigger fires).
--
--    invoice_id is never read, written, or cleared by this function.
-- -----------------------------------------------------------------------
CREATE FUNCTION public.attach_invoice_to_booking(
  p_invoice_id uuid,
  p_booking_id uuid,
  p_payment_claim_token uuid,
  p_actor_email text
) RETURNS public.invoices
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice public.invoices;
  v_booking record;
  v_existing_original_count integer;
BEGIN
  IF p_payment_claim_token IS NULL THEN
    RAISE EXCEPTION 'payment claim token must not be null';
  END IF;

  SELECT * INTO v_invoice FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice % does not exist', p_invoice_id;
  END IF;

  IF v_invoice.payment_claim_token IS DISTINCT FROM p_payment_claim_token THEN
    RAISE EXCEPTION 'payment claim for invoice % is not owned by token %; refusing to attach',
      p_invoice_id, p_payment_claim_token;
  END IF;

  -- Defensive backstop — see this function's header.
  IF v_invoice.active_stripe_payment_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'invoice % still has an active Stripe PaymentIntent (%); refusing to attach until it is resolved',
      p_invoice_id, v_invoice.active_stripe_payment_intent_id;
  END IF;

  IF v_invoice.status = 'void' THEN
    RAISE EXCEPTION 'invoice % is void and cannot be attached to a job', p_invoice_id;
  END IF;

  IF v_invoice.booking_id IS NOT NULL THEN
    RAISE EXCEPTION 'invoice % is already attached to booking %; attach is a one-time operation (no detach/re-attach)',
      p_invoice_id, v_invoice.booking_id;
  END IF;

  SELECT id, customer_id, service_type INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking % does not exist', p_booking_id;
  END IF;

  -- Same rule handleCreateInvoice() already enforces for a brand-new
  -- invoice (api/admin/booking.js) — a pickup job's auto-generated
  -- booking can never carry an invoice; bill the primary rental instead.
  IF v_booking.service_type = 'dumpster_pickup' THEN
    RAISE EXCEPTION 'booking % is a pickup job and cannot receive an invoice; attach to the primary rental instead',
      p_booking_id;
  END IF;

  IF v_invoice.customer_id IS DISTINCT FROM v_booking.customer_id THEN
    RAISE EXCEPTION 'invoice % belongs to customer % but booking % belongs to customer %; refusing to attach across clients',
      p_invoice_id, v_invoice.customer_id, p_booking_id, v_booking.customer_id;
  END IF;

  SELECT count(*) INTO v_existing_original_count
    FROM public.invoices
    WHERE booking_id = p_booking_id AND status <> 'void' AND invoice_kind = 'original';
  IF v_existing_original_count > 0 THEN
    RAISE EXCEPTION 'booking % already has an active original invoice; cannot attach a second one',
      p_booking_id;
  END IF;

  UPDATE public.invoices
  SET booking_id = p_booking_id,
      payment_claim_token = NULL,
      payment_claimed_at = NULL,
      updated_by = p_actor_email,
      updated_at = now()
  WHERE id = p_invoice_id
  RETURNING * INTO v_invoice;

  -- Backfill ONLY rows that don't already have a booking_id — on a
  -- standalone invoice every one of its own job_payments rows qualifies.
  UPDATE public.job_payments
  SET booking_id = p_booking_id
  WHERE invoice_id = p_invoice_id AND booking_id IS NULL;

  RETURN v_invoice;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_invoice_to_booking(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attach_invoice_to_booking(uuid, uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.attach_invoice_to_booking(uuid, uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.attach_invoice_to_booking(uuid, uuid, uuid, text) TO service_role;

-- -----------------------------------------------------------------------
-- 4. Grant extension — job_payments.booking_id becomes UPDATE-able by
--    service_role, needed ONLY for the Attach RPC's backfill step just
--    above. REVOKE-ALL-then-GRANT-exact, same deterministic pattern as
--    sql/2026-09-19_phase3c-stage3-service-role-grants.sql. invoice_id
--    and invoice_id_classified are deliberately NOT added — invoice_id
--    stays permanently non-updatable (see Stage A's header), and nothing
--    ever needs to UPDATE invoice_id_classified after this file's own
--    sweeps run (every row is now permanently true; see §5).
-- -----------------------------------------------------------------------
REVOKE ALL ON public.job_payments FROM service_role;
GRANT SELECT, INSERT ON public.job_payments TO service_role;
GRANT UPDATE (voided_at, voided_reason, updated_at, booking_id) ON public.job_payments TO service_role;

-- -----------------------------------------------------------------------
-- 5. Marker lockdown. By this point in the transaction, §2(c) has
--    already proven zero invoice_id_classified = false rows remain —
--    this is safe to add now. After this, `false` can never be stored
--    again: the dropped DEFAULT forces every future INSERT to specify
--    the column explicitly (or fail NOT NULL), and the CHECK forces that
--    explicit value to be true (or fail the CHECK). Stage A is
--    permanently the only period where `false` ever had meaning.
-- -----------------------------------------------------------------------
ALTER TABLE public.job_payments ALTER COLUMN invoice_id_classified DROP DEFAULT;
ALTER TABLE public.job_payments
  ADD CONSTRAINT job_payments_invoice_id_classified_true_chk CHECK (invoice_id_classified = true);

COMMIT;

-- =======================================================================
-- 6. Verification (re-run any of these any time to re-confirm current
--    state; all read-only).
-- =======================================================================

-- Backfill/classification state.
-- select count(*) from public.job_payments where invoice_id_classified = false; -- expect: 0
-- select column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'job_payments' and column_name = 'invoice_id_classified';
-- -- expect: NULL (default dropped)
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.job_payments'::regclass and conname = 'job_payments_invoice_id_classified_true_chk';

-- Zero-drift, re-confirmed independently of the in-transaction assertion.
-- select i.id as invoice_id, i.invoice_number, old_fmt.old_net, new_fmt.new_net
-- from public.invoices i
-- join lateral (
--   select coalesce(sum(case when jp.payment_type = 'refund' then -jp.amount else jp.amount end), 0) as old_net
--   from public.job_payments jp where jp.booking_id = i.booking_id and jp.voided_at is null
-- ) old_fmt on true
-- join lateral (
--   select coalesce(sum(case when jp.payment_type = 'refund' then -jp.amount else jp.amount end), 0) as new_net
--   from public.job_payments jp where jp.invoice_id = i.id and jp.voided_at is null
-- ) new_fmt on true
-- where i.status <> 'void' and i.invoice_kind = 'original' and i.booking_id is not null
--   and old_fmt.old_net <> new_fmt.new_net;
-- -- expect: zero rows

-- Grants.
-- select has_column_privilege('service_role', 'public.job_payments', 'booking_id', 'UPDATE');      -- expect true (new)
-- select has_column_privilege('service_role', 'public.job_payments', 'invoice_id', 'UPDATE');       -- expect false (permanent)
-- select has_column_privilege('service_role', 'public.job_payments', 'invoice_id_classified', 'UPDATE'); -- expect false

-- RPC.
-- select p.proname, pg_get_function_identity_arguments(p.oid) from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'attach_invoice_to_booking';
-- select has_function_privilege('anon', 'public.attach_invoice_to_booking(uuid,uuid,uuid,text)', 'EXECUTE'); -- expect false
-- select has_function_privilege('authenticated', 'public.attach_invoice_to_booking(uuid,uuid,uuid,text)', 'EXECUTE'); -- expect false
-- select has_function_privilege('service_role', 'public.attach_invoice_to_booking(uuid,uuid,uuid,text)', 'EXECUTE'); -- expect true

-- =======================================================================
-- OPTIONAL functional smoke suite — exercises every behavioral guarantee
-- this file adds. Operates ENTIRELY on throwaway fixture rows it creates
-- itself and ends in ROLLBACK — nothing it does is ever kept, and it
-- never reads or touches any real production row. Run as its own
-- script, any time after this file's migration above has committed.
-- =======================================================================
-- BEGIN;
--
-- DO $$
-- DECLARE
--   v_cust1 uuid; v_cust2 uuid;
--   v_booking1 uuid; v_booking2 uuid; v_booking3 uuid; v_booking4 uuid;
--   v_booking5 uuid; v_booking6 uuid; v_booking7 uuid; v_booking8 uuid;
--   v_invoice1 uuid; v_invoiceA uuid; v_invoiceB uuid;
--   v_invoice_standalone uuid; v_invoice_standalone2 uuid;
--   v_invoice7a uuid; v_invoice8 uuid;
--   v_claim uuid; v_bad_claim uuid; v_result public.invoices;
--   v_count integer;
-- BEGIN
--   INSERT INTO public.customers (first_name, last_name) VALUES ('Smoke', 'TestOne') RETURNING id INTO v_cust1;
--   INSERT INTO public.customers (first_name, last_name) VALUES ('Smoke', 'TestTwo') RETURNING id INTO v_cust2;
--   INSERT INTO public.bookings (customer_id, service_type) VALUES (v_cust1, 'junk_removal') RETURNING id INTO v_booking1;
--   INSERT INTO public.bookings (customer_id, service_type) VALUES (v_cust1, 'junk_removal') RETURNING id INTO v_booking2;
--   INSERT INTO public.bookings (customer_id, service_type) VALUES (v_cust1, 'junk_removal') RETURNING id INTO v_booking3;
--   INSERT INTO public.bookings (customer_id, service_type) VALUES (v_cust1, 'junk_removal') RETURNING id INTO v_booking4;
--   INSERT INTO public.bookings (customer_id, service_type) VALUES (v_cust1, 'junk_removal') RETURNING id INTO v_booking5;
--   INSERT INTO public.bookings (customer_id, service_type) VALUES (v_cust1, 'junk_removal') RETURNING id INTO v_booking6;
--   INSERT INTO public.bookings (customer_id, service_type) VALUES (v_cust1, 'junk_removal') RETURNING id INTO v_booking7;
--   INSERT INTO public.bookings (customer_id, service_type) VALUES (v_cust2, 'junk_removal') RETURNING id INTO v_booking8;
--
--   -- By the time this smoke suite runs, the real migration above has
--   -- already committed job_payments_invoice_id_classified_true_chk —
--   -- so a literal `invoice_id_classified = false` row (needed to
--   -- simulate the pre-lockdown/legacy world for TESTs 1 and 3) would
--   -- otherwise be rejected by a constraint violation that has nothing
--   -- to do with what those tests are proving. Temporarily suspend the
--   -- lockdown for exactly the tests that need to simulate "before
--   -- lockdown," inside this same transaction that ends in ROLLBACK
--   -- regardless — then restore it before TEST 10 proves the restored
--   -- lockdown actually rejects a violation, mirroring the real
--   -- before/after sequence rather than pretending both coexist.
--   ALTER TABLE public.job_payments DROP CONSTRAINT job_payments_invoice_id_classified_true_chk;
--
--   -- ---------------------------------------------------------------
--   -- TEST 1: legacy backfill. A classified=false payment (simulating a
--   -- pre-Stage-A row) predating its booking's eventual invoice must be
--   -- swept up by the SAME unconditional-sweep rule this file's real
--   -- migration already ran over production — re-proved here scoped to
--   -- one throwaway booking.
--   -- ---------------------------------------------------------------
--   INSERT INTO public.job_payments (booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--     VALUES (v_booking1, 100.00, 'cash', 'payment', current_date, false);
--   INSERT INTO public.invoices (created_by, status, booking_id, customer_id, invoice_number, total_amount, finalized_at)
--     VALUES ('smoke-test', 'finalized', v_booking1, v_cust1, 'SMOKE-B-1', 100.00, now())
--     RETURNING id INTO v_invoice1;
--
--   UPDATE public.job_payments jp SET invoice_id = i.id, invoice_id_classified = true
--     FROM public.invoices i
--     WHERE i.booking_id = jp.booking_id AND i.status <> 'void' AND i.invoice_kind = 'original'
--       AND jp.invoice_id IS NULL AND jp.booking_id = v_booking1;
--
--   SELECT count(*) INTO v_count FROM public.job_payments WHERE booking_id = v_booking1 AND invoice_id = v_invoice1;
--   ASSERT v_count = 1, 'TEST 1 (legacy backfill): expected the pre-existing payment backfilled, got ' || v_count;
--   RAISE NOTICE 'TEST 1 (legacy backfill): passed.';
--
--   -- ---------------------------------------------------------------
--   -- TEST 2: Stage-A-era race. A classified=TRUE row with invoice_id
--   -- NULL (simulating Stage A's resolver finding no invoice yet) on a
--   -- booking that gets its invoice created AFTER — the unconditional
--   -- sweep (not classified-filtered) must still catch it, proving the
--   -- design decision that a classified-filtered-only sweep would have
--   -- missed this.
--   -- ---------------------------------------------------------------
--   INSERT INTO public.job_payments (booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--     VALUES (v_booking2, 50.00, 'zelle', 'payment', current_date, true);
--   INSERT INTO public.invoices (created_by, status, booking_id, customer_id, invoice_number, total_amount, finalized_at)
--     VALUES ('smoke-test', 'finalized', v_booking2, v_cust1, 'SMOKE-B-2', 50.00, now());
--
--   UPDATE public.job_payments jp SET invoice_id = i.id, invoice_id_classified = true
--     FROM public.invoices i
--     WHERE i.booking_id = jp.booking_id AND i.status <> 'void' AND i.invoice_kind = 'original'
--       AND jp.invoice_id IS NULL AND jp.booking_id = v_booking2;
--
--   SELECT count(*) INTO v_count FROM public.job_payments WHERE booking_id = v_booking2 AND invoice_id IS NOT NULL;
--   ASSERT v_count = 1, 'TEST 2 (Stage-A-era race): expected the pre-invoice payment attributed despite already being classified=true, got ' || v_count;
--   RAISE NOTICE 'TEST 2 (Stage-A-era race caught by unconditional sweep): passed.';
--
--   -- ---------------------------------------------------------------
--   -- TEST 3: blanket classification sweep. A classified=false payment
--   -- on a booking with NO invoice at all ever gets classified=true,
--   -- invoice_id stays NULL.
--   -- ---------------------------------------------------------------
--   INSERT INTO public.job_payments (booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--     VALUES (v_booking3, 20.00, 'cash', 'payment', current_date, false);
--
--   UPDATE public.job_payments SET invoice_id_classified = true
--     WHERE invoice_id_classified = false AND booking_id = v_booking3;
--
--   SELECT count(*) INTO v_count FROM public.job_payments WHERE booking_id = v_booking3 AND invoice_id_classified = true AND invoice_id IS NULL;
--   ASSERT v_count = 1, 'TEST 3 (blanket sweep): expected the no-invoice payment classified with invoice_id still NULL, got ' || v_count;
--   RAISE NOTICE 'TEST 3 (blanket classification sweep): passed.';
--
--   -- Restore the lockdown now — every row inserted from this point on
--   -- in this smoke suite uses invoice_id_classified = true, matching
--   -- the real post-lockdown world these remaining tests run in.
--   ALTER TABLE public.job_payments
--     ADD CONSTRAINT job_payments_invoice_id_classified_true_chk CHECK (invoice_id_classified = true);
--
--   -- ---------------------------------------------------------------
--   -- TEST 4: row-completeness detection — isolated proof the check
--   -- query itself correctly flags PARTIAL omission (net balance could
--   -- agree while individual rows are still missing). Scoped to
--   -- v_booking4 only; does not re-run the real migration's assertion,
--   -- just the same query logic against a deliberately incomplete state.
--   -- ---------------------------------------------------------------
--   INSERT INTO public.invoices (created_by, status, booking_id, customer_id, invoice_number, total_amount, finalized_at)
--     VALUES ('smoke-test', 'finalized', v_booking4, v_cust1, 'SMOKE-B-4', 0.00, now());
--   INSERT INTO public.job_payments (booking_id, invoice_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--     VALUES (v_booking4, NULL, 100.00, 'cash', 'payment', current_date, true); -- deliberately left unattributed (classified is irrelevant to this check — it's unconditional)
--
--   SELECT count(*) INTO v_count
--   FROM public.job_payments jp
--   JOIN public.invoices i ON i.booking_id = jp.booking_id AND i.status <> 'void' AND i.invoice_kind = 'original'
--   WHERE jp.invoice_id IS DISTINCT FROM i.id AND jp.booking_id = v_booking4;
--   ASSERT v_count = 1, 'TEST 4 (row-completeness detection): expected the deliberately-unattributed row to be flagged, got ' || v_count;
--   RAISE NOTICE 'TEST 4 (row-completeness detection logic): passed.';
--
--   -- ---------------------------------------------------------------
--   -- TEST 5: void-and-replace detection — isolated proof. invoice A
--   -- (void) has an attributed payment; invoice B (live, same booking)
--   -- is the sole non-void original — the detection query must find it.
--   -- ---------------------------------------------------------------
--   INSERT INTO public.invoices (created_by, status, booking_id, customer_id, invoice_number, total_amount, finalized_at, voided_at, voided_reason)
--     VALUES ('smoke-test', 'void', v_booking5, v_cust1, 'SMOKE-B-5A', 30.00, now(), now(), 'smoke test void')
--     RETURNING id INTO v_invoiceA;
--   INSERT INTO public.invoices (created_by, status, booking_id, customer_id, invoice_number, total_amount, finalized_at)
--     VALUES ('smoke-test', 'finalized', v_booking5, v_cust1, 'SMOKE-B-5B', 30.00, now())
--     RETURNING id INTO v_invoiceB;
--   INSERT INTO public.job_payments (booking_id, invoice_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--     VALUES (v_booking5, v_invoiceA, 30.00, 'cash', 'payment', current_date, true);
--
--   SELECT count(*) INTO v_count
--   FROM public.job_payments jp
--   JOIN public.invoices i_voided ON i_voided.id = jp.invoice_id
--   JOIN public.invoices i_live
--     ON i_live.booking_id = i_voided.booking_id AND i_live.status <> 'void' AND i_live.invoice_kind = 'original' AND i_live.id <> i_voided.id
--   WHERE i_voided.status = 'void' AND i_voided.invoice_kind = 'original' AND jp.booking_id = v_booking5;
--   ASSERT v_count = 1, 'TEST 5 (void-and-replace detection): expected the stale attribution to be flagged, got ' || v_count;
--   RAISE NOTICE 'TEST 5 (void-and-replace detection logic): passed.';
--
--   -- ---------------------------------------------------------------
--   -- TEST 6: attach success + payment booking-backfill.
--   -- ---------------------------------------------------------------
--   INSERT INTO public.invoices (created_by, status, customer_id, invoice_number, total_amount, finalized_at)
--     VALUES ('smoke-test', 'finalized', v_cust1, 'SMOKE-B-6', 75.00, now())
--     RETURNING id INTO v_invoice_standalone;
--   INSERT INTO public.job_payments (invoice_id, booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--     VALUES (v_invoice_standalone, NULL, 75.00, 'venmo', 'payment', current_date, true);
--
--   v_claim := gen_random_uuid();
--   UPDATE public.invoices SET payment_claim_token = v_claim, payment_claimed_at = now() WHERE id = v_invoice_standalone;
--   SELECT * INTO v_result FROM public.attach_invoice_to_booking(v_invoice_standalone, v_booking6, v_claim, 'smoke-test');
--   ASSERT v_result.booking_id = v_booking6, 'TEST 6: expected invoice.booking_id set to booking6';
--   ASSERT v_result.payment_claim_token IS NULL, 'TEST 6: expected the payment claim released by attach';
--
--   SELECT count(*) INTO v_count FROM public.job_payments WHERE invoice_id = v_invoice_standalone AND booking_id = v_booking6;
--   ASSERT v_count = 1, 'TEST 6: expected the pre-existing standalone payment backfilled to booking6, got ' || v_count;
--   RAISE NOTICE 'TEST 6 (attach success + payment backfill): passed.';
--
--   -- ---------------------------------------------------------------
--   -- TEST 7: wrong/stale/null payment claim rejection.
--   -- ---------------------------------------------------------------
--   INSERT INTO public.invoices (created_by, status, customer_id, invoice_number, total_amount, finalized_at)
--     VALUES ('smoke-test', 'finalized', v_cust1, 'SMOKE-B-7', 20.00, now())
--     RETURNING id INTO v_invoice_standalone2;
--
--   v_bad_claim := gen_random_uuid();
--   BEGIN
--     PERFORM public.attach_invoice_to_booking(v_invoice_standalone2, v_booking6, v_bad_claim, 'smoke-test');
--     RAISE EXCEPTION 'TEST 7a (no claim held): expected rejection but attach succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%not owned by token%' THEN RAISE; END IF;
--   END;
--
--   v_claim := gen_random_uuid();
--   UPDATE public.invoices SET payment_claim_token = v_claim, payment_claimed_at = now() WHERE id = v_invoice_standalone2;
--   BEGIN
--     PERFORM public.attach_invoice_to_booking(v_invoice_standalone2, v_booking6, v_bad_claim, 'smoke-test');
--     RAISE EXCEPTION 'TEST 7b (wrong token): expected rejection but attach succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%not owned by token%' THEN RAISE; END IF;
--   END;
--
--   BEGIN
--     PERFORM public.attach_invoice_to_booking(v_invoice_standalone2, v_booking6, NULL, 'smoke-test');
--     RAISE EXCEPTION 'TEST 7c (null token): expected rejection but attach succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%must not be null%' THEN RAISE; END IF;
--   END;
--   RAISE NOTICE 'TEST 7 (wrong/stale/null payment claim rejection): passed.';
--
--   -- ---------------------------------------------------------------
--   -- TEST 8: existing-original conflict.
--   -- ---------------------------------------------------------------
--   INSERT INTO public.invoices (created_by, status, booking_id, customer_id, invoice_number, total_amount, finalized_at)
--     VALUES ('smoke-test', 'finalized', v_booking7, v_cust1, 'SMOKE-B-8A', 10.00, now())
--     RETURNING id INTO v_invoice7a;
--   v_claim := gen_random_uuid();
--   UPDATE public.invoices SET payment_claim_token = v_claim, payment_claimed_at = now() WHERE id = v_invoice_standalone2;
--   BEGIN
--     PERFORM public.attach_invoice_to_booking(v_invoice_standalone2, v_booking7, v_claim, 'smoke-test');
--     RAISE EXCEPTION 'TEST 8 (existing-original conflict): expected rejection but attach succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%already has an active original invoice%' THEN RAISE; END IF;
--     RAISE NOTICE 'TEST 8 (existing-original conflict rejection): passed.';
--   END;
--
--   -- ---------------------------------------------------------------
--   -- TEST 9: client mismatch.
--   -- ---------------------------------------------------------------
--   INSERT INTO public.invoices (created_by, status, customer_id, invoice_number, total_amount, finalized_at)
--     VALUES ('smoke-test', 'finalized', v_cust1, 'SMOKE-B-9', 10.00, now())
--     RETURNING id INTO v_invoice8;
--   v_claim := gen_random_uuid();
--   UPDATE public.invoices SET payment_claim_token = v_claim, payment_claimed_at = now() WHERE id = v_invoice8;
--   BEGIN
--     PERFORM public.attach_invoice_to_booking(v_invoice8, v_booking8, v_claim, 'smoke-test');
--     RAISE EXCEPTION 'TEST 9 (client mismatch): expected rejection but attach succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%refusing to attach across clients%' THEN RAISE; END IF;
--     RAISE NOTICE 'TEST 9 (client mismatch rejection): passed.';
--   END;
--
--   -- ---------------------------------------------------------------
--   -- TEST 10: marker lockdown. After the real migration's §5 has run,
--   -- an explicit attempt to insert invoice_id_classified = false must
--   -- be rejected by job_payments_invoice_id_classified_true_chk.
--   -- ---------------------------------------------------------------
--   BEGIN
--     INSERT INTO public.job_payments (booking_id, amount, payment_method, payment_type, payment_date, invoice_id_classified)
--       VALUES (v_booking8, 5.00, 'cash', 'payment', current_date, false);
--     RAISE EXCEPTION 'TEST 10 (lockdown): expected rejection but insert succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%job_payments_invoice_id_classified_true_chk%' THEN RAISE; END IF;
--     RAISE NOTICE 'TEST 10 (marker lockdown rejection): passed.';
--   END;
--
--   RAISE NOTICE 'All Stage B smoke tests passed.';
-- END;
-- $$;
--
-- ROLLBACK;

-- =======================================================================
-- Rollback (reference only — not executed as part of this file). Only
-- clean if NO Attach-to-Job, standalone invoice, or Stage-B-canonical
-- balance read has been exercised in production yet — once any of those
-- are live, this rollback would discard real attribution/state, not
-- just schema.
-- =======================================================================
-- ALTER TABLE public.job_payments DROP CONSTRAINT IF EXISTS job_payments_invoice_id_classified_true_chk;
-- ALTER TABLE public.job_payments ALTER COLUMN invoice_id_classified SET DEFAULT false;
--
-- REVOKE ALL ON public.job_payments FROM service_role;
-- GRANT SELECT, INSERT ON public.job_payments TO service_role;
-- GRANT UPDATE (voided_at, voided_reason, updated_at) ON public.job_payments TO service_role; -- restores the pre-Stage-B grant
--
-- REVOKE ALL ON FUNCTION public.attach_invoice_to_booking(uuid, uuid, uuid, text) FROM service_role;
-- DROP FUNCTION IF EXISTS public.attach_invoice_to_booking(uuid, uuid, uuid, text);
--
-- -- There is no clean way to "undo" the backfill sweeps themselves — they
-- -- only ever filled in a previously-NULL invoice_id or flipped
-- -- invoice_id_classified from false to true, never destroyed or
-- -- overwrote a real value. Reversing them would mean deciding, row by
-- -- row, whether a now-filled invoice_id was "supposed" to be NULL —
-- -- which is exactly the kind of casual historical rewrite this whole
-- -- design refuses to do automatically. If Stage B must be abandoned
-- -- after running, that is a product decision requiring manual review,
-- -- not a mechanical rollback.
