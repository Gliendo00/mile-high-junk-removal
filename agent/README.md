# Site Improvement Agent — Phase 1 (foundation)

An autonomous system that inspects this site's own public marketing pages,
evaluates potential improvements against a risk model, and records exactly
what it found (and, for a narrow whitelist, did) in an append-only,
git-tracked activity log. Phase 1 is **research + classification + a
single narrow auto-fix**, not broad autonomous editing — see "What this
deliberately cannot do yet" below.

## Core philosophy

- "No worthwhile change today" is a valid, loggable result.
- A finding may never exist without evidence (`agent/lib/findings.js`
  enforces this at construction time — `makeFinding()` throws if `pages`
  or `evidence` is empty).
- Nothing here fetches the network or calls an external API. Everything
  is derived from files already in this repo. This makes every finding
  either true-by-construction or a bug in the agent — never a
  hallucination.
- Content (titles, descriptions, FAQ copy, new pages) is never written by
  this system in Phase 1. It only ever recommends, with evidence, that a
  human (or a future research-capable step) write it.

## How to run it

```bash
node agent/cli.js                 # dry-run (default) — never writes anything
node agent/cli.js --dry-run       # same, explicit
node agent/cli.js --apply-safe    # also applies the narrow auto-fix whitelist
node agent/cli.js --json          # print the full run record as JSON
```

`--apply-safe` refuses to apply anything (falls back to proposing only)
if `git status --porcelain` is not empty, so an apply run's diff is always
attributable to exactly that run — never mixed with unrelated
in-progress changes.

## Pipeline

```
scan.js            -> PageRecord[] (title, description, canonical, h1s,
                       jsonLd, internalLinks, wordCount — all literally
                       read from each top-level *.html file)
      |
      v
link-audit.js       -> findings about broken/redirect-hop internal links,
seo-audit.js           orphan pages, sitemap/robots conflicts, missing or
consistency-audit.js   duplicate metadata, missing schema/H1, and
                       structural outliers among comparable page groups
      |
      v
risk.js             -> assigns category (A-E) + riskLevel + autoApplyEligible
      |
      v
runner.js           -> (apply-safe only) applies the narrow whitelist via
                       lib/apply/rewrite-href.js, then always appends one
                       record to history
      |
      v
agent/history/log.ndjson   (git-tracked, append-only, one JSON object per run)
```

## Risk model

Every finding is assigned exactly one category:

| Category | Meaning | Auto-apply eligible? |
|---|---|---|
| A | technical/site-quality issue | only the one whitelisted fix type |
| B | clear low-risk improvement | only the one whitelisted fix type |
| C | content opportunity requiring research | never |
| D | major/high-risk SEO change | never |
| E | insufficient evidence — do nothing | never (also the fail-safe default for any unrecognized finding type) |

The full type -> category/risk mapping lives in `agent/lib/risk.js`.

### Auto-apply whitelist (Phase 1: exactly one fix type)

`autoApplyEligible` is **not** the same as "risk is low." It additionally
requires the finding to carry a mechanical `autoFix` descriptor, and only
one fixer is registered: `agent/lib/apply/rewrite-href.js`, which rewrites
one exact `href="..."` string to another exact string in one file. It is
used only for:

- `redirect-hop-internal-link` — a page links to a URL that itself
  redirects (per `vercel.json`) to its real destination; the fix points
  the link directly at the destination.
- `broken-internal-link-fixable` — a page links to a path that doesn't
  exist, but exactly one file matches it case-insensitively (an
  unambiguous typo).

Both `to` values are derived entirely from on-disk facts (vercel.json's
own redirect table, or an exact filename already in the repo) — never
guessed. The fixer itself refuses (rather than guessing) if the target
string appears zero times or more than once in the file.

Every other finding type — including every category-A "technical" finding
except those two — is propose-only in Phase 1. Metadata text
(titles/descriptions), FAQ copy, and any new content are content
decisions this system does not make.

### vercel.json rewrites vs. redirects

One page, `privacy-policy.html`, is served under a clean URL
(`/privacy-policy`) via a **rewrite**, not a redirect — the opposite of
every other page on the site, which is canonical at its `.html` filename.
`link-audit.js` and `seo-audit.js` both account for this via
`buildRewriteCleanUrlMap()` so that page doesn't generate false
broken-link/canonical-mismatch findings. If another page is ever served
this way, it is picked up automatically from `vercel.json` — nothing here
is hardcoded to `privacy-policy.html` specifically.

## Private vs. publication-safe business context

