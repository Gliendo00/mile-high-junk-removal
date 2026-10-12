# Site Improvement Agent — Phase 1 + Phase 2

An autonomous system that inspects this site's own public marketing pages,
researches what genuinely needs external evidence, decides what (if
anything) is warranted, applies a narrow whitelist of safe mechanical
fixes, validates them, and records exactly what happened in an
append-only, git-tracked activity log that now also feeds the CRM Home
dashboard. See "What this deliberately cannot do yet" below for the hard
boundaries this system still respects.

## Core philosophy

- "No worthwhile change today" is a valid, loggable result — and so is
  "no research was warranted today." Both are judgment, not inaction.
- A finding may never exist without evidence (`agent/lib/findings.js`
  enforces this at construction time), and a research result may never
  exist without at least one observed, attributed evidence item
  (`agent/lib/research.js` enforces this the same way).
- The offline runner (`agent/runner.js`) never fetches the network or
  calls an external API. Everything it decides on its own is derived from
  files already in this repo — true-by-construction, never a
  hallucination. External research is a deliberately separate,
  explicitly-invoked step (see "External research" below).
- Content (titles, descriptions, FAQ copy, new pages) is never written by
  this system. It only ever recommends, with evidence, that a human (or a
  future content-writing step) write it.
- Do not waste research. A finding answerable from internal evidence
  alone never gets routed through the research layer.

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
scan.js              -> PageRecord[] (title, description, canonical, h1s,
                         jsonLd, internalLinks, wordCount — all literally
                         read from each top-level *.html file)
        |
        v
link-audit.js         -> findings about broken/redirect-hop internal links,
seo-audit.js             orphan pages, sitemap/robots conflicts, missing or
consistency-audit.js     duplicate metadata, missing schema/H1, and
                         structural outliers among comparable page groups
        |
        v
risk.js               -> assigns category (A-E) + riskLevel + autoApplyEligible
        |
        v
