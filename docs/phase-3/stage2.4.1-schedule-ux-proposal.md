# Phase 3C Stage 2.4.1 — Schedule UX Polish + Two Bug/Config Investigations

Status: **implemented**, on feature branch `phase-3c/stage2.4.1-schedule-ux-fixes`
from production baseline `afddeb0`. Owner feedback from actual Production
use, addressed as one focused pass: Daily/Week layout redesign (items 1-3),
two investigations that concluded "no code bug found, root cause is X"
(items 4-5), and a public-site isolation audit (item 6).

## 1-2. Selected-day / Daily layout + compact job cards

`admin/calendar-views.js`'s `renderDayPanel(container, iso, jobs)` is now
the **single shared renderer** for both Month's day panel and the new
Week's per-day selection (see §3) — one function, never two copies that
could visually drift apart. It builds, in this exact order:

1. **Selected date** — the heading, unchanged.
2. **Quick Expense icons** — `admin/quick-expense.js`'s mount, moved from
   the bottom of the panel to directly under the date. Nothing about the
   Quick Expense widget itself changed: same categories, same automatic
   `iso` (selected-date) assignment, same POST contract. This is a pure
   reorder.
3. **Jobs** — the "+ New Job"/"+ Past Job" action (unchanged logic: a
   historical date links to Past Job, today/future links to New Job),
   followed by each job as its own card.

New compact card, `renderDailyJobCard(job)` — deliberately **different**
from `admin/schedule.js`'s `renderJobCard()` (which Today/Tomorrow still
use, byte-for-byte unchanged): **Time** (bold, first) → **Client name**
(bold, second) → one secondary meta line (service · city · price, no
overcrowding). The entire card is a single `<a href="/admin/booking/?id=...">`
— no separate Call/Text/Directions row competing for the tap; those stay
one tap away on the booking detail page the card opens. Cards are visually
separated (white surface, border, radius, gap) in a simple vertical list.

## 3. Week redesigned into a 7-day overview

Previously: a rolling chronological list of full job cards grouped under
day-heading labels — visually indistinguishable from "seven Daily views
stacked," exactly what the owner didn't want.

Now: `admin/calendar-views.js`'s `renderWeekOverview()` builds **exactly 7
day rows every time**, unconditionally (Sunday through Saturday of the
selected week — the definition is unchanged), including days with zero
jobs (shown as just a weekday + date, no job count badge). A day with jobs
shows its count and up to `WEEK_ROW_MAX_JOB_LINES` (3) compact
"`time · client name`" lines; a busier day is capped with a "`+N more`"
line rather than growing the row — tapping the row still opens the full
list for that day. Tapping **anywhere** on a row selects that date and
renders it in the exact same shared `renderDayPanel()` Month uses,
appearing below the 7-day overview.

**Preserved, unchanged:**
- Prev Week / Next Week / "Jump to this week" — same buttons, same
  server-driven `canGoPrevious`/`isCurrentWeek` gating.
