-- Phase 3 — Invoice Delivery + Pay Now: final schema (revised 2026-10-20).
--
-- Supersedes the prior draft of this file in full — this revision fixes
-- several production blockers found in review of that draft:
--   1. provider_email_id's CHECK conflicted with superseding a previously
--      ACCEPTED attempt (superseding must preserve that historical id,
--      not erase it) — fixed below.
--   2. resolved_at was being reused as "when accepted" AND "when
--      superseded," so superseding an accepted row destroyed the record
--      of when it was originally accepted — fixed by adding a separate,
--      never-overwritten accepted_at column.
--   3. The acceptance RPC did not validate that its caller still owns the
--      invoice's Send claim, and did not reject a delayed response for a
--      generation that has since been superseded by an explicit newer
--      send — both are now required steps inside the transaction, which
--      also now releases the claim on success.
--   4. Generation allocation was documented as an application-code
--      COALESCE(MAX...)+1 under the claim lock, with no DB-level
--      atomicity beyond the UNIQUE backstop — a second function,
--      create_invoice_delivery_attempt(), now makes claim-validation +
--      generation-allocation + insertion one atomic call.
--   5. The DDL itself was not wrapped in a transaction — a mid-migration
--      syntax error could have left the database partially migrated.
--   6. Table privileges on invoice_delivery_attempts are now revoked from
--      every non-service role explicitly, one statement per role, rather
--      than relying on a single blanket REVOKE ALL.
--   7-10. Preflight/verification additions (service_role BYPASSRLS,
--      generation/timestamp sanity checks, corrected terminology, and an
--      optional self-rolling-back functional smoke test covering the
--      behavioral guarantees that a static schema query can't verify).
--
-- Latest revision (same day) fixes several further issues found in review:
--   a. Both functions' claim-ownership comparisons are now NULL-safe
--      (IS DISTINCT FROM), with an explicit upfront rejection of a NULL
--      p_send_claim_token — the previous `v_current_claim IS NULL OR
--      v_current_claim <> p_send_claim_token` form could, for a NULL
--      p_send_claim_token specifically, evaluate the OR to NULL (neither
--      true nor false) and silently fall through the IF without raising,
--      rather than rejecting the call as it should.
--   b. Preflight #4 now lists the exact five Phase 3 CHECK constraint
--      names on invoices individually, rather than a `LIKE 'invoices_%'`
--      pattern that could also match unrelated constraints from other,
--      non-Phase-3 migrations and give a false read on this migration's
--      own starting state.
--   c. Every unnecessary IF NOT EXISTS / CREATE OR REPLACE in the apply
--      DDL below has been removed. Preflight already confirms none of
--      these objects exist before this transaction runs — using
--      IF NOT EXISTS (or OR REPLACE for the functions) anyway would mean
--      an unexpected pre-existing object is silently skipped or
--      overwritten instead of the whole transaction failing loudly, which
--      is the only safe response to schema drift this migration didn't
--      expect.
--   d. started_at's documentation is corrected: it marks the LOGICAL
--      start of a delivery attempt (the moment
--      create_invoice_delivery_attempt() inserts the row), not the exact
--      instant Resend's servers received the outbound request — those
--      two moments are necessarily a few milliseconds apart (the DB
--      insert happens first; the Resend call follows). Anchoring the 23h
--      safety window to the slightly-earlier DB timestamp is intentionally
--      conservative, never optimistic, relative to Resend's own clock.
--   e. Fixed a real contradiction between the AES-GCM AAD design and the
--      atomic generation RPC: access_token_ciphertext's AAD was
--      documented as bound to invoice_id:generation, but
--      create_invoice_delivery_attempt() only computes `generation`
--      atomically INSIDE itself — application code encrypting the raw
--      token BEFORE calling this function has no way to know that value
--      in advance without racily predicting it, which would undermine
--      the very atomicity this function exists to provide. Fixed by
--      binding the AAD to invoice_id:attempt_id instead: the caller
--      generates a random attempt id (a value it fully owns, no
--      prediction needed) before encrypting, and now passes that same id
--      to this function as a new required p_attempt_id parameter, which
--      is inserted as the row's own primary key rather than left to the
--      column's default. Generation is still allocated atomically inside
--      the function exactly as before, and remains the identity folded
--      into the invoice-send Resend idempotency key — only the
--      ciphertext's own authentication binding changed.
--   The smoke test gained explicit coverage for: a NULL claim token being
--   rejected by both functions, a NULL attempt id being rejected by
--   create_invoice_delivery_attempt(), and the caller-supplied attempt id
--   being the exact id actually inserted and returned.
--
-- Post-application correction (same day, after production apply): the
-- actual preflight/apply/smoke-test run surfaced two bugs that were
-- corrected before anything was finalized; this file is patched to match
-- exactly what was verified and is now live:
--   (1) create_invoice_delivery_attempt()'s invoice lookup now qualifies
--       the table with an explicit alias
--       (`FROM public.invoices AS i ... WHERE i.id = ...`, `SELECT
--       i.send_claim_token`), because this function's own
--       `RETURNS TABLE (id uuid, generation integer)` introduces
--       PL/pgSQL OUT parameters named `id`/`generation` that otherwise
--       shadow the bare, unqualified column reference in that lookup.
--   (2) The smoke test's access_token_hash placeholders that used
--       non-hex letters (g, i, k) are replaced with valid lowercase hex
--       digits — access_token_hash is CHECK-constrained to
--       `^[0-9a-f]{64}$`, and at least one of those (the generation-3
--       creation call) is on a success path that actually reaches the
--       INSERT, so the invalid placeholder tripped the real constraint.
--
-- APPLIED to production and verified 2026-10-20: preflight passed, the
-- 24-check post-migration verification passed 24/24, and the functional
-- smoke test passed and rolled back cleanly. This file is the
-- authoritative historical record of that migration — do not re-run the
-- BEGIN/COMMIT block below against production again; any future schema
-- change here is a NEW migration file, never an edit-and-rerun of this
-- one. Application code that depends on this schema is not written yet.
--
-- Out of scope for this file (application-code concerns, not schema):
--   - Classifying the admin-approved additional-charge workflow's
--     INITIATION as a discretionary, invoice-PI-guarded action distinct
--     from its post-capture mirror/reconciliation — needs a guard call
--     in handleApprove() during implementation, no schema change.
--   - The AES-256-GCM encryption/decryption code itself, the HTTP
--     endpoints, and the fresh-vs-recover decision logic that calls
--     create_invoice_delivery_attempt() / accept_invoice_delivery_attempt()
--     below — all application code, written in a later phase. The one
--     contract detail that DOES matter here: application code must
--     generate the attempt id (crypto.randomUUID()) and encrypt the raw
--     token with AAD = invoiceId + ":" + attemptId BEFORE calling
--     create_invoice_delivery_attempt(), passing that same id as
--     p_attempt_id — see §3 below for exactly why.
--
-- =======================================================================
-- Design summary
-- =======================================================================
--
-- public.invoices gains 6 columns (unchanged from the prior draft): the
-- Send-claim lock (send_claim_token/send_claimed_at — pure mutual
-- exclusion, holds no content of its own) and the Payment lock state
-- (active_stripe_payment_intent_id — a real Stripe "pi_..." id ONLY,
-- never a placeholder; payment_claim_token/payment_claimed_at — the claim
-- held while a stripe.paymentIntents.create() call is in flight, mutually
-- exclusive with active_stripe_payment_intent_id being set; payment_
-- generation — monotonic, never reused, folded into the Stripe
-- idempotency key so a later attempt never collides with a prior dead
-- attempt's cached response even if the dollar balance later repeats).
--
-- public.invoice_delivery_attempts (new table) owns every Send/email-link
-- concern: one row per logical send generation, a status column driving
-- every lifecycle invariant, and a permanent, append-only audit trail —
-- nothing is ever hard-deleted.
--
-- Terminology: "accepted" below means accepted BY THE EMAIL PROVIDER
-- (Resend returned success for the send request) — never "delivered to
-- an inbox" or "opened by the client." This codebase has no way to know
-- either of those things, and nothing in it should claim to.
--
-- status lifecycle and exactly what each status requires, split across
-- THREE independently-meaningful timestamps instead of overloading one:
--   started_at    — set once, at the moment create_invoice_delivery_
--                    attempt() inserts this row — the LOGICAL start of
--                    this delivery attempt/generation. This is not
--                    necessarily the exact instant Resend's servers
--                    received the outbound HTTP request (that call is
--                    made by application code moments after this row is
--                    inserted) — it is always at or slightly before that
--                    instant, never after. The 23h Resend-idempotency
--                    safety window (application code) is anchored to
--                    this timestamp specifically because that makes the
--                    window's start conservative: it can only ever be
--                    judged to begin a little EARLIER than Resend's own
--                    clock would say, so treating the window as expired
--                    is never premature relative to Resend's actual 24h
--                    retention — it can only ever be as-or-more cautious.
--   accepted_at   — set exactly once, the moment this row is first
--                    promoted to 'accepted'. NEVER overwritten again,
--                    including when this same row later becomes
--                    'superseded' — this is what preserves "when did
--                    Resend actually confirm this one" through a later
--                    supersede.
--   resolved_at   — set when this row reaches a true dead end:
--                    'rejected' or 'superseded'. NOT set for 'accepted'
--                    (accepted is not a dead end — it can still become
--                    superseded later) and NOT set for 'pending'/
--                    'unrecoverable' (not yet resolved either way).
--
--   pending       — just inserted, or a crash-recovery candidate.
--                    access_token_ciphertext present; accepted_at and
--                    provider_email_id NULL (never accepted); resolved_at
--                    NULL (not yet resolved).
--   unrecoverable — a recovery attempt found the ciphertext undecryptable
--                    (e.g. a rotated INVOICE_LINK_SECRET). Same nullability
--                    shape as 'pending' — ciphertext is PRESERVED, never
--                    cleared, in case a future fix makes it decryptable.
--                    Automatic recovery refuses to act on it; moving on
--                    requires the same explicit human confirmation as an
--                    expired (>23h) pending attempt.
--   accepted      — provider confirmed the send. accepted_at and
--                    provider_email_id are both required (and are set
--                    together, never one without the other — see the
--                    CHECK below); ciphertext is cleared (nothing left to
--                    recover). At most one row per invoice may hold this
--                    status at a time (partial unique index below) — this
--                    is how "which link is currently THE current one" is
--                    answered, with no separate pointer column anywhere.
--   rejected      — provider explicitly rejected this attempt. resolved_at
--                    required; accepted_at/provider_email_id stay NULL
--                    (it was never accepted); ciphertext cleared. No other
--                    row for the invoice is touched.
--   superseded    — this attempt has been displaced by a LATER attempt's
--                    successful acceptance. resolved_at required.
--                    accepted_at/provider_email_id are preserved exactly
--                    as they were if this row had previously reached
--                    'accepted' (a real historical Resend id must never
--                    be erased just because the link was later replaced)
--                    — or stay NULL if this row was superseded while
--                    still 'pending'/'unrecoverable', i.e. it was never
--                    accepted in the first place.
--
-- Public lookup (application code, not this file) is always:
--   SELECT invoice_id FROM invoice_delivery_attempts
--     WHERE access_token_hash = :hash AND status IN ('pending','accepted','unrecoverable')
-- — identical response shape regardless of which status matched.
--
-- Generation allocation and cross-row atomicity are now both handled by
-- dedicated, service-role-only functions (§3) rather than a bare
-- COALESCE(MAX...)+1 in application code: create_invoice_delivery_attempt()
-- makes claim-validation + generation-allocation + row-insertion one
-- atomic call — the row's own id is supplied by the CALLER (not left to
-- the column default) specifically so application code can bind the
-- ciphertext's AES-GCM AAD to invoice_id:attempt_id before this function
-- ever runs, since the generation value itself is only known once this
-- function's internal allocation completes (see the "Latest revision"
-- note (e) above for why that ordering matters). accept_invoice_delivery_
-- attempt() makes claim-ownership re-validation + stale-generation
-- rejection + superseding every other live row + promoting the target +
-- releasing the claim one atomic call. UNIQUE (invoice_id, generation)
-- remains the hard database backstop in both cases — never the primary
-- mechanism, only what turns a violated application-level invariant into
-- a loud failure instead of silent corruption.

