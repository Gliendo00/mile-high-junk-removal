# Time Window Compatibility

Status: **documentation only — no data migration, no new code.** Confirmed
by reading `api/book.js` (server-side source of truth for what's
accepted/labeled) and `book/book.js` (client-side wizard, which defines the
identical set independently — the two are kept in sync by hand today, see
"Note for Phase 2" below).

## Legacy values (no longer written by the current wizard, but still valid)

These four broad windows were used before the 2-hour-window date & time UI
shipped. `api/book.js` explicitly keeps them valid for **every** service
type for backwards compatibility with bookings submitted under the old UI
(see `LEGACY_TIME_WINDOWS` and the comment above `TIME_WINDOWS_BY_SERVICE`
in `api/book.js`).

| Value | Label |
|---|---|
| `morning` | Morning (8am–11am) |
| `midday` | Midday (11am–2pm) |
| `afternoon` | Afternoon (2pm–5pm) |
| `evening` | Evening (5pm–7pm) |

## Current values (2-hour windows)

Every current booking writes one of these. `startHour` is the America/Denver
hour (0–23) the window begins — this is what `api/book.js` uses server-side
to reject a same-day window whose start time has already passed
(`isTimeWindowExpired()`).

| Value | Label | Start hour (America/Denver) |
|---|---|---|
| `w_0400_0600` | 4:00 AM – 6:00 AM | 4 |
| `w_0600_0800` | 6:00 AM – 8:00 AM | 6 |
| `w_0800_1000` | 8:00 AM – 10:00 AM | 8 |
| `w_1000_1200` | 10:00 AM – 12:00 PM | 10 |
| `w_1200_1400` | 12:00 PM – 2:00 PM | 12 |
| `w_1400_1600` | 2:00 PM – 4:00 PM | 14 |
| `w_1600_1800` | 4:00 PM – 6:00 PM | 16 |
| `w_1800_2000` | 6:00 PM – 8:00 PM | 18 |
| `w_2000_2200` | 8:00 PM – 10:00 PM | 20 |

## Which current windows apply to which service type

`api/book.js`'s `TIME_WINDOWS_BY_SERVICE` map (mirrored client-side by
`ARRIVAL_WINDOWS` / `DUMPSTER_DELIVERY_WINDOWS` in `book/book.js`):

- **`junk_removal` and `light_demo`**: all 9 current windows above (4am–10pm), plus all 4 legacy windows.
- **`dumpster_rental`**: all current windows **except** `w_0400_0600` and `w_2000_2200` (delivery is 6am–8pm only), plus all 4 legacy windows.

## How a future admin portal should display these

Every booking record's `time_window` value is a raw key like `w_0800_1000`
or `morning` — never a display-ready string. Both `api/book.js`
(`TIME_WINDOW_LABELS`) and `book/book.js` (`windowLabels`) already solve
this today by merging the legacy label map and the current-window label map
into one lookup object keyed by every valid value, current or legacy, and
falling back to the raw key itself if somehow given something unrecognized
(`TIME_WINDOW_LABELS[value] || value`).

**Recommendation for Phase 2:** the admin portal should do exactly the same
thing — build one lookup table containing all legacy + current labels (the
full set documented above) and use it for every booking regardless of how
old it is. A booking from before the 2-hour-window UI shipped should render
as "Morning (8am–11am)", not as the raw string `morning` and not as an
error. No translation/migration of the stored value is needed for this —
the existing raw value is sufficient input to a label lookup.

**No data migration is proposed or needed.** Old bookings keep their
original `morning`/`midday`/`afternoon`/`evening` value forever; only the
*display* layer needs to know how to render it.

## Note for Phase 2: duplicated definitions

The window ids, labels, and per-service allow-lists are currently defined
twice independently — once in `api/book.js` (server-side validation) and
once in `book/book.js` (client-side UI) — and are not imported from a shared
module. They agree today (verified by comparing both files), but nothing
enforces that they stay in sync if either is edited in isolation later. Not
a Phase 1 concern to fix (no behavior is broken), but worth a shared
constants module in Phase 2 once an admin portal needs this same list a
third time.
