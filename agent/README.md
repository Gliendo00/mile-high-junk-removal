# Site Improvement Agent — Phase 1 + Phase 2 + Phase 3 + Phase 4 (hardening) + Phase 5 (daily/weekly operating system)

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
| `sql/2026-10-14_phase5-agent-adjust-workflow.sql` | Adds the Adjust state (§8) |
| `admin/agent-reports/`, `admin/agent-reports.js` | Report-history CRM page (§7) |
| 10 new `tests/agent-*.test.js` files | §11 |

Modified (behavior-preserving unless noted): `agent/runner.js` (runType,
report building, rotation, lock, failure recording), `agent/cli.js`
(`--daily`/`--weekly` flags), `agent/lib/proposals-sync.js` (now also
returns `statusByKey`, additive), `agent/lib/research.js` (new optional
`temporality`/`publishedAt`/`locality`/`topic` fields, all backward
compatible — the two real Phase 3 research files were updated to set
`temporality` explicitly, see §3), `api/admin/bookings.js` (new
`agent-reports`/`agent-report` views, `adjust` PATCH action, richer
`agent-activity` response — all additive), `admin/home.js`+
`admin/home/index.html` (richer card, §6), `admin/agent-proposals.js`+
`index.html` (Adjust button, §8), `tests/agent-migrations-review.test.js`
(extended to also check the new migration's cumulative effect).

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

## 8. Proposal integration + the Adjust decision

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

## 11. Testing

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

## Implementation discipline — what was deliberately NOT built

Per the brief's own "don't overbuild" instruction: no new Supabase
tables beyond the one additive migration; no new Vercel functions (still
exactly 12); no paid APIs; no numeric health score anywhere; the 4th
"Recommended Phase 5" wish-list item (expanding the audit surface
further) was left for a future phase, since it's unrelated to the
daily/weekly operating-system request; Adjust's auto-regeneration half
was evaluated and explicitly deferred (§8) rather than built messily.

## Remaining risks / open questions

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
