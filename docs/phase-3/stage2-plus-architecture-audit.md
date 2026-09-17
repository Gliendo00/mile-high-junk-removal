# Phase 3C Stage 2+ — Architecture Audit

Status: **audit only. No feature code, no migration, no Supabase mutation,
no push/deploy.** This reviews [stage2-plus-requirements.md](./stage2-plus-requirements.md)
against the codebase as it exists at production baseline `81a40af`, and
recommends a staged build order. Every finding below is traceable to a real
file read during this audit, not inferred from memory.

## 1. What already fits with zero schema change

Worth stating up front, since it shrinks the actual gap: several Stage 2+
requirements need **no new column at all**, because Phase 3B/3C already
built the primitive they depend on.

| Requirement | Already exists |
|---|---|
| §5 New Job frozen address snapshot | `bookings.service_address/service_city/service_state/service_zip` already exist and are already the primary source everywhere (`api/admin/booking.js`, `api/admin/bookings.js`, `api/admin/client.js`, the schedule view) — a legacy row without one falls back to the customer's current address, exactly the pattern §5 asks New Job to establish. |
| §6/§8 private notes on a job | `bookings.internal_notes` already exists and is already read by `api/admin/booking.js`. |
| §7 duplicate-safe client matching | `phone_normalized`/`email_normalized` columns and `normalizePhone()`/`normalizeEmail()` (`api/_lib/customer-identity.js`) already exist and are already exercised by `api/book.js`'s repeat-client lookup. |
| §9 completed/booked revenue split | `bookings.estimated_price` and `bookings.final_price` already exist as separate columns on every booking row — the revenue-summary logic in §9 is a new *query*, not a new *column*. |
| §4 Denver-local "today" | `api/admin/bookings.js`'s `denverTodayIso()`/`addDaysIso()` already solve the UTC-vs-Denver problem for day-level arithmetic; the Month/Year work extends this pattern rather than inventing it. |

## 2. Conflicts / required changes to existing behavior

### 2.1 "Week" is not what §3 asks for

`api/admin/bookings.js`'s `handleSchedule()` implements "week" as a rolling
7-day window (`today` .. `today + 6`) with **no `startDate`/`endDate` input
and no previous/next navigation** — `schedule-architecture.md` flags this
exact design as "a judgment call... flagged here for review." §3 explicitly
requires previous/next week navigation with a clearly displayed range, i.e.
**arbitrary week windows, not just "the next 7 days from now."** This is a
direct, acknowledged conflict: `VALID_RANGES = ["today","tomorrow","week"]`
has no way to ask for last week or three weeks from now today. Fixing it
means widening `handleSchedule`'s contract to accept an explicit anchor date
(and, per §4, a Month/Year mode too) rather than only a fixed enum.

### 2.2 No date-range floor/ceiling exists anywhere

Nothing in `api/admin/bookings.js` rejects or clamps an out-of-range date.
§4's "January 1, 2026 is the earliest date selectable" is a **new
constraint** that has to be added — both as a server-side floor (so the API
itself never returns fabricated pre-2026 structure) and a UI affordance
(disable further "previous" navigation). Recommend a single exported
constant (e.g. `HISTORICAL_FLOOR_ISO = "2026-01-01"`) in a shared module, so
it's defined once and reused by every range-accepting endpoint and every
UI control, never duplicated as a string literal in multiple places.

### 2.3 `booking-status.js`'s narrowness is a deliberate design choice this plan pushes against

`api/admin/booking-status.js`'s header comment states it is "deliberately
narrow... does not become a generic 'update a booking' endpoint" — the only
column it can ever write is `status`, to one of six hardcoded values, and
the request body is never spread into the update payload. §8/§9 need to
write `final_price`, `tip_amount`, `payment_method`, and `payment_status` on
an existing booking — a materially larger write surface than "one status
enum." This isn't a bug to fix, it's a real design tension to resolve
deliberately (see §4.2 below) rather than by quietly bolting more fields
onto an endpoint whose own documentation says it intentionally doesn't do
that.

### 2.4 Historical entry violates today's implicit "every booking has a time window" assumption

