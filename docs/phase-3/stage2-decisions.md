# Phase 3C Stage 2 — Locked Owner Decisions

Status: **decisions locked, nothing implemented.** These resolve the open
questions raised in
[stage2-plus-architecture-audit.md §7](./stage2-plus-architecture-audit.md#7-decisions-that-need-rockysthe-owners-input-before-stage-2-starts).
Recorded verbatim-in-substance so a later session builds against the actual
approved answer, not a re-guess of what was probably meant.

## 1. Vercel plan — stay on Hobby

Remain on the Hobby plan. Do not upgrade to Pro merely to gain function
headroom. Use sensible consolidation (per
[stage2-plus-architecture-audit.md §4.2](./stage2-plus-architecture-audit.md#42-what-stage-2-actually-needs-and-how-to-fit-it-without-a-plan-upgrade))
to stay within the existing 12-function limit — but never by building one
giant generic "do everything" endpoint just to dodge the ceiling. This
resolves audit decision #1 as: **consolidate, don't upgrade.**

## 2. `booking-status.js` retirement — approved in principle, deferred in practice

Retiring `api/admin/booking-status.js` into `api/admin/booking.js`'s
`PATCH` is **approved as a future change**, but must **not** happen as a
side effect of the New Job implementation unless genuinely required by it.
New Job creation (Stage 2.1, proposed below) only ever needs `booking.js`'s
`POST` — it never touches status-changing logic — so this consolidation has
no reason to happen in Stage 2.1 and won't.

When it does happen (expected around booking-edit work, previously staged
as "Stage 2.3" and unchanged in the revised sequence below), treat it as its
own controlled, reviewable change with full regression coverage — not folded
quietly into an unrelated feature commit. The consolidated `PATCH` must keep
exactly the write discipline `booking-status.js` already has today:

- `requireAdmin()` first, before anything else.
- Validate the id as a real UUID and the requested action/fields against an
  explicit allowlist — never accept an arbitrary field name from the body.
- Never spread the request body into the Supabase update payload — read
  each accepted field individually, the same way `booking-status.js` reads
  only `id`/`status` as primitives today.
- `Cache-Control: no-store` (already set by `requireAdmin()`).
- Service-role client used only after `requireAdmin()` succeeds.

This resolves audit decision #2 as: **yes, eventually, as its own reviewed
change — not bundled into Stage 2.1.**

## 3. Admin duplicate-client behavior — locked

This is the exact behavior to build (supersedes the looser language in
[stage2-plus-requirements.md §7](./stage2-plus-requirements.md) and the
open question in the audit's decision #3):

| Match | Behavior |
|---|---|
| Exact `phone_normalized` **and** `email_normalized` match (one row) | **Block** normal creation. Prominently surface/select the existing client instead. Creating a duplicate anyway requires an explicit, separate **"Create anyway"** confirmation/action — never the default path. |
| Phone-only match, or email-only match | **Warn**, but allow creation to proceed without an extra confirmation step. Never auto-merge. |
| Neither phone nor email provided (or neither matches anything) | **Allow** creation outright — nothing to warn about. |
| Multiple/ambiguous matches | **Never** auto-merge or auto-select. Surface as a warning at most; the admin picks manually if they want to reuse one, or creates new. |
| No fuzzy name/address matching | Not part of this design at all — matching is exact-normalized-value only, on phone/email, exactly as `api/_lib/customer-identity.js` already normalizes them. Never silently merge clients under any circumstance. |

**Public booking behavior (`api/book.js`'s silent single-exact-match
auto-reuse) is unchanged.** This locked behavior is admin-side only — a new
code path in `api/admin/client.js`'s `POST`, not a modification to the
public `/api/book` endpoint's existing Step 4a.3 logic.

### Amendment (2026-09-17) — phone is optional for an admin-created client

Do **not** require a phone number to create a client from the admin side.
Historical migration from January 2026 may include legitimate clients the
owner no longer has a working phone number for. Locked fields:

- **Required:** first name.
- **Optional:** last name, phone, email, address/city/state/zip.
- Normalize phone only when one is provided; normalize email only when one
  is provided — never invent a placeholder value for either just to
  satisfy a requirement that doesn't apply to a given historical client.
- The duplicate-matching table above is unchanged by this — it already
  only ever runs a phone-based lookup when a phone was actually submitted,
  and an email-based lookup when an email was. A client created with
  neither falls into the "neither provided" row above: created outright,
  no warning possible (there's nothing to compare).

## 4. Past Job duplicate policy — locked

`+ Past Job` is for historical jobs that **do not already exist** in the
CRM — phone/text-only or off-system jobs the owner is backfilling. It is
**not** a way to re-enter a job that already exists as a public or
admin-created booking. An existing CRM booking that needs its real
historical details filled in (actual amount, payment, notes) should be
**edited/completed in place** once job-editing exists (Stage 2.4 below),
never duplicated via Past Job. This matters concretely: a duplicate would
double-count that job in job counts and revenue reporting, silently
corrupting the exact numbers §9/§17 of the requirements depend on.

## 5. Revised Stage 2 implementation sequence

Supersedes [stage2-plus-requirements.md §25](./stage2-plus-requirements.md)
and [stage2-plus-architecture-audit.md §6](./stage2-plus-architecture-audit.md).
Month/Year moves up ahead of job-money fields and revenue summaries,
specifically so the owner has a working way to navigate and verify imported
2026 history while the historical migration is actively underway, rather
than migrating data blind and reviewing it only once money fields exist.

1. **Stage 2.0** — preflight/read-only schema checks (see
   [stage2-preflight.md](./stage2-preflight.md); in progress, blocked on
   dashboard access this session doesn't have).
2. **Stage 2.1** — `+ New Job` + inline Create Client. Proposed in
   [stage2.1-new-job-proposal.md](./stage2.1-new-job-proposal.md); not yet
   implemented.
3. **Stage 2.2** — `+ Past Job` rapid historical entry.
4. **Stage 2.3** — booking editing (status/price/notes) + the controlled
   `booking-status.js` → `booking.js` `PATCH` consolidation from decision
   #2 above.
5. **Stage 2.4** — Month / Year / historical Schedule navigation back to
   January 1, 2026.
6. **Stage 2.5** — job money fields: actual amount, tip, payment
   method/status, private notes (depends on Stage 2.0's type-verification
   result for `tip_amount`).
7. **Stage 2.6** — revenue summaries.
8. **Stage 2.7** — archive/restore/safe permanent delete.
9. **Stage 2.8** — expense data model + daily Quick Expense icons.
10. **Stage 2.9** — revenue + expense summaries.
11. **Stage 2.10** — daily route map.
12. **Stage 2.11** — SMS/communications.

Each stage remains individually implemented and reviewed before the next
begins — this sequence is a plan, not a batch authorization.
