# First-party evidence (Search Console + GA4)

One JSON file per targeted fetch, each an array of one or more objects
matching the shape `agent/lib/firstparty-evidence.js`'s
`makeFirstPartyEvidence()` validates (`source`, `metric`, `scope`,
`window`, `observed`, `context`, `limitations` — see that file for the
full field list).

These files are produced by `node agent/cli.js --fetch-firstparty=<request.json>`
(see `agent/lib/firstparty-fetch.js`) — a separate, explicit step a
research-capable orchestrator session runs when a specific finding or
research question actually warrants a targeted Search Console / GA4 /
URL Inspection query. Never by `agent/runner.js` itself, which has no
network access by design (see `agent/README.md`'s Phase 6 section).

`agent/lib/firstparty-intake.js` reads every `*.json` file in this
directory on each run and attaches matching entries to the finding they
inform, by `findingKey` (see `agent/lib/findings.js`'s `makeKey`) —
**strictly for report/provenance display**. `agent/lib/decision.js`
never reads this data; a metric can never independently produce
`PROPOSE_CHANGE` or `APPLY_SAFE_FIX` (see
`tests/agent-firstparty-safety.test.js`).

This directory is intentionally empty on a fresh checkout — same posture
as `agent/research/results/` before Phase 3's first real
research-assisted finding, and `agent/research/completed-jobs/` before
any real completed-job data existed: no evidence should ever be fetched
or manufactured just to fill this folder. Search Console/GA4 credentials
are also not configured in this environment — see
`agent/README.md`'s Phase 6 "Credentials" section for the exact owner
setup steps still required before any real fetch can succeed.
