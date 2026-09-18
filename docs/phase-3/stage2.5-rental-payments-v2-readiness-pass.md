# Phase 3C Stage 2.5-v2 — Pre-Sandbox Readiness Pass

Status: **complete. Still not deployed — no push to `main`, no production
SQL, no Braintree credentials configured, no real or sandbox transaction
performed.** Performed 2026-09-18, immediately after
[stage2.5-rental-payments-v2-hardening-audit.md](./stage2.5-rental-payments-v2-hardening-audit.md),
at the owner's request for one final focused pass before configuring
Braintree Sandbox and running a first end-to-end checkout. Scope: the one
remaining architecture concern (post-Braintree-success/DB-write-failure),
plus the infrastructure planning needed to set up an isolated staging
environment (this document plans it — it does not create it; no Supabase
account access exists in this session).

## 1. Outer-repo / git state

Verified before any change: repo `C:\milehighjunkremovalsite\site`, branch
`phase-3c/stage2.5-rental-payments-v2`, HEAD `076b2a7c2219be0287bae10ddaf95789db3673db`
(matched exactly), working tree clean, remote
`https://github.com/Gliendo00/mile-high-junk-removal.git`. The outer repo
was not touched at all in this pass.

## 2. Post-Braintree-success / DB-write-failure — line-by-line analysis

Walking `handleDumpsterRentalBooking()` (`api/book.js`) at the exact moment
`gateway.transaction.sale()` returns `success: true`:

1. **What booking record already exists?** A full `bookings` row —
   customer id, service type, appointment date/window, description,
   service address — inserted several steps earlier (step 4), long before
   Braintree was ever called.
2. **What status is it in?** `status: "booked"` — written directly at
   INSERT time. There is no separate "pending" sub-state on `bookings`
   itself; by the time Braintree is called, the job already displays as a
   fully booked job in the Schedule/CRM.
3. **Is the slot already durably claimed?** Yes — that same `bookings`
   insert (step 4) is exactly what the partial unique index
   (`idx_bookings_dumpster_delivery_slot`) protects. The slot is claimed at
   the database level before Braintree is ever called.
4. **What `rental_payments` record already exists?** A row inserted at
   step 6 (before Braintree) with `payment_status: "processing"`, the
   idempotency key, `amount_charged`, and the full rate-schedule snapshot
   (`base_rate`/`included_days`/`included_tons`/`overage_ton_rate`/
   `overage_day_rate`) added in the hardening audit.
5. **What's durable BEFORE the Braintree call?** Everything above. The
   only fields that cannot exist yet are the four Braintree can only
   generate/return AFTER the charge: `braintree_transaction_id`,
   `braintree_customer_id`, `braintree_payment_method_token`,
   `payment_method_summary`.
6. **What DB writes happen AFTER Braintree succeeds?** Originally: exactly
   one — a single UPDATE attempt setting those four fields plus
   `payment_status: "paid"`.
7. **Which writes could fail?** Just that one UPDATE (a Supabase network
   blip, brief unavailability, etc.).
8. **If it fails, where was the transaction ID preserved?** **This was the
   real gap.** Before this pass, `txn.id` existed only in a local JS
   variable and in a `console.error` call — i.e., only in ephemeral Vercel
   function logs, nowhere in Supabase, and nowhere durable/queryable.
9. **What does the client receive?** `{ ok: true, booked: true }` either
   way — correct and unchanged by this pass: the booking is genuinely
   valid regardless of whether the confirmation write succeeded, so
   telling the customer anything but "booked" would be false.
