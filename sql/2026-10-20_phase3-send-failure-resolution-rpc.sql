-- Phase 3 follow-up — resolve_invoice_delivery_attempt_failure(): a third,
-- narrow service-role-only RPC closing a gap found during application-code
-- design review, AFTER the base Phase 3 migration (sql/2026-10-19_phase3-
-- invoice-delivery-pay-now.sql) was already applied to production and
-- verified. This is an ADDITIVE follow-up file, not a rewrite of that one
-- — production did not already have this function; it is being added now.
--
-- Gap: Send's reject/unrecoverable transitions were planned as a plain
-- conditional UPDATE — `WHERE id=:attemptId AND status='pending'`. That
-- condition says nothing about which REQUEST is doing the updating. A
-- request whose send_claim_token has since been reclaimed (it went stale;
-- another request took over) could still match that WHERE clause if the
-- row it's holding happens to still read 'pending' — and change a row now
-- legitimately owned by a newer request. The two existing Phase 3 RPCs
-- (create_invoice_delivery_attempt, accept_invoice_delivery_attempt)
-- already enforce claim ownership atomically; this third RPC gives the two
-- remaining single-row transitions (reject, mark-unrecoverable) the same
-- guarantee, rather than leaving them as an unguarded plain UPDATE in
-- application code.
--
-- Revision (same day, before apply): two correctness fixes found in
-- review of the first draft of this file:
--   1. The target_status validation (`NOT IN (...)`) was not NULL-safe —
--      Postgres's three-valued logic means `NULL NOT IN (...)` evaluates
--      to NULL, not TRUE, so the IF would NOT fire for a NULL
--      p_target_status and execution would fall through to the ELSE
--      branch later in the function and incorrectly mark the attempt
--      'unrecoverable'. Fixed with an explicit `p_target_status IS NULL
--      OR ...` check.
--   2. No newer-generation protection — a delayed failure transition
--      (reject/unrecoverable) for an OLDER generation, arriving after an
--      explicit newer send has already superseded it, could still
--      incorrectly release the current Send claim (the claim ownership
--      check alone doesn't catch this, since the current claim owner may
--      legitimately be the one holding — and presenting — the NEWER
--      generation's own token when a stale request for the OLDER
--      generation finally resolves). Fixed by adding the same
--      newer-generation EXISTS check accept_invoice_delivery_attempt()
--      already uses, which aborts (and therefore touches nothing,
--      including the claim) before any row is changed.
--
-- NOT applied by this file automatically — review first, then run
-- preflight, then the transaction below, same posture as every prior
-- migration in this directory. Do not apply without explicit go-ahead.

-- =======================================================================
-- PREFLIGHT — run first, by itself. Read-only.
-- =======================================================================

-- 1. The function does not already exist.
-- select p.proname, pg_get_function_identity_arguments(p.oid) from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'resolve_invoice_delivery_attempt_failure';
-- -- expect: zero rows

-- 2. The two existing Phase 3 RPCs are present — sanity check that this
--    follow-up is being applied against the expected base state.
-- select p.proname from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--   and p.proname in ('create_invoice_delivery_attempt', 'accept_invoice_delivery_attempt');
-- -- expect: both rows present

-- 3. invoice_delivery_attempts and invoices still have the shape this
--    function depends on (status/send_claim_token columns).
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoice_delivery_attempts'
--   and column_name in ('status', 'access_token_ciphertext', 'resolved_at', 'generation');
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoices'
--   and column_name in ('send_claim_token', 'send_claimed_at');
-- -- both expect: all listed columns present

-- =======================================================================
-- MIGRATION — one atomic transaction. Additive only: one new function, no
-- table/column changes, no change to the two existing Phase 3 RPCs.
-- =======================================================================
BEGIN;

