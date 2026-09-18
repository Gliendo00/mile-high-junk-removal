# Phase 3C Stage 2.5-v2 — Dumpster Rental Real Booking + Stripe Payments
# (Braintree → Stripe migration)

Status: **implementation complete, still not deployed** — no push to `main`,
no production Supabase migration, no real or sandbox transaction of any
kind. Performed 2026-09-18, on branch
`phase-3c/stage2.5-stripe-rental-payments`, created from the exact same
commit (`a69b12a37114d4e44a1888bf2843a79974a4c3ff`) the Braintree
implementation branch (`phase-3c/stage2.5-rental-payments-v2`) was at when
the owner decided to abandon Braintree before any production rollout and
switch to Stripe instead. The Braintree branch is preserved unchanged as a
fallback/reference — its own design docs
(`stage2.5-rental-payments-v2-proposal.md`,
`-hardening-audit.md`, `-readiness-pass.md`) still exist there and describe
that implementation faithfully; they are removed from *this* branch only,
since they described Braintree-specific behavior this branch no longer has.

Nothing about the underlying business requirements changed: 15-yard
dumpster, $349 base / 5 days included / 2 tons included / $90 per extra
ton / $15 per extra day, online checkout is a real booking (not a lead),
exactly one delivery per (date, time window), vault the payment method for
later admin-approved charges, never auto-charge an overage without
explicit approval, coherent state handling for every failure/retry/
webhook-duplication scenario. See the Braintree branch's own proposal doc
for the original requirements gathering — none of it is repeated here
except where the processor swap changed the actual design.

## 1. Why Stripe, and why this was a clean rebuild of the payment layer

The owner's instruction was explicit: abandon Braintree before production
rollout, since nothing had shipped yet (no merge, no migration, no
transaction) — this was the correct time to replace it cleanly rather than
convert an already-deployed integration. Everything **not** specific to
Braintree carried over unchanged from the original design: server-
authoritative pricing, the partial unique index enforcing delivery-slot
availability, agreement version/timestamp audit trail, rate-schedule
snapshotting, the propose → approve → process additional-charge workflow,
no automatic charging without admin approval, the function-budget
consolidation (`api/admin/auth.js` merging login+logout), reconciliation
states, durable processor correlation, admin-visible failures, dispute
tracking, no raw card storage.

## 2. Stripe architecture

Built around **Stripe Elements' Payment Element + the PaymentIntents API**
(not Checkout Sessions, and not any deprecated/legacy integration) per
explicit instruction. One note for the record: Stripe's own current
documentation now generally *recommends* Checkout Sessions with the
Payment Element over the raw PaymentIntents API for most integrations,
specifically because it requires less code — but Checkout Sessions' hosted/
managed flow does not offer the fine-grained control this stage's slot-
race-safety design depends on (see §2.1 below), so PaymentIntents + Elements
remains the correct choice here, matching what was explicitly asked for.

### 2.1 The core problem this design had to solve

The original Braintree design relied on one crucial ordering: **insert the
booking (claiming the delivery slot via the database's own partial unique
index) BEFORE ever calling the payment processor.** A losing racer for the
same slot was rejected by Postgres before Braintree's `transaction.sale()`
was ever invoked, so a losing customer's card was never touched at all.

Stripe's Payment Element cannot work this way: it requires a real
PaymentIntent (and its `client_secret`) to exist **before** the customer
can even enter card details, let alone before the browser confirms
payment. If payment confirmation is treated as equivalent to "charge the
customer," the slot-claiming order guarantee breaks — a naive
implementation would confirm payment (charging the customer) client-side,
*then* discover server-side that the slot was already taken, refund/void,
and hope nothing goes wrong in between.

**The fix: `capture_method: "manual"`.** The customer's card is
*authorized* (a hold, no money moves) as soon as they confirm payment via
the Payment Element — but it is only ever **captured** (charged) by the
server, and only after the server has successfully claimed the delivery
slot in the database. This exactly reproduces the original ordering
guarantee ("claim the slot, then move money") using Stripe's own
authorize/capture split instead of a single all-in-one charge call — and
it is strictly *better* than the Braintree design in one respect: a losing
racer's card is never charged even temporarily, because the capture call
is simply never made for the loser (its authorization is cancelled,
releasing the hold).

### 2.2 Two-phase request flow

