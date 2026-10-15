# Site Improvement Agent — Phase 1 + Phase 2 + Phase 3 + Phase 4 (hardening) + Phase 5 (daily/weekly operating system) + Phase 5B (research orchestration) + Phase 6 (first-party search/analytics evidence)

**Naming note**: this file's own Phase 1-4 numbering reached "Recommended
Phase 5" (a short wish-list, see below) before Rocky's own "Phase 2: turn
this into a daily/weekly operating system" request arrived under a
DIFFERENT numbering scheme (the git branch for that work is named
`site-improvement-agent-phase2`). To avoid two different "Phase 2"s and
two different "Phase 5"s existing in the same project, this file keeps its
own existing Phase 1-4 numbering and calls Rocky's request "Phase 5" here
— see the dedicated section near the end of this file, which supersedes
the short "Recommended Phase 5" wish-list that used to be this file's
final section (kept below, marked superseded, as a historical record of
what it predicted — items 2-4 of it did end up built, under this new
numbering).

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

## Completed-job context: "How'd it go?" (Phase 3, UX hardened in Phase 4)

A real CRM feature, not a stub. Phase 3 shipped it behind a chain of
`window.prompt()`s; Phase 4 replaced that with one coherent **closeout
sheet** — the same `.admin-sheet-overlay`/`.admin-sheet` CRM-native
bottom-sheet chrome `admin/status-ui.js` and `admin/other-revenue.js`
already use, not a new modal system. Picking "Completed" from the status
picker (and *only* that specific transition — not toggling away and
back, not any other status change) opens the sheet instead of saving
immediately: an optional Tip amount field and an optional "How'd it go?"
note field, with "Mark Completed" / "Cancel" actions.

- **Cancel** (the button, the backdrop, or Escape) calls nothing — the
  status PATCH is never sent, so the job is left completely untouched.
  There is no partial/accidental completion.
- **Mark Completed** sends the status PATCH (with the note, if any, in
  that SAME request — `bookings.operational_note`,
  `sql/2026-10-12_phase3-agent-howd-it-go.sql`) and, only after that
  succeeds, submits the tip via the exact same `PATCH
  ?resource=tip` endpoint the existing Payments-section Tip control
  already uses (`submitTipAmount()`, extracted so there is exactly one
  implementation, shared by both call sites — never a second copy of the
  tip-write logic, never a changed validation rule, never a touched
  Stripe/accounting calculation). A tip-save failure AFTER a successful
  completion surfaces its own toast rather than failing the whole
  closeout — the job IS completed at that point; the tip can still be
  added from Payments below, exactly like before this change.
- The note is **never required** and remains editable afterward via the
  existing dedicated completed-jobs-only control (`PATCH
  ?resource=operational-note`, unchanged from Phase 3).

This was built by first inspecting the existing completion/payment/tip
flow in detail (there was no single "mark complete" transaction to
duplicate — tip, review-request, and the note are each their own small,
independent, completed-jobs-only write) rather than assuming or
duplicating anything that already existed. Neither `api/admin/booking.js`
nor any Stripe/payment/accounting calculation changed in this hardening
pass — only `admin/booking-detail.js`'s client-side UI did.

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

## CRM approval workflow (Phase 3, hardened in Phase 4)

`agent_proposals` (`sql/2026-10-12_phase3-agent-proposals.sql`) is the
live, CRM-mutable counterpart to the read-only, git-tracked history log —
needed because a deployed Vercel function's filesystem is read-only, so
an owner clicking Approve/Reject needs something a live request can
actually persist. `agent/lib/proposals-sync.js` upserts every
`PROPOSE_CHANGE`/`REJECT_OPPORTUNITY` finding into it after a run, keyed
by the finding's stable `key`. Gracefully skipped (never thrown) when
Supabase isn't configured in the runner's environment — true for this
repo's offline dry-run/test setup.

State model: `proposed -> approved | rejected` (the only transitions this
phase's UI performs) — `applied`/`validated`/`failed` exist in the schema
for the EXISTING mechanical auto-apply/validate loop to use later if it's
ever connected to this same table; nothing in this phase makes that
connection, since the narrow whitelist already has its own working
history-log-based record.

### What "Approve" actually means (stated truthfully in the UI itself)

Approving or rejecting a proposal **only records that decision** — it
never modifies the website, never runs the mechanical-fix whitelist, and
never grants the agent any authority beyond that one specific
`finding_key`. `admin/agent-proposals/` says this twice: once in the
page's intro paragraph, and again, right at the point of action, next to
every still-`proposed` card's Approve/Reject buttons — so it's truthful
even to someone who scrolled straight to one card. There is no "Approve"
outcome that silently becomes "published."

### Proposal identity stability (Phase 4 hardening)

`finding_key` (`type::sorted-pages`) alone is **not** treated as strong
enough identity to carry an `approved`/`rejected` decision forward across
a *materially different* observation wearing the same key. A later run
re-observing the same `finding_key` with a changed `summary` — a
genuinely different concrete proposal, not the same one recurring —
resets the row back to `proposed` and clears `reviewed_by`/`reviewed_at`/
`review_note`, rather than silently letting the old decision apply to
new content. An unchanged `summary` (the normal case: the same real
issue still exists) leaves a prior decision untouched, exactly as before.
See `proposals-sync.js`'s own header and
`tests/agent-proposals-sync.test.js` for the exact rule and its tests.

A related bug this same review caught: an earlier draft of the
`agent_proposals` migration's `GRANT UPDATE` column list didn't actually
match what `proposals-sync.js`'s UPDATE statement writes (it was missing
`category`, among others) — in production, that would have silently
failed to refresh some columns on every re-sync. Fixed, and now
mechanically enforced by `tests/agent-migrations-review.test.js`, which
fails if the SQL grant and the app code's column list ever drift apart
again (it also cross-checks the migration's `category`/`decision`/
`status` CHECK constraints against `risk.js`/`decision.js`/
`bookings.js`'s own literal lists, for the same reason).

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

### Phase 4 sanity-check on this exact proposal

Before treating the LeafDrop result as production-ready evidence, Phase
4 re-reviewed it against four specific risks and updated the committed
research file's `limitations`/`recommendation` to state the answers
explicitly (not just imply them) — see
`agent/research/results/content-gap__blog-seasonal-cleanout-guide-2-denver-leafdrop.json`
and `tests/agent-research.test.js`'s dedicated test for this file:

1. **Topic fit** — confirmed: the page's existing Fall section already
   discusses exactly this yard-waste/leaf scenario.
2. **Currency** — the evidence was accessed 2026-10-12, inside the
   confirmed 2026 program window; it is explicitly marked as ALREADY
   STALE outside that window and must be re-verified before publish.
3. **Evergreen-content risk** — explicitly flagged: the published copy,
   if ever written, should describe the program generically and link to
   Denver's own page for current dates, rather than hardcoding "October
   5 - November 25" as static text that will be wrong next year.
4. **Real visitor benefit** — still only plausible, not proven; restated
   that this does not establish actual visitor demand.

The research record also now explicitly says the 3-vs-6 FAQ-question gap
that triggered this research was only a trigger for investigation, never
a target ("add exactly 3 more FAQs") — the content-gap finding's own
`recommendation` never implied a count either.

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
node tests/agent-migrations-review.test.js
```

All offline, no network, no mutation of real site content (fixture-based
apply/validate tests use throwaway files under `tests/fixtures/`, cleaned
up after; history/runner/proposals-sync tests use a temp file, an
injected path, or an injected fake Supabase client, never the real
`agent/history/log.ndjson` or a real database — that log file is only
ever written by an explicit `node agent/cli.js` invocation, and the real
`agent_proposals` table was never written to from this environment,
which has no real Supabase credentials; `agent-migrations-review.test.js`
never executes either `.sql` file against any database — it's a static
source-level review).

## Phase 4 — deployment-readiness / UX hardening

Added no new agent capabilities — this phase exists to make the
Phase 1-3 system safe and truthful to actually turn on. Summary (see each
section above for detail):

1. Replaced the completion `window.prompt()` chain with one coherent
   closeout sheet, reusing the existing Tip write path verbatim — no
   financial-logic duplication, no Stripe/accounting change.
2. Reviewed both SQL migrations for production-readiness; found and
   fixed a real bug (the `agent_proposals` UPDATE grant didn't match what
   the sync step actually writes) and added a test that fails if the
   grant and the app code's columns, or the CHECK-constraint enum lists,
   ever drift apart again.
3. Hardened proposal identity: a reviewed (`approved`/`rejected`)
   proposal now resets to `proposed` if the underlying finding's content
   materially changed on a later sync, instead of silently carrying the
   old decision forward. Made "Approve ≠ Published" explicit in the UI
   itself, not just implied.
4. Verified (with a new dedicated test) that external research cannot
   influence a non-category-C finding's decision, and re-confirmed every
   other authority boundary (whitelist, approval-required content,
   honest NO_CHANGE/REJECT_OPPORTUNITY, failed-validation-never-reported-
   as-success) by re-reading the pipeline rather than assuming it still
   held after three phases of changes.
5. Re-reviewed the one real research-backed proposal (seasonal-cleanout
   FAQ gap) against four specific risks (topic fit, currency,
   evergreen-content risk, unproven visitor benefit) and made the
   research record state the answers explicitly.
6. Added a second, outer try/catch (plus a defensive `Array.isArray`
   guard inside `buildDashboardSummary` itself) so a malformed history
   record can never 500 or crash the Home dashboard's activity feed, and
   added tests proving `?view=agent-proposals`/`resource:"agent-proposal"`
   degrade to a clean 500 (never a crash) when the migration hasn't been
   applied yet, while confirming `?view=agent-activity` is completely
   unaffected either way (it never touches Supabase).

## Recommended Phase 5 (2026-10-12 wish-list — SUPERSEDED by "Phase 5: Daily/Weekly Operating System" below)

1. **Scheduling**: once this phase's output has been trusted over more
   real runs, consider a recurring (e.g. weekly) dry-run via the existing
   Vercel cron mechanism or an external scheduler — still dry-run only
   until there's more experience with the approval workflow. *(Design
   done, not activated — see "Scheduling architecture" below.)*
2. **Connect the real completed-job data**: once `operational_note` has
   real production content, a step that pulls recent completed jobs,
   routes them through `business-context.js`, and feeds genuinely
   recurring signals (e.g. "several real jobs mention X in city Y") into
   `content-gap-audit.js`/`coverage-audit.js` as additional internal
   evidence — still never a publish trigger by itself. *(Built — see
   "Completed-job evidence" below — but feeds the weekly research-rotation
   scorer, not the daily audit modules directly; see that section for
   why.)*
3. **Close the loop on approved proposals**: today, approving a
   `PROPOSE_CHANGE` just records the decision — a human still has to go
   write the actual change. A lightweight way to track "approved and
   already acted on" (vs. "approved, still waiting") would make the
   `applied`/`validated`/`failed` states in `agent_proposals`'s own schema
   actually used for meaningful proposals, not just the narrow mechanical
   whitelist. *(Still open — see "Remaining risks/open questions" below.)*
4. **Expand the audit surface further** now that the pattern (check
   against the real site during development, confirm it separates signal
   from this site's own natural similarity) is established — e.g.
   near-duplicate description detection with corroborating signals,
   "missing useful content" gap analysis against `services.html`'s own
   listing. *(Not done this phase — deliberately out of scope; see
   "Implementation discipline" in the new section below.)*

---

# Phase 5 — Daily/Weekly Operating System

Built on branch `site-improvement-agent-phase2` (confusingly named vs.
this file's own numbering — see the note at the top of this file),
starting from `main`@`f67d4c6`. **Does not touch the Estimate workflow**
(`admin/estimate*`, the Lead→Estimate→Job pipeline) — that work is
separate, complete, and live; nothing in this phase reads or writes it.

This section documents what changed. It assumes you've already read
Phases 1-4 above.

## 1. What already existed vs. what this phase added

Already built (Phases 1-4, unchanged by this phase): the scan → 9 audit
modules → risk classify → research-intake → decide → apply-safe-whitelist
→ validate/revert → history-log pipeline; the `agent_proposals` CRM table
and its approve/reject review page; the completed-job privacy boundary
(`business-context.js`, built but **unwired** — see below); the Phase
1-4 README/tests. See "Recommended Phase 5" above for exactly what was
flagged as missing — this phase builds items 1-2 from that list under a
different name, adds the daily/weekly cadence and reporting layer Rocky
asked for, and deliberately defers item 3 and all of item 4.

New in this phase (all additive — nothing above was rewritten):

| File | Purpose |
|---|---|
| `agent/context/business-profile.json` | Canonical business/service-area data (§2) |
| `agent/lib/business-profile.js` | Loader/accessors for the above |
| `agent/lib/page-groups.js` | **Refactored** (not rewritten) to derive its existing exports from business-profile.js instead of hardcoding them a second time — same values, same exports, zero behavior change (proven by `tests/agent-business-profile.test.js`) |
| `agent/lib/change-detection.js` | New/still-open/resolved vs. the previous run (§5) |
| `agent/lib/research-rotation.js` | Weekly service-area prioritization (§4) |
| `agent/lib/completed-job-intake.js` | Reads publication-safe completed-job evidence (§9) |
| `agent/lib/report.js` | Builds the persisted CRM-facing report (§6) |
| `agent/lib/run-lock.js` | Concurrency guard (§10) |
| `agent/history/research-rotation-state.json` | Git-tracked rotation bookkeeping (like `log.ndjson`) |
| `agent/research/completed-jobs/` | Intake directory, mirrors `research/results/` |
| `admin/agent-reports/`, `admin/agent-reports.js` | Report-history CRM page (§7) |
| 10 new `tests/agent-*.test.js` files | §11 |

Modified (behavior-preserving unless noted): `agent/runner.js` (runType,
report building, rotation, lock, failure recording), `agent/cli.js`
(`--daily`/`--weekly` flags), `agent/lib/proposals-sync.js` (now also
returns `statusByKey`, additive), `agent/lib/research.js` (new optional
`temporality`/`publishedAt`/`locality`/`topic` fields, all backward
compatible — the two real Phase 3 research files were updated to set
`temporality` explicitly, see §3), `api/admin/bookings.js` (new
`agent-reports`/`agent-report` views, richer `agent-activity` response —
all additive), `admin/home.js`+`admin/home/index.html` (richer card,
§6).
**An `adjust` PATCH action, `admin/agent-proposals.js` Adjust UI, and a
SQL migration were ALSO built in this phase and documented in §8 below
— then fully reverted in Phase 5B (see that section) before this branch
reached its current state. §8's text is kept as a historical record of
what was evaluated; it does not describe what ships today.**

## 2. Canonical business/service-area context

`agent/context/business-profile.json` is now the single source of truth
for services/cities/identity — verified directly against the live site
(`index.html`'s JSON-LD + `#service-areas` section) on 2026-10-14, not
invented. The verification surfaced a real, previously-undocumented gap:
**the site's own JSON-LD `areaServed` claims 20 cities, but only 13 have a
dedicated page.** The profile models both lists explicitly
(`serviceArea.citiesWithPages` / `serviceArea.claimedCitiesWithoutPages`)
rather than silently picking one — the 7 pageless-but-claimed cities
(Golden, Brighton, Morrison, Lone Tree, Wheat Ridge, Commerce City,
Sterling Ranch) are real evidence for the weekly rotation (§4) to
evaluate, never a to-do list of pages to auto-create (see §8's new-page
standard, unchanged from the brief).

`agent/lib/page-groups.js` — the pre-existing single source every Phase
1-3 audit module already relied on — now derives its exports FROM this
file instead of hardcoding a second copy. Every existing audit module is
untouched and was re-tested to confirm identical behavior.

## 3. Daily-run behavior

`node agent/cli.js --daily` (or `--daily --apply-safe`). Runs the exact
same Phase 1-4 pipeline (nothing about scanning/auditing/deciding
changed), then additionally:

- Reads the previous run from history and computes change detection (§5).
- Builds a persisted `report` object (§6) and attaches it to the run
  record before writing to history.
- Does NOT compute research-rotation priorities (weekly-only, §4) and
  does NOT pull completed-job evidence into the mechanical audits (that
  evidence only ever feeds the weekly rotation scorer, never a daily
  finding-producer — see §9 for why this boundary was deliberate).

A daily run with zero actionable findings and zero proposals produces an
`ALL CLEAR` report — proven by `tests/agent-report.test.js`'s first test.
Daily is not forced to find something wrong; `report.healthSummary` is a
short sentence derived from real counts, never a fabricated 0-100 score
(enforced by a dedicated test).

## 4. Weekly-run behavior

`node agent/cli.js --weekly`. Same daily pipeline, PLUS:
`agent/lib/research-rotation.js` scores every city in the WHOLE claimed
service area (`business-profile.js`'s `getAllServiceAreaCities()` — 20
cities, not 13) on four real, non-invented signals:

1. Days since this rotation last reviewed it (persisted in
   `agent/history/research-rotation-state.json`, git-tracked).
2. Whether it's claimed-but-pageless (a real gap, evaluate don't
   auto-create).
3. Open daily-audit findings already on its page.
4. Publication-safe completed-job evidence count for that city (§9).

The top N (default 3 — configurable via `rotationLimit`) become this
week's picks, persisted as "reviewed" so next week rotates elsewhere. No
search-volume/demand numbers are invented anywhere in this scoring — see
`research-rotation.js`'s own header for the exact, documented point
values. **The weekly runner does not perform the actual research** — same
architecture as the existing category-C research layer: a Claude-driven
session with web access is expected to read the week's picks from the
report, research them per the evidence hierarchy (§9 of the brief,
unchanged — official sources first, competitors for landscape only), and
write `agent/research/results/*.json` files the NEXT run will pick up.
This keeps the offline runner's "no network access" invariant intact.

## 5. Change detection

`agent/lib/change-detection.js` compares the current run's finding keys
against the single most recent previous run, producing `new` /
`stillOpen` / `resolved` lists. Combined with `proposalStatus` (stamped
onto each finding from `proposals-sync.js`'s new `statusByKey` return
value — itself additive, no existing behavior changed), the report can
distinguish new / still-open / resolved / previously-rejected /
already-proposed / already-applied, exactly as requested — without a
second database round-trip. A malformed/missing previous-run history
degrades to "no previous run" rather than throwing.

## 6. Report persistence model

`agent/lib/report.js`'s `buildReport()` is a pure function —
`runner.js` calls it once per run and persists the result as
`record.report` inside the existing `agent/history/log.ndjson` (same
file, same git-tracked durability as Phases 1-4; no new table). Shape:
`runId`, `timestamp`, `runType`, `pagesChecked`, `healthSummary`
(`{status, text}` — never a numeric score), `technicalIssues`,
`observationsCount`, `opportunitiesCount`, `research` (questions raised +
each result's freshness, §9), `safeFixes`, `proposals` (counts + items,
including awaiting/previously-rejected/already-applied), `changeDetection`
(§5), `validation`, `failure` (null unless the run failed, §10),
`rotation` (weekly only), `nextReviewHint`.

## 7. CRM Home + report-history UX

Home's "Website & Marketing Activity" card (`admin/home.js` +
`admin/home/index.html`) gained a compact summary (last run time, pages
checked, health line) and a stats row (fixes applied / opportunities
researched / proposals awaiting approval) built from the latest run's
`report` — see the mockup in the original brief; this implementation
matches it closely (verified visually in the browser preview, including
mobile width). Degrades gracefully (hides the new rows) for any
pre-Phase-5 log entry with no `report` field — the original
`recent[0].lines` rendering is completely untouched as the fallback.

`admin/agent-reports/` (new, `?view=agent-reports` list +
`?view=agent-report&runId=` detail, both on the EXISTING
`api/admin/bookings.js` function — no new Vercel function) is the
smallest sensible report-history page: a list of
Today/Yesterday/date + run-type badge + outcome badge, tap a row to see
that run's full decisions/evidence/actions. Mobile-first (verified at
375px).

## 8. Proposal integration + the Adjust decision (HISTORICAL — see "Phase 5B" below for the current state)

