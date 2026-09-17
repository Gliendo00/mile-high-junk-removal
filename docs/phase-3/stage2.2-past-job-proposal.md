# Phase 3C Stage 2.2 — `+ Past Job` (Rapid Historical Entry)

Status: **implemented, 2026-09-17, on feature branch
`phase-3c/stage2.2-past-job`, from production baseline `25dc57e`. Not merged
to `main`, not deployed.** Built per the owner's Stage 2.2 instructions
(chat-provided, not a prior architecture doc) and the locked patterns from
[stage2-decisions.md](./stage2-decisions.md) /
[stage2.1-new-job-proposal.md](./stage2.1-new-job-proposal.md).

## 1. Scope

`+ Past Job`: fast, repetitive entry of a historical job that does **not**
already exist in the CRM — the owner is manually backfilling business
records starting January 1, 2026. Reuses the Stage 2.1 client picker and
inline Create Client unchanged. Does **not** touch Month/Year, payment
schema (`tip_amount`/`payment_method`/`payment_status`), revenue/expense
reporting, archive/delete, route map, or SMS.

## 2. Files changed

**Backend:**

| File | Change |
|---|---|
| `api/admin/booking.js` | `POST` handler (`handleCreate`) now branches on an explicit, allowlisted `mode` (`"new"` default, or `"past"`), enforcing a different date range, time-window requirement, status, and price field per mode. Exactly one `.insert(` call still exists in this file — both modes share it. |
| `api/_lib/historical-floor.js` (new) | Exports the single `HISTORICAL_FLOOR_ISO = "2026-01-01"` constant Past Job's date validation uses, so a future Month/Year stage can reuse the identical boundary. Pure constant, no I/O — lives under `api/_lib/`, so it does not count toward the Vercel function limit. |
| `api/admin/client.js` | **Unchanged.** Past Job reuses Create Client exactly as Stage 2.1 built it. |

**Frontend (static):**

| File | Change |
|---|---|
| `admin/booking-past/index.html` (new) | The Past Job form page — compact single-column layout, same chrome as every other admin page. |
| `admin/booking-past.js` (new) | Form state, client-picker wiring (reuses `window.AdminClientPicker` unchanged), historical date min/max, `POST` call with `mode:"past"`, and the post-save "View Job" / "Add Another Past Job" panel. |
| `admin/index.html` | Schedule's `.admin-list-heading` now wraps two actions — `+ Past Job` (outline/secondary) and `+ New Job` (primary, unchanged) — in a `.admin-list-heading-actions` flex row instead of a single anchor. |
| `admin/admin.css` | `.admin-list-heading-actions` updated to a flex row (`gap:8px`) for the two buttons; new `.admin-success-title`/`.admin-success-meta` styles for the post-save confirmation panel. |

No new file under `api/`. Function count stays exactly **12/12** (confirmed
by the existing regression test in `tests/phase3c-schedule.test.js`).

## 3. API contract — `POST /api/admin/booking`

Extends the existing Stage 2.1 contract with one new field, `mode`:

```json
{
  "mode": "past",
  "customerId": "<uuid>, required",
  "serviceType": "junk_removal | dumpster_rental | light_demo",
  "appointmentDate": "YYYY-MM-DD, required — 2026-01-01 through today (America/Denver)",
  "timeWindow": "<one of the existing time-window values>, optional — omit or \"\" for unknown",
  "serviceAddress": { "address": "", "city": "", "state": "", "zip": "" },
  "description": "string, optional",
  "finalPrice": "number, optional — the actual job amount",
  "internalNotes": "string, optional"
}
```

- `mode` is read once, validated against the explicit allowlist `["new",
  "past"]`, and never inferred from any other field. Omitting it entirely
  preserves exact Stage 2.1 New Job behavior — no existing caller needs to
  change.
- **Date bounds (server-enforced, not just client-side):** `appointmentDate
  < HISTORICAL_FLOOR_ISO` ("2026-01-01") → `400`. `appointmentDate >
  denverTodayIso()` → `400`. Both computed in America/Denver, matching
  every other date check in this codebase (`denverTodayIso()`).
- **Time window:** validated against the existing allowlist only when a
  non-empty value is submitted; an empty/omitted value writes a real SQL
  `NULL` to `time_window` (confirmed nullable at the database level per
  [stage2-preflight.md](./stage2-preflight.md)) — never an invented
  placeholder. New Job's requirement that a valid window always be present
  is unchanged.