research-intake.js     -> attaches any already-committed research result
                         (agent/research/results/*.json) matching the
                         finding's stable `key`
        |
        v
decision.js            -> APPLY_SAFE_FIX / PROPOSE_CHANGE / RESEARCH_MORE /
                         NO_CHANGE / REJECT_OPPORTUNITY, with a reason
        |
        v
runner.js              -> (apply-safe only) applies APPLY_SAFE_FIX findings
                         via lib/apply/rewrite-href.js, then re-scans and
                         validates each one (validate.js), auto-reverting
                         any that didn't verify — then always appends one
                         record to history
        |
        v
agent/history/log.ndjson     (git-tracked, append-only, one JSON object per run)
        |
        v
api/admin/bookings.js?view=agent-activity  -> admin/home.js's Home dashboard
```

## Risk model

Every finding is assigned exactly one category:

| Category | Meaning | Auto-apply eligible? |
|---|---|---|
| A | technical/site-quality issue | only the one whitelisted fix type |
| B | clear low-risk improvement | only the one whitelisted fix type |
| C | content opportunity requiring research | never (routed through research first) |
| D | major/high-risk SEO change | never — always requires explicit approval |
| E | insufficient evidence — do nothing | never (also the fail-safe default for any unrecognized finding type) |

The full type -> category/risk mapping lives in `agent/lib/risk.js`.

### Auto-apply whitelist (exactly one fix type)

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
except those two — is propose-only. Metadata text (titles/descriptions),
FAQ copy, and any new content are content decisions this system does not
make.

### vercel.json rewrites vs. redirects

One page, `privacy-policy.html`, is served under a clean URL
(`/privacy-policy`) via a **rewrite**, not a redirect — the opposite of
every other page on the site, which is canonical at its `.html` filename.
`link-audit.js` and `seo-audit.js` both account for this via
`buildRewriteCleanUrlMap()` so that page doesn't generate false
broken-link/canonical-mismatch findings. If another page is ever served
this way, it is picked up automatically from `vercel.json` — nothing here
is hardcoded to `privacy-policy.html` specifically.

### City pages vs. same-suffix service pages (Phase 2 correctness fix)

`consistency-audit.js`'s "city pages" group used to be any file matching
`/-junk-removal\.html$/`, which also matched several pages that are NOT
city/location pages — `commercial-junk-removal.html`,
`office-junk-removal.html`, `hoa-junk-removal.html`,
`contractor-remodeler-junk-removal.html`,
`property-management-junk-removal.html`, `same-day-junk-removal.html` are
all service-type pages that happen to share the filename suffix. It now
uses an explicit `CITY_SLUGS` allowlist instead, and the same module also
checks blog posts (`blog-*.html`) as their own comparable group.

## Decision engine (`agent/lib/decision.js`)

A classified finding does not automatically become a website edit.
`decide(finding)` returns exactly one of:

- **APPLY_SAFE_FIX** — the finding has the one whitelisted mechanical
  `autoFix` and low risk. The only decision the runner ever acts on
  itself in `--apply-safe` mode.
- **PROPOSE_CHANGE** — internal evidence (optionally plus research) is
  clear enough to recommend action, but a human (or future
  content-writing step) must still execute it. Category D and any
  research-backed category-C proposal are additionally flagged
  `requiresApproval: true`.
- **RESEARCH_MORE** — a category-C finding with no research attached yet.
  Carries a structured `researchQuestion` (the question, the internal
  evidence so far, and suggested source types) for whoever performs
  research next.
- **NO_CHANGE** — either category E (fail-safe default), or a category-C
  finding whose attached research came back low-confidence or
  inconclusive. "Researched, decided it isn't worth it" is a real,
  loggable outcome.
- **REJECT_OPPORTUNITY** — a category-C finding whose attached research
  actively contradicts the opportunity (e.g. confirms the page's length
  is appropriate for its topic, not thin).

Only category-C findings are ever routed through research at all —
everything else is answerable from internal evidence alone, and routing
it through research anyway would be exactly the wasted effort the product
spec warns against.

## External research (`agent/lib/research.js` + `research-intake.js`)

The offline runner has no network access **by design** — research is
performed separately, by whoever (or whatever) can reach the network. In
practice that's a Claude-driven session with web search/fetch available,
run deliberately when a `RESEARCH_MORE` decision raises a question, not
on every scheduled run. This avoids the three things explicitly ruled
out: a new paid API, a new serverless function, or new crawler
infrastructure — none of that was needed.

A research result is a plain JSON file under `agent/research/results/`
(git-tracked, reviewable, diffable), validated by
`makeResearchResult()` against a required shape:

- `findingKey` — which finding this answers (a stable, content-derived
  key — see `findings.js`'s `makeKey` — not the per-run `id`, so research
  done today still matches the same finding in next week's run).
- `question`, `source`, `sourceType` (one of `official-government`,
  `official-municipal-utility`, `search-results-observation`,
  `competitor-website`, `other-authoritative`, `internal-repo-review`),
  `accessedAt`.
- `evidence` — one or more concrete, attributable observations (never
  empty — a verdict with zero evidence is refused).
- `confidence` (`low`/`medium`/`high`), `limitations` (required, not
  optional — a result claiming no limitations is almost always
  overconfident), `verdict` (`supports-opportunity` /
  `contradicts-opportunity` / `inconclusive`), `recommendation`.

`research-intake.js` reads every file in that directory on each run,
validates it, and attaches matches to the finding they answer. A missing
directory, an empty one, or an individual malformed file all fail safe
(empty research, a visible warning) — never a thrown error.

**INTERNAL EVIDENCE vs. EXTERNAL EVIDENCE vs. INFERENCE** stay visibly
separate throughout: a finding's own `.evidence` is internal (from the
scan); its `.research[].evidence` is external (or, for
`internal-repo-review`, a deeper internal look than the scan alone did);
`decision.js`'s own `.reason` is the system's inference, never conflated
with either evidence source.

## Post-change validation (`agent/lib/validate.js`)

After `--apply-safe` applies a mechanical fix, the runner re-scans the
whole site and validates each applied finding: has the original issue
actually resolved, and does the new href not itself now show up as
broken? If validation fails (`fix-not-verified` or `regression-detected`),
the runner automatically reverts — the exact inverse rewrite, through the
same single-unambiguous-occurrence-only mechanism the forward fix used,
so the revert is exactly as safe and deterministic as the fix itself was.
If the revert itself can't proceed deterministically (e.g. the file
changed again in the meantime), the finding is marked
`apply-failed-requires-review` rather than pretending anything succeeded.
Git remains the underlying rollback mechanism for everything else — no
separate backup/snapshot system was built, since none was needed.

## Private vs. publication-safe business context

The product plan for this agent eventually wants to use real completed-job
operational notes (e.g. "hot tub removal in Wheat Ridge, backyard access
was easy") as safe signal for future content opportunities. **That CRM
integration still does not exist** and Phase 2 does not build it.

What already exists is the boundary it will have to respect:
`agent/lib/business-context.js` defines a private-field blocklist
pattern, a narrow publication-safe allowlist (`serviceType`, `city`,
`accessNotes`, `outcomeTag`), and `redactForPublication()` /
`assertNoPrivateLeakage()` helpers, proven out with synthetic fixture data
in `tests/agent-business-context.test.js`. When the CRM's "how'd it go?"
note is built, it should produce objects shaped like that module's
`syntheticRawJobNote` example and pass them through this module — not
reimplement redaction inline. Nothing becomes public merely because it's
classified as potentially publication-safe — it's evidence/input for the
agent, same as any other research, not automatic website copy.

## Activity history + CRM wiring

`agent/history/log.ndjson` is a plain git-tracked file — one JSON object
per line, one line per run, appended by `agent/lib/history.js`. Each
record carries: `runId`, `timestamp`, `mode`, a `summary` (pages scanned,
counts by category/decision, auto-applied vs. proposed, research
questions raised), the full `findings` array (each with its evidence,
attached research, decision + reason, and — if applied — its validation
result), and a `validation` summary.

`history.buildDashboardSummary(runs)` reduces the log into a short list of
`{icon, text}` lines per run (always led by a "Checked N pages" line),
exactly the compact activity-view shape the product spec asked for. This
is now wired all the way to the CRM:

- `api/admin/bookings.js`'s new `?view=agent-activity` branch (dispatched
  before any Supabase client is created, same as the existing
  `?view=google-config` branch, since this never touches Supabase) reads
  the log and returns `{ok, connected, recent}` — no new serverless
  function, reusing the exact function-slot-conscious pattern every other
  stage in this project already follows (the Hobby plan was already at
  12/12 — see `docs/phase-3/vercel-function-limit.md`).
- `vercel.json`'s `functions."api/admin/bookings.js".includeFiles` is set
  to `agent/**` so the (data, not code) `agent/history/log.ndjson` file —
  read via `fs` at runtime, not `require()`d — actually ships in that
  function's deployment bundle; the agent library code itself is an
  ordinary `require()` graph Vercel's build already traces on its own.
- `admin/home.js` fetches that view as a fifth, independent Stage 1 GET
  and renders it into `admin/home/index.html`'s existing "Website &
  Marketing Activity" slot — a plain row saying "Not connected yet" when
  there's no log yet (or the fetch fails — never fabricated), or a small
  compact card with the real lines, built via `createElement`/`textContent`
  only (no `innerHTML`, matching every other admin page's own discipline).
  Home was **not** redesigned; only that one existing slot changed.

## What this agent can currently inspect

- Every top-level `*.html` page's title, meta description, canonical tag,
  H1s, JSON-LD blocks, internal links, and word count.
- `vercel.json`'s redirects and rewrites, `sitemap.xml`, `robots.txt`.
- Cross-page consistency among the true city/location pages and,
  separately, among blog posts.

## What research it can currently perform

Structural/internal research is built into the runner itself (comparing
pages against each other and against the site's own routing config) and
needs no separate step. Genuine **external** research (current search
results, competitor landscape, official municipal/disposal information)
is performed by a human-directed Claude session with web access, only
when a `RESEARCH_MORE` decision raises a specific question — never
automatically, never for every page on every run, and never by copying
competitor wording or fabricating rankings/search-volume/demand numbers
the agent cannot actually observe.

## What it can currently change

Only the narrow auto-apply whitelist described above, and only in
`--apply-safe` mode, and only when the working tree is clean, and only
after post-apply validation confirms it (or reverts it). Nothing else is
ever written to disk by this system.

## What this agent deliberately cannot change yet

- Any copy: titles, meta descriptions, headings, body content, FAQ text.
- Any new page.
- Any schema/structured-data authoring (only *absence* is flagged).
- Sitemap.xml / robots.txt edits (only flagged).
- Anything touching `admin/`, `api/`, or booking/payment flows — out of
  scope by design; this agent only ever reads top-level marketing pages
  (the one exception, `api/admin/bookings.js`'s read-only
  `?view=agent-activity`, never writes anything either).

## First research-assisted run (Phase 2)

Run against the live site content on 2026-10-12: **51 pages scanned, 13
findings, all decided `PROPOSE_CHANGE` from internal evidence alone, 0
research questions raised.** Category breakdown: `{"A":1,"B":12}` — one
sitemap gap, twelve title/meta-description length outliers. No category-C
findings emerged (no duplicate descriptions, no orphan pages, no
structural inconsistency among city pages OR blog posts — both groups
checked clean), so the research layer correctly determined there was
nothing worth spending it on this run.

This is a genuine, honest result, not a weak one: the whole point of
`decision.js`'s "do I have enough internal evidence?" gate is to *avoid*
manufacturing a research task when none is warranted, and on this run,
none was. The research/decision machinery itself is proven out
end-to-end by the test suite below (`tests/agent-decision.test.js` and
`tests/agent-research.test.js`), which exercises every branch —
`RESEARCH_MORE` with no evidence yet, `NO_CHANGE` after weak/inconclusive
research, `REJECT_OPPORTUNITY` after contradicting research, and
`PROPOSE_CHANGE` after confirming research — using realistic synthetic
findings of the kind future audit modules (e.g. a genuinely thin page, or
a real near-duplicate description) would produce. `agent/research/results/`
stays empty in this repo until a real `RESEARCH_MORE` question is raised
and actually answered — nothing was seeded there just to demonstrate the
mechanism.

## Tests

```bash
node tests/agent-findings-and-risk.test.js
node tests/agent-seo-and-consistency-audit.test.js
node tests/agent-link-audit.test.js
node tests/agent-apply-and-history.test.js
node tests/agent-business-context.test.js
node tests/agent-research.test.js
node tests/agent-decision.test.js
node tests/agent-validate.test.js
node tests/agent-runner.test.js
node tests/agent-activity-api.test.js
node tests/agent-activity-home-ui.test.js
```

All offline, no network, no mutation of real site content (fixture-based
apply/validate tests use throwaway files under `tests/fixtures/`, cleaned
up after; history/runner tests use a temp file under the OS temp
directory or an injected path, never the real `agent/history/log.ndjson`
— that file is only ever written by an explicit `node agent/cli.js`
invocation).

## Recommended Phase 3

1. **Expand the audit surface** so the research layer has more to
   evaluate: near-duplicate (not just exact-duplicate) description
   detection, internal-linking-opportunity detection, "missing useful
   content" gap analysis against `services.html`'s own listing. Each new
   category-C-eligible check should be validated against the real site
   first (as this phase's blog-group consistency check was) to confirm it
   separates real signal from the site's own natural similarity, before
   shipping.
2. **A real completed-job CRM integration**, routed through
   `agent/lib/business-context.js`.
3. **CRM approval workflow**: a way for the owner to act on a
   `requiresApproval: true` `PROPOSE_CHANGE`/`REJECT_OPPORTUNITY` directly
   from the activity view, rather than only reading about it.
4. **Scheduling**: once Phase 2's output has been trusted over more real
   runs, consider a recurring (e.g. weekly) dry-run via the existing
   Vercel cron mechanism or an external scheduler — still dry-run only
   until the approval workflow above exists.