-- resolve_invoice_delivery_attempt_failure(): atomically transitions one
-- 'pending' attempt to either:
--   'rejected'      — a definite provider rejection. Ciphertext cleared
--                      (nothing left to recover); resolved_at set (a true
--                      dead end).
--   'unrecoverable' — a decrypt failure during recovery. Ciphertext
--                      PRESERVED (in case a future fix makes it
--                      decryptable again); resolved_at stays NULL — this
--                      is NOT a dead end, the row keeps resolving
--                      publicly and an explicit confirmed new generation
--                      is still the only way past it, same as the
--                      existing 23h-expiry path.
-- and releases the invoice's Send claim — all conditional on the caller
-- still owning that exact claim token, exactly like the other two Phase 3
-- RPCs, and only for the CURRENT (not superseded by a newer generation)
-- attempt. If ownership was lost, or a newer generation already exists,
-- the whole call raises and nothing changes (neither row, nor the claim).
--
-- SECURITY INVOKER (the default) — service_role already holds the needed
-- table grants directly from the base Phase 3 migration; no new GRANT on
-- invoice_delivery_attempts or invoices is needed here. No RETURNS TABLE
-- here (unlike create_invoice_delivery_attempt), so no OUT-parameter
-- shadowing risk — the invoices lookup below intentionally stays
-- unaliased, matching accept_invoice_delivery_attempt()'s own style for
-- the same reason.
CREATE FUNCTION public.resolve_invoice_delivery_attempt_failure(
  p_invoice_id uuid,
  p_attempt_id uuid,
  p_generation integer,
  p_send_claim_token uuid,
  p_target_status text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_claim uuid;
BEGIN
  IF p_send_claim_token IS NULL THEN
    RAISE EXCEPTION 'send claim token must not be null';
  END IF;

  -- NULL-safe: a bare `p_target_status NOT IN (...)` would evaluate to
  -- NULL (neither true nor false) for a NULL input under Postgres's
  -- three-valued logic, silently skipping this IF and falling through to
  -- the ELSE branch below, which would incorrectly mark the attempt
  -- 'unrecoverable' instead of rejecting the call outright.
  IF p_target_status IS NULL OR p_target_status NOT IN ('rejected', 'unrecoverable') THEN
    RAISE EXCEPTION 'target status must be rejected or unrecoverable, got %', p_target_status;
  END IF;

  -- Lock the invoice row and confirm claim ownership — NULL-safe, same
  -- IS DISTINCT FROM pattern as the other two Phase 3 RPCs.
  SELECT send_claim_token INTO v_current_claim
    FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice % does not exist', p_invoice_id;
  END IF;
  IF v_current_claim IS DISTINCT FROM p_send_claim_token THEN
    RAISE EXCEPTION 'send claim for invoice % is no longer owned by token %; refusing to resolve attempt %',
      p_invoice_id, p_send_claim_token, p_attempt_id;
  END IF;

  -- A strictly newer generation already existing, in ANY status, means an
  -- explicit new send has already moved past this one by admin decision
  -- — a delayed failure transition for the OLDER generation must never
  -- retroactively touch it OR release the claim on its behalf. Mirrors
  -- accept_invoice_delivery_attempt()'s identical check.
  IF EXISTS (
    SELECT 1 FROM public.invoice_delivery_attempts a
    WHERE a.invoice_id = p_invoice_id AND a.generation > p_generation
  ) THEN
    RAISE EXCEPTION 'invoice % already has a delivery generation newer than %; refusing to resolve the older attempt %',
      p_invoice_id, p_generation, p_attempt_id;
  END IF;

  -- Lock and validate the target attempt: must belong to the claimed
  -- invoice/generation and still be 'pending' — the only status either
  -- transition above is ever reached from.
  PERFORM 1 FROM public.invoice_delivery_attempts
    WHERE id = p_attempt_id AND invoice_id = p_invoice_id AND generation = p_generation
      AND status = 'pending'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_delivery_attempt % (invoice %, generation %) is not a pending attempt',
      p_attempt_id, p_invoice_id, p_generation;
  END IF;

  IF p_target_status = 'rejected' THEN
    UPDATE public.invoice_delivery_attempts
    SET status = 'rejected', resolved_at = now(), access_token_ciphertext = NULL
    WHERE id = p_attempt_id;
  ELSE
    UPDATE public.invoice_delivery_attempts
    SET status = 'unrecoverable'
    WHERE id = p_attempt_id;
  END IF;

  UPDATE public.invoices
  SET send_claim_token = NULL, send_claimed_at = NULL
  WHERE id = p_invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_invoice_delivery_attempt_failure(uuid, uuid, integer, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_invoice_delivery_attempt_failure(uuid, uuid, integer, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_invoice_delivery_attempt_failure(uuid, uuid, integer, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_invoice_delivery_attempt_failure(uuid, uuid, integer, uuid, text) TO service_role;

COMMIT;

-- =======================================================================
-- Verification
-- =======================================================================
-- select p.proname, pg_get_function_identity_arguments(p.oid) from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'resolve_invoice_delivery_attempt_failure';

-- select has_function_privilege('anon', 'public.resolve_invoice_delivery_attempt_failure(uuid,uuid,integer,uuid,text)', 'EXECUTE'); -- expect false
-- select has_function_privilege('authenticated', 'public.resolve_invoice_delivery_attempt_failure(uuid,uuid,integer,uuid,text)', 'EXECUTE'); -- expect false
-- select has_function_privilege('service_role', 'public.resolve_invoice_delivery_attempt_failure(uuid,uuid,integer,uuid,text)', 'EXECUTE'); -- expect true

-- =======================================================================
-- OPTIONAL functional smoke test — safe, self-rolling-back, exercises:
-- NULL target_status rejection (state unchanged), invalid target_status
-- rejection, stale/wrong-claim rejection, newer-generation rejection for
-- a delayed older-generation resolution (claim NOT released), a
-- successful 'rejected' transition (ciphertext cleared, resolved_at set,
-- claim released), and a successful 'unrecoverable' transition on a
-- separate attempt (ciphertext preserved, resolved_at stays NULL, claim
-- released). Run as its own script, after the migration above has
-- committed.
-- =======================================================================
-- BEGIN;
--
-- DO $$
-- DECLARE
--   v_invoice_id uuid;
--   v_claim_1 uuid := gen_random_uuid();
--   v_claim_2 uuid := gen_random_uuid();
--   v_claim_3 uuid := gen_random_uuid();
--   v_attempt_1 uuid; v_gen_1 integer;
--   v_attempt_2 uuid; v_gen_2 integer;
--   v_attempt_3 uuid; v_gen_3 integer;
-- BEGIN
--   SELECT id INTO v_invoice_id FROM public.invoices LIMIT 1;
--   IF v_invoice_id IS NULL THEN
--     RAISE NOTICE 'No invoice rows exist yet — smoke test skipped.';
--     RETURN;
--   END IF;
--
--   UPDATE public.invoices SET send_claim_token = v_claim_1, send_claimed_at = now() WHERE id = v_invoice_id;
--   SELECT id, generation INTO v_attempt_1, v_gen_1
--     FROM public.create_invoice_delivery_attempt(v_invoice_id, v_claim_1, gen_random_uuid(), repeat('4', 64), repeat('b', 60), 'test@example.com', 1000);
--
--   -- A NULL target_status is rejected outright, and changes nothing:
--   -- attempt stays pending, ciphertext untouched, claim still owned.
--   BEGIN
--     PERFORM public.resolve_invoice_delivery_attempt_failure(v_invoice_id, v_attempt_1, v_gen_1, v_claim_1, NULL);
--     RAISE EXCEPTION 'expected a null target_status to be rejected but it succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%target status must be%' THEN RAISE; END IF;
--   END;
--   ASSERT (SELECT status FROM public.invoice_delivery_attempts WHERE id = v_attempt_1) = 'pending',
--     'a null target_status must not change the attempt status';
--   ASSERT (SELECT access_token_ciphertext FROM public.invoice_delivery_attempts WHERE id = v_attempt_1) IS NOT NULL,
--     'a null target_status must not clear the ciphertext';
--   ASSERT (SELECT send_claim_token FROM public.invoices WHERE id = v_invoice_id) = v_claim_1,
--     'a null target_status must not release the send claim';
--
--   -- An otherwise-invalid target_status is also rejected outright.
--   BEGIN
--     PERFORM public.resolve_invoice_delivery_attempt_failure(v_invoice_id, v_attempt_1, v_gen_1, v_claim_1, 'accepted');
--     RAISE EXCEPTION 'expected an invalid target_status to be rejected but it succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%target status must be%' THEN RAISE; END IF;
--   END;
--
--   -- A non-owning claim token cannot resolve the attempt.
--   BEGIN
--     PERFORM public.resolve_invoice_delivery_attempt_failure(v_invoice_id, v_attempt_1, v_gen_1, gen_random_uuid(), 'rejected');
--     RAISE EXCEPTION 'expected a non-owning claim token to be rejected but it succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%not owned by token%' THEN RAISE; END IF;
--   END;
--
--   -- Reclaim and create generation 2 (v_attempt_1/generation 1 stays
--   -- 'pending', untouched — create_invoice_delivery_attempt() never
--   -- touches any row but the one it inserts).
--   UPDATE public.invoices SET send_claim_token = v_claim_2, send_claimed_at = now() WHERE id = v_invoice_id;
--   SELECT id, generation INTO v_attempt_2, v_gen_2
--     FROM public.create_invoice_delivery_attempt(v_invoice_id, v_claim_2, gen_random_uuid(), repeat('6', 64), repeat('d', 60), 'test@example.com', 1000);
--   ASSERT v_gen_2 = 2;
--
--   -- A delayed failure transition for the OLDER generation (1), even
--   -- presenting the currently-valid claim (v_claim_2), must be rejected
--   -- because a newer generation (2) already exists — and must change
--   -- NOTHING: not the older attempt, and NOT release the claim that a
--   -- legitimately newer request may still need.
--   BEGIN
--     PERFORM public.resolve_invoice_delivery_attempt_failure(v_invoice_id, v_attempt_1, v_gen_1, v_claim_2, 'rejected');
--     RAISE EXCEPTION 'expected resolution of stale generation % to be rejected but it succeeded', v_gen_1;
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%newer than%' THEN RAISE; END IF;
--   END;
--   ASSERT (SELECT status FROM public.invoice_delivery_attempts WHERE id = v_attempt_1) = 'pending',
--     'a rejected newer-generation call must not change the older attempt';
--   ASSERT (SELECT access_token_ciphertext FROM public.invoice_delivery_attempts WHERE id = v_attempt_1) IS NOT NULL,
--     'a rejected newer-generation call must not clear the older attempt''s ciphertext';
--   ASSERT (SELECT send_claim_token FROM public.invoices WHERE id = v_invoice_id) = v_claim_2,
--     'a rejected newer-generation call must not release the claim';
--
--   -- Resolving the CURRENT generation (2) with its own valid claim
--   -- succeeds: 'rejected' — ciphertext cleared, resolved_at set, claim released.
--   PERFORM public.resolve_invoice_delivery_attempt_failure(v_invoice_id, v_attempt_2, v_gen_2, v_claim_2, 'rejected');
--   ASSERT (SELECT status FROM public.invoice_delivery_attempts WHERE id = v_attempt_2) = 'rejected';
--   ASSERT (SELECT access_token_ciphertext FROM public.invoice_delivery_attempts WHERE id = v_attempt_2) IS NULL;
--   ASSERT (SELECT resolved_at FROM public.invoice_delivery_attempts WHERE id = v_attempt_2) IS NOT NULL;
--   ASSERT (SELECT send_claim_token FROM public.invoices WHERE id = v_invoice_id) IS NULL, 'claim was not released after reject';
--
--   -- A fresh attempt (generation 3), marked unrecoverable instead:
--   -- ciphertext PRESERVED, resolved_at stays NULL, claim released.
--   UPDATE public.invoices SET send_claim_token = v_claim_3, send_claimed_at = now() WHERE id = v_invoice_id;
--   SELECT id, generation INTO v_attempt_3, v_gen_3
--     FROM public.create_invoice_delivery_attempt(v_invoice_id, v_claim_3, gen_random_uuid(), repeat('7', 64), repeat('e', 60), 'test@example.com', 1000);
--   PERFORM public.resolve_invoice_delivery_attempt_failure(v_invoice_id, v_attempt_3, v_gen_3, v_claim_3, 'unrecoverable');
--   ASSERT (SELECT status FROM public.invoice_delivery_attempts WHERE id = v_attempt_3) = 'unrecoverable';
--   ASSERT (SELECT access_token_ciphertext FROM public.invoice_delivery_attempts WHERE id = v_attempt_3) IS NOT NULL,
--     'expected unrecoverable to preserve the ciphertext';
--   ASSERT (SELECT resolved_at FROM public.invoice_delivery_attempts WHERE id = v_attempt_3) IS NULL,
--     'expected unrecoverable to leave resolved_at NULL — not a dead end';
--   ASSERT (SELECT send_claim_token FROM public.invoices WHERE id = v_invoice_id) IS NULL, 'claim was not released after marking unrecoverable';
--
--   RAISE NOTICE 'Smoke test passed.';
-- END;
-- $$;
--
-- ROLLBACK;

-- =======================================================================
-- Rollback (reference only — not executed as part of this file)
-- =======================================================================
-- REVOKE ALL ON FUNCTION public.resolve_invoice_delivery_attempt_failure(uuid, uuid, integer, uuid, text) FROM service_role;
-- DROP FUNCTION IF EXISTS public.resolve_invoice_delivery_attempt_failure(uuid, uuid, integer, uuid, text);
