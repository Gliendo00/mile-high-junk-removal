# Phase 3C Stage 3 — Job Payment Ledger + Expense Management + Stripe Trust Signal

Status: **implementation complete, NOT deployed.** No push to `main`, no
Production or Staging Supabase migration run by this session, no Production
deployment. Built on branch `phase3c/stage3-payments-expenses`. Full test
suite: **777 tests across 21 files, 0 failed** (baseline before this stage:
19 files, all passing, confirmed first).

**Pre-push migration/privilege audit (2026-09-19, after implementation) —
see §9** for the two things specifically checked before recommending a
rollout sequence: whether the Stage 3 migration works when `public.expenses`
doesn't exist yet (it does — verified against a real Postgres engine, not
just read), and whether `service_role`'s column-scoped UPDATE restriction on
`job_payments`/`expenses` is actually enforced rather than just stated (it
wasn't fully deterministic as originally written — fixed; see §9.2).

This stage covers four things requested together: a Stripe trust signal on
the public booking/payment flow, a cross-service-type payment ledger
(`job_payments`), a full Expense Management screen (extending the existing
Stage 2.4 Quick Expense feature), and database-enforced financial-audit
history for expenses. Nothing about the existing Stripe rental-payment
implementation (Stage 2.5-v2) was changed — this stage only adds an
additional, best-effort mirror call at points where that code already
confirms a successful Stripe collection.

## 1. Stripe trust signal

Text-only, per explicit instruction — no recreated Stripe logo/wordmark:

```
🔒 Secure payments powered by Stripe
```

Placed directly under the Stripe Payment Element inside the Payment card in
`book/index.html`, above the "Pay & Book Now" button. Styled in
`book/book.css`'s `.payment-trust-note` — 12px, `--color-neutral-600`,
centered — deliberately smaller/lower-contrast than `.field-note` so it
never competes with the CTA. No JS, no external asset load, no new
dependency. Verified in-browser at desktop and mobile (375px) widths.

## 2. `job_payments` — the cross-service-type payment ledger

### 2.1 Why a new table, not a `bookings.payment_method` column

A single column can't represent "$100 Stripe deposit + $400 cash balance,"
a partial payment, an additional charge, or a refund/correction — the
owner's explicit requirement. `job_payments` is a per-booking, many-rows
table instead (see `sql/2026-09-19_phase3c-stage3-job-payments-and-expenses.sql`
§1).

### 2.2 Relationship to `rental_payments`/`rental_additional_charges`

Those two tables (Stage 2.5-v2) remain the Stripe **operational** record —
capture state, disputes, idempotency, rate snapshots — completely
unchanged. `job_payments` is the **read-side financial ledger**, covering
every service type (junk removal, light demo, dumpster rental). Every
Stripe collection that succeeds in those two tables is also mirrored into
`job_payments` as a `payment_method: "card_stripe"` row, so the ledger is a
complete cross-service-type picture without duplicating Stripe's own
operational complexity into a second table.

**Mirroring is one-directional and best-effort** (`api/_lib/job-payments-ledger.js`'s
`mirrorStripePaymentToLedger()`): called from four places, all *after*
Stripe has already confirmed success — a mirroring failure is logged and
swallowed, never allowed to affect the real payment response:

1. `api/book.js` — the initial dumpster-rental capture (`handleDumpsterRentalBooking()`).
2. `api/admin/booking.js`'s `handleApprove()` — an approved additional
   charge (overweight tonnage, extra rental days, other) succeeds.
3. `api/admin/booking.js`'s `handleCheckStatus()` — a `requires_customer_action`
   charge is found `succeeded` on re-check.
4. `api/stripe-webhook.js`'s `reconcileSucceeded()` — the async backstop for
   both `rental_payments` and `rental_additional_charges`, covering the case
   where a synchronous mirror call above didn't complete for some reason.

**Idempotent by construction**: `job_payments.stripe_payment_intent_id` has
a partial `UNIQUE` index (NULL-safe — manual rows are unaffected), and the
mirror call is a `upsert(..., {onConflict: "stripe_payment_intent_id",
ignoreDuplicates: true})`. Any of the four call sites firing for the same
PaymentIntent — including more than one, e.g. the synchronous path and the
webhook backstop both eventually reacting to the same transaction — produces
exactly one row, never a duplicate.

### 2.3 Amount/refund sign convention

**Amount is always stored as a positive number.** `payment_type`
(`"payment"` or `"refund"`) determines whether it increases or decreases
collected revenue:

```
collected = SUM(amount WHERE payment_type='payment' AND voided_at IS NULL)
          − SUM(amount WHERE payment_type='refund'  AND voided_at IS NULL)
```

Implemented once, in `api/_lib/job-payments-ledger.js`'s
`netCollectedFromLedgerRows()` — every caller (booking detail, future
profitability reporting) uses this single function rather than each
re-deriving the sign convention. `amount > 0` is a database `CHECK`
constraint, not just app-level validation.

### 2.4 Append-only / financial-audit correction pattern

`job_payments` rows are **never edited in place**. The only write PATCH
allows (`handleVoidJobPayment()`) sets exactly `voided_at`/`voided_reason`/
`updated_at` — enforced twice: at the application layer (the handler simply
never accepts amount/method/type in its update payload) and at the database
permission layer (`service_role` has a **column-scoped** `GRANT UPDATE
(voided_at, voided_reason, updated_at)` — see the grants file — so even a
future application bug cannot alter a payment's financial facts after it's
written). `service_role` is never granted `DELETE` on this table at all.

A wrong entry ($500 cash that should have been $450 Zelle) is corrected by:
1. Voiding the original row (reason required) — it stays in the table
   permanently, `voided_at` set, excluded from the collected-revenue sum.
2. Recording a new, correct row — optionally with `reversesPaymentId`
   pointing at the voided row, for traceability (not required for the void
   mechanism itself, which works via `voided_at`/`voided_reason` alone).

A genuine refund (money actually returned to the customer) is its own new
row with `payment_type: "refund"` — the original payment row is untouched;
the refund is a separate, later ledger entry.

### 2.5 `bookings.final_price` compatibility

**Historical jobs have `bookings.final_price` set but no `job_payments`
rows.** `final_price` is never removed or repurposed by this stage. The
compatibility rule (`effectiveRevenue()` in `job-payments-ledger.js`,
surfaced as `collectedRevenue`/`collectedRevenueSource` on the booking
detail GET response):

- **Any non-voided `job_payments` rows exist** → the ledger total is
  authoritative (`source: "ledger"`) — matches the owner's instruction that
  actual collected payments should be the preferred revenue source.
- **No non-voided rows exist** (every job created before this stage, or a
  job with no ledger entries yet — including a job whose only ledger rows
  are all voided) → falls back to `bookings.final_price` unchanged
  (`source: "final_price"`). A fully-voided ledger is deliberately treated
  the same as "no ledger" here, so a corrected-away entry never makes
  historical revenue read as `$0`.
- **Neither exists** → `null` (`source: "none"`), never a false `$0`.

`tip_amount` is completely untouched by any of this — confirmed by
inspection before this stage was built that it has never been summed with
`final_price` anywhere in this codebase (every display surface shows them
as two independent fields), and the ledger never writes to or reads from
`tip_amount`. No double-counting, no dropping.

### 2.6 API surface

Folded into the existing 12/12-function budget (see §5) —
`api/admin/booking.js`'s `?resource=job-payments`:
- `GET` — list a booking's payments, newest first.
- `POST` — record one manual payment (`cash`/`zelle`/`venmo`/`check`).
  `paymentMethod: "card_stripe"` is explicitly rejected (400) — that value
  is reserved exclusively for the auto-mirror path.
- `PATCH` — void one payment (reason required).

`GET /api/admin/booking?id=...` (the plain booking-detail fetch) now also
returns `jobPayments` (every row, voided included — the UI shows the full
audit trail) and `collectedRevenue`/`collectedRevenueSource`.

## 3. Expense Management

### 3.1 Schema — additive only

`expenses` (existing, from Stage 2.4) gains nullable columns only:
`vendor`, `payment_method`, `booking_id`, `receipt_reference`, `voided_at`,
`voided_reason`, `created_by`, `updated_by`. No existing column
renamed/retyped/dropped. See the migration SQL's §2 for the exact
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements (safe regardless of
whether Production already has the base table).

### 3.2 Categories — stable keys, relabeled/expanded

The original seven DB keys (`fuel`, `dump_fees`, `meals`,
`repairs_maintenance`, `advertising`, `supplies`, `miscellaneous`) are
**never renamed** — only their display label changed
(`api/_lib/expense-categories.js`). Four new keys were added:
`labor`, `subcontractor`, `vehicle`, `disposal_recycling`. Eleven
categories total. Any staging row using an old key still resolves to a
valid label under its unchanged key.

### 3.3 Financial-audit history — a database trigger, not application code

`expense_audit_log` (new table) is written **automatically by a Postgres
trigger** (`expenses_write_audit_log()`, `AFTER INSERT`/`AFTER UPDATE` on
`public.expenses` — see the migration SQL's §3 for the full function).

**Why a trigger instead of an application-level audit write:** this is
financial data, and the owner explicitly asked for database-enforced
history where it can be done cleanly. A trigger guarantees every change is
captured no matter what touches the row — including a hypothetical future
direct SQL fix run by hand in the Supabase editor, which an
"insert an audit row after every API update" approach would silently miss.
It also removes an entire class of bug: the application forgetting to log a
field, or logging create/update/void inconsistently across three different
handler code paths. The one trade-off — a small amount of PL/pgSQL instead
of a pure-JS implementation — is worth it here specifically because
correctness of financial history matters more than avoiding a second
language in one file.

**"Who made the change"** is populated by the trigger reading
`NEW.created_by`/`NEW.updated_by` directly — plain columns the API sets as
part of the *same* insert/update statement — rather than a transaction-local
session variable (`set_config(...)`). This project's Supabase access goes
through PostgREST via `supabase-js`, which gives application code no way to
guarantee a `SET` and the following `UPDATE` land in the same transaction;
reading off `NEW` has no such requirement, since the trigger fires within
the very statement that set the column.

**No hard-delete path, ever** — enforced twice: `api/admin/bookings.js`
never issues a `DELETE` against `expenses` (only `handlePatchExpense()`'s
`action: "void"` sets `voided_at`/`voided_reason`), and `service_role` is
never granted `DELETE` on either `expenses` or `expense_audit_log` (see the
grants file). `expense_audit_log.expense_id` is a plain (non-cascading)
foreign key — deliberately **not** `ON DELETE CASCADE` — so even a future
hard-delete attempt on `expenses` would be blocked by Postgres while audit
rows still reference it, rather than silently taking the audit history with
it.

### 3.4 API surface (folded into `api/admin/bookings.js`)

- `GET ?view=expenses` — extended with `category`, `paymentMethod`,
  `bookingId`, `search` (vendor+note, ilike), `sort`/`sortDir`, `includeVoided`,
  `limit`/`offset`; returns `total`/`totalAmount` for the period.
- `POST` (`resource: "expense"`) — extended with `vendor`, `paymentMethod`,
  `receiptReference`, `bookingId`.
- `PATCH` (`resource: "expense"`) — new. `action: "update"` (default) edits
  editable fields on an active expense (a voided expense can never be
  edited — 409); `action: "void"` soft-deletes (reason required; an
  already-voided expense can't be voided again — 409).
- `GET ?view=expense-audit&expenseId=...` — new, read-only, the trigger-written history.
- `GET ?view=job-search&q=...` — new, the "link to a job" picker (customer
  name/phone search, same bounded multi-field `ilike` pattern
  `api/admin/clients.js` already established).

### 3.5 UI

New `/admin/expenses/` page (`admin/expenses.js`), reachable from a new
"Expenses" nav tab added to all 8 admin pages that have a nav bar. Add,
edit, void (with required reason), search, filter (date range/category/
payment method/job/include-voided), sort, and a per-expense History view —
all via the existing bottom-sheet pattern (`admin/quick-expense.js`,
`admin/status-ui.js`, `admin/client-picker.js` already established this
project's one modal convention). Quick Expense stays the fast one-tap entry
surface on Schedule, unchanged; the new page is where entries get managed.

The booking detail page (`admin/booking-detail.js`, `admin/booking/index.html`)
gained a "Payments" section: Collected (per §2.5's rule), the full
`job_payments` list (Stripe rows shown read-only/auto-labeled, manual rows
voidable), and a "Record a payment" form (cash/Zelle/Venmo/check only —
`card_stripe` is not offered as a manual choice, matching the API's own
rejection of it).

## 4. Vercel 12-function budget — unchanged, still exactly 12/12

Zero new files under `api/`. Every new endpoint (`job-payments`,
`expense-audit`, `job-search`, expense PATCH) is a new `resource`/`view`
branch on `api/admin/booking.js` or `api/admin/bookings.js`, the same
folding convention every prior stage since Stage 1 has used (see
`docs/phase-3/vercel-function-limit.md`). Confirmed by a plain file count
(`find api -name "*.js" -not -path "api/_lib/*"` → 12) and by the existing
deployment-guard tests, which still pass.

## 5. Migration/rollout plan

1. `sql/2026-09-19_phase3c-stage3-job-payments-and-expenses.sql` — run first.
   Includes a read-only preflight query to confirm current `expenses` shape
   in whichever environment it's run against.
2. `sql/2026-09-19_phase3c-stage3-service-role-grants.sql` — run second.
3. Both files include their own verification queries and a reference-only
   rollback block. Neither has been executed by this session against any
   environment — the owner runs these manually, per this project's standing
   convention (every prior migration in this repo follows the same rule).
4. No backfill: every historical job with no `job_payments` rows simply
   keeps using `bookings.final_price` per §2.5 — a future, separate
   "legacy payment import" effort (explicitly deferred by the owner) can
   backfill `job_payments` rows once payment methods for old jobs are known,
   with no schema change required to support that later.

## 6. Tests

774 tests across 21 files, 0 failed (up from the 19-file, all-passing
baseline confirmed before this stage began). New files:
`tests/phase3c-stage3-job-payments.test.js` (36 tests — ledger semantics,
idempotent mirroring, the three real Stripe call sites' wiring, the booking-
detail `collectedRevenue` compatibility rule, tip-amount independence) and
`tests/phase3c-stage3-expenses-management.test.js` (35 tests — edit/void,
voided-row immutability, filters/search/sort, audit-log read, job-search).
Existing files updated where this stage's changes affected their
assertions: the two write-audit call-count guards
(`tests/phase3a-admin-status-write.test.js`, `tests/phase3c-schedule.test.js`),
`tests/phase3c-job-editing.test.js`'s `booking.js` update-count assertion
(12 → 13), `tests/phase3c-stage2.4-expenses.test.js`'s category-list
assertions, and `tests/phase3c-stage2.5v2-stripe-rental-payments.test.js`
(added `job_payments` assertions to its existing successful-booking test,
plus minimal `upsert()` support in its fake Supabase so the real mirror
call is exercised rather than silently caught by its own try/catch).

**Not testable offline**: the `expense_audit_log` trigger itself is real
PL/pgSQL and can only be verified against a real Postgres instance
(staging) — the migration SQL's own verification section includes the
exact statements to exercise it in a throwaway, rolled-back transaction.

## 7. Files changed

**Added:**
- `sql/2026-09-19_phase3c-stage3-job-payments-and-expenses.sql`
- `sql/2026-09-19_phase3c-stage3-service-role-grants.sql`
- `api/_lib/job-payments-ledger.js`
- `admin/expenses/index.html`
- `admin/expenses.js`
- `tests/phase3c-stage3-job-payments.test.js`
- `tests/phase3c-stage3-expenses-management.test.js`
- `docs/phase-3/stage3-payments-expenses-proposal.md` (this file)

**Modified:**
- `book/index.html`, `book/book.css` — Stripe trust note.
- `api/book.js` — ledger mirror call in `handleDumpsterRentalBooking()`.
- `api/admin/booking.js` — `?resource=job-payments` (GET/POST/PATCH),
  `jobPayments`/`collectedRevenue` on the plain GET, ledger mirror calls in
  `handleApprove()`/`handleCheckStatus()`.
- `api/admin/bookings.js` — expense list filters/search/sort/pagination,
  expense PATCH (update/void), `?view=expense-audit`, `?view=job-search`,
  `vendor`/`paymentMethod`/`bookingId`/`receiptReference` on expense create.
- `api/stripe-webhook.js` — ledger mirror calls in `reconcileSucceeded()`.
- `api/_lib/expense-categories.js` — category expansion/relabeling.
- `admin/quick-expense.js` — mirrored category label/list update.
- `admin/booking-detail.js`, `admin/booking/index.html` — Payments section.
- `admin/admin.css` — `.admin-btn-danger`, Expenses page styles, Payments
  section void-button alignment fix.
- `admin/index.html`, `admin/requests/index.html`, `admin/booking/index.html`,
  `admin/booking-edit/index.html`, `admin/booking-new/index.html`,
  `admin/booking-past/index.html`, `admin/clients/index.html`,
  `admin/client/index.html` — Expenses nav tab.
- `tests/phase3a-admin-status-write.test.js`, `tests/phase3c-schedule.test.js`,
  `tests/phase3c-job-editing.test.js`, `tests/phase3c-stage2.4-expenses.test.js`,
  `tests/phase3c-stage2.5v2-stripe-rental-payments.test.js` — see §6.

## 8. Manual steps required before this can go live

1. Run both SQL files (§5) against Production (and/or staging, if staging
   is used for a pre-Production check) via the Supabase SQL editor, **in
   the single sequence given in §5 — no other migration needs to run
   first** (see §9.1: confirmed the Stage 3 file already bootstraps the
   complete `expenses` schema from nothing).
2. Confirm via the verification queries in each file that the expected
   columns/tables/trigger/grants exist — **specifically run the
   `has_column_privilege()`/`has_table_privilege()` queries in the grants
   file**, not just the raw grant-listing ones (see §9.2 for why those are
   the authoritative check).
3. Deploy this branch (`vercel build` locally first to reconfirm the
   12-function count, as every prior stage has done) — **only after
   explicit owner approval**, per this project's standing production-safety
   rules.

## 9. Pre-push migration/privilege audit (2026-09-19)

Before recommending the rollout sequence in §5/§8, two specific concerns
were raised and checked — not by re-reading the SQL and asserting it's
fine, but by actually running both files against a real PostgreSQL engine
(`@electric-sql/pglite`, a WASM build of real Postgres, installed
standalone in the session's scratchpad directory — never added to this
project's own `package.json`/`package-lock.json`, and no Production or
Staging credentials were used or exist in this session).

### 9.1 Does Stage 3 work when `public.expenses` doesn't exist yet?

**Yes — confirmed by executing the migration against a schema with no
`expenses` table at all** (a stand-in for Production's actual, unconfirmed
state — recall the Stage 2.4 addendum's own migration was verified run on
Staging but explicitly NOT on Production). Three things were checked in
that run:

1. `sql/2026-09-19_phase3c-stage3-job-payments-and-expenses.sql`'s §2
   already opens with `CREATE TABLE IF NOT EXISTS public.expenses (...)`
   carrying the complete ORIGINAL Stage 2.4 shape (`id`, `expense_date`,
   `category`, `amount`, `note`, `created_at`, `updated_at`), followed by
   the Stage 3 `ADD COLUMN IF NOT EXISTS` additions — this was already the
   design (§1 Option A from the original request), and the engine run
   confirms it actually behaves that way: **all 15 expected columns exist
   after a single run against an empty schema**, both new tables
   (`job_payments`, `expense_audit_log`) are created, both triggers
   (`expenses_audit_insert`, `expenses_audit_update`) exist, and a live
   insert-then-update through the trigger produces exactly the expected
   two `expense_audit_log` rows (`create`, then `update` with
   `field_name='amount', old_value='68.00', new_value='76.00'`).
2. **Re-running the same file a second time is fully idempotent** — no
   error, no duplicate objects (every `CREATE TABLE`/`ADD COLUMN`/`CREATE
   INDEX` is `IF NOT EXISTS`, and the two `CREATE TRIGGER`s are preceded by
   `DROP TRIGGER IF EXISTS`).
3. **Separately**, the same file was also run against a schema where
   `expenses` already exists at the OLD Stage 2.4 shape with one pre-existing
   row (a stand-in for Staging's actual current state) — the migration adds
   the eight new columns, the pre-existing row survives untouched with the
   new columns `NULL`, and no data is lost or altered.

**Conclusion: one migration file, one deterministic sequence
(`2026-09-19_phase3c-stage3-job-payments-and-expenses.sql` then
`2026-09-19_phase3c-stage3-service-role-grants.sql`), correct whether run
against Production (no `expenses` table) or Staging (old-shape `expenses`
with data) — §5/§8's sequence is unchanged; no separate base-expenses
migration needs to be added to the required order.** This is Option A from
the original instruction, now verified rather than only asserted.

### 9.2 Are `service_role`'s effective privileges actually what the grants file claims?

**Found a real gap, and fixed it.** The original grants file only ever
issued `GRANT` statements — it never `REVOKE`d anything first. PostgreSQL
privileges are strictly **additive**: a later, narrower `GRANT UPDATE
(voided_at, voided_reason, updated_at)` does **not** revoke a broader,
pre-existing table-level `GRANT UPDATE` from any other source. This was
confirmed directly against the real engine, not just reasoned about: a
table given a broad `GRANT UPDATE` first, then a narrow single-column
`GRANT UPDATE (a)` on top, still lets the grantee update a completely
different, never-listed column `b` — `has_column_privilege()` returns
`true` for it. Only `REVOKE` can narrow an already-broader grant.

**This session cannot query Production or Staging's actual current grants**
(no credentials, and project rules prohibit running SQL against them from
here). What can be said with confidence, from this project's own
documented history rather than generic assumption: Stage 2.5's own staging
rollout directly observed `service_role` **missing** basic `SELECT`/`INSERT`
on brand-new tables created via the SQL editor
(`docs/phase-3/stage2.5-stripe-rental-payments-migration.md` §5.3) — which
could not happen if this project had a working schema-wide or
default-privilege catch-all grant for `service_role`. That's real,
project-specific evidence against a pre-existing blanket grant existing at
all, for any table created the way every table in this project's `sql/`
directory is created (by hand, in the SQL editor).

Rather than rely on that inference holding specifically for the three new
Stage 3 objects, **the grants file was corrected** to `REVOKE ALL ...
FROM service_role` on each of `job_payments`/`expenses`/`expense_audit_log`
immediately before granting exactly the intended privileges — so the end
state is deterministic regardless of whatever (if anything) already
existed, not dependent on the inference above. Confirmed against the real
engine, starting from a deliberately-seeded pre-existing broad grant:
`REVOKE ALL` followed by the narrow re-grant correctly leaves the
never-listed column un-updatable and `DELETE` disallowed. Also confirmed
`REVOKE ALL ... FROM service_role` is a safe no-op (no error) when
`service_role` had zero prior privileges on the table at all — the actual
`job_payments` case, since it's a brand-new table.

The grants file's verification section was also strengthened: it now leads
with `has_column_privilege()`/`has_table_privilege()` queries (the same
authoritative check PostgreSQL itself uses to allow/deny a query) rather
than only the raw grant-listing queries, which show which statements exist
but require the reader to manually reason about composition — **run those
after applying the grants file against Production, and expect exactly the
boolean each line documents.** That is the actual, final confirmation this
session cannot perform itself.

### 9.3 What this changed

Only `sql/2026-09-19_phase3c-stage3-service-role-grants.sql` was modified
(`REVOKE ALL` added before each `GRANT` block; verification section
strengthened) — no application code, no other SQL file, no test changed.
Full JS suite re-run after the fix: still 776/776 passing (SQL files aren't
exercised by the offline JS test harness — this confirms the fix didn't
touch anything the tests do cover). The `expenses`-bootstrap question (§9.1)
required no change — it was already correct as designed.

## 10. Second pre-push audit pass (2026-09-19) — the remaining rollout-record items

Continuing §9's approach: every claim below was checked by actually
executing SQL against a real PostgreSQL engine (`@electric-sql/pglite`,
same standalone scratchpad install as §9 — never added to this project) and
running `SET ROLE service_role` (with `BYPASSRLS`, matching Supabase's own
documented behavior for that role — see §10.3's note) to exercise the exact
query shapes the application issues, not just reading the SQL and asserting
it's correct.

### 10.1 `expense_audit_log` FK behavior + hard-delete protection

**Exact constraint, read directly from `pg_constraint`:**
```
conname:    expense_audit_log_expense_id_fkey
definition: FOREIGN KEY (expense_id) REFERENCES expenses(id)
```
No `ON DELETE` clause at all — Postgres's default is `NO ACTION`, confirmed
by the empty clause above (an `ON DELETE CASCADE` would show explicitly).

**Live test**: inserted an expense, updated it once (2 audit rows: `create`
+ `update`), then attempted `DELETE FROM expenses WHERE id = '<that id>'`
directly:
```
BLOCKED — update or delete on table "expenses" violates foreign key
constraint "expense_audit_log_expense_id_fkey" on table "expense_audit_log"
```
The expense row and both audit rows were confirmed still present
immediately after. This was tested as the database superuser (i.e. with
every privilege) specifically to isolate that the FK **itself**, not a
permissions error, is what blocks the delete.

**Four independent layers, all confirmed, that would each have to fail for
an expense with history to ever be hard-deleted:**
1. The FK constraint itself has no cascade — Postgres refuses the `DELETE`
   outright while audit rows reference it (proven above).
2. `service_role has DELETE on public.expenses`: **`false`**
   (`has_table_privilege()`, confirmed both before and after the §9.2 grants
   fix).
3. No code path in `api/admin/bookings.js` issues `.from("expenses")...delete(`
   — confirmed by grep: zero matches for `.delete(` anywhere in that file,
   and the method dispatch only ever routes `GET`/`POST`/`PATCH` (no `DELETE`
   branch exists at all).
4. The only removal path is `handlePatchExpense()`'s `action: "void"`,
   which sets `voided_at`/`voided_reason` — confirmed the sole write path by
   the same grep, and exercised directly against the engine (§10.3): voiding
   changes exactly those two columns, the row remains, and it's excluded
   from `collectedRevenue`-style totals via `voided_at IS NULL` filtering
   everywhere it's queried.

### 10.2 Stripe → `job_payments` coverage map

| Scenario | Source table / event | Code (file : function) | Idempotency key | `job_payments.payment_type` | Duplicate prevented? |
|---|---|---|---|---|---|
| Initial rental payment capture | `rental_payments` (synchronous capture success) | `api/book.js:1168`, `handleDumpsterRentalBooking()` | `captured.id` (the PaymentIntent id) | `payment` | Yes — `job_payments_stripe_pi_idx` (plain UNIQUE, fixed §11) + `upsert(...,{ignoreDuplicates:true})` |
| Webhook reconciliation — initial payment | `rental_payments` (`payment_intent.succeeded`) | `api/stripe-webhook.js:212`, `reconcileSucceeded()` | `intent.id` | `payment` | Yes — same unique index; safe even if it fires alongside the synchronous path above for the same PaymentIntent |
| Overweight tonnage charge (approved) | `rental_additional_charges` (`charge_type='overweight_tonnage'`) | `api/admin/booking.js:1655`, `handleApprove()` | `intent.id` (new off-session PaymentIntent, one per charge) | `payment` | Yes — same unique index |
| Extra rental days charge (approved) | `rental_additional_charges` (`charge_type='additional_days'`) | `api/admin/booking.js:1655`, `handleApprove()` (same function — `charge_type` is data on the row, not a separate code path) | `intent.id` | `payment` | Yes — same unique index |
| Other approved additional charge | `rental_additional_charges` (`charge_type='other'`) | `api/admin/booking.js:1655`, `handleApprove()` (same function) | `intent.id` | `payment` | Yes — same unique index |
| Check-status / manual recovery (`requires_customer_action` → `succeeded`) | `rental_additional_charges` (read-only re-fetch of a stored PaymentIntent) | `api/admin/booking.js:1787`, `handleCheckStatus()` | `row.stripe_payment_intent_id` | `payment` | Yes — same unique index; safe even though `handleApprove()` may have already attempted (and failed to confirm) the same PaymentIntent |
| Webhook reconciliation — additional charge | `rental_additional_charges` (`payment_intent.succeeded`) | `api/stripe-webhook.js:230`, `reconcileSucceeded()` | `intent.id` | `payment` | Yes — same unique index |
| Refunds / reversals | — | — | — | — | **Not implemented.** No `stripe.refunds.*` call, no `charge.refunded`/dispute-refund webhook handling anywhere in this codebase. `rental_payments.payment_status` reserves the string `'refunded'` as a value the CHECK constraint allows, but no code path ever sets it (confirmed by the Stage 2.5-v2 doc's own note: "reserved for future use"). The **only** way a `job_payments` row with `payment_type: 'refund'` can exist today is an admin manually recording one via `POST ?resource=job-payments {paymentType:"refund"}` — a deliberate bookkeeping entry, not an automated Stripe refund. |

All six real Stripe-success call sites funnel through the single
`mirrorStripePaymentToLedger()` function (`api/_lib/job-payments-ledger.js`),
so "idempotency key" and "duplicate prevention" are identical across every
row above by construction — verified as one shared mechanism, not six
separate ones to audit individually.

### 10.3 Re-checked grants file for regressions — and a real bug found in the process

Built one continuous engine session: applied both Stage 3 SQL files, then
ran `SET ROLE service_role` (created with the `BYPASSRLS` attribute —
required to accurately model Supabase's actual `service_role`, which
carries that attribute; documented in this project's own
`docs/phase-1/admin-security-requirements.md`/Stage 2.5 doc as the reason
`service_role` queries bypass RLS regardless of policy count) and attempted
every distinct query shape the application code issues against
`job_payments`/`expenses`/`expense_audit_log`.

**Required-and-working (20/20):**

| Operation | Result |
|---|---|
| `job_payments` INSERT (manual payment) | ALLOWED |
| `job_payments` SELECT (list) | ALLOWED |
| `job_payments` UPDATE `voided_at`/`voided_reason`/`updated_at` (void) | ALLOWED |
| `job_payments` UPSERT on `stripe_payment_intent_id` conflict (ledger mirror) | ALLOWED *(see bug below — this failed before the fix)* |
| `expenses` INSERT | ALLOWED |
| `expenses` SELECT | ALLOWED |
| `expenses` UPDATE editable fields + `updated_by` | ALLOWED |
| `expenses` UPDATE `voided_at`/`voided_reason` (void) | ALLOWED |
| `expense_audit_log` INSERT (fired by the trigger, running as `service_role`) | ALLOWED — and produced the correct 5-row audit trail for a create → 2 edits → void → 1 more edit sequence in one live run |
| `expense_audit_log` SELECT (history view) | ALLOWED |
| `rental_payments` webhook UPDATE (`.not("payment_status","eq","paid")` shape) | ALLOWED |

**Correctly-blocked (financial-immutability/no-hard-delete guarantees, all confirmed DENIED):** `job_payments` UPDATE `amount`, UPDATE `payment_method`, DELETE; `expenses` UPDATE `id`, UPDATE `created_at`, UPDATE `created_by`, DELETE; `expense_audit_log` UPDATE, DELETE.

**A real bug was found and fixed during this check** — not a grants
problem, a schema problem: `job_payments_stripe_pi_idx` was originally
defined as a **partial** unique index
(`... WHERE stripe_payment_intent_id IS NOT NULL`). PostgreSQL requires an
`ON CONFLICT (col)` target to exactly match a unique index **including its
partial predicate** — `mirrorStripePaymentToLedger()`'s plain
`.upsert(payload, {onConflict: "stripe_payment_intent_id", ...})` does not
supply one, so against the partial index every single call (not just
duplicates) failed with `there is no unique or exclusion constraint
matching the ON CONFLICT specification`. Confirmed directly: the partial
version fails 100% of the time; a plain (non-partial) index — which
already permits unlimited `NULL` rows on its own, since Postgres never
treats `NULL = NULL` as true for uniqueness — fixed it, and a genuine raw
duplicate insert (bypassing `ON CONFLICT` entirely) is still correctly
rejected by the constraint. **This bug would have silently made the entire
`job_payments` ledger non-functional in Production** — every Stripe
mirror call is wrapped in try/catch and logs-and-continues, so no customer-
or admin-facing failure would have occurred, but zero rows would ever have
landed in the ledger. It was never caught by this project's offline JS
test suite because the fake Supabase clients simulate `.upsert()` in
memory without replicating real PostgreSQL's `ON CONFLICT`-matching rules —
exactly the kind of gap only a real-engine check surfaces.

**Fixed**: `sql/2026-09-19_phase3c-stage3-job-payments-and-expenses.sql`'s
`job_payments_stripe_pi_idx` is now a plain unique index (no `WHERE`
clause); `api/_lib/job-payments-ledger.js`'s comment updated to match. A
new static regression test
(`tests/phase3c-stage3-job-payments.test.js`, "sql migration:
job_payments_stripe_pi_idx is a PLAIN unique index, never partial") greps
the migration file directly so this exact bug can never silently reappear,
since no offline test exercises real `ON CONFLICT` semantics. Full test
suite re-run after the fix: **777 tests across 21 files, 0 failed.**

### 10.4 Final Production migration order + full verification checklist (actual outcomes)

**Exact sequence — two files, in this order, nothing else:**
1. `sql/2026-09-19_phase3c-stage3-job-payments-and-expenses.sql`
2. `sql/2026-09-19_phase3c-stage3-service-role-grants.sql`

**The original Stage 2.4 addendum's own `CREATE TABLE public.expenses`
statement (`docs/phase-3/stage2.4-expenses-migration.md`) is superseded and
must NOT be run separately.** File 1 above already contains the identical
base shape via `CREATE TABLE IF NOT EXISTS`, confirmed in §9.1 to correctly
bootstrap a fresh database with no `expenses` table at all. Running the old
statement first would be harmless (its own `CREATE TABLE` has no
`IF NOT EXISTS` guard per the original file, but it's an identical shape so
either order works) — but there's no reason to: File 1 supersedes it
entirely and is the only statement that needs to run.

**Post-run verification — real outcomes from the actual engine run** (run
against Production, these are the exact expected values):

*Tables:* `expense_audit_log`, `expenses`, `job_payments` — all three exist.

*Columns:* `expenses` — 15 columns (7 original + 8 new). `job_payments` —
14 columns. `expense_audit_log` — 8 columns. (Full per-column list in §9.1
and reproducible via the `information_schema.columns` queries in the
migration file's own Verification section.)

*Indexes:* `expenses_pkey`, `expenses_expense_date_idx`,
`expenses_booking_id_idx`; `job_payments_pkey`,
`job_payments_booking_id_idx`, `job_payments_stripe_pi_idx` (now a **plain**
`btree (stripe_payment_intent_id)` — no `WHERE` clause, per §10.3's fix);
`expense_audit_log_pkey`, `expense_audit_log_expense_id_idx`.

*Triggers:* `expenses_audit_insert`, `expenses_audit_update` — both on
`public.expenses`, both present.

*RLS state:* all three tables — `rls_enabled: true`, `rls_forced: false`,
**zero policies** on any of them (`pg_policies` count = 0). This is
intentional (§ migration file's own comment) — `service_role` carries
`BYPASSRLS` in the real Supabase project (confirmed by this project's own
prior documentation, not assumed), so RLS-with-zero-policies means
"blocked for every role except `service_role`," which is exactly the
posture this project uses for every other table.

*Effective `service_role` privileges (`has_*_privilege()`, the
authoritative check — all 20 matched their expected value in the live
run):* `job_payments.amount` UPDATE → **false**; `payment_method` UPDATE →
**false**; `booking_id` UPDATE → **false**; `voided_at` UPDATE → **true**;
`voided_reason` UPDATE → **true**; `job_payments` DELETE → **false**;
SELECT → **true**; INSERT → **true**. `expenses.id` UPDATE → **false**;
`created_at` UPDATE → **false**; `created_by` UPDATE → **false**; `amount`
UPDATE → **true**; `voided_at` UPDATE → **true**; `expenses` DELETE →
**false**; SELECT → **true**; INSERT → **true**. `expense_audit_log`
INSERT → **true**; SELECT → **true**; UPDATE → **false**; DELETE →
**false**.

*Expense FK behavior:* `expense_audit_log_expense_id_fkey` = `FOREIGN KEY
(expense_id) REFERENCES expenses(id)` — no cascade; a `DELETE` on an
`expenses` row with any audit history is rejected by Postgres itself
(§10.1).

*Idempotency constraint:* `job_payments_stripe_pi_idx` = `CREATE UNIQUE
INDEX ... ON public.job_payments USING btree (stripe_payment_intent_id)` —
plain, confirmed both that a duplicate `upsert(...)` call correctly
no-ops (still exactly 1 row) and that a genuine raw duplicate `INSERT`
(bypassing `ON CONFLICT`) is correctly rejected:
`duplicate key value violates unique constraint "job_payments_stripe_pi_idx"`.

### 10.5 What this pass changed

- `sql/2026-09-19_phase3c-stage3-job-payments-and-expenses.sql` —
  `job_payments_stripe_pi_idx` changed from a partial to a plain unique
  index (the real bug, §10.3).
- `api/_lib/job-payments-ledger.js` — one comment corrected to match.
- `tests/phase3c-stage3-job-payments.test.js` — one new static regression
  test added.
- No other file changed. Full suite: 777/777 passing after this pass.
