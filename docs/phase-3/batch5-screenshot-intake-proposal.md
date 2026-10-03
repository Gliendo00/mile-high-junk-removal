# Phase 3C Batch 5 — Screenshot AI Intake (Proposal)

Status: **5A/5B/5C implemented and tested locally, plus a hardening pass
(mock vision provider, screenshot retention/cleanup, upload-ordering
concurrency safety). Nothing pushed, nothing deployed, no SQL executed
against any real Supabase, no credential added.** Stopping here for review
per Rocky's instruction — see §13 for the exact rollout steps still needed
before any of this is live. Following the same proposal-first pattern as
[stage2.1-new-job-proposal.md](./stage2.1-new-job-proposal.md) and
[stage2.4-calendar-address-proposal.md](./stage2.4-calendar-address-proposal.md).

Batch 5 is explicitly prioritized **above** the UI redesign work.

**Progress:**
- **5A — done.** `api/admin/booking-status.js` retired into
  `api/admin/booking.js`'s `?resource=status` branch. Full test suite green.
- **Vision provider adapter — done.** `api/_lib/intake-vision-provider.js`
  implements OpenAI as the first concrete backend (§6), fully swappable.
  `OPENAI_API_KEY` is **documented, not set** —
  `extractFromScreenshots()` fails safely and generically until it is. 17
  tests in `tests/phase3c-batch5-intake-vision-provider.test.js`.
- **5B/5C — done.** `sql/2026-10-04_phase3c-batch5-intake-sessions.sql`
  drafted (§4.1, not executed). `api/admin/intake.js` implements the full
  session lifecycle — upload, extract, list, detail, field/classification/
  client-match/existing-job-link edits, screenshot removal, discard — using
  the real adapter end-to-end in tests (fetch mocked, never the adapter
  module itself). 44 tests in
  `tests/phase3c-batch5-intake-endpoint.test.js`, including a dedicated
  static guard proving this file never writes to `customers` or `bookings`.
  Function count is back to **12/12** (the slot 5A freed, now spent on
  `api/admin/intake.js`).
- **Review UI — done.** Three new admin pages
  (`admin/intakes/`, `admin/intake-new/`, `admin/intake/`), a Pending
  Intake nav tab + badge added to every existing admin page, and 31 static-
  analysis UI tests in `tests/phase3c-batch5-intake-ui.test.js` (including
  regression guards that the UI's field/classification/confidence lists
  never drift from the adapter's own exported constants, and that no
  Confirm/create-booking/create-client action exists anywhere client-side
  yet).
- **Hardening pass — done.** Three small changes requested before Preview
  rollout:
  1. A deterministic **mock vision provider** (`INTAKE_VISION_PROVIDER=mock`,
     default stays `openai`) so the full upload → extract → pending_review →
     review/edit → discard flow can be exercised in Preview with no
     `OPENAI_API_KEY` and no manual SQL. Refuses outright when
     `VERCEL_ENV=production`; the `openai` provider has no code path that
     can reach it on its own failure (§6).
  2. **Screenshot retention**: discarded = immediate (unchanged); pending/
     processing/extraction_failed = 7 days; confirmed = 30 days
     (Stage 5D not built, so unreachable today); structured
     `extracted_data`/`ai_raw_extraction`/classification always survive
     screenshot cleanup. Swept by a new `?action=cleanup-expired` action on
     the *existing* `api/admin/intake.js` file via Vercel Cron — zero new
     functions. Needs a second new env var, `CRON_SECRET`, also not yet
     added (see `docs/phase-3/batch5-storage-design.md`).
  3. **`UNIQUE(intake_session_id, sort_order)`** added to
     `intake_screenshots`, plus a one-retry self-heal in
     `insertScreenshotWithRetry()` on the 23505 it can now raise — chosen
     over redesigning the ordering scheme entirely (see
     `sql/2026-10-04_phase3c-batch5-intake-sessions.sql` §2 for the full
     reasoning).

  25 new tests across the three affected suites (vision provider, intake
  endpoint, UI) — 1,196 total assertions, still 12/12 functions.
- **Not built: Stage 5D (confirm).** No code path anywhere — server or
  client — creates or updates a `customers` or `bookings` row from an
  intake. That is the explicit boundary of this stop-for-review point.

## 1. Goal

