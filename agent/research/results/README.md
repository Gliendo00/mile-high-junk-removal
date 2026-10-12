# Research results

One JSON file per research result, each matching the shape
`agent/lib/research.js`'s `makeResearchResult()` validates — see that
file for the required fields (`findingKey`, `question`, `source`,
`sourceType`, `evidence`, `confidence`, `limitations`, `verdict`,
`recommendation`).

These files are produced by whoever (or whatever) actually performs the
research — in Phase 2 that's a Claude-driven session with web
search/fetch available, run deliberately and separately from the offline
`agent/runner.js` — never by the runner itself, which has no network
access by design.

`agent/lib/research-intake.js` reads every `*.json` file in this
directory on each run and attaches matching results to the finding they
answer, by `findingKey` (see `agent/lib/findings.js`'s `makeKey`).

A reasonable filename is the `findingKey` itself, slugified, e.g.
`structural-inconsistency__some-page.html.json` — but the filename itself
is never read for meaning; only the file's own `findingKey` field is used
to match it to a finding.

## Phase 3 update

Phase 3's expanded audit surface (see `agent/lib/content-gap-audit.js`)
found one genuine category-C opportunity on the real site —
`blog-seasonal-cleanout-guide.html`'s FAQ is noticeably thinner than its
comparable siblings — and this directory now holds the two real research
results written for it, from actual web research performed in a
Claude-driven session (not seeded/fabricated to demonstrate the
mechanism): one general industry-FAQ-pattern observation (deliberately
low-confidence — SERP presence isn't search volume), and one
Denver-specific, official-government result (the City and County of
Denver's LeafDrop leaf/pumpkin composting program) that actually tipped
the finding's decision to `PROPOSE_CHANGE`. See `agent/README.md`'s
"First research-assisted run (Phase 3)" section for the full writeup.

Phase 2's note still applies to every OTHER finding on this run: no
research was warranted, and none was manufactured just to fill this
directory.
