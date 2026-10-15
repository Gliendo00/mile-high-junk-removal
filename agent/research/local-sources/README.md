# Curated official local-source evidence (Phase 10)

One JSON file per fetch, each matching the shape
`agent/lib/local-source-evidence.js`'s `makeLocalSourceEvidence()`
validates (`sourceUrl`, `sourceDomain`, `authorityClass`, `locality`,
`topic`, `discoveryMethod`, `retrievedAt`, `extractedSnippet`,
`expectedTemporality`, `limitations`, `robots` — see that file for the
full field list).

These files are produced by
`node agent/cli.js --fetch-local-source-strict=<registry-entry-id>` (see
`agent/lib/local-source-fetch.js`) — a separate, explicit,
network-touching step, never `agent/runner.js` itself, which has no
network access by design. A fetch may only ever target a URL already
declared in `agent/context/local-source-registry.json` — a small,
human-curated, human-VERIFIED list — never an arbitrary or
caller-supplied URL.

This is **not** a `research.js` result: it carries no `verdict`,
`confidence`, or `recommendation`. It is a bounded, mechanical record
proving retrieval happened — a starting point for a human (or Claude
session) to read and, if warranted, turn into an actual `research.js`
result with a real judgment call, not a replacement for that judgment.
`agent/lib/decision.js` never reads this data, and it is never merged
into `report.firstPartyEvidence`, `report.firstPartySignals`, or
`agent/research/results/` — see `report.js`'s own, separate
`localSourceEvidence` section.

This directory is intentionally empty on a fresh checkout — same posture
as `agent/research/firstparty/` before its first real fetch: no evidence
should ever be fetched or manufactured just to fill this folder.
