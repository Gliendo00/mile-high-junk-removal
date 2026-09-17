# Phase 3C Stage 2.4 addendum — `expenses` table migration

Status: **proposed, NOT executed.** Per the addendum's explicit instruction
("Do NOT execute a Production Supabase migration yourself... STOP the
expense write implementation at the point where owner action is
required"), this agent has not run any statement against production
Supabase. The code that depends on this table (`api/admin/bookings.js`'s
`handleExpensesList()`/`handleCreateExpense()`, and the client-side
`admin/quick-expense.js`) is fully written and covered by the offline test
suite (`tests/phase3c-stage2.4-expenses.test.js`), but has never been
exercised against a real database — see
[Why this can't be verified live yet](#why-this-cant-be-verified-live-yet)
below.

First confirmed: **no `expenses` table exists in this codebase's schema
docs.** `docs/phase-3/stage2-plus-requirements.md` and
`docs/phase-3/stage2-plus-architecture-audit.md` both describe "lightweight
expense tracking (a new `expenses` table, not yet created)" as a future
stage — this addendum is that stage, arriving ahead of its originally
planned sequence position (Stage 2.8) at the owner's request, bundled into
Stage 2.4's calendar work since the two share the same "select a day, act
on it" UI surface.

## Required migration

```sql
CREATE TABLE public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date date NOT NULL,
  category text NOT NULL,
  amount numeric(10,2) NOT NULL,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX expenses_expense_date_idx ON public.expenses (expense_date);

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
```

No RLS policies are created — matching `bookings`/`customers`' own posture
(see `docs/phase-1/admin-security-requirements.md`): every read/write to
this table goes through `api/admin/bookings.js`'s service-role client
(`api/_lib/supabase-admin.js`), which bypasses RLS entirely and is gated by
`requireAdmin()` before any query runs. Enabling RLS with zero policies is
strictly more restrictive than leaving it disabled — it blocks the `anon`
key from ever reading or writing this table even if a future bug somehow
routed a request through the wrong Supabase client, which is exactly the
posture `docs/phase-1/admin-security-requirements.md`'s "if RLS is not
already enabled" guidance calls for on any new table.

### Column notes

- `id uuid DEFAULT gen_random_uuid()` — matches this project's existing
  `bookings`/`customers` primary-key convention (both are documented as
  UUID in `docs/phase-1/database-schema.md`, though that document itself
  flags the exact DEFAULT expression as NEEDS VERIFICATION since it was
  never independently confirmed against the live schema). If the existing
  tables' real default turns out to be `uuid_generate_v4()` (the
  `uuid-ossp` extension) instead of `gen_random_uuid()` (built into
  Postgres 13+/`pgcrypto`), either works correctly for a brand-new table —
  this is a cosmetic consistency preference, not a functional requirement,
  and can be adjusted before running if the owner confirms the other
  tables' actual default.
- `amount numeric(10,2) NOT NULL` — same precision/scale as `bookings.
  estimated_price`/`final_price`/`tip_amount`, confirmed live in
  `docs/phase-3/stage2-preflight.md`, for the same reason the Stage 2.2 tip
  addendum matched them: one consistent money representation across the
  whole schema. `NOT NULL` here (unlike the bookings money columns) because
  an expense row only ever exists once an amount has actually been entered
  — there is no "create the expense now, fill in the amount later" flow in
  this addendum, unlike a booking's price fields.
- `category text NOT NULL` — a free-text column, not a Postgres `enum` or a
  `CHECK` constraint against the seven locked values (`fuel`, `dump_fees`,
  `meals`, `repairs_maintenance`, `advertising`, `supplies`,
  `miscellaneous`). The application layer (`api/_lib/expense-categories.js`,
  read by `api/admin/bookings.js`'s `handleCreateExpense()`) is the sole
  enforcement point, matching this project's existing convention for
  `bookings.service_type`/`status` (see `docs/phase-1/database-schema.md`:
  "Whether the DB itself enforces this as an enum/check constraint or just
  a free-text column: NEEDS VERIFICATION" — the established pattern here is
  app-level validation, not a DB constraint). A `CHECK` constraint could be
  added later without any application code change if the owner later wants
  DB-level enforcement too.
- `note text NULL` — optional, matches the addendum's requirement.
- `expense_date date NOT NULL` — the historical floor
  (`api/_lib/historical-floor.js`'s `HISTORICAL_FLOOR_ISO`, 2026-01-01) and
  "never in the future" are both enforced at the application layer in
  `handleCreateExpense()`, not as a DB constraint — consistent with how
  `bookings.appointment_date`'s equivalent floor is enforced today.
- `expenses_expense_date_idx` — every query this stage issues
  (`handleExpensesList()`) filters by `expense_date` range; an index keeps
  that fast as the table grows, mirroring the implicit assumption
  `bookings.appointment_date` already benefits from being queried this way
  throughout the Schedule/Calendar work.
- No `booking_id`, `receipt_url`, `vendor`, or `vehicle` columns —
  explicitly out of scope per the addendum ("do not implement those now
  unless an existing schema already requires them" — it doesn't). Adding
  any of these later is a simple additive `ALTER TABLE ... ADD COLUMN`,
  the same low-risk shape as the `tip_amount` migration this project has
  already run once successfully.

## Reporting-readiness (not built this stage)

Every column a future "aggregate by day/week/month/year/category" report
would need already exists: `expense_date` for any time-bucketing, `category`
for the group-by, `amount` for the sum. No schema change is anticipated
being necessary to add that reporting later — only new query code, per the
addendum's explicit "design so later reporting can aggregate... but do not
build reporting now."

## Why this is safe to run when authorized

- **Additive only.** A brand-new table; touches no existing table, row,
  index, constraint, or application code path. `bookings`/`customers`/every
  other existing table are completely unaffected by this migration existing
  or not.
- **No backfill needed or possible.** There is no prior expense data
  anywhere in this system to migrate — every row will be newly entered by
  the owner from this stage forward.
- **Nothing currently reads or writes this table.** Running the migration
  alone, before deploying this stage's code, changes nothing observable —
  the table would simply exist unused until this code is live. Deploying
  this stage's code BEFORE the migration runs is also safe in the other
  direction (unlike the Stage 2.2 tip_amount case) — see the next section.
- **Reversible.** `DROP TABLE public.expenses;` would cleanly undo it; no
  other table has a foreign key into it.

## Why this can't be verified live yet

Every Vercel Preview deployment on this project points at **production**
Supabase (an existing, already-flagged standing characteristic — see
`docs/phase-3/stage2.1-new-job-proposal.md §11`). Unlike Stage 2.2's
`tip_amount` addendum — where deploying the code before the migration ran
would have broken **every** booking creation, New Job included, because
both modes shared one `bookings` insert — this addendum's blast radius is
fully isolated: `handleExpensesList()`/`handleCreateExpense()` only ever
touch the new `expenses` table, never `bookings` or `customers`. A GET or
POST against `?view=expenses` before the migration runs will fail cleanly
(PostgREST returns a "relation does not exist" error, caught by this file's
existing try/catch and surfaced as a generic `500`/"Could not load
expenses."/"Could not save this expense." — see
`admin/quick-expense.js`'s non-blocking failure handling), but nothing else
in the Schedule, Calendar, Requests, or Clients surfaces is affected either
way. This is why this stage's Preview verification pass never attempts to
actually save a real expense (see the stage report's Preview-safety
section) — not because doing so would be dangerous to other data, but
because there is nothing live to save it to yet.

## Sequencing once authorized

1. Owner (or an explicitly-authorized agent action) runs the `CREATE TABLE`
   statement above directly in the Supabase Dashboard SQL Editor.
2. Owner/agent confirms the table exists and matches this shape (e.g.
   `select column_name, data_type, is_nullable from
   information_schema.columns where table_schema='public' and
   table_name='expenses';` — read-only).
3. From that point on, the already-implemented Quick Expense UI (once this
   branch is merged/deployed) works against real data with no further code
   change required.
