# Site Improvement Agent — Phase 1 + Phase 2 + Phase 3

An autonomous system that inspects this site's own public marketing pages,
researches what genuinely needs external evidence, decides what (if
anything) is warranted, applies a narrow whitelist of safe mechanical
fixes, validates them, and records exactly what happened in an
append-only, git-tracked activity log that feeds the CRM Home dashboard
AND a live, owner-approvable proposals table. See "What this deliberately
cannot do yet" below for the hard boundaries this system still respects.

## Core philosophy

- "No worthwhile change today" is a valid, loggable result — and so is
  "no research was warranted today." Both are judgment, not inaction.
- Length, or any other single weak signal, is never sufficient evidence
  on its own (see "Weak-finding semantics" below) — the activity feed
  must never imply every observation requires work.
- A finding may never exist without evidence (`agent/lib/findings.js`
  enforces this at construction time), and a research result may never
  exist without at least one observed, attributed evidence item
  (`agent/lib/research.js` enforces this the same way).
- The offline runner (`agent/runner.js`) never fetches the network or
  calls an external API for research. Everything it decides on its own is
  derived from files already in this repo — true-by-construction, never a
  hallucination. External research is a deliberately separate,
  explicitly-invoked step (see "External research" below). Syncing to
  this project's own database (`agent/lib/proposals-sync.js`) is a
  different category of thing from external research — see that
  section's own note on why.
- Content (titles, descriptions, FAQ copy, new pages) is never written by
  this system. It only ever recommends, with evidence, that a human (or a
  future content-writing step) write it. Approving a proposal records a
  decision — it never grants broader authority or executes anything by
  itself, beyond the narrow mechanical-fix whitelist that was already
  auto-apply-eligible before anyone approved anything.
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
                         jsonLd, internalLinks, contextualInternalLinks,
                         telLinks, wordCount — all literally read from
                         each top-level *.html file)
        |
        v
link-audit.js         -> findings about broken/redirect-hop internal links,
seo-audit.js             orphan pages, sitemap/robots conflicts, missing/
consistency-audit.js     malformed/duplicate metadata, missing schema/H1,
internal-linking-audit.js structural outliers among comparable page
cannibalization-audit.js groups, weak internal-linking support, overlapping
content-gap-audit.js     search intent, thin FAQs, city/service coverage
coverage-audit.js        patterns, UX/conversion dead-ends, and factual
ux-audit.js              contradictions in business-identity data
factual-consistency-audit.js
        |
        v
risk.js               -> assigns category (A-E) + riskLevel + tier
                         (observation/opportunity/actionable) + autoApplyEligible
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
                         any that didn't verify — then syncs owner-review-
                         needing findings to agent_proposals
                         (proposals-sync.js) — then always appends one
                         record to history
        |
        v
agent/history/log.ndjson     (git-tracked, append-only, one JSON object per run)
        |              \
        v               v
api/admin/bookings.js   api/admin/bookings.js
  ?view=agent-activity    ?view=agent-proposals / resource:"agent-proposal"
        |                       |
        v                       v
admin/home.js            admin/agent-proposals.js
(compact activity feed)  (approve/reject detailed review)
```

## Risk model

Every finding is assigned exactly one category, one risk level, and
(Phase 3) one **tier**:

| Category | Meaning | Auto-apply eligible? |
|---|---|---|
| A | technical/site-quality issue | only the one whitelisted fix type |
| B | clear low-risk improvement | only the one whitelisted fix type |
| C | content opportunity requiring research | never (routed through research first) |
| D | major/high-risk SEO change | never — always requires explicit approval |
| E | insufficient evidence — do nothing | never (also the fail-safe default for any unrecognized finding type) |

The full type -> category/risk/tier mapping lives in `agent/lib/risk.js`.

### Weak-finding semantics: OBSERVATION / OPPORTUNITY / ACTIONABLE (Phase 3)

Phase 2's first run flagged all 12 of its title/meta-description-length
findings as `PROPOSE_CHANGE` — busywork, since falling outside a
conventional character-count window is, by itself, weak evidence. Phase 3
fixes this by giving every finding a `tier`:

- **observation** — a true, recorded fact that is NOT, on its own,
  sufficient evidence to warrant a change (e.g. `title-length`,
  `description-length`, `weak-internal-support`, `weak-cta`,
  `no-next-action`). `decision.js` always resolves these to `NO_CHANGE`,
  with an explicit "observation only" reason — logged for transparency,
  never implied to need work, never routed through research either (that
  would just be a different flavor of wasted effort).
- **opportunity** — category C: plausible, but needs external evidence
  before it's known whether it's worth acting on.
- **actionable** — enough evidence already exists (internally, or
  because research confirmed it) to propose or apply a real change.

A length observation only escalates to something actionable when a
*specific, stronger* reason also applies — `seo-audit.js` checks for
exactly two: the text is placeholder-looking (`"Untitled"`, `"Lorem
ipsum..."`, etc.) or severely out of range (not merely over the
recommended window, but far enough that it plausibly hides the page's
distinguishing information entirely). Those produce `title-malformed`/
`description-malformed` instead — a different, actionable finding type,
never the same type with its tier silently flipped.