1. **`POST /api/book?resource=payment-intent`** (new — a query-param-
   dispatched branch on the existing `api/book.js`, not a new Vercel
   function; see §4). Called once, when the customer reaches the Payment
   step, with the full booking payload already filled in (everything
   `validateBooking()` can check except the payment method itself, which
   doesn't exist yet, and except the agreement checkbox, which the
   customer hasn't necessarily checked yet at this point — see the UX note
   below).
   - Validates the booking fields server-side (never trusts the client for
     anything about the booking itself).
   - Resolves a Stripe **Customer**: looks up whether this repeat customer
     (matched by the same exact phone+email rule Step 4a.3 already uses)
     has a `stripe_customer_id` on file from a past rental (read via their
     most recent `rental_payments` row) and reuses it; creates a fresh
     Stripe Customer otherwise. (No new `customers.stripe_customer_id`
     column was added — reusing the most recent per-booking record is a
     deliberately minimal way to get this without new schema for a
     capability nothing else needs.)
   - Creates a **PaymentIntent**: `amount` computed server-side (never
     trusted from the client), `currency: "usd"`, `customer`,
     `capture_method: "manual"`, `setup_future_usage: "off_session"` (so
     the payment method gets saved for later admin-approved charges once
     the eventual capture succeeds), `automatic_payment_methods: {enabled:
     true, allow_redirects: "never"}` (keeps the customer on the page —
     no redesign, no new return-URL landing page needed),
     `metadata: {idempotencyKey}`. Every Stripe write here passes the
     client-generated `idempotencyKey` as Stripe's own request
     `Idempotency-Key`, so calling this endpoint twice with the same key
     (e.g. reopening the Payment panel) returns the identical Stripe
     objects rather than creating duplicates.
   - Creates **zero database rows** — this step only talks to Stripe.
   - Returns `{ clientSecret, paymentIntentId }` to the browser.
2. Client-side (`book/book.js`): mounts Stripe's Payment Element against
   `clientSecret`. On "Pay & Book Now," calls `stripe.confirmPayment({
   elements, redirect: "if_required" })`. A decline surfaces inline via
   Stripe's own Payment Element UI, letting the customer retry on the SAME
   PaymentIntent (same idempotency key, never regenerated). A successful
   confirmation lands the PaymentIntent at `"requires_capture"` (authorized,
   not yet charged) — not `"succeeded"`, precisely because of the manual
   capture method.
3. **`POST /api/book`** (the existing endpoint, unchanged public
   contract) — the finalize/booking call, now carrying
   `payment: {paymentIntentId, idempotencyKey, agreementAccepted}`. See
   §2.3 for the full server-side sequence.

### 2.3 Server-side finalize sequence (`handleDumpsterRentalBooking()`)

1. **Idempotency check** by `idempotencyKey` — before any row is touched.
2. **Retrieve & verify the PaymentIntent** from Stripe: confirms
   `metadata.idempotencyKey` matches this exact request,
   `status === "requires_capture"`, and `amount` matches the authoritative
   server-computed rate. The client-submitted `paymentIntentId` is trusted
   only to look the object up — every fact used afterward comes back from
   Stripe itself.
3. **Customer lookup/reuse** — identical Step 4a.3 rule as every other
   flow in this file.
4. **Insert `rental_payments` FIRST**, `payment_status: "processing"`,
   `booking_id: NULL`. This is the one genuinely new architectural
   requirement this migration introduced (see §2.4) — it atomically claims
   the idempotency key via `rental_payments.idempotency_key`'s own UNIQUE
   constraint, *before* the delivery-slot uniqueness check is ever reached.
5. **Insert `bookings`**, `status: "booked"` — the delivery-slot claim
   (`idx_bookings_dumpster_delivery_slot`). A collision here means a
   *genuinely different* customer just took the slot (our own idempotency
   key was already uniquely claimed in step 4, so this can never be a
   same-key duplicate) — safe to cancel our own distinct PaymentIntent
   unconditionally.
6. **Link `rental_payments.booking_id`** to the new booking, and
   (best-effort) attach `metadata.bookingId` to the PaymentIntent on
   Stripe's side.
7. **Insert `dumpster_rentals`.**
8. **Capture** the already-authorized PaymentIntent — the moment money
   actually moves. A `StripeCardError` here is a *definitive* decline
   (rare — the authorization already succeeded once — but possible, e.g.
   the card was cancelled in the intervening minutes): roll back and free
   the slot. Any other thrown error (network/timeout/API error) is
   *ambiguous* — Stripe may have actually captured the charge — preserve
   every row and mark `error_pending_review`, never auto-retry, never roll
   back.
9. **Finalize**: retry-then-minimal-fallback write of `payment_status:
   "paid"` (same bounded-saga pattern the Braintree design's own hardening
   pass established) — falling back to `paid_reconciliation_required` if
   every retry of the full write fails. The customer response is
   unconditionally `{ok: true, booked: true}` from the moment capture
   succeeds, regardless of any subsequent local persistence gap — the
   browser is never nudged toward resubmitting a payment that may have
   already succeeded.

