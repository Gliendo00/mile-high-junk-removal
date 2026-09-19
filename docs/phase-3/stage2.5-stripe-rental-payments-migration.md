# Phase 3C Stage 2.5-v2 — Dumpster Rental Real Booking + Stripe Payments
# (Braintree → Stripe migration)

Status: **implementation complete, still not deployed to Production** — no
push to `main`, no Production Supabase migration, no real transaction of
any kind against Production. **Staging is no longer clean/unmigrated**:
the Stripe schema migration has been run against the isolated staging
Supabase project, and one real end-to-end $349 Stripe **Test Mode**
dumpster booking has been completed against it successfully — see §5.2 for
the exact current staging state, the service_role permissions gap that
testing surfaced (and its fix, §5.3), and the one-time `signature_name`
catch-up staging needs now that the typed-electronic-signature feature has
been added after that test booking was made (§5.4). Performed 2026-09-18,
on branch
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

### 4a. Later hardening pass (this session) — signature, staging grants, retry fix

Performed after the original implementation above, once staging testing
(§5.2) had already happened. Still uncommitted, still on this same
branch, still not pushed.

**Added:**
- `sql/2026-09-18_phase3c-stage2.5-service-role-grants.sql` — see §5.3.
- `sql/2026-09-18_phase3c-stage2.5-staging-signature-backfill.sql` — see
  §5.4. Staging-only; not executed by this session.

**Modified:**
- `book/index.html` — new "Electronic Signature" field (label, helper
  text, required text input) directly below the agreement checkbox, same
  card. The earlier white-background fix on `#rental-agreement-text`
  (`background:#fff;color:#111827`) is preserved, untouched.
- `book/book.js` — `pay-and-book-btn` now also requires a non-empty typed
  signature before proceeding (client-side gate, mirrors the existing
  agreement-checkbox gate); sends `signatureName` in the finalize payload.
  Also: the failure-path retry/lock fix, through two corrections (§13.1,
  §13.3) to its final three-way design — confirmed-dead → fresh
  PaymentIntent, ambiguous → locked payment panel (new `state.paymentLocked`),
  purely client-side → unchanged, still retryable.
- `api/book.js` — `validateBooking()` requires and sanitizes
  `payment.signatureName` whenever `requirePaymentMethod` is true (finalize
  only, never at PaymentIntent creation); `handleDumpsterRentalBooking()`'s
  `rental_payments` insert now writes `signature_name`. Also:
  `handleDumpsterRentalBooking()` now returns an explicit
  `retryWithNewPaymentIntent: true` on exactly the 10 failure branches
  proven to have cancelled/confirmed-dead this request's own PaymentIntent,
  and a separate `paymentStatusPending: true` on exactly the 3 branches
  that are a TRUE payment-ambiguous/reconciliation outcome — see §13.2's
  per-branch audit table and §13.3 for the flag split.
- `sql/2026-09-18_phase3c-stage2.5v2-stripe-rental-payments.sql` — added
  `signature_name text NOT NULL` to the `rental_payments` `CREATE TABLE`
  (this file had not yet been run against Production when this column was
  added — see §5 for why editing it directly, rather than a separate
  `ALTER TABLE`, was the smallest clean change for a fresh Production
  install; staging's own catch-up is §5.4, a separate file, since staging
  already had the table before this column existed).
- `tests/phase3c-stage2.5v2-stripe-rental-payments.test.js` — default
  payload now includes a signature; tests for missing/whitespace/null
  `signatureName` (400) and for `signature_name` persistence on a
  successful booking; tests asserting `retryWithNewPaymentIntent` AND
  `paymentStatusPending` across every confirmed-dead/ambiguous failure
  branch (§13.2/§13.3), plus exact-count checks on both flags; static
  source-pattern tests against `book/book.js`'s actual catch-handler logic
  (§13.3). 88 tests in this file now (was 77 before any of this session's
  work).
- `tests/phase3b-step4a3-repeat-client-reuse.test.js` — this file's own,
  separate dumpster-rental payload builder needed `signatureName` added
  too (see §8) — an unrelated fixture gap the full suite run surfaced, not
  itself part of the retry/grants/signature work.

## 5. Database schema changes — clean Stripe schema, not a conversion