Let the owner upload one or more screenshots of a client conversation (SMS,
Facebook Messenger, Instagram DM, etc.), have the CRM extract the useful
information, detect whether the person is already a client, classify what
kind of interaction it is, and build a **Pending Intake** record for the
owner to review/correct/confirm — never auto-creating a live client, lead,
or booking from a screenshot without that confirmation step.

## 2. Decisions locked (owner input, 2026-10-02)

1. **AI/vision provider: OpenAI, as the first concrete backend.** Image
   input directly to a vision-capable chat model — no separate OCR
   dependency. Strict structured JSON output (`response_format:
   json_schema`, `strict: true`) so the model's output always matches the
   intake schema exactly, never free text to be re-parsed. Kept entirely
   behind a single swappable adapter (§6) — `api/_lib/intake-vision-
   provider.js` is the **only** file that knows OpenAI exists; nothing about
   the intake workflow, database schema, client matching, or review UI
   depends on which provider answers the call. Benchmarking Claude or Gemini
   later is a new branch in that one file's internal provider map plus an
   env var change, not a redesign.
2. **Client matching, duplicate detection, and booking decisions stay
   deterministic application code, never the model's call.** The adapter's
   only job is extraction + classification; every decision described in §5
   (which customer to attach to, whether to create a booking, which existing
   booking to link) runs in `api/admin/intake.js` after the model responds,
   using the project's existing phone/email-normalization and duplicate
   rules — never something the model is asked to decide or is trusted to
   have decided correctly.
3. **No credential added yet.** `OPENAI_API_KEY` is implemented against and
   documented (§6), but not set in any environment. Explicitly stopping here
   for approval before that credential is added, same as every other
   production-infrastructure change this project requires sign-off for.
4. **Function budget:** retire `api/admin/booking-status.js` into
   `api/admin/booking.js`'s `PATCH` now, as its own small reviewed change,
   to free one Vercel function slot for a new dedicated `api/admin/intake.js`
   (§3). This was already pre-approved in principle in
   [stage2-decisions.md §2](./stage2-decisions.md), deferred until a stage
   actually needed the slot — this is that stage. **Done (5A).**

## 3. Function budget

Current state: exactly 12/12 functions (confirmed by
`tests/phase3c-schedule.test.js`'s function-count guard — see
[vercel-function-limit.md](./vercel-function-limit.md)).

| Step | File | Change |
|---|---|---|
| 1 | `api/admin/booking-status.js` | **Deleted.** |
| 2 | `api/admin/booking.js` | Gains a `PATCH` branch for `action: "status"` that does exactly what `booking-status.js` did: same `ALLOWED_STATUSES` allowlist, same `rental_out`/`service_type` guard, same "read `id`/`status` as primitives, never spread the body" discipline, same 404-on-malformed-id behavior. `admin/booking-detail.js` and any other caller update their endpoint path from `/api/admin/booking-status` to `/api/admin/booking?action=status` (or equivalent), nothing else about the request/response contract changes. |
| 3 | `api/admin/intake.js` | **New file.** Function count: still 12/12. |

This is a pure move, not a redesign — tests for the old endpoint's behavior
move to cover the same behavior at its new location.

## 4. New resource: Intake

### 4.1 Data model (draft SQL — not executed; for review only)

Two new tables. Extracted data is kept as structured JSON rather than wide
columns, because the extraction schema is new, will probably be tuned after
real-world use, and the fields are heterogeneous (some are plain values,
every one of them also carries a confidence state and which screenshot(s) it
came from) — a wide table of `field_x`, `field_x_confidence`,
`field_x_source` columns for a dozen fields is exactly the kind of premature
rigid schema this project's own [database-schema-updates.md](./database-schema-updates.md)
has been careful to avoid elsewhere. A few real columns exist only where the
app needs to filter/sort by them cheaply (status, classification, matched
customer, normalized phone for the match itself).