`api/admin/bookings.js`/`booking.js`/`client.js` all read `time_window` and
resolve it through `timeWindowLabel()`/`timeWindowStartHour()`
(`api/_lib/time-windows.js`) without a null-check beyond "unrecognized value
sorts last." A Past Job with no time window at all (§6: "must be optional")
is a new case — `time_window: null` — that every consumer of this column
needs to keep tolerating exactly as gracefully as it already tolerates an
*unrecognized* value. Worth an explicit test rather than assuming today's
"sorts after every recognized window" behavior already covers `null`
(it likely does, since `timeWindowStartHour(null)` should already return
`null` the same as an unrecognized string — but this should be verified,
not assumed, before Past Job ships).

### 2.5 Public-flow duplicate matching is silent; admin-flow duplicate matching must not be

`api/book.js`'s repeat-client reuse (Phase 3B Step 4a.3) auto-attaches a
booking to an existing customer whenever exactly one row matches both
`phone_normalized` and `email_normalized` — **silently, with no human in the
loop**, which is correct for an unattended public form. §7 requires the
admin-side Find/Create Client flow to *surface* an exact match "strongly"
and require "deliberate action" before creating a duplicate anyway — i.e.
the same matching query and the same normalization functions, but a
different calling contract (return the match for the admin to confirm/reuse,
don't auto-join silently). This is a UX-and-endpoint-contract difference,
not a bug in the existing code — flagged so Stage 2 doesn't assume it can
call the exact same code path unmodified.

## 3. Schema changes this plan requires (documented, not executed)

None of the following are created by this audit. Recorded here so Stage 2
implementation planning starts from an agreed list rather than inventing one
mid-stage.

| Table | New column(s) | Notes |
|---|---|---|
| `bookings` | `tip_amount` | Type must match whatever `final_price`'s live type actually is (§8 explicitly calls this out) — **`final_price`'s type has never been independently confirmed against production**; [database-schema.md](../phase-1/database-schema.md) still lists it as NEEDS VERIFICATION. This is a blocking unknown, not a guess to make now. |
| `bookings` | `payment_method` | Small fixed set (Card/Cash/Invoice/Zelle/Venmo). Recommend following the existing `status` column's own pattern — a plain text column plus an app-level allowlist (mirroring `booking-status.js`'s `ALLOWED_STATUSES` shape) — rather than a DB-level enum type, for consistency with how this codebase already does it. |
| `bookings` | `payment_status` | Same treatment: text + app-level allowlist (Paid/Unpaid). |
| `bookings` | `archived_at` (nullable timestamp) | Visibility flag only, no cascade — the recommended safe alternative to permanent delete, exactly per the already-audited FK-cascade finding in [database-schema-updates.md](./database-schema-updates.md). |
| `customers` | `archived_at` (nullable timestamp) | Same pattern. Permanent customer delete still requires a zero-bookings guard in application code regardless of this column, since the CASCADE itself offers no interception point. |
| *(new table)* `expenses` | `id`, `expense_date`, `category`, `amount`, `notes` (nullable), `created_at`, and a nullable `booking_id` (§16) | A genuinely new resource — not modeled as a `bookings` row with a fake service type. Leave room for (not: build now) `receipt photo`, `vendor`, `vehicle/trailer attribution` as nullable additions later. |

**Before any of these migrations are written**, the one concrete unknown
that blocks a correct choice is `final_price`'s live column type — this
needs a **read-only** `information_schema.columns` check against production
(not a mutation) as the literal first step of whichever stage adds
`tip_amount`, so `tip_amount`/`final_price`/`estimated_price` share one
consistent money representation instead of three independently-guessed
types.

## 4. API / serverless-function-limit implications

This is the single biggest structural risk in the whole plan, and it's not
hypothetical — Stage 1 already hit it once (see
[vercel-function-limit.md](./vercel-function-limit.md)).

### 4.1 Current state: zero headroom

Confirmed directly against the working tree during this audit:

```
api/*.js        book.js, contact.js, instagram-feed.js, reviews.js, upload-photo.js       (5)
api/admin/*.js  booking-status.js, booking.js, bookings.js, client.js, clients.js,
                login.js, logout.js                                                        (7)
                                                                                    total: 12
```

The project is **exactly at** the Hobby plan's 12-function ceiling right
now, with the Stage 1 fix already having consumed the one piece of slack
that existed (folding `new-count.js` into `bookings.js`). Every Stage 2+
capability that needs its own new endpoint file makes the count 13+ and
fails at deploy time exactly as it did before — the regression test
(`tests/phase3c-schedule.test.js`) will catch this locally before another
failed Preview deploy, but it doesn't create budget, only visibility into
its absence.

### 4.2 What Stage 2+ actually needs, and how to fit it without a plan upgrade

Naively, the plan's write surface is: create job (New/Past), edit job
(price/tip/payment/notes), create client, archive/restore job, archive/
restore client, permanently delete job, permanently delete client, create
expense, list expenses (+ totals), and eventually per-day/month/year
Schedule aggregation. Built as one file each, that's 8-10 new functions
against a budget of zero. Recommended consolidation, extending the exact
pattern Stage 1 already established (folding `schedule`/`countsOnly` into
`bookings.js` via query modes/`req.method` branching):

- **`api/admin/booking.js`** — currently `GET` only (single-booking detail).
  Extend to a full per-resource file: `POST` = create a job (covers both
  New Job and Past Job — they differ only in which fields are required and
  the default `status`, not in the endpoint), `PATCH` = edit job fields
  (price/tip/payment/notes/archive), `DELETE` = permanent delete (with the
  Storage-cleanup step from [database-schema-updates.md](./database-schema-updates.md)).
  This absorbs `booking-status.js`'s one job entirely — recommend retiring
  `booking-status.js` as its own file once `booking.js`'s `PATCH` covers
  status changes too, which nets **-1** function before Stage 2 adds
  anything.
- **`api/admin/client.js`** — currently `GET` only (single-client detail).
  Extend the same way: `POST` = create (standalone and inline-from-job
  share this), `PATCH` = archive/restore, `DELETE` = permanent delete (with
  the bookings-count guard from §19). **No new file.**
- **`api/admin/bookings.js`** — already handles list + counts + schedule via
  query modes. Extend `handleSchedule` to accept an explicit date range and
  a `mode=list|calendar|summary` (or similar) so Month/Year/financial-summary
  views reuse this one file rather than each getting their own. **No new
  file.**
- **Expenses** — this is the one genuinely new resource with no existing
  file to extend. One new file, e.g. `api/admin/expenses.js`, handling
  `GET` (list + date-range totals) and `POST` (create), with `PATCH`/`DELETE`
  added later for archive, following the same method-branching shape.
  **+1 function.**

Net trajectory if this consolidation is followed: 12 → 11 (retire
`booking-status.js`) → 12 (add `expenses.js`) → **12, exactly at the
ceiling again**, with the entire job/client create-edit-archive-delete
surface absorbed into two existing files. This leaves **zero** further
headroom for the later route-map or SMS stages (§21/§22) — those will need
either more of the same consolidation (a strong candidate: route-map
directions can likely be computed from data the existing `bookings.js`
schedule view already returns, needing no new endpoint at all) or the Pro
plan decision below.

### 4.3 The decision this doesn't get to duck forever

Two honest paths, unchanged in substance from what
[vercel-function-limit.md](./vercel-function-limit.md) already flagged, now
concretely up against the plan above:

1. **Consolidate aggressively** (recommended default, costs nothing): every
   resource file grows multiple HTTP methods instead of staying
   single-purpose. This is more internal branching per file than this
   codebase's existing style prefers, but it's the same trade already made
   once for Stage 1 and it fits the whole current plan at exactly 12.
2. **Upgrade to Vercel Pro**: removes the ceiling, lets every new capability
   stay in its own small file matching the codebase's current per-file
   style. A cost decision for Rocky, not a technical one.