Production has **never** received the Braintree-schema migration (it was
committed but never run against any environment). The committed migration
for this branch is therefore a clean Stripe schema from the start — see
`sql/2026-09-18_phase3c-stage2.5v2-stripe-rental-payments.sql` for the full
file.

**Current status, accurately, per environment:**
- **Production**: has NOT received this migration. No Stripe-schema object
  (index, table, or grant) exists there. §5.1 is the exact, still-unrun
  rollout plan for when that happens.
- **Staging**: HAS received this migration — see §5.2 for the exact
  current state, §5.3 for a permissions gap staging testing surfaced (and
  its fix, tracked as its own file rather than left as an undocumented
  manual step), and §5.4 for the one schema catch-up staging still needs
  (`signature_name`, added to this file after staging's test booking was
  already made).

Summary of what the migration file adds, and nothing else:

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
5. Run `sql/2026-09-18_phase3c-stage2.5-service-role-grants.sql` — grants
   `service_role` exactly the CRUD it needs on all five tables this flow
   touches (`customers`, `bookings`, `dumpster_rentals`, `rental_payments`,
   `rental_additional_charges`), schema-qualified as `public.*`. Do this
   as a standard, visible step of the rollout — not an ad hoc manual grant
   run from memory — see §5.3 for why this step exists at all. This step
   does **not** touch `anon`/`authenticated` privileges on any of these
   tables — see §5.3 for why that's deliberately out of scope here.

No data migration, no backfill, no Braintree-schema teardown — this is a
purely additive migration against the current, unmodified Production
schema.

### 5.2 Staging — what was actually run, and its current state

**This section is no longer a plan — it is a record of what has actually
happened against the staging Supabase project.** Staging is **not**
clean/unmigrated. Do not assume otherwise when working against it.

**What was run, in order:**
1. The Braintree-schema objects that pre-existed in staging (from earlier
   Braintree-era testing) were dropped, per the rollback block previously
   documented in this section (now historical — see git history of this
   file if that exact block is needed again).
2. `sql/2026-09-18_phase3c-stage2.5v2-stripe-rental-payments.sql` (this
   branch's Stripe schema) was run against staging in full — the unique
   delivery-slot index, `rental_payments`, and `rental_additional_charges`
   all exist there today.
3. Stripe Test Mode credentials and the Stripe webhook were configured
   against a Preview deployment pointed at staging Supabase.
4. **One real end-to-end $349 Stripe Test Mode dumpster booking was
   completed successfully** — a genuine `paymentIntents.create` →
   `confirmPayment` → capture round trip against Stripe's Test Mode API,
   landing a `rental_payments` row with `payment_status: "paid"`.

**Current staging state, precisely:**
- `rental_payments` and `rental_additional_charges` exist, with the exact
  shape `sql/2026-09-18_phase3c-stage2.5v2-stripe-rental-payments.sql` had
  **at the time staging was migrated** — which was *before*
  `signature_name` was added to that file for the typed-electronic-
  signature feature (this same working tree, later). Staging's
  `rental_payments` therefore does not yet have that column. See §5.4.
- That one successful test booking's `rental_payments` row is real data
  staging now carries forward — it must not be deleted or treated as
  disposable. See §5.4 for how its schema catch-up handles that row
  specifically.
- `bookings`/`customers`/`dumpster_rentals` were never touched by either
  migration and remain on the Production baseline schema.
- Staging testing surfaced a `service_role` permissions gap not caught by
  anything above — see §5.3.

### 5.3 Permissions gap discovered during staging testing, and its fix

The booking/payment flow did not work against staging until `GRANT`
statements were run by hand, directly in the Supabase SQL editor. That
got staging working, but left Production dependent on someone repeating
that exact undocumented step from memory during a future Production
rollout — precisely the kind of step that gets missed.

**Root cause**: `service_role` was missing `SELECT`/`INSERT`/`UPDATE`/
`DELETE` on some or all of the five tables this flow touches (`customers`,
`bookings`, `dumpster_rentals`, `rental_payments`,
`rental_additional_charges`). Supabase normally back-fills `service_role`'s
table privileges via `ALTER DEFAULT PRIVILEGES`, but that default only
applies to tables created by the exact role it was declared for — when a
table is created by a different role (e.g. directly in the SQL editor, or
by a migration run under a different session), that default silently does
not apply. That is exactly the gap staging hit, and it's a plain grant
gap, independent of RLS.

**Correction (2026-09-18, after review)**: an earlier draft of this
write-up, and of the fix file itself, additionally claimed "none of these
tables have row-level security enabled" and paired the `service_role`
grant with a `REVOKE ALL ... FROM anon, authenticated` on all five
tables. Both are wrong/premature and have been removed:
- Staging testing directly observed that **`public.bookings` has RLS
  enabled**. The blanket "no RLS anywhere" claim was never actually
  verified against staging and should not have been stated as fact.
- Changing `anon`/`authenticated` privileges on `customers`, `bookings`,
  or `dumpster_rentals` has **not** been proven safe — that needs its own
  dedicated privilege/RLS audit (what RLS policies exist today on each
  table, what `anon`/`authenticated` can currently do and why, whether
  anything already depends on that) before touching that surface at all.
  That audit has not been done and is out of scope for this Stage 2.5
  fix.

**Fix, narrowed accordingly**:
`sql/2026-09-18_phase3c-stage2.5-service-role-grants.sql` — grants
`service_role` `SELECT, INSERT, UPDATE, DELETE` on exactly the five
`public.`-qualified tables above. **Does not touch `anon`/`authenticated`
privileges at all.** Idempotent; safe to run once against staging
(replacing the ad hoc manual grants with this same tracked state) and as
§5.1 step 5 during a clean Production install. See that file for the full
statement, a verification query for the grant, and an *informational*
query showing each table's actual current RLS-enabled state (not changed
by this file — for visibility only, so this doesn't happen again).

### 5.4 `signature_name` staging catch-up — plan only, not executed

Staging's `rental_payments` predates the typed-electronic-signature
feature (§5.2), so it's missing the `signature_name` column that
`sql/2026-09-18_phase3c-stage2.5v2-stripe-rental-payments.sql` now defines
as `NOT NULL` from birth. A plain `ADD COLUMN ... NOT NULL` would fail
outright against staging's one existing `rental_payments` row (no default
to fill it with).