### 2.4 The one real architectural difference from the Braintree design

Braintree's design never reserved any external resource (an authorization,
a hold) before the booking existed — Braintree was only ever called *after*
`rental_payments` (which came *after* `bookings`) was successfully
inserted. Stripe's manual-capture PaymentIntent, by contrast, is created
and authorized *before* any database row exists at all (§2.2, step 1). This
introduces a race the original design never had to consider: **a
concurrent duplicate submission sharing the same idempotency key** (e.g. a
literal double-click, or a client retry firing before the first response
returns) could, if it reached the delivery-slot-uniqueness check first,
cause the *losing* copy of that same request to cancel the PaymentIntent
its own sibling still needs to capture.

The fix is the reordering in §2.3: `rental_payments` (idempotency-key
claim) is inserted **before** `bookings` (slot claim), not after. A
same-key duplicate is now caught atomically at the idempotency-key
uniqueness constraint, before the slot-uniqueness check is ever reached,
and that specific code path never cancels the PaymentIntent (a sibling may
still need it). Only once the current request's own idempotency key has
been uniquely and successfully claimed does reaching the slot-uniqueness
check even become possible — and by then, any collision there is
guaranteed to be a genuinely different customer, safe to cancel
unconditionally. This is proven directly by test (not just asserted) in
`tests/phase3c-stage2.5v2-stripe-rental-payments.test.js`'s two
`CONCURRENCY` tests for the finalize flow, using true `Promise.all`
concurrency (not sequential duplicate calls) so the two requests' `await`s
genuinely interleave.

`rental_payments.booking_id` is therefore **nullable** (still `UNIQUE` —
Postgres permits multiple `NULL`s under a `UNIQUE` constraint), populated
via an `UPDATE` once the booking actually exists. Every rollback path
deletes the `rental_payments` row by `idempotency_key` (always known,
regardless of whether `booking_id` has been linked yet) rather than by
`booking_id`.

### 2.5 Admin-approved additional charges (off-session)