### Re-evaluation of the Phase 2 run's 13 findings

Re-running the same 13 real findings through this fix: **1 of 13 remains
genuinely actionable** (the `sitemap-missing-url` gap). The other 12
(all `title-length`/`description-length`) are now honestly reported as
observations — `NO_CHANGE`, "not actionable on its own" — not because
they were dropped, but because length alone never justified treating
them as work items in the first place.

### Auto-apply whitelist (exactly one fix type)

`autoApplyEligible` is **not** the same as "risk is low." It additionally
requires the finding to carry a mechanical `autoFix` descriptor AND be
tier `"actionable"`, and only one fixer is registered:
`agent/lib/apply/rewrite-href.js`, which rewrites one exact `href="..."`
string to another exact string in one file. It is used only for:

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

Every other finding type is propose-only. Metadata text
(titles/descriptions), FAQ copy, and any new content are content
decisions this system does not make.

### vercel.json rewrites vs. redirects

One page, `privacy-policy.html`, is served under a clean URL
(`/privacy-policy`) via a **rewrite**, not a redirect — the opposite of
every other page on the site, which is canonical at its `.html` filename.
`link-audit.js` and `seo-audit.js` both account for this via
`buildRewriteCleanUrlMap()`. `ux-audit.js` and
`factual-consistency-audit.js` separately exclude it (and any future
`UTILITY_PAGE_FILES` entry — see `page-groups.js`) from CTA/business-
identity checks, since a legal page legitimately has neither.

### City pages vs. same-suffix service pages (Phase 2 correctness fix)

`consistency-audit.js`'s "city pages" group used to be any file matching
`/-junk-removal\.html$/`, which also matched several pages that are NOT
city/location pages (`commercial-`, `office-`, `hoa-`, `contractor-
remodeler-`, `property-management-`, `same-day-junk-removal.html`). It
now uses an explicit `CITY_SLUGS` allowlist, single-sourced in
`agent/lib/page-groups.js` and reused by every Phase 3 audit module that
needs to know "is this a city page / a service page / a utility page."

## Expanded audit surface (Phase 3)

Six new modules, each conservative by design — tested against the real
site during development specifically to confirm they separate genuine
signal from this site's own natural similarity before shipping (several
almost-reasonable heuristics were tuned or rejected this way — see each
module's own header for what that process found):

- **`internal-linking-audit.js`** (A) — looks only at CONTEXTUAL links
  (a page's own body content, via `scan.js`'s `contextualInternalLinks` —
  everything OUTSIDE the shared header/nav/footer chrome, which is
  identical on every page and so says nothing about any one page's
  content). `weak-internal-support` (observation) flags a page relying
  almost entirely on the global nav. `missing-contextual-link`
  (opportunity) flags a city page with zero contextual link to any
  general service page. Never proposes adding links "for SEO."
- **`cannibalization-audit.js`** (C) — `overlapping-intent`: beyond exact
  duplicate titles, requires AT LEAST TWO of three independent signals
  (title/description/H1 word-overlap) to each clear a 0.75 Jaccard
  threshold before flagging a pair — a single-signal check, tested
  against this real site, produced a 0.56 city-to-city description
  similarity that would have been a false positive at any reasonable
  one-signal threshold (two different city pages legitimately share a lot
  of template vocabulary). Never recommends consolidation/deletion.
