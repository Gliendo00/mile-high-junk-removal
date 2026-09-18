# Phase 3C Stage 2.4.2 — Schedule UX Polish

Post-Stage 2.4.1 owner review of the live Production CRM asked for a
Schedule UI/UX polish pass — not a new architecture phase. Built on feature
branch `phase-3c/stage2.4.2-schedule-ux-polish` from production baseline
`ee2585f` (`ee2585fc35b5d6153ad5a5fa5eb50c5be4ed18e7`).

## 1. Yesterday tab

`api/admin/bookings.js`'s `VALID_RANGES` gained `"yesterday"` and `"day"`.
`handleSchedule()` computes yesterday the same way it already computes
tomorrow (`addDaysIso(todayIso, -1)`, Denver-local). If that date falls
before the historical floor (`HISTORICAL_FLOOR_ISO`, 2026-01-01 — only
possible when "today" itself is at or just past the floor), the response
carries `beforeHistoricalFloor: true` with an empty `jobs` array and **no
query is run** — handled cleanly rather than querying an invalid range.
`admin/schedule.js` shows a dedicated "No historical records before January
1, 2026." message for that case and hides the relocated Quick Expense bar
(an expense on that date would be rejected anyway).

`"day"` is a second new range, `?range=day&date=YYYY-MM-DD` — not a tab,
it backs the previous/next-day arrows (see §5). Bounded the same way
Month/Year already are: rejected before the historical floor, rejected past
`MAX_FUTURE_YEARS`.

Zero schema changes; zero new serverless functions (still handled inside
`api/admin/bookings.js`, still 12/12 total).

## 2. Job card visual separation

