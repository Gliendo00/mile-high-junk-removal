# Phase 3C Stage 2.5-v2 — Dumpster Rental Real Booking + Braintree Payments

Status: **proposal, implementation in progress on branch
`phase-3c/stage2.5-rental-payments-v2`.** Starting point: `main` @
`42f69b5e7b78c33f23d0eb985054ff49ffd6e674` (Stage 2.5 addendum — independent
financial fields), clean working tree, verified against the actual repo
before any code was written. A previous session's attempt at this same
feature (branch `phase-3c/stage2.5-rental-payments`, commit `b560f00`) does
not exist anywhere in this repository's history, reflogs, or remote branches
— confirmed by direct inspection, not assumed. This is a clean rebuild.

## 0. What this does NOT touch

Per `CLAUDE.md` and the owner's repeated "scope tightly" instruction:

- `junk_removal` and `light_demo` booking flows — completely untouched, both
  client and server. They stay lead/request forms exactly as today.
- Every service/city page, blog, SEO metadata, sitemap, redirects other than
  the two new ones this stage adds (see §5).
- The existing `bookings.status` six-value enum, `booking-status.js`'s
  narrow write scope (explicitly deferred by the owner in
  [stage2-decisions.md](./stage2-decisions.md) #2 — not touched here either),
  Quoted/Actual/Tip financial-field independence from Stage 2.5, exact-time/
  time-window scheduling, Client Typeahead, Month/Year calendar, expenses.
- Admin-created dumpster rentals (`+ New Job` / `+ Past Job` via
  `api/admin/booking.js`) are NOT subject to the new delivery-slot
  uniqueness rule below. That rule is scoped to the public, payment-integrated
  `/book` flow specifically — an admin manually creating a job already has
  full business context (e.g. a dumpster came back early) and the existing
  admin write path is trusted, unauthenticated-adjacent risk doesn't apply.

## 1. Business requirements recap (as given, plus the one clarified fact)

- 15-yard dumpster, $349 base / 5 days included / 2 tons included / $90 per
  extra ton / $15 per extra day, delivery+pickup included.
- Online checkout must be a **real booking**, not a lead: available + agreed
  + paid ⇒ booked. No "request received"/"pending approval" language for a
  normal successful checkout.
- **Availability: exactly one delivery per (date, time window).** The owner
  confirmed there is **no fixed dumpster fleet cap** — "we have as many as we
  need, I can get more dumpsters" — so the *only* hard constraint is delivery
  capacity: the crew can physically deliver one dumpster in one 2-hour
  window. This is materially simpler than an N-unit inventory-overlap model
  (which would have needed a `daterange` exclusion constraint or an
  advisory-lock RPC): a single partial **UNIQUE index** on
  `bookings (appointment_date, time_window)` for booked dumpster rentals
  gives atomic, race-proof enforcement for free, via ordinary insert
  semantics — no custom locking code needed.
- Braintree: card + Venmo (where enabled on the merchant account), vault the
  payment method for later admin-approved charges, never auto-charge an
  overage without explicit admin approval, agreement/consent with an audit
  trail, coherent state handling for every failure/retry/webhook-duplication
  scenario named in the brief.

## 2. Existing architecture this builds on (confirmed by direct inspection)

- **Static site + Vercel serverless functions + Supabase**, no build step, no
  test framework — every test is a plain `node tests/x.test.js` script using
  `assert`, intercepting `require("@supabase/supabase-js")` via `Module._load`
  with an in-memory fake DB. 601/601 passing at baseline. New Braintree tests
  follow the identical convention: intercept `require("braintree")` the same
  way.
- **Vercel Hobby plan, 12-Serverless-Function ceiling, currently exactly
  12/12** (`api/`: `book.js`, `contact.js`, `instagram-feed.js`, `reviews.js`,
  `upload-photo.js`; `api/admin/`: `booking-status.js`, `booking.js`,
  `bookings.js`, `client.js`, `clients.js`, `login.js`, `logout.js`).
  `api/_lib/*` helpers don't count — only files exporting an `(req,res)`
  handler do, enforced by a real test
  (`tests/phase3c-schedule.test.js`'s function-count check). **The owner has
  already locked the decision on this exact tradeoff**
  ([stage2-decisions.md](./stage2-decisions.md) #1): *stay on Hobby,
  consolidate, never upgrade just for headroom, never build one giant
  generic endpoint to dodge the ceiling.* §5 below is the consolidation plan
  that respects this.
- **`bookings.status`** is a plain six-value column (`new, contacted, quoted,
  booked, completed, lost`) — `booked` already means exactly what this
  feature needs ("confirmed, on the schedule"). No new status value is
  introduced; a successful payment sets `status = 'booked'` directly, the
  same value `+ New Job` already writes for an admin-created upcoming job.
- **`api/book.js`** is the one public write endpoint: rate-limited,
  honeypot + fill-time spam protection, strict JSON-only body, explicit
  per-field validation, then customer→booking→(dumpster_rentals) sequential
  inserts with `safeDelete()` rollback on any later failure. This exact
  rollback pattern is what the payment flow below extends by one more step.
- **`api/admin/booking.js`** is the admin job CRUD endpoint (GET/POST/PATCH),
  with a hard discipline this stage's additions must keep: `requireAdmin()`
  first, explicit field allowlists, the request body is *never* spread into
  a Supabase payload, and writes use optimistic concurrency
  (`updated_at`) where relevant.
- **Admin auth**: Supabase Auth session in httpOnly cookies,
  `ADMIN_ALLOWED_EMAILS` allowlist, `requireAdmin()` gates every
  `/api/admin/*` route (`api/_lib/admin-auth.js`).
- No pricing/settings table exists anywhere in the schema; every existing
  "single source of truth" in this codebase (time windows, historical floor,
  expense categories) is a plain code constants module under `api/_lib/`,
  never a DB-driven config table. This stage's pricing follows the same
  established pattern rather than introducing a new kind of infrastructure.
- No CSP/security headers are currently configured in `vercel.json`, so
  loading Braintree's own hosted `client.js`/`dropin.js` from their CDN on
  `/book/` is unblocked (and is, per Braintree's own integration
  requirements, not something that can be self-hosted/bundled).

## 3. Braintree architecture decision

Researched against current (2026) Braintree developer docs.

- **Client-side auth: a tokenization key, not a server-minted client
  token.** A tokenization key is a static, non-secret, publishable-style
  value Braintree explicitly designs to be embedded in client code (same
  trust model as a Stripe publishable key) — it authorizes Drop-in to
  tokenize a card/Venmo selection into a one-time `payment_method_nonce`.
  The one capability it lacks (retrieving a customer's already-vaulted
  payment methods client-side for a "saved card" UI) isn't needed here —
  every rental checkout is a fresh, one-time purchase, and vaulting for
  *later admin-initiated charges* happens **server-side**, at transaction
  time, via `options.storeInVaultOnSuccess` — a decision the client-side auth
  method has no bearing on. This eliminates an entire server endpoint
  (client-token minting) that would otherwise have been needed just to hand
  the browser a value before it can render the payment form.
  - Matching this project's own established precedent (`ADMIN_GOOGLE_MAPS_API_KEY`
    delivered via an endpoint rather than committed to source, even though a
    Maps browser key is *also* non-secret) rather than hardcoding it: the
    tokenization key is still delivered via a small `GET` addition to
    `api/book.js` (§5), not committed literally into `book/book.js`. This
    keeps sandbox vs. production swappable via env var with no code change
    and nothing Braintree-account-specific in git history.
- **Server SDK**: `braintree` npm package (official Node SDK, current major
  v3.x). `braintree.BraintreeGateway({ environment: Sandbox|Production,
  merchantId, publicKey, privateKey })`, all four from env vars.
- **Initial charge**: `gateway.transaction.sale({ amount, paymentMethodNonce,
  customerId?, options: { submitForSettlement: true, storeInVaultOnSuccess:
  true } })`. `submitForSettlement: true` because "payment succeeds ⇒ booked"
  means an immediate authorize *and* capture, not a bare auth that could
  later expire unsettled.
- **Vault / later charges**: a Braintree **Customer** record is created (or
  reused) per `customers.id`-linked booking, and the transaction result's
  `creditCard.token` / `paymentMethod.token` (the vaulted **payment method
  token** — never raw card data) is stored in the new `rental_payments`
  table. A later admin-approved additional charge uses
  `gateway.transaction.sale({ amount, paymentMethodToken,
  options: { submitForSettlement: true } })` against that stored token —
  Braintree's server never needs the card again, and neither does this
  database.
- **Idempotency**: Braintree's classic (REST-backed) Node SDK has no built-in
  `Idempotency-Key` request header (that exists only on the newer GraphQL
  API, not used here), and its own "duplicate transaction" detection is a
  narrow, time-boxed heuristic — not something to depend on for
  correctness. Idempotency is built at the application layer instead (§6):
  a client-generated UUID per checkout attempt, enforced `UNIQUE` in
  `rental_payments.idempotency_key`, checked *before* ever calling
  Braintree.
- **Webhooks**: `gateway.webhookNotification.parse(btSignature, btPayload,
  callback)` does full HMAC signature verification itself — an invalid
  signature throws, which this endpoint treats as a hard reject (400),
  never processed. Used for `transaction_settled` /
  `transaction_settlement_declined` (a submitted-for-settlement transaction
  can still fail to settle up to ~24–48h later) and dispute
  (`dispute_opened`/`dispute_lost`/`dispute_won`) events, so the CRM's
  payment status stays accurate after the synchronous checkout response.
- **Venmo**: enabled via `venmo: true` in the Drop-in `create()` config on
  the client. Renders automatically only on browsers Braintree supports it
  for, and only if the merchant account has Venmo enabled in the Braintree
  Control Panel (a manual dashboard step — see §11) — Drop-in degrades
  gracefully (no Venmo button) if it isn't configured, so no code branch is
  needed either way.
- **Explicitly out of scope for this stage** (flagged, not silently
  decided): 3D Secure. It would improve fraud-liability protection but
  requires a server-minted client token (reversing the tokenization-key
  simplification above) and a materially larger client-side flow. Not
  requested in the brief; called out in §12 as a recommended future
  enhancement, not a blocker.

## 4. Schema changes (new SQL file, run manually by the owner — this repo has
no migration runner; see `sql/2026-09-16_...customer-identity-columns.sql`
for the exact same pattern)

New file: `sql/2026-09-18_phase3c-stage2.5v2-rental-payments.sql`

1. **`CREATE UNIQUE INDEX idx_bookings_dumpster_delivery_slot ON bookings
   (appointment_date, time_window) WHERE service_type = 'dumpster_rental'
   AND status = 'booked';`** — the entire availability guarantee. A colliding
   `INSERT` fails atomically with Postgres error `23505`; `api/book.js`
   catches exactly that and returns "that delivery window was just booked."
   No advisory locks, no RPC, no application-level race window.
2. **New table `rental_payments`** (1:1 with `bookings`, `booking_id UNIQUE
   NOT NULL REFERENCES bookings(id) ON DELETE CASCADE` — mirrors
   `dumpster_rentals`'s existing exact pattern):
   `id, booking_id, idempotency_key UNIQUE NOT NULL, payment_status
   ('processing'|'paid'|'failed'|'voided'|'refunded', CHECK-constrained),
   amount_charged numeric(10,2), braintree_transaction_id,
   braintree_customer_id, braintree_payment_method_token,
   payment_method_summary (e.g. "Visa •••• 4242" — Braintree returns this;
   never a raw PAN), agreement_version, agreement_accepted_at timestamptz,
   created_at, updated_at`.
3. **New table `rental_additional_charges`** (many per booking):
   `id, booking_id REFERENCES bookings(id) ON DELETE CASCADE, charge_type
   ('overweight_tonnage'|'additional_days'|'other'), quantity numeric,
   rate numeric(10,2) (rate *snapshotted* at proposal time — never
   re-derived from a possibly-since-changed rate config, for audit
   integrity), amount numeric(10,2), description, status
   ('proposed'|'approved'|'processing'|'paid'|'failed'|'voided',
   CHECK-constrained), proposed_by, proposed_at, approved_by, approved_at,
   braintree_transaction_id, failure_reason, created_at, updated_at`.
4. Both new tables: RLS left disabled/default-deny like every other table in
   this project (service-role key only, same as `customers`/`bookings`) —
   consistent with the existing (unverified-by-this-repo, server-key-only)
   access pattern.

`estimated_price`/`estimated_price_max`/`final_price`/`tip_amount` on
`bookings` are **not** touched or overloaded — the online rental payment is
a wholly separate concern from the admin's manual quote/actual/tip
tracking, exactly as the Stage 2.5 addendum kept those three independent.
For a paid-online dumpster rental, admin's "Actual Job Amount Collected"
field can optionally be set to the same $349 by the admin for their own
reporting consistency, but this stage does not auto-populate it — flagged
as an open question in §12, not decided here.

## 5. Function-budget plan (net change: **zero** — stays at exactly 12/12)

Per the owner's locked "consolidate, don't upgrade, never one giant generic
endpoint" decision:

- **Merge `api/admin/login.js` + `api/admin/logout.js` → `api/admin/auth.js`**,
  dispatched on `?action=login|logout` (both bodies already tiny, both
  already POST-only, both already the same "session lifecycle" concern —
  this is a genuine cohesive merge, not a dodge). Two new `vercel.json`
  rewrites (`/api/admin/login` → `/api/admin/auth?action=login`,
  `/api/admin/logout` → `/api/admin/auth?action=logout`) mean **zero**
  frontend files change — all 9 admin pages that call these URLs today keep
  working verbatim. This is its own isolated, clearly-labeled commit,
  exactly like the Stage 1 `bookings.js`/`new-count.js` consolidation this
  mirrors. Frees one slot: 12 → 11.
- **New file: `api/braintree-webhook.js`** — the one genuinely new concern
  that doesn't fit anywhere else (different auth model entirely — Braintree
  HMAC signature, not admin-session or spam-protection — and must never be
  rate-limited the way `api/book.js` rate-limits human submitters, since
  that could reject Braintree's own retries). Spends the freed slot: 11 → 12.
- **Extend `api/book.js` in place** (0 new files) — `GET` (currently a bare
  405) now returns public rental config: Braintree tokenization key +
  environment, the current authoritative base-rate pricing (display only —
  see §6), and a lightweight already-taken-slots list for the given month
  (read-only, UX convenience — the real enforcement is the unique index at
  write time, not this). `POST`'s existing `dumpster_rental` branch gains
  the payment step (§6) — `junk_removal`/`light_demo` POST behavior is
  byte-for-byte unchanged.
- **Extend `api/admin/booking.js` in place** (0 new files) — `GET
  ?resource=charges&bookingId=` (list), `POST ?resource=charges` (propose),
  `PATCH ?resource=charges` (approve → process) for the additional-charge
  workflow (§7), dispatched the same way `bookings.js` already dispatches
  `?view=google-config`/`?countsOnly=1`. The existing booking GET/POST/PATCH
  behavior is unchanged; this is a new, clearly-separated branch, not a
  rewrite of the existing one.
- Admin-side **UI** additions (payment status on Booking Detail, the charge
  proposal/approval panel) are static `admin/*.html`/`admin/*.js` files —
  the Hobby function ceiling only counts `api/**/*.js`, so these are free.

## 6. Public booking + payment flow (`api/book.js`, `dumpster_rental` only)

1. Client loads `/book/`, fetches `GET /api/book` once (tokenization key +
   pricing + taken-slots) to initialize Braintree Drop-in and show a live
   price breakdown before the customer ever reaches the review step.
2. Client picks delivery date/window exactly as today (the same date/time
   picker already in `book/book.js`); the wizard gains one new step between
   Review and current-Submit: **Rental Agreement + Payment** — agreement
   text + a required checkbox, then the Braintree Drop-in UI (renders card
   fields + Venmo if enabled), which on `requestPaymentMethod()` yields a
   `payment_method_nonce`.
3. A client-generated `idempotencyKey` (UUID, `crypto.randomUUID()`,
   generated once when the payment step is first shown and reused across
   any retry within that same session/browser tab — never regenerated on a
   second click) travels with the submit payload alongside the existing
   customer/schedule/job-details fields, `paymentMethodNonce`, and
   `agreementVersion`.
4. Server, inside the existing `dumpster_rental` branch, after all existing
   field validation passes and *before* touching Supabase:
   - Re-derives the charge amount **entirely server-side** from
     `api/_lib/rental-pricing.js` (the base rate — a browser-submitted price
     is never trusted for anything, matching the brief's explicit security
     requirement).
   - Looks up `rental_payments` by `idempotency_key`. A `paid` match ⇒
     return the original success response again (never re-charge, this
     covers double-click/browser-retry/refresh-resubmit). A `processing`
     match ⇒ 409 "already processing" (covers a genuine concurrent duplicate
     request racing the first one). No match ⇒ continue.
   - Runs customer lookup/create exactly as today (Step 4a.3 reuse logic,
     untouched).
   - Inserts `bookings` with `status: 'booked'` directly (not left null/new)
     and `dumpster_rentals`, exactly as today's insert sequence — this
     `bookings` insert is what the new partial unique index (§4.1) actually
     protects. A `23505` here (someone else just took this exact
     date+window) is caught specifically and returned as a clean, friendly
     409 — **no Braintree call is ever made for a slot that turned out to be
     taken**, so a losing race never touches the customer's card at all.
   - Inserts `rental_payments` with `payment_status: 'processing'` — this
     row, plus the slot-holding `bookings` row, is the "reservation" for the
     duration of this one request.
   - Calls Braintree `transaction.sale(...)` (§3).
     - **Success**: updates `rental_payments` to `paid` with the
       transaction id, vault customer id, payment method token, and
       display-safe payment method summary. Responds `{ ok: true, booked:
       true, ... }` — the client's confirmation copy says "booked," never
       "request received" (per the brief).
     - **Failure** (declined, gateway error, timeout): rolls back exactly
       like the existing `dumpster_rentals`-insert-failed path already
       does — `safeDelete()`s `dumpster_rentals`, `bookings`,
       `rental_payments`, and the customer row (only if this request
       created it) — freeing the delivery slot immediately so it's not
       squatted by a declined card. Responds with the decline reason
       Braintree gives (safe to show — Braintree's processor-response text
       is written for exactly this), never a generic 500, so the customer
       knows to try a different card rather than assuming the site is
       broken.
   - A process crash between the `processing` insert and the Braintree call
     completing (rare — the whole sequence is one request, expected
     duration ~1–3s) leaves a `processing` row and a `booked` slot with no
     confirmed payment. This is a known, explicitly accepted edge for this
     stage (documented, not silently ignored): Booking Detail (§8)
     surfaces `payment_status: processing` prominently rather than
     defaulting to looking "paid" or "booked normally," so the owner
     notices and can call the customer / manually resolve. No automated
     cleanup cron is added — out of scope, and Vercel Hobby's cron support
     is limited enough (2 jobs, daily) that it wouldn't meaningfully close
     this narrow a window anyway.

## 7. Admin additional-charge approval flow (`api/admin/booking.js
?resource=charges`)

States: `proposed → approved → processing → paid` (or `failed`/`voided` off
the approved/processing branch). Mirrors the brief's required state
separation exactly — **a calculation is never authorization to charge.**

- `POST ?resource=charges` (propose): admin enters `chargeType`
  (`overweight_tonnage`|`additional_days`|`other`) + `quantity` (or a raw
  amount for `other`). Server computes `amount` from `quantity × ` the
  **current** rate in `api/_lib/rental-pricing.js`, snapshots that rate onto
  the row, sets `status: 'proposed'`. This alone moves no money and calls
  Braintree for nothing.
- `PATCH ?resource=charges` `{ id, action: 'approve' }`: `requireAdmin()`
  first. Loads the charge, requires current `status = 'proposed'`
  (conditioned directly in the `UPDATE ... WHERE status = 'proposed'` clause
  — the same optimistic-concurrency-style guard `booking.js`'s Edit Job PATCH
  already uses for `updated_at` — so a second concurrent "Approve" click
  matches zero rows and gets a clean "already processed" response instead of
  a double charge). On the row actually transitioning to `approved`, the
  *same request* immediately calls `transaction.sale({ amount,
  paymentMethodToken: <from rental_payments>, options: {
  submitForSettlement: true } })` and writes the resulting
  `processing`→`paid`/`failed` status + transaction id. Approval and
  processing are two states but one atomic admin action — matching "admin
  must explicitly approve" while keeping the actual Braintree call
  server-side-only and never separately callable without an approval having
  just happened in the same authorized request.
- `GET ?resource=charges&bookingId=`: list charges for a booking, for the
  Booking Detail panel.
- Every field read individually off the body, never spread — same
  discipline as the rest of `booking.js`.

## 8. Admin CRM visibility

`admin/booking-detail.js` (dumpster rentals only) gains: payment status
badge, amount charged, payment method summary, Braintree transaction id
(display only, no card data), agreement version/timestamp, and the charges
panel from §7 (propose form + list with status pills + an Approve button on
`proposed` rows). No new Vercel function — pure static JS/HTML addition
consuming the endpoints from §5–7.

## 9. Rental agreement

Versioned plain-text/HTML agreement (`RENTAL_AGREEMENT_VERSION` constant
alongside the pricing module) covering: base rate/included days/tons,
overage rates, that Mile High Junk Removal may submit an approved additional
charge to the payment method on file for legitimate overage per this
agreement, and that this checkbox is not a substitute for professional legal
advice. `rental_payments.agreement_version` +
`agreement_accepted_at` is the audit trail; §12 flags the actual wording for
Rocky/legal sign-off — this stage writes reasonable draft language, not
final legal copy.

## 10. Tests (new, following the exact existing offline/fake-module
convention — `node tests/<file>.test.js`, zero real network)

New `tests/phase3c-stage2.5v2-rental-payments.test.js` (+ a
`braintree` fake module interceptor alongside the existing Supabase one),
covering at minimum every scenario the brief lists: successful payment,
declined payment (no booking left behind), invalid payment input, duplicate
submission via reused idempotency key, same-slot concurrent booking attempt
(unique-index collision), server-side availability enforcement independent
of any client-side disabling, booking/payment state transitions, no
confirmation on failed payment, no duplicate transaction on retry, charge
proposal creates no transaction, admin approval flow, approved-charge
success/failure, pricing/extra-day/overweight calculation correctness,
agreement audit metadata, webhook signature accept/reject + duplicate
delivery, client-controlled-price rejection (a spoofed `amount` in the
request body is ignored — server always recomputes). Existing suites
(`phase3c-stage2.5-quoted-range-exact-time`, `phase1-api` for `api/book.js`
non-dumpster paths, `phase3a-admin-status-write`/`phase2-admin-api` for the
login/logout merge) re-run in full alongside the new file, not just the new
one.

## 11. Environment variables (new)

- `BRAINTREE_ENVIRONMENT` — `Sandbox` or `Production`.
- `BRAINTREE_MERCHANT_ID`, `BRAINTREE_PUBLIC_KEY`, `BRAINTREE_PRIVATE_KEY` —
  server-only, from the Braintree Control Panel.
- `BRAINTREE_TOKENIZATION_KEY` — the one value the `GET /api/book` response
  echoes to the browser; safe by Braintree's own design (§3), still kept out
  of committed source and swappable per-environment.
- `BRAINTREE_WEBHOOK_...` — no separate secret needed;
  `webhookNotification.parse` verifies against the configured
  public/private key pair already above.

Manual dashboard step (cannot be done from this repo): register the
production/sandbox webhook URL (`https://milehighjunkremoval.net/api/braintree-webhook`)
in the Braintree Control Panel, and enable Venmo on the merchant account if
desired — flagged in the final report, not something code can configure.

## 12. Open items flagged for the owner (not blocking implementation, per
the brief's own instruction to flag rather than invent for anything
consequential)

- Final legal wording of the rental agreement (§9) — draft language is
  written, not legally reviewed.
- Whether a successfully paid online rental should also auto-populate the
  admin's `final_price`/`Actual Job Amount Collected` field for reporting
  consistency, or stay fully independent per Stage 2.5's existing design
  philosophy (leaning toward: stay independent, for the same "never derive
  one financial field from another" reason Stage 2.5 established — but this
  is the owner's call, flagged not decided).
- 3D Secure (§3) — not built, recommended future enhancement.
- No automated cleanup for an orphaned `processing` row from a mid-request
  crash (§6) — surfaced in the admin UI instead of auto-resolved.
