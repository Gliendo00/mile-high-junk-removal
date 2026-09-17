# Phase 3C Stage 2.1 — `+ New Job` + Inline Create Client (Proposal)

Status: **proposal only. Not implemented.** Written for review/approval
before any code is written, per the Stage 2 decisions in
[stage2-decisions.md](./stage2-decisions.md). Does not depend on the
outcome of [stage2-preflight.md](./stage2-preflight.md) — see §9.

## 1. Scope

`+ New Job`: search/select an existing client or create one inline →
enter job info → save. Defaults to `status = "booked"`. This stage does
**not** touch `+ Past Job`, booking editing, `booking-status.js`, Month/
Year, money fields beyond `estimated_price`, or archive/delete. Per the
locked decision, it does **not** retire or modify `booking-status.js`.

## 2. Files that would change

**Backend (all under `site/`):**

| File | Change |
|---|---|
| `api/admin/booking.js` | Add a `POST` branch alongside the existing `GET`. Creates one `bookings` row for an already-identified client. Does not create/match clients itself. |
| `api/admin/client.js` | Add a `POST` branch alongside the existing `GET`. Creates one `customers` row, running the locked duplicate-check policy (§4). Used by both the inline New Job flow and (later, unchanged) a standalone `+ New Client` page. |
| `api/_lib/customer-identity.js` | **Unchanged.** `normalizePhone()`/`normalizeEmail()` reused exactly as-is. |

No file under `api/_lib/` needs a new export beyond what's already there;
no new file under `api/` at all.

**Frontend (static — does not count toward the Vercel function limit):**