> **Phase 5B update**: Adjust (described below exactly as it was built)
> was DEFERRED and fully reverted before the branch reached its current
> state — see the "Phase 5B" section's "Adjust removal" for why and
> exactly what was reverted. `agent_proposals`'s workflow today is simply
> `proposed → approved | rejected`, unchanged from Phase 3. This section
> is kept as a historical record of the design that was evaluated.

`agent_proposals`'s existing `proposed → approved|rejected` workflow is
completely unchanged. **Adjust was evaluated and partially implemented**
— deliberately scoped narrow rather than building the "messy
architecture" the brief said to avoid:

**Built** (`sql/2026-10-14_phase5-agent-adjust-workflow.sql` +
`handleReviewAgentProposal`'s new `action:"adjust"` + the UI's Adjust
button): a proposal can move `proposed → adjust_requested`, capturing
required owner feedback (`adjust_note`/`adjusted_at`), WITHOUT setting
`reviewed_by`/`reviewed_at` (it is not an approval or rejection) and
WITHOUT touching the website — proven by
`tests/agent-adjust-workflow.test.js`. An adjust request on an
already-reviewed proposal clears the stale verdict, same "a new decision
point replaces the old one" posture approve/reject already has.

**Deliberately not built**: automatic AI-driven regeneration of the
proposal's text from the owner's feedback. The mechanical offline runner
has no NLP/LLM capability and should not gain one just for this (new paid
API dependency, explicitly to avoid per the brief). Instead,
`adjust_requested` proposals are meant to be picked up by a human or a
Claude-assisted session — the SAME existing pattern as "real research"
(§4 above) — who revises the summary/recommendation; when the next sync
sees that changed content, `proposals-sync.js`'s EXISTING Phase-4
identity-reset logic (previously only triggered for
`approved`/`rejected`) already resets it back to `proposed` requiring
fresh approval — no new code needed for that half, because
`adjust_requested` was deliberately treated as "not yet reviewed" from
sync's point of view. This is the clean design the brief asked for when
full automation isn't: a bounded, reviewable loop reusing existing
machinery, not a second content-override column with its own
clobber-avoidance logic (which was drafted and rejected during design —
see this file's own PATCH handler comment for the reasoning).

## 9. Completed-job evidence + privacy

`business-context.js`'s `fromCompletedBooking()` (built in Phase 3, never
wired to anything) is now wired — but deliberately NOT into the daily
mechanical audit modules. Reasoning: those modules' finding `type`+`pages`
form `Finding.key`, which research-attachment stability depends on
staying byte-stable (documented risk in the Phase 1-4 architecture);
wiring real, slowly-changing operational data into their OUTPUT would
risk exactly that fragility. Instead, `agent/lib/completed-job-intake.js`
reads ALREADY-REDACTED evidence files (written by whoever has real
Supabase access — a human or Claude-assisted session, same pattern as
research results) from `agent/research/completed-jobs/*.json`, and feeds
only a per-city COUNT into the weekly rotation scorer (§4) — a pure
informational signal, never a finding-producer, never a publish trigger.

Defense in depth: the loader independently re-validates every field
against `PUBLICATION_SAFE_FIELDS` (even though its input is supposed to
already be redacted) and rejects any entry carrying a price/payment/tip/
address/customer-name/phone/email/raw-notes field — proven for every one
of those patterns independently by
`tests/agent-completed-job-intake.test.js`.

## 10. Freshness/temporality + failure/concurrency safety

**Freshness** (`research.js`): every research result now carries an
optional `temporality` (`evergreen`/`temporary`/`unknown`, defaults to
`unknown` — never silently assumed evergreen) plus optional
`publishedAt`/`locality`/`topic`. `computeFreshness()` flags a
`temporary` result stale after ~45 days, an `evergreen` one after ~365,
and an `unknown` one as always `needs-classification` regardless of age.
The real Denver LeafDrop result (a genuinely seasonal municipal program —
exactly the risk the Phase 4 "sanity check" narrative already flagged in
prose) is now explicitly tagged `temporality:"temporary"`.

**Concurrency** (`run-lock.js`): a file-based lock
(`agent/history/.run.lock`, gitignored, never committed) refuses a second
run while one is in flight (`ConcurrentRunError`), self-heals after 2
hours if a process crashed without releasing it, and `release()` only
ever removes a lock it recognizes as its own. Proven with two genuinely
overlapping `runner.run()` calls in `tests/agent-runner-phase5.test.js`.

**Failure safety** (`runner.js`): the whole scan→decide pipeline is now
wrapped — if it throws, a `failed:true` record (with a `healthSummary`
explicitly saying the run didn't complete, never an empty-but-successful-
looking record) is still written to history before the error is
re-thrown (carrying `err.recordedFailure` so the CLI can report the
history runId it saved). A malformed/unreadable previous-run history
degrades change detection to "no previous run" rather than blocking a new
run. A malformed rotation-state file degrades to "nothing reviewed yet."

## Scheduling architecture (DESIGNED, NOT ACTIVATED)

No cron/schedule was created this phase, per explicit instruction. Design:

- **Recommended cadence**: Daily at the existing cron's off-hour (e.g.
  04:00 America/Denver, matching the one existing cron's 9am UTC pattern
  in `vercel.json`) via `node agent/cli.js --daily --apply-safe`. Weekly
  on one fixed day (e.g. Sunday 04:00) via `node agent/cli.js --weekly`
  (apply-safe optional; the weekly run's value is research/reporting, not
  mechanical fixes).