`api/admin/booking.js`'s `?resource=charges` propose/approve workflow
carries over almost unchanged — a proposal still never calls Stripe (only
computes and snapshots an amount from `api/_lib/rental-pricing.js`, or a
booking's own locked-in rate schedule). Approval now creates and confirms
an **off-session** PaymentIntent against the vaulted Stripe
Customer/PaymentMethod:

```
stripe.paymentIntents.create({
  amount, currency: "usd", customer, payment_method,
  off_session: true, confirm: true,
  metadata: { bookingId, chargeId },
}, { idempotencyKey: "charge:" + chargeId })
```

- **Success** (`status === "succeeded"`): marked `paid`, with the same
  retry-then-fallback `paid_reconciliation_required` saga as the initial
  booking flow.
- **A `StripeCardError`**: a definitive decline — marked `failed`, safely
  retryable via Approve again (the admin UI shows "Retry: Approve &
  Charge").
- **A `StripeCardError` with `code: "authentication_required"`** — the
  card issuer requires Strong Customer Authentication for this off-session
  charge, per Stripe's own current documentation. This is genuinely new
  behavior with **no Braintree equivalent** (Braintree's own off-session
  vaulted-token charges had no analogous mid-flow authentication
  challenge). Modeled as a new, explicit state — see §2.6.
- **Any other thrown error**: ambiguous — marked `error_pending_review`,
  never auto-retried, exactly like the initial booking flow's own
  ambiguous-capture handling.

### 2.6 `requires_customer_action` — the new off-session-authentication state

Per the explicit instruction: *"If an off-session charge requires customer
authentication, do not falsely mark it paid and do not blindly retry it.
Model that state explicitly and provide a safe recovery/customer-action
path."*

- New status value on `rental_additional_charges.status` (and its own
  admin-UI badge, a distinct violet — neither a failure color nor a
  success color, since this is genuinely "waiting on the customer," not
  "processing" or "needs review").
- **Excluded from the normal Approve-retry set** (`proposed`/`failed`
  only) — re-approving would just re-attempt the identical off-session
  confirmation, most likely failing the same way, or worse, creating
  ambiguity about which attempt the customer actually authenticated.
- **Recovery path**: a new, deliberately non-charging admin action, `PATCH
  ?resource=charges { id, action: "check-status" }`
  (`handleCheckStatus()`). This only ever **retrieves** the stored
  PaymentIntent from Stripe (never creates or confirms anything) and
  advances the local row to match reality:
  - `status === "succeeded"` → the customer completed authentication
    out-of-band → mark `paid`.
  - `status === "canceled"` or `"requires_payment_method"` → the customer
    never completed it (or it expired) → mark `failed` (safely retryable
    via a fresh Approve, since no charge occurred).
  - Still `"requires_action"` → no change, still pending.
  - Safe to call any number of times — it is a pure read-and-reconcile
    action.
- **How does the customer actually get notified to authenticate?** This is
  a Stripe Dashboard configuration matter, not something this repo's code
  controls: Stripe can be configured (**Settings → Customer emails**) to
  automatically email the customer a hosted authentication link when an
  off-session PaymentIntent requires action. This is a manual dashboard
  step for the owner, analogous to how the original Braintree design
  flagged "enable Venmo in the Control Panel" as a manual step outside
  this repo's control — flagged here, not invented or silently assumed
  configured.

### 2.7 Reconciliation via webhook — a real backstop, not documentation-only

The Braintree design's webhook (`api/braintree-webhook.js`) discovered,
during its own hardening audit, that Braintree's settlement webhooks
(`transaction_settled`/`transaction_settlement_declined`) are ACH/SEPA-only
per Braintree's documentation — dead code for the card/Venmo transactions
that feature actually processed. Stripe's equivalent events do **not**
have this limitation: `payment_intent.succeeded` and
`payment_intent.payment_failed` genuinely fire for every card/wallet
capture this app creates. `api/stripe-webhook.js` (replacing
`api/braintree-webhook.js` — same Vercel function slot, not an additional
one) therefore does real work beyond dispute notification:

- **`payment_intent.succeeded`**: self-heals a row still stuck at
  `paid_reconciliation_required` or `error_pending_review` back to `paid`
  — a genuine, working recovery path for exactly the ambiguous/incomplete
  cases §2.3/§2.5 describe, not just documentation of what *should*
  happen. Never downgrades an already-`paid` row (Stripe does not
  guarantee event delivery order, so a late/duplicate delivery must be a
  no-op).
- **`payment_intent.payment_failed`**: marks a `processing`/
  `error_pending_review` row `failed` — never downgrades an already-`paid`
  row, for the same out-of-order-delivery reason.
- **`payment_intent.canceled`**: marks a stuck `processing`/
  `error_pending_review` row `voided` — the backstop for a hold released
  by a path other than this app's own synchronous rollback code (e.g.
  Stripe's own authorization-window expiry).
- **`charge.dispute.created` / `.closed` / `.funds_withdrawn` /
  `.funds_reinstated` / `.updated`**: recorded verbatim as Stripe's own
  `dispute.status` string (e.g. `"needs_response"`, `"won"`, `"lost"`,
  `"warning_closed"`) — Stripe's dispute lifecycle has more states than
  Braintree's did, so this is stored as-is rather than remapped into a
  narrower enum, avoiding any information loss for no benefit. Purely
  informational — no automated action is ever taken from it.

**Required webhook events** (verified against current Stripe
documentation, `docs.stripe.com/api/events/types`):
`payment_intent.succeeded`, `payment_intent.payment_failed`,
`payment_intent.canceled`, `charge.dispute.created`,
`charge.dispute.closed`, `charge.dispute.funds_withdrawn`,
`charge.dispute.funds_reinstated`, `charge.dispute.updated`. Subscribing to
additional events is harmless (unrecognized kinds are acknowledged with
200 and ignored) but unnecessary.

**Signature verification requires the raw request body** — re-serializing
a JSON-parsed body can produce different bytes and fail verification, per
Stripe's own documentation ("Don't manipulate the raw body of the
request"). `api/stripe-webhook.js` disables Vercel's default JSON body
parsing (`module.exports.config = { api: { bodyParser: false } }`) and
reads the raw bytes directly from the request stream before calling
`stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)`.

Unlike Braintree's webhook (which needed a `GET ?bt_challenge=` handler for
Control-Panel URL verification), Stripe has no analogous GET-based
ownership-verification step — the endpoint is POST-only; a GET is
rejected with 405.

## 3. Function budget — unchanged, still exactly 12/12

`api/braintree-webhook.js` is **removed**; `api/stripe-webhook.js` takes
its exact slot — not an additional function. `api/book.js` and
`api/admin/booking.js` are both extended in place (the new
`?resource=payment-intent` branch on `api/book.js`, the `check-status`
action on `api/admin/booking.js`'s existing `?resource=charges` PATCH) —
zero new files. Confirmed directly against the real `vercel build` output:
exactly 12 `.func` directories under `.vercel/output/functions/api/`.

## 4. Files removed / added / modified

**Removed:**
- `api/_lib/braintree-client.js`
- `api/braintree-webhook.js`
- `sql/2026-09-18_phase3c-stage2.5v2-rental-payments.sql` (the Braintree-
  schema migration — never run against any environment)
- `docs/phase-3/stage2.5-rental-payments-v2-proposal.md`,
  `-hardening-audit.md`, `-readiness-pass.md` (Braintree-specific design
  docs — preserved, unremoved, on the Braintree branch)
- `braintree` npm dependency

**Added:**
- `api/_lib/stripe-client.js` — `getStripeClient()`, mirrors
  `braintree-client.js`'s factory pattern exactly.
- `api/stripe-webhook.js` — see §2.7.
- `sql/2026-09-18_phase3c-stage2.5v2-stripe-rental-payments.sql` — a clean
  Stripe schema (see §5), not a Braintree-schema conversion.
- `docs/phase-3/stage2.5-stripe-rental-payments-migration.md` — this file.
- `tests/phase3c-stage2.5v2-stripe-rental-payments.test.js` — replaces
  `tests/phase3c-stage2.5v2-rental-payments.test.js` (removed from this
  branch; preserved on the Braintree branch).
- `stripe` npm dependency (`^22.6.2`, current at the time of this work).

**Modified:**
- `api/book.js` — `GET` echoes `stripe.publishableKey` instead of
  `braintree.tokenizationKey`; new `POST ?resource=payment-intent` branch;
  `validateBooking()` gains a `requirePaymentMethod` option distinguishing
  the two validation stages (see §2.2); `handleDumpsterRentalBooking()`
  rewritten per §2.3/§2.4; payment-method-summary extraction rewritten for
  Stripe's `PaymentMethod` object shape.
- `api/admin/booking.js` — `getStripeClient()` replaces
  `getBraintreeGateway()`; `handleApproveCharge()` split into
  `handleApprove()` (the money-moving path, rewritten per §2.5) and the new
  `handleCheckStatus()` (§2.6); `serializeCharge()`/booking-detail GET
  field renamed `stripePaymentIntentId`/`stripe_payment_intent_id` (the
  JSON key the admin frontend consumes, `transactionId`, is unchanged, so
  `admin/booking-detail.js` needed no field-mapping changes).
- `admin/booking-detail.js` — status-label text updated ("Check Stripe"
  instead of "Check Braintree"); new `requires_customer_action` label +
  "Check Status" button wiring.
- `admin/admin.css` — comment text updated; new
  `.admin-charge-status-requires_customer_action` badge color.
- `book/index.html` — Braintree Drop-in `<script>` replaced with
  `https://js.stripe.com/v3/`; container `id` renamed
  `stripe-payment-element-container`.
- `book/book.js` — the whole payment-panel section rewritten for the
  two-phase Stripe flow (§2.2); the Rental Agreement text itself is
  **unchanged** (it never named Braintree — it describes the rate/
  authorization mechanics only, which are processor-agnostic — so no
  agreement-version bump was needed for the processor swap alone).
- `package.json`/`package-lock.json` — `braintree` → `stripe`.
- `tests/phase3a-admin-status-write.test.js`,
  `tests/phase3c-schedule.test.js` — write-audit call-count assertions
  updated to match `api/admin/booking.js`'s actual `.insert(`/`.update(`
  occurrence counts (11 `.update(` total, up from 8, reflecting the new
  `check-status` action's 2 conditional writes plus
  `markChargeRequiresCustomerAction`'s 1).
- `tests/phase3c-job-editing.test.js` — its own narrower exact-count
  assertion updated to match (11 total).
- `tests/phase3b-step4a3-repeat-client-reuse.test.js` — its dumpster-rental
  fixtures updated to the new `payment.paymentIntentId` shape, with a
  minimal fake Stripe module added (this file's own scope — customer-reuse/
  rollback rules — never reaches an actual capture call, so the fake only
  needs `paymentIntents.retrieve`/`update`/`cancel` to work).

## 5. Database schema changes — clean Stripe schema, not a conversion

Production has **never** received the Braintree-schema migration (it was
committed but never run against any environment). The committed migration
for this branch is therefore a clean Stripe schema from the start — see
`sql/2026-09-18_phase3c-stage2.5v2-stripe-rental-payments.sql` for the full
file, `not run against Production or Staging` by this session. Summary of
what it adds, and nothing else:

1. `CREATE UNIQUE INDEX CONCURRENTLY idx_bookings_dumpster_delivery_slot ON
   bookings (appointment_date, time_window) WHERE service_type =
   'dumpster_rental' AND status = 'booked'` — unchanged, processor-
   agnostic, identical to the original design.
2. `rental_payments` — same shape/intent as the Braintree-era table, with:
   - `booking_id` now **nullable** (see §2.4) instead of `NOT NULL`.
   - `braintree_transaction_id` → `stripe_payment_intent_id`.
   - `braintree_customer_id` → `stripe_customer_id`.
   - `braintree_payment_method_token` → `stripe_payment_method_id`.
   - `payment_status`'s allowed values are unchanged: `processing`, `paid`,
     `failed`, `voided`, `refunded`, `error_pending_review`,
     `paid_reconciliation_required`.
   - Rate-schedule snapshot columns (`base_rate`, `included_days`,
     `included_tons`, `overage_ton_rate`, `overage_day_rate`) — unchanged,
     processor-agnostic.
3. `rental_additional_charges` — same shape, with
   `braintree_transaction_id` → `stripe_payment_intent_id`, and one new
   allowed `status` value: **`requires_customer_action`** (§2.6) —
   Stripe-specific, no Braintree equivalent.
4. `idx_rental_additional_charges_booking_id` — unchanged.

### 5.1 Exact migration strategy for a clean Production rollout

Because nothing Braintree-related was ever run against Production, the
rollout is simple and requires no conversion step:

1. Run **statement 0** (the preflight query) by itself — read-only, finds
   any existing `booked` dumpster-rental rows already sharing a
   `(appointment_date, time_window)` pair. An empty result means the index
   will build cleanly.
2. Run **statement 1** (`CREATE UNIQUE INDEX CONCURRENTLY
   idx_bookings_dumpster_delivery_slot ...`) alone — `CONCURRENTLY` cannot
   run inside a transaction block, and the Supabase SQL editor runs a
   multi-statement paste as one implicit transaction.
3. Run **statements 2–4** together (the two `CREATE TABLE`s and the one
   regular index) — safe to batch.
4. Verify using the queries at the bottom of the SQL file (confirm the
   index/columns/constraints exist as expected; optionally exercise the
   delivery-slot collision inside a throwaway transaction that's rolled
   back, never committed).

No data migration, no backfill, no Braintree-schema teardown — this is a
purely additive migration against the current, unmodified Production
schema.

### 5.2 Staging cleanup/reset plan — **not executed by this session**

Per explicit instruction: this section documents the exact steps: it does
not run any of them.

**Current staging state** (per the owner's own prior setup, described in
the task brief): an isolated Supabase staging project containing (a) the
current production `public` schema, copied schema-only, (b) the
**Braintree** rental-payment migration applied for testing, (c) no real
production client/booking data, (d) one synthetic staging admin Auth user.

**What needs to happen, in order, before staging can be used for Stripe
testing:**

1. **Confirm what the Braintree migration actually added to staging.**
   Run the read-only introspection query below directly against the
   staging project (never against Production) to see exactly what exists
   today:
   ```sql
   select table_name, column_name, data_type, is_nullable
   from information_schema.columns
   where table_schema = 'public' and table_name in ('rental_payments', 'rental_additional_charges')
   order by table_name, ordinal_position;

   select indexname, indexdef from pg_indexes
   where schemaname = 'public' and indexname in ('idx_bookings_dumpster_delivery_slot', 'idx_rental_additional_charges_booking_id');
   ```
2. **Drop the Braintree-schema objects from staging** using the exact
   rollback block already documented at the bottom of the *old* Braintree
   migration file (`sql/2026-09-18_phase3c-stage2.5v2-rental-payments.sql`
   — still available on the `phase-3c/stage2.5-rental-payments-v2` branch
   for reference, since it's removed from this branch):
   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS idx_rental_additional_charges_booking_id;
   DROP TABLE IF EXISTS rental_additional_charges;
   DROP TABLE IF EXISTS rental_payments;
   DROP INDEX CONCURRENTLY IF EXISTS idx_bookings_dumpster_delivery_slot;
   ```
   This returns staging's `bookings`/`customers`/`dumpster_rentals` tables
   (never touched by either migration) to the production baseline exactly.
3. **Apply the new Stripe schema** — run
   `sql/2026-09-18_phase3c-stage2.5v2-stripe-rental-payments.sql` (this
   branch's file) against staging, same three-step order as §5.1
   (preflight → unique index alone → the two tables + index together).
   Staging's preflight query will be a guaranteed no-op (no existing
   dumpster-rental data to conflict), but running it anyway keeps the
   staging runbook identical to the Production one.
4. **Configure Stripe Test Mode credentials** into Vercel's
   Preview-scoped environment variables (see §7) — staging Supabase +
   Stripe Test Mode together are what a Preview deployment should use.
5. **Register the Stripe webhook** pointing at the Preview deployment's
   `/api/stripe-webhook` URL (Stripe Dashboard → Developers → Webhooks,
   Test Mode) and copy its signing secret into
   `STRIPE_WEBHOOK_SECRET` (Preview-scoped).

**Why this session does not execute any of this**: it requires direct
Supabase SQL execution against a real (even if non-production) database,
and the task's own instructions plus this project's standing safety rules
require the owner to run schema-affecting SQL themselves, the same
established pattern every prior stage in this project has followed.

## 6. Stripe Customer/PaymentMethod strategy

- **Customer**: created once per booking's payment-intent-creation call,
  reused across a repeat customer's later rentals via the most recent
  `rental_payments.stripe_customer_id` on file for that local customer
  (matched by the existing exact phone+email rule) — see §2.2.
- **PaymentMethod**: never stored as a raw card — only the opaque
  `stripe_payment_method_id` (e.g. `pm_...`), saved automatically via
  `setup_future_usage: "off_session"` once the initial PaymentIntent is
  captured. Used for every later admin-approved off-session charge against
  that booking.

## 7. Environment variables

Confirmed as the exact minimum set this codebase reads (grepped every
`process.env.STRIPE_*` reference):

- `STRIPE_SECRET_KEY` — server-only, never sent to the browser.
- `STRIPE_PUBLISHABLE_KEY` — echoed by `GET /api/book`, safe for the
  browser by Stripe's own design (same trust model as any publishable
  key).
- `STRIPE_WEBHOOK_SECRET` — used directly by `api/stripe-webhook.js` for
  `stripe.webhooks.constructEvent()`; not read anywhere else.

No fourth variable (no separate "environment" flag) is needed — Stripe
keys are self-describing (`pk_test_...`/`sk_test_...` vs.
`pk_live_.../sk_live_...`), avoiding a second, potentially-inconsistent
source of truth for test vs. live mode, the same reasoning the original
`GET /api/book` response already used for Braintree's tokenization key.

Recommended: set all three to Stripe **Test Mode** values under Vercel's
"Preview" environment scope, and real **Live Mode** values under
"Production" — a dashboard configuration step, not something this repo's
code can enforce or verify.

## 8. Tests

**All 15 explicitly required scenarios are covered**, plus the full
existing regression suite, in
`tests/phase3c-stage2.5v2-stripe-rental-payments.test.js` (77 tests) and
the rest of the full suite (677 tests total across 19 files):

1. Successful $349 booking.
2. Card decline (at capture time, a `StripeCardError`).
3. PaymentIntent requiring customer action (admin off-session charge
   flow — §2.6).
4. Same idempotency key submitted concurrently (true `Promise.all`
   concurrency).
5. Two different clients racing the same slot (true concurrency).
6. Exactly one customer charged in the slot race (proven via
   `captureCallLog.length === 1`, not just HTTP status codes).
7. Proposal creates zero Stripe charges.
8. Approved additional charge creates exactly one PaymentIntent
   (`confirmChargeCallLog.length === 1`).
9. Double approval cannot double-charge (both sequential and true-
   concurrent).
10. Failed off-session charge remains recoverable (a clean decline is
    retryable via Approve again).
11. Off-session authentication-required state (marked
    `requires_customer_action`, recovered via `check-status`, never
    falsely paid, never blindly retried).
12. Webhook duplicates are idempotent (`payment_intent.succeeded`
    processed twice lands on the same end state).
13. Dispute events (`charge.dispute.created`/`.closed`).
14. Agreement/rate snapshot remains historical (an admin-proposed charge
    on an older booking uses that booking's own locked-in rate, not the
    current global rate).
15. Processor success followed by DB persistence failure/reconciliation
    (both the booking-flow and admin-charge-flow retry-then-fallback
    paths, plus the webhook's own self-healing reconciliation of a stuck
    row — going beyond the original Braintree design, since Stripe's
    `payment_intent.succeeded` is a genuine backstop unlike Braintree's
    ACH/SEPA-only settlement events).

All Stripe interaction is faked via the same `Module._load` interception
convention every other test file in this project already uses — no real
Stripe account, no real network call, no sandbox transaction of any kind.

## 9. Build / function count

`vercel build` succeeds locally (`.vercel/output` — no deployment, no
network call to Vercel beyond what the CLI itself needs to build). Function
count confirmed at exactly **12/12** directly against the real build
output (`.vercel/output/functions/api/**/*.func`), not inferred from
source alone.

## 10. Rental agreement — still NOT production-ready; business decisions
still needed (carried over verbatim from the Braintree-era hardening
audit — nothing here changed by the processor swap, since none of it is
processor-specific)

The current agreement text in `book/index.html` covers only the rate and
payment-authorization mechanics originally requested. It does **not**
address (deliberately — these are business policy decisions this document
does not invent):

- Prohibited/hazardous materials and any maximum weight beyond the
  included 2 tons.
- Loading/overfilling rules (e.g. must material stay below the rim?).
- Placement authorization — who is responsible for confirming the
  placement location is structurally/legally OK (driveway load limits,
  HOA rules, permits for street placement, etc.)?
- Property, driveway, or access damage responsibility.
- Moving/relocating the dumpster once delivered — is that allowed, does it
  cost extra, who's liable if it damages something?
- Blocked or failed pickup (e.g. a car parked in front of it) — is there a
  fee, how is it handled?
- Cancellation/rescheduling policy and any associated fee.
- Whether taxes/fees apply on top of the $349 (Colorado sales tax
  treatment for this kind of rental — a real question this document
  cannot answer without legal/accounting input).
- Dispute/contact procedure beyond "call 303-990-1812."

**This remains a checklist of business decisions needed from the owner
before final legal review** — not touched, not invented, by this
migration.

## 11. Open items flagged for the owner (not blocking implementation)

- Final legal wording of the rental agreement (§10) — draft language only.
- Whether a successfully paid online rental should also auto-populate the
  admin's `final_price`/"Actual Job Amount Collected" field — carried over
  unresolved from the Braintree-era proposal, unrelated to the processor
  swap.
- 3D Secure / Stripe Radar fraud-rules configuration — not built, not
  requested; the manual-capture architecture (§2.1) already provides some
  fraud protection (a hold can be released without ever moving money), but
  dedicated fraud tooling (Stripe Radar rules, 3DS enforcement policy) is a
  Dashboard-configurable, separate concern from this stage's scope.
- No automated cleanup for an orphaned `processing`
  `rental_payments`/`rental_additional_charges` row from a mid-request
  crash — surfaced in the admin UI (and now, additionally, self-healed by
  the webhook when Stripe's own event eventually arrives — §2.7) rather
  than auto-resolved by a cron job. Vercel Hobby's cron limitations
  (2 jobs, daily) make a polling-based auto-heal impractical regardless.
- Whether to configure Stripe's automatic off-session-authentication
  customer email (§2.6) — a Dashboard setting, not code; flagged, not
  configured by this session.
- Exact wording/branding of the automatic email Stripe sends the customer
  for off-session authentication (if that Dashboard setting is enabled) —
  a Stripe-hosted, Stripe-branded flow by default; whether to customize it
  is a separate Dashboard concern.

## 12. Next steps for Stripe Test Mode + the isolated Vercel Preview

1. Owner creates/accesses a Stripe account and switches to **Test Mode**.
2. **Developers → API keys**: copy the Test Mode **Publishable key**
   (`pk_test_...`) and **Secret key** (`sk_test_...`).
3. **Developers → Webhooks** (Test Mode) → add an endpoint pointing at the
   Preview deployment's `https://<preview-domain>/api/stripe-webhook`.
   Subscribe to at minimum: `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `payment_intent.canceled`,
   `charge.dispute.created`, `charge.dispute.closed`,
   `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`.
   Copy the endpoint's **Signing secret** (`whsec_...`).
4. In Vercel's dashboard, set `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
   `STRIPE_WEBHOOK_SECRET` scoped to **Preview** only (leaving Production's
   Stripe env vars, if any exist yet, untouched) — per §5.2, this Preview
   should also point at the isolated staging Supabase project (already
   configured per the task brief), never at production Supabase.
5. Execute the staging cleanup/reset plan in §5.2 (owner-run, not this
   session).
6. Push `phase-3c/stage2.5-stripe-rental-payments` to `origin` (requires
   the owner's own explicit push authorization, same pattern as every
   prior stage) to trigger a Preview deployment.
7. Run a first end-to-end Stripe Test Mode checkout against that Preview +
   staging Supabase, using Stripe's documented test card numbers (e.g.
   `4242 4242 4242 4242` for a guaranteed success; consult Stripe's current
   testing reference for decline/`authentication_required` test cards
   before relying on a specific number, the same "verify before relying on
   it" discipline the original Braintree readiness pass used for its own
   test-card guidance).
8. Only after a real Test Mode checkout, an admin-approved additional
   charge, and a verified webhook delivery have all been confirmed working
   end-to-end against staging should Production rollout even be
   considered — and that remains the owner's own explicit go/no-go
   decision, not something this document authorizes.