-- =======================================================================
-- PREFLIGHT — run this FIRST, by itself, separate from the transaction
-- below. Read-only.
-- =======================================================================

-- 1. None of the 6 new invoices columns already exist.
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoices'
--   and column_name in (
--     'send_claim_token', 'send_claimed_at', 'active_stripe_payment_intent_id',
--     'payment_claim_token', 'payment_claimed_at', 'payment_generation'
--   );
-- -- expect: zero rows

-- 2. invoice_delivery_attempts does not already exist.
-- select table_name from information_schema.tables
--   where table_schema = 'public' and table_name = 'invoice_delivery_attempts';
-- -- expect: zero rows

-- 3. Neither function already exists.
-- select p.proname, pg_get_function_identity_arguments(p.oid) from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--   and p.proname in ('accept_invoice_delivery_attempt', 'create_invoice_delivery_attempt');
-- -- expect: zero rows

-- 4. None of the exact five Phase 3 invoices CHECK constraint names (or
--    the index names below) already exist — listed individually rather
--    than matched by a LIKE pattern, so this can never be satisfied by
--    an unrelated, non-Phase-3 constraint that happens to share the
--    "invoices_" prefix.
-- select conname from pg_constraint where conrelid = 'public.invoices'::regclass
--   and conname in (
--     'invoices_send_claim_pair_chk', 'invoices_active_pi_format_chk',
--     'invoices_pi_claim_exclusive_chk', 'invoices_payment_claim_pair_chk',
--     'invoices_payment_generation_nonneg_chk'
--   );
-- select indexname from pg_indexes where schemaname = 'public'
--   and indexname in (
--     'invoices_active_pi_uniq', 'invoice_delivery_attempts_invoice_id_idx',
--     'invoice_delivery_attempts_access_token_hash_uniq', 'invoice_delivery_attempts_one_accepted_uniq'
--   );
-- -- both expect: zero rows

