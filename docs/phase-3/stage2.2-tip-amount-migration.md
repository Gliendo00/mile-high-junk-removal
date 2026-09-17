# Phase 3C Stage 2.2 addendum — `bookings.tip_amount` migration

Status: **proposed, NOT executed.** The owner reviewed the Stage 2.2 Preview
(`https://mile-high-junk-removal-7gywwfcw7-gliendo00-4614s-projects.vercel.app`,
commit `119ceb7`) and asked for Tip Amount to be added to `+ Past Job` before
this stage ships. This requires one new production column that does not
exist yet. Per explicit instruction, this document records the exact SQL
required; no statement in it has been run against Supabase, and the code
change that depends on it is committed locally only — not pushed, not
deployed — until the column actually exists in production (see
[Why this can't go to Preview yet](#why-this-cant-go-to-preview-yet) below).

## Required migration

```sql
ALTER TABLE public.bookings
  ADD COLUMN tip_amount numeric(10,2) NULL;
```

That is the entire migration — one nullable column, no default, no
constraint beyond the type itself. Matches the precision/scale of the two
existing money columns on the same table confirmed in
[stage2-preflight.md](./stage2-preflight.md) (`estimated_price`,
`final_price` are both nullable `numeric(10,2)`), per that document's own
recommendation that a future `tip_amount` share their representation rather
than independently guessing a type.

## Why this is safe to run when authorized

- **Additive only.** No existing column, row, index, constraint, or
  application code path is touched. No table rewrite is required in modern
  Postgres for adding a nullable column with no default — this is a fast,
  metadata-only `ALTER TABLE` (briefly takes an `ACCESS EXCLUSIVE` lock on
  `bookings`, as any `ALTER TABLE` does, but doesn't rewrite existing rows).
- **No backfill needed.** Every existing row gets `tip_amount = NULL`
  automatically, which is exactly the correct value for a historical job
  that predates this column — there is no correct non-NULL default to
  backfill.
- **Nothing currently reads or writes this column**, so running the
  migration alone (before any code deploy) changes nothing observable —
  the column would simply sit unused until the Stage 2.2 code that
  reads/writes it is deployed.
- **Reversible.** `ALTER TABLE public.bookings DROP COLUMN tip_amount;`
  would cleanly undo it with no cascading effect on any other table (no
  other table references this column).

## Who runs it, and how

Per [production-safety-rules], this agent does not execute SQL against
production Supabase. When authorized, the owner (or an agent explicitly
told to proceed) runs the single `ALTER TABLE` statement above via the
Supabase Dashboard's **SQL Editor** — the same tool used for the Stage 2
preflight's read-only query in `stage2-preflight.md`, just with this one
write statement this time.

## Why this can't go to Preview yet

Every Vercel Preview deployment on this project points at **production**
Supabase (an existing, already-flagged standing characteristic of this
project — see the architecture audit's security section and
`stage2.1-new-job-proposal.md §11`). The code change this migration
unblocks (below) adds `tip_amount: tipAmount` to `api/admin/booking.js`'s
single shared `bookings` insert — used by **both** New Job and Past Job.
If that code were deployed before the column exists, Supabase's PostgREST
layer would reject the insert for an unrecognized column on **every**
booking creation, New Job included, not just Past Job ones with a tip
entered — a regression far outside this stage's scope. So the code below
is written and tested now, but stays on the local `phase-3c/stage2.2-past-job`
branch, unpushed, until the column is confirmed live in production.

## Sequencing once authorized

1. Owner (or an explicitly-authorized agent action) runs the `ALTER TABLE`
   statement above directly in the Supabase Dashboard SQL Editor.
2. Owner/agent confirms the column exists (e.g. `select column_name,
   data_type, numeric_precision, numeric_scale, is_nullable from
   information_schema.columns where table_schema='public' and
   table_name='bookings' and column_name='tip_amount';` — read-only,
   confirms the migration landed as written).
3. Only then does pushing/redeploying the already-committed Stage 2.2 code
   (which references `tip_amount`) become safe.