`.admin-schedule-card` (Today/Tomorrow/Yesterday all reuse this exact same
card/markup — nothing new to build for Yesterday here) gained a
slightly-darker border (`--color-neutral-300` instead of `--color-neutral-200`,
which read as near-white against the page's pale-green `--admin-tint`
background) and a very light `box-shadow`. `#schedule-list` gained a bit
more inter-card gap (12px vs the denser Requests list's 8px). Information
hierarchy inside the card (time/status/client/service+city/price/actions)
is completely unchanged.

## 3. Week: genuinely horizontal

`admin/calendar-views.js`'s `renderWeekOverview()` JS is **unchanged** —
only `.admin-week-overview`/`.admin-week-day-row` in `admin/admin.css`
changed, from a vertical stacked list (`flex-direction: column`, each row
`width: 100%`) to a horizontal strip (`flex-direction: row`,
`overflow-x: auto`, each day a `flex: 1 1 128px` column with a top accent
border instead of a left one). On a wide-enough screen the 7 columns simply
grow to fill the available width (flex-grow); on a phone the strip scrolls
horizontally, contained to itself — confirmed directly via
`document.documentElement.scrollWidth` staying exactly at the viewport
width while `#week-overview`'s own `scrollWidth` exceeded its `clientWidth`
(944px vs 347px at 375px viewport). Every existing Week behavior (Prev/
Next/Jump-to-current-week, auto-select-today, tapping a day) is untouched —
same API contract, same JS, only the CSS changed.

## 4. Quick Expense relocated

New persistent `#quick-expense-bar` in `admin/index.html`, directly under
the Schedule range tabs. `admin/quick-expense.js` gained `showBar(dateIso)`/
`hideBar()`, which mount into (or clear) that one container — the same
`mount()` internals as before (categories/POST/sheet all byte-identical),
just a new home and a heading that now names its own date ("Quick Expense —
Thu, Sep 17") since it's no longer sitting directly under a per-range date
heading. `admin/calendar-views.js`'s `renderDayPanel()` no longer mounts
Quick Expense itself; `selectWeekDate()`/`selectMonthDate()` call
`showQuickExpenseFor(iso)` instead, and every load/show path (`showWeek()`,
`showMonth()`, `showYear()`, `loadWeek()`, `loadMonth()`) hides the bar
first so a stale date's controls never linger while new data loads. Year
never shows it (no single day is ever "selected" in Year).
`admin/schedule.js`'s `applyDayResult()` shows it for whichever date
Today/Tomorrow/Yesterday/day-nav just resolved, always from the server's
own `startDate` — never a client-guessed date.

## 5. Previous/next-day navigation

New `#day-nav` row in `admin/schedule.js`'s Today/Tomorrow/Yesterday view
(`< Wednesday, Sep 17, 2026 >`), and the same arrows added around
`renderDayPanel()`'s heading in `admin/calendar-views.js` for Week/Month's
selected-day panel. Both step by exactly one calendar day
(`addDaysIso(iso, ±1)`), refuse to go before the historical floor (Previous
is `disabled` there), and correctly cross week/month boundaries: Week's
`navigateWeekDayBy()`/Month's `navigateMonthDayBy()` load the adjacent
week/month first (via `loadWeek()`/`loadMonth()`'s new optional
`selectAfterLoad` param) and then select the target date once it arrives,
rather than ever showing a date whose data was never fetched. Today/
Tomorrow/Yesterday's own arrows call the new `?range=day&date=` mode (§1).
No new page or route.

## 6. Month grid cleanup

`.admin-month-grid-cell` dropped its forced `aspect-ratio: 1/1` (which
turned into an enormous square with a tiny centered number once the
`.admin-main` column grows to 1040px on desktop) in favor of a compact,
content-sized cell: `align-items/justify-content: flex-start` puts the date
number top-left with the job-count badge just beneath it, `min-height: 42px`
still keeps a comfortable touch target. Everything else — outside-month
muting, today/selected indication, job-count badges, tap-to-select,
Prev/Next month — is unchanged. New `#month-current-wrap`/`#month-current-btn`
("Jump to today") mirrors Week's existing "Jump to this week" pattern
exactly.

## 7. Address autocomplete: ZIP preview (mid-task addendum)

Raised by the owner mid-session, separate from the Schedule work above but
touching the same "already production-verified, don't create unnecessary
Google work" integration: the ZIP code wasn't visible in the autocomplete
**dropdown** while searching, only after selecting — reps need to read it
back to a client on the phone before picking an address. Google's
lightweight `AutocompleteSuggestion` prediction never carries a ZIP (only a
Place Details fetch does), so `admin/address-autocomplete.js` now fetches
Details for each visible suggestion and fills in a "ZIP xxxxx" line once
resolved. Two deliberate cost controls given this is now up to N
individually-billable Place Details calls per rendered list, not the one
session-priced call this component previously made only for the eventually
selected suggestion:
- A separate `ZIP_ENRICH_DELAY_MS` (350ms) delay before starting these
  fetches, cancelled entirely if a newer keystroke's render supersedes the
  list first — a fast typist is never charged for detail lookups on a
  suggestion list they typed straight past.
- A `placeId`-keyed cache (`addressCache`) shared between the preview fetch
  and the click-to-select handler (refactored into `fetchMappedPlace()`),
  so a suggestion already previewed is never fetched a second time on
  selection.

`applySelection()` was refactored to take the already-mapped
`{address, city, state, zip}` object directly (previously it received a raw
Google `Place` and mapped it itself), since both the cache-hit and
cache-miss paths now produce that same shape upstream.

## Scope discipline

No schema migration. No new serverless function (still 12/12). No SMS/
revenue/reporting work. No changes to public `/` or `/book/` (confirmed:
neither references any Schedule/Quick-Expense/day-nav file). Google
Maps key delivery/security untouched — the ZIP-preview addendum reuses the
exact same `?view=google-config` key-fetch and `fetchFields` field mask
(`["addressComponents"]` only) already in place.

## Tests

523/523 passing (496 pre-existing — 2 of Stage 2.4.1's own assertions
updated in place to match the intentional Quick-Expense-relocation and
day-panel-arrows changes, not weakened — plus 37 new in
`tests/phase3c-stage2.4.2-schedule-polish.test.js`).