- **Entry point**: `node agent/cli.js --daily [--apply-safe]` /
  `node agent/cli.js --weekly`, exit code 0 on success (including a
  `failed:true` honest record — the CLI's own exit code still reflects
  the failure; see `cli.js`'s updated catch block) or nonzero on an
  unrecoverable CLI-level error.
- **Required environment/credentials**: `SUPABASE_URL`/`SUPABASE_SECRET_KEY`
  for proposal sync (optional — gracefully skips without them, same as
  today); no other credentials required for the mechanical run itself.
- **How external research is performed**: NOT by the scheduled job itself
  (no network access by design). A scheduled run's report surfaces
  `RESEARCH_MORE` questions and the week's rotation picks; a separate,
  human-or-Claude-assisted session performs the actual research and
  commits the result files, which the NEXT scheduled run picks up.
- **If research/network is unavailable**: irrelevant to the scheduled job
  itself — it never touches the network. A `RESEARCH_MORE` finding simply
  stays `RESEARCH_MORE` until a research file answers it.
- **If a run fails halfway**: see §10 above — an honest `failed:true`
  record is written; the next scheduled run is unaffected (no corrupted
  state carries forward) except that change-detection will compare
  against whatever the last SUCCESSFUL run was, since the failed record's
  `findings` array is empty (never a false "nothing is open anymore").
- **Concurrency**: `run-lock.js` (§10) — a second scheduled invocation
  while one is still running is refused, not interleaved.
- **Vercel/function implications**: NONE. This CLI runs outside any
  Vercel function (a cron-triggered GitHub Action, or an external
  scheduler hitting a thin trigger, are both viable — this phase does not
  pick one, since picking one IS the activation step being deliberately
  deferred). If a future phase wants a Vercel Cron-triggered HTTP
  endpoint instead of an external scheduler, it would need to reuse an
  EXISTING function (the 12/12 budget is fully consumed, confirmed
  unchanged by this phase) rather than add one.

## 11. Testing (HISTORICAL — see "Phase 5B" below for the current test list; `agent-adjust-workflow.test.js` listed here was deleted in Phase 5B)

10 new test files, all passing: `agent-business-profile`,
`agent-change-detection`, `agent-research-freshness`,
`agent-research-rotation`, `agent-completed-job-intake`, `agent-run-lock`,
`agent-report`, `agent-adjust-workflow`, `agent-reports-api`,
`agent-reports-ui`, plus `agent-runner-phase5` (11 total) and 2 existing
files updated (`agent-migrations-review` extended for the new SQL file,
`agent-proposals-ui` updated for new UI wording). Full repository suite
(85 files) run: 84 pass, 1 pre-existing unrelated failure
(`phase3c-batch5-intake-ui.test.js`, present since before this branch
existed, confirmed untouched by `git log` — see that file's own history).

## Implementation discipline — what was deliberately NOT built (HISTORICAL — see "Phase 5B" below)

Per the brief's own "don't overbuild" instruction: no new Supabase
tables beyond the one additive migration; no new Vercel functions (still
exactly 12); no paid APIs; no numeric health score anywhere; the 4th
"Recommended Phase 5" wish-list item (expanding the audit surface
further) was left for a future phase, since it's unrelated to the
daily/weekly operating-system request; Adjust's auto-regeneration half
was evaluated and explicitly deferred (§8) rather than built messily.

## Remaining risks / open questions (HISTORICAL — superseded by "Phase 5B"'s own "Remaining risks" below)

1. `agent_proposals`'s `applied`/`validated`/`failed` states are still
   only ever set by the narrow mechanical whitelist — "close the loop on
   approved PROPOSE_CHANGE proposals" (item 3 of the old wish-list) is
   still open.
2. The weekly rotation's scoring weights (§4) are a reasonable first
   pass, not tuned against multiple real weekly runs yet (there has only
   ever been one real run in this repo's history, per the Phase 1-4
   README's own note) — worth revisiting after a few real weeks.
3. Scheduling is designed, not activated — see that section. Activating
   it is a separate, explicit decision for Rocky.
4. `research-rotation-state.json`'s scoring currently treats every
   "claimed-but-pageless" city as a flat +8 — real-world weekly runs may
   reveal some of those 7 cities deserve a different priority than others
   (e.g. based on actual lead volume by city, not modeled here since that
   data isn't available to this agent).

---

# Phase 6 — First-Party Search + Analytics Intelligence

Built on the SAME branch (`site-improvement-agent-phase2`), immediately
after Phase 5B (`9cbdf67`). Gives the agent first-party EVIDENCE from
Google Search Console (Search Analytics + URL Inspection) and GA4 —
strictly as additional, inspectable signal alongside the existing
scanner/research/completed-job evidence, never as a new decision path.
**Read this section's §4 ("metrics are signals, not decisions") before
touching anything here** — it's the one rule every other design choice in
this phase exists to protect, and it's enforced structurally (by code
and tests), not just by convention.

**Auth-hardening follow-up (same phase, built immediately after real
Google Cloud setup began)**: real setup hit the org's
`iam.disableServiceAccountKeyCreation` policy — Google's own
secure-by-default posture, correctly left untouched rather than
disabled. §3A/§3B below replace the single `GOOGLE_SERVICE_ACCOUNT_JSON`
mechanism this section originally shipped with a keyless-by-default
model (service-account impersonation via Application Default
Credentials, preferred; direct ADC and the legacy key kept only as
narrower/optional fallbacks) — read §3A/§3B instead of (not in addition
to) any surviving references to "the service-account JSON key" being
required elsewhere in this section.

## 1. What was already there (investigated before building anything)

- **GA4 is already live on every public page**: a literal inline
  `gtag.js` snippet (measurement ID `G-WC7NX6SETQ`) copy-pasted into the
  `<head>` of every top-level `*.html` file — no shared analytics helper
  file exists. Custom events already fired: `phone_click`/`sms_click`
  (`nav.js`, site-wide header), `contact_form_start`/`generate_lead`/
  `contact_form_submit_error` (`contact.html`), `before_after_interaction`
  + a local `trackSocialEvent` wrapper (`index.html`), and the booking
  funnel's own `booking_started`/`booking_service_selected`/
  `booking_date_selected`/`booking_form_completed` (`book/book.js`).
  Phase 6 reads this EXISTING event taxonomy via the GA4 Data API — it
  does not invent a second one, and does not touch `nav.js`/`book.js`/
  `contact.html`/`index.html` (CLAUDE.md: tracking is never modified
  without Rocky's explicit authorization, and there was no demonstrated
  bug in it — Rocky's own Phase 6 brief authorized the NEW read-only
  integrations, not a change to the site's existing tracking code).
- **No existing Search Console integration** anywhere in the repo.
- **Two other existing Google integrations**, both plain-`fetch`, no SDK:
  Google Places (`api/reviews.js`, API-key auth, `GOOGLE_PLACES_API_KEY`/
  `GOOGLE_PLACE_ID`) and Google Maps JS (admin address autocomplete,
  `ADMIN_GOOGLE_MAPS_API_KEY`). Neither uses OAuth/a service account —
  Phase 6 is the first integration here that needs one (Search Console
  and GA4's Data API are both scoped-OAuth-only; there is no API-key
  mode for either). `googleapis`/`google-auth-library` are NOT in
  `package.json` — Phase 6 does not add them either (see §11).
- **Env var convention**: plain upper-snake-case, read via
  `process.env.X` with a falsy guard, no app-specific prefix (e.g.
  `SUPABASE_URL`, `STRIPE_SECRET_KEY`, `GOOGLE_PLACES_API_KEY`). Phase 6's
  three new env vars (§11) follow this exactly.
- **Existing Phase 5B evidence/research/orchestration architecture** (see
  above) is the template this phase reuses wholesale: a validated,
  provenance-carrying evidence shape (`research.js`'s
  `makeResearchResult()`), a fails-safe intake reader
  (`research-intake.js`), a separate explicit network-touching CLI step
  that the deterministic runner never calls itself
  (`completed-job-fetch.js` + `--refresh-completed-jobs`), and the
  orchestrator-driven resume lifecycle (§5 of Phase 5B above). Phase 6
  adds one more instance of each of those same patterns for GSC/GA4/URL
  Inspection, rather than inventing a new architecture.

## 2. New files

| File | Purpose |
|---|---|
| `agent/lib/google-auth.js` | **The unified auth resolver** every client imports — impersonation > direct ADC > legacy key, see §3A |
| `agent/lib/google-adc.js` | Application Default Credentials loader (keyless — a credential file, or the GCE/Cloud Run metadata server) |
| `agent/lib/google-impersonation.js` | Short-lived service-account impersonation via the IAM Credentials API |
| `agent/lib/google-service-account-auth.js` | Legacy JWT-bearer OAuth2 key exchange — now TIER 3, optional fallback only (see §3A) |
| `agent/lib/search-console-client.js` | Raw Search Analytics query + URL Inspection calls |
| `agent/lib/ga4-client.js` | Raw GA4 Data API `runReport` call |
| `agent/lib/firstparty-evidence.js` | Normalized evidence schema + freshness windows (no verdict/confidence/recommendation field — see §4) |
| `agent/lib/firstparty-fetch.js` | The ONLY module that actually calls GSC/GA4 — targeted fetch + normalize + bounds/privacy guards |
| `agent/lib/firstparty-intake.js` | Reads `agent/research/firstparty/*.json`, attaches to findings by key, for DISPLAY ONLY |
| `agent/research/firstparty/` | Evidence file directory (git-tracked, intentionally empty on this checkout) |
| 12 new `tests/agent-firstparty-*.test.js`/`tests/agent-google-*.test.js` | §16 |

Modified (additive only): `agent/runner.js` (wires the new intake step
in, AFTER `decideAll()` — see §4; computes the two `isXConfigured()`
booleans, still zero network calls, and passes them to `buildReport()`),
`agent/lib/report.js` (new `report.firstPartyEvidence` summary field),
`agent/cli.js` (new `--fetch-firstparty=<request.json>` step),
`admin/agent-reports.js` (new compact "First-party evidence" block in
the report detail view), `agent/lib/search-console-client.js`/
`agent/lib/ga4-client.js` (auth-hardening follow-up, §3A: now import
from `google-auth.js` instead of going straight to the legacy key
module — their own `isSearchConsoleConfigured()`/`isGa4Configured()`
signatures are unchanged). **Not modified**: `decision.js`, `risk.js`,
`findings.js`, `research.js`, `research-intake.js`,
`research-rotation.js`, `change-detection.js`, `business-profile.js`,
`completed-job-fetch.js`/`completed-job-intake.js`, every audit module,
`vercel.json`, `package.json`, any `api/*.js` file, any `sql/*.sql` file,
and every piece of the site's own GA4 tracking code.

## 3. Architecture: three new read-only clients, one shared auth helper

`agent/lib/google-service-account-auth.js` mints a short-lived OAuth2
access token from a service-account JSON via a hand-signed RS256 JWT
(`crypto.createSign`) exchanged at Google's token endpoint with a plain
`fetch` — the same lightweight-fetch style `api/reviews.js` already uses
for Google Places, deliberately NOT a reason to add `googleapis`/
`google-auth-library` as dependencies (brief §11/§16: smallest secure
model, don't overbuild). Fails safe exactly like
`api/_lib/supabase-admin.js`'s `getServiceClient()`: missing/invalid
config returns `{skipped:true, reason}`, never thrown, and (confirmed by
`tests/agent-google-service-account-auth.test.js`) attempts ZERO network
call when unconfigured. **This module is no longer the only, or the
preferred, way to authenticate — see §3A below**, added immediately
after this phase shipped, once real Google Cloud setup hit the org's
`iam.disableServiceAccountKeyCreation` policy.

## 3A. Auth-hardening follow-up — keyless by default, key-based only as a fallback

**Why**: this org's Google Cloud project blocks creating a long-lived
service-account key outright (`iam.disableServiceAccountKeyCreation`) —
Google's own secure-by-default posture, and correctly NOT something this
agent asked to have disabled. `GOOGLE_SERVICE_ACCOUNT_JSON` (§3 above)
therefore cannot realistically be populated for
`mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com` going
forward. This follow-up makes that env var one optional fallback among
three, with two genuinely keyless mechanisms tried first.

`agent/lib/google-auth.js` is the new single entry point
`search-console-client.js`/`ga4-client.js` both import
`getAccessToken()`/`isGoogleAuthConfigured()` from (neither client's own
code changed beyond that one import swap). It resolves auth in a FIXED
priority, each tier gated on its own "is this explicitly/discoverably
configured" check, with **no silent fallthrough once a tier is
configured** — a misconfigured preferred tier fails loudly with a
specific reason rather than quietly trying something else (proven by
`tests/agent-google-auth.test.js`'s "never falls through" tests):

1. **Impersonation (preferred, keyless)** — `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`
   set to the target SA's email. `agent/lib/google-adc.js` resolves a
   BASE identity token via Application Default Credentials (a human's
   own `gcloud auth application-default login`, or a hosted identity's
   ADC), then `agent/lib/google-impersonation.js` calls the IAM
   Credentials API's `generateAccessToken` to mint a short-lived
   (~1 hour) token scoped to EXACTLY what's needed
   (`webmasters.readonly` / `analytics.readonly`) — regardless of the
   base credential's own scope. No key file is ever created, read, or
   needed for the target service account; the human/hosted identity only
   needs `roles/iam.serviceAccountTokenCreator` on it. This is the ONE
   mechanism that reliably works end-to-end with zero extra login-time
   configuration, and is the recommended default for BOTH local dev and
   eventual unattended orchestration (§3B).
2. **Direct ADC (keyless, narrower)** — no impersonation configured, but
   an ADC credential FILE exists (`GOOGLE_APPLICATION_CREDENTIALS`, or
   the well-known `gcloud auth application-default login` path). Used
   directly, requesting the target scope from it. Only actually
   succeeds if that credential's own token already carries the target
   scope — an `authorized_user` file's scope is fixed at login time
   (`gcloud`'s default: `cloud-platform` + `userinfo.email` only) and
   cannot be narrowed per-request, so this tier typically needs an extra
   `gcloud auth application-default login --scopes=...,https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/analytics.readonly`
   to work for THESE specific APIs. Kept because the brief asked for ADC
   "where practical," documented honestly as narrower than impersonation
   rather than presented as equally reliable.
3. **Legacy service-account key (optional fallback, lowest explicit
   priority)** — `GOOGLE_SERVICE_ACCOUNT_JSON` set. Kept ONLY for
   forward/backward compatibility (a differently-governed project
   without this org's key-creation policy, or tests) — never required,
   never recommended going forward.
4. **Last resort: GCE/Cloud Run metadata server** — tried only when
   NONE of the three above are configured, for the case of an eventual
   orchestrator actually hosted on Google Cloud compute with zero
   environment configuration at all. Never interferes with an
   explicitly configured tier (confirmed by
   `tests/agent-google-auth.test.js`'s "no metadata-server pollution"
   test: a configured legacy key makes exactly one request, never a
   wasted metadata probe first).

A `GOOGLE_APPLICATION_CREDENTIALS`/well-known-gcloud-path file of type
`"external_account"` (Workload Identity Federation — e.g. a CI identity
federated into GCP with no Google credential at all) is recognized and
explicitly reported as **not yet supported** rather than mis-handled —
see §3B for why, and the upgrade path once/if it's ever needed.

None of these three credential-resolution modules
(`google-adc.js`/`google-impersonation.js`/`google-auth.js`) ever call
`console.*` (checked directly by a dedicated test) — nothing is ever
logged, so there is no code path where a debug log could leak a token.
Every result returned by any tier is exactly
`{skipped, accessToken, ...a non-secret metadata field, source}` —
never a credential file's own secret fields
(`refresh_token`/`client_secret`/`private_key`) — proven end-to-end
(auth → fetch → normalize → write to disk) by
`tests/agent-firstparty-auth-integration.test.js`.

## 3B. Recommended setup — local Windows dev AND eventual unattended orchestration

**The SAME one-time step serves both**, because `gcloud auth
application-default login`'s resulting credential file persists on disk
and silently refreshes itself on every subsequent use — no repeated
browser interaction required after the first login:

1. Install the Google Cloud CLI on this Windows machine (if not already
   installed), then run once, interactively:
   ```bash
   gcloud auth application-default login
   ```
   This opens a browser, authenticates as Rocky's own Google identity
   (not the service account), and writes
   `%APPDATA%\gcloud\application_default_credentials.json` — a
   refresh-token-based credential tied to Rocky, never a service-account
   key, never subject to `iam.disableServiceAccountKeyCreation`.
2. In Google Cloud Console (IAM & Admin → IAM, or directly on the
   service account's "Permissions" tab), grant Rocky's own Google
   account the role **Service Account Token Creator**
   (`roles/iam.serviceAccountTokenCreator`) scoped to
   `mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com`
   specifically (not project-wide) — this is the ONLY new permission
   this phase needs granted, and it does not grant Rocky's account any
   OTHER access to Search Console/GA4 data directly; it only lets that
   account mint short-lived tokens AS the already-narrowly-scoped
   service account.
3. Set exactly these three env vars wherever `node agent/cli.js
   --fetch-firstparty=...` will actually run (this Windows machine's own
   shell/profile, or whatever environment hosts the eventual scheduled
   orchestrator session — never Vercel, see §17):
   ```
   GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com
   GSC_SITE_URL=<the exact Search Console property — e.g. https://www.milehighjunkremoval.net/ or sc-domain:milehighjunkremoval.net>
   GA4_PROPERTY_ID=549425042
   ```
   `GOOGLE_APPLICATION_CREDENTIALS` does NOT need to be set — step 1
   already wrote the credential to gcloud's well-known path, which
   `agent/lib/google-adc.js` discovers automatically.
4. Sanity-check with one targeted request before relying on it in a real
   run (see §12's example `--fetch-firstparty` request file).

**If/when the orchestrator later moves to GitHub Actions or another
non-Google-Cloud CI** (true Workload Identity Federation — no Google
credential anywhere, not even a refresh token): that federated identity
would need `roles/iam.serviceAccountTokenCreator` on the same service
account (identical IAM grant as step 2 above — WIF changes WHO is
authenticating, not what they're authorized to do), and
`agent/lib/google-adc.js` would need its `"external_account"` branch
implemented (currently an honest "not yet supported" — see §3A). Not
built in this pass since no such CI identity exists yet — building the
STS token-exchange protocol for a provider nobody has configured would
be exactly the overbuilding this phase was asked to avoid.

**If/when the orchestrator runs ON Google Cloud compute** (a GCE VM,
Cloud Run job, etc.): no env vars beyond `GSC_SITE_URL`/`GA4_PROPERTY_ID`
are needed at all — either grant that compute resource's own attached
service account `roles/iam.serviceAccountTokenCreator` on
`mile-high-site-agent@...` and set `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`
(tier 1, same as local dev), or skip impersonation entirely and grant
the Search Console/GA4 roles directly to that compute resource's own
identity (tier 4, the metadata-server last resort already implemented).

`search-console-client.js` (`querySearchAnalytics()`, `inspectUrl()`) and
`ga4-client.js` (`runReport()`) are thin wrappers that call exactly one
targeted API request and hand back the RAW response shape to their one
caller, `firstparty-fetch.js` — normalization happens in exactly one
place, not scattered across callers.

## 4. "Metrics are signals, not decisions" — the hard rule, enforced structurally

No individual Search Console/GA4/URL Inspection observation may
independently produce `PROPOSE_CHANGE` or `APPLY_SAFE_FIX`. This is not
just stated in prose — it is true by construction, for two independent
reasons:

1. **The evidence shape itself has no verdict.**
   `firstparty-evidence.js`'s `makeFirstPartyEvidence()` has no
   `verdict`/`confidence`/`recommendation` field at all (unlike
   `research.js`'s `makeResearchResult()`, which does, and which IS
   allowed to tip a decision — see §2's original Phase 2/3 "External
   research" section above). A metric can describe WHAT was observed; it
   cannot assert a conclusion.
2. **`decision.js` never reads it.** `agent/runner.js`'s
   `gatherFindings()` calls `attachFirstPartyEvidence()` strictly AFTER
   `decideAll()` has already produced every finding's `.decision` (see
   the comment at that exact call site in `runner.js`) — but even that
   ordering is belt-and-suspenders: `decision.js`'s `decide()` function
   has zero code paths, destructures, or property accesses anywhere in
   its body that reference `.firstPartyEvidence`.
   `tests/agent-firstparty-safety.test.js`'s first two tests prove both
   halves directly: `decide()` produces byte-identical output for two
   otherwise-identical findings that differ only in whether
   `.firstPartyEvidence` is populated, and a regex check over
   `decide.toString()` confirms the string `firstPartyEvidence` never
   appears in its source at all.

So `finding.firstPartyEvidence` exists for exactly one purpose:
**report/provenance display** — "here is the first-party evidence a
human/orchestrator gathered while investigating this finding," surfaced
in `report.firstPartyEvidence` (§8) and `admin/agent-reports.js`'s detail
view, never "here is what changed the outcome." The only way first-party
evidence can ever influence a real decision is INDIRECTLY: by informing
a human/orchestrator who then writes an actual `research.js`
verdict-bearing result (citing the first-party evidence in its own
`evidence`/`source`) — the same path every other category-C opportunity
already goes through. This also means a weak/concerning metric (a CTR
near zero, a position drop, a spike in impressions for a city) is never,
by itself, sufficient justification to rewrite a title, change a CTA,
create a page, or redirect anything — see §6/§7/§8 below for the
specific guardrails this implies, each with its own regression test.

## 5. Normalized evidence schema (`agent/lib/firstparty-evidence.js`)

One shape for all three sources, mirroring `research.js`'s validation
discipline (a result may not assert anything without its source, scope,
window, and limitations recorded):

```
{
  findingKey,       // optional — the Finding.key this informs, or null
  source,           // "search-console-search-analytics" | "search-console-url-inspection" | "ga4"
  metric,           // e.g. "clicks-impressions-ctr-position", "indexStatus", "sessions"
  dimension,        // e.g. "query", "page", "landingPage" — or null
  scope: {type, value},   // what this is ABOUT: "page" | "query" | "city" | "site"
  window: {start, end, label},        // the exact date range queried — never omitted
  comparisonWindow: {...} | null,     // the prior period compared against, if any
  observed,         // small, BOUNDED normalized value(s) — never the raw API response
  context,          // what was queried and why, in plain language
  limitations,      // required, like research.js — what this does NOT establish
  fetchedAt,
}
```

No raw API payload is ever stored — `firstparty-fetch.js` picks out only
the specific fields each `observed` shape needs (e.g. Search Analytics:
`{totalRowsReturned, topRows: [...]}` capped at `MAX_ROWS` (10); URL
Inspection: `{verdict, coverageState, googleCanonical, userCanonical,
lastCrawlTime}`, discarding everything else the API returns, including
unrelated result blocks like `mobileUsabilityResult`). Proven end-to-end
(fetch → normalize → write → read back) by
`tests/agent-firstparty-fetch.test.js`'s "never leaks"/"raw-only marker"
tests.

`computeFirstPartyFreshness()` mirrors `research.js`'s
`computeFreshness()` with per-source windows reflecting real differences
in how fast each source's data is both DELIVERED and stays MEANINGFUL
(§6): Search Console (`aging: 10d, stale: 21d` — real reporting lag,
naturally noisy day to day), URL Inspection (`aging: 14d, stale: 30d` — a
point-in-time check whose underlying state can drift), GA4
(`aging: 7d, stale: 14d` — closer to real-time, goes stale fastest).

## 6. Freshness / comparison windows

`firstparty-fetch.js`'s `computeWindow(days, lagDays)` builds
`{start, end, label}` ending `lagDays` days before "now" — 3 days for
Search Console (its well-known reporting lag; querying through "today"
would silently include an incomplete, misleadingly-low final few days),
1 day for GA4 (a smaller same-day-completeness buffer). The window used
is always recorded ON the evidence itself (`window.label`, e.g. "28 days
ending 2026-10-10") — never implied. There is no hardcoded single
window everywhere: every `fetch*Evidence()` function takes an explicit
`days` parameter (default 28), so a targeted question that needs a
different comparison period (e.g. a shorter recent spike, or a longer
seasonal pattern) is never forced into one default. When Search
Console/GA4 are unconfigured, or an API call fails, the evidence simply
isn't produced — `report.firstPartyEvidence.gatheredThisRunCount` stays
at `0` and `integrations.{searchConsole,ga4}` stays `false`; nothing
manufactures a trend or a fake "insufficient data" placeholder value.

## 7. Service-area safety (unchanged guard, now proven against first-party evidence specifically)

The Phase 5B rule — 20 claimed service-area cities ≠ 20 required city
pages — is untouched by this phase, and there is still no finding type,
anywhere in `risk.js`'s `RULES`, that represents "create a new page."
`tests/agent-firstparty-safety.test.js` adds the Phase-6-specific proof:
feeding a `coverage-gap-candidate` finding deliberately EXTREME, high-
impression, near-zero-CTR first-party evidence for a claimed-but-
pageless city (Brighton) through `decide()` changes nothing — the
decision is identical with or without that evidence attached, and the
evidence shape itself has no `decision`/`recommendation`/`createPage`
field for anything to act on even if it tried. Search Console impressions
for a city, GA4 sessions for a city's nearest page, or a weekly rotation
pick are all still only ever EVIDENCE an opportunity might exist — never
a page-creation trigger, individually or combined.

## 8. Cannibalization safety (unchanged guard, now proven against query/page overlap evidence)

Same posture: `cannibalization-audit.js`'s `overlapping-intent` finding
type is untouched, and the only mechanical auto-fixer registered anywhere
in this codebase is still `rewrite-href` (used only for
`redirect-hop-internal-link`/`broken-internal-link-fixable` —
`tests/agent-firstparty-safety.test.js` confirms this by grepping
`agent/lib/*.js` for every place `autoFix:` is attached, finding only
`link-audit.js`, to only those two types). Attaching Search-Console-
observed query/page overlap evidence (two pages both receiving
impressions for a similar query) to an `overlapping-intent` finding does
not change its decision and cannot route it anywhere near an auto-
merge/delete/redirect, because no such fixer exists for this finding
type to reach even if a decision wanted one to.

## 9. Privacy

Aggregate analytics only — no user-level analytics or visitor profiling
is introduced. Two independent guarantees:

1. **GA4 dimension denylist, checked BEFORE any request is sent**:
   `firstparty-fetch.js`'s `fetchGa4Evidence()` refuses `clientId`,
   `userId`, `userPseudoId`, `appInstanceId`, or `ipOverride`-shaped
   dimensions outright — `{skipped:true, reason: "...visitor/client-
   identifier dimension..."}`, with the injected `fetchImpl` proven NEVER
   called for any of them (`tests/agent-firstparty-fetch.test.js`). This
   is enforced in code, not left to whoever crafts a request JSON file to
   remember.
2. **Nothing here touches the completed-job privacy boundary.**
   `business-context.js`/`completed-job-fetch.js` (Phase 3/5B) are
   entirely unmodified by this phase; first-party search/analytics
   evidence and completed-job evidence are two separate evidence
   categories that are never joined to each other or to any individual
   client/booking record anywhere in this codebase.

No IP address, client ID, session ID, or individual visitor identifier
is ever requested, normalized, or persisted — `observed` shapes are
always small, aggregate counts/metrics/rows keyed by query/page/
dimension-name, never by person.

## 10. Failure behavior

Exactly the same fails-safe posture as every other optional integration
in this codebase (`getServiceClient()`, `completed-job-fetch.js`,
`research-intake.js`): missing credentials, a missing property/site
grant, an API error, a quota/rate-limit response, or an unreachable
endpoint all degrade to `{skipped:true, reason}` at the client layer,
propagate up through `firstparty-fetch.js` unchanged, and are logged by
the CLI wrapper as a one-line skip message — never thrown, never
mistaken for "zero evidence because there's nothing to report." Because
`decision.js` never reads first-party evidence at all (§4), a
`RESEARCH_MORE` finding stays `RESEARCH_MORE` (and a run stays
`research_pending`) regardless of whether first-party evidence happened
to be available — missing analytics can never be read as "all clear"
(`tests/agent-firstparty-runner.test.js`'s last test proves this
directly: a `RESEARCH_MORE` finding with rich attached first-party
evidence still reports `status: "research_pending"`). A daily/weekly run
with a genuinely clean deterministic audit still completes normally even
when GSC/GA4 are fully unconfigured — `report.firstPartyEvidence`
honestly shows `integrations: {searchConsole:false, ga4:false}` rather
than silently omitting the section.

## 11. Credentials / APIs required

**Smallest secure, keyless-by-default model** (updated by the §3A/§3B
auth-hardening follow-up): one service account, two scoped read-only
IAM grants, impersonated from a human's (or a hosted identity's) own
Application Default Credentials — never a downloaded long-lived key for
`mile-high-site-agent@...`, consistent with this org's
`iam.disableServiceAccountKeyCreation` policy. Env vars follow this
repo's existing convention (plain upper-snake, `process.env.X`,
falsy-guarded); no new npm dependency was added for any of this.

| Env var | Purpose | Required? |
|---|---|---|
| `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` | The target SA's email to impersonate (tier 1, preferred) | Recommended |
| `GSC_SITE_URL` | The exact Search Console property identifier, e.g. `https://www.milehighjunkremoval.net/` or `sc-domain:milehighjunkremoval.net` | Yes, for Search Console |
| `GA4_PROPERTY_ID` | The numeric GA4 property ID | Yes, for GA4 |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to an ADC credential file (tier 2) — usually unset; `gcloud auth application-default login`'s well-known path is found automatically | Optional |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | A legacy service-account key JSON (tier 3, optional fallback) | Optional, not recommended |

**Already completed on the Google Cloud side (per Rocky, confirmed —
not performed by this agent)**:

- "Google Search Console API" and "Google Analytics Data API" both
  enabled on the project.
- Service account created: `mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com`.
- That service account granted **Restricted** access in Search Console
  on the `milehighjunkremoval.net` property.
- That service account granted **Viewer** in GA4 Property Access
  Management.
- `GA4_PROPERTY_ID=549425042`.
- Service-account key creation confirmed BLOCKED by the org's
  `iam.disableServiceAccountKeyCreation` policy — this agent does not
  ask for that policy to be relaxed; §3A/§3B's keyless model exists
  specifically so it never needs to be.

**Owner setup steps still required on Rocky's Windows machine — see §3B
for the full writeup; summarized here**:

1. Install the Google Cloud CLI (`gcloud`) if not already installed, then
   run once, interactively: `gcloud auth application-default login`.
2. In Google Cloud Console, grant Rocky's own Google account
   `roles/iam.serviceAccountTokenCreator` scoped specifically to
   `mile-high-site-agent@mile-high-site-agent.iam.gserviceaccount.com`
   (not project-wide).
3. Set `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`, `GSC_SITE_URL`, and
   `GA4_PROPERTY_ID` wherever `node agent/cli.js --fetch-firstparty=...`
   will actually run — NEVER Vercel env vars, since no Vercel function
   ever calls this (see §17).
4. Sanity-check with a single targeted request file before relying on it
   in a real run (see §12's example).

No credentials were created, requested, or configured BY THIS AGENT —
`isSearchConsoleConfigured()`/`isGa4Configured()` both correctly report
`false` in this sandboxed environment today (it has no `gcloud` install,
no ADC file, and no env vars set — confirmed before writing any of this
code).

## 12. Orchestrator integration

Follows Phase 5B's exact orchestrator pattern (§5 of that section above)
with one more optional step inserted between "read the pending
questions" and "write research result files":

```
node agent/cli.js --daily --json   (or --weekly --json)
  -> report.status === "research_pending"?
     For each entry in report.research.questionsPending[] (and, weekly
     only, optionally report.rotation.picks[]):
       - If a TARGETED first-party query would meaningfully inform this
         specific question (brief §1/§2/§3's examples — an Aurora
         opportunity, an existing page's query/page performance, a
         specific indexing/canonical concern) — write a small request
         JSON and run:
             node agent/cli.js --fetch-firstparty=<request.json>
         e.g. {"type":"search-analytics","findingKey":"coverage-gap-candidate::...",
               "scope":{"type":"city","value":"Aurora"},"days":28}
       - Research the question per the existing evidence hierarchy
         (official sources first, competitors for landscape only),
         optionally citing the first-party evidence just gathered, and
         write agent/research/results/<slug>.json (research.js's
         makeResearchResult() — unchanged shape).
  -> node agent/cli.js --resume=<runId>
  -> report.status again: "completed" | "research_pending" (loop) | "failed"
```

Never run automatically by `--daily`/`--weekly` themselves — the
deterministic pipeline stays network-free (confirmed by
`tests/agent-firstparty-runner.test.js`'s static-source check: `runner.js`
imports `search-console-client.js`/`ga4-client.js` ONLY for their pure
`isXConfigured()` checks, never `querySearchAnalytics`/`inspectUrl`/
`runReport`). `--fetch-firstparty` is a peer of `--refresh-completed-jobs`
(Phase 5B) — both are separate, explicit, orchestrator-invoked steps; the
runner itself calls neither.

## 13. Daily vs. weekly usage (procedural, like the existing research loop)

Same posture as Phase 5B's external-research loop (its own "Remaining
risks" §1 already notes that loop is a documented PROCEDURE, not code-
enforced) — there is no code that forces or forbids a first-party fetch
on a given run type; this section is the orchestrator's guidance:

- **Daily**: lightweight by default. Only fetch first-party evidence when
  a specific actionable/research finding genuinely warrants it, or a
  just-made site change needs a quick indexing/visibility sanity check
  (one targeted URL Inspection, not a sweep). Never query every
  page/query/city every day.
- **Weekly**: may go deeper — e.g. first-party evidence for the week's
  `report.rotation.picks[]` alongside their external research, a broader
  (still targeted, still bounded) Search Analytics look at a specific
  opportunity, or a small batch of URL Inspections for pages that changed
  recently. A weekly run that finds nothing worth fetching first-party
  evidence for is still a valid, complete run — this phase does not
  manufacture first-party queries to "use" the integration.

## 14. CRM reporting (`report.firstPartyEvidence`, `admin/agent-reports.js`)

`report.firstPartyEvidence` (built by `report.js`, computed purely from
findings' already-attached evidence — never a live call at report-build
time):

```
{
  integrations: {searchConsole: bool, ga4: bool},   // configured? (env-var check only, no network)
  gatheredThisRunCount: number,
  countsBySource: {"search-console-search-analytics": n, "search-console-url-inspection": n, "ga4": n},
  items: [{findingKey, source, metric, scope, window, freshness, context}, ...],
}
```

`admin/agent-reports.js`'s report detail view renders exactly this — two
"available"/"not configured" lines, and (only when `gatheredThisRunCount
> 0`) up to 10 short one-line summaries, each the plain-language
`context` string plus scope/window/freshness — matching the brief's own
example shape ("Search Console: available · GA4: available · URL
Inspection: 2 targeted URLs checked") and deliberately NOT a raw-numbers
table or a second analytics dashboard.

## 15. External research provider boundary (unchanged, reconfirmed)

Phase 5B's orchestrator loop already treats "perform the actual research"
as the orchestrating Claude session's own job (WebSearch/WebFetch), not a
pluggable provider abstraction in code — this phase doesn't change that,
and doesn't integrate Perplexity/Brave/any paid research API (explicitly
out of scope per the brief). Nothing in this phase's architecture assumes
a specific provider; a future phase choosing one plugs into the same
"write `agent/research/results/*.json`, then `--resume`" boundary that
already exists.

## 16. Tests

```bash
node tests/agent-firstparty-evidence.test.js
node tests/agent-firstparty-intake.test.js
node tests/agent-google-service-account-auth.test.js
node tests/agent-search-console-client.test.js
node tests/agent-ga4-client.test.js
node tests/agent-firstparty-fetch.test.js
node tests/agent-firstparty-safety.test.js
node tests/agent-firstparty-runner.test.js
node tests/agent-google-adc.test.js
node tests/agent-google-impersonation.test.js
node tests/agent-google-auth.test.js
node tests/agent-firstparty-auth-integration.test.js
```

12 new files, all passing, covering (per the brief's own checklist):
evidence schema validation + freshness windows; intake fixture-dir
loading/attachment/malformed-file handling; **the unified auth resolver's
exact tier priority** (impersonation > direct ADC file > legacy key >
last-resort metadata server, with zero silent fallthrough once a tier is
configured, and zero wasted metadata-server probe when a tier is
explicitly configured — the specific regression this auth-hardening
follow-up exists to prevent); ADC's authorized_user/service_account/
external_account file handling and the metadata-server fallback, all
via injected fetches, never a real gcloud install; impersonation's IAM
Credentials API call shape and graceful degradation; both API clients
(request-shape assertions, graceful degradation on error); the
fetch/normalize layer (MAX_ROWS cap, raw-payload-never-persisted
end-to-end, the GA4 privacy denylist with zero requests sent); the hard
safety rules (`decide()` byte-identical with/without first-party
evidence, by both behavior AND source-grep; the auto-apply whitelist's
exact scope re-confirmed; service-area and cannibalization guards
re-proven); runner/report wiring (every finding gets the field,
network-free pipeline re-confirmed by source grep, status/health summary
unaffected by evidence volume); **no credential material (refresh
token/client secret/private key/access token) ever appears in a
returned auth result, a written evidence file, or `report.firstPartyEvidence`**
(proven end-to-end: auth → fetch → normalize → write to disk); and
**zero `console.*` calls in any of the three new auth-resolution
modules** (nothing is ever logged). Full repository suite: same single
pre-existing, unrelated failure as Phase 5/5B
(`phase3c-batch5-intake-ui.test.js`) — every other file, including all
12 new ones, passes (99 total test files, 98 passing).

## 17. Vercel / DB impact

Zero. No new Vercel function (still 12/12 — nothing in `api/` was
touched), no new/altered SQL migration (first-party evidence lives in
git-tracked JSON files under `agent/research/firstparty/`, exactly like
`agent/research/results/`/`agent/research/completed-jobs/` — no new
table), no change to `vercel.json`. `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`/
`GOOGLE_APPLICATION_CREDENTIALS`/`GOOGLE_SERVICE_ACCOUNT_JSON`/
`GSC_SITE_URL`/`GA4_PROPERTY_ID` are all read by the Node CLI only, in
whatever environment runs `node agent/cli.js --fetch-firstparty=...` —
never by a Vercel function, so none of them are ever added to Vercel's
own environment-variable configuration. The auth-hardening follow-up
also did not weaken, request an exception to, or otherwise touch the
org's `iam.disableServiceAccountKeyCreation` policy — it was worked
around entirely by using a different, keyless auth mechanism, not by
asking for the policy itself to change.

## 18. First live validation (real Google data) + two post-validation fixes

The first real `--daily` run against production GSC/GA4/URL Inspection
(via real impersonation — ADC + IAM Credentials API, no key file)
surfaced one real false positive and one real lifecycle gap. Both were
fixed immediately, before any merge, with regression coverage.

### 18A. Sitemap audit vs. noindex intent (correctness fix)

**What the live evidence showed**: the real daily run proposed adding
`privacy-policy.html` to `sitemap.xml` (`sitemap-missing-url`). A
targeted URL Inspection for that exact page showed real Google evidence:
`coverageState: "Excluded by 'noindex' tag"` — and the page itself
genuinely declares `<meta name="robots" content="noindex, follow">`.
Google and the page agree; the proposal was wrong.

**The general rule, not a special case**: `agent/lib/scan.js` now
extracts each page's own stated indexing intent
(`extractRobotsMeta()`/`noindex`, from its `<meta name="robots">` or
`<meta name="googlebot">` tag — a real, on-disk fact, same discipline as
every other scanned field). `agent/lib/link-audit.js`'s
`auditSitemapAndRobots()` uses this DIRECTLY — no filename is ever
checked: a page declaring `noindex` and missing from `sitemap.xml`
produces NO finding at all (its absence is consistent with its own
stated intent); a genuinely indexable page missing from the sitemap
still produces the existing `sitemap-missing-url` finding, unchanged.
The opposite disagreement — a `noindex` page that IS still listed in
`sitemap.xml` — is now surfaced as a new, narrow `noindex-page-in-sitemap`
finding (category A, tier **observation** — `risk.js`'s RULES table —
so `decision.js` always resolves it to `NO_CHANGE`, "not actionable on
its own"), never an automatic sitemap edit; this audit module still has
no write capability at all, and the only mechanical auto-fixer anywhere
in this codebase remains `rewrite-href`, used for exactly its original
two finding types.

Regression coverage (`tests/agent-link-audit.test.js`): an indexable
page missing from the sitemap still produces the actionable finding; a
noindex page missing from the sitemap produces nothing; a noindex page
already in the sitemap produces the new observation-only finding
(never `autoFix`, never `autoApplyEligible`); and the real
`privacy-policy.html` scan is asserted directly (no `sitemap-missing-url`
for it, with an explicit check that the page is genuinely noindexed — so
this test fails loudly, not silently, if that page's own markup ever
changes).

### 18B. First-party-evidence lifecycle tightening

**What the live validation showed**: evidence for the `sitemap-missing-
url` finding was fetched (via `--fetch-firstparty`) only AFTER that
daily run had already finalized as `"completed"` — so that run's own
persisted report honestly said `gatheredThisRunCount: 0`, even though
evidence was genuinely warranted and was gathered moments later for
exactly that finding. Truthful, but not the intended production
lifecycle: Rocky asked for evidence to be gathered BEFORE finalization,
reusing Phase 5B's existing pause/resume mechanism rather than inventing
a second one.

**The smallest coherent change**: `agent/lib/firstparty-candidates.js`
(new) deterministically identifies which DECIDED findings are
first-party-evidence CANDIDATES — narrow by design:

- Only a small, fixed type list (`sitemap-missing-url`,
  `robots-sitemap-conflict`, `canonical-mismatch`, `missing-canonical`,
  `orphan-page`) whose own definition IS an indexing-consistency
  question. Category-C findings keep their existing, separate
  `RESEARCH_MORE` path unchanged — not folded into this one.
- Never an `observation`-tier finding (decision.js already settled
  those as "not actionable on its own" — reopening them just to fetch
  more evidence would itself be manufactured work).
- Never a finding that already carries first-party evidence.
- Only when the finding is NEW this run (`change-detection.js`'s `new`
  list) — once a candidate has been through one cycle without anyone
  investigating it, it does NOT keep re-blocking every subsequent daily
  run forever (nothing stops an orchestrator from investigating an older
  still-open one manually anyway).

`report.js`'s `computeRunStatus()` now treats an unresolved first-party-
evidence question exactly like an unresolved research question: status
stays `"research_pending"` — **the SAME status value, not a new one** —
until it's resolved. Because `runner.js`'s resume mechanism
(`findResumableRun()`/`run({resumeRunId})`) already only checks
`status === "research_pending"` and never cared WHY, **zero changes**
were needed there: an orchestrator reads `report.firstPartyEvidence.
questionsPending[]` (mirrors `report.research.questionsPending[]` —
narrow question + a source-type hint, never a pre-filled request —
same shape discipline as `decision.js`'s `buildResearchQuestion()`),
runs the warranted `--fetch-firstparty` request(s), then calls the
EXISTING `--resume=<runId>` — which re-attaches the new evidence and
re-finalizes, exactly like a research resume always has.

`report.firstPartyEvidence` now also distinguishes, truthfully:
- `gatheredDuringThisRunCount` / `reusedFromBeforeCount` — per evidence
  item, whether its `fetchedAt` postdates the INITIAL pass's timestamp
  (genuinely fetched during this logical run/resume cycle) or predates
  it (already existed, simply reused) — a resumed pass naturally shows
  real "gathered during this run" counts; a fresh single-pass run
  (nothing can postdate its own start) correctly shows everything as
  reused, since the network-free runner never fetches anything itself.
- `sourcesNotConsulted` — which of the three sources contributed zero
  items this run.
- `questionsRaisedCount`/`questionsPending` — mirrors `report.research`'s
  shape exactly.

Metrics are still never decisions: `firstparty-candidates.js` is never
imported by `decision.js`, and the one place a pending question CAN
affect anything is `status`/`healthSummary` (exactly where a pending
RESEARCH_MORE question already could) — never `actionableOpenCount`,
never a finding's own `category`/`tier`/`decision`, never which pages
get scanned, never a new finding type, never an auto-applied change.

Regression coverage: `tests/agent-firstparty-candidates.test.js` (the
candidacy rules in isolation — type/tier/decision/evidence-presence/
`isNewThisRun` gating, and the question/hint shape) and
`tests/agent-firstparty-lifecycle.test.js` (full `buildReport()`
integration — a new candidate pauses the run with the right status/
health text; the same candidate already in the previous run does not
re-pause it; gathered-during-this-run vs. reused-from-before is computed
correctly in both a resume and a fresh single-pass run; `sourcesNotConsulted`;
and that none of this touches `actionableOpen`/`proposals` counts).

## Remaining risks / open questions (Phase 6)

1. Like Phase 5B's orchestrator loop, the daily-vs-weekly first-party-
   fetch guidance in §13 is a documented procedure, not code-enforced —
   nothing stops an orchestrator session from fetching first-party
   evidence unnecessarily on a daily run, or from never fetching any.
   §18B's new candidate-gating narrows this for the specific types it
   covers, but doesn't make it impossible to fetch evidence that wasn't
   strictly asked for.
2. ~~No real Search Console/GA4 credentials exist in this environment~~
   — **RESOLVED**: a real `--daily` run and three real targeted fetches
   (Search Analytics, GA4, URL Inspection) were performed successfully
   against production credentials via impersonation (§3A/§3B), proving
   the request/response shapes assumed here were correct.
3. `report.firstPartyEvidence.items` is currently uncapped beyond the
   per-fetch `MAX_ROWS`/10-items-in-the-UI limits — a hypothetical run
   with many targeted fetches attached to many different findings could
   produce a longer list than today's real usage pattern (a handful of
   targeted fetches per run) will ever actually produce; worth revisiting
   if that assumption changes.
4. The weekly research-rotation scorer (`research-rotation.js`) was
   deliberately NOT modified to incorporate Search Console impressions as
   a new scoring factor (the brief allows but does not require this,
   and risks destabilizing an already-tested scoring model for marginal
   benefit this phase) — a future phase could add it as one more
   documented, bounded factor, the same way completed-job evidence was
   added in Phase 5.
5. ~~Impersonation's base-ADC step has only ever been exercised against
   a FILE fixture in tests~~ — **RESOLVED**: `gcloud auth
   application-default login` was completed on Rocky's machine and a
   real refresh-token-backed base token was obtained and used for real
   impersonation.
6. ~~The IAM grant has not been performed yet~~ — **RESOLVED**: granted,
   confirmed by a successful real impersonated token exchange.
7. **(Auth-hardening follow-up, still open)** Workload Identity
   Federation (`external_account` ADC files) remains unimplemented —
   correctly deferred (no federated identity provider exists for this
   project yet) but worth revisiting if the orchestrator ever moves to
   GitHub Actions or another non-Google-Cloud CI runner (see §3B's note
   on that path).
8. **(§18B, new)** The `CANDIDATE_TYPES` list in
   `firstparty-candidates.js` is a deliberately narrow starting set —
   extending first-party-evidence candidacy to category-C findings
   (alongside their existing external-research path) is a documented,
   deliberately-deferred future option, not something this pass does.
9. **(§18B, new)** "New this run" (point 4 of §18B's candidate rules)
   means a candidate finding gets exactly ONE chance to pause a run for
   investigation; if nobody resumes it, it silently reverts to a normal
   open proposal on the next run, same as before this change — there is
   no escalation/reminder mechanism if a genuinely-warranted check is
   missed. Judged acceptable (matches the existing, already-accepted
   posture for research questions nobody ever answers), but worth
   revisiting if this pattern proves too easy to miss in practice.

---

# Phase 5B — Research Orchestration, Adjust Deferral, Migration Correction

Built immediately after Phase 5 (`df0eab6`), on the SAME branch
(`site-improvement-agent-phase2`), in response to Rocky's review. This
section is the CURRENT, authoritative state of the agent — read it
instead of (not in addition to) the "HISTORICAL" sections above wherever
they conflict.

## 1. Adjust removal

Fully reverted, cleanly, not just disabled: `sql/2026-10-14_phase5-agent-
adjust-workflow.sql` deleted; `api/admin/bookings.js`'s `adjust` PATCH
action, `adjust_requested` status, and `adjust_note`/`adjusted_at`
columns removed from `AGENT_PROPOSAL_STATUSES`/`AGENT_PROPOSAL_SELECT`/
`mapAgentProposal`/`handleReviewAgentProposal`; `admin/agent-proposals.js`
+ `index.html` reverted byte-for-byte to their pre-Phase-5 shape (git
`checkout` of the pre-Phase-5 commit, not a hand-revert); the Adjust CSS
rule removed from `admin/admin.css`; `tests/agent-migrations-review.test.js`
and `tests/agent-proposals-ui.test.js` reverted to their pre-Phase-5
shape. `agent_proposals`'s workflow is exactly `proposed → approved |
rejected`, identical to Phase 3 — confirmed by re-running
`tests/agent-proposals-api.test.js` unchanged and green.

A hard regression guard (`tests/agent-reports-ui.test.js`'s "no 'adjust'
... reference remains" test) scans every agent-related UI/API/SQL file
this project has for Adjust-workflow vocabulary and fails the build if it
ever creeps back in without deliberate reconsideration.

**Reasoning** (per Rocky): Adjust's "revise and resume" half always
required a separate human/Claude session to act on the feedback — with
Phase 5B now giving the orchestrator a resumable run lifecycle for
RESEARCH anyway (see §2 below), a proposal needing a human look is better
served by that same reviewer just rejecting it with a note (existing
Phase 3 behavior) than by a second, mostly-manual "adjust_requested"
limbo state. If a genuinely automated revise-and-resume flow is wanted
later, it's cleaner to build it as a presumably-related extension of the
resume lifecycle below than as the separate mechanism Phase 5 built.

## 2. Does Phase 5B need any DB migration? **No.**

Every Phase 5B capability — run status/sequence, resumable runs, the
orchestrator hand-off, completed-job auto-fetch — is either (a) fields on
the already-git-tracked `agent/history/log.ndjson` record (no schema;
it's a JSON blob per line, same as every Phase 1-5 field already was), or
(b) a narrowly-scoped SELECT against the EXISTING `bookings` table's
EXISTING columns (`status`, `service_type`, `service_city`,
`operational_note` — all already live since Phase 3's
`2026-10-12_phase3-agent-howd-it-go.sql`). With Adjust reverted, Phase 5B
introduces zero new tables, zero new columns, zero altered constraints.

**Migration-state correction** (per Rocky): Phase 3's two migrations
(`2026-10-12_phase3-agent-proposals.sql`, `2026-10-12_phase3-agent-howd-
it-go.sql`) are confirmed, by Rocky directly, to already be live in
production — current production code depends on them. This repo's own
code cannot independently verify an external database and should not
have hedged on that basis; this file and the project's own memory record
have been corrected to stop characterizing them as "unconfirmed."

## 3. Final Daily lifecycle

```
node agent/cli.js --daily [--apply-safe]
  -> scan -> 9 audits -> classify -> attach existing research ->
     decide -> (apply-safe only) apply narrow whitelist + validate ->
     sync proposals -> build report
  -> if ANY finding is RESEARCH_MORE: persist status "research_pending"
     (sequence 1). report.research.questionsPending[] has everything an
     orchestrator needs. STOP — this run is not finalized.
  -> else: persist status "completed" (sequence 1). Done.
```

External research is performed ONLY if a genuine category-C
`RESEARCH_MORE` finding exists — never manufactured daily (unchanged from
Phase 5's own "don't force a finding every day" principle, and from the
brief's original §3/§6).

## 4. Final Weekly lifecycle

```
node agent/cli.js --refresh-completed-jobs      (optional, see §10)
node agent/cli.js --weekly
  -> same daily pipeline, PLUS research-rotation scoring across the
     WHOLE 20-city service area (agent/lib/research-rotation.js,
     unchanged from Phase 5) using whatever completed-job evidence the
     refresh step above most recently wrote.
  -> rotation picks are ALWAYS included in the report (for the
     orchestrator to read), regardless of whether any finding is also
     RESEARCH_MORE.
  -> status "research_pending" if any finding needs research; the
     orchestrator should ALSO consider researching the rotation picks
     while it has web access open (same session, see §6) — rotation
     picks never themselves cause "research_pending" (they're not
     findings; a weekly run with rotation picks but zero RESEARCH_MORE
     findings still finalizes as "completed" in one pass, since the
     rotation picks are advisory investigation targets, not blocking
     questions).
  -> else: "completed" in one pass.
```

Only the top N (default 3) rotation picks per week — never every city
every week (brief §6, unchanged).

## 5. Orchestrator architecture

The orchestrator is a **Claude-driven session** (this very kind of
session) with Bash/file-write access to this repository and WebSearch/
WebFetch — NOT a new Node program, NOT a new Vercel function, NOT a new
service. `agent/runner.js`/`agent/cli.js` remain network-free; nothing
about that invariant changed. The orchestrator's job is entirely sitting
OUTSIDE the deterministic pipeline, driving it via two CLI invocations
(or one, when no research is needed):

```
Orchestrator session starts (scheduled or manual)
  1. node agent/cli.js --refresh-completed-jobs   (weekly only, optional)
  2. node agent/cli.js --daily --json   (or --weekly --json)
  3. Read the JSON result's `report.status`.
     - "completed": done. Report is final. Stop.
     - "failed": done. Report records the failure honestly. Stop —
       do NOT attempt to "fix" a pipeline failure by retrying research;
       that's a code/environment problem, not a research gap.
     - "research_pending": continue to step 4.
  4. For each entry in report.research.questionsPending[]:
     - Research it using the evidence hierarchy (brief §9, unchanged —
       official government first, competitors for landscape only).
     - For a weekly run, ALSO consider the top report.rotation.picks[]
       (advisory, not blocking) using the same hierarchy, if there's
       time/budget in this session.
     - Write agent/research/results/<slugified-key>.json conforming to
       research.js's makeResearchResult() shape — including the NEW
       `temporality`/`publishedAt`/`locality`/`topic` fields from Phase 5
       wherever the evidence has a real answer for them (never guessed).
     - Weak/inconclusive evidence is written as low-confidence/
       inconclusive — NEVER omitted to force a decision either way; the
       deterministic decision.js already resolves that honestly to
       NO_CHANGE.
  5. node agent/cli.js --resume=<runId>
  6. Read the result's `report.status` again.
     - "completed": done.
     - "research_pending" AGAIN: the orchestrator's research didn't
       actually answer every pending question (e.g. it only answered
       some, or a NEW category-C finding appeared from re-scanning —
       rare but possible if the evidence file itself exposed something).
       Loop back to step 4 for the remaining questionsPending.
     - "failed": the resume itself hit an error (e.g. a malformed
       research file). Report records it honestly. Stop.
```

This is a loop a Claude Code session (interactive or run via this
product's own scheduled-session mechanism) executes directly — no new
code was needed to make this possible beyond the resume capability
itself (§6 below); the "orchestration" is the session's own tool calls
(Bash, WebSearch, Write), not a new abstraction layer.

## 6. How research questions are handed to the research-capable layer

`record.report.research.questionsPending[]` — already fully-formed
`researchQuestion` objects (`findingKey`, `question`, `internalEvidence`,
`suggestedSourceTypes` — unchanged shape from Phase 2/3's
`decision.js#buildResearchQuestion()`), returned by `node agent/cli.js
--daily --json` (or `--weekly --json`), and also rendered in plain text
by the CLI's human-readable summary, and in the CRM report-detail page
(`admin/agent-reports/`'s new "Awaiting research" section) for a human
reviewer to see what's pending even without running the CLI.

## 7. How research results return to the deterministic engine

Unchanged mechanism from Phase 2/3: the orchestrator writes one
`agent/research/results/*.json` file per answered question, matching its
`findingKey`. What's NEW in Phase 5B is `node agent/cli.js
--resume=<runId>` — it re-runs the FULL deterministic pipeline fresh
(same `gatherFindings()` as every other run; `research-intake.js` picks
up the new files automatically, exactly as any later run always would
have), but reuses the SAME `runId` (a new `sequence`, see §9) rather than
minting a new one, and finalizes the record to `"completed"` or
`"failed"`. `runner.findResumableRun()` refuses to resume a runId that
doesn't exist or is already finalized — a resume can never silently
double-apply.

## 8. Report/run lifecycle states

`report.status` (top-level, machine-readable): `"completed"` |
`"research_pending"` | `"failed"` — computed by
`agent/lib/report.js#computeRunStatus()`, checked in that priority order
(failed wins over research_pending wins over completed). This is the
fix for the real bug Rocky flagged: before this, a run whose ONLY
findings were unresolved `RESEARCH_MORE` questions (category C, tier
"opportunity" — never "actionable", never `PROPOSE_CHANGE`) produced
`actionableOpenCount === 0` and `proposalsAwaitingApproval === 0`, which
read as `"all-clear"`. `computeRunStatus()` is now checked BEFORE that
logic, so a pending question always wins. Proven by
`tests/agent-report.test.js`'s dedicated regression test and the
end-to-end `tests/agent-runner-resume.test.js`.

`healthSummary.status` (display-oriented, CSS-class-friendly):
`"all-clear"` | `"needs-attention"` | `"research-pending"` | `"failed"` —
the Home card and report-history list both render a distinct blue
"awaiting research" treatment for this state (never the amber
"needs-attention" color — it isn't an issue to approve, it's "the
orchestrator hasn't finished yet").

No separate persisted `"running"` state was added — the deterministic
pass itself completes synchronously in seconds; nothing would ever
observe a mid-pass "running" record. The only genuinely multi-step,
possibly-slow state is `research_pending` (while the orchestrator does
real web research), which IS persisted and visible.

**"Avoid duplicate before/after-research reports"**: a resumed run is
recorded as a SECOND append-only line sharing the SAME `runId`
(`sequence` 1, then 2) — the git-tracked log itself is still never
rewritten (an absolute rule, unchanged). `agent/lib/history.js#
latestByRunId()` is the new read-time dedup every consumer (the Home
card, `?view=agent-reports`, `?view=agent-report`) now applies BEFORE
building any list or "most recent run" summary, so the owner always sees
exactly ONE report per logical run, in its current state — proven by
`tests/agent-runner-resume.test.js`'s dedup assertion and the three
updated `api/admin/bookings.js` handlers' own tests.

## 9. Completed-job retrieval architecture

New `agent/lib/completed-job-fetch.js` replaces the Phase 5 manual file
handoff. `node agent/cli.js --refresh-completed-jobs` is a SEPARATE,
explicit step (run by the orchestrator before `--weekly`, never by the
deterministic pipeline itself — `runner.js` still has zero network/DB
access):

```
fetchRecentCompletedJobEvidence()
  -> supabase.from("bookings")
       .select("status, service_type, service_city, operational_note")  <- narrowest possible column list, see below
       .eq("status", "completed")
       .gte("updated_at", cutoff)
  -> for each row: fromCompletedBooking(row)   <- the EXISTING Phase 3 privacy boundary, unchanged
  -> returns ONLY the already-redacted entries (a raw row is never
     returned, logged, or written anywhere by this module)
writeCompletedJobEvidence(evidence)
  -> overwrites ONE rolling file, agent/research/completed-jobs/
     latest-refresh.json (a snapshot, not an accumulating archive —
     the historical record of what the agent DID with this evidence
     already lives in agent/history/log.ndjson)
```

The SELECT itself never requests `customer_id`, `final_price`,
`estimated_price`, `tip_amount`, `payment_method`, `service_address`,
`internal_notes`, or any other private column — this is defense BEFORE
`fromCompletedBooking()`'s own redaction, not instead of it: even if a
future schema change widened the `bookings` table, a private value
cannot reach this process's memory via this specific query. The CLI
wrapper never logs field values, only a count.

## 10. Privacy guarantees + tests

Every requirement from the brief's "hard requirement" list is covered by
`tests/agent-completed-job-fetch.test.js`, using a realistic raw
`bookings` row with EVERY private field populated (customer name/id,
phone, email, exact address, final/estimated price, tip, payment method,
internal notes) fed through a fake Supabase client:

- `SELECT_COLUMNS` never matches any `business-context.js`
  `PRIVATE_FIELD_PATTERNS` entry (static check).
- The fetch function's output never contains any of the 9 forbidden
  values, even when the fake client returns them anyway (simulating a
  future schema/query mistake) — defense-in-depth at the
  `fromCompletedBooking()` layer, independent of the SELECT-column
  narrowing above.
- A row with no `operational_note` is dropped entirely, not pushed as an
  empty placeholder.
- `writeCompletedJobEvidence()`'s output file, read back from disk, is
  confirmed to contain none of the forbidden values either — proving the
  full fetch→write pipeline, not just the fetch function in isolation.
- Supabase misconfigured or erroring both degrade to `skipped: true`,
  never thrown, never a partial/garbled write.

`agent/lib/completed-job-intake.js` (Phase 5, unchanged) still
independently re-validates every field against the allowlist when
READING these files back for rotation scoring — two independent layers
agreeing, per the brief's defense-in-depth instinct.

## 11. Service-area/new-page guard

Already true structurally in Phase 5 (a pageless city is never scanned —
there's no file), but now has an explicit regression test
(`tests/agent-service-area-guard.test.js`) proving it at every layer:

- A rotation pick's shape is exactly `{slug, name, hasPage, pageFile,
  score, reasons}` — no `decision`, `recommendation`, or "create this
  page" field exists anywhere on it.
- Every pageless city's `reasons` text reads "evaluate, don't
  auto-create" — never a conclusion that demand exists or the site is
  deficient.
- `scanAllPages()`'s output never includes a pageless city's
  would-be filename.
- `buildReport()`'s `proposals`/`technicalIssues` sections are computed
  ONLY from `findings` — a rotation pick, by construction, cannot
  produce a `PROPOSE_CHANGE`, a new-page recommendation, or move
  `healthSummary` off `"all-clear"` by itself.

## 12. Research quality/freshness behavior

Unchanged from Phase 5 (§9 of the original brief's evidence hierarchy;
§10's freshness/temporality model) — the orchestrator is instructed (§5
above) to follow the same hierarchy and to tag `temporality` honestly.
`computeFreshness()`'s stale/aging windows are unchanged.

## 13. Scheduling environment recommendation

**A scheduled Claude Code / Claude Agent SDK session — NOT Vercel Cron.**
Reasoning, against the brief's own requirements:

| Requirement | Vercel Cron -> serverless function | Scheduled Claude session |
|---|---|---|
| Execute repo code | Yes, but read-only filesystem except `/tmp` | Yes, full repo checkout |
| Access the web for real research | No general-purpose capability | Yes (WebSearch/WebFetch) |
| Securely access Supabase credentials | Yes (env vars) | Yes (env vars / secrets) |
| Write research/report/proposal results back to GIT | No — a Vercel function cannot commit | Yes |
| Preserve git/history behavior | N/A — can't write to git at all | Yes, natively |
| Fail visibly | Yes | Yes (§8 above) |
| Prevent concurrent runs | Yes (`run-lock.js`) | Yes (same `run-lock.js`) |
| Stay within the 12/12 Vercel function budget | Would need a 13th function for the orchestration step alone (research needs more than one HTTP request/response cycle) | N/A — doesn't touch Vercel at all |

A Vercel Cron job fundamentally cannot perform the research half (no
general web-research capability, and a serverless invocation's
read-only, ephemeral filesystem cannot commit `agent/research/results/`
files back to git) — it would, at best, run the deterministic pass alone
and leave every `research_pending` run stuck forever with nothing to
resume it. The scheduled-Claude-session model handles the ENTIRE
lifecycle in §5 above with existing product capabilities (this
environment's own scheduled/cron session mechanism), not new
infrastructure.

**Recommended cadence** (unchanged intent from Phase 5): Daily
04:00 America/Denver, Weekly Sunday 04:00 America/Denver.

## 14. Required credentials

Same as Phase 5: `SUPABASE_URL`/`SUPABASE_SECRET_KEY` (for proposal sync,
AND now also `--refresh-completed-jobs` — both optional/gracefully
skipped without them). No credentials are required for the deterministic
`--daily`/`--weekly --json` pass itself. The orchestrator session needs
whatever this product's own scheduled-session mechanism already provides
for repo + web access — no new secret category.

## 15. Git/history behavior

`agent/history/log.ndjson` remains strictly append-only — a resumed run
adds a SECOND line, never rewrites the first (§8 above). `agent/history/
research-rotation-state.json` is updated only on the INITIAL pass of a
weekly run, never on resume (rotation picks are carried forward verbatim
— re-computing on resume could pick different cities now that findings
have shifted, and would double-mark picks reviewed).
`agent/research/results/*.json` and `agent/research/completed-jobs/
latest-refresh.json` are git-tracked like every other evidence file in
this project.

## 16. Failure/concurrency behavior

Unchanged mechanism from Phase 5 (`run-lock.js`, the outer
try/catch-and-record-honestly in `runner.js`), now proven to also cover
resume: resuming while another run (fresh or resumed) holds the lock is
refused; resuming a nonexistent or already-finalized runId is refused
with a clear, specific error (never a silent no-op or false success); a
failure DURING resume (e.g. a malformed research file causing something
unexpected) still produces an honest `"failed"` record rather than
pretending the resume succeeded.

## 17. API/Vercel function impact

Zero new functions — still exactly 12/12 (confirmed by re-running the
existing function-count test). `api/admin/bookings.js` gained zero NEW
view/action branches in Phase 5B (the `agent-reports`/`agent-report`
views already existed from Phase 5; the `adjust` PATCH action was added
then fully removed). `report.status`/`sequence` are additive fields on
the existing `?view=agent-report` response shape.

## 18. Tests/results

4 new test files (`agent-runner-resume`, `agent-completed-job-fetch`,
`agent-service-area-guard`, plus the already-existing `agent-report`/
`agent-reports-ui` extended with new cases) and 1 test file deleted
(`agent-adjust-workflow`, since the feature it tested was reverted).
Full repository suite: **84/85 pass** — the same single pre-existing,
unrelated failure as Phase 5 (`phase3c-batch5-intake-ui.test.js`,
confirmed via `git log` to predate this entire branch).

## 19. Files changed

See the final report's own file list and commit SHA.

## Remaining risks / open questions (Phase 5B)

1. The orchestrator loop in §5 is a documented PROCEDURE a Claude session
   follows — it is not itself enforced by code (nothing stops a human
   from running `--daily` and never resuming a `research_pending` run).
   That's intentional (the brief asked for the lifecycle/hand-off to
   exist, not for a meta-process-enforcer), but worth knowing: a
   `research_pending` run just sits there, visibly, until something
   resumes it — there's no timeout/escalation.
2. `research-rotation-state.json`'s "picks carried forward on resume"
   design (§15) means a weekly run's rotation choice is locked in at the
   INITIAL pass — if the orchestrator's research takes long enough that
   the picks feel stale by resume time, there's no re-evaluation point.
   Judged acceptable (a week-scale rotation doesn't need minute-scale
   freshness), but worth revisiting if weekly runs start taking unusually
   long.
3. Items 1-4 of Phase 5's own "Remaining risks" (closing the loop on
   `applied`/`validated`/`failed` proposal states; rotation-weight
   tuning; scheduling activation; flat pageless-city scoring) are all
   still open, unchanged by Phase 5B.
4. No automated test exercises a REAL multi-step Claude-orchestrator
   session end-to-end (only the underlying `runner.js` resume mechanics
   are tested) — this is intentional (that loop's "intelligence" is the
   orchestrating session itself, not something a Node test can
   meaningfully simulate), but the first real scheduled run will be the
   first true end-to-end proof.

---

# Phase 7 — GitHub Actions unattended runner (manual-dispatch only)

A secure, GitHub-Actions-hosted execution path for the already-built,
already-deployed Agent — `.github/workflows/website-agent.yml` can run
`node agent/cli.js --daily --json` or `--weekly --json` unattended. This
phase builds and validates the runner infrastructure; it deliberately
does **not** enable a recurring schedule (no `schedule:` trigger exists
in the workflow file) — `workflow_dispatch` only, until explicitly
authorized.

**Nothing about the Agent itself changed** — no new providers, no
decision-logic changes, no dashboard changes. The one functional code
change is in the auth layer, and it was already the documented upgrade
path (§3A/§3B above, and point 7 of Phase 6's "Remaining risks"):
`agent/lib/google-adc.js` now implements the `"external_account"`
(Workload Identity Federation) branch that was previously an honest
"not yet supported" — specifically the one concrete shape
`google-github-actions/auth` writes for GitHub Actions (a URL-sourced
credential, JSON format). It fetches a fresh GitHub OIDC subject token
and exchanges it via RFC 8693 token exchange (Google's STS endpoint)
for a `cloud-platform`-scoped base token — exactly the same "base
identity" role a human's `gcloud auth application-default login`
refresh token already played. `agent/lib/google-auth.js`'s tier-1
impersonation logic is completely unchanged: it still calls
`getAdcAccessToken()` for a base token, then
`google-impersonation.js`'s `generateAccessToken()` to mint the actual
scope-specific (`webmasters.readonly`/`analytics.readonly`) token for
`mile-high-site-agent@...`. **`GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`
remains necessary** — the GitHub auth action is deliberately configured
WITHOUT its own `service_account:` impersonation input, so there is
exactly one impersonation step, not two.

## Workflow architecture

`.github/workflows/website-agent.yml`:
checkout → fail-fast config checks (Supabase secrets, WIF
provider/impersonation vars) → Node 24 + `npm ci` → `google-github-
actions/auth@v2` (WIF, base identity only) → `node agent/cli.js
--daily|--weekly --json` → `.github/scripts/safe-commit.js` (`if:
always()`) → `git push origin HEAD:main`. `permissions: {contents:
write, id-token: write}` only (a non-empty `permissions:` map implies
every other scope is `none`). One `concurrency` group
(`website-agent-runner`, `cancel-in-progress: false`) covers BOTH daily
and weekly, since they share one history file/lock and two GitHub-hosted
runners have no shared filesystem for `agent/lib/run-lock.js`'s own file
lock to protect against each other.

## Safe persistence back to `main`

`.github/scripts/safe-commit.js` — not a generic "commit whatever
changed" helper. With mutation disabled (no `--apply-safe`), the ONLY
files `--daily`/`--weekly` ever write are `agent/history/log.ndjson`
(every run) and `agent/history/research-rotation-state.json` (weekly
only); the script's allowlist is exactly those two paths. Any other
changed/untracked path (a website source file, an unexpected new file,
a stray `agent/research/**` artifact) makes it refuse to commit
anything and fail the job loudly. Every allowed file's new content is
also scanned for credential-shaped strings (PEM blocks,
`refresh_token`/`client_secret` fields, a live `SUPABASE_SECRET_KEY`
value, Google/Stripe token shapes, an `external_account` credential
blob) before committing — never printing the matched text. Runs with
`if: always()` so a genuinely failed Agent run (runner.js's own
honest "failed" history record — see this file's failure-safety
sections) still gets persisted. Unit- and real-temp-git-repo-integration
tested by `tests/github-actions-safe-commit.test.js`.

## `research_pending` handling

This runner does the deterministic pass only. If a run comes back
`research_pending`, it is persisted exactly as such (same as any local
run) and the workflow does nothing further to resolve it — no Claude
API key, no other AI provider, no attempt to fake/bypass the research
step was added. The existing scheduled-Claude-session orchestrator
(§5/§13 above) still owns resuming it via `node agent/cli.js
--resume=<runId>`, unchanged.

## Tests

New: `tests/github-actions-safe-commit.test.js` (15 cases — pure
parsing/classification/leak-scan functions, plus a real temp-git-repo
end-to-end CLI check), `tests/github-actions-workflow.test.js` (14
structural/regex invariant checks against the workflow YAML itself: no
schedule/cron, exact two permissions, concurrency group, no
`--apply-safe`, fail-fast secret/var checks ordered before the Agent
runs, no `git add -A`/`git commit` in the workflow, `if: always()` on
the persistence step, Node 24). Modified: `tests/agent-google-adc.test.js`
(replaced the old "external_account not yet supported" test with real
coverage of the implemented URL-sourced exchange, a subject-token-
fetch-failure case, an STS-exchange-failure case, and a file-sourced-
not-supported case). Full repository suite: **104/105 pass** — the same
single pre-existing, unrelated failure as every prior phase
(`phase3c-batch5-intake-ui.test.js`, confirmed via `git stash` against
unmodified `main` to predate this work).

## Remaining risks / open questions (Phase 7)

1. ~~Not yet exercised against a REAL GitHub Actions run~~ —
   **PARTIALLY RESOLVED**: a real Daily run and a real Weekly run have
   now both succeeded end-to-end (WIF auth, Agent pass, safe-commit,
   push). Still open: neither has yet made a REAL Google API call — the
   real Weekly run that surfaced Phase 7B's gap had zero first-party-
   evidence candidates under the OLD architecture, so Search Console was
   never actually reached over the network, only its config-presence
   checked. The real WIF->STS->IAM-Credentials->Search-Console network
   chain is still proven only by fixture-injected `fetchImpl` tests
   (same rigor as every other tier) — see Phase 7B's own section below
   for exactly what the next controlled run will prove for real.
2. `git push origin HEAD:main` fails loudly (not resolved/retried) if
   `main` moved on since checkout — deliberate (no rebase, no force
   push), but means a run that races a human push just fails and must
   be re-dispatched; acceptable at today's manual-only, low-frequency
   cadence.
3. Scheduling is still fully OFF, per explicit instruction — enabling it
   is a separate, later, explicitly-authorized step (just adding a
   `schedule:` trigger to the existing workflow; no other change
   needed).

---

# Phase 7B — closing the "rotation selects a target but nothing reviews it" gap

## Root cause

The real Weekly run selected 3 rotation picks (Golden, Brighton,
Morrison) correctly, but nothing ever performed a deep review of them.
Investigation found this was NOT an auth/API failure — it was a pure
orchestration gap, present since Phase 5: **a rotation pick was never
wired to any evidence-gathering mechanism at all.**

- `agent/lib/research-rotation.js`'s `computePriorities()` has always
  produced ONLY a scored shortlist (`{slug, name, hasPage, score,
  reasons}`) — never a Finding. Decision.js's `RESEARCH_MORE` path is
  category-C-finding-only; `firstparty-candidates.js`'s `CANDIDATE_TYPES`
  is a fixed set of EXISTING-PAGE mechanical finding types (sitemap/
  canonical/orphan issues) — a pageless city structurally cannot match
  any of them (there's no page to have a sitemap/canonical/orphan
  problem on). So a rotation pick was NEVER eligible for either existing
  evidence-gathering path — not a bug in either path, just a third case
  neither was ever extended to cover.
- §4's documented design for closing this gap (`agent/README.md`,
  pre-Phase-7B) was: "the orchestrator should ALSO consider researching
  the rotation picks while it has web access open... if there's
  time/budget in this session" — i.e. a **Claude-driven orchestrator
  session's own voluntary judgment**, with zero structural tracking of
  whether it actually happened. That model assumed every Weekly run was
  driven by such a session. Phase 7's GitHub Actions runner is NOT that
  session (deliberately — no AI/research provider was added, per
  explicit instruction) and never was; it only runs the deterministic
  `--daily`/`--weekly` pass. So when Weekly runs unattended via GitHub
  Actions, rotation picks are selected and persisted, but the "someone
  with web access should look into these" step has no one to perform
  it. Using the terms from the brief: **category 1 — orchestration
  (of any kind, human or automated) never even requested the evidence**,
  because no code path existed that could request it on a rotation
  pick's behalf.
- The SEPARATE symptom — `firstPartyEvidence.gatheredThisRunCount: 0`
  and Search Analytics/URL Inspection/GA4 all in `sourcesNotConsulted` —
  was investigated independently and is **working exactly as designed**
  for the EXISTING (finding-based) first-party-evidence pipeline: zero
  `CANDIDATE_TYPES`-eligible findings existed as NEW this run, so zero
  evidence was correctly requested (also category 1, but the
  CORRECT/intended category-1 outcome for that pipeline — nothing to
  fix there). It LOOKED connected to the rotation gap only because both
  symptoms shared the same root — an unattended run with nothing
  requesting first-party evidence — and because, once Phase 7B's fix IS
  in place, rotation evidence genuinely does move those sources off
  `sourcesNotConsulted` (see below).

## What Weekly was actually doing

Selecting and scoring 3 topics correctly (§4/§11's rules intact), then
immediately persisting the run as "completed" with those picks attached
as inert data — no code path ever read them back to decide anything
needed doing. A rotation pick and a "reviewed rotation pick" were
visually indistinguishable in the report.

## What changed

**New:** `agent/lib/rotation-evidence.js` — the ONLY mechanical,
judgment-free evidence available for a claimed-but-pageless rotation
pick: does this property's real Search Console query data contain ANY
query mentioning the city's name? `isRotationEvidenceCandidate()`
(pageless only — a paged pick already has its own daily/first-party
path), `buildRotationEvidenceRequest()` (a READY-TO-FETCH request — no
orchestrator judgment needed, unlike a finding's first-party question,
because the right scope here never varies), `classifyRotationConclusion()`
(caps the outcome at `NO_CHANGE`/`RESEARCH_MORE` — **structurally never
`PROPOSE_CHANGE`**, proven by a dedicated test). GA4 is deliberately NOT
queried for a pageless pick — there is no `landingPage` dimension that
would mean anything without a page.

**New CLI command:** `node agent/cli.js --refresh-rotation-evidence` —
mirrors `--refresh-completed-jobs`'s existing precedent exactly: a
separate, explicit, network-touching step run BEFORE `--weekly`, never
inside the deterministic core. Recomputes this week's picks (same
inputs the `--weekly` pass will use moments later, so they match), and
for each pageless candidate lacking evidence, fetches ONE targeted,
bounded Search Analytics query and writes it to
`agent/research/firstparty/` — same file convention, same normalized/
bounded shape (`firstparty-evidence.js`'s `makeFirstPartyEvidence()`,
now with an optional `rotationSlug` field alongside `findingKey` — two
independent key spaces, never both set on one entry) as an
orchestrator's `--fetch-firstparty` already produced.

**Wired in:** `agent/lib/firstparty-intake.js`'s new
`attachRotationEvidence()` (mirrors `attachFirstPartyEvidence()`, keyed
by `rotationSlug`); `agent/runner.js`'s weekly path calls it right after
computing `rotationPriorities`; `agent/lib/report.js` classifies each
pick's conclusion and MERGES rotation-sourced evidence into the SAME
aggregate `firstPartyEvidence` summary findings already use — this is
the actual fix for the `sourcesNotConsulted` symptom, since Search
Console now genuinely gets consulted and counted.

**The report now distinguishes** (`report.rotation.picks[]` /
`report.rotation.summary`): targets selected, targets actually
researched (`researched: boolean`), first-party evidence gathered per
pick (`firstPartyEvidence[]`, folded into the top-level
`firstPartyEvidence` aggregate too), conclusions reached (`conclusion:
null|"NO_CHANGE"|"RESEARCH_MORE"`, with a human-readable
`conclusionReason`), proposals created from rotation (`summary.
proposalsCreatedFromRotation` — always `0`, structurally), and targets
where `NO_CHANGE` was the honest, evidence-grounded answer. Every pick
and the summary also carry `externalResearchPerformed: false` and an
explicit `externalResearchCapability` string — see below.

**Workflow:** `.github/workflows/website-agent.yml` gained one step,
"Refresh weekly rotation evidence (weekly only)" — `if: inputs.run_type
== 'weekly'`, runs BEFORE the main Agent step. `.github/scripts/
safe-commit.js`'s allowlist gained exactly `agent/research/firstparty/
*.json` (one level deep only — not `agent/research/**` broadly;
`results/`/`completed-jobs/` stay OUT of scope, since nothing newly
writes there).

## Is real GSC/GA4 retrieval now exercised?

**Not yet for real, and this phase did not force that** — per explicit
instruction not to dispatch another workflow run. Confirmed instead,
without any network call:
- All new/changed library code passes the same fixture-injected
  `fetchImpl` test rigor as every existing Google-auth-related test
  (`tests/agent-rotation-evidence.test.js`,
  `tests/agent-firstparty-intake.test.js`'s new cases,
  `tests/agent-report.test.js`'s new cases,
  `tests/agent-runner-rotation-evidence.test.js`).
- Running `node agent/cli.js --refresh-rotation-evidence` locally (no
  Google env configured in this shell, so zero network attempted — by
  construction, `isSearchConsoleConfigured()` gates the request before
  any fetch) reproduced the EXACT 3 real picks from the actual Weekly
  run — "Golden", "Brighton", "Morrison" — confirming the fix's
  candidate-selection logic matches live production data, not just a
  synthetic test fixture.
- The real WIF->STS->IAM-Credentials-impersonation->Search-Console
  network chain itself remains proven only by injected-`fetchImpl`
  tests until the next controlled manual Weekly dispatch — see
  "Recommended next controlled test" in the final report for this
  phase.

## What external research capability is still missing

**Genuine municipal/county/state and competitor-landscape research for
a rotation pick is NOT implemented, and this phase deliberately did not
fake it.** This unattended GitHub Actions runner has no Claude/
Anthropic or other AI provider, and no general web-research (WebSearch/
WebFetch) access — by explicit instruction, none was added. A rotation
pick's conclusion from this phase's fix is capped at `NO_CHANGE` (no
first-party signal) or `RESEARCH_MORE` (genuine first-party signal found
— a human, or a future research-capable orchestrator session, still
needs to do the actual municipal/competitor research before any page
decision) — it can NEVER reach `PROPOSE_CHANGE` from this mechanism
alone, by construction (`classifyRotationConclusion()` has no code path
that returns it — proven by a dedicated regression test). This is the
SAME boundary Phase 7's own "Claude/research boundary" section already
drew for category-C `RESEARCH_MORE` findings; Phase 7B does not move
that boundary, it only makes the Weekly report tell the truth about
where a rotation pick currently sits relative to it.

**A `NO_CHANGE` conclusion here means "this specific first-party check
found no signal" — it is explicitly, by wording AND by behavior, NEVER
"no local opportunity exists in this city."** Zero rows is real
evidence of absence-of-SIGNAL, never evidence of absence-of-
OPPORTUNITY: a real searcher may describe the service without ever
naming the city, Search Console only reports impressions for queries
this property already surfaces for (a pageless city structurally has
little to measure in the first place), and even a genuinely current
local opportunity can show zero rows in any single 28-day window. Two
separate, independently-tested guarantees enforce this:
1. **Wording** — `classifyRotationConclusion()`'s `reason` text for a
   zero-row result explicitly states the limitation (never just omits
   it) — `tests/agent-rotation-evidence.test.js` and
   `tests/agent-report.test.js` both assert the exact phrase appears.
2. **Behavior** — `--refresh-rotation-evidence` treats STALE existing
   evidence as absent (`rotation-evidence.js`'s
   `freshlyEvidencedRotationSlugs()`, using the same freshness windows
   `report.js` already computes) and re-fetches, so a zero-row result
   can never permanently suppress future research for that city —
   caught during this phase's own review before it shipped: an earlier
   draft checked only "does ANY evidence file exist for this slug,"
   which would have silently abandoned re-checking a city forever after
   one zero-row result.

## Tests

New: `tests/agent-rotation-evidence.test.js` (16 cases — candidate
rules, request shape, conclusion classification including the "never
PROPOSE_CHANGE" structural guard, the "never claims no local
opportunity" wording guard, and `freshlyEvidencedRotationSlugs()`'s
stale-evidence-is-treated-as-absent behavior), `tests/agent-runner-
rotation-evidence.test.js` (2 cases — real end-to-end wiring against the
real site, using a throwaway fixture file in the real `agent/research/
firstparty/` directory, always cleaned up). Extended: `tests/agent-
firstparty-intake.test.js` (+4, `attachRotationEvidence` and the two
key-spaces' independence), `tests/agent-report.test.js` (+8, the
richer rotation shape, the aggregate-evidence merge, the
`evidenceFreshness` field, and the "never claims no local opportunity"
wording guard at the report level too),
`tests/agent-firstparty-evidence.test.js` (updated field-allowlist for
the new optional `rotationSlug`), `tests/agent-service-area-guard.test.js`
(updated + strengthened — explicitly proves the new fields can never
produce `PROPOSE_CHANGE`/a page-creation signal), `tests/github-
actions-safe-commit.test.js` (+4, the new allowlist entry),
`tests/github-actions-workflow.test.js` (+1, the new weekly-only step).
Full repository suite: **106/107 pass** — the same single pre-existing,
unrelated failure as every prior phase.

## Remaining risks / open questions (Phase 7B)

1. The real network chain (WIF -> STS -> IAM Credentials impersonation
   -> Search Console Search Analytics) is still unproven live — see
   "Is real GSC/GA4 retrieval now exercised?" above. The next controlled
   manual Weekly dispatch is the first opportunity to prove it, and will
   either produce real evidence files (git-diffable, reviewable before
   trusting) or a clear, specific skip reason — never a silent gap.
2. `--refresh-rotation-evidence` calls `gatherFindings()` (a full site
   scan) once to determine this week's picks, and the `--weekly` pass
   moments later calls it again — doubles the scan cost of a weekly run.
   Accepted as negligible (scanning ~50 static HTML files is sub-second)
   rather than threading a shared pre-computed findings list across two
   separate CLI invocations, which would be more coupling for no
   measurable benefit at this scale.
3. A rotation pick's Search Analytics check uses one fixed, simple
   query filter (`contains "<city name>"`) over a 28-day window — not
   configurable, not multi-variant (e.g. "near me" phrasing, misspellings).
   A reasonable, documented first pass; worth revisiting if it proves
   too narrow to ever surface a real signal in practice.
4. The external-research gap this section documents is not a TODO this
   phase forgot — it is the honest current boundary of what this
   unattended environment can do. Closing it for real requires either a
   scheduled Claude/Agent-SDK orchestrator session (agent/README.md §13's
   original recommendation, still valid) or a different, explicitly-
   authorized research-provider integration — neither is in scope here.

---

# Phase 7C — GOOGLE_IMPERSONATE_SERVICE_ACCOUNT corruption incident

A real controlled Weekly run sent a malformed, multi-line value to
service-account impersonation — literally
`"<email>\nGSC_SITE_URL <value>\nGA4_PROPERTY_ID <value>"` — which
Google correctly rejected as an invalid IAM Credentials resource name,
but only after a network round trip, and with an opaque error naming
the whole garbled string.

**Investigation** traced every link between the three independently-
configured GitHub repository variables and the code that consumes
them: the pushed workflow's `env:` blocks (plain `KEY: ${{ vars.X }}`
mappings, no block scalars, no `$GITHUB_ENV`/`$GITHUB_OUTPUT` writes
anywhere in this repo's own files), `google-github-actions/auth@v2`'s
own outputs (it only ever exports `GOOGLE_APPLICATION_CREDENTIALS`-
related variables — it has no knowledge of `GOOGLE_IMPERSONATE_
SERVICE_ACCOUNT` at all), `process.env` (no `dotenv` or any custom env-
parsing exists anywhere in this codebase), and every line of code that
reads this variable (exactly one: `google-auth.js`'s `getAccessToken()`
— a direct, unmodified read). Every one of those links is clean. The
one remaining link — the GitHub variable's own stored bytes — cannot
be read back via the GitHub API without authentication this
environment doesn't have, and this phase was explicitly told not to
ask for it to be changed; by elimination, and consistent with the exact
symptom (the garbled text is literally two "OTHER_VAR value" lines
appended after the real email, matching how a multi-line paste into
one variable's value field would look), the corruption most plausibly
originated there, not in this repository's code.

**What WAS a real, fixable gap**, regardless of where the corruption
originated: nothing anywhere validated `GOOGLE_IMPERSONATE_SERVICE_
ACCOUNT`'s shape before use.
`google-impersonation.js`'s `generateImpersonatedAccessToken()`
`encodeURIComponent()`s it directly into the IAM Credentials API's
request URL — a multi-line value just gets percent-encoded in place,
producing exactly the "Google rejected the whole garbled string"
symptom reported, and only after wasting a base-ADC network round
trip first. `google-auth.js` now validates it (`validateServiceAccountEmail()`)
BEFORE any network call: no embedded whitespace/newlines, and it must
match `<name>@<project-id-or-number>.gserviceaccount.com`. Tier 1
stays "configured" either way (never silently falls through to tier
2/3/4 — this module's existing, unchanged rule) — it just fails
immediately with a specific, actionable reason instead of a cryptic
Google API error.

**No change to**: the pushed workflow YAML (clean — nothing to fix
there), Google Cloud IAM/WIF permissions (no evidence they're wrong),
or any other env var's handling — `GSC_SITE_URL`/`GA4_PROPERTY_ID` are
read completely independently and were never implicated.

**Tests**: `tests/agent-google-auth.test.js` (+5) —
`validateServiceAccountEmail()` unit cases including the exact real-
incident shape, a TIER-1 test proving a malformed email fails before
ANY network call (not even the base-ADC fetch) and never falls through,
and an end-to-end test proving all three env vars
(`GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`/`GSC_SITE_URL`/`GA4_PROPERTY_ID`)
reach their respective consumers as three fully independent, exact
values. Full repository suite: **106/107 pass** — the same single
pre-existing, unrelated failure as every prior phase.

---

# Phase 7D — Golden Search Console diagnostic (manual, one-off)

With `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` corrected (Phase 7C) and the
weekly rotation mechanism confirmed to be excluding candidates
correctly (Phase 7B follow-up — all 7 pageless cities had simply
already been reviewed today, the first day the mechanism ever ran, so
nothing had a chance to re-select one), the one thing still genuinely
unproven live was the real GitHub Actions -> WIF -> service-account
impersonation -> Search Console path itself. Waiting for weekly
rotation to naturally re-draw a pageless city could take real-world
weeks (7 cities out of 20, staleness-scored); manually editing
`research-rotation-state.json` to force it was explicitly ruled out.

**Added a third, narrow `run_type` option** on the existing
`workflow_dispatch`: `diagnostic-golden-search-console`. It runs ONLY
the existing `--fetch-firstparty` path (via a new
`--fetch-firstparty-strict=` variant — see below) against a single,
pre-committed, reviewable request file
(`agent/diagnostics/golden-search-console-request.json` — search-
analytics, 28-day window, `query` dimension, `contains "golden"`,
`rotationSlug: "golden"`) through the SAME WIF/impersonation/
`GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`/`GSC_SITE_URL`/search-console-
client.js/normalization/write path unattended daily/weekly runs use —
no new Google client, no new auth code. `daily`/`weekly` behavior is
completely unchanged (same steps, same gating, same env). The main
Agent step and the weekly-only rotation-evidence step are both
explicitly gated OUT for this run_type, so it can never run the
ordinary pipeline, touch `research-rotation-state.json`, create a
proposal, or make a website change — there is no code path from this
step that reaches any of those.

**New: `--fetch-firstparty-strict=<path>` (`agent/cli.js`).** The
existing `--fetch-firstparty=` is orchestrator-facing: a `{skipped:
true}` result (misconfiguration, auth failure, API error) logs and
returns exit 0, correctly, because a human/Claude session reads the
reason and decides what to do next. An unattended diagnostic dispatch
has no one reading the log in real time — the SAME graceful skip would
make a genuinely broken credential look like a green run. The strict
variant calls the identical `fetchFirstPartyEvidence()`/
`writeFirstPartyEvidence()` functions and only changes what happens on
a skip: `process.exitCode = 1`. A real, successful fetch — including a
legitimate **zero-row** Search Console response — is never a skip
(`fetchFirstPartyEvidence()` only returns `skipped:true` for an actual
problem), so it is written and reported exactly the same in both
modes: honestly, as zero observed rows, never as a failure and never
as a claim that no opportunity exists (unchanged from Phase 7B's own
wording guarantee — this diagnostic doesn't even reach
`classifyRotationConclusion()`, since it never runs inside a weekly
report at all).

**A real, pre-existing bug was found and fixed while building this**:
`fetchSearchAnalyticsEvidence()`/`fetchUrlInspectionEvidence()`/
`fetchGa4Evidence()` (`agent/lib/firstparty-fetch.js`) destructured and
forwarded `findingKey` to `makeFirstPartyEvidence()`, but never
`rotationSlug` — silently dropping it. This meant the ENTIRE Phase 7B
`--refresh-rotation-evidence` mechanism, once it ever reached a real
(or realistically-mocked) fetch call, would write evidence that could
never attach back to the rotation pick that requested it — Phase 7B's
own tests never caught this because they exercised
`writeFirstPartyEvidence()`/`attachRotationEvidence()` directly with
hand-built evidence objects, never the real `fetchSearchAnalyticsEvidence()`
call in between. Caught by this phase's own new end-to-end test
(`tests/agent-cli-fetch-firstparty-strict.test.js`'s zero-row success
case, which — deliberately, to actually exercise the real code path —
injects a fetch mock at the `global.fetch` level rather than hand-
building the evidence object). Fixed by threading `rotationSlug`
through all three fetch functions, same as `findingKey`.

## Tests

New: `tests/agent-cli-fetch-firstparty-strict.test.js` (5 cases —
strict-vs-non-strict exit-code behavior, the committed request file's
exact shape proven byte-identical to `buildRotationEvidenceRequest()`'s
real output except `context`, and the zero-row-is-success case that
caught the `rotationSlug` bug above). Extended:
`tests/agent-firstparty-fetch.test.js` (+1, all three fetch functions'
`rotationSlug` pass-through), `tests/github-actions-workflow.test.js`
(+6 — the new run_type option, the diagnostic step's path/env/no-
continue-on-error, and that it cannot reach rotation state or the
ordinary pipeline). `agent/cli.js` also gained a `require.main ===
module` guard so it can be `require()`'d for testing without auto-
running a real pass. Full repository suite: **107/108 pass** — the
same single pre-existing, unrelated failure as every prior phase.

## How to run it

GitHub → Actions → "Website Agent — unattended runner" → **Run
workflow** → `run_type` dropdown → **diagnostic-golden-search-console**
→ Run workflow. A real, bounded, reviewable Search Console evidence
file for "Golden" is committed to `agent/research/firstparty/` on
success; the job itself fails (not green) on any auth/config/API
problem.

# Phase 7E — Golden GA4 diagnostic (manual, one-off)

Phase 7D proved the real GitHub Actions → WIF → service-account
impersonation → **Search Console** path. GA4 was a separate, still-open
question: `agent/lib/ga4-client.js`'s `runReport()` had only ever been
exercised two ways — fixture-`fetchImpl` unit tests
(`tests/agent-ga4-client.test.js`), and a real call against production
GA4 data from a **human's own local ADC login** on Rocky's Windows
machine (Phase 6 §18/§Remaining-risks item 2). Neither proves the
unattended GitHub Actions runner's own WIF-federated identity can
actually reach the GA4 Data API — `agent/lib/rotation-evidence.js`
deliberately never calls GA4 at all (no `landingPage` for a pageless
pick means nothing to query), so nothing in the existing unattended
pipeline had ever exercised it, by design, until now.

**Added a fourth, narrow `run_type` option**, mirroring Phase 7D's
pattern exactly: `diagnostic-golden-ga4`. It runs ONLY the existing
`--fetch-firstparty-strict=` path (the SAME variant Phase 7D added —
no second GA4 networking implementation, no new Google client, no new
auth code) against a second, pre-committed, reviewable request file,
`agent/diagnostics/golden-ga4-request.json`:

```json
{
  "type": "ga4",
  "rotationSlug": "golden-ga4",
  "scope": { "type": "site", "value": "milehighjunkremoval.net" },
  "days": 28,
  "dimensions": ["date"],
  "metrics": ["sessions", "screenPageViews"]
}
```

**Why this exact request, not a `landingPage` filter for "Golden"**:
Golden has no dedicated page (that's precisely why the weekly rotation
flagged it in the first place) — a `landingPage` dimension filter for
it would be querying for data that structurally cannot exist, proving
nothing about the auth/fetch path either way. A whole-site, `date`-
dimension aggregate is the simplest request that still proves a real,
well-formed GA4 Data API call succeeded: no dimension filter to get
subtly wrong, no page-existence assumption to maintain as the site
changes.

**Why `sessions`/`screenPageViews`, not `conversions`/`keyEvents`**:
both are core, automatically-collected GA4 metrics present on every
GA4 property with zero configuration — they do not depend on this
property's own conversion/key-event setup the way `conversions` (GA4's
older metric name) or `keyEvents` (the newer one, properties migrated
since 2024) do. Using either of those blindly risks a false failure
signal (an API error, or a silently-empty result) that reflects this
property's conversion-event configuration rather than the auth/fetch
path this diagnostic actually exists to prove. A future phase that
wants real conversion-attributed evidence should inspect the property's
actual configured events first, not assume either name.

**Reuses `agent/cli.js`'s `--fetch-firstparty-strict=` unchanged** — it
was already generic over `request.type` (`"search-analytics"` |
`"url-inspection"` | `"ga4"`, see `firstparty-fetch.js`'s
`fetchFirstPartyEvidence()` dispatcher), so **zero changes to
`agent/cli.js` or any Google client were needed** for this diagnostic.
Same strict-mode contract as Phase 7D: a `{skipped:true}` result
(misconfiguration, auth failure, API error) sets `process.exitCode = 1`
— a legitimate zero-row GA4 response is never a skip and is written and
reported exactly like any other successful count. `daily`/`weekly`
behavior is completely unchanged; the main Agent step, the weekly-only
rotation-evidence step, and the Search Console diagnostic step's own
gating are all unaffected — the new step is gated to
`inputs.run_type == 'diagnostic-golden-ga4'` only, and the Supabase-
config check is skipped for both diagnostics now (neither ever runs
proposal sync).

## Tests

New: `tests/agent-cli-fetch-firstparty-strict-ga4.test.js` (9 cases —
the committed request's exact shape, its deliberate avoidance of
`conversions`/`keyEvents`, a privacy check that its dimensions never
match a visitor/client-identifier pattern, confirmation it is NOT
page-scoped to "Golden", strict-vs-non-strict exit-code behavior, and
the zero-row-is-success case — asserting the written evidence carries
no raw GA4 API response shape, no visitor/client identifiers, and not
even the GA4 property id itself). Extended:
`tests/github-actions-workflow.test.js` (+7 — the new run_type option,
the diagnostic step's path/env/no-continue-on-error, that it cannot
reach rotation state or the ordinary pipeline, that the Supabase check
now excludes both diagnostics, and that the two diagnostics' gating is
mutually independent). Full repository suite: same single pre-existing,
unrelated failure as every prior phase — see this phase's own commit
for the exact pass count.

## Is real GA4 retrieval now exercised through GitHub Actions/WIF?

**RESOLVED — yes.** This diagnostic was dispatched (`run_type:
diagnostic-golden-ga4`) and succeeded: `First-party evidence fetch: 1
evidence entry(ies) written to
.../agent/research/firstparty/ga4__milehighjunkremoval-net-....json`,
with safe-commit and the push to `main` both succeeding. The real
WIF → STS → IAM Credentials impersonation → GA4 Data API chain is now
proven end to end, the same way Phase 7D proved it for Search Console —
both real production first-party paths (Search Console and GA4) are now
confirmed working through the unattended GitHub Actions/WIF identity,
not just through a human's local ADC login (Phase 6 §Remaining-risks)
or fixture-injected tests.

## How to run it

GitHub → Actions → "Website Agent — unattended runner" → **Run
workflow** → `run_type` dropdown → **diagnostic-golden-ga4** → Run
workflow. A real, bounded, reviewable GA4 evidence file (whole-site
sessions/screenPageViews over the trailing 28 days) is committed to
`agent/research/firstparty/` on success; the job itself fails (not
green) on any auth/config/API problem.

**Dispatched and succeeded** — see "Is real GA4 retrieval now exercised
through GitHub Actions/WIF?" above.

# Phase 8 — First-Party Signals (investigation-only, decision-isolated)

With both real production first-party paths proven (Phase 7D: Search
Console; Phase 7E: GA4 — both via GitHub Actions/WIF), the next step was
to let GSC/GA4 evidence meaningfully PARTICIPATE in investigation
without becoming a decision-maker: `agent/lib/firstparty-evidence.js`'s
hard structural rule (no verdict/confidence/recommendation field;
`agent/lib/decision.js` never reads it at all) stays exactly as strict
as it always was — this phase adds a new, clearly-separated layer
ABOVE evidence and BELOW decisions, never inside either.

## Goal

Convert normalized GSC/GA4 evidence into useful, bounded investigation
SIGNALS — a named, provenance-carrying observation worth a human's
attention — without creating a new way for a metric to control an Agent
decision.

## Preserved boundary (unchanged, reconfirmed)

- `agent/lib/decision.js` still does not consume first-party evidence
  OR first-party signals — zero code paths, in either direction. Proven
  by `tests/agent-firstparty-signals-safety.test.js` the same way
  `tests/agent-firstparty-safety.test.js` already proved it for
  evidence: `decide()` produces byte-identical output with or without
  `.firstPartySignals` attached, AND `decision.js`'s own source text
  never mentions `firstPartySignals` or `require()`s
  `firstparty-signals.js` at all.
- A signal cannot produce `PROPOSE_CHANGE`, `APPLY_SAFE_FIX`, approval,
  rejection, or any website change — there is no code path from
  `agent/lib/firstparty-signals.js` into `decision.js`,
  `proposals-sync.js`, or `apply/rewrite-href.js` at all.
- First-party evidence is still never converted into an
  `agent/lib/research.js`-shaped external-research verdict — the two
  schemas stay completely separate (evidence has no
  verdict/confidence/recommendation field; research results require
  them). A signal doesn't have one either.
- The automatic-change whitelist (`agent/lib/apply/rewrite-href.js`,
  exactly the same two finding types since Phase 1/2) is untouched.

## What evidence is actually available today (inspected before writing any signal logic)

Before choosing a signal vocabulary, the real evidence schema and the
real evidence currently committed in this repo were both inspected:

- `agent/lib/firstparty-evidence.js`'s shape has no `verdict`/
  `confidence`/`recommendation` field by design (unchanged).
- A `comparisonWindow` field exists on the schema but **no caller
  anywhere** (`fetchSearchAnalyticsEvidence`/`fetchUrlInspectionEvidence`/
  `fetchGa4Evidence` in `agent/lib/firstparty-fetch.js`) ever populates
  it — it is always `null` in real evidence.
- `fetchSearchAnalyticsEvidence()`'s own DEFAULT dimensions (when a
  caller doesn't override them) are `["query", "page"]` — so a Search
  Console evidence entry fetched with default dimensions already
  carries, per returned row, which URL Google actually associates with
  that query.
- Each targeted first-party fetch scopes to exactly ONE target (one
  page, one city, or the whole site) — nothing in this codebase
  co-locates a subject page's evidence together with its comparable
  siblings' evidence in one place, the way `content-gap-audit.js`/
  `coverage-audit.js` do for purely internal, network-free page facts.
- The three real evidence files committed in `agent/research/firstparty/`
  as of this phase (the Golden Search Console diagnostic, the
  `privacy-policy.html` sitemap-finding evidence, and the Golden GA4
  diagnostic) were read directly — none of them carry both `query` and
  `page` dimensions together, and none has a sibling page's evidence
  co-located anywhere nearby.

## Signal vocabulary: one implemented, three deliberately deferred

Four signal concepts were discussed when this phase was proposed. Only
**`query-page-mismatch`** is implemented — the other three are
documented, not built, because implementing them honestly today would
require either an arbitrary magic-number threshold (explicitly ruled
out) or evidence-gathering this codebase does not currently perform:

- **`query-page-mismatch` (implemented).** Computable from a SINGLE
  already-realistic evidence entry, no baseline/threshold needed: does
  any returned query row's page differ from the finding's own subject
  page? A direct identity comparison (`agent/lib/page-identity.js`'s
  `normalizePageIdentifierForComparison()` handles URL-vs-relative-path
  identity, tolerant of http/https and www/apex differences — an
  identity check, not a canonicalization judgment), never an average or
  a magic number.
- **`weak-ctr-despite-impressions` (deferred).** "Weak" requires a
  baseline. The only non-arbitrary options are (a) a same-site
  comparable-page CTR average — not currently assembled anywhere — or
  (b) an external CTR-by-position benchmark curve, which would itself be
  exactly the kind of invented, non-site-specific magic number this
  phase was told to avoid.
- **`landing-page-weak-conversion-vs-comparable` (deferred).** Same
  problem as weak-ctr, for GA4: "vs comparable" requires GA4 evidence
  for the subject page AND its comparable siblings to exist
  simultaneously, which nothing currently assembles.
- **`declined-vs-prior-period` (deferred).** The schema's
  `comparisonWindow` field is never populated by any real caller. An
  honest alternative — comparing two separately-fetched, time-separated
  evidence entries attached to the SAME finding — is structurally
  possible (`firstparty-intake.js` already attaches every matching
  entry, not just the first), but `firstparty-candidates.js`'s own
  candidacy rule deliberately never re-flags a finding that already has
  evidence attached (see that file's header, point 3), so a finding
  essentially never accumulates two time-separated entries today outside
  a human manually re-fetching by hand. Deferred until a concrete,
  intentional re-fetch mechanism exists for findings (the way
  `rotation-evidence.js`'s staleness-triggered refresh already exists
  for rotation picks, but nothing analogous exists for findings yet).

**Future extension (not this phase):** a later, separately-authorized
phase could widen `firstparty-candidates.js` to request GSC/GA4 evidence
for a comparable GROUP of pages at once, which would make the two
deferred "vs comparable" signals honestly computable using the same
relative/proportional comparison style `content-gap-audit.js` already
uses internally (`count < avg * 0.5`) — new evidence-gathering scope,
not something this phase backfills by inventing data.

## New files

- `agent/lib/firstparty-signals.js` — the signal detector registry
  (`SIGNAL_TYPES`, currently `["query-page-mismatch"]`),
  `deriveFirstPartySignals(finding)`, and
  `attachFirstPartySignals(findings)` (mirrors
  `firstparty-intake.js`'s `attachFirstPartyEvidence()` exactly).
- `agent/lib/page-identity.js` — `normalizePageIdentifierForComparison()`,
  the shared URL-vs-relative-path identity helper the mismatch detector
  needs (and any future page-comparison signal will too).

## Wiring (`agent/runner.js`, `agent/lib/report.js`)

`gatherFindings()` now calls `attachFirstPartySignals()` strictly AFTER
both `decideAll()` and `attachFirstPartyEvidence()` — the same ordering
guarantee `firstparty-intake.js`'s header already documents for
`.firstPartyEvidence` itself, extended one step further.

**Bug fix found while wiring this in:** `agent/runner.js`'s persisted
`record.findings.map()` computed `.firstPartyEvidence` on every finding
(via `attachFirstPartyEvidence()`) but never copied it into the
persisted/mapped shape — so a FINDING's own first-party evidence
silently never reached `record.report.firstPartyEvidence` or
`agent/history/log.ndjson`, even though `report.js` has always read
`f.firstPartyEvidence` expecting it to be there. Only rotation-sourced
evidence (passed through a separate `rotationPriorities` parameter, not
through `record.findings`) ever actually showed up in a report. Same
class of bug as the Phase 4 `tier` fix already documented at that exact
line in `runner.js` — classification/decisions were never affected
(computed from the in-memory finding either way), only what got WRITTEN
for later display. Proven with a real end-to-end `runner.run()`
regression test (not just a hand-built `record` fixture, which is
exactly why this had gone uncaught) —
`tests/agent-firstparty-runner.test.js`'s new "BUG FIX regression"
case. Fixed by adding both `firstPartyEvidence` and the new
`firstPartySignals` to that mapping.

`report.js` now has THREE clearly-distinguished sections (see its own
header comment at the `firstPartySignals` computation):

1. `report.firstPartyEvidence` — RAW/NORMALIZED evidence, unchanged.
2. `report.firstPartySignals` — NEW: `{count, items}`, derived
   investigation leads. Never folded into `status`/`healthSummary`
   computation (same rule `firstPartyEvidence` already follows) — zero
   signals is a valid, ordinary, successful result.
3. `report.proposals`/`report.safeFixes` — ACTUAL Agent decisions,
   unchanged, computed entirely by `decision.js`.

`admin/agent-reports.js` renders a "First-party signals (investigation
leads, not decisions)" section, gated on `count > 0`, placed directly
after the existing "First-party evidence" section — rendering only each
signal's `reason` text (never a raw `mismatchedQueries` dump, never a
decision-shaped field, since none exists on the shape).

## Signal shape

```json
{
  "type": "query-page-mismatch",
  "findingKey": "content-gap::furniture-removal.html",
  "pages": ["furniture-removal.html"],
  "scope": { "type": "page", "value": "furniture-removal.html" },
  "window": { "start": "...", "end": "...", "label": "28 days ending ..." },
  "source": "search-console-search-analytics",
  "evidenceFetchedAt": "...",
  "mismatchedQueries": [
    { "query": "...", "observedPage": "...", "clicks": 1, "impressions": 10, "ctr": 0.1, "position": 5 }
  ],
  "reason": "...",
  "limitations": "...",
  "posture": "investigation-only — never a decision, proposal, approval, or rejection; agent/lib/decision.js does not read this signal and cannot be influenced by it."
}
```

No `verdict`/`recommendation`/`confidence`/`propose`/`apply` field
anywhere — `tests/agent-firstparty-signals-safety.test.js` asserts this
both empirically (a real derived signal's own keys) and structurally
(the module's source text never assigns any of those field names, and
never references `decision.js`'s `APPLY_SAFE_FIX`/`PROPOSE_CHANGE`/
`RESEARCH_MORE`/`REJECT_OPPORTUNITY` vocabulary at all).

## Tests

New: `tests/agent-firstparty-signals.test.js` (11 cases — the detector's
correctness: mismatch detection, agreement (no signal), multiple
entries, malformed-row handling, non-GSC-search-analytics sources
produce nothing, and a documentation test proving the real evidence
files currently committed in this repo produce zero signals today).
New: `tests/agent-firstparty-signals-safety.test.js` (14 cases — the
six safety properties this phase was explicitly scoped around: `decide()`
byte-identical with/without signals; no signal code path can return a
decision/proposal/apply state, checked both structurally and
empirically; a zero-row evidence entry produces no signal, never a
fabricated "no opportunity" claim; every degrade path — wrong
dimensions, no pages, healthy/agreeing evidence, no evidence at all —
produces no signal rather than a false one; no visitor/client-identifier
field name anywhere in the module or in a real derived signal's
serialized output). New: `tests/agent-page-identity.test.js` (7 cases).
Extended: `tests/agent-firstparty-runner.test.js` (+2, including the bug-
fix regression above), `tests/agent-report.test.js` (+3), `tests/agent-
reports-ui.test.js` (+2). Full repository suite: same single
pre-existing, unrelated failure as every prior phase (CRM intake UI) —
see this phase's own commit for the exact pass count.

## Compatibility

Daily/Weekly behavior, the Search Console diagnostic, and the GA4
diagnostic are all unaffected — re-run and confirmed passing unchanged
alongside this phase's own new tests. No Vercel function was added, no
paid external research provider was added, no scheduling was added, and
no GitHub Actions workflow was dispatched by this phase.

## Remaining risks / open questions (Phase 8)

1. Against the real evidence currently committed in this repo,
   `query-page-mismatch` produces zero signals today — none of the three
   real files carry both `query` and `page` dimensions together. The
   capability is real (it's `fetchSearchAnalyticsEvidence()`'s own
   default shape), but nothing has exercised it against genuine
   production data yet; that will only happen the next time a human/
   orchestrator fetches page-scoped Search Console evidence without
   overriding `dimensions`.
2. The three deferred signal concepts remain genuinely useful ideas —
   see "Signal vocabulary" above for exactly what evidence-gathering
   extension each would need, so a future phase doesn't have to
   re-derive that reasoning from scratch.
3. `report.firstPartySignals.items` is currently uncapped beyond
   whatever bound the upstream evidence already carries (`MAX_ROWS`=10
   per evidence entry) — the same, already-accepted posture
   `firstPartyEvidence.items` has (see Phase 6's own remaining-risks
   list, item 3).

# Phase 9 — Autonomous First-Party Evidence Candidacy + Fetch Planning

Phase 8 built `query-page-mismatch` but left a gap item 1 above states
plainly: the classifier has never seen real qualifying evidence, because
exercising it has always required a human to hand-compose a
`--fetch-firstparty=` request with un-overridden `["query","page"]`
dimensions. This phase closes that gap — Weekly can now identify
eligible findings and fetch that evidence itself, through the existing
network boundary, with zero widening of decision/proposal/site-change
authority.

## What's now autonomous

A `weekly` dispatch now recognizes, on its own, when a `content-gap` or
`structural-inconsistency` finding would benefit from real Search
Console query/page evidence, builds a bounded, mechanically-derived
request for it, fetches it through the SAME existing
`fetchFirstPartyEvidence()`/`search-console-client.js` path every other
first-party fetch already uses (no new Google client, no new auth code),
and persists it through the SAME normalized schema — all BEFORE the
deterministic `--weekly` pass runs, so `firstparty-intake.js` attaches it
and `firstparty-signals.js` classifies it in the SAME run, same pattern
Phase 7B established for rotation picks.

## New files

- `agent/lib/finding-evidence.js` — `QUERY_PAGE_CANDIDATE_TYPES`
  (`content-gap`, `structural-inconsistency` — exactly two, not every
  category-C type), `isQueryPageEvidenceCandidate()`,
  `deriveQueryFilterTerm()`, `buildQueryPageEvidenceRequest()`,
  `freshlyEvidencedFindingKeys()`. Mirrors `rotation-evidence.js`'s
  architecture deliberately — same separation of concerns, same reason
  for existing as its own module (a category of evidence-worthy target
  neither existing evidence-gathering path reaches).

## Why exactly these two finding types, and not the other category-C types

- **`content-gap`/`structural-inconsistency` (included)** — both ask
  "is this page's own content/depth adequate for what it's actually
  about?" Real Search Console query text about this page's own topic is
  the single most direct, non-fabricated evidence for that question, and
  both are always single-page findings, fitting this module's
  single-target request shape cleanly.
- **`coverage-gap-candidate` (excluded)** — its question is about a
  MISSING cross-reference to a different service, not this page's own
  adequacy. The natural query term would be the missing service's name,
  not this page's own identity, and a real query for that service
  landing on the general service page instead of a city page is often
  entirely normal — the mismatch semantics don't map cleanly. Left out
  rather than forced.
- **`overlapping-intent` (2 pages) / `duplicate-meta-description` (2+
  pages) (excluded)** — both need a genuinely GROUP-scoped request shape
  this module's single-target design doesn't attempt. A real, legitimate
  future extension (arguably the cleanest actual use of
  `query-page-mismatch` — cannibalization IS a query/page-mismatch
  question), but it needs its own deliberate request-shape design, not a
  mechanical default forced onto this phase's "smallest architecture."
- **`research-gap` (moot)** — defined in `risk.js`'s `RULES` table but
  never actually emitted by any audit module.
- **Every category A/B finding (`broken-internal-link`,
  `missing-title`, etc.) and the EXISTING `firstparty-candidates.js`
  `CANDIDATE_TYPES` set (excluded, untouched)** — technical/indexing
  questions answerable from internal evidence alone, or already covered
  by the separate, existing URL-Inspection-oriented mechanism. A
  technical finding does not get Search Console performance research
  just because it has a URL — the exact case the brief warned against.

## Request shape — a correctness detail that matters

```json
{
  "type": "search-analytics",
  "findingKey": "content-gap::blog-seasonal-cleanout-guide.html",
  "scope": { "type": "page", "value": "blog-seasonal-cleanout-guide.html" },
  "days": 28,
  "dimensions": ["query", "page"],
  "dimensionFilterGroups": [
    { "filters": [{ "dimension": "query", "operator": "contains", "expression": "blog seasonal cleanout guide" }] }
  ]
}
```

**Deliberately filtered by QUERY, never by PAGE.** An earlier draft of
this design considered filtering `dimensionFilterGroups` by the
finding's own page — which would have been self-defeating: filtering to
one page makes every returned row's `page` column trivially equal that
same page by construction, making a query-page mismatch structurally
impossible to ever detect. The query-filter term is derived
MECHANICALLY from the page's own file name
(`deriveQueryFilterTerm()`: `.replace(/\.html$/,"").replace(/-/g," ")`
— the exact same transform `decision.js`'s `questionTextFor()` already
uses for service names) — the page's own existing identity, not an
invented keyword, not a demand/volume claim.

## Freshness, not permanent suppression

The EXISTING `firstparty-candidates.js`/`isFirstPartyEvidenceCandidate()`
mechanism (daily, pause/resume-based) treats "already has ANY evidence,
ever" as permanent disqualification. That's too blunt for this
autonomous, mechanical weekly refresh, and this phase does NOT carry it
forward: `freshlyEvidencedFindingKeys()` mirrors
`rotation-evidence.js`'s existing `freshlyEvidencedRotationSlugs()`
exactly — STALE evidence (per `firstparty-evidence.js`'s existing,
UNCHANGED freshness windows: aging 10 days, stale 21 days for
`search-console-search-analytics`) is treated as absent, so a finding is
re-checked again once enough time passes rather than permanently
abandoned after one fetch. The EXISTING `CANDIDATE_TYPES` mechanism's
permanent-suppression rule is untouched — a deliberately separate,
already-shipped lifecycle this phase does not redesign.

## `--refresh-finding-evidence` (`agent/cli.js`)

Mirrors `--refresh-rotation-evidence` almost exactly: recomputes this
week's findings (same deterministic `gatherFindings()` a `--weekly` run
itself will call moments later), filters to eligible,
not-already-fresh candidates, and for each, fetches ONE targeted
request via the EXISTING `fetchFirstPartyEvidence()`/
`writeFirstPartyEvidence()` functions — zero new networking code. Never
throws: every candidate's outcome is logged and the loop continues.

**Four-way honest outcome classification** (`classifyFindingEvidenceOutcome()`),
addressing the explicit requirement that a transient failure must never
be silently indistinguishable from "zero evidence":

- `"fetched"` — a real, successful API call that found 1+ rows.
- `"fetched-zero-rows"` — a real, successful API call that found 0 rows
  (honest absence-of-SIGNAL, never absence-of-opportunity).
- `"skipped"` — never attempted: the integration isn't configured, or
  the request was malformed before any network call.
- `"failed"` — an attempt WAS made (auth resolution or the Search
  Analytics API call itself) and did not succeed.

This classification is pure, read-only text-matching over
`fetchFirstPartyEvidence()`'s EXISTING `{skipped, reason}` shape — no
change to that shape, no new Google networking code. It exists purely
to make the console log say which of the two happened, instead of
collapsing both into one generic "skipped" word. The underlying
guarantee that prevents a failure from ever masquerading as real
evidence is structural, not logging: `fetchSearchAnalyticsEvidence()`
only ever calls `makeFirstPartyEvidence()` — and therefore only ever
writes a file — on a GENUINE successful API response; a skip or a
failure writes nothing, full stop.

## Workflow integration

One new step, "Refresh finding-level query evidence (weekly only)" —
`if: inputs.run_type == 'weekly'` — placed immediately after the
existing "Refresh weekly rotation evidence" step and before "Run
Website Agent (weekly)". Daily is untouched by construction: the gate
is `inputs.run_type == 'weekly'` and nothing else, identical in
structure to the rotation-evidence step's own gate.

## Tests

New `tests/agent-finding-evidence.test.js` (18 cases — candidacy rules
including the explicit "a broken link is never a candidate" case,
query-term derivation, the "never page-filtered" structural proof,
freshness/staleness behavior, cross-contamination guards). New
`tests/agent-cli-refresh-finding-evidence.test.js` (9 cases — the
four-way outcome classification; real end-to-end wiring with no Google
env configured (correctly "skipped", no file written); freshness
exclusion; a genuine API error correctly classified "failed" (not
"skipped"), writing no file; a real zero-row success correctly written;
and — the key proof this phase exists to deliver — a REALISTICALLY-
SHAPED mocked Search Console response with a genuine mismatch row,
flowing through `--refresh-finding-evidence` into a real
`runner.run({runType:"weekly"})` call, confirming
`firstparty-signals.js`'s `query-page-mismatch` classifier actually
fires, that `decision.js`'s output for that finding is byte-identical
regardless, and that the signal reaches `record.report.firstPartySignals`).
Extended `tests/github-actions-workflow.test.js` (+3 — the new step's
gating/placement/ordering, that it uses the same credential variables,
and an explicit assertion that Daily is unaffected).

## Compatibility / boundaries preserved

`decision.js`, `risk.js`, `firstparty-signals.js`, every audit module,
`apply/rewrite-href.js`, and `proposals-sync.js` are all completely
untouched by this phase (confirmed via `git diff --stat` before commit
— only `agent/cli.js`, the workflow file, the new
`agent/lib/finding-evidence.js`, and tests changed). No paid API, no
scheduling, no Vercel function, no new Google authentication/network
code. Daily behavior is unchanged (the new step and CLI path are both
additive and gated to `weekly` only).

## Remaining risks / open questions (Phase 9)

1. `coverage-gap-candidate` remains a plausible future candidate once a
   deliberate decision is made about which query term to derive for it
   (the missing service's name vs. this page's own identity) and how to
   interpret a resulting mismatch — documented above, not implemented.
2. `overlapping-intent`/`duplicate-meta-description` remain the most
   semantically direct future use of `query-page-mismatch`
   (cannibalization IS a page/query-mismatch question) but need a
   genuinely group-scoped request design this phase didn't attempt.
3. The query-filter term is derived from the page's OWN file name for
   both candidate types uniformly — for `content-gap` specifically, the
   actual real query TEXT returned (not just whether it mismatches) is
   independently valuable context for a human reviewing the finding,
   even on the (common) healthy case where no mismatch fires; nothing
   currently surfaces that raw query text anywhere beyond
   `report.firstPartyEvidence.items`'s existing generic display.

# Phase 10 — Curated Official Source Evidence ($0 external/local research, Tier A only)

The Agent's remaining intelligence gap was external/local information:
Search Console/GA4 (Phase 6+) describe this property's OWN
search/analytics behavior; `research.js` (Phase 2+) captures a
human/Claude session's actual read-and-judge verdict about an external
source. Neither closes the gap of *mechanically, autonomously, at $0*
checking a known official municipal/county/state source for current
information relevant to an existing opportunity (e.g. a seasonal
disposal/recycling program) — without a paid search API, and without
pretending a general web-research/discovery capability exists when it
doesn't.

## Goal and explicit non-goal

Prove the Agent can safely retrieve and normalize ONE human-vetted
official local source at $0, through the SAME network-layer /
normalized-evidence / deterministic-consumer separation that has
already worked for first-party evidence — nothing more. This is
explicitly **not** autonomous general web research: there is no search
provider, no sitemap-based discovery, no RSS monitoring, no competitor
fetching, and no mechanism for discovering a BRAND NEW official source
for a city this registry doesn't already know about. A locality/topic
with no curated entry correctly surfaces as "external discovery
unavailable" — never faked.

## Architecture

```
agent/context/local-source-registry.json   (human-curated, human-VERIFIED — like business-profile.json)
        v
agent/lib/local-source-registry.js         (loader + validation — domain/authorityClass consistency enforced)
        v
agent/lib/robots.js                        (minimal, NOT standards-complete robots.txt check — fails conservative, always)
        v
agent/lib/local-source-fetch.js            (network layer: robots gate -> known-URL GET only -> bounded extraction)
        v
agent/lib/local-source-evidence.js         (normalized schema — mirrors firstparty-evidence.js's shape; NO verdict/confidence/recommendation field)
        v
agent/research/local-sources/*.json        (committed, git-tracked, one file per fetch)
        v
agent/lib/local-source-intake.js           (deterministic load; NOT attached to any finding/rotation pick in Phase 1)
        v
report.js's own, independent `localSourceEvidence` section
```

`agent/runner.js` remains network-free: it only calls
`loadLocalSourceEvidence()`, a pure filesystem read, the same category
as its existing `attachFirstPartyEvidence()` call. The only thing that
ever touches the network is `agent/lib/local-source-fetch.js`, invoked
exclusively via the separate, explicit `node agent/cli.js
--fetch-local-source-strict=<registry-entry-id>` CLI step — never by the
deterministic pipeline itself.

## Registry (`agent/context/local-source-registry.json`)

Human-maintained, human-VERIFIED, and **not autonomously editable** —
`.github/scripts/safe-commit.js`'s allowlist deliberately excludes
`agent/context/**` entirely (same treatment `business-profile.json`
already gets). Phase 1 holds exactly one entry:

- **id**: `denver-leafdrop`
- **locality**: Denver, CO
- **domain**: `denvergov.org`
- **url**: `https://www.denvergov.org/My-Property/Recycle-Compost-Trash/Seasonal-Programs/LeafDrop-and-Pumpkin-Recycling`
- **topic**: `leafdrop-pumpkin-composting-program`
- **authorityClass**: `official-government`
- **expectedTemporality**: `temporary`

This URL was independently re-verified during this phase's design — NOT
assumed valid merely because the Phase 3 Denver LeafDrop research result
(`agent/research/results/content-gap__blog-seasonal-cleanout-guide-2-denver-leafdrop.json`)
referenced the same program under a different (dated news-article) URL.
Verification: resolved the City's own short link
(`https://denvergov.org/leafdrop`, a live HTTP 302) to this exact
canonical destination; fetched and fully parsed the real,
7629-line `https://www.denvergov.org/robots.txt` (a single
`User-agent: *` block, zero `Allow`/`Crawl-delay` directives) and
confirmed this exact path is not matched by any `Disallow` rule — the
only LeafDrop-related rules on that host cover two *different*, older
path families. See the registry entry's own `verificationNotes` for the
full detail.

`local-source-registry.js`'s `validateEntry()` enforces that an entry's
`url` host must equal its own declared `domain` (apex or `www.`
variant) — a malformed entry can never claim authority over a host it
doesn't actually point to, and `authorityClass` must be one of
`research.js`'s existing `SOURCE_TYPES` (reused, not a second taxonomy).

## Fetch safety (Tier A only)

`local-source-fetch.js`'s `fetchLocalSourceEvidence()` takes a REGISTRY
ENTRY OBJECT, never a raw URL — there is no parameter through which an
arbitrary or caller-supplied URL could ever reach it, and an unknown
registry id refuses outright rather than falling back to treating the
id as a literal URL. Per-fetch: `robots.txt` is checked exactly ONCE
(see "Robots retrieval cadence" below), the known URL is fetched with a
10s timeout and an honest, identifying User-Agent
(`MileHighJunkRemovalAgent/1.0 (+contact@milehighjunkremoval.net)`, no
cookies/login/session), and any 3xx response is treated as a `failed`
outcome requiring a human to re-verify the registry entry — **redirects
are never followed automatically**, to the same host or any other. No
sitemap discovery, no RSS, no competitor fetching, no retry/bypass of
any kind (a response that looks like a bot-protection challenge is just
another `failed` outcome, never something to work around).

### Robots retrieval cadence

Fetched exactly ONCE per CLI invocation (one host per registry entry in
Phase 1), reused for the one page fetched in that same call — not
cached across separate process runs, and not re-fetched per-page within
one run. Chosen over "fetch robots.txt before every individual page
fetch" because, within one short-lived GitHub Actions job (well under
the existing 20-minute timeout), robots.txt cannot meaningfully change
between two fetches to the same host in the same run — re-fetching it a
second time for the same host would be pure redundant load on the
target server with zero correctness benefit. Chosen over "cache across
runs" because persisting a robots.txt decision across days/weeks risks
silently acting on stale rules — a fresh in-memory-only check every
invocation is simpler and strictly safer.

`agent/lib/robots.js` is explicitly, deliberately NOT a
standards-complete robots.txt implementation — it supports only the
subset the real, verified `denvergov.org` host actually uses (one
`User-agent: *` block, `Disallow` prefix matching with trailing `*`
treated as a no-op, zero `Allow`/`Crawl-delay` reliance) and **fails
conservatively, always**: an unreachable robots.txt, a non-2xx
response, or no matching block at all is treated as DISALLOWED, never
as "no file means fetch freely."

## Extraction — bounded, mechanical, never structured facts

`stripHtmlToText()` strips `<head>` (so a page's own `<title>` text,
which frequently contains its `<h1>` text as a prefix, can't
self-defeat anchoring), scripts, styles, and all tags, then
`extractAnchorText()` locates the page's own `<h1>` (falling back to
`<title>`) so the bounded snippet starts from the page's real content
rather than nav/header chrome. The result is capped at
`MAX_SNIPPET_CHARS` (2000) — raw HTML is never persisted. This is
deliberately NOT structured field extraction: no dates, locations, or
program rules are ever mechanically parsed into claimed authoritative
facts — a human (or Claude session) must read the snippet and the live
page before treating anything in it as confirmed for site copy, same
discipline the real Phase 3 Denver LeafDrop research result already
modeled by hand.

## Evidence schema (`agent/lib/local-source-evidence.js`)

Mirrors `firstparty-evidence.js`'s structural discipline exactly: **no
`verdict`/`confidence`/`recommendation` field at all** —
`sourceUrl`, `sourceDomain`, `authorityClass` (one of `research.js`'s
`SOURCE_TYPES`), `locality`, `topic`, `discoveryMethod` (`"known-url"`
only in Phase 1), `retrievedAt`, `extractedSnippet` (bounded),
`expectedTemporality` (one of `research.js`'s `TEMPORALITY_VALUES`,
reused directly), `limitations` (required), and `robots: {checkedAt,
allowed}` — the constructor structurally refuses to build evidence for
any fetch that wasn't explicitly robots-allowed. Freshness
(`computeLocalSourceFreshness()`) reuses `research.js`'s existing
`FRESHNESS_WINDOWS_DAYS` directly (no new, invented aging numbers).

## Reporting

`report.localSourceEvidence` is its own, independent section — **never
merged into** `firstPartyEvidence`, `firstPartySignals`, or `research`.
Every non-empty section carries the literal disclaimer: *"Retrieved
official-source evidence — not yet interpreted as a research verdict."*
`agent/lib/decision.js`, `agent/lib/research.js`, `agent/lib/risk.js`,
`agent/lib/proposals-sync.js`, and every `*-audit.js` module are all
independently confirmed (by source-grep, not just by not-currently-
calling-it) to never `require()` any `local-source-*.js` module — see
`tests/agent-local-source-safety.test.js`, including an end-to-end proof
that a real `runner.run()`'s findings/decisions are byte-identical
whether or not local-source evidence exists on disk.

## Diagnostic (manual, one-off — same precedent as Phase 7D/7E's Golden diagnostics)

`node agent/cli.js --fetch-local-source-strict=denver-leafdrop` /
`.github/workflows/website-agent.yml`'s `diagnostic-denver-leafdrop`
`run_type`: fetches exactly the one curated Denver entry, checks robots
first, writes one normalized evidence file, and EXITS NONZERO on any
`skipped` outcome (robots disallow, network/HTTP failure, an unexpected
redirect, or an unknown registry id) rather than logging and returning
0. Needs **no Google Cloud/WIF credentials at all** — this is a plain,
anonymous public HTTP fetch, not a Search Console/GA4 call — so both
the Google Cloud config-check and the WIF auth step skip for this
`run_type`, alongside the existing Supabase-config skip the two Golden
diagnostics already use. Never runs `--daily`/`--weekly`, never touches
rotation state, never creates a proposal, never changes the site.

## Persistence

New directory `agent/research/local-sources/*.json`, added to
`.github/scripts/safe-commit.js`'s allowlist (same one-level-deep,
`.json`-only treatment as `agent/research/firstparty/*.json`).
`agent/context/local-source-registry.json` is deliberately **not** in
that allowlist — the runner may read it, but can never autonomously
commit a change to what it's allowed to fetch.

## What this phase deliberately does NOT do

No change to `decision.js`, `research.js` verdicts, proposals, or site
changes. No sitemap-based discovery, RSS monitoring, content-hash/
change detection, or competitor fetching (all genuinely deferred, not
abandoned). No second city/source added to the registry yet — each
future entry needs its own live, hands-on verification the same way
Denver's was. No scheduling, no new Vercel function, no new npm
dependency (native `fetch`/`AbortController` only), no paid search
provider.

## Tests

New: `tests/agent-robots.test.js` (robots.txt parsing/matching —
grouping, trailing-`*` handling, fail-conservative-always),
`tests/agent-local-source-registry.test.js` (validation, the
domain/authorityClass consistency guarantee, the real registry file),
`tests/agent-local-source-evidence.test.js` (schema validation,
freshness), `tests/agent-local-source-fetch.test.js` (mocked HTTP only —
robots allow/disallow/unavailable, timeout, non-2xx, redirect-to-any-
host rejection, bounded/anchored extraction, no raw HTML persisted),
`tests/agent-local-source-intake.test.js`,
`tests/agent-cli-fetch-local-source-strict.test.js` (strict-mode
contract, mocked), `tests/agent-local-source-safety.test.js` (the
decision/proposal/apply-authority structural proof). Extended:
`tests/github-actions-safe-commit.test.js` (+5, the new allowlist entry
and the registry's own exclusion from it),
`tests/github-actions-workflow.test.js` (+6, the new diagnostic's
gating/isolation). Full repository suite: **120/121 pass** — the same
single pre-existing, unrelated failure as every prior phase. All real
Denver verification (URL resolution, robots.txt content, live fetch,
extraction quality) was performed by hand against the live network
during design — the committed test suite itself never touches the real
network (all HTTP is mocked).