-- 5. invoices already carries a table-wide SELECT/INSERT/UPDATE grant to
--    service_role (Phase 2, no column list) — already covers the 6 new
--    columns, so no new GRANT statement for invoices appears below.
-- select privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'invoices' and grantee = 'service_role'
--   order by privilege_type;
-- -- expect: INSERT, SELECT, UPDATE (table-wide)

-- 6. invoices.id is uuid (confirms the new FK below will actually match).
-- select data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoices' and column_name = 'id';
-- -- expect: uuid

-- 7. service_role exists AND bypasses RLS. invoice_delivery_attempts has
--    RLS enabled below with NO client-facing policies at all — every
--    read/write service_role performs against it depends entirely on
--    this bypass posture, not on any policy this migration defines.
-- select rolname, rolbypassrls from pg_roles where rolname = 'service_role';
-- -- expect: service_role | true

-- =======================================================================
-- MIGRATION — one atomic transaction. No CONCURRENTLY operation is used
-- anywhere below, so wrapping the whole thing is safe: a syntax error or
-- constraint violation on any one statement rolls back everything,
-- leaving Production exactly as it was rather than partially migrated.
--
-- No IF NOT EXISTS / OR REPLACE appears below: preflight above already
-- confirmed none of these objects exist, so every CREATE/ADD here is
-- plain — if something unexpected already exists at apply time (drift
-- this migration didn't anticipate), the statement fails loudly and the
-- whole transaction rolls back, rather than silently skipping or
-- overwriting it.
-- =======================================================================
BEGIN;

-- -----------------------------------------------------------------------
-- 1. invoices — 6 new columns (Payment lock state + Send claim lock only)
-- -----------------------------------------------------------------------
ALTER TABLE public.invoices
  ADD COLUMN send_claim_token uuid NULL,
  ADD COLUMN send_claimed_at timestamptz NULL,
  ADD COLUMN active_stripe_payment_intent_id text NULL,
  ADD COLUMN payment_claim_token uuid NULL,
  ADD COLUMN payment_claimed_at timestamptz NULL,
  ADD COLUMN payment_generation integer NOT NULL DEFAULT 0;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_send_claim_pair_chk
    CHECK ((send_claim_token IS NULL) = (send_claimed_at IS NULL)),
  ADD CONSTRAINT invoices_active_pi_format_chk
    CHECK (active_stripe_payment_intent_id IS NULL OR active_stripe_payment_intent_id ~ '^pi_'),
  ADD CONSTRAINT invoices_pi_claim_exclusive_chk
    CHECK (active_stripe_payment_intent_id IS NULL OR payment_claim_token IS NULL),
  ADD CONSTRAINT invoices_payment_claim_pair_chk
    CHECK ((payment_claim_token IS NULL) = (payment_claimed_at IS NULL)),
  ADD CONSTRAINT invoices_payment_generation_nonneg_chk
    CHECK (payment_generation >= 0);

-- No two invoices may ever reference the same live Stripe PaymentIntent.
CREATE UNIQUE INDEX invoices_active_pi_uniq
  ON public.invoices (active_stripe_payment_intent_id)
  WHERE active_stripe_payment_intent_id IS NOT NULL;

-- No GRANT statements for invoices — see preflight #5; the existing
-- table-wide grant already covers all 6 new columns.

-- -----------------------------------------------------------------------
-- 2. invoice_delivery_attempts — new table, owns all Send/link state
-- -----------------------------------------------------------------------
CREATE TABLE public.invoice_delivery_attempts (
  -- No DEFAULT is relied upon in practice — create_invoice_delivery_
  -- attempt() always supplies this explicitly as p_attempt_id, generated
  -- by the CALLER before it ever reaches this function (see §3's own
  -- comment for exactly why). The DEFAULT stays here only as ordinary
  -- schema hygiene for any other insert path this table might ever gain.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),

  -- Allocated by create_invoice_delivery_attempt() only — see that
  -- function and this file's header for why COALESCE(MAX...)+1 under the
  -- invoice's Send claim is safe, with this row's own UNIQUE constraint
  -- (below) as the hard backstop.
  generation integer NOT NULL
    CHECK (generation > 0),

  status text NOT NULL
    CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded', 'unrecoverable')),

  -- SHA-256 hex of the raw token actually emailed for this attempt. The
  -- raw value itself is never stored anywhere in this database.
  access_token_hash text NOT NULL
    CHECK (access_token_hash ~ '^[0-9a-f]{64}$'),

  -- AES-256-GCM, versioned envelope ("v1.<nonce>.<ciphertext>.<tag>",
  -- base64url), AAD bound to invoice_id:attempt_id — this row's own id,
  -- generated by application code BEFORE encryption and passed in as
  -- create_invoice_delivery_attempt()'s p_attempt_id (NOT invoice_id:
  -- generation: generation is only allocated atomically inside that
  -- function, so the caller has no way to know it in advance without
  -- racily predicting it — see the "Latest revision" note (e) in this
  -- file's header). Copying this value into a different invoice's row
  -- or a different attempt fails authentication rather than decrypting
  -- to a wrong-but-plausible token.
  access_token_ciphertext text NULL
    CHECK (access_token_ciphertext IS NULL OR length(access_token_ciphertext) BETWEEN 40 AND 300),

  -- Snapshot of the recipient address and balance-due figure actually
  -- used to build THIS attempt's email body — never re-resolved live on
  -- a recovery retry, so a retry under the same Resend idempotency key
  -- stays byte-identical to whatever Resend may have already received.
  -- Neither value ever feeds into what the customer is actually charged
  -- — Pay Now always computes the live balance fresh.
  recipient_email text NOT NULL,
  balance_due_cents integer NOT NULL
    CHECK (balance_due_cents >= 0),

  -- Set once, at row-creation time (create_invoice_delivery_attempt()'s
  -- own now()) — the LOGICAL start of this attempt, not necessarily the
  -- exact instant Resend received the outbound request. See this file's
  -- header for why anchoring the 23h safety window here is conservative,
  -- never optimistic.
  started_at timestamptz NOT NULL,
  resolved_at timestamptz NULL,
  accepted_at timestamptz NULL,

  -- Resend's own message id. Historical once set — see this file's
  -- header for why superseding a previously-accepted row must never
  -- erase it.
  provider_email_id text NULL
    CHECK (provider_email_id IS NULL OR length(btrim(provider_email_id)) > 0),

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoice_delivery_attempts_invoice_generation_uniq
    UNIQUE (invoice_id, generation),

  -- Ciphertext present exactly while this attempt might still need
  -- automatic recovery.
  CONSTRAINT invoice_delivery_attempts_ciphertext_presence_chk
    CHECK ((status IN ('pending', 'unrecoverable')) = (access_token_ciphertext IS NOT NULL)),

  -- resolved_at marks a TRUE dead end only — 'rejected' or 'superseded'.
  -- Deliberately NOT required for 'accepted' (not a dead end) or
  -- 'pending'/'unrecoverable' (not yet resolved).
  CONSTRAINT invoice_delivery_attempts_resolved_at_presence_chk
    CHECK ((status IN ('rejected', 'superseded')) = (resolved_at IS NOT NULL)),
  CONSTRAINT invoice_delivery_attempts_resolved_at_order_chk
    CHECK (resolved_at IS NULL OR resolved_at >= started_at),

  -- accepted_at: never set for a row that was never accepted
  -- (pending/unrecoverable/rejected); always set the moment a row
  -- becomes 'accepted'; left exactly as-is (set or NULL, whichever it
  -- already was) once a row becomes 'superseded' — this is the
  -- corrected invariant that no longer conflicts with the superseding
  -- UPDATE in accept_invoice_delivery_attempt().
  CONSTRAINT invoice_delivery_attempts_accepted_at_chk
    CHECK (
      (status IN ('pending', 'unrecoverable', 'rejected') AND accepted_at IS NULL)
      OR (status = 'accepted' AND accepted_at IS NOT NULL)
      OR (status = 'superseded')
    ),
  CONSTRAINT invoice_delivery_attempts_accepted_at_order_chk
    CHECK (accepted_at IS NULL OR accepted_at >= started_at),

  -- provider_email_id: same shape as accepted_at (set together, cleared
  -- together — see the pairing CHECK below), fixed per the Phase 3
  -- correction so superseding a previously-accepted row is no longer
  -- rejected by this constraint.
  CONSTRAINT invoice_delivery_attempts_provider_email_id_chk
    CHECK (
      (status IN ('pending', 'unrecoverable', 'rejected') AND provider_email_id IS NULL)
      OR (status = 'accepted' AND provider_email_id IS NOT NULL)
      OR (status = 'superseded')
    ),

  -- accepted_at and provider_email_id are always set together and
  -- cleared together — they record the same event.
  CONSTRAINT invoice_delivery_attempts_accepted_pair_chk
    CHECK ((accepted_at IS NULL) = (provider_email_id IS NULL))
);