The product plan for this agent eventually wants to use real completed-job
operational notes (e.g. "hot tub removal in Wheat Ridge, backyard access
was easy") as safe signal for future content opportunities. **That CRM
integration does not exist yet** and this phase does not build it.

What Phase 1 does build is the boundary it will have to respect:
`agent/lib/business-context.js` defines a private-field blocklist
pattern, a narrow publication-safe allowlist (`serviceType`, `city`,
`accessNotes`, `outcomeTag`), and `redactForPublication()` /
`assertNoPrivateLeakage()` helpers, proven out with synthetic fixture data
in `tests/agent-business-context.test.js`. When the CRM's "how'd it go?"
note is built, it should produce objects shaped like that module's
`syntheticRawJobNote` example and pass them through this module — not
reimplement redaction inline.

## Activity history

`agent/history/log.ndjson` is a plain git-tracked file — one JSON object
per line, one line per run (dry-run or apply-safe), appended by
`agent/lib/history.js`. Each record carries: `runId`, `timestamp`, `mode`,
a `summary` (pages scanned, finding counts by category, applied vs.
proposed), the full `findings` array (each with its evidence and
recommendation), and `validation` notes.

This is deliberately a file, not a database table, for Phase 1: it needs
no migration, it's reversible and diffable through the same git workflow
as every other change to this site, and it costs nothing to query from a
future read-only endpoint (the deployed site already bundles its own
repo). `history.buildDashboardSummary(runs)` reduces the log into the
exact "Today: - Improved X - Fixed Y - Researched Z — no change made"
shape the CRM Home dashboard's "Website & Marketing Activity" row is
waiting for (see `admin/home/index.html`'s "Not connected yet" status and
`admin/home.js`'s header comment) — nothing calls it yet; that's Phase 2
work (see below), done once there's a real read path to wire it to
without adding a new serverless function (the Hobby plan is at 12/12 —
see `docs/phase-3/vercel-function-limit.md` — so this will need to fold
into an existing `api/admin/*.js` file's `?resource=`/`?action=` dispatch,
the same pattern every other stage in this project already uses).

## What this agent can currently inspect

- Every top-level `*.html` page's title, meta description, canonical tag,
  H1s, JSON-LD blocks, internal links, and word count.
- `vercel.json`'s redirects and rewrites, `sitemap.xml`, `robots.txt`.
- Cross-page consistency among the city/location pages (`*-junk-removal.html`).

## What research it can currently perform

Only **internal structural** research: comparing pages against each
other and against the site's own routing config. It has no network
access and no API keys, so it cannot (and does not pretend to) check
current search results, competitor pages, municipal disposal info, or
Search Console data. Where that kind of research would genuinely help —
e.g. a city page that structurally looks thin compared to its siblings —
it emits a category-C finding that says so explicitly and recommends
research, rather than fabricating the content itself.

## What it can currently change

Only the narrow auto-apply whitelist described above, and only in
`--apply-safe` mode, and only when the working tree is clean. Nothing
else is ever written to disk by this system.

## What this agent deliberately cannot change yet

- Any copy: titles, meta descriptions, headings, body content, FAQ text.
- Any new page.
- Any schema/structured-data authoring (only *absence* is flagged).
- Sitemap.xml / robots.txt edits (only flagged).
- Anything touching `admin/`, `api/`, or booking/payment flows — out of
  scope by design; this agent only ever reads top-level marketing pages.

## Tests

```bash
node tests/agent-findings-and-risk.test.js
node tests/agent-seo-and-consistency-audit.test.js
node tests/agent-link-audit.test.js
node tests/agent-apply-and-history.test.js
node tests/agent-business-context.test.js
node tests/agent-runner.test.js
```

All offline, no network, no mutation of real site content (the apply/fix
test uses a throwaway fixture file under `tests/fixtures/`, cleaned up
after; the runner tests that exercise `appendRun` use a temp file under
the OS temp directory, never the real `agent/history/log.ndjson`).

## Recommended Phase 2

1. **Close the apply loop**: after an `--apply-safe` run, re-scan and
   confirm the fixed finding is actually gone (a regression guard before
   anything is committed).
2. **Wire history into the CRM dashboard**: fold a read of
   `agent/history/log.ndjson` into an existing `api/admin/*.js` file's
   `?resource=` dispatch (no new serverless function — see the Hobby-plan
   note above) and replace `admin/home/index.html`'s "Not connected yet"
   row with `history.buildDashboardSummary()`'s output.
3. **A real external-research step**: a separate, explicitly-invoked mode
   (likely a Claude-driven run with web search/fetch available, not this
   offline CLI) that takes this run's category-C findings as its starting
   point and produces researched, evidence-backed category-C/D proposals
   — still never auto-applied.
4. **The completed-job CRM integration**: once the CRM actually collects
   a "how'd it go?" operational note, route it through
   `agent/lib/business-context.js` rather than building new redaction
   logic for it.
5. **Scheduling**: once Phase 2's dry-run quality is trusted, consider a
   recurring (e.g. weekly) dry-run via the existing Vercel cron mechanism
   or an external scheduler — still dry-run only until there's an
   approval workflow in the CRM for proposed changes.
