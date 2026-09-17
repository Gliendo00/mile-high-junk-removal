# Known Issue — `api/book.js` accepts an invalid 2-letter state

Status: **documented, not fixed.** Discovered 2026-09-17 while building
Phase 3C Stage 2.1's admin job/client creation endpoints. Explicitly **out
of scope** for that work — `api/book.js` is the live, customer-facing
public booking endpoint, and per this project's standing convention (see
`api/_lib/booking-format.js`'s header) it is deliberately not touched by
admin-side changes. Recorded here as a follow-up for whenever public
booking validation is next reviewed, not bundled into any other change.

## The bug

`validateBooking()` in `api/book.js` sanitizes and validates the
customer's state in this order:

```js
const state = sanitizeText(customerIn.state, MAX.state).toUpperCase();
...
if (!/^[A-Z]{2}$/.test(state)) return { ok: false, error: "Please enter a valid 2-letter state." };
```

`MAX.state` is `2`. `sanitizeText(value, maxLen)` **truncates to `maxLen`
before** the regex check ever runs. So a customer who types a full state
name is silently truncated to its first two letters and then validated as
if that were already a real 2-letter code:

- `"Colorado"` → truncated to `"Co"` → uppercased `"CO"` → **passes** the
  regex and is stored as `"CO"`. Correct by coincidence (Colorado's own
  abbreviation happens to start with "Co"), not because the check worked.
- `"Texas"` → truncated to `"Te"` → uppercased `"TE"` → **passes** the
  regex (it's a syntactically valid-looking 2-letter code) and is stored
  as `"TE"` — **not a real US state abbreviation**, and not what the
  customer meant to enter.

Any full state name whose first two letters aren't its real postal
abbreviation is silently mis-stored rather than rejected. The validation
gives no signal that anything went wrong.

## Where else this pattern was caught and fixed

The same truncate-then-validate ordering was written into the two new
Stage 2.1 admin endpoints on first draft (copied from this exact code) and
was caught by `tests/phase3c-stage2-new-job.test.js`. Fixed in
`api/admin/booking.js` and `api/admin/client.js` by validating the
sanitized-but-untruncated value's shape first, and only treating the
result as the stored value once it already matches `/^[A-Z]{2}$/` — see
those files' `serviceStateRaw`/`stateInput` handling. `api/book.js` itself
was left unmodified, per the scope boundary above.

## Suggested fix (for whenever this is picked up)

Reorder `api/book.js`'s validation exactly the way the admin endpoints now
do it: sanitize with a generous max length (e.g. 40, just to bound and
strip control characters/tags), validate the 2-letter shape against that
untruncated value, and only then treat it as the stored `state`. This is a
one-line reordering, not a schema or contract change — the accepted input
shape (a real 2-letter code) doesn't change, only what happens with
already-invalid input (rejected with the existing error message, instead
of silently corrupted).

## Risk / impact

Low-severity, address-quality issue, not a security issue — bounded to
whatever a customer literally typed into the state field on the public
booking form. Checked directly against the live form
(`book/index.html:421-422`): the state field is a plain text input,
**`<input type="text" maxlength="2" value="CO" style="text-transform:uppercase">`**,
not a dropdown — but the `maxlength="2"` attribute already stops a real
person from typing more than two characters in the first place, and
`book/book.js`'s own client-side check (`book.js:626`,
`/^[A-Za-z]{2}$/.test(...)`) validates the raw input with no truncation
bug of its own. So in practice this endpoint's server-side bug is only
reachable via a direct API call that bypasses the form entirely (e.g. a
raw request to `POST /api/book`), not through normal use of the live site.
Still worth the one-line fix next time this file is touched, since a
defense-in-depth server-side check that can be silently fooled isn't
actually doing its job. Recorded now, while fresh, rather than left to be
rediscovered.
