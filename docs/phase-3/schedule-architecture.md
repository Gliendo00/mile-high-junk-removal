# Phase 3C Stage 1 — Schedule Homepage Architecture

Status: **implemented, locally tested, not yet deployed.** No commit has been
pushed and no deployment has happened. No database schema was changed — this
stage adds two read-only API routes and restructures existing static admin
pages; it introduces zero new write capability (see
[test-matrix.md](./test-matrix.md)'s write-audit test).

## What changed

- `/admin/` now serves the Schedule homepage. The former Requests dashboard
  moved to `/admin/requests/` (same `dashboard.js`, same
  `api/admin/bookings.js`, unchanged behavior — only its URL and page chrome
  changed).
- Primary nav is now three tabs — **Schedule / Requests / Clients** — present
  on every admin page except login, matching the existing convention that
  login has no nav.
- The Requests tab carries a small, restrained numeric badge (count of `new`
  bookings), hidden entirely when zero. No color/animation implies urgency —
  deliberately not styled as an alert.

## Which bookings appear on the Schedule

**No second operational-status field was introduced.** Per the Phase 3C
architecture audit, `bookings.status` already distinguishes the sales/lead
lifecycle (`new`, `contacted`, `quoted`) from a confirmed job (`booked`) and
its outcome (`completed`, `lost`). The Schedule includes exactly the
bookings whose `status` is `booked` or `completed`, filtered by
`appointment_date` within the requested range —
`new`/`contacted`/`quoted` bookings have no confirmed appointment yet, and
`lost` bookings fell through; neither belongs on an operational schedule.
This is implemented as a single `.in("status", ["booked","completed"])`
filter in `api/admin/schedule.js`, which naturally excludes NULL-status
("new") rows without a separate null-check, since PostgREST's `.in()` never
matches `NULL`.

## Range handling

`GET /api/admin/schedule?range=today|tomorrow|week` (default, and fallback
for any unrecognized value: `today`).

- **Today / Tomorrow**: a single calendar day, computed in **America/Denver**
  time (not the server process's own UTC clock) — mirrors `api/book.js`'s
  existing `getDenverNow()`/`denverTodayIso()` logic via a small, deliberate,
  self-contained copy in `api/admin/schedule.js`, consistent with this
  project's established convention (see `api/_lib/booking-format.js`) of
  keeping admin code from reaching into the live public booking endpoint.
- **Week**: a rolling 7-day window starting today (today + the next 6 days),
  **not** a Sunday–Saturday calendar week. This is a judgment call, flagged
  here for review rather than dictated by any existing requirement or code —
  it matches "Today"/"Tomorrow" being relative-to-now views and this being an
  operational "what's coming up" list rather than a reporting view.

## Chronological ordering

Jobs sort by `appointment_date`, then by each job's `time_window` start hour
within that date. The start-hour metadata comes from a **new shared module**,
[api/_lib/time-windows.js](../../api/_lib/time-windows.js), rather than a
third duplicated windows-to-hour map. `api/_lib/booking-format.js`'s own
previously-hardcoded `TIME_WINDOW_LABELS` copy was refactored to derive from
this same shared module (label values unchanged — verified byte-identical by
the existing `tests/phase2-admin-api.test.js` label assertions, which pass
unmodified). `api/book.js`'s own local `TIME_WINDOW_DEFS` was deliberately
**left untouched** — it is the live, customer-facing booking endpoint, has
its own validation logic built around that local copy
(`isTimeWindowExpired`, `TIME_WINDOWS_BY_SERVICE`), and touching it is a
materially different risk than adding a new admin-only module; the new
shared file's header documents this explicitly. This means two independent
copies of the window-to-hour data still exist project-wide (`api/book.js`'s
live copy, and the new shared admin one) rather than one — a smaller number
than the three it would otherwise become to reach today's requirement,
flagged as a known, deliberate limitation for review rather than a full
collapse into a single source of truth.

An unrecognized `time_window` value sorts after every recognized window on
the same date rather than throwing or being silently dropped — a job must
never disappear from the Schedule because of an unexpected value.

## Requests badge

`GET /api/admin/new-count` returns only `{ ok: true, new: <int> }` via a
single count-only query (`status IS NULL`, matching `api/admin/bookings.js`'s
own "new" definition exactly) — no booking or customer rows. It exists as
its own endpoint specifically because the badge loads on every admin page,
not just Requests, and pulling a full page of booking data just to render
one integer would be wasteful. `admin/nav-badge.js` (a new shared script,
loaded the same way `admin/status-ui.js` already is) fetches this on every
page load and shows/hides the badge — failing safe to "hidden" on any error
or non-200 response rather than showing a stale count or redirecting the
page; the page's own primary data fetch already owns the "session expired →
redirect to login" behavior.

## Security posture (unchanged from Phase 2/3A/3B)

Both new endpoints (`api/admin/schedule.js`, `api/admin/new-count.js`) follow
the exact pattern already established and tested for every other
`/api/admin/*` route:

- `requireAdmin(req, res)` first, before any data access; `Cache-Control:
  no-store` on every response (set inside `requireAdmin` itself).
- Service-role Supabase client (`api/_lib/supabase-admin.js`) used only after
  `requireAdmin()` succeeds; never reachable from the browser.
- Both are pure `SELECT`s — no `.insert(`/`.update(`/`.upsert(`/`.delete(`
  call anywhere in either file, confirmed by extending the existing
  write-audit test (see [test-matrix.md](./test-matrix.md)) rather than
  merely asserting it by description.
- No new IDOR surface: neither endpoint takes a resource id at all — the
  Schedule endpoint is scoped entirely by the authenticated session plus a
  `range` value with a hardcoded allowlist (`today`/`tomorrow`/`week`,
  anything else silently falls back to `today`), never by anything that
  identifies a specific booking or customer.
- All new/changed client-side rendering (`admin/schedule.js`,
  `admin/nav-badge.js`) uses `textContent`/DOM construction exclusively —
  including its SVG icons, built via `createElementNS` rather than
  `innerHTML`, matching `admin/dashboard.js`'s existing `cameraIcon()`
  pattern — never `innerHTML`/`insertAdjacentHTML`/`document.write`.

One deliberate, documented difference from `api/admin/bookings.js`: the
Schedule endpoint's response includes each customer's **phone number**,
which the Requests list endpoint does not. This is intentional — the
Schedule's Call/Text actions are a stated requirement (jobs are run from a
phone, and the actions must work directly from the card) — and is not a new
exposure category: the same authenticated admin session is already shown
this exact phone number on the booking detail page and the client profile.
`requireAdmin()` remains the only gate either way.

## Explicitly out of scope for this stage

Per the Stage 1 instructions: no route map / "View Route", no payment/tip/
payment-status editing, no Create Job/Create Client, no archive/delete, and
no database schema change. The FK cascade finding recorded in
[database-schema-updates.md](./database-schema-updates.md) exists purely to
inform *future* archive/delete design and changes nothing about what this
stage implements.