`sql/2026-09-18_phase3c-stage2.5-staging-signature-backfill.sql` is the
exact plan for this — **staging-only, three statements (add nullable →
backfill only NULL rows with an explicit, unmistakably-not-a-real-name
sentinel string → lock to NOT NULL), never a fabricated legal name for
that pre-existing row.** See that file for the full statements, the
reasoning for the sentinel-over-nullable-forever choice, and verification
queries. Not run by this session — run it manually against staging only,
never against Production (which gets `signature_name` directly from the
main `CREATE TABLE`, with nothing to catch up).

**Why none of this is executed by this session**: every statement above
requires direct Supabase SQL execution against a real (even if
non-production) database, and this project's standing safety rules
require the owner to run schema-affecting SQL themselves — the same
established pattern every prior stage here has followed.

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
`tests/phase3c-stage2.5v2-stripe-rental-payments.test.js` (88 tests) and
the rest of the full suite (**688 tests total across 19 files, 0 failed**
— re-run in full again after the §13.3 correction pass; also fixed one
unrelated fixture gap it surfaced in
`tests/phase3b-step4a3-repeat-client-reuse.test.js`, whose own separate
dumpster-rental payload builder needed `signatureName` added, same as
`validDumpsterPayload` in this file):

**Test-count reconciliation (677 → 680 → 682 → 688)** — four real,
additive checkpoints, not a discrepancy:
- **677**: the original Stage 2.5 Stripe-migration checkpoint (§1–§3),
  before the signature feature or any of this hardening pass existed.
- **680** (+3): the electronic-signature feature's own validation tests —
  missing/whitespace/null `signatureName` each rejected with 400 (§4a).
  `tests/phase3c-stage2.5v2-stripe-rental-payments.test.js` went 77 → 80.
- **682** (+2): the first retry/idempotency-safety correction's new tests
  (§13.2) — one asserting `retryWithNewPaymentIntent: true` for a
  `canceled`-status PaymentIntent (a scenario with no prior test), and one
  for a customer-insert failure (also previously untested). 80 → 82.
- **688** (+6): the second correction's tests (§13.3) — the
  `paymentStatusPending: true`/`retryWithNewPaymentIntent: true`
  exact-count check, and five static source-pattern tests against
  `book/book.js`'s actual catch-handler branches (the `paymentLocked`
  guard, and each of the three mutually-exclusive branches A/locked/D).
  82 → 88.