```sql
-- Draft only. Not executed. For Rocky's review alongside this proposal.

CREATE TABLE intake_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,              -- admin email, from requireAdmin()
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'pending_review', 'confirmed', 'discarded', 'extraction_failed')),

  -- Normalized output of the vision adapter (see §6) — the ONLY place its
  -- shape is defined. Never queried into with SQL JSON operators from
  -- outside api/_lib/intake-extraction.js; application code always reads
  -- it back through that module's accessors so the stored shape can change
  -- without a migration.
  extracted_data jsonb,
  extraction_error text,                  -- set only when status = 'extraction_failed'
  classification text
    CHECK (classification IN ('lead_only', 'quote_discussion', 'booking_confirmed', 'follow_up', 'existing_job_update', 'unclear')),

  -- Client match, computed once at extraction time, re-checked at confirm
  -- time in case something changed in between.
  match_status text
    CHECK (match_status IN ('existing_exact', 'new_candidate', 'needs_confirmation')),
  matched_customer_id uuid REFERENCES customers(id),
  extracted_phone_normalized text,        -- for the match query; mirrors customer-identity.js normalization

  -- Set only on confirm (§5.5) — the real records this intake produced.
  confirmed_at timestamptz,
  confirmed_by text,
  resulting_customer_id uuid REFERENCES customers(id),
  resulting_booking_id uuid REFERENCES bookings(id),

  -- Set only when classification = 'existing_job_update' and the owner
  -- links it to an existing upcoming booking instead of creating a new one.
  linked_existing_booking_id uuid REFERENCES bookings(id)
);

CREATE TABLE intake_screenshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_session_id uuid NOT NULL REFERENCES intake_sessions(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  sort_order int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_intake_sessions_status ON intake_sessions(status);
CREATE INDEX idx_intake_screenshots_session ON intake_screenshots(intake_session_id);
```

`ON DELETE CASCADE` on `intake_screenshots.intake_session_id` mirrors the
confirmed FK behavior already documented for `booking_photos`/`bookings` in
[database-schema-updates.md](./database-schema-updates.md) — deleting a
session's row cleans up its screenshot rows, but (same caveat as that doc)
never reaches into Storage by itself. A discard action must explicitly
`storage.remove([...])` each screenshot's path, same pattern as
`upload-photo.js`'s `safeDeleteStorageObject()`.

**Not run until Rocky approves and executes it**, same as every prior
migration in this project (`sql/` directory, owner-executed in production
Supabase).

### 4.2 Storage

New private bucket `intake-screenshots`, same posture as the existing
`booking-photos` bucket: service-role write only, signed URLs
(`createSignedUrl`, short TTL) for the review UI's thumbnails — exact pattern
already used in `api/admin/booking.js` for job photos. Creating the bucket
itself is a Supabase action, done by Rocky (or by me with explicit
go-ahead) — not something that happens silently as a side effect of writing
code.

Upload mechanics reuse `upload-photo.js`'s approach: raw
`application/octet-stream` body, magic-byte verification against the
declared type, per-file size cap (propose keeping the existing 4 MB cap —
screenshots compress well, and this stays under Vercel's 4.5 MB hard
request-body ceiling with no multipart parsing needed, matching this
project's one-file-per-request convention). One HTTP call per screenshot,
same as today's booking-photo upload flow.

## 5. `api/admin/intake.js` — endpoint contract

All actions behind `requireAdmin()` first, exactly like every other
`/api/admin/*` route. No public/unauthenticated path exists or is proposed —
this is an owner-only tool.

| Method | Query/body | Does |
|---|---|---|
| `POST` | `?action=create-session` | Creates an `intake_sessions` row (`status: processing`), no screenshots yet. Returns `sessionId`. |
| `POST` | `?action=upload-screenshot`, body = raw image bytes + `X-Intake-Session-Id` header | Stores one screenshot against a session (same raw-buffer pattern as `upload-photo.js`). Does **not** trigger extraction by itself — the client calls `extract` once it's done adding screenshots, so multi-screenshot sessions cost one extraction call, not one per image. |
| `POST` | `?action=extract`, body `{ sessionId }` | Loads every screenshot for the session, calls the vision adapter (§6) once with all of them, normalizes the result into `extracted_data`/`classification`, runs the client-match query (§5.3), sets `status: pending_review` (or `extraction_failed` with `extraction_error` set, never a 500 that loses the uploaded images). |
| `GET` | `?action=list` (default) | Pending Intake queue: sessions with `status = pending_review`, newest first. Also supports `?countsOnly=1` returning just the count, same folding trick as `bookings.js`'s Requests badge — so the nav badge for Pending Intake needs no new function either. |
| `GET` | `?action=detail&id=...` | Full session: extracted fields (each with its confidence state), classification, match info, signed screenshot URLs, and — when `classification = 'existing_job_update'` — the matched customer's upcoming bookings as link candidates. |
| `PATCH` | `?action=update`, body `{ id, fields: {...} }` | Owner corrections to extracted fields before confirming. Only ever merges into `extracted_data`'s field-level values — never touches `status`/`classification`/match fields directly (those have their own explicit actions below, so a stray `fields` body can't accidentally flip session state). |
| `PATCH` | `?action=reclassify`, body `{ id, classification }` | Owner overrides the AI's classification pick, from the same fixed enum — covers the "model said `unclear`, I know it's actually a quote" case without a free-text field. |
| `PATCH` | `?action=remove-screenshot`, body `{ id, screenshotId }` | Removes one screenshot from a still-pending session (storage + row), per the brief's requirement. Refuses once the session isn't `pending_review` anymore. |
| `PATCH` | `?action=discard`, body `{ id }` | Marks `discarded`, deletes its screenshots from Storage. Nothing else is touched — no customer/booking ever existed for a discarded session. |
| `POST` | `?action=confirm`, body `{ id, customerChoice, bookingFields?, linkBookingId? }` | The only action that ever creates/updates a real `customers`/`bookings` row. See §5.5. |