CREATE INDEX invoice_delivery_attempts_invoice_id_idx
  ON public.invoice_delivery_attempts (invoice_id);

-- Each attempt's token is independently 256-bit random — unconditional
-- (not partial) unique index, since no two attempts in any status should
-- ever share a hash.
CREATE UNIQUE INDEX invoice_delivery_attempts_access_token_hash_uniq
  ON public.invoice_delivery_attempts (access_token_hash);

-- At most one row per invoice may be the current, provider-accepted
-- link at a time — also how "what is this invoice's current link" is
-- answered, with no separate pointer column anywhere.
CREATE UNIQUE INDEX invoice_delivery_attempts_one_accepted_uniq
  ON public.invoice_delivery_attempts (invoice_id)
  WHERE status = 'accepted';

ALTER TABLE public.invoice_delivery_attempts ENABLE ROW LEVEL SECURITY;

-- Explicit, one-statement-per-role revocation rather than a single
-- blanket REVOKE ALL, so each role's absence of privilege is individually
-- unambiguous. No DELETE, ever — same append-only, permanent-audit-trail
-- posture as job_payments and invoices themselves. RLS stays enabled with
-- no policies defined: service_role's BYPASSRLS attribute (preflight #7)
-- is what makes it usable at all; anon/authenticated get nothing, from
-- either the grant revocation below or RLS, in either order.
REVOKE ALL ON public.invoice_delivery_attempts FROM PUBLIC;
REVOKE ALL ON public.invoice_delivery_attempts FROM anon;
REVOKE ALL ON public.invoice_delivery_attempts FROM authenticated;
REVOKE ALL ON public.invoice_delivery_attempts FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.invoice_delivery_attempts TO service_role;

-- -----------------------------------------------------------------------
-- 3. Two atomic, service-role-only functions
-- -----------------------------------------------------------------------
-- Both run as SECURITY INVOKER (the default — no SECURITY DEFINER
-- needed): service_role already holds the table-level grants above
-- directly, so each function simply runs with its caller's own
-- privileges. Locked down below so only service_role may ever call
-- either — same posture as next_invoice_number() in
-- sql/2026-10-19_invoice-workflow.sql. Plain CREATE FUNCTION, not CREATE
-- OR REPLACE — preflight #3 already confirmed neither exists, so a
-- pre-existing function here (drift) fails the statement loudly instead
-- of being silently overwritten.