Verified nothing was silently lost along the way: `grep -c '^test("'
tests/phase3c-stage2.5v2-stripe-rental-payments.test.js` returns exactly
**88**, matching the 88 actually executed — no test is registered but
skipped, and every file in `tests/*.test.js` (19 files, unchanged count)
still runs and reports a non-zero test count. The one other file touched
this pass, `tests/phase3b-step4a3-repeat-client-reuse.test.js`, had its
fixture corrected but its own test count is unchanged at 14 (no test
added or removed there — only a missing field added to an existing
payload builder).

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

**Added in the §4a hardening pass**: missing/whitespace/null
`signatureName` each rejected with 400 (mirrors the existing
`agreementAccepted` validation tests); a successful booking persists
`signature_name` on the `rental_payments` row.

**Added in the §13.2 correction pass**: `retryWithNewPaymentIntent`
asserted directly on the response body for both sides of the A/B
distinction — see §13.2's table for the full list of branches now
covered (a `canceled`-status PaymentIntent and a customer-insert failure
newly get dedicated tests; the decline, ambiguous-capture, slot-conflict,
concurrent-duplicate, resubmit-after-ambiguous, `dumpster_rentals`-insert-
failure, and `requires_payment_method` tests all gained a
`retryWithNewPaymentIntent` assertion alongside their existing checks).

**Added in the §13.3 correction pass**: `paymentStatusPending` asserted
on the three true payment-ambiguous branches (existing-row
`error_pending_review`, concurrent-duplicate `processing`, ambiguous
capture-throw), plus an exact-count test on both flags in `api/book.js`
(`paymentStatusPending: true` × 3, `retryWithNewPaymentIntent: true` ×
10). Plus a new static source-pattern section (§10 in this test file)
verifying `book/book.js`'s actual catch-handler branches directly —
`state.paymentLocked`'s existence and its guards on `showPaymentPanel()`/
the click handler, and each of the three mutually-exclusive branches
(confirmed-dead resets and remints; locked/ambiguous disables both
buttons, unmounts the Payment Element, and contains no
`initPaymentElement()`/`newIdempotencyKey()`/genuine `confirmPayment({`
call; purely-client-side stays retryable with nothing reset).

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
5. ~~Execute the staging cleanup/reset plan~~ — **done** (owner-run). See
   §5.2 for the current staging state and §5.3 for a permissions gap that
   testing surfaced, since fixed as its own tracked migration.
6. Push `phase-3c/stage2.5-stripe-rental-payments` to `origin` — **still
   not done**; requires the owner's own explicit push authorization, same
   pattern as every prior stage.
7. Run a first end-to-end Stripe Test Mode checkout against staging — **done**:
   one real $349 booking completed successfully (§5.2). Still worth running
   Stripe's documented decline/`authentication_required` test cards before
   relying on those paths, the same "verify before relying on it"
   discipline the original Braintree readiness pass used for its own
   test-card guidance.
8. Only after a real Test Mode checkout (**done**), an admin-approved
   additional charge, and a verified webhook delivery have all been
   confirmed working end-to-end against staging should Production rollout
   even be considered. The additional-charge and webhook-delivery legs are
   **not yet confirmed** as of this write-up — that, and the final
   go/no-go, remain the owner's own explicit decision, not something this
   document authorizes.
9. Before any Production rollout: apply the schema fixes above against
   Production in the order §5.1 documents (now including its step 5, the
   `service_role` grants), so Production never depends on a manual grant
   run from memory the way staging briefly did.

## 13. Frontend retry/reset fix — a canceled PaymentIntent could not be retried

**Bug, discovered during staging testing**: after a failed booking attempt
whose PaymentIntent got canceled server-side (e.g. the delivery slot was
lost to a concurrent booking), clicking "Pay & Book Now" again failed with
Stripe's `payment_intent_unexpected_state` — the customer had no way to
recover without reloading the whole page and re-entering everything.

**Root cause**: `book/book.js` generates `state.idempotencyKey` once per
checkout attempt and deliberately reuses it across a retry — correct and
necessary so a genuine same-attempt resubmit (e.g. a network hiccup) can
never double-book or double-charge. The bug: the client kept reusing the
very same `state.paymentIntentId`/`state.stripeElements`/
`state.idempotencyKey` for the next click regardless of *why* the previous
attempt failed. Retrying against a dead PaymentIntent's idempotency key
calls `stripe.paymentIntents.create()` again with the *same* Stripe
idempotency key (`"intent:" + idempotencyKey`), which — per Stripe's own
idempotency-key contract — returns the identical cached (and now dead)
PaymentIntent object rather than creating a new one. `confirmPayment()`
against that object is exactly what `payment_intent_unexpected_state`
means.

