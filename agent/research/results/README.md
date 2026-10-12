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

This directory is empty as of Phase 2: the first research-assisted run
against the live site found zero findings that actually required external
research (see `agent/README.md`'s "First research-assisted run" section)
— a valid, honest outcome, not a gap to fill artificially.
