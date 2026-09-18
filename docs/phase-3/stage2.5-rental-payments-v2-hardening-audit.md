# Phase 3C Stage 2.5-v2 — Pre-Deployment Payment Hardening Audit

Status: **audit complete, fixes implemented and tested. Still not deployed —
no push to `main`, no production Supabase migration, no real transaction.**
Performed 2026-09-18 against branch `phase-3c/stage2.5-rental-payments-v2`
at commit `4a73071` (the original implementation), before any production
rollout. This document is the durable record of what was found and fixed;
see the commits following `4a73071` on this branch for the actual diffs.

Goal: adversarially challenge the original implementation rather than
re-confirm it, specifically because this is money-moving code. Several real
defects were found — see §1–§8 below. Several other concerns raised in the
audit turned out, on inspection, to already be handled correctly by the
original design (insert-before-charge ordering); those are documented too,
with the reasoning, rather than silently assumed.

## 1. Outer-repo cleanup

The prior session added a `site-vercel-dev` entry to the **outer** repo's
`.claude/launch.json` without authorization. Surgically removed — only that
one block — leaving the outer repo's pre-existing uncommitted changes
(`site-static`'s args, the `prototype-preview` entry, `.claude/scheduled_tasks.lock`)
untouched. Nothing was committed in the outer repo, and nothing else in it
was touched.

## 2. Braintree webhook model — corrected

**Finding: the original implementation incorrectly assumed
`transaction_settled`/`transaction_settlement_declined` webhooks would fire
for card and Venmo transactions.** Per current Braintree documentation,
these two webhook kinds are available for **ACH and SEPA Direct Debit**
Transaction: Sale/Refund requests only — not for card or Venmo, which is
everything this feature actually processes. For this project's real
traffic, that webhook handling code was dead on arrival.

**Why this didn't cause a live bug**: `api/book.js` and
`api/admin/booking.js`'s `handleApproveCharge()` both mark
`payment_status`/`status` "paid" directly from `transaction.sale()`'s own
**synchronous** response — neither ever waited on or depended on a webhook
to confirm a charge. Per Braintree's own documentation, a transaction in
`submitted_for_settlement`/`settling`/`settled` is considered successful,
and a real synchronous `sale()` response is never literally "settled"
(that only happens in a nightly batch, hours later) — so this code was
already careful not to claim "settled" for something that had only been
submitted for settlement. The bug was in the webhook file's documentation
and its unused-for-card/Venmo settlement handlers, not in the core booking/
charge confirmation logic.

**Fix**: `api/braintree-webhook.js` is corrected to document this precisely
— the settlement handlers are kept (harmless, future-proofing if ACH/SEPA
is ever added) but explicitly marked as not relied upon for anything today.
What this app **actually** relies on the webhook for: **dispute
notifications** (`dispute_opened`/`dispute_lost`/`dispute_won`/
`dispute_accepted`), which do apply to card and Venmo and which this app
has no other way to learn about. Tests updated to document this
distinction (`tests/phase3c-stage2.5v2-rental-payments.test.js` §9).

**Vaulted-Venmo revocation**: Braintree has a
`payment_method_revoked_by_customer` webhook. Not subscribed to — a
revoked vaulted Venmo account simply fails cleanly (marked "failed",
safely retryable) the next time `handleApproveCharge()` tries to charge
it. Proactive handling would only provide earlier awareness, not different
correctness; not built, to avoid overengineering for the expected Venmo
volume. Documented in `api/braintree-webhook.js`'s header for
reconsideration if Venmo becomes a significant share of payments.

## 3. Idempotency/concurrency at the money-movement boundary

**Audited, found already correct, now proven with true concurrent tests
(not just sequential duplicate POSTs).**

The original design already inserts the idempotency-key-bearing
`rental_payments` row (a `UNIQUE` column) **before** calling
`gateway.transaction.sale()`, not after. This matters: for the exact race
the audit asked about (two concurrent requests, same idempotency key,
neither sees an existing row yet), only one can win the `INSERT` — the
loser hits a `23505` unique-violation, rolls back, and returns 409
**without ever calling Braintree**. The database's own unique-index
row-locking makes this atomic regardless of how many processes race it,
the same guarantee any ACID-compliant Postgres provides.

**New tests added** (`tests/phase3c-stage2.5v2-rental-payments.test.js`,
"CONCURRENCY" section) fire two requests via `Promise.all` — not
sequentially — so their internal `await`s genuinely interleave at each
step, the same way two separate serverless invocations hitting the same
real Postgres database would. Each test asserts on `saleCallLog.length`
(literally counting Braintree invocations), not just HTTP status codes:

- Same idempotency key, same slot → exactly one `transaction.sale()` call.
- Same slot, **different** idempotency keys (two different customers racing
  for the last slot) → exactly one `transaction.sale()` call; the loser is
  blocked at the `bookings` insert (see §4) before it ever reaches
  Braintree, so it retains **no** charge of any kind.
- Two simultaneous admin "Approve" clicks on the same additional charge →
  exactly one `transaction.sale()` call, via the same `.eq("status",
  "proposed")`-style optimistic-concurrency guard.

No code change was needed here — the audit's job was to prove the existing
ordering was actually correct, which it was.

## 4. Slot concurrency vs. payment concurrency

**Audited, found already correct, now proven** (same test file, same
section as §3). The `bookings` insert — the one the partial unique index
(`idx_bookings_dumpster_delivery_slot`) actually protects — happens
**before** the Braintree call in the code, not after. A losing concurrent
request for the same slot is rejected by the database at that insert step
and rolls back immediately; it never reaches the Braintree call at all, so
"Client A pays, Client B pays, then the DB decides" — the exact failure
mode described in the audit brief — cannot happen with this ordering.
Proven with the true-concurrency test in §3.

## 5. Payment success + database failure compensation — real defect, fixed

**This was a genuine, serious gap.** The original code treated every
Braintree-call failure identically — roll back everything (delete the
booking, the reservation, the idempotency claim). That is correct for a
**definitive decline** (`saleResult.success === false`, a clean answer from
Braintree: no money moved). It is **dangerous** for the case where
`gateway.transaction.sale()` itself **throws** — a network error, timeout,
or gateway 5xx — because Braintree may have actually processed the charge
on their end and the response simply never reached us. In that case:

- We have **no transaction id** to look up or void.
- Rolling back would delete the only record that a charge might have
  happened.
- Rolling back also frees the delivery slot immediately, so someone else
  could book (and pay for) it while the first charge's fate is unknown —
  and if the original customer's card *was* charged, they'd have paid for
  nothing.

**Fix**: a new `error_pending_review` state (added to both
`rental_payments.payment_status` and `rental_additional_charges.status`,
not yet run in production — see the updated SQL migration). On an ambiguous
Braintree-call failure, `api/book.js` and `handleApproveCharge()` now:

1. Preserve every row exactly as it is (no rollback, no deletion) — the
   booking, the customer, the reservation, the idempotency claim.
2. Mark the payment/charge `error_pending_review` with a reason that names
   the booking/charge id, amount, and instructs checking the Braintree
   dashboard for a matching transaction.
3. Tell the customer explicitly **not** to resubmit, and to call instead —
   never a generic "try again" message for this specific case.
4. Refuse any further automatic action: the idempotency pre-check (§3) and
   the charge-approval guard (§8) both explicitly exclude
   `error_pending_review` from anything retryable. Only a human, after
   checking Braintree directly, can move it forward (by editing the row
   directly, or — for the initial booking — the row already durably exists
   with `status: "booked"` so the client's slot is preserved either way).

For the **narrower**, already-safe case — Braintree gives a **definite
success** and only the *subsequent* "mark this paid in our database" write
fails — the fix reports success to the caller (the charge genuinely
succeeded; the booking row already existed before the charge was ever
attempted, so the customer's booking is valid regardless) while logging the
transaction id loudly for manual reconciliation, rather than falsely
telling an admin "could not process this charge" when money had, in fact,
already moved. New tests cover both the booking flow and the admin-charge
flow for this exact scenario.

## 6. Vault token behavior — verified against current documentation

Confirmed via Braintree's current documentation, not assumed:

- `transaction.creditCard.token` and `transaction.venmoAccount.token` (plus
  `.username` for a display-safe summary) are both real, populated fields
  on a successful transaction result when `storeInVaultOnSuccess: true` was
  passed — the original `extractPaymentMethodInfo()` already read the
  correct shape for both.
- `storeInVaultOnSuccess` without an explicit `customerId` in the sale
  request auto-creates a new Braintree Customer record — confirmed
  `transaction.customer.id` is populated in that case, matching what the
  code already stores as `braintree_customer_id`.
- Never stored: PAN, CVV, or the raw payment nonce as a reusable
  credential. Only the vaulted `paymentMethodToken` (opaque, revocable,
  useless outside this merchant account) and Braintree's own display-safe
  summary fields (card type + last 4, or Venmo username).
- No code change required — this section documents verification, not a
  fix.

## 7. Additional-charge approval safety — real gaps, fixed

Audited end to end against the brief's explicit checklist:

| Requirement | Status |
|---|---|
| Creating a proposal never calls Braintree | ✅ confirmed, tested |
| Editing/calculating a proposal never calls Braintree | ✅ (no edit path exists — a proposal is created once; changing it requires proposing a new one) |
| Page load never calls Braintree | ✅ (`GET ?resource=charges` is a read-only `select`) |
| Webhook never initiates an extra charge | ✅ (the webhook only ever updates existing rows by transaction id; it has no code path that calls `transaction.sale`) |
| No cron/background process initiates a charge | ✅ (none exists in this project) |
| Approval requires authenticated admin | ✅ `requireAdmin()` gates the whole route before any charges code runs |
| Amount is server-controlled | ✅ approval never reads an amount from the request body — only the row's own snapshotted `amount` |
| Booking/rental relationship validated server-side | ✅ propose confirms the booking exists and is `dumpster_rental` before inserting |
| Already-paid charge cannot be approved again | ✅ the approve transition only matches rows currently `proposed` or `failed` |
| Processing charge cannot be approved again | ✅ same guard — `processing` isn't in the retry-eligible set |
| Two simultaneous approvals cannot double-charge | ✅ **now proven** with a true-concurrency test (§3) |
| **Failed charge remains safely retryable without accidental duplication** | ❌ was a real gap — originally a dead end (see below) — **fixed** |
| Audit timestamps/statuses are retained | ✅ `proposed_at`/`approved_by`/`approved_at`/`failure_reason` all persisted |

**The retryability gap**: originally, the approve-transition guard only
matched `status = "proposed"` — once a charge was marked `"failed"` (a
clean decline), there was **no way to approve it again** through the API
at all, contradicting the brief's explicit requirement. **Fixed**: the
guard now accepts `status IN ("proposed", "failed")`, and the admin UI now
shows "Retry: Approve & Charge" on a failed charge. Rate math and the
approval-safety guarantees are identical on retry — only the starting
status differs. `error_pending_review` (§5) is deliberately **excluded**
from this retry set, since retrying an ambiguous outcome is exactly what
could cause a real double charge.

## 8. Rate-schedule snapshot — real gap, fixed

**Finding**: the original schema stored only the flat `amount_charged`
($349) on `rental_payments` — not the included days/tons or overage rates
that were actually in effect when a given rental was booked. Additional
charges were computed from `api/_lib/rental-pricing.js`'s **current**
global constants regardless of when the underlying booking happened. If
pricing ever changes, a historical booking's overage charges would
silently start using the new rate — not what the customer agreed to at
booking time.

**Fix**: `rental_payments` gains `base_rate`, `included_days`,
`included_tons`, `overage_ton_rate`, `overage_day_rate` — snapshotted at
booking-insert time from the (then-current) global constants, never
updated afterward. `handleProposeCharge()` now reads **this booking's own**
locked-in rate first, falling back to the current global rate only when a
booking has no `rental_payments` row of its own (e.g. an admin-created
dumpster rental that was never paid online, which locked in no schedule).
Tested for both the snapshot itself and the propose-time lookup precedence.

Confirmed already durable and correct, no change needed: `agreement_version`
+ `agreement_accepted_at` are stored per booking and never overwritten by a
later HTML change to the agreement text — changing `RENTAL_AGREEMENT_VERSION`
in `api/_lib/rental-pricing.js` is what "bumping the version" means, and a
historical booking's own `agreement_version` column is untouched by that.

## 9. Migration preflight

**Added, not yet run.** A read-only preflight query (in the SQL migration
file, §0, before the `CREATE UNIQUE INDEX` statement) finds any existing
`booked` dumpster-rental rows that already share the same
`(appointment_date, time_window)` — these would make the unique index fail
to build. Nothing is deleted, cancelled, or merged automatically; an
empty result means the index will build cleanly, a non-empty result names
the exact conflicting `booking_id`s for a manual decision.

**Predicate explanation** (why the index and preflight both filter to
`status = 'booked'` only): `booked` is the only status representing a
currently active, on-the-schedule reservation. `completed` rows are
historical — the same Tuesday 8–10am window will legitimately have many
completed rentals across different weeks, and none of that should ever
block a new booking. `new`/`contacted`/`quoted` have no confirmed
appointment at all, and `lost` fell through — neither represents a real
claim on the slot.

## 10. Preview vs. Production environment

**Braintree**: `BRAINTREE_ENVIRONMENT`/`BRAINTREE_MERCHANT_ID`/
`BRAINTREE_PUBLIC_KEY`/`BRAINTREE_PRIVATE_KEY`/`BRAINTREE_TOKENIZATION_KEY`
are plain environment variables this project controls — Vercel natively
supports scoping a variable differently per environment (Production vs.
Preview vs. Development). **Recommendation**: set these to Sandbox values
under "Preview" and real Production values under "Production" in the
Vercel dashboard. This is a dashboard configuration step, not something
this repo's code can enforce or verify — flagged for the owner to set up
before any Preview-deployment sandbox testing.

**Supabase — a pre-existing, already-documented fact, not introduced by
this feature**: per `docs/phase-3/stage2.1-new-job-proposal.md` §11 and
`docs/phase-3/stage2.4-expenses-migration.md`, **every Vercel Preview
deployment on this project points at the same production Supabase
database** — there is no separate staging database, and this repo has
been explicitly instructed (by the owner, in that earlier proposal) not to
invent one. This was already a known risk for ordinary admin-CRM testing;
it is a **materially bigger** risk for this feature specifically, because
a "harmless" sandbox Braintree checkout on a Preview deployment would still
write a real row into production `customers`/`bookings`/`dumpster_rentals`/
`rental_payments` — mixing fake-money test data into the real CRM.

**What needs to happen before real sandbox checkout testing** (not decided
here — the owner's call): either (a) accept that a Preview sandbox test
will create real rows in production tables and commit to deleting them
afterward (the cascade behavior already documented in
`docs/phase-3/database-schema-updates.md` means deleting the test
`customers` row cleanly removes its `bookings`/`dumpster_rentals`/
`rental_payments` row with it — **only** if that customer has no other
real bookings attached), or (b) stand up a genuinely separate, disposable
Supabase project for this specific testing, matching what the original
Stage 2.1 proposal already suggested as the only acceptable way to get a
real DB round-trip without touching production. This document does not
create a staging database — flagged for a decision, not invented.

## 11. Agreement data/versioning

Confirmed durable and correct (see §8): `agreement_version` and
`agreement_accepted_at` are stored per booking, immune to a later change
to the agreement text. The rate-schedule snapshot added in §8 extends this
same guarantee to the pricing breakdown, not just the total charged.

## 12. Rental agreement — NOT production-ready; business decisions needed

The current agreement text in `book/index.html` covers only the rate and
payment-authorization mechanics the brief explicitly asked for. It does
**not** address (deliberately — these are business policy decisions this
document does not invent):

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

**This is a checklist of business decisions needed from the owner before
final legal review**, not a request to guess at any of them.

## 13. 3D Secure — analysis only, not implemented this pass

- **Does the current tokenization-key architecture prevent 3DS?** Yes —
  confirmed via current Braintree documentation: a tokenization key cannot
  create a 3D Secure transaction. 3DS requires a server-minted client
  token instead.
- **Would switching to client tokens be required?** Yes, for 3DS
  specifically. Nothing else about the current architecture would need to
  change — the client-token-minting call could still be folded into the
  existing `GET /api/book` endpoint (zero new Vercel functions, same
  consolidation pattern already used throughout this feature).
- **Risk/fraud benefit**: 3DS can shift certain fraud/chargeback liability
  to the card issuer when properly completed, and is legally required in
  some regions (EU/UK's PSD2 Strong Customer Authentication) — not
  applicable to a Denver, CO business, so the benefit here is optional
  fraud protection, not a compliance requirement.
- **Would adopting client tokens now simplify a future 3DS rollout?**
  Somewhat — it would remove the "still on a tokenization key" step from a
  future migration, in exchange for a small amount of added complexity now
  (an extra server round-trip before Drop-in can render) for no immediate
  benefit. Not recommended for this pass; worth reconsidering if fraud
  losses or chargeback rates become a real concern.

## 14. Full test results after this audit

**651/651 passing** (20 files) — the original 639 from the initial build
report, plus 12 new/updated tests from this audit (true-concurrency races,
ambiguous-failure preservation, retry-eligibility, rate-schedule snapshot
and lookup precedence, GET response fields). `vercel build` succeeds;
function count confirmed at exactly 12/12 against the real build output.