### 13.1 First-draft fix — too broad, corrected after review

The first draft of this fix reset and re-minted a PaymentIntent on ANY
non-2xx finalize response (keyed off the existing `err.isServerMessage`
flag, set whenever the finalize `POST /api/book` was sent and came back
non-2xx). That is **too broad** and was corrected: several failure
branches in `handleDumpsterRentalBooking()` return non-2xx *without* the
PaymentIntent being confirmed dead — most importantly the AMBIGUOUS
capture-failure path (§8's `error_pending_review`, where Stripe's own
capture call timed out with no definitive answer — the charge **may have
actually succeeded**) and `paid_reconciliation_required` (Stripe
DEFINITELY captured the charge; only the local confirmation write failed).
Auto-minting a second PaymentIntent after either of those would risk a
second live authorization — or worse, a second charge attempt — against a
request whose outcome isn't known or has already resolved successfully.
`isServerMessage` alone cannot distinguish "definitely dead, safe to
replace" from "unresolved, do not touch."

### 13.2 Corrected design — explicit, per-branch server confirmation

**Backend — `api/book.js`, `handleDumpsterRentalBooking()`**: every
failure response now carries an explicit `retryWithNewPaymentIntent`
boolean, set to `true` **only** on a response the code has *positively*
confirmed corresponds to a dead PaymentIntent — never inferred from "the
server said no." Full branch-by-branch audit, in the order they appear in
the function:

| Branch | Response | PaymentIntent confirmed dead? | Flag |
|---|---|---|---|
| Idempotency lookup DB error | 500 | No — untouched | unset |
| Existing row: `error_pending_review` (prior ambiguous attempt) | 409 | No — outcome of prior attempt still unknown | unset |
| Existing row: `processing` (concurrent duplicate) | 409 | No — a sibling request may still need it | unset |
| Stripe not configured | 500 | No — untouched | unset |
| `paymentIntents.retrieve()` throws | 400 | No — unknown/possibly transient | unset |
| `metadata.idempotencyKey` mismatch (foreign/stale PI) | 400 | No — not confirmed, not ours to declare | unset |
| `intent.status === "canceled"` | 402 | **Yes — Stripe's own positive confirmation** | **`true`** |
| `intent.status` is anything else non-`requires_capture` (e.g. `succeeded`, `requires_action`) | 402 | No — `succeeded` could mean money already moved; others are incomplete, not dead | unset |
| Amount mismatch (defensive; "should never happen") | 400 | No — not cancelled by this branch | unset |
| Customer insert fails | 500 | **Yes — `cancelPaymentIntent()` called directly** | **`true`** |
| `rental_payments` insert: idempotency race (unique violation) | 409 | No — explicitly NOT cancelled (comment: "the other request may be about to capture it") | unset |
| `rental_payments` insert: other error | 500 | **Yes — `cancelPaymentIntent()` called** | **`true`** |
| `bookings` insert: slot conflict (unique violation) | 409 | **Yes — via `rollbackDumpsterBooking()`** | **`true`** |
| `bookings` insert: other error | 500 | **Yes — via `rollbackDumpsterBooking()`** | **`true`** |
| `rental_payments` → booking link-back update fails | 500 | **Yes — via `rollbackDumpsterBooking()`** | **`true`** |
| `dumpster_rentals` insert fails | 500 | **Yes — via `rollbackDumpsterBooking()`** | **`true`** |
| Capture: `StripeCardError` (definitive decline) | 402 | **Yes — via `rollbackDumpsterBooking()`; Stripe confirms no money moved** | **`true`** |
| Capture: any other thrown error (ambiguous — network/timeout) | 502 | **No — outcome unknown, may have captured; rows preserved, `error_pending_review`** | **unset** |
| `captured.status !== "succeeded"` (defensive) | 402 | **Yes — via `rollbackDumpsterBooking()`** | **`true`** |