**As actually implemented**, two actions also exist beyond this original
table (`?action=set-client-match` and `?action=link-existing-booking`, both
PATCH — see §5.3/§5.4's own implementation notes below), and `confirm` does
**not** exist — that row describes Stage 5D's eventual contract, not
anything built in this commit set.

**Hardening pass addendum:**

| Method | Query/body | Does |
|---|---|---|
| `GET`/`POST` | `?action=cleanup-expired` | **Not gated by `requireAdmin()`** — authenticated by a `CRON_SECRET` bearer token instead, since the caller is a Vercel Cron job with no admin session. Deletes screenshots (Storage + rows) for sessions past the retention window (§14/`batch5-storage-design.md`), marks `screenshots_expired_at`, never touches `extracted_data`/classification/match state, never touches a `discarded` or already-expired session. 401s unconditionally until `CRON_SECRET` is set. |

This stays a single-purpose file for one resource (Intake) — not a dumping
ground for unrelated admin actions, consistent with
[stage2-decisions.md §1](./stage2-decisions.md)'s "never by building one
giant generic do-everything endpoint" rule. It's "dedicated-but-multi-action"
the same way `api/admin/booking.js` and `api/admin/bookings.js` already are.

### 5.3 Client matching (reuses existing rules, doesn't reinvent them)

Runs at extraction time (so the review screen can show it immediately) and
is re-verified at confirm time (cheap, and covers the case where another
admin action changed something in between):

1. If the extraction has a phone number, normalize it with the **existing**
   `api/_lib/customer-identity.js` `normalizePhone()` — not a new/parallel
   normalization function.
2. Query `customers` by `phone_normalized`.
   - Exactly one match → `match_status: existing_exact`, `matched_customer_id`
     set. Review screen shows "Existing Client Found" with name/phone/email
     and a cheap job-count (`count(*)` on `bookings` for that `customer_id`),
     matching the brief.
   - Zero matches → `match_status: new_candidate`.
   - More than one match (shouldn't normally happen given phone is meant to
     be unique-ish, but the schema doesn't enforce it) → `match_status:
     needs_confirmation`. Never guessed.
3. No phone extracted (or ambiguous) → `needs_confirmation`, same as the
   brief's "Needs Client Confirmation" case. The admin picks an existing
   client (via the same client-picker component `admin/client-picker.js`
   already provides for other flows) or proceeds as new.

This is **read-only lookup logic** shared conceptually with
`api/admin/client.js`'s duplicate-check, but Batch 5 doesn't modify
`client.js`'s create-path matching rules (exact phone+email blocks, etc.) —
that policy is about *preventing duplicate creation*, and only actually
triggers at confirm time (§5.5), not here.

### 5.4 `existing_job_update` handling

When classification is `existing_job_update`, extraction also looks up the
matched customer's upcoming (`booked`/`rental_out`, `appointment_date >=
today`) bookings and returns them as link candidates. The review screen
shows them; the owner either:

- **Links** the intake to one of them (`linkBookingId` at confirm) — no new
  booking is created; the intake record is just an annotated pointer the
  owner can use as a prompt to go edit that booking's real date/time/notes
  through the existing booking-edit flow, **or**
- Decides it's actually unrelated and proceeds as a new lead/booking instead.

v1 deliberately does **not** auto-apply the suggested change (e.g. new time)
to the existing booking — confirming an intake never silently mutates a
booking that already has its own edit flow and its own review surface. This
matches the brief's "no auto-created bookings without confirmation" rule
extended to "no auto-*edited* bookings" either, which the brief didn't say
explicitly but follows from the same reasoning Rocky already locked for Past
Job duplicates in [stage2-decisions.md §4](./stage2-decisions.md).

### 5.5 Confirm (`action=confirm`) — the only mutating step

1. Re-verify the match (§5.3) hasn't gone stale.
2. Resolve the customer:
   - `existing_exact` (and the owner didn't override it) → use
     `matched_customer_id` as-is. No customer write at all.
   - `new_candidate`, or owner picked "create new" on a `needs_confirmation`
     case → create the customer. This calls the **same** duplicate-check +
     create logic `api/admin/client.js`'s `POST` already runs (exact
     phone+email block / partial warn / never-auto-merge, per
     [stage2-decisions.md §3](./stage2-decisions.md)) — refactored into a
     small shared `api/_lib/customer-write.js` helper that both
     `client.js` and `intake.js` call, rather than copy-pasted. One
     source of truth for the locked duplicate policy, same reasoning as
     `customer-identity.js` already being shared.
   - `needs_confirmation` with the owner picking an existing client from the
     picker → use that `customer_id` directly.
3. If classification implies a real job (`booking_confirmed`, or
   `quote_discussion`/`lead_only` where the owner chooses to create a job
   record anyway) and no `linkBookingId` was given, create the booking.
   This calls the **same** job-creation logic `api/admin/booking.js`'s
   `POST` already runs — same refactor principle, a shared
   `api/_lib/booking-write.js` helper. Time/date confidence state carries
   over: anything the owner hadn't confirmed/corrected in review is
   required to be resolved (not silently defaulted) before `confirm` will
   accept the request — the API rejects a confirm whose scheduling fields
   are still `missing`/`uncertain` for a classification that claims a
   booking, forcing the review step to actually happen rather than being
   skippable.
4. If `linkBookingId` was given, no new booking — just records the link.
5. If classification is `lead_only`/`quote_discussion`/`follow_up` and the
   owner doesn't want a job row yet, confirm only creates/attaches the
   customer — no booking. (A lead that's just "how much to remove a couch"
   doesn't need a `bookings` row with no date; that's what the intake
   record itself is for until it becomes more.)
6. Mark the session `confirmed`, store `resulting_customer_id`/
   `resulting_booking_id`.

Every one of these writes happens inside the one `confirm` call, after
`requireAdmin()`, using the service-role client — same security posture as
every other admin write today.

## 6. Vision provider adapter (the swappable boundary) — implemented

Single file, **`api/_lib/intake-vision-provider.js`** (implemented, tested —
`tests/phase3c-batch5-intake-vision-provider.test.js`, 17/17 passing),
exporting one function:

```js
// extractFromScreenshots({ images: [{ base64, mimeType }], hintContext? })
//   -> Promise<{
//        fields: { [fieldName]: { value: string|null, confidence: 'confirmed'|'likely'|'uncertain'|'missing', sourceIndex: number|null } },
//        classification: one of the six enum values,
//        classificationConfidence: 'confirmed'|'likely'|'uncertain',
//        conflicts: [ { field, values: [{ value, sourceIndex }] } ]  // e.g. the Wed-then-Thu example
//      }>
async function extractFromScreenshots({ images, hintContext }) { ... }
module.exports = { extractFromScreenshots, CLASSIFICATIONS, FIELD_CONFIDENCES, CLASSIFICATION_CONFIDENCES, FIELD_KEYS };
```

This is the **only** module that:
- knows which provider/model is configured (`INTAKE_VISION_PROVIDER`,
  default `"openai"`, plus that provider's own API-key env var),
- knows that provider's HTTP shape and prompt format — `callOpenAi()` builds
  a plain `fetch()` call (no SDK dependency added, matching this project's
  existing convention for Resend/Google Places/Instagram — see
  `api/reviews.js`) to `POST https://api.openai.com/v1/chat/completions`
  with the screenshots as `image_url` data-URI parts and `response_format:
  { type: "json_schema", strict: true, schema: ... }`,
- is the only place a provider-specific error can occur — every failure
  (missing key, network error, non-2xx response, malformed model output) is
  caught and re-thrown as one generic `Error`, logged in full server-side
  only (`console.error`), exactly this codebase's existing "never leak
  upstream provider detail to the client" discipline. `intake.js`'s
  `extract` action treats every rejection identically: mark the session
  `extraction_failed`, keep the uploaded screenshots, never a 500 that loses
  them.

Everything else — `intake.js`'s handlers, the `intake_sessions.extracted_data`
shape, the client-matching code, the review UI's rendering — consumes only
the normalized return shape above. Swapping providers later means adding one
more entry to the internal `PROVIDERS` map (plus that provider's own
request/response helpers) and changing `INTAKE_VISION_PROVIDER`; nothing
outside this file changes. No provider SDK is `require()`'d anywhere.

The prompt sent (`SYSTEM_PROMPT` in the module) is responsible for: reading
the screenshot(s) directly as images (no separate OCR step), extracting the
19 fields from §7 (`FIELD_KEYS`), classifying per §8, assigning the four
confidence states per field (§9), and flagging cross-screenshot conflicts —
all in one call per session, per the "combine evidence across screenshots"
requirement, rather than per-image calls stitched together after the fact.
It also explicitly instructs the model to treat screenshot content as data
about a conversation, never as instructions to itself — defense in depth
against prompt injection via adversarial text inside a client's message,
on top of the structural fact that strict JSON-schema output already
constrains what the model's response can contain.

The adapter does **no** matching, deduplication, or booking-decision work —
`normalizeExtractionResult()` only maps/validates the model's JSON into the
shape above (unrecognized enum values fall back to safe defaults —
`"unclear"`/`"uncertain"`/`"missing"` — rather than being passed through
raw). Every decision in §5 happens afterward, in `intake.js`, in plain
deterministic code.

### Required environment variables (documented, NOT yet set)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes, for the `openai` provider | none — extraction fails safely without it | The only credential this adapter needs today. **Not added to any environment yet** — blocked on Rocky's explicit go-ahead, per CLAUDE.md's environment-variable rule. |
| `INTAKE_VISION_PROVIDER` | No | `"openai"` | `"openai"` or `"mock"` (hardening pass — see below). Reserved for a future `"claude"`/`"gemini"` value once another branch exists in the adapter's internal provider map. |
| `INTAKE_VISION_MODEL` | No | `"gpt-4o"` | Lets the exact model be tuned (cost/quality) without a code change. |

Until `OPENAI_API_KEY` is set, calling `extractFromScreenshots()` always
rejects with a generic "not available right now" error — verified by test,
never a crash, never a silent no-op that could be mistaken for success.

### Mock provider (hardening pass, Preview/test only)

`INTAKE_VISION_PROVIDER=mock` routes to `callMock()` — a fixed, deterministic
extraction (no network call, no credential) returning a fake client
("Mock Client", phone normalizing to `3035550199`), a mock service
description, and — when more than one screenshot is given — a manufactured
`date` conflict across two screenshots, specifically so the Conflicts UI has
something real to render in Preview. This exists so the whole upload →
extract → pending_review → review/edit → discard pipeline can be verified
end-to-end in Preview before `OPENAI_API_KEY` is ever added (per Rocky's
revised rollout order, step 7) — client matching (existing_exact/
new_candidate/needs_confirmation) is driven by what Preview customer rows
share (or don't share) that same deterministic phone number.

Two safety properties, both verified by test:
- `PROVIDERS` is a flat, single-entry-by-name lookup — the `openai` branch
  has no code path that references `callMock()` at all. A failing or
  unconfigured `openai` call never silently returns mock data; it rejects,
  same as always.
- `callMock()` refuses outright when `VERCEL_ENV === "production"` —
  defense in depth beyond "nobody would configure it that way," since a
  stray `INTAKE_VISION_PROVIDER=mock` in Production must never fabricate
  fake client data into a real intake record.

The default remains `"openai"` either way — `mock` only ever runs when an
environment's own config explicitly asks for it.

## 7. Extracted fields (per the brief, unchanged)

first name, last name, phone, email, service/job address, city/state/zip,
service type, requested service details, junk/item description, estimated
load size, quoted amount, date, appointment time/window, tentative-vs-
confirmed flag, internal notes, whether photos were referenced, explicit
client constraints. Never invented when absent — a field the model can't
find is `{ value: null, confidence: 'missing' }`, not a guess.

## 8. Classification enum (per the brief, unchanged)

`lead_only`, `quote_discussion`, `booking_confirmed`, `follow_up`,
`existing_job_update`, `unclear`. `booking_confirmed` requires strong
explicit commitment language in the prompt's instructions — the model is
told to prefer `quote_discussion`/`unclear` over `booking_confirmed` when
ambiguous, mirroring the brief's "never force it into a booking state."

## 9. Confidence model (per the brief, unchanged)

Four states only — `confirmed`, `likely`, `uncertain`, `missing` — no
percentage shown anywhere in the UI. `uncertain`/`missing` fields render
visibly flagged (e.g. an amber dot + outline) and stay editable until
confirm.

## 10. Review UI — implemented

Three new admin pages, matching existing naming/folder conventions exactly:

- **`admin/intakes/`** (plural — the Pending Intake queue; mirrors
  `admin/clients/`'s list pattern). `admin/intakes-list.js`.
- **`admin/intake-new/`** — the upload entry point, mirroring
  `admin/booking-new/`'s naming. `admin/intake-new.js` creates the session,
  uploads each screenshot sequentially (reusing `book/book.js`'s
  `uploadPhoto()`/`uploadAllPhotos()` sequential-chain pattern — `fetch()`
  takes a `File`/`Blob` body directly, no manual `ArrayBuffer` conversion
  needed), then calls `extract` and redirects into the review screen. A
  failed upload/extraction keeps the already-created session id in memory
  so retrying never creates a duplicate session or re-uploads an
  already-stored screenshot.
- **`admin/intake/`** (singular — the review/edit/save-pending screen,
  `?id=...`, matching `admin/booking`/`admin/client`'s existing convention).
  `admin/intake-detail.js` renders Client / Job-Lead / Scheduling /
  Conflicts / Existing-Job-Candidates / Notes / Source-Screenshots /
  Actions exactly per the brief, with a per-field confidence dot+word
  (never a percentage — new `.admin-confidence-dot-*` CSS, reusing the
  existing `.admin-sheet-dot` shape) and disables every input outright once
  the intake is no longer `pending_review`. **Deliberately has no Confirm
  button or any call to the client/booking-creation endpoints** — verified
  by a dedicated test
  (`tests/phase3c-batch5-intake-ui.test.js`).

Client matching in this screen is a **small self-contained search box**
(reusing the existing read-only `GET /api/admin/clients?search=` endpoint)
rather than the full `AdminClientPicker` component New/Past Job already
use — deliberately, so this screen can never trigger that component's
"+ Create Client" path and create a real `customers` row. Picking "new
client" here just clears the match (`matchedCustomerId: null`); the actual
customer row is only ever created at Stage 5D confirm time.

Nav gets one new tab + badge (Pending Intake count), reusing the
`countsOnly` pattern (§5, `list` action) so it costs no new function — added
to all nine pre-existing admin pages alongside the three new ones, same as
every prior section (Clients, Expenses, Requests) was integrated.

A regression test cross-checks that `admin/intake-detail.js`'s
`FIELD_LABELS`/`CLASSIFICATION_LABELS`/`CONFIDENCE_LABELS` keys exactly
match `api/_lib/intake-vision-provider.js`'s own exported
`FIELD_KEYS`/`CLASSIFICATIONS`/`FIELD_CONFIDENCES` constants, so the two
can never silently drift apart.

## 11. Staged implementation (within Batch 5) — 5A/5B/5C/review UI done

Same incremental-stage discipline as every prior batch — each reviewed
before the next starts:

1. **5A — done.** `booking-status.js` → `booking.js` PATCH consolidation
   (frees the function slot). Pure refactor, zero behavior change.
2. **Vision provider adapter — done.** OpenAI as the first concrete
   backend, fully swappable (§6). `OPENAI_API_KEY` documented, not set.
3. **5B/5C — done.** SQL migration drafted (§4.1, not executed);
   `api/admin/intake.js` built in full — session lifecycle, screenshot
   upload/removal, extraction (real adapter, mocked `fetch` in tests),
   client matching (§5.3), existing-job candidate detection (§5.4),
   classification/confidence persistence, and every review/edit/
   save-pending PATCH action. Function count back to 12/12.
4. **Review UI — done** (§10 above).
5. **5D — not started, intentionally.** `confirm` action + the shared
   `customer-write.js`/`booking-write.js` extraction from
   `client.js`/`booking.js`, plus a Confirm button in the review UI. This is
   the next and only remaining piece before an intake can produce a real
   client/lead/job/booking record.

## 12. Explicit non-goals / guardrails (restating the brief's constraints)

- No live client/lead/job/booking is ever created except via `confirm`,
  which always requires an authenticated admin action after review.
- No SQL runs against production until Rocky executes the reviewed
  migration himself (or explicitly asks me to).
- No push, no deploy, no new Vercel env var, no new Supabase bucket created
  without explicit go-ahead — all of those are production-infrastructure
  changes under this repo's existing CLAUDE.md rules.
- No new Vercel function file beyond the one `intake.js` made room for by
  §3's consolidation.
- Vision provider is swappable, never hard-wired into anything outside
  `api/_lib/intake-vision-provider.js`.

## 13. Current test/commit/function-count status (for this review)

- **Tests:** 1,196 assertions across 42 test files, all passing locally
  (`node tests/<file>.test.js` per file — this project has no test
  runner/CI beyond that).
- **Function count:** 12/12 (`api/admin/auth.js`, `booking.js`,
  `bookings.js`, `client.js`, `clients.js`, `intake.js` — six; plus the six
  pre-existing direct `api/*.js` files). The hardening pass's
  `?action=cleanup-expired` and the Vercel Cron pointed at it add zero new
  functions — same existing `intake.js` file, confirmed by the existing
  `<=12` guard in `tests/phase3c-schedule.test.js` and by direct inspection.
- **Commits:** 6, all local, nothing pushed (5A; the vision adapter; the
  schema/migration + storage design; `api/admin/intake.js` + server tests;
  the review UI + nav; the proposal/docs writeup) — approved structure, see
  chat history for exact hashes. **The hardening pass (mock provider,
  retention/cleanup, the `UNIQUE` constraint + retry) landed as working-tree
  changes on top of those 6, not yet its own commit(s)** — Rocky's call on
  how to split or fold it in before pushing.
- **New environment variables, both documented, NEITHER set anywhere:**
  `OPENAI_API_KEY` (§6) and, as of the hardening pass, `CRON_SECRET` (§14,
  `batch5-storage-design.md`) for authenticating the cleanup cron trigger.
- **Nothing pushed, nothing deployed, no SQL executed, no Storage bucket
  created.** Per CLAUDE.md, every one of those stays blocked on Rocky's
  explicit go-ahead, taken one at a time per §14 below.

## 14. Rollout plan — Rocky's revised order (2026-10-03)

Supersedes this proposal's earlier draft order. Nothing below has been done
except where marked; each remaining step needs Rocky's explicit go-ahead
before it happens.

1. **Commit locally.** Done — 6 commits (§13), hardening pass still
   uncommitted on top.
2. **Run final targeted + full tests.** Done — 1,196/1,196 passing.
3. **Run a read-only migration safety audit.** Done (text review only, no
   DB connection used or possible from this environment): the migration is
   purely additive (`CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS`/
   `REVOKE`-then-`GRANT` on brand-new tables, no backfill `UPDATE`s at all),
   safe to re-run any number of times. One non-migration, app-level
   observation noted and already addressed: see §2/the `UNIQUE` constraint
   discussion.
4. **Create the `intake-screenshots` Storage bucket** (private, policies per
   `batch5-storage-design.md`) — only after the migration is approved, per
   Rocky's explicit ordering. Not done.
5. **Apply the migration** (`sql/2026-10-04_phase3c-batch5-intake-sessions.sql`)
   to the target environment. Not done — blocked on Rocky running it or
   explicitly asking Claude to.
6. **Push to a Preview branch, not Production.** Not done.
7. **Verify the full intake flow in Preview** with `INTAKE_VISION_PROVIDER=mock`
   (no `OPENAI_API_KEY` needed) — create intake, upload one/multiple
   screenshots, reload and confirm persistence, Pending list/detail, client
   matching (seed a Preview customer with phone `303-555-0199` for
   `existing_exact`, omit it for `new_candidate`, duplicate it across two
   customers for `needs_confirmation`), the manufactured multi-screenshot
   date conflict, existing-job-candidate display (seed an upcoming booking
   for the matched customer, reclassify to `existing_job_update`), edit/save
   pending, discard, and the static/runtime guarantee that nothing writes to
   `customers`/`bookings`. `?action=cleanup-expired` can be exercised
   directly (curl with the `CRON_SECRET` bearer token) since Vercel Cron
   itself only fires against Production, not Preview. Not done.
8. **Only after that non-AI pipeline is clean, add `OPENAI_API_KEY` to
   Preview.** Not done.
9. **Run real screenshot extraction tests in Preview** (`INTAKE_VISION_PROVIDER`
   back to its `openai` default, or unset). Not done.
10. **Stop before Production and before Stage 5D.** This proposal's explicit
    boundary — confirming the real client/booking write (Stage 5D) and the
    Production push are both separate, future, explicitly-approved steps,
    not a continuation of this rollout.
