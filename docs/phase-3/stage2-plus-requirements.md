# Phase 3C Stage 2+ — Locked Product Requirements

Status: **locked product direction, not implemented.** This document records
requirements gathered after Stage 1 shipped, ahead of any Stage 2 code. It
freezes *what* the CRM should eventually do; [stage2-plus-architecture-audit.md](./stage2-plus-architecture-audit.md)
covers *how* that intersects with the current codebase — conflicts, schema
dependencies, the Vercel function-count budget, security implications, and a
recommended staged build order. No feature code, no migration, no Supabase
change, and no push/deploy happened while writing either document.

## 0. Baseline this document builds on

- Production/`main` SHA: `81a40af` ("Fix Preview deploy failure: consolidate
  Schedule/badge into bookings.js").
- `/admin/` is the Schedule homepage; `/admin/requests/` holds Requests;
  `/admin/clients/` holds Clients. Requests carries the small `new`-count
  badge.
- Schedule currently supports Today/Tomorrow/Week and shows only `booked`
  and `completed` jobs (see [schedule-architecture.md](./schedule-architecture.md)).
- 169/169 local tests passing at this baseline (confirmed by re-running the
  full suite while writing this document).

Stage 1 is complete and live. Nothing below reopens it.

## 1. Product direction

Small-operation CRM, not enterprise software. Priorities: extremely fast
mobile use, few taps, clean UI, simple forms, useful numbers, safe
destructive actions, clear client/job history, historical business records.

Target speeds:
- A phone-call job: enterable in ~30 seconds.
- A historical job with only basic info: faster still.
- A common expense (fuel): a few seconds.

## 2. Schedule stays the CRM homepage

`/admin/` remains Schedule. Nav stays Schedule / Requests / Clients.
Requests keeps its restrained numeric badge. Schedule becomes the central
operational view for jobs, revenue, expenses, and eventually daily routing —
without becoming a full accounting dashboard.

## 3. Schedule date views

Today, Tomorrow, Week, Month, Year — via a compact mobile selector, not five
buttons across the screen.

- **Today/Tomorrow**: individual job cards, as today.
- **Week**: previous/next navigation, a clearly displayed date range. Not
  permanently "rolling next 7 days."
- **Month**: mobile calendar overview — dates with jobs, a restrained
  count/indicator per day, tap a day to see its jobs, prev/next month,
  eventually monthly financial totals. No full job cards in calendar cells.
- **Year**: Jan–Dec overview; eventually per-month job count, completed
  revenue, expected/booked revenue, tracked expenses. Tap a month to open
  Month view. Year navigates between years, bounded by §4 below.

## 4. Historical data starts January 1, 2026

The owner will manually transfer business records into the CRM starting
**January 1, 2026**. The CRM is therefore both the live scheduling system
and the historical operational record from that date forward.

- January 1, 2026 is the earliest date selectable through the normal CRM UI.
- Never fabricate historical records; empty historical periods render cleanly.
- Schedule APIs should support arbitrary bounded date ranges so
  Today/Week/Month/Year can reuse the existing serverless architecture — do
  **not** create a separate function per view (see the Vercel Hobby 12-function
  limit already hit once in Stage 1).
- Audit date handling so historical calendar dates never shift due to
  UTC/local timezone conversion.

## 5. + New Job

Fast manual job entry: **+ New Job → Find/Create Client → Job Info → Save.**

- Search/select an existing client, or create one inline.
- Enter service address, service type, appointment date, time/time window,
  description/details, estimated price, optional private notes. Save.
- Defaults to `status = booked`.
- Must store its own `service_address`/`service_city`/`service_state`/
  `service_zip` snapshot — never derived from the client's current profile
  address later.

## 6. + Past Job — rapid historical entry

A separate, streamlined **+ Past Job** flow — not the full public booking
wizard, repeated.

Core fields: search/select or inline-create client; job date; service/job
address; service type; actual job amount; tip (once tip tracking exists);
payment method (once it exists); payment status (once it exists);
description/details; optional private notes.

- Appointment time/time-window is **optional** — never force-inventing a
  forgotten time.
- Defaults to `status = completed`.
- Allowed date range: January 1, 2026 through the current date.
- Never require data that may legitimately be unavailable just to save the
  record.
- Design (future) for rapid re-entry: after saving one Past Job, go straight
  into entering another rather than navigating back through the CRM.
- **Locked duplicate policy:** Past Job is only for jobs that don't already
  exist in the CRM — never a way to re-enter a job already created via the
  live public booking flow or New Job. See
  [stage2-decisions.md §4](./stage2-decisions.md#4-past-job-duplicate-policy--locked).

## 7. Client creation

- Standalone `+ New Client`.
- Inline creation during New Job and during Past Job.
- Reuse the existing normalization infrastructure: `normalizePhone()`,
  `normalizeEmail()`, `phone_normalized`, `email_normalized`.
- Preserve the existing duplicate-safety philosophy: never silently merge
  ambiguous clients. An exact phone+email match must be surfaced strongly
  and require deliberate action before intentionally creating a duplicate.
  Weaker/partial matches may warn but must never auto-merge. **Locked,
  exact behavior:** see [stage2-decisions.md §3](./stage2-decisions.md#3-admin-duplicate-client-behavior--locked).
- Historical migration must not require separately creating every client
  before entering their jobs — inline creation covers this.

## 8. Job money tracking

Existing: `estimated_price` (expected), `final_price` (actual),
`internal_notes` (private notes).

Future: `tip_amount`, `payment_method`, `payment_status`. Before creating
`tip_amount`, verify the live numeric type backing `final_price` and choose a
compatible money representation.

- Initial payment methods: Card, Cash, Invoice, Zelle, Venmo.
- Initial payment statuses: Paid, Unpaid.
- Keep it simple — no normalized accounting/payment ledger unless a real
  future requirement (e.g. split/partial payments) demands it.

## 9. Revenue counter / financial summary

Schedule shows a compact financial summary that follows the selected date
range (Today/Week/Month/Year; Tomorrow may show scheduled/expected value).

- **Completed revenue**: `status = completed` jobs, summed by `final_price`.
  Never silently substitute `estimated_price` and present it as actual
  revenue.
- **Booked/expected revenue**: `status = booked` jobs, shown separately —
  `final_price` if an actual/agreed amount exists, otherwise
  `estimated_price`. Never presented as already-earned.
- **Scheduled value** (optional): Completed + Booked, with the distinction
  kept obvious.
- Example: `$8,450 Completed` / `$3,200 Booked` / `$11,650 Scheduled` /
  `18 completed · 6 upcoming`. Visual design not locked; keep it compact.
- Aggregates computed server-side from authenticated CRM data — never
  trusted from the browser as authoritative.
- Historical Past Jobs contribute to the correct Day/Week/Month/Year
  automatically, based on `appointment_date`.

## 10. Tips

Stored separately from `final_price` — job revenue, tips, and total
collected must remain distinguishable in the underlying data, even though
Schedule reporting may eventually surface tips alongside revenue.

## 11. Lightweight expense tracking

Fast entry, daily operational visibility, useful Week/Month/Year totals.
Not full accounting software. Expenses need their own authenticated data
model — never represented as fake bookings/jobs.

## 12. Daily Schedule — quick expense icons

No generic form + category picker for common expenses. Compact quick-expense
actions directly on the daily Schedule (e.g. `⛽ Fuel` `🗑 Dump` `🍔 Meal`
`＋ More`). Tapping one opens a small mobile sheet with the category
pre-selected (e.g. Fuel → Amount → Date defaults Today → optional note →
Save). No re-selecting the category. After save: persisted, sheet closes,
daily totals update, owner stays on Schedule. Optimize for one-handed phone
use.

## 13. Expense categories

Initial set: Fuel, Dump Fees, Meals, Repairs/Maintenance, Advertising,
Supplies, Miscellaneous. (No both `Other` and `Miscellaneous` — Miscellaneous
covers that role.)

Proposed quick actions: Fuel, Dump Fee, Meal, More (More exposes
Repairs/Maintenance, Advertising, Supplies, Miscellaneous) — keeps Schedule
from being cluttered with seven permanent buttons. Exact final UX can be
refined during implementation review.

## 14. Expense entry

Normal flow: category pre-selected → amount → save, plus date (default
Today) and an optional note. Historical expenses must support dates back to
January 1, 2026. Notes are never mandatory.

## 15. Expense data architecture (design only — not created in this stage)

Initial required concepts: expense id, expense date, category, amount,
optional notes, created timestamp. Leave room for future optional fields
(receipt photo, vendor, vehicle/trailer attribution, booking/job
association) without making them mandatory for quick entry.

All expense writes must follow the existing admin security discipline:
authenticate first, validate method/input, strict category allowlist,
bounded numeric amount, bounded notes, service-role access only after
authorization, no-store admin responses.

## 16. Optional job-linked expenses

An expense may optionally reference a booking/job — most useful for Dump
Fees. From inside a completed job, `+ Add Dump Fee` pre-fills category and
job association; the owner just enters the amount. That expense still counts
toward daily/Week/Month/Year expense totals and is separately associated
with the job. From the general Schedule, job association is optional, never
required.

## 17. Revenue + expense summary

Once both job-money and expense tracking exist, Schedule can show e.g.
`$1,075 Completed` / `$475 Booked` / `− $96 Expenses` / `$979 After tracked
expenses`. **Never** call that bottom figure Profit / Net Profit / Net
Income — the CRM may not contain every accounting/tax/business cost. Keep
completed revenue, expected/booked revenue, tips, tracked expenses, and job
count independently available. Day/Week/Month/Year use the same underlying
model; historical 2026 entries build the corresponding historical totals
automatically.

## 18. Month/Year business history

As historical records accumulate, Year view becomes a simple
business-performance overview (e.g. `January — 18 jobs · $8,420 completed ·
$1,100 expenses`). Do not implement these figures before the underlying
job-money and expense data is trustworthy — the architecture should simply
support this future presentation.

## 19. Archive / restore / permanent delete

Preserve the previously audited safe-removal architecture. Confirmed live
FKs (all `ON DELETE CASCADE`): `bookings.customer_id → customers.id`,
`booking_photos.booking_id → bookings.id`, `dumpster_rentals.booking_id →
bookings.id` (see [database-schema-updates.md](./database-schema-updates.md)).

- Normal removal is **Archive**, not permanent deletion. Planned:
  `customers.archived_at`, `bookings.archived_at`. Archived jobs drop out of
  active Schedule/counts/revenue; client history may still show archived
  jobs with an archived indication.
- Permanent client deletion: count bookings first, refuse if any exist; only
  zero-job clients can be permanently deleted.
- Never expose a casual action capable of triggering the customer → booking
  cascade and destroying job history.
- Permanent job deletion must explicitly remove the booking's Storage photo
  objects (the DB cascade deletes `booking_photos` rows but never the
  underlying Storage files) before/while deleting the booking row.
- When expenses exist, define equivalent archive/removal behavior so
  deleted/archived expenses don't skew financial totals.

## 20. Operational job status

No second operational-status field yet. `booked`/`completed`/`lost` remain
sufficient. Do not add En Route / On Site / In Progress speculatively —
revisit when route/communication features actually need it.

## 21. Daily route map — later

Planned after core CRM functionality: job list, numbered stops, "View
Route," directions/navigation for a day with 2+ jobs. No route optimization
in current stages.

## 22. SMS — after core CRM

Planned after core CRM architecture is stable (booking confirmation,
appointment reminder, on-the-way, completion/review request). Not
implemented yet.

## 23. Security / architecture requirements

Preserve existing admin security in full. Client names, phone numbers,
addresses, booking information, photos, financial information, and expenses
must never become publicly readable. Continue: admin auth before processing
protected data, HttpOnly/Secure/SameSite cookies, admin email allowlist,
server-side Supabase service-role only, browser never receives service-role
credentials, no-store admin API responses, strict UUID validation, explicit
input allowlists, XSS-safe rendering, signed private photo URLs only after
authorization. Never weaken existing public booking security while adding
admin features.

## 24. Serverless function limit

Hard constraint: **Vercel Hobby plan, 12 Serverless Functions per
deployment.** Stage 1 already had to consolidate Schedule and the
Requests-badge count into `api/admin/bookings.js` via query modes to stay
under it. Future work must prefer extending cohesive existing
endpoints/query modes over adding a new function file per operation — but
not by building one unsafe do-everything endpoint either. Preserve the
function-count regression guard test.

## 25. Proposed product priority (not a mandate to build sequentially without review)

1. `+ New Job` + inline Create Client
2. `+ Past Job` / historical migration workflow
3. Edit scheduling/job details
4. Actual amount / tip / payment method / payment status / private notes
5. Month + Year + historical Schedule navigation back to Jan 2026
6. Revenue summaries
7. Archive / restore / safe permanent delete
8. Expense data model + daily Quick Expense icons
9. Revenue + expense summaries
10. Daily route map
11. SMS / communications

Each stage is approved individually. **Superseded by the owner-approved
revision in [stage2-decisions.md §5](./stage2-decisions.md#5-revised-stage-2-implementation-sequence)**,
which moves Month/Year ahead of financial reporting so historical migration
has a working navigation/verification view while it's underway — kept here
for the historical record.

## 26. Guiding UX principle

Every new feature must answer: **does this make the owner's day easier, or
are we adding software complexity for its own sake?**

- Phone call: `+ New Job → client → date/time → address → price/details → Save`
- Historical migration: `+ Past Job → client → date → address → amount → payment → Save`
- Gas station: `⛽ Fuel → $72.43 → Save`
- Landfill: `🗑 Dump → $86 → Save`
- Meal: `🍔 Meal → $18.50 → Save`