**Frontend — `book/book.js`**: the finalize POST's error object now
carries `retryWithNewPaymentIntent` straight from the response body
(`reqErr.retryWithNewPaymentIntent = !!(resBody && resBody.retryWithNewPaymentIntent === true)`).
The `.catch()` handler's reset-and-remint logic (null
`paymentIntentId`/`stripeElements`, unmount the Payment Element, mint a
new `idempotencyKey`, call `initPaymentElement()` again) now runs **only**
when that flag is `true` — never merely because the request failed.
Every ambiguous/unresolved case (concurrent duplicate, `error_pending_review`,
an amount-mismatch or foreign-PI edge case) instead just re-enables the
Pay button with the same still-referenced PaymentIntent/idempotencyKey;
if the customer clicks again, the SAME idempotency key reaches the SAME
idempotency pre-check at the top of `handleDumpsterRentalBooking()`,
which is what actually prevents any repeat action from creating a new
payment attempt — the frontend doesn't need to (and must not) make that
call itself.

**Deliberately still left untouched**: a purely client-side rejection —
Stripe.js's own inline validation (e.g. an incomplete card number), or a
decline `confirmPayment()` itself surfaces before any server call is even
made — never sets `isServerMessage` at all. See §13.3 for how this stays
distinct from case B below, which §13.2's own first pass got wrong.

### 13.3 Second correction — re-enabling Pay for an ambiguous outcome was itself unsafe

**Bug in §13.2's own design, caught before approval**: for the ambiguous/
~unresolved case (`isServerMessage` true, `retryWithNewPaymentIntent`
false/absent), §13.2 simply re-enabled `payAndBookBtn` and left the same
PaymentIntent/Elements mounted — reasoning that since no *new* attempt was
being minted, nothing further was needed. That reasoning missed something
important: by the time the finalize `POST /api/book` is ever sent,
`stripe.confirmPayment()` has **already succeeded once** against this
exact PaymentIntent (that success is the precondition for reaching the
finalize call at all). Its Stripe-side status from that point on could be
`requires_capture`, `succeeded`, `canceled`, or something else entirely —
and calling `confirmPayment()` on it a **second time**, which simply
re-enabling the button invites, can itself throw
`payment_intent_unexpected_state` — the exact failure this whole fix
exists to prevent, just reached one click later. "We didn't mint a new
PaymentIntent" and "it's safe to let the customer click Pay again" are
NOT the same guarantee, and §13.2 conflated them.

**Corrected behavior** — `book/book.js`'s catch handler is now a genuine
three-way branch, not two:

1. **`retryWithNewPaymentIntent: true`** (confirmed dead) — unchanged
   from §13.2: reset `paymentIntentId`/`stripeElements`, unmount the
   Payment Element, mint a fresh `idempotencyKey`, call
   `initPaymentElement()` again. Re-enables `paymentBackBtn` too (a fresh
   attempt is starting; going back to Review is fine again).
2. **`isServerMessage` true, `retryWithNewPaymentIntent` NOT true**
   (ambiguous/unresolved) — **the payment panel is now locked**, not just
   left as-is:
   - `state.paymentLocked = true` (new state field; also guards
     `showPaymentPanel()` and the very top of the click handler itself, so
     there is no code path — not even "Back to Review" then forward again
     — that can re-enter `initPaymentElement()` and reuse the same tainted
     `idempotencyKey`, or re-run `confirmPayment()` against the same
     PaymentIntent).
   - `payAndBookBtn.disabled = true` AND `paymentBackBtn.disabled = true`
     — both, permanently, for the rest of this page load. The only way to
     try again is a full page reload: a genuinely new attempt, with a new
     `idempotencyKey` and a new PaymentIntent, sharing nothing with the
     stuck one.
   - The mounted Payment Element is unmounted.
   - The customer sees a dedicated, customer-safe message — **only** when
     `paymentStatusPending` (below) is also set — instead of a generic
     "try again": *"Your payment status is being verified. Please do not
     submit another payment. If your booking is confirmed, we'll process
     it automatically. If you need help, call or text 303-990-1812."*
     When `paymentStatusPending` is not set (a non-payment-ambiguous
     failure, e.g. a stale/foreign PaymentIntent or a config error), the
     server's own specific message is shown instead — still locked either
     way, since the danger (a second `confirmPayment()` call) is identical
     regardless of *why* the outcome wasn't confirmed dead.
