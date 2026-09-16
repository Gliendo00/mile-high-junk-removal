# Fill-Time Safety Review

Scope: the "minimum fill time" bot check added in this phase
(`isSubmittedTooFast()` in `api/_lib/spam-protection.js`, `MIN_FILL_TIME_MS
= 3000` in both `api/book.js` and `api/contact.js`). This check treats a
form submitted within 3 seconds of its page loading as a likely bot.

**Current behavior differs by endpoint (as of the change request below):**

- **`/api/book`**: an implausibly fast submission is a **hard signal** —
  treated identically to a tripped honeypot, responding with a faked
  success (no data is saved, no email is sent). Unchanged from the original
  Phase 1 implementation; see finding #2 for why this endpoint's shape makes
  that safe.
- **`/api/contact`**: an implausibly fast submission is a **soft signal**
  — the submission is still validated, saved, and emailed normally, just
  with `[Fast Submission]` prepended to the notification email's subject
  line and a `console.warn` logged server-side. Only a tripped honeypot is
  still a hard rejection on this endpoint. This was changed after the
  initial Phase 1 review below identified a real false-positive risk
  specific to this form — see "Resolution" under finding #2.

**One real bug was found during the initial review and was fixed
immediately** (not deferred) — see "Client/server clock skew" below. A
second finding (very-fast-but-legitimate submissions on `/contact`) was
initially left as a flagged decision and has since been resolved per your
direction — see finding #2.

## What changed as a result of this review

The original implementation sent an **absolute client timestamp**
(`Date.now()` at page load) and had the server compute
`elapsed = server's Date.now() - clientTimestamp`. That was wrong: it
silently compared two different clocks.

**The fix:** the client now measures its own elapsed duration using
`performance.now()` (a monotonic clock local to the page, unaffected by the
system clock being changed) and sends that duration directly as `elapsedMs`.
The server just checks `elapsedMs < 3000` — it never touches its own clock
for this comparison anymore. See `nowMs()` in `book/book.js` and
`contact.html`, and the updated `isSubmittedTooFast()` in
`api/_lib/spam-protection.js`. This is covered by the local test suite
(`tests/phase1-api.test.js`) and by additional targeted assertions run
during this review (see "Testing performed" below).

## Findings

### 1. Client/server clock skew — FIXED

**Before the fix:** if a customer's device clock ran even a couple of
seconds fast (not rare — unsynced clocks, VMs, manual clock changes, timezone/DST
misconfiguration all produce this), the server would compute an artificially
small "elapsed" time for a completely normal, unhurried submission. Example:
a real customer takes 4 real seconds filling out the contact form, but their
clock is 1.5 seconds fast — the server would see `elapsed ≈ 2.5s`, under the
3-second threshold, and **silently discard the submission while showing the
customer a success message.** That's the worst kind of false positive for a
business: a real lead vanishes and nobody — not the customer, not the
business — gets an error telling them something went wrong.

**Why the fix works:** by measuring the duration entirely with the
browser's own `performance.now()` and never comparing it to the server's
clock, there is no cross-clock comparison left to be thrown off by drift.
The server trusts only "how much time did the browser say elapsed," which
is internally consistent regardless of what wall-clock time either machine
thinks it is.

**Residual risk:** a bot could lie about `elapsedMs` (send a large fake
number). This is not a regression — the previous absolute-timestamp version
had the exact same weakness (a bot could send a stale/fake old timestamp).
This check was never a hard security boundary; it's a best-effort signal
layered with the honeypot, same as before.

### 2. Very fast *legitimate* submission — real residual risk, flagged for a decision

**`/book` (the multi-step wizard): essentially safe.** `formLoadedAt` is
captured once, when the wizard's script first runs (step 1). Reaching the
final submit button requires clicking "Next" through five steps
in between, each a real rendered UI transition. It is not realistically
possible for a human (or a browser-automation-driven human, for that
matter) to complete that flow in under 3 seconds. This check is very
unlikely to ever false-positive on a real /book submission.