10. **Can the client safely reload/retry?** Yes, already safe before this
    pass (the idempotency-key lookup would hit the generic "processing,
    please wait" 409 branch — no double charge) — but imprecise, since a
    genuinely-succeeded charge showed the same message as a merely-slow
    one. Improved in §3 below.
11. **What did the admin CRM show?** Before this pass: `payment_status:
    processing`, no transaction id, no payment method summary — visually
    indistinguishable from a request that crashed *before* ever reaching
    Braintree at all.
12. **Could the discrepancy be found without depending solely on ephemeral
    Vercel logs?** **No — this was the actual defect.** The only durable
    trace was a `processing` row with no transaction id, plus whatever
    Vercel's log retention happened to still have.

## 3. Was the existing behavior safe, and what was changed

**Not fully safe** — correct on the customer-facing response (§2.9-10),
genuinely incomplete on durable, admin-visible reconciliation (§2.8/12).
Braintree and Supabase are not made into one ACID transaction (not
possible, not attempted) — a practical, bounded saga was built instead:

1. **`orderId` set on every Braintree charge, before any Supabase write.**
   Confirmed via current Braintree documentation:
   `orderId` is a standard, Control-Panel-searchable transaction field (max
   255 characters, no special merchant-account configuration required —
   distinct from Level 2/3 processing fields, which do need setup). Set to
   this booking's own UUID for the initial charge
   (`gateway.transaction.sale({..., orderId: bookingId})`), and to
   `"<bookingId>-charge-<chargeId>"` for an admin-approved additional
   charge. This is the **last-resort correlation path**: it exists on
   Braintree's own system regardless of what happens to any later Supabase
   write, including a total outage. Only an internal UUID — no customer
   name, address, phone, or other PII ever reaches Braintree's metadata.
2. **The confirmation write is now retried** (`api/_lib/db-retry.js`, a
   small shared helper — used only for this one class of write: recording
   an already-successful charge, never for anything before the Braintree
   call). Short backoff (150ms, then 400ms for the initial charge; a
   single 400ms retry for the admin-approved-charge path) — a transient
   blip, the most likely real cause, now self-heals silently in the
   overwhelming majority of cases.
3. **A new state, distinguishable from every other state the audit named**
   (`paid_reconciliation_required`, added to both `rental_payments.
   payment_status` and `rental_additional_charges.status`): reached only
   if every retry of the full confirmation write fails. At that point a
   second, minimal write is attempted — just `payment_status`/`status`
   plus `braintree_transaction_id`, nothing else — on the theory that if
   the original failure was shaped by the payload rather than a total
   outage, the smaller write has a real chance of landing. This is
   genuinely different from `error_pending_review` (built in the
   hardening audit): `error_pending_review` means *outcome unknown* — an
   admin must check Braintree to find out what happened at all.
   `paid_reconciliation_required` means *we already know* — Braintree
   returned a definitive success, we have (or at least attempted to save)
   its transaction id, and the gap is purely in how completely that fact
   got persisted locally.
4. **If even the minimal write fails** (the true "Supabase is completely
   unavailable" case the owner explicitly asked to be acknowledged, not
   worked around): nothing further can be written — there is no way to
   durably record anything in a database that cannot be reached. What
   *does* survive that case: the Braintree transaction itself, tagged with
   `orderId`, discoverable in the Control Panel or via the Search API
   without depending on this app's database at all. The admin-facing
   response in this exact case still reports `paid_reconciliation_required`
   with the transaction id (known from the synchronous Braintree response,
   independent of any local write) and a warning explaining that even the
   fallback save failed — never a fabricated "paid" the database doesn't
   actually reflect.
5. **The customer-facing response is unconditional from here in every
   case**: `{ ok: true, booked: true }`. The browser is never nudged toward
   resubmitting a payment that may have already succeeded — confirmed by a
   new test: resubmitting the same idempotency key against a booking stuck
   at `paid_reconciliation_required` returns the same success response,
   **without calling Braintree again**.
6. **Admin UI** (`admin/booking-detail.js`, `admin.css`): both new states
   get their own label and (for charges) badge color —
   `paid_reconciliation_required` reads "Paid — Record Incomplete, Check
   Braintree" (a distinct green, not the "needs review" orange used for
   `error_pending_review`, since the money side is actually resolved —
   only the bookkeeping needs attention) and does not offer a retry button
   (retrying could double-charge; only an admin manually confirming via
   Braintree and, if truly necessary, a fresh proposal is appropriate).

**What this deliberately does not do**: pretend a write to a genuinely
unreachable database can be made to succeed, or invent a background
job/cron to "auto-heal" a stuck reconciliation state (no such
infrastructure exists in this project, and one was not built for this
narrow edge case — matches this project's consistent "don't overengineer"
guidance elsewhere).

## 4. Staging Supabase plan

### 4.1 Every Supabase environment variable this app reads

Confirmed by grepping every `process.env.SUPABASE_*` reference under `api/`:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (admin login/logout only — `api/admin/auth.js`)
- `SUPABASE_SECRET_KEY` (service-role key — every data read/write)

Only these three. Nothing else in this codebase references a
Supabase-specific variable.

### 4.2 Can they be scoped to Preview separately from Production?

Yes — this is a standard Vercel platform feature (Project Settings →
Environment Variables → each variable can have a different value per
Production/Preview/Development environment, or be restricted to only
certain ones). Recommended: set all three `SUPABASE_*` variables (and the
five `BRAINTREE_*` variables from the earlier build report) to different
values for "Preview" than for "Production" in the Vercel dashboard. This
is a dashboard configuration step for the owner — this session made no
change to any Vercel environment variable, Preview or Production.