- **`content-gap-audit.js`** (C) — `content-gap`: a page whose FAQ
  answers meaningfully fewer questions than its comparable siblings
  (<50% of the group's average question count). Always routes through
  research, never guesses what the missing questions are.
- **`coverage-audit.js`** (C) — `coverage-gap-candidate`: a service the
  site ITSELF already contextually promotes on ≥70% of city pages, but
  which is contextually absent from a specific one — never "every
  service needs every city" (confirmed on the real site: two services
  that are genuinely niche, present on only 2/13 and 0/13 city pages
  respectively, correctly raised nothing, since there's no majority
  pattern to compare against).
- **`ux-audit.js`** (B, static-detection-only) — `weak-cta`/
  `no-next-action`: a page with no contextual (body-content) link into
  the booking flow, and — if also thin — flagged more specifically as a
  possible dead end. Explicitly does not claim to replace real browser
  usability testing; utility pages (privacy-policy.html) are excluded by
  design.
- **`factual-consistency-audit.js`** (A technical / D contradiction) —
  phone-number consistency (`inconsistent-contact-info`) and
  business-identity JSON-LD consistency (`factual-contradiction`:
  name/telephone/priceRange/areaServed disagreeing with the site-wide
  majority). Flags CONTRADICTIONS only, never mere wording differences —
  utility pages are excluded from the business-identity comparison, since
  a thinner schema block there isn't a contradiction.