**`/contact` (the single-page quote form): a real, if narrow, risk.**
Looking at `contact.html`: only `Name`, `Phone`, and `Email` are marked
`required` — `Address` and `Message` are optional. A browser's own
form-autofill can populate name/phone/email in a single interaction, and a
fast user could then click "Get My Free Quote" in well under 3 real
seconds. This is a genuine human, not a bot, being measured as "too fast."

**Consequence if it happens:** same as the clock-skew bug — a real lead is
silently dropped with a success message shown, no error, no way for the
customer to know to try again.

**This was a design choice already implicit in the original spam-protection
work** (treating honeypot-tripped and too-fast identically, both as silent
fake-success), not something introduced by this review. It was flagged
because the consequence (a silently dropped real lead) is more severe on
the business than the alternative failure mode (a bot occasionally getting
through).

**Resolution — Option B implemented for `/contact` only.** Per your
decision, `/api/contact` no longer discards a fast submission. In
`api/contact.js`:

- `isHoneypotTripped(hp)` remains a hard rejection (silent fake-success, no
  Resend call) — unchanged, since a tripped honeypot has essentially zero
  false-positive risk.
- `isSubmittedTooFast(elapsedMs, MIN_FILL_TIME_MS)` is now checked
  separately, purely as a flag: when true, the request still runs through
  the normal required-field validation, the existing solicitation check,
  and the existing Resend send — the only difference is `[Fast Submission]`
  is prepended to the notification email's subject (stacking with
  `[Possible Solicitation]` if both apply, e.g.
  `[Fast Submission] [Possible Solicitation] New quote request from ...`),
  and a `console.warn` is logged server-side for visibility. No real lead
  can be silently dropped by this check on `/contact` anymore.
- Rate limiting, validation, the solicitation-pattern check, and the Resend
  call itself are all unchanged — only the fill-time consequence changed.

**`/api/book` was deliberately left unchanged.** Its multi-step-wizard shape
makes a false positive implausible (see above), and testing in this phase
found no regression, so the original hard-discard behavior (identical to
the honeypot path) still applies there. Lowering `/book`'s protection was
explicitly out of scope for this change.

Option A (lowering the threshold instead) was considered but not used —
Option B fully eliminates the false-positive consequence for `/contact`
rather than just narrowing its window, and better matches this codebase's
existing "flag, never block" precedent (the solicitation-pattern check).

### 3. Missing/malformed timestamp — safe

`isSubmittedTooFast()` explicitly treats `null`, `undefined`, non-numeric
values, and negative numbers as "unknown, not suspicious," returning
`false` (never blocks) in all of those cases. Verified with unit tests
covering `null`, `undefined`, `"abc"`, and `-500` — all correctly pass
through without being flagged. (One bug caught and fixed during this same
review: `Number(null)` evaluates to `0` in JavaScript, not `NaN` — an
initial version of the fixed check would have incorrectly treated an
explicit `null` the same as "submitted in 0ms," i.e. flagged it. Fixed by
checking for `null`/`undefined` explicitly before the numeric coercion. See
the comment directly above `isSubmittedTooFast()`.) In normal operation the
client always sends a real number, so this path only matters for malformed
or deliberately-adversarial requests, and it correctly does not punish them
with a false block.

### 4. Browser back/forward navigation and bfcache — safe by construction

Neither `book/book.js` nor `contact.html`'s inline script uses the History
API (confirmed by searching for `history.`, `pushState`, and `popstate` in
`book/book.js` — no matches). The wizard's step navigation (`goToStep()`)
only toggles which `<section>` is visible; it never creates a browser
history entry. So there is no "back button" state *within* the wizard to
worry about — clicking the browser's back button from any step in `/book`
navigates away from the page entirely, to whatever page the visitor was on
before.

