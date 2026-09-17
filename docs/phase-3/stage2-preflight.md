# Phase 3C Stage 2 — Read-Only Schema Preflight

Status: **complete — verified against production, 2026-09-17.** The owner
ran the read-only query below directly (this session had no path to run it
itself — see "Why this couldn't be run directly from this session" below,
kept for the record). No Supabase mutation happened at any point.

## Confirmed live schema (production, read-only)

| Column | Type | Precision | Scale | Nullable | Default |
|---|---|---|---|---|---|
| `bookings.estimated_price` | `numeric` | 10 | 2 | `YES` | `NULL` |
| `bookings.final_price` | `numeric` | 10 | 2 | `YES` | `NULL` |
| `bookings.time_window` | `text` | — | — | `YES` | `NULL` |

**What this settles:**

- `estimated_price` and `final_price` are both nullable `numeric(10,2)`.
  Future `tip_amount` should use the same **`numeric(10,2)`**, unless a
  later migration review surfaces a concrete reason to diverge — there's no
  reason for three money columns on the same table to disagree on
  precision/scale by default.
- `time_window` is nullable at the database level today. **`+ Past Job`
  (Stage 2.2) can represent an unknown historical appointment time as a
  real `NULL`** — no placeholder value ("unknown", `"tbd"`, an invented
  window) needs to be invented or migrated in later. This removes the one
  contingency [stage2-decisions.md](./stage2-decisions.md) flagged Stage
  2.2 as depending on.
- Stage 2.1 (`+ New Job`, this stage) is unaffected either way, as already
  noted below — it always requires a real time window and never needs to
  know `estimated_price`'s exact type to write a JS number into it.

## Why this couldn't be run directly from this session (kept for the record)

## What's being checked, and why

Before any Stage 2 code writes `bookings.final_price`/`estimated_price` or
designs `tip_amount`'s type, or before `+ Past Job` is built to leave
`time_window` unset for a historical job with no known appointment time, two
live facts need confirming against production — not assumed, per
[database-schema.md](../phase-1/database-schema.md), which has always listed
`estimated_price`/`final_price` as NEEDS VERIFICATION:

1. `bookings.estimated_price` — data type, numeric precision/scale, default, nullability.
2. `bookings.final_price` — same.
3. `bookings.time_window` — data type, default, nullability, and specifically:
   **does the database itself currently allow `NULL`?** (The application
   layer has always required a value on every insert path so far — that
   proves nothing about what the column itself permits.)

## Why this couldn't be run directly from this session

`api/_lib/supabase-admin.js` (and every existing admin route) reads
`SUPABASE_URL`/`SUPABASE_SECRET_KEY` from `process.env` — neither is set in
this local environment, and no `.env`/`.env.local` in `site/` carries them.
Separately, and more fundamentally: **Supabase's PostgREST API does not
expose `information_schema` by default** — the same service-role key that
every `/api/admin/*` route already uses to query `public.bookings` cannot be
pointed at `information_schema.columns` through `supabase-js`, because
PostgREST only serves tables/views registered in its `public`-schema cache.
Getting this specific information requires either the Supabase Dashboard
(Table Editor or SQL Editor) or a direct Postgres connection — not the
service-role REST key this app already uses. So even having the key
available here wouldn't have been enough on its own.

No workaround was attempted (no credential search beyond confirming none are
present, no attempt to install/authenticate the Vercel CLI to pull env vars,
no direct Postgres connection string requested) — pulling additional
secrets into this session isn't warranted when the dashboard already gives a
direct, read-only answer with no key ever leaving Supabase's own UI.

## How to get the answer (either works; no credentials need to be shared here)

**Option A — SQL Editor (one query, most precise):** in the Supabase
dashboard for this project, open **SQL Editor** and run:

```sql
select
  column_name,
  data_type,
  numeric_precision,
  numeric_scale,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'bookings'
  and column_name in ('estimated_price', 'final_price', 'time_window')
order by column_name;
```

This is a pure `SELECT` against `information_schema` — it cannot alter any
table, row, or setting. Paste the resulting rows back and this document (and
the Stage 2.4/2.3 design decisions that depend on them) will be updated with
the confirmed values.

**Option B — Table Editor (no SQL):** open **Table Editor → bookings**,
click the `estimated_price` column header (or the column's settings), and
the side panel shows its type/default/nullable directly; repeat for
`final_price` and `time_window`. Slightly less precise for numeric
precision/scale than Option A, but confirms nullability and base type just
as well.

## What depended on the result (now resolved — see the confirmed table above)

- **`time_window` nullability** gated `+ Past Job` (Stage 2.2 in the revised
  sequence, see [stage2-decisions.md](./stage2-decisions.md)) — **confirmed
  nullable**, so Past Job can save a historical job with an unknown time as
  a real `NULL`, no migration needed for this specifically.
- **`estimated_price`/`final_price` type/precision/scale** gates the
  `tip_amount` column design in Stage 2.5 (money fields) — so that
  `tip_amount` shares one consistent, deliberately-chosen money
  representation with the two columns it's reported alongside, instead of a
  third independently-guessed type.
- **Neither blocks Stage 2.1** (`+ New Job` + inline Create Client, proposed
  below) — New Job always requires a real appointment time (no `NULL`
  case), and it writes `estimated_price` using whatever type the column
  already has today without needing to know that type in advance (the same
  way every existing insert/read path already does).