### 4.3 What needs to be created/configured (owner action — not done here)

1. A new, separate Supabase project ("staging" or similar) — **this
   session did not and cannot create it** (no account access).
2. In that project: run the schema per §5 below.
3. In that project's **Auth** section: create one test admin user (email +
   password) whose email is in a `ADMIN_ALLOWED_EMAILS` value scoped to
   Preview — this is a genuinely separate credential from the production
   admin login, since it's a separate Supabase project's own Auth store.
4. Copy that project's URL + anon key + service-role key into Vercel's
   Preview-scoped `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SECRET_KEY`.
5. Braintree Sandbox credentials into Vercel's Preview-scoped
   `BRAINTREE_*` variables (§6).

### 4.4 Does staging need seed data?

- **Admin login**: yes — the one Auth user in §4.3. Nothing else.
- **Scheduling/bookings**: no — the test matrix (§7) creates everything it
  needs organically through the actual booking flow being tested.
- **Pricing**: no seed data needed at all — confirmed earlier in this
  project, pricing is **not** database-driven; it's the plain code
  constants in `api/_lib/rental-pricing.js`, which apply identically
  regardless of which Supabase project the deployment talks to.
- **Customer data**: none. Use synthetic test customers (fake names,
  `555`-prefixed phone numbers, `@example.com` emails) created through the
  test matrix itself — never copy real client rows into staging.

## 5. Migration/schema order for a from-scratch staging database