3. **`isServerMessage` not set** (purely client-side — Stripe.js
   validation, or a decline `confirmPayment()` itself surfaces, before any
   server call was ever made) — unchanged from §13.2's intent, genuinely
   preserved this time: `confirmPayment()` never succeeded for this
   attempt, so the same PaymentIntent/Elements remain safely retryable.
   Both buttons re-enabled, nothing unmounted, nothing reset.

**New backend flag — `paymentStatusPending: true`** (`api/book.js`,
alongside `retryWithNewPaymentIntent`, never both on the same response):
set explicitly on exactly the three TRUE payment-ambiguous/reconciliation
branches in `handleDumpsterRentalBooking()` — never inferred from a
generic status code:
- The idempotency pre-check finding an existing row already stuck at
  `error_pending_review` (409).
- The idempotency pre-check finding a still-`processing` concurrent
  duplicate (409) — a sibling request has this same PaymentIntent live.
- The capture call itself throwing with no definitive answer (502, the
  canonical `error_pending_review`-setting branch).

Every other non-confirmed-dead branch (stale/foreign PaymentIntent, a
config error, a DB read error, a defensive amount mismatch, a non-`canceled`
non-`requires_capture` intent status) sets neither flag — still locked on
the frontend (§13.3 point 2 above applies to ALL of them, since the
`confirmPayment()`-reuse danger is the same), but shown its own existing,
already-accurate server message rather than the payment-specific pending
text.

**Preserved, unchanged**: manual capture, the original concurrency
protections (the `rental_payments`-before-`bookings` insert ordering and
its unique-constraint race handling), the idempotency-key contract itself,
and every reconciliation state/path (`error_pending_review`,
`paid_reconciliation_required`, the webhook's self-healing).

**Tests added** (`tests/phase3c-stage2.5v2-stripe-rental-payments.test.js`,
88 tests in this file now, up from 82):
- Backend, response-body assertions extending existing scenarios: all
  three `paymentStatusPending: true` sites now have a dedicated assertion
  (existing-row `error_pending_review`, concurrent-duplicate `processing`,
  ambiguous capture-throw), plus an exact-count check
  (`paymentStatusPending: true` appears exactly 3 times in `api/book.js`,
  `retryWithNewPaymentIntent: true` exactly 10 times) so a future edit
  that silently adds or drops a site fails loudly rather than passing
  quietly.
- Frontend, static source-pattern verification against `book/book.js`'s
  actual deployed source (this project's own established fallback for
  frontend behavior — see below): the three catch-handler branches are
  isolated by their exact, unique source boundaries and asserted against
  directly —
  - **A** (confirmed dead): resets `paymentIntentId`/`stripeElements`,
    mints a new `idempotencyKey`, unmounts and re-calls
    `initPaymentElement()`, never sets `paymentLocked`.
  - **B** (ambiguous/locked): sets `paymentLocked = true`, disables both
    buttons, unmounts the Payment Element, and critically does **NOT**
    contain `initPaymentElement()`, `newIdempotencyKey()`, or a genuine
    `.confirmPayment({` call anywhere in that branch.
  - **D** (ordinary client-side, still retryable): re-enables both
    buttons, never sets `paymentLocked`, never unmounts the Payment
    Element, never touches `paymentIntentId`/`idempotencyKey`.
  - `state.paymentLocked` is declared (`false` initially) and guards both
    `showPaymentPanel()` and the top of the click handler.
  - The crafted pending-review message is present and gated specifically
    on `err.paymentStatusPending`.

**Not implemented**: an automated *browser-executed* (DOM/Stripe-mock)
test for `book/book.js`. This project has no existing test harness that
executes any frontend file in a JS engine at all — every existing
frontend-file check elsewhere in this repo (e.g.
`tests/phase3c-stage2.4-address-and-prefill.test.js`, which explicitly
notes "there is no DOM/click simulation available in this project's test
setup") is the same static/regex-based source-pattern verification used
above, never simulated execution. Building a full Stripe-mock browser
harness from scratch for one fix was judged disproportionate scope, and
would itself be new project infrastructure well beyond this fix's size.
The static tests above guarantee the underlying control flow — which
branch touches which state, and that the three branches stay mutually
exclusive — will not silently regress; they were additionally
cross-checked by: (a) the full per-branch backend audit table in §13.2,
now backed by response-body assertions; (b) `node --check book/book.js`
and `api/book.js` (syntax); (c) a live page load with the change applied
showing zero console errors.
