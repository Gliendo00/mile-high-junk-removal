# Supabase Schema — Confirmed-from-Code Documentation

Status: **draft, partially unverified.** This documents only what can be
proven by reading `api/book.js` and `api/upload-photo.js` (the only code in
this repo that touches these tables). It does **not** come from inspecting
the live Supabase project directly — no database connection was made or
queried to produce this document, and no column types, constraints,
indexes, defaults, or RLS policies below should be trusted as accurate until
someone checks them against the actual Supabase dashboard/CLI (`supabase db
dump`, the Table Editor, or the SQL editor with
`select * from information_schema.columns where table_name = '...'`).

Every table below lists:
- **Columns referenced in code** — confirmed to exist, because the code
  reads or writes them successfully today against production.
- **Confirmed from code comments** — things explicitly stated in code
  comments by whoever built this (e.g. `dumpster_rentals.booking_id UNIQUE`)
  but not independently re-verified here.
- **NEEDS VERIFICATION** — anything this document cannot know just from
  reading application code (types, nullability beyond what the app enforces,
  defaults, indexes, RLS policies, foreign key definitions, triggers).

---

## `customers`

Source: `api/book.js` (comment header + the `.insert({...})` call in the
booking flow).

| Column | Confirmed from code | Notes |
|---|---|---|
| `id` | Yes — returned via `.select("id").single()` and used as `customer_id` on the booking insert. | Type NEEDS VERIFICATION. Likely `uuid` (matches the pattern confirmed for `bookings.id`, see below), but this repo never reads a raw customer id back out or displays it, so that's an inference, not a confirmation. |
| `first_name` | Yes — always written, required by app-level validation (`MAX.name` = 80 chars). | NOT NULL at the application level. DB-level NOT NULL/constraints: NEEDS VERIFICATION. |
| `last_name` | Yes — the insert writes `data.customer.lastName \|\| null`, so the column itself accepts NULL. | In practice this endpoint never sends NULL here: `validateBooking()` requires `lastName` to be truthy (`if (!lastName) return { ok:false, error: "Last name is required." }`) before the insert is reached. The `\|\| null` fallback exists in the insert code but is currently unreachable from this endpoint. Nullability at the DB level: NEEDS VERIFICATION. |
| `phone` | Yes — always written, required, validated as 10–15 digits. | Max 30 chars enforced by the app (`MAX.phone`). DB length/type: NEEDS VERIFICATION. |
| `email` | Yes — written, optional (`data.customer.email || null`). | Max 254 chars enforced by the app. Nullable. |
| `address` | Yes — always written (maps from the app's `streetAddress` field), required. | Max 200 chars enforced by the app. |
| `city` | Yes — always written, required. | Max 80 chars enforced by the app. |
| `state` | Yes — always written, required, validated as exactly 2 uppercase letters. | Max 2 chars enforced by the app. |
| `zip` | Yes — always written, required, validated as 5 digits or ZIP+4. | Max 10 chars enforced by the app. |
| `created_at` | Named in the comment header (`customers(id, ..., created_at)`) but never set explicitly by this code — must be a DB default (e.g. `now()`). | NEEDS VERIFICATION (default value/trigger). |

No update or delete path exists for `customers` in this codebase except the
rollback path in `api/book.js` (`safeDelete`), which deletes the just-created
customer row if a later step in the same request (creating the booking, or
the dumpster_rentals row) fails — this is transactional cleanup, not a
general delete capability.

---

## `bookings`

Source: `api/book.js` (comment header + `.insert({...})` call).

| Column | Confirmed from code | Notes |
|---|---|---|
| `id` | Yes. **Confirmed to be treated as sensitive/opaque**: a code comment explicitly states "this endpoint never returns the raw booking UUID," and the type is called out as UUID in that same comment. | Type: UUID (stated in code comment, not independently re-verified against the DB). |
| `customer_id` | Yes — foreign key value written on every insert (the just-created customer's id). | **Confirmed directly against production Supabase, 2026-09-16 (Phase 3C): `ON DELETE CASCADE`.** Deleting a `customers` row deletes every `bookings` row referencing it, with no admin-code opportunity to intervene once that DELETE is issued. See [../phase-3/database-schema-updates.md](../phase-3/database-schema-updates.md) for the full finding and its implications for a future delete/archive feature. |
| `service_type` | Yes — one of `junk_removal`, `dumpster_rental`, `light_demo` (enforced at the app level by `SERVICE_TYPES`). | Whether the DB itself enforces this as an enum/check constraint or just a free-text column: NEEDS VERIFICATION. |
| `appointment_date` | Yes — an ISO `YYYY-MM-DD` string. For `dumpster_rental` this is the delivery date, not a generic "preferred date" (see code comment in `validateBooking`). | Column type presumably `date`: NEEDS VERIFICATION. |
| `time_window` | Yes — one of the values documented in [time-windows.md](./time-windows.md). | Presumably `text`: NEEDS VERIFICATION. |
| `status` | **Named in the comment header, but never set by this code path at all.** | This is the key fact behind [crm-status-plan.md](./crm-status-plan.md): every booking created through the current `/book` flow leaves `status` at whatever the column's default is (or NULL, if there is no default). Actual default value/nullability: NEEDS VERIFICATION — this document cannot tell you which without checking Supabase directly. |
| `description` | Yes — a server-generated multi-line human-readable summary built from the service-specific job details (`buildDescription()`). | |
| `estimated_price` | Named in the comment header. Never read or written anywhere in this repo. | NEEDS VERIFICATION (type, default, whether it's used by any other system e.g. a future admin UI or an existing internal tool not in this repo). |
| `final_price` | Named in the comment header. Never read or written anywhere in this repo. | Same as above. |
| `internal_notes` | Named in the comment header. Never read or written anywhere in this repo. | Same as above. |
| `created_at` | Named in the comment header, never set explicitly — must be a DB default. | NEEDS VERIFICATION. |
| `updated_at` | Named in the comment header, never set explicitly. | Likely maintained by a DB trigger (common Supabase pattern) but this is an assumption — NEEDS VERIFICATION. |

Rollback: if the `dumpster_rentals` insert fails after a `bookings` row was
already created, `api/book.js` deletes the just-created `bookings` row (and
the `customers` row) via `safeDelete()`. This is application-level cleanup,
not a DB transaction — there's a real (if narrow) window where a customer
row could persist without a booking if the process crashes between the two
inserts. Not a Phase 1 concern to fix, just noted here since it's relevant
to "what can bookings data actually look like."

---

## `dumpster_rentals`

Source: `api/book.js` (comment header + `.insert({...})` call, only reached
when `serviceType === "dumpster_rental"`).

| Column | Confirmed from code | Notes |
|---|---|---|
| `id` | Yes (implied — every table in this app has one; never read back). | Type NEEDS VERIFICATION. |
| `booking_id` | Yes — the just-created booking's id. **Confirmed UNIQUE from an explicit code comment**: `dumpster_rentals(id, booking_id UNIQUE, ...)`. | So today's data model is one dumpster_rentals row per booking, never more — confirmed by the app's own logic (it inserts exactly once per booking) and reinforced by that comment, though the UNIQUE constraint itself was not independently re-verified against the DB in this pass. **`ON DELETE` behavior confirmed directly against production Supabase, 2026-09-16 (Phase 3C): `CASCADE`.** Deleting a `bookings` row deletes its `dumpster_rentals` row automatically. See [../phase-3/database-schema-updates.md](../phase-3/database-schema-updates.md). |
| `delivery_date` | Yes — ISO date string. | |
| `pickup_date` | Yes — ISO date string, validated to be on/after `delivery_date`. | |
| `material_type` | Yes — free text, max 200 chars enforced by the app (`MAX.short`). | |
| `placement_notes` | Yes — maps from the app's `placementLocation` field, max 200 chars. | |
| `created_at` | Named in the comment header, never set explicitly. | NEEDS VERIFICATION. |

---

## `booking_photos`

Source: `api/upload-photo.js` (comment header + `.insert({...})` call).

| Column | Confirmed from code | Notes |
|---|---|---|
| `id` | Yes (implied, never read back). | Type NEEDS VERIFICATION. |
| `booking_id` | Yes — derived **only** from the verified, signed upload token, never from any client-supplied field (this is called out explicitly in the file's header comment as an intentional IDOR defense). | No UNIQUE constraint implied — a booking can have multiple photo rows (up to `MAX_PHOTOS_PER_BOOKING = 6`, enforced at the application level via a `count` query before insert, not by a DB constraint). **`ON DELETE` behavior confirmed directly against production Supabase, 2026-09-16 (Phase 3C): `CASCADE`.** Deleting a `bookings` row deletes its `booking_photos` rows automatically — but this only ever removes database rows, never the underlying files in the `booking-photos` Storage bucket (a DB cascade cannot reach Supabase Storage). See [../phase-3/database-schema-updates.md](../phase-3/database-schema-updates.md). |
| `storage_path` | Yes — format `bookings/<bookingId>/<uuid>.<ext>`, written after a successful upload to Supabase Storage. | |
| `created_at` | Named in the comment header, never set explicitly. | NEEDS VERIFICATION. |

### Storage

- Bucket name: `booking-photos` (confirmed — the `BUCKET` constant in
  `api/upload-photo.js`).
- Allowed types: JPEG, PNG, WebP — enforced both by declared
  `Content-Type`/`X-Photo-Type` header **and** by checking the file's actual
  magic bytes (`matchesMagicBytes()`), so a mislabeled file is rejected.
- Application-level size ceiling: 4 MB per photo (`MAX_PHOTO_BYTES`), with a
  comment noting the bucket's own infra-level limit is separately configured
  in Supabase at 6 MB. That bucket-level limit is NEEDS VERIFICATION — this
  document takes the code comment's word for it, it wasn't checked directly.
- **Bucket privacy: NEEDS VERIFICATION.** Nothing in this codebase proves
  the bucket is private. Uploads go through the service-role key from a
  server function, which works whether the bucket is public or private — so
  the upload path alone doesn't tell you the read side is locked down. This
  matters directly for [admin-security-requirements.md](./admin-security-requirements.md)
  ("booking photos remain private") — someone needs to confirm in the
  Supabase dashboard that the `booking-photos` bucket is **not** public and
  has no public-read policy before a future admin UI is allowed to assume
  short-lived signed URLs are the only way to view a photo.

---

## What this document deliberately does NOT claim

To be explicit about the boundary: this document does not state, and no one
should assume from it:

- Exact column data types (`uuid` vs `text`, `timestamptz` vs `timestamp`, `numeric` vs `integer` for prices, etc.)
- Any index definitions
- Any CHECK/UNIQUE constraint beyond the one `dumpster_rentals.booking_id UNIQUE` case explicitly called out in a code comment (the three `ON DELETE CASCADE` foreign keys noted above were confirmed directly against Supabase in Phase 3C — see [../phase-3/database-schema-updates.md](../phase-3/database-schema-updates.md) — and are the one exception to this document's original code-only-confirmation scope)
- Any column defaults beyond "must exist because the app never sets it and doesn't error"
- Any Row Level Security (RLS) policies on any of these tables
- Whether RLS is even enabled on these tables

All of the above must be confirmed against the live Supabase project
(dashboard → Table Editor / Database → Roles & Policies, or
`supabase db dump --schema public`) before Phase 2 code relies on any of it.