| File | Change |
|---|---|
| `admin/booking/new/index.html` (new) | The New Job form page. Same chrome as every other admin page (topbar, nav tabs, `admin.css`). |
| `admin/booking-new.js` (new) | Form state, client-picker wiring, validation feedback, the `POST` calls. Mirrors `admin/booking-detail.js`'s fetch/toast/error-banner conventions. |
| `admin/client-picker.js` (new, shared) | A bottom-sheet component — search existing clients (reuses `GET /api/admin/clients?search=`) or create one inline (`POST /api/admin/client`), including the exact-match block/"Create anyway" UI. Built as a shared, reusable module (mirroring `admin/status-ui.js`'s `window.AdminStatusUI` shape, exposed as `window.AdminClientPicker`) because the requirements already name three callers for the identical picker — New Job now, Past Job and standalone `+ New Client` next stage — not spoken-for speculation. |
| `admin/schedule.js` / `admin/index.html` | Add a `+ New Job` button in the existing `.admin-list-heading` row (next to the `<h1>Schedule</h1>`), linking to `/admin/booking/new/`. |
| `admin/admin.css` | New styles for the New Job form fields (can mostly reuse the existing `.admin-field`/`.admin-btn-primary` classes already used by the login form) and the client-picker sheet (extends the existing `.admin-sheet-*` classes from `admin/status-ui.js`'s CSS, plus the existing client-search input styling noted in `admin.css` around the Clients list search box). |

`/admin/booking/new/` (rather than a new `/admin/job/` URL family) keeps
the URL consistent with the existing `booking.js`/`/admin/booking/` naming
— "Job" stays the product/UI word (button label, headings), "booking"
stays the underlying resource name, matching every existing file/route.
Flagging this as a naming call, not a hidden assumption, in case you'd
rather it read `/admin/job/new/`.

## 3. API contract

### `POST /api/admin/client` — create a client

Request:
```json
{
  "firstName": "string, required",
  "lastName": "string, optional",
  "phone": "string, optional",
  "email": "string, optional",
  "address": "string, optional",
  "city": "string, optional",
  "state": "string, optional",
  "zip": "string, optional",
  "confirmCreateAnyway": false
}
```

**Only `firstName` is required** (locked 2026-09-17, amending this
proposal's original "firstName + phone" draft — see
[stage2-decisions.md §3 amendment](./stage2-decisions.md#amendment-2026-09-17--phone-is-optional-for-an-admin-created-client)):
historical migration may include a legitimate client the owner no longer
has a working phone number for, and nothing should force a placeholder
value into `phone` to work around that. `lastName`/`phone`/`email`/profile
`address`/`city`/`state`/`zip` are all optional at creation time, unlike the
public `/book` flow's stricter requirements — an admin-created client can be
filled in later, and the *job's* own service address (always captured on
the booking itself) covers the immediately useful case regardless. Every
field gets the same bounded-length validation style already used in
`api/book.js`/`api/admin/clients.js` (`MAX.*`-style constants local to this
file); phone/email are validated for shape only when actually provided —
normalization (`normalizePhone()`/`normalizeEmail()`) likewise only ever
runs on a field that was submitted.

Server behavior:
1. `requireAdmin()`; reject non-`POST`/`GET` with 405.
2. Validate required fields; bounded lengths on everything.
3. `normalizePhone()`/`normalizeEmail()` the input (reusing
   `api/_lib/customer-identity.js`, unchanged).
4. Look up matches **separately** (not just the combined-AND lookup
   `api/book.js` already does, which can't distinguish "exact" from
   "partial"):
   - rows where `phone_normalized` matches (only if a phone was given),
   - rows where `email_normalized` matches (only if an email was given).
   - "Exact match" = a row present in both sets at once.
5. Apply the locked policy from
   [stage2-decisions.md §3](./stage2-decisions.md#3-admin-duplicate-client-behavior--locked):
   - **Exactly one exact match, and `confirmCreateAnyway` is not `true`**:
     respond `409` with `{ error: "duplicate_client", existingClient: {...} }`
     (id, name, phone, email, city, bookingCount) and create nothing. The
     UI shows this client and offers "Use this client" (no further call
     needed — the picker already has the id) or "Create anyway" (resubmit
     the same body with `confirmCreateAnyway: true`).
   - **Exactly one exact match, and `confirmCreateAnyway` is `true`**:
     proceed to create, deliberately allowing the duplicate.
   - **Phone-only or email-only matches (no exact match)**: proceed to
     create; response includes a non-blocking
     `warnings: [{ type: "phone_match" | "email_match", clients: [...] }]`
     array.
   - **Multiple/ambiguous matches**: never auto-merge or auto-select —
     surfaced the same way as phone-only/email-only, as warnings, never as
     a block.
5. Insert into `customers`, writing `phone_normalized`/`email_normalized`
   exactly as `api/book.js` already does.
6. Return `201` with the created client's id and fields.

### `POST /api/admin/booking` — create a job

Request:
```json
{
  "customerId": "<uuid>, required",
  "serviceType": "junk_removal | dumpster_rental | light_demo",
  "appointmentDate": "YYYY-MM-DD",
  "timeWindow": "<one of the existing time-window values>",
  "serviceAddress": { "address": "", "city": "", "state": "", "zip": "" },
  "description": "string, optional",
  "estimatedPrice": "number, optional",
  "internalNotes": "string, optional"
}
```

Server behavior:
1. `requireAdmin()`; reject non-`GET`/`POST` with 405.
2. Validate `customerId` is a well-formed UUID and belongs to a real
   `customers` row (a `SELECT` check first, so a bad id gets a clean `404
   "Client not found"` instead of a raw FK-violation error).
3. Validate `serviceType` against a local allowlist (the same three values
   `api/book.js` enforces — duplicated locally per this project's existing
   "small deliberate duplication over cross-importing from the public
   endpoint" convention, documented in `api/_lib/booking-format.js`).
4. Validate `appointmentDate` is a real ISO date **on or after today in
   America/Denver** (reusing `denverTodayIso()`, already duplicated into
   `api/admin/bookings.js`) — New Job is for a job being booked now or in
   the future; a date before today has no meaning for a `status="booked"`
   row and isn't what this endpoint is for (Past Job, next stage, is the
   one that accepts past dates).
5. Validate `timeWindow` against the existing allowlist in
   `api/_lib/time-windows.js` — **required** for New Job (unlike the
   future Past Job flow, there's no "unknown time" case here).
6. Validate `serviceAddress` fields present and bounded-length.
7. Validate `estimatedPrice`/`description`/`internalNotes` if present
   (bounded numeric range / bounded length).
8. Insert into `bookings` with **`status` hardcoded to `"booked"`
   server-side** — the request body is never allowed to set `status` at
   all (there's no `status` field in the accepted request shape above),
   so there's no path by which a crafted request could create a job in
   any other state.
9. Return `201` with the created booking's id and fields (same shape
   `GET api/admin/booking?id=` already returns, for the UI to redirect
   straight to the new booking's detail page).

## 4. Client duplicate-check behavior (summary)

Full policy in [stage2-decisions.md §3](./stage2-decisions.md#3-admin-duplicate-client-behavior--locked).
In short: exact phone+email match blocks and offers the existing client,
with "Create anyway" as an explicit override; phone-only/email-only warns
but never blocks; ambiguous matches never auto-merge. This is new code in
`api/admin/client.js` — the public `/api/book` endpoint's existing silent
single-match auto-reuse (Phase 3B Step 4a.3) is untouched.

## 5. New Job fields

Client (search-select-or-create-inline via the shared picker), service
address, service type, appointment date, appointment time/time window
(required), description/details, estimated price, private notes.

## 6. Default `status = "booked"` behavior

Enforced entirely server-side (§3 step 8) — never accepted as client
input, never optional, never derived from anything the request body sends.

## 7. Service-address snapshot behavior

`serviceAddress` is a required part of every New Job request and is
written directly to the booking's own `service_address`/`service_city`/
`service_state`/`service_zip` columns — never copied from or pointed at
the client's profile address, matching the snapshot behavior every
existing admin route (`booking.js`, `bookings.js`, `client.js`, the
Schedule view) already treats as primary. A convenience "same as client's
address on file" checkbox can prefill the form client-side from the
selected/just-created client's profile address, but the value that
actually gets submitted and stored is always this booking's own snapshot,
never a live reference to the customer row.

## 8. Function-count impact

**Zero new files under `api/`.** `booking.js` and `client.js` each gain a
method branch; the project stays at exactly 12/12. Confirmed no other
Stage 2.1 file lives under `api/` — everything else is static `admin/*`
HTML/JS, which the Vercel Hobby function limit doesn't count (only files
under `api/` that export a request handler do, per the finding in
[vercel-function-limit.md](./vercel-function-limit.md)).

## 9. Relationship to the schema preflight

Stage 2.1 does not depend on the pending
[stage2-preflight.md](./stage2-preflight.md) results. It only ever
requires a real `timeWindow` (no nullability question), and it writes
`estimatedPrice` to a column whose exact type is irrelevant to a plain
insert of a JS number — the same way every existing insert/read path
already handles `estimated_price`/`final_price` without knowing their
precise DB type. The preflight remains a prerequisite for Stage 2.2 (Past
Job, needs `time_window` nullability confirmed) and Stage 2.5 (money
fields, needs `tip_amount`'s type chosen to match).

## 10. Tests to add

New file `tests/phase3c-stage2-new-job.test.js`, following the existing
offline/stubbed-`supabase-js` pattern used by every `tests/*.test.js` file
— no real network call, no real Supabase project touched.

**`POST /api/admin/booking`:**
- Auth gate: no cookie / bad token / non-admin email → 401; `Cache-Control:
  no-store` present.
- Method allowlist: unsupported method → 405; existing `GET` behavior
  unchanged.
- Validation: missing/malformed `customerId` → 400; `customerId` for a
  nonexistent client → 404; invalid `serviceType` → 400; invalid/missing
  `timeWindow` → 400; `appointmentDate` before today (Denver) → 400;
  missing/incomplete `serviceAddress` → 400; oversized
  `description`/`internalNotes` → 400.
- **Security/integrity**: a request body that includes `"status":
  "completed"` (or any other value) still creates a row with
  `status === "booked"` — proves the hardcoded server-side default can't
  be overridden by a crafted request.
- Success path: valid request creates exactly one `bookings` row with the
  submitted `service_address`/`service_city`/`service_state`/`service_zip`
  snapshot, returns the expected shape.
- Write-audit test (the existing grep-based test extended): the write list
  gains exactly one new `.insert(` in `api/admin/booking.js`, nothing
  unexpected elsewhere.

**`POST /api/admin/client`:**
- Auth gate / method allowlist, same shape as above.
- Validation: missing `firstName`/`phone` → 400; bounded-length violations
  → 400.
- Exact match (phone + email both match one existing row): no insert
  occurs; response is `409` with `existingClient`.
- Exact match + `confirmCreateAnyway: true`: insert proceeds; two
  `customers` rows now share phone+email, by deliberate admin choice.
- Phone-only match: insert proceeds; response includes `warnings`.
- Email-only match: insert proceeds; response includes `warnings`.
- Multiple ambiguous matches: insert proceeds; never merges; `warnings`
  lists more than one candidate.
- No matches: plain create, no `warnings` key (or an empty array —
  whichever the implementation settles on, tested explicitly either way).
- `phone_normalized`/`email_normalized` written correctly on the created
  row, reusing the existing normalization functions unmodified.
- Write-audit test extended the same way as `booking.js`'s.

**Cross-cutting:**
- XSS/rendering-discipline grep guard extended to `admin/booking-new.js`
  and `admin/client-picker.js` (no `innerHTML`/`insertAdjacentHTML`/
  `document.write`, matching every other admin script).
- The existing Vercel-function-count regression test
  (`tests/phase3c-schedule.test.js`) re-run to confirm it still passes at
  12 — no new file under `api/` should ever make this test start failing
  for this stage.
- Full existing suite re-run to confirm zero regression (the current
  169/169 baseline).

## 11. Preview testing plan that avoids mutating production Supabase

1. **Primary verification stays offline**, exactly like every prior phase:
   the new test file above, stubbing `@supabase/supabase-js`, run locally
   with `node tests/phase3c-stage2-new-job.test.js` — no real network call.
2. **UI/layout verification** uses the local static-file preview
   (`site-static` in `.claude/launch.json`, the same setup Stage 1 used
   per its test-matrix) at a mobile viewport, checking console errors and
   layout. This preview has no backend, so `POST` calls will 404 there —
   useful for confirming the form renders and validates client-side, not
   for confirming the actual save.
3. **No real Vercel Preview click-through against the actual save/insert
   path.** Preview deployments on this project point at production
   Supabase (already flagged as a standing risk in the architecture
   audit's security section) — clicking "Save" on a Preview build would
   write a real row into the real `customers`/`bookings` tables. This
   proposal explicitly does not rely on that for verification.
4. If a real end-to-end database round-trip is wanted beyond the offline
   tests, the only acceptable way is a **genuinely separate, disposable
   Supabase project** (not production) with its own URL/service-role key
   supplied only to a local environment — never assumed to already exist,
   never production's credentials pointed somewhere "just for this test."
   This is optional and only worth setting up if you want that extra
   confidence; the offline suite plus static-preview UI check is
   sufficient to reach the same bar every prior phase shipped at.
5. Explicitly ruled out: creating a real test client/job in production and
   deleting it afterward. That's a production mutation regardless of
   cleanup, and isn't how any earlier phase verified a write path.