This audit recommends path 1 for as long as it keeps working (through at
least the end of §25's list), and flags SMS (§22) as the most likely place
it stops working cleanly, since a future inbound-SMS webhook is a genuinely
new, differently-shaped resource the way expenses were.

## 5. Security implications

No change to the existing security posture is proposed; everything below is
"continue the existing pattern," called out per new capability so it's
explicit rather than assumed.

- **Every new write path** (job create/edit/delete, client create/archive/
  delete, expense create) must run `requireAdmin()` first, use the
  service-role client only after that succeeds, set `Cache-Control:
  no-store`, and validate/allowlist every field explicitly — mirroring
  `booking-status.js`'s existing discipline of reading only named primitives
  off the request body and never spreading it into a query payload.
- **Consolidating multiple HTTP methods into one file (§4.2) raises the
  blast radius of a mistake in that file** — a bug in `booking.js`'s new
  `DELETE` branch is now sitting next to the `GET`/`POST`/`PATCH` branches
  in the same module instead of physically isolated in its own file. The
  mitigating pattern already exists in this codebase (`booking-status.js`'s
  hardcoded `ALLOWED_STATUSES`, never derived from anything else, changed
  only by deliberate edit) — the same per-field/per-action explicit
  allowlist approach should apply to each branch of the consolidated files,
  not a shared "update whatever's in the body" helper.
- **Expense category allowlist**: same shape as `ALLOWED_STATUSES` —
  `EXPENSE_CATEGORIES = ["fuel","dump_fees","meals","repairs_maintenance","advertising","supplies","miscellaneous"]`
  (illustrative), rejected outright rather than fuzzy-matched, exactly like
  the existing status allowlist's case-sensitive exact-match behavior.
- **Money fields need bounds, not just type-correctness**: a bounded numeric
  range check (matching the existing `MAX.*` constant convention in
  `api/book.js`/`api/admin/clients.js`) on `amount`/`tip_amount`/
  `final_price` server-side, independent of whatever the DB column type
  turns out to allow.
- **Permanent job delete must remove Storage objects before/alongside the
  row delete** — already audited in
  [database-schema-updates.md](./database-schema-updates.md); repeated here
  because it's a real, specific implementation step (mirror
  `api/upload-photo.js`'s `safeDeleteStorageObject()` pattern), not a
  general reminder.
- **Permanent client delete must count bookings first and refuse on any
  non-zero count** — the CASCADE offers no interception point once issued,
  so the guard is entirely a pre-check in application code, not something
  the database enforces for you.
- **Financial aggregates are computed server-side** (§9) — no client-supplied
  total is ever trusted as authoritative, consistent with every other admin
  read path in this codebase already being server-computed.
- **Preview environment caution carries forward unchanged**: Preview may
  point at production Supabase. Any Stage 2+ testing of a new mutating
  endpoint must use this project's existing offline test harness (a stubbed
  `@supabase/supabase-js`, per every `tests/*.test.js` file already in this
  repo) rather than a real Preview click-through, exactly as every prior
  phase was verified.
- **No weakening of existing posture**: none of the above changes
  `requireAdmin()`, the cookie model, the admin-email allowlist, or the
  IDOR/IDOR-adjacent id-validation pattern already in place — Stage 2+ is
  additive to this, not a rework of it.

## 6. Recommended staged implementation sequence

The requirements doc's own §25 priority order is sound; this reorders two
items based on the technical dependencies found above, and makes the
schema-verification step an explicit zeroth stage.

1. **Stage 2.0 — Pre-work (no schema change, read-only verification):**
   confirm `final_price`'s live column type directly against production
   (read-only `information_schema` check, not a migration) so every later
   money-type decision in this list is made once, correctly, instead of
   guessed three times.
2. **Stage 2.1 — `+ New Job` + inline Create Client.** Extends
   `api/admin/booking.js` (`POST`) and `api/admin/client.js` (`POST`) per
   §4.2. No new schema needed (service-address snapshot columns already
   exist). This is the highest-value, lowest-schema-risk stage and matches
   §25's own #1.
3. **Stage 2.2 — `+ Past Job` / historical migration workflow.** Reuses
   the same `booking.js` `POST` endpoint with a historical-entry mode
   (optional time window, default `status = completed`, Jan 1 2026 floor).
   Small, natural follow-on to 2.1 rather than a separate endpoint.