That leaves two real scenarios:

- **Full reload** (browser back-navigates to `/book/` or `/contact.html`
  and does *not* restore from bfcache — e.g. cache was evicted, or the
  browser doesn't use bfcache for this navigation): the page's script runs
  fresh, `formLoadedAt`/`nowMs()` resets to "now," and the form fields are
  empty (no framework-level form-state restoration exists in this vanilla
  JS code). The customer has to refill everything, which takes real time.
  Not a risk.
- **bfcache restore** (the common case for back/forward in modern
  browsers): the entire JS execution context is frozen and later resumed —
  the page's script does **not** re-run, so `formLoadedAt` keeps its
  *original* value from whenever the page first loaded. `performance.now()`
  continues to advance in real wall-clock time even while a page is frozen
  in bfcache (this is standard, specified behavior — the timeline isn't
  reset or paused for bfcache), so the measured "elapsed" time on any
  eventual submit after a bfcache restore can only be *larger* than if the
  page had never been navigated away from at all. This can only make a
  bot-like false-positive *less* likely, never more.

**Not empirically browser-tested in this pass** (bfcache behavior is
consistent, specified, cross-browser behavior, not something specific to
this codebase, so this finding rests on how bfcache is documented to work
rather than a captured before/after measurement) — flagged here rather than
asserted as lab-verified, per your instruction to mark what wasn't actually
tested. If you want this empirically confirmed, it would require manually
driving real back/forward navigation in an actual browser (not something
the local Node-based test harness in `tests/phase1-api.test.js` can
exercise, since that harness never loads a real page).

### 5. Client clock *changes* mid-session — covered by the same fix as #1

A user manually changing their system clock while the tab is open, a laptop
waking from sleep with a corrected NTP time, DST transitions, etc. all only
matter if the timing check ever reads the *system* clock. Since the fixed
implementation measures elapsed time with `performance.now()` (which is not
tied to the system's wall-clock time-of-day at all — it's explicitly a
monotonic "time since this page started" timer, unaffected by the OS clock
being adjusted), none of these scenarios can affect the result. This is the
same underlying fix as #1, called out separately because you asked about it
specifically.

## Testing performed

All of the following were run locally in this session with no network
calls and no production Supabase access — see
[test-matrix.md](./test-matrix.md) for the full picture:

- Unit tests directly against `isSubmittedTooFast()`: just-under-threshold
  trips, exactly-at-threshold does not trip, negative/null/undefined/
  non-numeric never trip, exactly-0ms trips (a real bot signature).
- Full-handler integration tests (`tests/phase1-api.test.js`) covering a
  0ms-elapsed submission to `/api/book` (confirms the fake-success response
  and zero database/email side effects) and to `/api/contact` (confirms the
  opposite on purpose: a 200, a real Resend call still made, and
  `[Fast Submission]` present in the subject — i.e. flagged, not
  discarded), plus a normal-speed `/api/contact` submission confirming the
  flag is absent when it shouldn't apply.
- Manual confirmation in a real browser (via the Browser pane) that
  `performance.now()` is available and returns a number on both `/book/`
  and `/contact.html` as loaded from this repo's static files.

**NOT tested in this pass** (and why):

- **Real bfcache back/forward behavior in an actual browser** — reasoning
  documented above (finding #4), not empirically captured. Would need a
  manual multi-navigation browser session to observe directly rather than
  the Node-based handler tests used elsewhere in this review.
- **Real device clock manipulation** — would require actually changing a
  test machine's system clock, which wasn't done. The fix's correctness
  here rests on `performance.now()`'s documented behavior (it does not read
  the system clock), not on an observed clock-change experiment.
- **Real browser autofill on the live `/contact.html` page** — the
  "very fast legitimate submission" scenario in finding #2 is a reasoned
  risk based on reading which fields are `required` in the markup, not a
  captured recording of an actual autofill-and-submit happening in under 3
  seconds.