On the real site as of this phase, five of these six modules currently
report **zero findings** (cannibalization, coverage, UX, factual
consistency, and internal-linking's `missing-contextual-link` variant) —
a genuinely good sign (protect what already works), not a bug; each is
fully exercised by synthetic fixtures in
`tests/agent-audit-expansion.test.js`. `internal-linking-audit.js`'s
`weak-internal-support` (observation-tier) does fire for five real pages
(about.html, two blog posts, privacy-policy.html, services.html), and
`content-gap-audit.js` found one real, genuine opportunity — see "First
research-assisted run" below.

## Decision engine (`agent/lib/decision.js`)

A classified finding does not automatically become a website edit.
`decide(finding)` returns exactly one of:

- **APPLY_SAFE_FIX** — the finding has the one whitelisted mechanical
  `autoFix`, tier `actionable`, and low risk.
- **PROPOSE_CHANGE** — internal evidence (optionally plus research) is
  clear enough to recommend action, but a human (or future
  content-writing step) must still execute it. Category D and any
  research-backed category-C proposal are additionally flagged
  `requiresApproval: true`.
- **RESEARCH_MORE** — a category-C finding with no research attached yet.
  Carries a structured, NARROW `researchQuestion` — Phase 3 gives several
  finding types their own specifically-worded question template (e.g.
  content-gap's question names the actual FAQ-count gap and asks whether
  THIS page's topic has specific unanswered questions — not "research
  this topic") — plus the internal evidence so far and suggested source
  types.
- **NO_CHANGE** — tier `observation` (always, checked first — see
  "Weak-finding semantics" above), OR category E (fail-safe default), OR
  a category-C finding whose attached research came back low-confidence
  or inconclusive.
- **REJECT_OPPORTUNITY** — a category-C finding whose attached research
  actively contradicts the opportunity.

Only category-C findings are ever routed through research at all — and,
as of Phase 3, tier `observation` findings never are either, regardless
of category.

## External research (`agent/lib/research.js` + `research-intake.js`)

The offline runner has no network access **by design** — research is
performed separately, by whoever (or whatever) can reach the network. In
practice that's a Claude-driven session with web search/fetch available,
run deliberately when a `RESEARCH_MORE` decision raises a question, not
on every scheduled run. This avoids the three things explicitly ruled
out: a new paid API, a new serverless function, or new crawler
infrastructure — none of that was needed.

A research result is a plain JSON file under `agent/research/results/`
(git-tracked, reviewable, diffable), validated by `makeResearchResult()`
against a required shape: `findingKey`, `question`, `source`, `sourceType`
(one of `official-government`, `official-municipal-utility`,
`search-results-observation`, `competitor-website`, `other-authoritative`,
`internal-repo-review`), `accessedAt`, `evidence` (one or more concrete,
attributable observations — never empty), `confidence` (`low`/`medium`/
`high`), `limitations` (required, not optional), `verdict`
(`supports-opportunity`/`contradicts-opportunity`/`inconclusive`),
`recommendation`.

`research-intake.js` reads every file in that directory on each run,
validates it, and attaches matches to the finding they answer by
`findingKey`. A missing directory, an empty one, or an individual
malformed file all fail safe (empty research, a visible warning) — never
a thrown error. When more than one result exists for the same finding,
`decision.js`'s `pickLatestResearch()` uses the most recently `accessedAt`
one to decide — see the real example below, where a weak general result
was superseded by a stronger, specific one.

**INTERNAL EVIDENCE vs. EXTERNAL EVIDENCE vs. INFERENCE** stay visibly
separate throughout: a finding's own `.evidence` is internal; its
`.research[].evidence` is external (or, for `internal-repo-review`, a
deeper internal look); `decision.js`'s own `.reason` is the system's
inference, never conflated with either evidence source.

### Syncing to this project's own database is not "external research"

`agent/lib/proposals-sync.js` writes to Supabase (this project's own
database, via `api/_lib/supabase-admin.js`'s existing service-role
client) — this is a different category of action from fetching an
external webpage. It's the same thing every other CRM feature in this
codebase already does with its own data, not a new kind of network
access, and it still never influences what the agent decides — it only
publishes decisions already made.

## Post-change validation (`agent/lib/validate.js`)

After `--apply-safe` applies a mechanical fix, the runner re-scans the
whole site and validates each applied finding: has the original issue
actually resolved, and does the new href not itself now show up as
broken? If validation fails, the runner automatically reverts — the
exact inverse rewrite, through the same single-unambiguous-occurrence-
only mechanism the forward fix used. If the revert itself can't proceed
deterministically, the finding is marked `apply-failed-requires-review`
rather than pretending anything succeeded. Git remains the underlying
rollback mechanism for everything else.

## Completed-job context: "How'd it go?" (Phase 3)

A real CRM feature, not a stub: marking an existing job **completed**
(`admin/booking-detail.js`'s status sheet, `PATCH
/api/admin/booking?resource=status`) now optionally prompts for a quick,
internal-only operational note — "Hot tub removal, easy backyard access,
cut into sections." — via the same lightweight `window.prompt()` pattern
this page already uses for Tip, never a new modal/form. Only asked when
actually transitioning TO completed (never on every status change, never
forced — cancelling still completes the job with no note). Stored in a
new `bookings.operational_note` column
(`sql/2026-10-12_phase3-agent-howd-it-go.sql`) and editable afterward via
a dedicated completed-jobs-only control
(`PATCH ?resource=operational-note`, mirroring Tip's exact shape/gating).

This was built by first inspecting the existing completion/payment/tip
flow in detail (there was no single "mark complete" transaction to
duplicate — tip, review-request, and the new note are each their own
small, independent, completed-jobs-only write) rather than assuming or
duplicating anything that already existed.

### Private vs. publication-safe pipeline

`agent/lib/business-context.js`'s boundary (built in Phase 2, with
synthetic fixtures) now has a real source: `fromCompletedBooking(booking)`
maps a real booking row (snake_case from Supabase, or the camelCase shape
`api/admin/booking.js`'s GET already returns — either works) to the same
four-field safe shape, picking ONLY `serviceType`/`city`/`accessNotes`
(the operational note)/`outcomeTag` — never reading `customer_id`,
`final_price`, `tip_amount`, `internal_notes`, `service_address`, or
anything else, so nothing else could leak even before
`redactForPublication()`'s own allowlist runs as a second, independent
check. Proven with a realistic fixture shaped exactly like a real row,
every private column included, in
`tests/agent-business-context.test.js`.

Nothing in `agent/runner.js` calls this yet — there is no real production
data behind it yet (the feature just shipped) and the offline runner has
no Supabase credentials in this environment anyway. It's evidence
available to a future step, same as any research result — even once
real completed-job data exists, nothing becomes public merely because it
passed this boundary.

## CRM approval workflow (Phase 3)

`agent_proposals` (`sql/2026-10-12_phase3-agent-proposals.sql`) is the
live, CRM-mutable counterpart to the read-only, git-tracked history log —
needed because a deployed Vercel function's filesystem is read-only, so
an owner clicking Approve/Reject needs something a live request can
actually persist. `agent/lib/proposals-sync.js` upserts every
`PROPOSE_CHANGE`/`REJECT_OPPORTUNITY` finding into it after a run, keyed
by the finding's stable `key` — a re-sync refreshes content
(summary/decision/evidence/research) but **never** resets an owner's
prior approve/reject decision back to `proposed`. Gracefully skipped
(never thrown) when Supabase isn't configured in the runner's
environment — true for this repo's offline dry-run/test setup.

State model: `proposed -> approved | rejected` (the only transitions this
phase's UI performs) — `applied`/`validated`/`failed` exist in the schema
for the EXISTING mechanical auto-apply/validate loop to use later if it's
ever connected to this same table; nothing in this phase makes that
connection, since the narrow whitelist already has its own working
history-log-based record.

- `api/admin/bookings.js`'s `?view=agent-proposals` (list, optional
  `?status=` filter) and `resource:"agent-proposal"` PATCH (`{id, action:
  "approve"|"reject", note}`) — no new Vercel function, same file that
  already hosts `?view=agent-activity`.
- `admin/agent-proposals/` — the smallest sensible detailed-review page:
  each proposal's summary, reason, pages, evidence (compact, never a raw
  JSON dump), and attached research, with Approve/Reject + an optional
  note for anything still `proposed`. Not added to the global nav — only
  reachable via a "Review proposals →" link on Home's existing activity
  card. Home itself was **not** redesigned.
- Approving a proposal **never grants authority beyond that one specific
  finding_key** — it is a recorded decision, not a trigger. Meaningful
  content changes remain human-executed even once approved.

## What this agent can currently inspect

- Every top-level `*.html` page's title, meta description, canonical tag,
  H1s, JSON-LD blocks, internal links, CONTEXTUAL (body-content-only)
  internal links, tel: links, and word count.
- `vercel.json`'s redirects and rewrites, `sitemap.xml`, `robots.txt`.
- Cross-page consistency among true city/location pages, blog posts, and
  (Phase 3) internal-linking patterns, title/description/H1 overlap, FAQ
  depth, service/city coverage patterns, booking-CTA presence, and
  phone/business-identity consistency.

## What research it can currently perform

Structural/internal research is built into the runner itself and needs
no separate step. Genuine **external** research (current search results,
competitor landscape, official municipal/disposal information) is
performed by a human-directed Claude session with web access, only when a
`RESEARCH_MORE` decision raises a specific, narrow question — never
automatically, never for every page on every run, and never by copying
competitor wording or fabricating rankings/search-volume/demand numbers
the agent cannot actually observe.

## What it can currently change

Only the narrow auto-apply whitelist described above, and only in
`--apply-safe` mode, and only when the working tree is clean, and only
after post-apply validation confirms it (or reverts it). Approving a CRM
proposal records a decision; it does not cause this system to write
anything. Nothing else is ever written to disk (or to the website's
public content) by this system.

## What this agent deliberately cannot change yet

- Any copy: titles, meta descriptions, headings, body content, FAQ text —
  even once a related proposal is approved.
- Any new page.
- Any schema/structured-data authoring (only *absence*/*contradiction* is
  flagged).
- Sitemap.xml / robots.txt edits (only flagged).
- Anything touching `admin/`, `api/`, or booking/payment flows beyond the
  two narrow, completed-jobs-only additions this phase made
  (`operational_note` capture/edit) — out of scope by design.

## First research-assisted run (Phase 3)

Run against the live site content on 2026-10-12, with the expanded audit
surface: **51 pages scanned, 19 findings.** `byDecision`:
`{"PROPOSE_CHANGE":1 (then 1 more after research — see below), "NO_CHANGE":17,
"RESEARCH_MORE":1}`.

- **12 title/description-length findings**: now honestly `NO_CHANGE`
  (observation) — see "Re-evaluation" above.
- **5 `weak-internal-support` findings** (about.html, two blog posts,
  privacy-policy.html, services.html): observation-tier, `NO_CHANGE`.
- **1 `sitemap-missing-url`**: the one real, internally-decidable
  actionable finding — `PROPOSE_CHANGE`.
- **1 `content-gap`**: `blog-seasonal-cleanout-guide.html`'s FAQ answers
  only 3 questions vs. a 6-question average among comparable blog posts —
  genuinely `RESEARCH_MORE`, with a narrow question: *"...is there enough
  evidence that this page's actual topic has specific, genuinely useful
  practical questions not yet answered there, that would justify adding
  to its FAQ?"*

**Real external research was performed** for that one question (via
`WebSearch`, a Claude-driven session with web access — not the offline
runner):

1. A general industry-FAQ-pattern search
   (`agent/research/results/content-gap__blog-seasonal-cleanout-guide-1-industry-pattern.json`)
   — multiple competitor/industry FAQ pages recurrently answer "how far
   in advance should I book during a busy season" and fall yard-waste
   logistics as their own distinct questions. Deliberately recorded at
   **low confidence, verdict `inconclusive`** — this is a generic
   cross-industry pattern, carries no actual search-volume/Search
   Console data, and SERP presence is explicitly not the same thing as
   search volume.
2. A second, Denver-specific result
   (`...-2-denver-leafdrop.json`) — the City and County of Denver's
   official **LeafDrop** leaf/pumpkin composting program (confirmed via
   denvergov.org + corroborating 2026-10-11 local news coverage): a real,
   checkable, currently-unmentioned fact directly relevant to the page's
   existing Fall section. Recorded at **medium confidence, verdict
   `supports-opportunity`** — strong enough to tip the decision, but still
   honestly caveated (doesn't prove visitor-level demand; dates/locations
   must be re-verified before any copy is actually published, since the
   program runs annually).

Feeding both back through `decision.js` (`pickLatestResearch()` correctly
preferred the later, stronger, Denver-specific result): the finding's
decision became **`PROPOSE_CHANGE`**, `requiresApproval: true` — a real,
specific, locally-grounded FAQ opportunity (*"Can I use Denver's free
LeafDrop program instead of hauling?"*), still never auto-written.

**On demonstrating all three research outcomes**: the real site this run
produced exactly ONE category-C opportunity, and real research on it led
to `PROPOSE_CHANGE`. The other two outcomes this phase asked to see
demonstrated (`NO_CHANGE` after weak/inconclusive research,
`REJECT_OPPORTUNITY` after contradicting research) are NOT naturally
produced by this run's real findings — said so honestly rather than
manufacturing a second fake opportunity. Both paths are fully implemented
and verified end-to-end with realistic synthetic findings in
`tests/agent-decision.test.js` (which also covers the low-confidence and
inconclusive-verdict cases) and `tests/agent-research.test.js`.

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
node tests/agent-audit-expansion.test.js
node tests/agent-howd-it-go.test.js
node tests/agent-proposals-sync.test.js
node tests/agent-proposals-api.test.js
node tests/agent-proposals-ui.test.js
```

All offline, no network, no mutation of real site content (fixture-based
apply/validate tests use throwaway files under `tests/fixtures/`, cleaned
up after; history/runner/proposals-sync tests use a temp file, an
injected path, or an injected fake Supabase client, never the real
`agent/history/log.ndjson` or a real database — that log file is only
ever written by an explicit `node agent/cli.js` invocation, and the real
`agent_proposals` table was never written to from this environment,
which has no real Supabase credentials).

## Recommended Phase 4

1. **Scheduling**: once this phase's output has been trusted over more
   real runs, consider a recurring (e.g. weekly) dry-run via the existing
   Vercel cron mechanism or an external scheduler — still dry-run only
   until there's more experience with the approval workflow.
2. **Connect the real completed-job data**: once `operational_note` has
   real production content, a step that pulls recent completed jobs,
   routes them through `business-context.js`, and feeds genuinely
   recurring signals (e.g. "several real jobs mention X in city Y") into
   `content-gap-audit.js`/`coverage-audit.js` as additional internal
   evidence — still never a publish trigger by itself.
3. **Close the loop on approved proposals**: today, approving a
   `PROPOSE_CHANGE` just records the decision — a human still has to go
   write the actual change. A lightweight way to track "approved and
   already acted on" (vs. "approved, still waiting") would make the
   `applied`/`validated`/`failed` states in `agent_proposals`'s own schema
   actually used for meaningful proposals, not just the narrow mechanical
   whitelist.
4. **Expand the audit surface further** now that the pattern (check
   against the real site during development, confirm it separates signal
   from this site's own natural similarity) is established — e.g.
   near-duplicate description detection with corroborating signals,
   "missing useful content" gap analysis against `services.html`'s own
   listing.