4. **Stage 2.3 — Edit job fields (status/price/notes) via `booking.js`
   `PATCH`, retiring `booking-status.js`.** Doing this *before* adding
   tip/payment/payment-status keeps the consolidation decision (§4.2)
   isolated from the schema decision (tip/payment columns), so each is
   reviewable on its own.
5. **Stage 2.4 — Add `tip_amount`/`payment_method`/`payment_status`**
   (migration, using the type confirmed in 2.0) and extend the Stage 2.3
   `PATCH` endpoint to accept them.
6. **Stage 2.5 — Month + Year + arbitrary-range Schedule, with the Jan 2026
   floor enforced server-side.** Depends on 2.1-2.2 existing so there's
   real historical data to view, but is otherwise independent of the
   money-field work in 2.4.
7. **Stage 2.6 — Revenue summaries** (Today/Week/Month/Year), built on the
   range support from 2.5 and the money fields from 2.4.
8. **Stage 2.7 — Archive/restore/safe permanent delete**, for both jobs and
   clients, using the `archived_at` columns and the `booking.js`/`client.js`
   `DELETE` branches from §4.2 (including the Storage-cleanup step).
9. **Stage 2.8 — Expense data model + daily Quick Expense icons**
   (new `expenses` table, new `api/admin/expenses.js`).
10. **Stage 2.9 — Revenue + expense summaries**, combining 2.6 and 2.8.
11. **Stage 2.10 — Daily route map.**
12. **Stage 2.11 — SMS/communications**, revisiting the Vercel
    function-budget decision (§4.3) at that point.

Each stage remains individually reviewed/approved before the next begins,
per the standing instruction — this reordering doesn't change that, only
the technical grouping.

## 7. Decisions that need Rocky's/the owner's input before Stage 2 starts

**Resolved — see [stage2-decisions.md](./stage2-decisions.md) for the full,
exact answers.** Summary: (1) stay on Vercel Hobby, consolidate; (2)
`booking-status.js` retirement approved in principle, deferred to its own
reviewed stage rather than bundled into New Job; (3) admin duplicate-client
UX locked (block on exact phone+email match with an explicit "Create
anyway" override, warn-only on a partial match, never auto-merge); (4)
Past Job is only for jobs that don't already exist in the CRM. Decision #5
below (money type) remains genuinely open, pending
[stage2-preflight.md](./stage2-preflight.md)'s result. Original open
questions kept below for the historical record.


1. **Function-budget path (§4.3)**: consolidate aggressively into
   multi-method resource files (free, more branching per file), or upgrade
   to Vercel Pro (paid, keeps the existing one-file-per-endpoint style)?
   This audit recommends consolidation as the default but it's a real
   trade-off, not a technical fact.
2. **Retiring `booking-status.js` (§4.2/§6 Stage 2.3)**: folding its one job
   into a broader `booking.js` `PATCH` is recommended for the function
   budget, but it reverses that file's own documented "deliberately narrow,
   will never become a generic update endpoint" design choice. Worth an
   explicit yes rather than treating it as implied by the rest of the plan.
3. **Admin-side duplicate-client UX (§2.5)**: on an exact phone+email match
   during inline client creation, should the admin flow (a) block save and
   require an explicit "use existing client" tap, or (b) allow save but
   show a strong warning either way? The requirements doc says "require
   deliberate action" — this audit reads that as (a), but the exact
   interaction hasn't been specified pixel-for-pixel and is worth confirming
   before building it.
4. **Historical/live boundary for "today's" bookings**: bookings placed
   through the live public `/book` flow between January 2026 and today
   already exist in `bookings` via the normal path — Past Job is for
   filling in jobs that were *never* entered anywhere (phone/text-only, or
   pre-CRM paper/memory records), not for re-entering what's already there.
   Confirming this reading avoids duplicate entries once Past Job exists.
5. **Money type for `tip_amount`** — blocked on Stage 2.0's read-only
   verification (§3/§6.1), not something to decide speculatively now.