**Important finding, not previously stated**: this repo's `sql/` folder
does **not** contain a complete bootstrap script for this schema. Only two
migrations exist as committed `.sql` files
(`sql/2026-09-16_phase3b-step4a1-customer-identity-columns.sql` and this
feature's own `sql/2026-09-18_phase3c-stage2.5v2-rental-payments.sql`).
Several other real, already-applied production schema changes exist **only
as prose inside a docs/phase-3/*.md file** (e.g.
`docs/phase-3/stage2.2-tip-amount-migration.md`'s `tip_amount` column,
`docs/phase-3/stage2.4-expenses-migration.md`'s `expenses` table) — and at
least one, the Stage 2.5 `estimated_price_max`/`exact_time` columns plus
their three `CHECK` constraints (`bookings_time_mode_exclusive`,
`bookings_quote_max_requires_min`, `bookings_quote_max_greater_than_min`),
has **no DDL committed anywhere in this repository at all** — confirmed by
searching every doc and sql file for those constraint names. And the
foundational tables themselves (`customers`, `bookings`, `dumpster_rentals`,
`booking_photos`) were never captured as `CREATE TABLE` statements in this
repo in the first place — `docs/phase-1/database-schema.md` only
reverse-engineers their columns from application code and explicitly
marks every type/constraint/default "NEEDS VERIFICATION" against the real
database.

**Consequence**: replaying every file/doc in this repo in order would
produce a staging schema that is *close* to production but **not
guaranteed identical** — some real structure would be missing or
inferred rather than authoritative.

**Recommendation — do not hand-assemble the schema from these docs.**
Use Supabase's own schema-export mechanism against **production** (a
read-only operation) instead, then replay that output onto the new empty
staging project:

- Either the Supabase CLI: `supabase db dump --db-url <production
  connection string> --schema public -f production-schema.sql` (a
  read-only pg_dump-style export — this does not modify production), then
  run the resulting file against the staging project, **or**
- If the Supabase plan in use supports it, the dashboard's own
  project-duplication/branching feature, which clones schema (and
  optionally data — decline the data copy, schema only) directly.

Either path requires the owner's own Supabase account access and
production connection details — not something this session can do.

**If the dump/clone path is unavailable and the docs-based path must be
used instead**, the order — for the record, and clearly flagged as
lower-confidence than an actual schema export — would be:

1. The foundational tables (`customers`, `bookings`, `dumpster_rentals`,
   `booking_photos`) — reconstructed from `docs/phase-1/database-schema.md`
   plus direct inspection of `api/book.js`'s insert calls for exact column
   names; types/constraints are best-effort guesses, not verified.
2. `sql/2026-09-16_phase3b-step4a1-customer-identity-columns.sql` —
   `customers.phone_normalized`/`email_normalized` + two indexes.
3. `docs/phase-3/stage2.2-tip-amount-migration.md`'s `ALTER TABLE bookings
   ADD COLUMN tip_amount numeric(10,2) NULL;`.
4. `docs/phase-3/stage2.4-expenses-migration.md`'s `expenses` table (full
   `CREATE TABLE` is in that doc, including the owner-added
   `CHECK (amount > 0)`).
5. The Stage 2.5 `estimated_price_max`/`exact_time` columns + three CHECK
   constraints — **no committed DDL exists**; would need to be
   reconstructed from the commit message
   (`0a0b121`)'s description and cross-checked against
   `api/admin/booking.js`'s actual validation logic before writing new SQL
   for it. Flagged, not done here — out of scope for this pass and risky
   to improvise for a database anyone will trust test results from.
6. `sql/2026-09-18_phase3c-stage2.5v2-rental-payments.sql` (this feature) —
   the preflight query in §0 of that file is a no-op on an empty staging
   database (nothing can conflict yet) but is harmless to run anyway for
   consistency with the production runbook.

## 6. Braintree Sandbox setup checklist

Sandbox only — no production credentials in this checklist.

1. **Create/access a Sandbox account** at
   https://sandbox.braintreegateway.com (a Braintree developer account,
   separate from any production merchant account).
2. **Control Panel → Account → My User** (or Business): note the
   **Merchant ID**.
3. **Control Panel → Account → API Keys** → generate/view a **Private
   Key** and its paired **Public Key** (server-side only — `
   BRAINTREE_PRIVATE_KEY`/`BRAINTREE_PUBLIC_KEY`).
4. Same API Keys screen: note the **Tokenization Key** — this is what
   `BRAINTREE_TOKENIZATION_KEY` gets set to; it is designed to be public
   and is what the Drop-in UI on `/book/` actually uses client-side.
5. Set `BRAINTREE_ENVIRONMENT=Sandbox` (exact casing — `api/_lib/
   braintree-client.js` requires it exactly, fails closed on anything
   else).
6. **Venmo** (only if you want to test it): gear icon (top right) →
   **Processing** → **Payment Methods** section → **Venmo** → **Options**
   → **Accept** the terms of service. You'll also want a personal Venmo
   account you can sign into on a mobile device to test the real app-switch
   flow; Braintree's own sandbox test nonce `fake-venmo-account-nonce` can
   be used to exercise the server-side charge/vault logic without a real
   phone flow.
7. **Webhook**: Control Panel → **Webhooks** (under Settings) → add a new
   webhook, URL = `https://<your-preview-domain>/api/braintree-webhook`.
   Click **Check URL** — this is what exercises the `GET ?bt_challenge=`
   handler in `api/braintree-webhook.js`; it must return 200 with the
   correct verification string before Braintree will let you save the
   webhook. **Dispute events are the only kind this app actually relies
   on** (per the hardening audit — settlement webhooks are ACH/SEPA-only
   and dead code for this app's card/Venmo traffic) — if the webhook setup
   UI asks which kinds to subscribe to, disputes are the ones that matter;
   subscribing to more is harmless.
8. **Vaulted payment methods**: no separate toggle needed — vaulting
   happens automatically via `options.storeInVaultOnSuccess: true`,
   already in the code, as long as the merchant account has Vault enabled
   (on by default for a standard Sandbox account).
9. **Server-side follow-up charges** (the additional-charge approval
   flow): no separate setup — charging a previously-vaulted
   `paymentMethodToken` via `transaction.sale()` uses the same API
   keys/merchant account as the initial charge.
10. **Test cards**: use Braintree's standard test numbers (e.g.
    `4111 1111 1111 1111`, any future expiry, any 3-digit CVV, for a
    normal successful charge). For decline testing, Braintree's sandbox
    determines the response from the **transaction amount**, not the card
    number — check the current official Testing Reference page
    (`developer.paypal.com/braintree/docs/reference/general/testing/node`)
    for the exact amount that triggers `processor_declined` before
    relying on a specific number, rather than guessing one here.

## 7. First manual E2E test matrix (staging Supabase + Braintree Sandbox)

| # | Scenario | Verify |
|---|---|---|
| A | **Successful $349 booking** | Client reaches the payment panel; Drop-in loads; payment succeeds; success screen says "booked" (not "request received"); exactly one `bookings` row (`status: booked`); the same delivery slot is rejected for a second attempt; `rental_payments` row shows `payment_status: paid`, correct `amount_charged` (349.00) and the full rate-schedule snapshot; `agreement_version`/`agreement_accepted_at` set; `braintree_transaction_id` present and matches the Sandbox Control Panel; `braintree_payment_method_token` + `payment_method_summary` present (never a raw card number); Booking Detail's Payment section shows all of this correctly. |
| B | **Declined transaction** | Use a Sandbox amount/scenario known to decline (§6.10). Verify: no booking left behind (`bookings` row count unchanged), no `rental_payments` row retained, the delivery slot is bookable again immediately, the client sees Braintree's own decline reason (not a generic error). |
| C | **Double-click / duplicate request** | Submit once, then trigger a second submit with the same in-flight idempotency key (e.g. rapid double-click if the UI doesn't fully prevent it, or replay the same request). Verify exactly one Braintree transaction, exactly one booking. |
| D | **Two browsers racing the same window** | Open the same delivery date+window in two separate browser sessions with two different customers; submit both as close together as practical. Verify: one succeeds, one gets "that delivery window was just booked"; exactly one Braintree transaction total; the losing browser's customer is never charged (confirm in the Sandbox Control Panel — search by the losing customer's test email/name and confirm no transaction exists). |
| E | **Additional charge proposal** | From Booking Detail on the booking created in A, propose a $90 overweight-tonnage charge (1 ton over at the booking's own locked-in $90/ton rate). Verify: the charge appears with `status: proposed`; **confirm directly in the Braintree Sandbox Control Panel that no new transaction was created** by this step alone. |
| F | **Admin approval** | Click "Approve & Charge" on the E proposal. Verify: exactly one new Braintree transaction for $90; the vaulted payment method from A is what's charged (not a re-prompt for card details); the charge's CRM status becomes `paid` with the transaction id recorded; click Approve again on the same (now-paid) row and confirm it's refused (409) with zero additional Braintree transactions. |
| G | **Failed additional charge** | Propose another charge, then force a decline when approving it (e.g. temporarily point `paymentMethodToken` at an expired/invalid vaulted method if Sandbox allows constructing one, or use a Sandbox-specific decline trigger). Verify: the charge shows `status: failed` with a visible reason, never a false `paid`; click "Retry: Approve & Charge" and confirm the retry can succeed (or decline again) without ever double-charging — check the Braintree Control Panel for exactly one transaction per actual attempt, not per click. |
| H | **Agreement/pricing snapshot** | After booking A completes, change `OVERAGE_TON_RATE` in `api/_lib/rental-pricing.js` (a temporary, local-only edit for this test — revert afterward) to a different value and redeploy the Preview. Propose a new overweight charge on booking A. Verify the proposal uses booking A's **original** locked-in rate (from its own `rental_payments` row), not the newly-changed global rate — confirming a historical booking's terms never silently drift with a later pricing change. |

Every scenario above should be run against **staging Supabase + Braintree
Sandbox only** — never against production Supabase, per the owner's
explicit instruction not to perform destructive Sandbox testing against
the real CRM database.

## 8. Legal wording

Untouched, as instructed — the draft agreement text and the business-policy
checklist from the hardening audit (§12 of that document) are unchanged.
No policy was invented in this pass.

## 9. Tests / build / function count after this pass

**21 new/updated tests** in
`tests/phase3c-stage2.5v2-rental-payments.test.js` (retry-then-fallback
behavior for both the booking flow and the admin-approved-charge flow, the
true-total-failure case, `orderId` presence and exact value, resubmission
against a `paid_reconciliation_required` row never re-calling Braintree,
and four direct unit tests of `api/_lib/db-retry.js` itself). Three
pre-existing write-audit tests updated for the two new `.update(`
occurrences (the retry-wrapped confirmation write and its minimal
fallback).

**Full suite: 660/660 passing** (up from the 651 baseline this pass
started from). `vercel build` succeeds. Function count confirmed at
exactly **12/12** against the real build output — `api/_lib/db-retry.js`
correctly does not count (no `(req, res)` handler, same as every other
`_lib` helper).

## 10. What still blocks staging creation / Sandbox testing

- **Staging Supabase project**: cannot be created in this session (no
  Supabase account access). Once created, run §5's recommended schema-dump
  approach rather than hand-assembling from docs.
- **Braintree Sandbox credentials**: cannot be generated in this session
  (no Braintree account access) — follow §6.
- **Vercel Preview environment variables**: need to be set by the owner in
  the Vercel dashboard (this session made no change to any Vercel env var,
  Preview or Production) — the three `SUPABASE_*` and five `BRAINTREE_*`
  variables, scoped to Preview only.
- Nothing in the code itself blocks this — the implementation is ready for
  Sandbox testing once the above three items exist.
