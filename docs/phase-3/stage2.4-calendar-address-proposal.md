# Phase 3C Stage 2.4 — Calendar, Historical Navigation, Date-Aware Entry, Google Address UX, Daily Quick Expense Tracking

Status: **implemented**, on feature branch `phase-3c/stage2.4-calendar-address`
from production baseline `409ae89`. Covers the "Calendar + Historical
Navigation + Date-aware Entry + Google Address UX" stage plus a same-session
addendum, "Daily Quick Expense Tracking," folded in because it shares the
identical UI surface (the Month view's selected-day panel).

## 1. Week start day — Sunday

Chosen to match the default week view of both Google Calendar and Apple
Calendar for a US locale — almost certainly what the owner's own phone
already shows — over an ISO-8601 Monday start. Documented once, as the
single source of truth, in `api/admin/bookings.js`'s `handleSchedule()`
header comment; every client-side copy of this convention (`admin/
schedule.js`, `admin/calendar-views.js`) points back to it rather than
re-deriving or re-justifying it.

## 2. Historical floor handling

`HISTORICAL_FLOOR_ISO` (`2026-01-01`, `api/_lib/historical-floor.js`) is
unchanged and reused, plus two new derived constants,
`HISTORICAL_FLOOR_YEAR`/`HISTORICAL_FLOOR_MONTH`, computed from it (never a
second hand-typed literal).

Because the floor date (a Thursday) doesn't align to a week or month
boundary, each navigation mode bounds at the smallest whole unit containing
it, exactly the way a normal calendar grid already shows a few adjacent-
month padding days at the start/end of any month view:

- **Week**: the earliest navigable week is the Sunday-aligned week
  *containing* the floor (`2025-12-28`–`2026-01-03`) — "Previous week" is
  disabled once there. The grid does not hide Dec 28–31, 2025 from that one
  week if a real (pre-floor) booking happens to exist on one of those days —
  this is a UI *navigation* boundary, not a data-hiding rule, per the
  stage's explicit "not permission to destroy or hide legitimate database
  records unexpectedly."
- **Month**: the earliest navigable month is January 2026 — "Previous
  month" is disabled there. January 2026's grid shows a few trailing
  December-2025 cells as standard muted/non-interactive calendar padding,
  the same way every month's grid shows adjacent-month padding.
- **Year**: the earliest navigable year is 2026 — "Previous year" is
  disabled there. Within 2026, months before January are impossible by
  construction (there are none).

No upper bound is product-imposed; each request is still individually
bounded (see §3) via `MAX_FUTURE_YEARS` (current Denver year + 3), which
moves forward on its own every year rather than being a fixed cutoff that
would eventually need manual bumping.

## 3. API contract

Everything below extends `api/admin/bookings.js` — **zero new serverless
function files** (still exactly 12/12; see §7). `requireAdmin()` gates
every mode before any query runs; every response carries
`Cache-Control: no-store` (set by `requireAdmin()`).

### `GET /api/admin/bookings?view=schedule&range=today|tomorrow|week|month|year`

Common response fields: `ok`, `range`, `startDate`, `endDate`, `today`
(Denver "today," so the client never needs a second source of truth for
it).

- **`range=today` / `range=tomorrow`** — unchanged from Stage 1.
- **`range=week`** — new optional `weekStart` (a Sunday-aligned `YYYY-MM-DD`;
  omitted defaults to the current Denver week). Validated: real calendar
  date, must literally be a Sunday, must be `>=` the floor week — any
  violation is `400`. Additional response fields: `weekStart`, `weekEnd`,
  `isCurrentWeek`, `canGoPrevious` (so the client never re-derives the floor
  comparison itself). `jobs`: full job cards, one bounded 7-day query.
- **`range=month`** — new optional `year`/`month` (each independently
  validated: `year` a real 4-digit number, `month` `1`–`12`; defaults to the
  current Denver month/year). Validated against the floor and the future
  cap; invalid → `400`. Response adds `year`, `month`, `jobs` (full job
  cards for the whole month — **one** bounded query, never one request per
  day), and `jobCountsByDate` (`{"2026-03-12": 2, ...}`) so the calendar
  grid's per-day indicator and the selected-day panel's job list both come
  from this single response.
- **`range=year`** — new optional `year` (validated the same way). Response
  replaces `jobs`/`jobCountsByDate` with `monthCounts` (`[{month:1,
  count:5}, ..., {month:12, count:0}]`) — **job counts only, never revenue,
  price, or any other per-booking field**, computed from one bounded
  `id, appointment_date`-only query for the whole year. Never 12 or 365
  separate requests.

Every mode keeps the existing `SCHEDULABLE_STATUSES = ["booked",
"completed"]` filter and the existing chronological sort (date, then
time-window start hour) for any mode that returns `jobs`.

### `GET /api/admin/bookings?view=expenses&startDate=&endDate=` (addendum)

Both dates required, validated as real calendar dates, `endDate >=
startDate`, and the span capped at `EXPENSES_MAX_RANGE_DAYS` (366) — never
an unbounded "every expense ever" query. Returns `{ok, startDate, endDate,
expenses: [{id, expenseDate, category, categoryLabel, amount, note,
createdAt, updatedAt}]}`, ordered by `expense_date` then `created_at`
(deterministic).

### `POST /api/admin/bookings` `{resource:"expense", ...}` (addendum)

`resource` is an explicit, allowlisted discriminator (mirrors `api/admin/
booking.js`'s `mode` field) — a request without `resource:"expense"` is
rejected `400`, never silently treated as some other write. Every field
(`expenseDate`, `category`, `amount`, `note`) is read individually and
validated:

- `expenseDate`: real calendar date, `>=` the historical floor, `<=` today
  (Denver) — a future expense is rejected.
- `category`: must be one of the seven locked keys in `api/_lib/
  expense-categories.js` (`fuel`, `dump_fees`, `meals`,
  `repairs_maintenance`, `advertising`, `supplies`, `miscellaneous`) — no
  "other" catch-all, matching the addendum's explicit instruction.
- `amount`: a finite number, `> 0`, bounded (`EXPENSE_MAX_AMOUNT`), rounded
  to 2 decimal places.
- `note`: optional, sanitized (control characters and `<...>`-shaped text
  stripped, matching `api/admin/booking.js`'s own `sanitizeText()`), bounded
  to 500 characters.

Never trusts the client's category/date/amount merely because it was sent
— every rule above is enforced server-side regardless of what the Quick
Expense UI itself already constrains client-side.

**Depends on a production `expenses` table that does not exist yet** — see
[stage2.4-expenses-migration.md](./stage2.4-expenses-migration.md) for the
exact `CREATE TABLE` statement (**not executed**) and why this is safe to
ship ahead of the migration (isolated blast radius, unlike Stage 2.2's
`tip_amount` case).

## 4. Today/Tomorrow/Week behavior

Today/Tomorrow are pixel-for-pixel unchanged from Stage 1. Week is now
navigable: a compact Prev/Next arrow row with a "Sun, Sep 13 – Sat, Sep 19"
label; a "Jump to this week" shortcut appears only when viewing a
non-current week (driven by the server's own `isCurrentWeek`, never a
client-recomputed guess); "Previous week" disables itself exactly at the
floor week (driven by `canGoPrevious`). Jobs remain grouped by date exactly
as before; the `booked`/`completed` inclusion rule is unchanged.

## 5. Month behavior

A genuine 7-column calendar grid (Sun–Sat headers) with Prev/Next month
navigation and a "September 2026"-style label. Each date cell shows the day
number plus, only when jobs exist that day, a small count badge — never a
full booking card crammed into a cell. Leading/trailing padding cells (the
edges of adjacent months) render muted and non-interactive. Tapping a date
selects it (today is auto-selected on load when the loaded month contains
it); the selected day's actual jobs render below the grid using the exact
same job-card component the Today/Tomorrow/Week views already use (`admin/
schedule.js`'s `renderJobCard`, exposed as `window.AdminSchedule.
renderJobCard` and reused by `admin/calendar-views.js` — no second, drifting
copy). A quick-action link — "+ Past Job" for a historical date, "+ New
Job" for today/future — carries the selected date into the create form via
`?date=`. An empty day shows a plain "No jobs on this date." message; an
empty month simply shows a grid with no count badges anywhere — both
intentional, not broken, per the stage's explicit instruction.

## 6. Year behavior

Twelve month tiles (2 columns on very narrow phones, 3 once there's room),
each showing the month name and, only when non-zero, a "N jobs" count.
Tapping a tile switches straight into Month view for that month. Prev/Next
year navigation; Prev disables at 2026. No revenue/profit/expense figure
appears anywhere in this view.

## 7. Vercel function count

**Still exactly 12/12** — the same 12 files as the current production
baseline. Confirmed by the existing regression guard (now also re-asserted
in `tests/phase3c-stage2.4-expenses.test.js`), which counts every
function-producing file under `api/` (excluding `api/_lib/`) and fails if
it exceeds 12. Two new non-function `_lib` modules were added
(`api/_lib/expense-categories.js`, plus two new derived exports in the
existing `api/_lib/historical-floor.js`) — neither counts, per the same
convention documented since Stage 1.

## 8. Date-aware entry

`admin/booking-new.js` and `admin/booking-past.js` each read an optional
`?date=` query param on load. The value is never trusted blindly:

1. Must match `/^\d{4}-\d{2}-\d{2}$/`.
2. Must round-trip through `Date.UTC` back to the exact same
   year/month/day (rejects an impossible date like `2026-02-30`, which the
   shape regex alone would accept).
3. Must satisfy the *same* range rule the server independently enforces —
   New Job: `>= todayIso`; Past Job: `>= HISTORICAL_FLOOR_ISO` and `<=
   todayIso`.

Any failure at any step is a silent no-op: the field keeps its existing
default (today for New Job; today for Past Job, still swappable back to
any valid historical date by hand). Nothing here ever throws, alerts, or
blocks the form from rendering — a broken or malicious `?date=` value
degrades to "the form opens exactly as if no date had been given," never a
crash. The server-side validation in `api/admin/booking.js`'s `POST`
handler is completely unchanged and remains the actual authority — this is
purely a convenience prefill, verified directly (both the valid-prefill and
the silently-ignored-invalid-prefill paths) in a local browser session
during this stage's verification pass.

Edit Job intentionally has no date-aware entry — it already loads its own
booking's real date from the server; there is no "calendar-selected date"
concept for editing an existing job.

## 9. Existing job date changes

No change was needed here, by design: Month/Year/Week all query
`bookings.appointment_date` fresh on every load, with zero client-side
caching of "which day a job is on." An edited booking's new date is
reflected the moment its containing period is (re)loaded — there is no
second source of truth to go stale. Verified in
`tests/phase3c-stage2.4-calendar.test.js`'s "an edited appointment_date is
reflected by the next query" test.

## 10. Google Address Autocomplete architecture

New shared component, `admin/address-autocomplete.js`
(`window.AdminAddressAutocomplete.attach(fields)`), used identically by New
Job, Past Job, and Edit Job's existing `service-address`/`service-city`/
`service-state`/`service-zip` inputs — no redesign of any form, no new
field ids.

- **API surface**: the modern Places API (New) data classes
  (`AutocompleteSuggestion.fetchAutocompleteSuggestions()` +
  `AutocompleteSessionToken`), not the legacy `google.maps.places.
  Autocomplete` widget class — Google no longer grants that legacy class to
  Places-API-(New)-era projects (the owner's Google Cloud project will be
  brand new), and the stage explicitly asked for the modern surface. Also
  not the `<gmp-place-autocomplete>` web component, which would replace the
  plain `<input>` entirely — a small custom dropdown, positioned under the
  existing input via CSS, was chosen instead specifically to avoid touching
  the existing form markup/styling/ids at all.
- **Loading**: lazy — the Google bootstrap script is only requested on the
  address field's first `focus`, never on page load, and never at all if no
  key is configured. `?libraries=places&loading=async` is the request URL
  shape; every step (script load, suggestion fetch, place-details fetch) is
  wrapped in a `.catch()` that silently gives up rather than throwing.
- **Structured mapping**: on selection, `place.fetchFields({fields:
  ["addressComponents"]})` — the single minimal field this form needs — is
  read into `street_number`+`route` → Street Address, `locality` → City,
  `administrative_area_level_1` (short form, e.g. "CO") → State,
  `postal_code` → ZIP. Never parses `formattedAddress`.
- **Geographic scope**: `includedRegionCodes: ["us"]` (hard restriction, per
  the stage's requirement) plus a `locationBias` circle centered on
  downtown Denver (~80 km radius) — a *bias*, not a restriction, so a
  legitimate service address well outside metro Denver remains fully
  selectable; it just doesn't get ranked first.
- **Fields requested**: `addressComponents` only, both for the
  autocomplete-suggestion request itself (Google's Autocomplete (New)
  suggestion payload doesn't carry billable Place Data fields at all — those
  only apply to the subsequent `fetchFields()` call) and for the
  place-details fetch. No map is ever rendered; this is text-only
  autocomplete.

## 11. Manual fallback (mandatory, verified)

Google is additive only, end to end:

- No key configured (`admin/google-maps-config.js` ships with
  `window.ADMIN_GOOGLE_MAPS_API_KEY = ""`) → `attach()` still runs, but the
  very first check (`hasConfiguredKey()`) short-circuits before any network
  call — confirmed directly in a local browser session: typing into Street
  Address with no key configured produces zero Google script requests, zero
  console errors, and the field holds exactly what was typed.
- Script fails to load / times out / a network error occurs at any later
  point → the rejected promise is caught silently; the dropdown simply
  never appears for that keystroke.
- No suggestion matches, or the owner ignores the dropdown and keeps typing
  → nothing is forced; Save is never blocked on having made a Google
  selection.
- A selected suggestion's place-details fetch fails, or its component
  mapping comes back incomplete → the fields are left exactly as they were,
  never partially overwritten or blanked.

No field is ever marked `required`, `readonly`, or `disabled` by this
component. Nothing is ever labeled "verified" — this is autocomplete/
standardization, not Address Validation, per the stage's explicit
instruction.

## 12. Google Cloud setup the owner needs to perform

Not requested or handled by this agent — **do not paste the key into
Claude chat**. Once ready:

1. In Google Cloud Console, create (or reuse) a project, then create an
   **API key** restricted as follows:
   - **Application restriction**: HTTP referrers. Add both the Production
     domain (`https://www.milehighjunkremoval.net/*` and
     `https://milehighjunkremoval.net/*`) and a Preview-testing entry —
     either the specific Preview URL pattern Vercel assigns
     (`https://mile-high-junk-removal-*.vercel.app/*`, if the Cloud Console
     accepts that wildcard shape) or, more simply, add each Preview URL
     as it comes up during a testing session and remove it afterward.
   - **API restriction**: restrict the key to only the two APIs this
     feature uses — **Maps JavaScript API** (the bootstrap loader) and
     **Places API (New)**. Do not leave it unrestricted, and do not enable
     any other Google Maps Platform API on this key.
2. Enable both of those APIs on the project (Cloud Console → "APIs &
   Services" → "Enabled APIs").
3. Paste the resulting key into `admin/google-maps-config.js`'s
   `window.ADMIN_GOOGLE_MAPS_API_KEY = ""` line (replacing the empty
   string) directly in the repository, then commit/deploy that one-line
   change. No other code changes are needed — the address fields on New
   Job/Past Job/Edit Job will start offering suggestions immediately.
4. Optional but recommended: set a budget alert / API-call quota on the key
   in Cloud Console, since a browser key's HTTP-referrer restriction limits
   *where* it can be used but not *how much* — this is normal Google Maps
   Platform hygiene, not specific to this project.

This key is safe to commit once restricted this way — see `admin/
google-maps-config.js`'s own header comment for why (Google's documented
security model for this key type is referrer + API restriction, not
secrecy, unlike every other secret in this codebase).

## 13. Daily Quick Expense Tracking (addendum)

Mounted by `admin/calendar-views.js` under the Month view's selected-day
panel only (not Today/Tomorrow/Week/Year) — see `admin/quick-expense.js`'s
header for why this stays scoped to the one explicit "a day is selected"
surface rather than spreading across every Schedule range, per the
addendum's "never turn the Schedule into an accounting screen" instruction.

- **UI**: four compact buttons above the selected day's job list — Fuel
  (⛽), Dump (🗑), Meal (🍔), + More — matching the addendum's exact icon
  set. Tapping Fuel/Dump/Meal opens a small bottom sheet with the category
  pre-filled/read-only, the date pre-filled/read-only (the currently
  selected calendar date — never re-typed), a required Amount field
  (auto-focused), and an optional Note. + More opens a category chooser
  (Repairs/Maintenance, Advertising, Supplies, Miscellaneous) first, then
  the same amount form. Primary flow: tap category → enter amount → Save —
  no other required step.
- **Display**: once any expense exists for the selected day, a "Tracked
  expenses: $X" line and a compact list (category + amount + note) appear
  below the quick-action row — never labeled Profit, Net Profit, or
  anything implying profitability, per the addendum's explicit instruction.
  A day with no expenses shows the quick-action row and nothing else —
  clean, not an empty-state message competing with the job list above it.
- **Data model / migration**: see
  [stage2.4-expenses-migration.md](./stage2.4-expenses-migration.md) — a
  new, isolated `expenses` table, **not yet created in production**. The
  code degrades to a small, calm inline "Could not load expenses for this
  date right now." message on any load/save failure (which is the expected
  behavior until the migration runs) without affecting the job schedule
  above it in any way.
- **API**: see §3 above (`GET ?view=expenses`, `POST {resource:"expense"}`)
  — both extend `api/admin/bookings.js`, zero new functions.
- **Reporting-readiness**: `expense_date`/`category`/`amount` are exactly
  the columns a future day/week/month/year/category aggregate report would
  need; no reporting logic is built this stage.

## 14. Tests

441 tests total (361 pre-existing baseline + 80 new), 0 failed, across:

- `tests/phase3c-stage2.4-calendar.test.js` (28) — navigable week (explicit
  `weekStart`, Sunday validation, floor rejection, `canGoPrevious`/
  `isCurrentWeek`), Month (explicit and defaulted year/month, floor and
  future-cap rejection, invalid year/month rejection, `jobCountsByDate`
  grouping, empty month, leap-year February boundary), Year (`monthCounts`
  shape and bucketing, floor/future-cap rejection, invalid year rejection,
  confirms no per-booking/price field ever appears), the
  booked/completed-only inclusion rule preserved, auth required on every
  mode, an edited `appointment_date` naturally reflected with no separate
  calendar state, and a Today regression check.
- `tests/phase3c-stage2.4-expenses.test.js` (28) — bounded-range GET
  validation (missing/malformed/reversed/excessively-wide dates all
  rejected), correct row filtering and `categoryLabel` derivation, POST
  validation for every field (missing `resource` discriminator, all seven
  locked categories individually accepted and "other" rejected, amount
  bounds, optional-and-sanitized-and-bounded note, floor/future date
  bounds), auth required, `Cache-Control: no-store`, confirms the write
  never touches `bookings`/`customers`, confirms DELETE/PUT are still 405,
  the migration doc's existence/content, and the 12-function guard.
- `tests/phase3c-stage2.4-address-and-prefill.test.js` (23) — source-level
  checks (this project's established pattern for client-only behavior, see
  that file's header) that New Job/Past Job validate `?date=` shape,
  real-date-ness, and range before use and silently ignore anything
  invalid; that the address-autocomplete component checks for a configured
  key before any network call, uses the modern Places API (New) classes
  (not the legacy widget or the web component), maps structured
  `addressComponents` only, requests only the necessary field, restricts to
  the US with a Denver bias, never disables/requires a field, and is wired
  identically into all three forms; plus regressions confirming the
  existing address-field markup and the "no innerHTML" discipline are
  unchanged.
- `tests/phase3c-schedule.test.js` — updated in place for two deliberate
  behavior changes: the Week default is now the Sunday-aligned current week
  (was a rolling 7-day window), and a bare `POST` to `bookings.js` now
  reaches the new expense-creation code (400 on a missing `resource`,
  rather than an unconditional 405) — both changes documented inline in the
  test file itself, all pre-existing assertions this didn't touch still
  pass unmodified.
- `tests/phase3a-admin-status-write.test.js` — its whole-admin-API
  write-audit list updated to include the one new, deliberate
  `api/admin/bookings.js: .insert(` call (the expense create), gated behind
  an explicit `resource:"expense"` discriminator that can never be reached
  by a booking-shaped request.

Interactive behavior not exercisable by this offline harness (this
project's established, previously-disclosed limitation — no DOM/click
simulation available) was verified directly in a local static-file browser
session with the fetch API mocked to return response shapes matching this
document's §3 contract exactly: Month grid rendering (weekday headers,
correct leading/trailing padding for September 2026, job-count badges,
today auto-selected), the selected-day panel (job cards reusing the shared
renderer, correct "+ Past Job" vs. "+ New Job" link per historical/future
date), Year grid (Prev disabled at 2026, tapping a month tile switches into
Month view for it), Week navigation (Prev/Next/"Jump to this week"), the
Quick Expense sheet (amount entry, Save, and a simulated backend failure
rendering a clean non-blocking error with the entered values preserved),
date-prefill (a valid `?date=` applied; an out-of-range one silently
ignored, falling back to today), and the address field's fallback (no
Google script requested, zero console errors, fully typable) with no
Google key configured — all at a 375px mobile viewport.

## 15. Mobile UX

Verified at 375px in the browser session above: the five range tabs are a
horizontally-scrollable single row of content-sized pills (never five
giant equal-width buttons); the Month grid's date cells are real ≥44px tap
targets; the selected date and today are each visually distinct (solid dark
fill vs. a green outline); Prev/Next controls are ≥44px; Year's month tiles
are easy to tap in a 2-column (3-column once there's room) grid; the
Quick Expense row is four compact icon buttons that never crowd the job
list above it; no horizontal page scrolling occurred anywhere in the
session.

## 16. Security / regression

- `requireAdmin()` still gates every mode/resource in `api/admin/
  bookings.js`, including both new expense endpoints — confirmed by
  dedicated 401 tests in both new API test files.
- No Supabase key of any kind reaches the browser — the Google Maps key is
  the only new client-visible credential, and it's designed to be public
  (see §12).
- Public `/api/book`, Requests, Clients, Client Typeahead, New Job/Past
  Job's creation contracts (except the additive, validated `?date=`
  prefill), Edit Job's `PATCH` contract, and status editing are all
  unaffected — confirmed by the full pre-existing suite passing unmodified
  (except the two deliberately-updated write-audit/week-behavior
  assertions documented in §14).
- Vercel function count: still exactly 12/12 (§7).