- **Status:** hardcoded to `"completed"` for `mode:"past"`, exactly as New
  Job hardcodes `"booked"` for the default mode — `status` is never read
  from the request body in either mode, so no value the caller sends
  (including an explicit `"status"` field) can change it.
- **Price:** `finalPrice` (optional, same bounded-numeric validation as New
  Job's `estimatedPrice`) is written to `bookings.final_price`.
  `estimatedPrice` is never read at all when `mode:"past"` — it cannot leak
  into `estimated_price`, which stays `NULL` for every Past Job row.
  Symmetrically, `finalPrice` is never read for `mode:"new"` (or omitted
  mode) — `final_price` stays `NULL` for every New Job row, same as before
  this stage.
- Client lookup/validation, service-address validation, and the response
  shape are otherwise identical between modes (the response now also
  includes `finalPrice`, matching `GET`'s existing shape).

## 4. Client behavior

Unchanged from Stage 2.1: same shared `window.AdminClientPicker`, same
`POST /api/admin/client` duplicate-check policy (exact phone+email match
blocks with "Create anyway"; phone-only/email-only warns; never
auto-merges). Historical clients with no phone/email/address are fully
supported since only `firstName` is required — no code change was needed
here.

## 5. Service address

Every Past Job writes its own frozen `service_address`/`service_city`/
`service_state`/`service_zip` snapshot, identical mechanism to New Job —
never derived from the client's profile address, then or later. State
input is prefilled `"CO"` client-side only (editable); server-side
validation is unchanged and shared between modes.

## 6. Rapid-entry UX

Field order: Client → Job Date + Service Type → Service Address → Actual
Job Amount + Time (optional) → Description → Private Notes → Save Past Job.
Description/Private Notes are 2-row textareas (resizable), matching New
Job's compact style. After a successful save, the form is replaced with a
confirmation panel offering **View Job** (redirects to the booking detail
page) and **Add Another Past Job** (a plain navigation back to
`/admin/booking-past/`, which discards all in-memory form state — the
previous client's identity, address, amount, and notes are never carried
forward into the next entry).

## 7. Test coverage

New file `tests/phase3c-stage2.2-past-job.test.js` (32 tests, offline/
stubbed Supabase, same harness pattern as every prior phase). Covers: auth
gate, mode allowlist validation, the historical floor/ceiling (`2026-01-01`
accepted, `2025-12-31` rejected, today accepted, tomorrow rejected),
Denver-local date handling, `completed` status enforcement (including an
attempted `"status":"booked"` override), `NULL`/omitted/empty/valid/invalid
time-window handling, `finalPrice` → `final_price` (and confirmation that
`estimatedPrice` never leaks into `estimated_price` under `mode:"past"`),
client/address validation reuse, an arbitrary-fields-ignored write-audit
check, a New-Job-regression pair (still `booked`, still requires a time
window), an end-to-end POST→GET round trip, a static check that
`api/book.js` is untouched, and the existing XSS/rendering-discipline and
function-count-style guards extended to the new files.

One pre-existing Stage 2.1 test assertion was updated (not weakened): `POST
booking: extra unexpected fields in the body are ignored` in
`tests/phase3c-stage2-new-job.test.js` previously asserted
`row.final_price === undefined`. Because `final_price` is now a real column
on every insert from this endpoint (an intentional, shared-code
consequence of adding Past Job to the same handler), the correct assertion
is `row.final_price === null` for a New Job request — the security
guarantee it was checking (an attacker-supplied `"final_price"` in the body
can never reach the row) is unchanged and still verified.

Full regression: **250/250 passing** (218 pre-existing + 32 new), function
count still exactly 12/12.

## 8. Preview verification (non-mutating)

Verified via the local static-file preview only (`site-static`, same
`.claude/launch.json` config used since Stage 1) — this preview has no
backend, so every `fetch` 404s harmlessly; the load-time auth-gate fetch
was forced past via a debug script purely to render the form for a visual
check (the same limitation and workaround Stage 2.1's own Preview report
already documented). No real Vercel Preview deployment was created or
clicked through for this stage, and no write of any kind was attempted
against production Supabase.

Confirmed: `+ Past Job` / `+ New Job` button placement and mobile (375px)
layout on the Schedule page; the Past Job form's field order, compact
2-row textareas, CO-prefilled state, and "Time unknown / optional"
placeholder; the shared client-picker sheet and inline Create Client form
render correctly when opened from the Past Job page; no unexpected
JavaScript console errors (only the expected 404s from the missing
backend).