-- create_invoice_delivery_attempt(): atomically validates the caller
-- still owns the invoice's Send claim, computes the next generation, and
-- inserts the new 'pending' row — removing the multi-round-trip
-- generation race that a bare application-code COALESCE(MAX...)+1 would
-- otherwise have. Only ever called when application code has already
-- determined there is no existing live row to recover (that decision —
-- read the latest row, decide fresh vs. recover — stays in application
-- code; this function's only job is making the fresh-insert path atomic).
--
-- p_attempt_id is generated by the CALLER (crypto.randomUUID() in
-- application code) BEFORE this function is ever invoked, and is used as
-- the inserted row's own primary key (id) rather than left to that
-- column's default — never generated inside this function. This is
-- required, not cosmetic: application code must encrypt the raw access
-- token into p_access_token_ciphertext with its AES-GCM AAD bound to
-- invoice_id:attempt_id BEFORE calling this function, and attempt_id is
-- the only one of the two identity values (attempt_id vs. generation)
-- the caller can know in advance — generation is only ever allocated
-- atomically inside this function's own body, below. Binding the AAD to
-- generation instead would force the caller to predict an atomically-
-- allocated value, which defeats the very atomicity this function exists
-- to provide.
CREATE FUNCTION public.create_invoice_delivery_attempt(
  p_invoice_id uuid,
  p_send_claim_token uuid,
  p_attempt_id uuid,
  p_access_token_hash text,
  p_access_token_ciphertext text,
  p_recipient_email text,
  p_balance_due_cents integer
) RETURNS TABLE (id uuid, generation integer)
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_claim uuid;
  v_next_generation integer;
  v_new_id uuid;
BEGIN
  -- A NULL claim token is never legitimate (a caller that never actually
  -- claimed anything cannot "own" one) — rejected outright, before
  -- touching any row, rather than relying on the comparison below to
  -- somehow catch it.
  IF p_send_claim_token IS NULL THEN
    RAISE EXCEPTION 'send claim token must not be null';
  END IF;

  -- p_attempt_id must also be non-null: this function uses it verbatim
  -- as the inserted row's primary key, and application code's AES-GCM
  -- AAD binding (see this function's own header above) depends on it
  -- being a real, caller-chosen value, never a value this function
  -- invents on the caller's behalf.
  IF p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'delivery attempt id must not be null';
  END IF;

  -- Table aliased and every column qualified — this function's own
  -- RETURNS TABLE (id uuid, generation integer) introduces PL/pgSQL OUT
  -- parameters named `id`/`generation` that would otherwise shadow a
  -- bare, unqualified `id` column reference here (found during the
  -- actual production apply/smoke-test run — see this file's header).
  SELECT i.send_claim_token INTO v_current_claim
    FROM public.invoices AS i
    WHERE i.id = p_invoice_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice % does not exist', p_invoice_id;
  END IF;

  -- NULL-safe ownership check: IS DISTINCT FROM treats NULL as an
  -- ordinary comparable value, so "the invoice currently holds no claim
  -- at all" (v_current_claim IS NULL) correctly compares as DISTINCT
  -- FROM any non-null p_send_claim_token (already guaranteed non-null by
  -- the guard above) and is rejected, with no risk of the old
  -- `v_current_claim IS NULL OR v_current_claim <> p_send_claim_token`
  -- form's three-valued-logic gap.
  IF v_current_claim IS DISTINCT FROM p_send_claim_token THEN
    RAISE EXCEPTION 'send claim for invoice % is not owned by token %; refusing to create a delivery attempt',
      p_invoice_id, p_send_claim_token;
  END IF;

  -- Safe under the row lock just taken above — UNIQUE(invoice_id,
  -- generation) remains the hard backstop regardless.
  SELECT COALESCE(MAX(a.generation), 0) + 1 INTO v_next_generation
    FROM public.invoice_delivery_attempts a WHERE a.invoice_id = p_invoice_id;

  -- id is supplied explicitly (p_attempt_id) rather than left to the
  -- column's default — see this function's header for why.
  INSERT INTO public.invoice_delivery_attempts (
    id, invoice_id, generation, status, access_token_hash, access_token_ciphertext,
    recipient_email, balance_due_cents, started_at
  ) VALUES (
    p_attempt_id, p_invoice_id, v_next_generation, 'pending', p_access_token_hash, p_access_token_ciphertext,
    p_recipient_email, p_balance_due_cents, now()
  )
  RETURNING invoice_delivery_attempts.id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, v_next_generation;
END;
$$;

REVOKE ALL ON FUNCTION public.create_invoice_delivery_attempt(uuid, uuid, uuid, text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_invoice_delivery_attempt(uuid, uuid, uuid, text, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.create_invoice_delivery_attempt(uuid, uuid, uuid, text, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_invoice_delivery_attempt(uuid, uuid, uuid, text, text, text, integer) TO service_role;

-- accept_invoice_delivery_attempt(): the one atomic promotion RPC.
-- Accepting a send is never a single-row update — it must (a) confirm
-- its caller still owns the Send claim it started with (a delayed
-- response from an invocation whose claim was since reclaimed must fail,
-- not promote anything), (b) refuse to promote a generation that is no
-- longer the newest one for this invoice (an explicit newer send already
-- supersedes it by admin decision, even before that newer one has itself
-- been accepted), (c) supersede every other currently-live row for the
-- invoice, (d) promote the target, and (e) release the Send claim — all
-- in one transaction, so a crash between any two of these steps is
-- impossible to observe as a partial result.
--
-- Ordering within the function is deliberate: every OTHER row is
-- superseded BEFORE this attempt is promoted to 'accepted', so there is
-- never a moment where two rows for the same invoice are simultaneously
-- 'accepted' (which would otherwise trip the partial unique index the
-- instant the new row is marked accepted while an old one still is).
--
-- Rejecting a single attempt (status -> 'rejected') and marking one
-- undecryptable (status -> 'unrecoverable') remain plain, already-atomic
-- single-row UPDATEs in application code — neither needs this function.
-- This function's own signature is unchanged by the AAD/attempt_id fix
-- above (it already took p_attempt_id as a lookup/locking key, unrelated
-- to the ciphertext's AAD binding).
CREATE FUNCTION public.accept_invoice_delivery_attempt(
  p_attempt_id uuid,
  p_invoice_id uuid,
  p_generation integer,
  p_send_claim_token uuid,
  p_provider_email_id text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_claim uuid;
BEGIN
  IF p_provider_email_id IS NULL OR length(btrim(p_provider_email_id)) = 0 THEN
    RAISE EXCEPTION 'provider_email_id is required to accept an invoice delivery attempt';
  END IF;

  -- Same NULL-rejection as create_invoice_delivery_attempt() — see its
  -- own comment for why this must be explicit rather than left to the
  -- comparison below.
  IF p_send_claim_token IS NULL THEN
    RAISE EXCEPTION 'send claim token must not be null';
  END IF;

  -- (1) Lock the invoice row and confirm the caller still owns the Send
  -- claim it started with.
  SELECT send_claim_token INTO v_current_claim
    FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice % does not exist', p_invoice_id;
  END IF;

  -- NULL-safe ownership check — see create_invoice_delivery_attempt()'s
  -- identical comment for why IS DISTINCT FROM replaces the old
  -- `IS NULL OR <>` form.
  IF v_current_claim IS DISTINCT FROM p_send_claim_token THEN
    RAISE EXCEPTION 'send claim for invoice % is no longer owned by token %; refusing to accept attempt %',
      p_invoice_id, p_send_claim_token, p_attempt_id;
  END IF;

  -- (2) A strictly newer generation already existing, in ANY status,
  -- means an explicit new send has already moved past this one by admin
  -- decision — a delayed response for the OLDER generation must never
  -- retroactively become current.
  IF EXISTS (
    SELECT 1 FROM public.invoice_delivery_attempts a
    WHERE a.invoice_id = p_invoice_id AND a.generation > p_generation
  ) THEN
    RAISE EXCEPTION 'invoice % already has a delivery generation newer than %; refusing to accept the older attempt %',
      p_invoice_id, p_generation, p_attempt_id;
  END IF;

  -- (3) Lock and validate the target attempt itself.
  PERFORM 1 FROM public.invoice_delivery_attempts
    WHERE id = p_attempt_id AND invoice_id = p_invoice_id AND generation = p_generation
      AND status IN ('pending', 'unrecoverable')
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_delivery_attempt % (invoice %, generation %) is not a live, promotable attempt',
      p_attempt_id, p_invoice_id, p_generation;
  END IF;

  -- (4) Supersede every OTHER public-valid attempt for this invoice
  -- FIRST — preserves accepted_at/provider_email_id on any that were
  -- previously accepted (neither column is touched here), and avoids
  -- ever having two rows simultaneously 'accepted'.
  UPDATE public.invoice_delivery_attempts
  SET status = 'superseded', resolved_at = now(), access_token_ciphertext = NULL
  WHERE invoice_id = p_invoice_id
    AND id <> p_attempt_id
    AND status IN ('accepted', 'pending', 'unrecoverable');

  -- (5) Promote the target attempt. resolved_at is deliberately left
  -- NULL — 'accepted' is not a dead end; accepted_at is the permanent
  -- record of when THIS row was first confirmed accepted.
  UPDATE public.invoice_delivery_attempts
  SET status = 'accepted', accepted_at = now(), provider_email_id = p_provider_email_id, access_token_ciphertext = NULL
  WHERE id = p_attempt_id;

  -- (6) Release the Send claim — a successful acceptance always ends
  -- with no claim held, in the same transaction.
  UPDATE public.invoices
  SET send_claim_token = NULL, send_claimed_at = NULL
  WHERE id = p_invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_invoice_delivery_attempt(uuid, uuid, integer, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_invoice_delivery_attempt(uuid, uuid, integer, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.accept_invoice_delivery_attempt(uuid, uuid, integer, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invoice_delivery_attempt(uuid, uuid, integer, uuid, text) TO service_role;

COMMIT;

-- =======================================================================
-- Verification (re-run any of these any time to re-confirm current
-- state; all read-only except the clearly-marked, self-rolling-back
-- smoke test at the very end).
-- =======================================================================

-- invoices: columns, types, nullability, defaults.
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoices'
--   and column_name in (
--     'send_claim_token', 'send_claimed_at', 'active_stripe_payment_intent_id',
--     'payment_claim_token', 'payment_claimed_at', 'payment_generation'
--   )
--   order by column_name;

-- invoices: all 5 named CHECK constraints, with definitions.
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where contype = 'c' and conrelid = 'public.invoices'::regclass
--   and conname in (
--     'invoices_send_claim_pair_chk', 'invoices_active_pi_format_chk',
--     'invoices_pi_claim_exclusive_chk', 'invoices_payment_claim_pair_chk',
--     'invoices_payment_generation_nonneg_chk'
--   )
--   order by conname;

-- invoices: unique partial index on active_stripe_payment_intent_id.
-- select indexname, indexdef from pg_indexes where schemaname = 'public'
--   and tablename = 'invoices' and indexname = 'invoices_active_pi_uniq';

-- invoices: confirm no new grant was needed.
-- select privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'invoices' and grantee = 'service_role'
--   order by privilege_type;

-- invoices: every new column is NULL (or 0) on pre-existing rows.
-- select count(*) from public.invoices
--   where send_claim_token is not null or active_stripe_payment_intent_id is not null
--      or payment_claim_token is not null or payment_generation <> 0;
-- -- expect: 0

-- invoice_delivery_attempts: columns including accepted_at, types, nullability.
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoice_delivery_attempts'
--   order by ordinal_position;
-- -- confirm accepted_at appears alongside resolved_at/started_at

-- invoice_delivery_attempts: every CHECK/UNIQUE constraint, with
-- definitions — confirm the provider_email_id/accepted_at CHECKs read as
-- "pending/unrecoverable/rejected => NULL; accepted => NOT NULL;
-- superseded unconstrained", never the simpler but wrong
-- "(status='accepted') = (provider_email_id IS NOT NULL))" form.
-- select conname, contype, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.invoice_delivery_attempts'::regclass
--   order by contype, conname;

-- invoice_delivery_attempts: generation > 0 is present.
-- select conname from pg_constraint
--   where conrelid = 'public.invoice_delivery_attempts'::regclass
--   and pg_get_constraintdef(oid) like '%generation > 0%';

-- invoice_delivery_attempts: indexes.
-- select indexname, indexdef from pg_indexes where schemaname = 'public'
--   and tablename = 'invoice_delivery_attempts' order by indexname;
-- -- expect invoice_delivery_attempts_one_accepted_uniq's indexdef to show
-- -- "WHERE (status = 'accepted'::text)"

-- invoice_delivery_attempts: RLS enabled.
-- select relname, relrowsecurity from pg_class
--   where relnamespace = 'public'::regnamespace and relname = 'invoice_delivery_attempts';
-- -- expect: relrowsecurity = true

-- invoice_delivery_attempts: service_role has SELECT/INSERT/UPDATE only.
-- select privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'invoice_delivery_attempts' and grantee = 'service_role'
--   order by privilege_type;
-- select has_table_privilege('service_role', 'public.invoice_delivery_attempts', 'DELETE'); -- expect false

-- invoice_delivery_attempts: PUBLIC/anon/authenticated have NO privileges at all.
-- select grantee, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'invoice_delivery_attempts'
--   and grantee in ('PUBLIC', 'anon', 'authenticated');
-- -- expect: zero rows
-- select has_table_privilege('anon', 'public.invoice_delivery_attempts', 'SELECT'); -- expect false
-- select has_table_privilege('authenticated', 'public.invoice_delivery_attempts', 'SELECT'); -- expect false

-- service_role BYPASSRLS (re-confirm post-migration, same as preflight #7).
-- select rolname, rolbypassrls from pg_roles where rolname = 'service_role';
-- -- expect: service_role | true

-- Both functions exist with the expected signatures.
-- select p.proname, pg_get_function_identity_arguments(p.oid) from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--   and p.proname in ('accept_invoice_delivery_attempt', 'create_invoice_delivery_attempt')
--   order by p.proname;
-- -- expect create_invoice_delivery_attempt's identity arguments to show
-- -- uuid, uuid, uuid, text, text, text, integer (seven parameters,
-- -- p_attempt_id included) — not the earlier six-parameter form.

-- Both functions: anon/authenticated/PUBLIC denied, service_role allowed.
-- select has_function_privilege('anon', 'public.create_invoice_delivery_attempt(uuid,uuid,uuid,text,text,text,integer)', 'EXECUTE'); -- expect false
-- select has_function_privilege('authenticated', 'public.create_invoice_delivery_attempt(uuid,uuid,uuid,text,text,text,integer)', 'EXECUTE'); -- expect false
-- select has_function_privilege('service_role', 'public.create_invoice_delivery_attempt(uuid,uuid,uuid,text,text,text,integer)', 'EXECUTE'); -- expect true
-- select has_function_privilege('anon', 'public.accept_invoice_delivery_attempt(uuid,uuid,integer,uuid,text)', 'EXECUTE'); -- expect false
-- select has_function_privilege('authenticated', 'public.accept_invoice_delivery_attempt(uuid,uuid,integer,uuid,text)', 'EXECUTE'); -- expect false
-- select has_function_privilege('service_role', 'public.accept_invoice_delivery_attempt(uuid,uuid,integer,uuid,text)', 'EXECUTE'); -- expect true

-- =======================================================================
-- OPTIONAL functional smoke test — exercises the behavioral guarantees a
-- static query can't: NULL claim-token rejection (both functions), NULL
-- attempt-id rejection (create only), the caller-supplied attempt id
-- being the exact id inserted and returned, stale-claim rejection,
-- newer-generation rejection, claim release on success, and
-- accepted_at/provider_email_id survival across a supersede. Safe to run
-- any time after the migration above has committed: it operates on ONE
-- arbitrary existing invoice's Send-claim columns and a handful of
-- throwaway invoice_delivery_attempts rows, and ends in ROLLBACK —
-- nothing it does is ever kept. Run it as its own script, separate from
-- everything above.
-- =======================================================================
-- BEGIN;
--
-- DO $$
-- DECLARE
--   v_invoice_id uuid;
--   v_claim_1 uuid := gen_random_uuid();
--   v_claim_2 uuid := gen_random_uuid();
--   v_claim_3 uuid := gen_random_uuid();
--   v_want_attempt_1 uuid := gen_random_uuid();
--   v_want_attempt_2 uuid := gen_random_uuid();
--   v_want_attempt_3 uuid := gen_random_uuid();
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
--   -- Take the Send claim (normally done by application code), create
--   -- generation 1 with a caller-chosen attempt id.
--   UPDATE public.invoices SET send_claim_token = v_claim_1, send_claimed_at = now() WHERE id = v_invoice_id;
--   SELECT id, generation INTO v_attempt_1, v_gen_1
--     FROM public.create_invoice_delivery_attempt(v_invoice_id, v_claim_1, v_want_attempt_1, repeat('a', 64), repeat('b', 60), 'test@example.com', 1000);
--   ASSERT v_gen_1 = 1, 'expected first generation to be 1, got ' || v_gen_1;
--   ASSERT v_attempt_1 = v_want_attempt_1, 'expected the caller-supplied attempt id to be the one inserted/returned';
--
--   -- A NULL claim token must be rejected outright by BOTH functions,
--   -- never silently treated as "doesn't match, so just fails the
--   -- ownership check" or (worse) silently passing due to three-valued
--   -- logic on the old IS NULL OR <> form.
--   BEGIN
--     PERFORM public.create_invoice_delivery_attempt(v_invoice_id, NULL, gen_random_uuid(), repeat('1', 64), repeat('j', 60), 'test@example.com', 1000);
--     RAISE EXCEPTION 'expected a null claim token to be rejected by create_invoice_delivery_attempt but it succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%must not be null%' THEN RAISE; END IF;
--   END;
--   BEGIN
--     PERFORM public.accept_invoice_delivery_attempt(v_attempt_1, v_invoice_id, v_gen_1, NULL, 'resend-test-id-null-claim');
--     RAISE EXCEPTION 'expected a null claim token to be rejected by accept_invoice_delivery_attempt but it succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%must not be null%' THEN RAISE; END IF;
--   END;
--
--   -- A NULL attempt id must be rejected outright by create_invoice_
--   -- delivery_attempt() specifically (uses a distinct message substring
--   -- from the claim-token check above, so this test can't accidentally
--   -- pass for the wrong reason). v_claim_1 is still the live claim here.
--   BEGIN
--     PERFORM public.create_invoice_delivery_attempt(v_invoice_id, v_claim_1, NULL, repeat('2', 64), repeat('l', 60), 'test@example.com', 1000);
--     RAISE EXCEPTION 'expected a null attempt id to be rejected by create_invoice_delivery_attempt but it succeeded';
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%attempt id must not be null%' THEN RAISE; END IF;
--   END;
--
--   -- Claim reclaimed by a second attempt without resolving the first
--   -- (the >23h / unrecoverable explicit-new-send scenario).
--   UPDATE public.invoices SET send_claim_token = v_claim_2, send_claimed_at = now() WHERE id = v_invoice_id;
--   SELECT id, generation INTO v_attempt_2, v_gen_2
--     FROM public.create_invoice_delivery_attempt(v_invoice_id, v_claim_2, v_want_attempt_2, repeat('c', 64), repeat('d', 60), 'test@example.com', 1000);
--   ASSERT v_gen_2 = 2, 'expected second generation to be 2, got ' || v_gen_2;
--   ASSERT v_attempt_2 = v_want_attempt_2, 'expected the caller-supplied attempt id to be the one inserted/returned';
--
--   -- The stale (first) claim can no longer create another attempt (a
--   -- fresh, valid attempt id is supplied here purely so this fails on
--   -- the ownership check being tested, not on the attempt-id-null check).
--   BEGIN
--     PERFORM public.create_invoice_delivery_attempt(v_invoice_id, v_claim_1, gen_random_uuid(), repeat('e', 64), repeat('f', 60), 'test@example.com', 1000);
--     RAISE EXCEPTION 'expected stale claim % to be rejected but it succeeded', v_claim_1;
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%not owned by token%' THEN RAISE; END IF;
--   END;
--
--   -- A delayed accept for the OLDER generation (1) is rejected now that
--   -- generation 2 exists, even presenting the currently-live claim.
--   BEGIN
--     PERFORM public.accept_invoice_delivery_attempt(v_attempt_1, v_invoice_id, v_gen_1, v_claim_2, 'resend-test-id-old');
--     RAISE EXCEPTION 'expected acceptance of stale generation % to be rejected but it succeeded', v_gen_1;
--   EXCEPTION WHEN OTHERS THEN
--     IF SQLERRM NOT LIKE '%newer than%' THEN RAISE; END IF;
--   END;
--
--   -- Accepting the current generation (2) succeeds, clears the claim,
--   -- and supersedes generation 1 (which was never accepted, so its
--   -- accepted_at/provider_email_id correctly stay NULL).
--   PERFORM public.accept_invoice_delivery_attempt(v_attempt_2, v_invoice_id, v_gen_2, v_claim_2, 'resend-test-id-new');
--   ASSERT (SELECT send_claim_token FROM public.invoices WHERE id = v_invoice_id) IS NULL, 'claim was not released after acceptance';
--   ASSERT (SELECT status FROM public.invoice_delivery_attempts WHERE id = v_attempt_2) = 'accepted';
--   ASSERT (SELECT accepted_at FROM public.invoice_delivery_attempts WHERE id = v_attempt_2) IS NOT NULL;
--   ASSERT (SELECT status FROM public.invoice_delivery_attempts WHERE id = v_attempt_1) = 'superseded';
--   ASSERT (SELECT provider_email_id FROM public.invoice_delivery_attempts WHERE id = v_attempt_1) IS NULL;
--
--   -- A further explicit new send (generation 3) that gets accepted must
--   -- supersede generation 2 WITHOUT erasing its historical acceptance record.
--   UPDATE public.invoices SET send_claim_token = v_claim_3, send_claimed_at = now() WHERE id = v_invoice_id;
--   SELECT id, generation INTO v_attempt_3, v_gen_3
--     FROM public.create_invoice_delivery_attempt(v_invoice_id, v_claim_3, v_want_attempt_3, repeat('3', 64), repeat('h', 60), 'test@example.com', 500);
--   ASSERT v_gen_3 = 3;
--   ASSERT v_attempt_3 = v_want_attempt_3, 'expected the caller-supplied attempt id to be the one inserted/returned';
--   PERFORM public.accept_invoice_delivery_attempt(v_attempt_3, v_invoice_id, v_gen_3, v_claim_3, 'resend-test-id-newest');
--   ASSERT (SELECT status FROM public.invoice_delivery_attempts WHERE id = v_attempt_2) = 'superseded';
--   ASSERT (SELECT provider_email_id FROM public.invoice_delivery_attempts WHERE id = v_attempt_2) = 'resend-test-id-new',
--     'expected attempt 2''s historical provider_email_id to survive being superseded';
--   ASSERT (SELECT accepted_at FROM public.invoice_delivery_attempts WHERE id = v_attempt_2) IS NOT NULL,
--     'expected attempt 2''s accepted_at to survive being superseded';
--
--   RAISE NOTICE 'Smoke test passed.';
-- END;
-- $$;
--
-- ROLLBACK;

-- =======================================================================
-- Rollback (reference only — not executed as part of this file; this is
-- the reverse of the migration transaction above, not wrapped in its own
-- BEGIN/COMMIT here since it is reference material, not a script to run
-- as-is)
-- =======================================================================
-- REVOKE ALL ON FUNCTION public.accept_invoice_delivery_attempt(uuid, uuid, integer, uuid, text) FROM service_role;
-- DROP FUNCTION IF EXISTS public.accept_invoice_delivery_attempt(uuid, uuid, integer, uuid, text);
--
-- REVOKE ALL ON FUNCTION public.create_invoice_delivery_attempt(uuid, uuid, uuid, text, text, text, integer) FROM service_role;
-- DROP FUNCTION IF EXISTS public.create_invoice_delivery_attempt(uuid, uuid, uuid, text, text, text, integer);
--
-- REVOKE ALL ON public.invoice_delivery_attempts FROM service_role;
-- DROP TABLE IF EXISTS public.invoice_delivery_attempts;
-- -- (drops its own indexes/constraints automatically)
--
-- DROP INDEX CONCURRENTLY IF EXISTS invoices_active_pi_uniq;
-- ALTER TABLE public.invoices
--   DROP CONSTRAINT IF EXISTS invoices_send_claim_pair_chk,
--   DROP CONSTRAINT IF EXISTS invoices_active_pi_format_chk,
--   DROP CONSTRAINT IF EXISTS invoices_pi_claim_exclusive_chk,
--   DROP CONSTRAINT IF EXISTS invoices_payment_claim_pair_chk,
--   DROP CONSTRAINT IF EXISTS invoices_payment_generation_nonneg_chk,
--   DROP COLUMN IF EXISTS send_claim_token,
--   DROP COLUMN IF EXISTS send_claimed_at,
--   DROP COLUMN IF EXISTS active_stripe_payment_intent_id,
--   DROP COLUMN IF EXISTS payment_claim_token,
--   DROP COLUMN IF EXISTS payment_claimed_at,
--   DROP COLUMN IF EXISTS payment_generation;