- The Sunday-start week definition (Stage 2.4's own decision, documented
  in `api/admin/bookings.js`'s `handleSchedule()`).
- America/Denver date semantics (all date math is still server-computed;
  the client only ever echoes back the `weekStart`/`weekEnd`/`today` the
  API already returns).
- The historical floor (`canGoPrevious` still comes straight from the
  server, which still bounds at the Sunday-aligned week containing
  2026-01-01).
- **No new API endpoint or serverless function.** Week still calls the
  exact same `GET /api/admin/bookings?view=schedule&range=week[&weekStart=]`
  established in Stage 2.4 — this is a rendering-only redesign. Confirmed:
  zero files under `api/` were touched this stage; function count stays
  12/12.

Architecturally, Week moved out of `admin/schedule.js` (which now only
handles Today/Tomorrow, unchanged, plus the five-tab orchestration) and
into `admin/calendar-views.js` alongside Month/Year, since it now needs the
exact same "compact overview + shared day-panel-on-selection" pattern those
two already established.

## 4. Investigation — "completed job cannot be moved to another past date"

**Root cause: no code bug found in this path.** Extensive investigation —
static code trace, the *existing* (already-passing, pre-dating this stage)
regression test at `tests/phase3c-job-editing.test.js`'s "the exact
historical floor date is accepted as a changed date on a completed job",
and a live, read-only empirical check against a real Production booking
(Charity Smith, `status: "completed"`, `appointmentDate: "2026-09-15"`) —
all independently confirm the exact rule the owner wants is **already
implemented correctly** in both layers:

- **Server** (`api/admin/booking.js`'s `handleUpdate()`): for a completed
  job, a changed date is accepted iff `HISTORICAL_FLOOR_ISO <= date <=
  todayIso` — verified by reading the current, unmodified code at lines
  590-604.
- **Client** (`admin/booking-edit.js`'s `render()`): for a completed job,
  `appointmentDateInput.min = HISTORICAL_FLOOR_ISO` and `.max = todayIso`
  — verified live on the real Charity Smith booking:
  `{"value":"2026-09-15","min":"2026-01-01","max":"2026-09-17"}`, and
  setting the input to `"2026-08-20"` reported `validity.valid: true`.

New regression tests were added (`tests/phase3c-job-editing.test.js`,
"Stage 2.4.1" section) that directly reproduce the owner's own example —
a completed Sep 15 job successfully PATCHed to Aug 20, and separately to
Mar 12 — both `200`, both writing the new date. A completed job dated
*today* moving to a valid past date also `200`s. Moving before the floor
or into the future still correctly `400`s. All pre-existed as correct
behavior; these tests only pin it down so it can never silently regress.

**Most likely actual explanation**, given the code proves the completed-job
rule already works: the job the owner attempted to edit was **not yet
marked `status = "completed"`** in the database at the time — e.g. a
`"booked"` job whose date had already passed but hadn't been flipped to
Completed yet. The date-editing contract has *always* deliberately
restricted a **non-completed** job's changed date to `>= today`
(`docs/phase-3/job-editing-proposal.md`'s original design, restated in
`handleUpdate()`'s own header comment) — a real, pre-existing "booked job
with an already-past date" can have every other field edited freely (the
same-date bypass), but not moved to a *different* past date, by design. A
new regression test, "a booked job whose date has already slipped into the
past still CANNOT be moved to a DIFFERENT past date (not marked
completed)", pins down this intentional distinction so it's documented as
deliberate, not accidentally conflated with the completed-job bug report.

**No code change was made to the validation logic** — the stated Desired
Rule for completed jobs is already met exactly as specified, confirmed by
both new tests and live Production data. If the owner hits this again on a
specific job, the fastest check is simply: is that job's status actually
"Completed" (visible on its detail page) at the moment of editing? If not,
marking it Completed first (via the existing status picker — a separate,
deliberate action, never automatic) unlocks the wider historical date
range, matching the documented contract.

## 5. Investigation — Google address autocomplete not working

**Root cause: absent configuration — exactly the documented, expected
state, not a bug.** Confirmed live: `curl
https://www.milehighjunkremoval.net/admin/google-maps-config.js` returns
the file exactly as shipped in Stage 2.4, with `window.
ADMIN_GOOGLE_MAPS_API_KEY = "";` — still an empty string. This was always
the deliberate default (see Stage 2.4's own report: "ships with an empty
key — no credential requested from or pasted by the owner"), and the
Stage 2.4 Production verification pass already found and reported this
exact state days ago (zero Google script load, `isConfigured(): false`).

Ruled out, specifically:
- **Google Cloud API not enabled / referrer restriction wrong** — moot;
  the code never even attempts a network call when the key is empty
  (`hasConfiguredKey()` short-circuits `loadPlacesLibrary()` before any
  `fetch`/script tag), so a Cloud-side misconfiguration can't be the cause
  yet — there's no key to be misconfigured.
- **Script/library loading issue** — same reasoning; no load is attempted.
- **Places API initialization / DOM integration bug** — can't be
  exercised without a real key either way; the code path is unchanged
  since Stage 2.4's implementation and test coverage (23 tests in
  `tests/phase3c-stage2.4-address-and-prefill.test.js`, still passing
  unmodified), and was built against the documented modern Places API
  (New) surface. This cannot be end-to-end verified without a live key —
  an inherent limitation disclosed at Stage 2.4 and unchanged now — but no
  implementation defect was found in code review this round either.
- **"Production config file still has empty placeholder"** — **this is
  the actual cause**, confirmed directly.

**No code change was made or needed.** Per the stage instructions, no key
was invented, hardcoded, or requested from the owner in chat. What the
owner needs to do, unchanged from Stage 2.4's original report (repeated
here for convenience):

1. In Google Cloud Console, create an **API key** restricted to:
   - **Application restriction**: HTTP referrers —
     `https://www.milehighjunkremoval.net/*` and
     `https://milehighjunkremoval.net/*` for Production, plus each Preview
     URL as needed for testing.
   - **API restriction**: only **Maps JavaScript API** and **Places API
     (New)** — nothing else.
2. Enable both of those APIs on the project.
3. Replace the empty string in `admin/google-maps-config.js`'s
   `window.ADMIN_GOOGLE_MAPS_API_KEY = ""` with the real key, directly in
   the repository, then commit/deploy that one-line change. Nothing else
   needs to change.

Manual address entry continues to work with zero configuration — verified
again this stage (see §7).

## 6. Public-site / performance isolation audit

Confirmed by direct source inspection (`grep` across every `.html` file):

- `calendar-views.js` and `quick-expense.js` are loaded **only** by
  `admin/index.html` (the Schedule page) — nowhere else.
- `address-autocomplete.js` and `google-maps-config.js` are loaded
  **only** by `admin/booking-new/index.html`, `admin/booking-past/index.html`,
  and `admin/booking-edit/index.html` — the three forms that actually use
  address autocomplete.
- Zero references to any of these four files anywhere outside `admin/` —
  confirmed by grepping the public homepage (`index.html`) and the public
  booking flow (`book/index.html`): their only `<script>` tags are Google
  Tag Manager (pre-existing analytics, untouched), `nav.js`, and (on
  `/book/`) `book.js` — the same scripts as before this entire Phase 3C
  CRM project began.
- No customer-facing page downloads any Calendar/Expense/Google-Places
  code. The CRM cannot slow the main website or the public booking flow —
  they share nothing.

## 7. Tests

**464 tests total** (441 pre-existing baseline + 6 date-editing regressions
+ 17 new Schedule-UX regressions), 0 failed:

- `tests/phase3c-job-editing.test.js` (+6) — the Stage 2.4.1 date-editing
  regressions described in §4: the owner's exact Aug 20/Mar 12 examples,
  today→past for a completed job, floor/future still rejected, and the
  intentional non-completed-job counterpart.
- `tests/phase3c-stage2.4.1-schedule-ux.test.js` (new, 17) — source-pattern
  checks (this project's established approach for client-only rendering
  behavior, see that file's header) confirming: the day-panel's exact
  append order (date → expenses → action → jobs), the shared `renderDayPanel()`
  used by both Month and Week, the new compact card's hierarchy and absence
  of a Call/Text/Directions row, Today/Tomorrow's fuller card left
  untouched, the week overview's unconditional 7-row loop, the
  `WEEK_ROW_MAX_JOB_LINES` cap with "+N more", the per-row click handler
  reading the date from `event.currentTarget` (not a closed-over loop
  variable), Prev/Next/Jump-to-this-week preserved and still server-driven,
  no new API endpoint, today auto-selection, and the "no innerHTML"
  discipline.
- Interactive behavior (all 7 days rendering including empty ones, the
  compact-lines cap and "+1 more" indicator, tapping a week day switching
  the selected-day panel, the reordered Month/Week day-panel hierarchy)
  additionally verified directly in a local browser session with the fetch
  API mocked to the real endpoint's response shape, at a 375px mobile
  viewport.

## 8. Function count

**Unchanged, exactly 12/12.** No file under `api/` was touched this stage
— every change in items 1-3 is client-rendering-only, and items 4-6 were
investigations that concluded no server-side fix was needed.
