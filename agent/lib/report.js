// Site Improvement Agent, Phase 5 (+ Phase 5B lifecycle fix) — persistent
// report builder.
//
// Turns one run record (runner.js's internal shape: findings, summary,
// validation, proposalsSync) plus the previous run and (for a weekly run)
// this week's rotation picks into the CRM-facing REPORT the rest of this
// phase is built around — see agent/README.md's "Daily report" section
// for the exact questions this must answer: WHAT DID THE AGENT DO? WHY?
// DID IT CHANGE ANYTHING? DO I NEED TO APPROVE SOMETHING?
//
// Deliberately NOT a raw log dump, and deliberately NOT a 0-100 "site
// health score" — healthSummary is a short, honest sentence derived from
// real counts (open actionable findings + proposals awaiting approval),
// not an invented metric.
//
// Phase 5B — RUN STATUS LIFECYCLE: a run record now carries an explicit
// `status`: "completed" | "research_pending" | "failed". This fixes a
// real bug in the original Phase 5 report: a run whose ONLY findings
// were unresolved RESEARCH_MORE questions (category C, tier
// "opportunity" — never "actionable", and never PROPOSE_CHANGE) produced
// `actionableOpenCount === 0` and `proposalsAwaitingApproval === 0`,
// which `buildHealthSummary()` read as "All clear" — exactly the
// "a run requiring research must never look like ALL CLEAR" failure mode
// Rocky flagged. `computeRunStatus()` below is checked BEFORE the
// all-clear/needs-attention logic, so a pending research question always
// wins that race.
//
// This is a pure function — runner.js calls it once per run (or once per
// RESUME of a run — see runner.js's resumeRunId option) and persists its
// output as `record.report` (see history.js), so the CRM API layer never
// has to recompute change-detection/rotation context on every read.

const { classifyChanges } = require("./change-detection");
const { computeFreshness } = require("./research");
const { computeFirstPartyFreshness, SOURCES: FIRST_PARTY_SOURCES } = require("./firstparty-evidence");
const { isFirstPartyEvidenceCandidate, buildFirstPartyEvidenceQuestion } = require("./firstparty-candidates");
const { isRotationEvidenceCandidate, classifyRotationConclusion } = require("./rotation-evidence");
const { computeLocalSourceFreshness } = require("./local-source-evidence");
const { selectWeeklyLocalSourceCandidates, picksWithNoRelevantSource, latestEvidenceByUrl } = require("./local-source-candidates");

// Phase 10 — Curated Official Source Evidence's own section banner.
// Stated here, verbatim, every time this section is non-empty: this
// evidence is retrieval-only (a bounded, mechanical snippet proving a
// known, human-verified official page was fetched) and is NEVER itself
// a research verdict — see agent/lib/local-source-evidence.js's header
// on why it carries no verdict/confidence/recommendation field and is
// never merged into firstPartyEvidence/firstPartySignals/research
// below.
const LOCAL_SOURCE_EVIDENCE_DISCLAIMER = "Retrieved official-source evidence — not yet interpreted as a research verdict.";

// Phase 11B — this week's local-source CANDIDATE SELECTION section's own
// banner, stated verbatim whenever rotationPriorities is present (weekly
// runs only — see buildReport()'s own gating below). Says, up front,
// that relevance here is geographic only — see agent/lib/local-source-
// candidates.js's header for the full reasoning this enforces
// structurally (by naming), not just in this one sentence.
const LOCAL_SOURCE_CANDIDATES_DISCLAIMER =
  "Geographic relevance only — selecting a curated source as relevant to a location/topic never establishes verified program eligibility, pricing, dates, or accepted materials for that location. See each source's own \"doesNotEstablish\" text (its registry eligibilityNotes) and, where evidence was actually retrieved, that evidence's own limitations.";

/**
 * Phase 11B — answers the exact questions agent/README.md's Phase 11
 * section requires Weekly's report to answer: which curated sources
 * were relevant this week, which were actually fetched, which evidence
 * was reused because still fresh, which was stale, which locations had
 * no curated source, and which source was blocked/failed — all read
 * from already-computed/already-loaded data, never from a live call
 * (this function does no I/O of its own). Deliberately manufactures NO
 * interpretation beyond what's already curated/observed: `establishes`
 * is just the entry's own topic/authorityClass/locality restated, and
 * `doesNotEstablish` is just the entry's own required `eligibilityNotes`
 * — never a new verdict, confidence, or recommendation (see
 * tests/agent-local-source-safety.test.js).
 *
 * @param {object[]} picks - this week's rotation picks (rotationPriorities)
 * @param {object[]} registryEntries - local-source-registry.js's getEntries()
 * @param {object[]} evidenceEntries - local-source-intake.js's loadLocalSourceEvidence().entries
 * @param {object} candidateLog - local-source-candidate-log.js's loadLocalSourceCandidateLog() shape
 * @param {Date} workflowBoundary - same CI-workflow-or-run boundary buildReport() already computes
 * @param {Date} now
 */
function buildLocalSourceCandidatesSection({ picks, registryEntries, evidenceEntries, candidateLog, workflowBoundary, now }) {
  const candidates = selectWeeklyLocalSourceCandidates(picks, registryEntries);
  const noCuratedSourcePicks = picksWithNoRelevantSource(picks, registryEntries);
  const latestByUrl = latestEvidenceByUrl(evidenceEntries);
  const blockedByEntryId = new Map((candidateLog.blockedOrFailed || []).map((b) => [b.entryId, b]));

  const relevantSources = candidates.map(({ entry, matchedPickSlugs }) => {
    const latest = latestByUrl.get(entry.url);
    let status;
    let freshness = null;
    let blockedReason = null;

    if (latest) {
      freshness = computeLocalSourceFreshness(latest, now).status;
      const retrievedAt = new Date(latest.retrievedAt);
      if (retrievedAt.getTime() >= workflowBoundary.getTime()) {
        status = "fetched-this-workflow";
      } else if (freshness === "stale") {
        status = "stale-needs-refresh";
      } else {
        status = "reused-fresh";
      }
    } else if (blockedByEntryId.has(entry.id)) {
      status = "blocked-or-failed";
      blockedReason = blockedByEntryId.get(entry.id).reason;
    } else {
      // Relevant and selected, but genuinely never attempted yet (new
      // this week, or the candidate log is from an older/unrelated run)
      // — an honest third option, never conflated with "blocked/failed".
      status = "not-yet-fetched";
    }

    return {
      id: entry.id,
      domain: entry.domain,
      topic: entry.topic,
      authorityClass: entry.authorityClass,
      locality: entry.locality,
      matchedPickSlugs,
      status,
      freshness,
      blockedReason,
      establishes: `${entry.topic} — a ${entry.authorityClass} source for ${entry.locality}`,
      doesNotEstablish: entry.eligibilityNotes,
    };
  });

  return {
    disclaimer: LOCAL_SOURCE_CANDIDATES_DISCLAIMER,
    picksConsidered: (picks || []).map((p) => p.slug),
    relevantSources,
    noCuratedSourcePicks,
  };
}

// Phase 7B — surfaced verbatim on every rotation pick and in
// rotation.summary: this unattended runner has no research-capable
// orchestrator session (no Claude/Anthropic or other AI provider is
// configured — see agent/README.md's Phase 7 section) and therefore
// cannot perform the EXTERNAL (municipal/county/state, competitor-
// landscape) half of a genuine deep review. Stated once here so it is
// never silently implied to have happened — see rotation-evidence.js's
// header for the full boundary this documents.
const EXTERNAL_RESEARCH_CAPABILITY_MISSING =
  "Not available in this environment — this unattended run has no research-capable orchestrator session (no Claude/Anthropic or other AI provider, no web-research access configured). External/local research (municipal, county, state sources; competitor landscape as context only) for this pick still requires a human or a future research-capable orchestrator session.";

// Website Agent workflow provenance (generic — not specific to finding
// evidence): a multi-step CI job (e.g. .github/workflows/website-agent.yml's
// --refresh-rotation-evidence / --refresh-finding-evidence / --weekly
// sequence) runs each step as its OWN separate `node` process. The
// existing `runStartedAt` below (this PROCESS's own start time) can
// therefore never recognize evidence fetched by an EARLIER step of the
// SAME workflow dispatch as anything but "already existed before this
// run" — it was only ever designed to catch a --resume picking something
// up mid-process. `workflowStartedAt`, if the caller supplies one
// (read from the CI-wide `WORKFLOW_STARTED_AT` env var, set once via
// $GITHUB_ENV near the top of that job — see runner.js), is an
// independent, EARLIER reference point spanning the whole workflow
// dispatch, not just this one process.
//
// Must degrade safely: an absent, empty, or unparsable value is NEVER
// treated as "everything is newly gathered" — parseWorkflowStartedAt()
// returns null for all of those, and buildReport() below then falls
// back to the EXACT existing `runStartedAt` reference, so every
// existing caller (local/manual CLI runs, daily, diagnostics, resumes,
// and every historical record) is completely unaffected. A parsed value
// that is somehow AFTER `now` (clock skew, a malformed future
// timestamp) is also rejected the same way, for the same reason — it
// could never honestly classify anything as "gathered by this
// workflow" anyway.
function parseWorkflowStartedAt(value, now) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (now && parsed.getTime() > now.getTime()) return null;
  return parsed;
}

function countBy(findings, predicate) {
  return findings.filter(predicate).length;
}

// Checked in this exact order: failed > research_pending > completed. A
// run can be BOTH "has unresolved research" and "failed" (research was
// needed, then something else broke) — failed always wins, since "this
// run did not complete successfully" is the most important thing to say.
//
// Lifecycle-tightening update: `research_pending` now also covers an
// unresolved FIRST-PARTY-EVIDENCE question (firstparty-candidates.js) —
// deliberately the SAME status value, not a second lifecycle/status
// enum, so the existing resume mechanism (runner.js's
// findResumableRun()/run({resumeRunId})) needs zero changes to also
// cover this case: it already just checks `status === "research_pending"`
// and doesn't care WHY. See agent/README.md's Phase 6 lifecycle-
// tightening section for the full reasoning.
function computeRunStatus({ failure, hasUnresolvedResearch, hasUnresolvedFirstPartyEvidence }) {
  if (failure) return "failed";
  if (hasUnresolvedResearch || hasUnresolvedFirstPartyEvidence) return "research_pending";
  return "completed";
}

function buildHealthSummary({ status, actionableOpenCount, proposalsAwaitingApproval, questionsPendingCount, firstPartyQuestionsPendingCount, failure }) {
  if (status === "failed") {
    const detail = failure && failure.message ? ` (${failure.message})` : "";
    return { status: "failed", text: `This run did not complete successfully${detail} — see failure details below. No site changes were made based on a failed run.` };
  }
  if (status === "research_pending") {
    const parts = [];
    if (questionsPendingCount > 0) parts.push(`${questionsPendingCount} research question${questionsPendingCount === 1 ? "" : "s"}`);
    if (firstPartyQuestionsPendingCount > 0) {
      parts.push(`${firstPartyQuestionsPendingCount} first-party evidence check${firstPartyQuestionsPendingCount === 1 ? "" : "s"}`);
    }
    return {
      status: "research-pending",
      text: `Evidence needed before this run can be finalized — ${parts.join(" and ")} awaiting results.`,
    };
  }
  if (actionableOpenCount === 0 && proposalsAwaitingApproval === 0) {
    return { status: "all-clear", text: "All clear — no worthwhile changes found." };
  }
  const parts = [];
  if (actionableOpenCount > 0) parts.push(`${actionableOpenCount} open issue${actionableOpenCount === 1 ? "" : "s"}`);
  if (proposalsAwaitingApproval > 0) parts.push(`${proposalsAwaitingApproval} proposal${proposalsAwaitingApproval === 1 ? "" : "s"} awaiting approval`);
  return { status: "needs-attention", text: parts.join(" · ") };
}

/**
 * @param {object} args
 * @param {object} args.record - the run record runner.js builds (pre-persistence), including `runType`
 * @param {object|null} args.previousRun - the previous run record read from history, or null if this is the first run
 * @param {object[]} [args.rotationPriorities] - this week's picks (weekly runs only; agent/lib/research-rotation.js)
 * @param {object} [args.failure] - { message } if this run failed partway (see agent/README.md's failure-safety section)
 * @param {object} [args.firstPartyIntegrations] - Phase 6: {searchConsole, ga4} booleans — whether each
 *   integration is CONFIGURED (env vars present), computed by runner.js via a pure env-var/local-JSON
 *   check (no network call — see search-console-client.js/ga4-client.js's isXConfigured()), passed in
 *   explicitly so this function stays a pure function of its arguments rather than reading process.env itself
 * @param {string} [args.initialTimestamp] - lifecycle-tightening: the FIRST pass's timestamp for this
 *   logical run (runner.js passes `priorRecord.timestamp` on a resume, else `record.timestamp` — i.e.
 *   itself, on a fresh single-pass run). Used only to tell "evidence gathered DURING this logical run"
 *   (fetched after the initial pass, picked up by a resume) apart from "evidence that already existed
 *   and was simply reused" — see the firstPartyEvidence section below.
 * @param {string} [args.workflowStartedAt] - optional, CI-wide workflow-execution boundary (runner.js
 *   reads this from the generic `WORKFLOW_STARTED_AT` env var — see this file's own
 *   parseWorkflowStartedAt() header above for why `initialTimestamp` alone cannot answer this). Absent/
 *   invalid/future values degrade safely to `initialTimestamp`'s existing behavior — see the
 *   firstPartyEvidence section below.
 * @param {object} [args.localSourceEvidence] - Phase 10: runner.js's loadLocalSourceEvidence() result
 *   ({entries, warnings}), a pure filesystem read (never a network call). Surfaced as report.localSourceEvidence,
 *   its own section — deliberately NEVER merged into firstPartyEvidence/firstPartySignals/research below.
 * @param {object[]} [args.localSourceRegistryEntries] - Phase 11B: local-source-registry.js's
 *   getEntries(loadRegistry()) — a pure filesystem read, never written by this codebase's runner. Used
 *   only to compute report.localSourceCandidates (weekly runs only — see below); has no effect at all
 *   when rotationPriorities is absent (daily runs).
 * @param {object} [args.localSourceCandidateLog] - Phase 11B: local-source-candidate-log.js's
 *   loadLocalSourceCandidateLog() result — a pure filesystem read of the small, overwritten-each-run
 *   record of what --refresh-local-source-evidence could NOT fetch this run (see that module's header).
 */
function buildReport({
  record,
  previousRun,
  rotationPriorities,
  failure,
  firstPartyIntegrations,
  initialTimestamp,
  workflowStartedAt,
  localSourceEvidence,
  localSourceRegistryEntries,
  localSourceCandidateLog,
}) {
  const findings = record.findings || [];
  const now = new Date(record.timestamp);
  const runStartedAt = new Date(initialTimestamp || record.timestamp);
  const workflowBoundary = parseWorkflowStartedAt(workflowStartedAt, now) || runStartedAt;

  const changeDetection = classifyChanges(findings, previousRun);

  const safeFixesApplied = findings.filter((f) => f.status === "applied");
  const proposalsCreatedOrUpdated = findings.filter(
    (f) => f.decision === "PROPOSE_CHANGE" || f.decision === "REJECT_OPPORTUNITY"
  );
  const proposalsAwaitingApproval = findings.filter((f) => {
    const status = f.proposalStatus;
    return f.decision === "PROPOSE_CHANGE" && (status === "proposed" || status == null);
  }).length;
  const previouslyRejectedStillSurfacing = findings.filter((f) => f.proposalStatus === "rejected").length;
  const alreadyApplied = findings.filter((f) => f.proposalStatus === "applied" || f.proposalStatus === "validated").length;

  const researchPerformed = findings
    .filter((f) => Array.isArray(f.research) && f.research.length > 0)
    .map((f) => ({
      findingKey: f.key,
      page: f.pages && f.pages[0],
      results: f.research.map((r) => ({
        source: r.source,
        sourceType: r.sourceType,
        confidence: r.confidence,
        verdict: r.verdict,
        freshness: computeFreshness(r, now),
      })),
    }));

  // Phase 5B — the actual hand-off contract to the research-capable
  // orchestrator (a Claude-driven session — see agent/README.md's
  // "Orchestrator architecture" section): every RESEARCH_MORE finding's
  // full researchQuestion object (question text, internal evidence,
  // suggested source types — see decision.js's buildResearchQuestion())
  // is surfaced here, not just a count. The orchestrator reads THIS
  // array (via `--json`, or the CRM report detail), researches each one,
  // writes agent/research/results/*.json files matching each
  // `findingKey`, then resumes this exact run (see runner.js's
  // `resumeRunId`).
  const questionsPending = findings
    .filter((f) => f.decision === "RESEARCH_MORE")
    .map((f) => f.researchQuestion)
    .filter(Boolean);

  const actionableOpenCount = countBy(
    findings,
    (f) => f.tier === "actionable" && f.decision !== "APPLY_SAFE_FIX" && f.status !== "applied"
  );
  const observationsCount = countBy(findings, (f) => f.tier === "observation");
  const opportunitiesCount = countBy(findings, (f) => f.tier === "opportunity");

  // Phase 6 — first-party evidence (Search Console/GA4/URL Inspection)
  // summary. Deliberately NOT part of status/healthSummary computation —
  // see agent/README.md's Phase 6 "metrics are signals, not decisions"
  // rule: this section may only ever REPORT what first-party evidence was
  // configured/gathered/pending, never flip a run between all-clear/
  // needs-attention by itself (that stays driven entirely by findings/
  // proposals, computed above, unchanged by this phase) — the ONE
  // exception, matching research's existing precedent exactly, is that
  // an UNRESOLVED question (not a metric value) can keep a run from
  // finalizing as "completed" — see computeRunStatus() above. Built from
  // each finding's own `.firstPartyEvidence` (attached by
  // firstparty-intake.js strictly AFTER decideAll() already ran — see
  // that file's header), never from a live API call.
  const findingFirstPartyAttached = findings.flatMap((f) =>
    Array.isArray(f.firstPartyEvidence) ? f.firstPartyEvidence.map((entry) => ({ entry, findingKey: f.key, rotationSlug: null })) : []
  );
  // Phase 7B — a weekly run's rotation picks (agent/lib/research-
  // rotation.js) can ALSO carry attached first-party evidence (by
  // runner.js's call to firstparty-intake.js's attachRotationEvidence(),
  // matched by rotationSlug — see that file's header). Folded into the
  // SAME aggregate counts/sourcesNotConsulted below, since it is
  // genuinely first-party evidence gathered this run, regardless of
  // whether a Finding or a rotation pick prompted it — the earlier
  // Weekly-run gap this closes was exactly that Search Console/GA4
  // showed up as "not consulted" even when rotation evidence HAD been
  // gathered, simply because nothing merged it into this summary.
  const rotationFirstPartyAttached = (rotationPriorities || []).flatMap((p) =>
    Array.isArray(p.firstPartyEvidence) ? p.firstPartyEvidence.map((entry) => ({ entry, findingKey: null, rotationSlug: p.slug })) : []
  );
  const firstPartyAttached = [...findingFirstPartyAttached, ...rotationFirstPartyAttached];
  const firstPartyCountsBySource = {};
  for (const source of FIRST_PARTY_SOURCES) firstPartyCountsBySource[source] = 0;
  for (const { entry } of firstPartyAttached) {
    firstPartyCountsBySource[entry.source] = (firstPartyCountsBySource[entry.source] || 0) + 1;
  }
  const sourcesConsulted = new Set(firstPartyAttached.map(({ entry }) => entry.source));
  const sourcesNotConsulted = FIRST_PARTY_SOURCES.filter((s) => !sourcesConsulted.has(s));

  // Lifecycle-tightening: distinguishes evidence genuinely fetched
  // DURING this logical run (after the initial pass, picked up by a
  // resume — see runner.js's resumeRunId) from evidence that already
  // existed beforehand and was simply reused. A fresh, single-pass run
  // (no resume) has `runStartedAt === now`, so nothing can postdate it —
  // everything attached on a single pass is correctly "reused" (the
  // network-free deterministic runner never fetches anything itself;
  // anything attached was necessarily gathered by an earlier session —
  // for a rotation pick, that's the separate --refresh-rotation-evidence
  // step, run moments earlier in the same job).
  const firstPartyItems = firstPartyAttached.map(({ entry, findingKey, rotationSlug }) => {
    const gatheredDuringThisRun = new Date(entry.fetchedAt) > runStartedAt;
    // New, separate from gatheredDuringThisRun above (kept byte-for-byte
    // unchanged — still answers its own original, narrower "picked up
    // mid-run by a --resume" question). gatheredByWorkflow answers a
    // different question: "did one of THIS CI workflow dispatch's own
    // steps (the evidence-refresh steps immediately before this one, or
    // this run itself) produce this evidence" — see parseWorkflowStartedAt()'s
    // header above. At/after, not strictly after, per the workflow
    // boundary's own spec (the boundary is captured BEFORE any step
    // runs, so anything fetched by this dispatch is >= it, never ==
    // runStartedAt the way a resume case could be).
    const gatheredByWorkflow = new Date(entry.fetchedAt).getTime() >= workflowBoundary.getTime();
    const freshness = computeFirstPartyFreshness(entry, now).status;
    return {
      findingKey,
      rotationSlug,
      source: entry.source,
      metric: entry.metric,
      scope: entry.scope,
      window: entry.window.label,
      freshness,
      context: entry.context,
      gatheredDuringThisRun,
      gatheredByWorkflow,
    };
  });
  // Kept exactly as before — same computation, same meaning, same name
  // (a resume-only signal) — never silently repurposed. See the new,
  // separate gatheredByWorkflow* fields below for the workflow-boundary
  // question this phase actually needed answered.
  const gatheredDuringThisRunCount = firstPartyItems.filter((i) => i.gatheredDuringThisRun).length;
  // New, additive, mutually-exclusive three-way split that always sums
  // to firstPartyAttached.length: fetched by this workflow dispatch /
  // pre-existing and still fresh-or-aging / pre-existing and stale.
  // Stale evidence CAN still appear here (attachFirstPartyEvidence()
  // attaches every entry for a key regardless of age — see that file's
  // header), so it is genuinely worth counting separately rather than
  // silently folding into "reused."
  const gatheredByWorkflowCount = firstPartyItems.filter((i) => i.gatheredByWorkflow).length;
  const staleReusedCount = firstPartyItems.filter((i) => !i.gatheredByWorkflow && i.freshness === "stale").length;
  const reusedFreshOrAgingCount = firstPartyAttached.length - gatheredByWorkflowCount - staleReusedCount;

  // Lifecycle-tightening — which open findings would genuinely benefit
  // from a targeted first-party check, raised NOW (only for a finding
  // that's NEW this run — see firstparty-candidates.js's header on why
  // an older still-open finding doesn't keep re-blocking every
  // subsequent run) so the orchestrator can gather evidence BEFORE this
  // run finalizes, not only after (the exact gap the first live Phase 6
  // validation surfaced).
  const newKeysThisRun = new Set(changeDetection.new);
  const firstPartyQuestionsPending = findings
    .filter((f) => isFirstPartyEvidenceCandidate(f, { isNewThisRun: newKeysThisRun.has(f.key) }))
    .map(buildFirstPartyEvidenceQuestion);

  const firstPartyEvidence = {
    integrations: {
      searchConsole: Boolean(firstPartyIntegrations && firstPartyIntegrations.searchConsole),
      ga4: Boolean(firstPartyIntegrations && firstPartyIntegrations.ga4),
    },
    gatheredThisRunCount: firstPartyAttached.length,
    gatheredDuringThisRunCount,
    reusedFromBeforeCount: firstPartyAttached.length - gatheredDuringThisRunCount,
    // New fields (additive — the three above are untouched, see this
    // function's own header): gatheredByWorkflowCount +
    // reusedFreshOrAgingCount + staleReusedCount always equals
    // gatheredThisRunCount.
    gatheredByWorkflowCount,
    reusedFreshOrAgingCount,
    staleReusedCount,
    countsBySource: firstPartyCountsBySource,
    sourcesNotConsulted,
    questionsRaisedCount: firstPartyQuestionsPending.length,
    questionsPending: firstPartyQuestionsPending,
    items: firstPartyItems,
  };

  // Phase 7B — closes the "rotation selects a target but nothing
  // reviews it" gap (see agent/lib/rotation-evidence.js's header for
  // the full root-cause writeup). Rotation picks STILL never produce
  // PROPOSE_CHANGE and STILL never block run finalization (§4/§11's
  // rules are unchanged) — this only makes the report tell the truth
  // about which picks were actually researched, with what, and why not
  // when they weren't, instead of silently looking identical to a
  // genuinely-completed deep review.
  const rotationPicks = (rotationPriorities || []).map((p) => {
    const candidate = isRotationEvidenceCandidate(p);
    const evidenceList = Array.isArray(p.firstPartyEvidence) ? p.firstPartyEvidence : [];
    if (!candidate) {
      return {
        slug: p.slug,
        name: p.name,
        hasPage: p.hasPage,
        score: p.score,
        reasons: p.reasons,
        researched: false,
        firstPartyEvidence: [],
        evidenceFreshness: null,
        conclusion: null,
        conclusionReason: `${p.name} already has a dedicated page — reviewed through the ordinary daily audit + first-party-evidence pipeline for that page, not this rotation mechanism.`,
        externalResearchPerformed: false,
        externalResearchCapability: EXTERNAL_RESEARCH_CAPABILITY_MISSING,
      };
    }
    const classified = classifyRotationConclusion(evidenceList[0] || null, {
      searchConsoleConfigured: Boolean(firstPartyIntegrations && firstPartyIntegrations.searchConsole),
    });
    // Surfaces the evidence's own age alongside the conclusion — a
    // reader must never mistake a `NO_CHANGE` grounded in months-old
    // data for a fresh, current answer. `--refresh-rotation-evidence`
    // (cli.js) already treats stale evidence as absent and re-fetches,
    // so this should normally read "fresh"; a non-fresh value here
    // means that re-fetch didn't happen this run (e.g. Search Console
    // was unreachable) — visible, never hidden.
    const evidenceFreshness = evidenceList[0] ? computeFirstPartyFreshness(evidenceList[0], now).status : null;
    return {
      slug: p.slug,
      name: p.name,
      hasPage: p.hasPage,
      score: p.score,
      reasons: p.reasons,
      researched: classified.researched,
      firstPartyEvidence: evidenceList,
      evidenceFreshness,
      conclusion: classified.conclusion,
      conclusionReason: classified.reason,
      externalResearchPerformed: false,
      externalResearchCapability: EXTERNAL_RESEARCH_CAPABILITY_MISSING,
    };
  });

  const rotationSummary = rotationPriorities
    ? {
        targetsSelected: rotationPicks.length,
        targetsPageless: rotationPicks.filter((p) => !p.hasPage).length,
        targetsActuallyResearched: rotationPicks.filter((p) => p.researched).length,
        targetsConcludedNoChange: rotationPicks.filter((p) => p.conclusion === "NO_CHANGE").length,
        targetsConcludedResearchMore: rotationPicks.filter((p) => p.conclusion === "RESEARCH_MORE").length,
        targetsNotYetResearched: rotationPicks.filter((p) => !p.researched).length,
        proposalsCreatedFromRotation: 0, // structurally always 0 — see §11's rule, unchanged by this phase
        externalResearchPerformed: 0,
        externalResearchCapability: EXTERNAL_RESEARCH_CAPABILITY_MISSING,
      }
    : null;

  // First-Party Signals — derived, investigation-only leads computed
  // from the SAME attached `.firstPartyEvidence` the section above
  // reads, by agent/lib/firstparty-signals.js (see that file's header).
  // Deliberately kept as its own, separate, clearly-labeled report
  // section — this report now distinguishes three genuinely different
  // things, and conflating any two of them would recreate exactly the
  // "metrics quietly become decisions" risk this architecture was built
  // to avoid:
  //   1. `firstPartyEvidence` (above)  — RAW/NORMALIZED first-party
  //      evidence: what was actually observed, bounded and sourced, no
  //      interpretation at all.
  //   2. `firstPartySignals` (here)    — DERIVED investigation leads:
  //      a bounded, named pattern noticed IN that evidence (e.g. a
  //      query/page mismatch), with its own stated limitations and an
  //      explicit investigation-only posture. Still not a decision.
  //   3. `proposals`/`safeFixes` (above) — ACTUAL Agent decisions: the
  //      only section this run's real site changes or owner-facing
  //      proposals ever come from. Computed entirely by
  //      agent/lib/decision.js, which never reads `.firstPartyEvidence`
  //      or `.firstPartySignals` — see tests/agent-firstparty-safety.test.js
  //      and tests/agent-firstparty-signals-safety.test.js.
  // Never folded into status/healthSummary computation (same rule
  // firstPartyEvidence already follows) — zero signals is a valid,
  // ordinary, successful result, same as zero findings.
  const firstPartySignalItems = findings.flatMap((f) => (Array.isArray(f.firstPartySignals) ? f.firstPartySignals : []));
  const firstPartySignals = {
    count: firstPartySignalItems.length,
    items: firstPartySignalItems,
  };

  // Phase 10 — Curated Official Source Evidence. Deliberately its OWN
  // section, never merged into firstPartyEvidence (Search Console/GA4
  // data about OUR OWN site/search behavior) or firstPartySignals (a
  // mechanical PATTERN noticed in that first-party data) or `research`
  // (a human/Claude session's actual read-and-judge verdict about an
  // external source) above — this is a THIRD, independent evidence
  // category: a bounded, mechanical record that a known, human-verified
  // official page was retrieved, carrying no verdict of its own. Never
  // folded into status/healthSummary — same "zero evidence is a valid,
  // ordinary result" rule every other evidence section here follows.
  const localSourceEntries = (localSourceEvidence && localSourceEvidence.entries) || [];
  const localSourceWarnings = (localSourceEvidence && localSourceEvidence.warnings) || [];
  const localSourceEvidenceSection = {
    disclaimer: LOCAL_SOURCE_EVIDENCE_DISCLAIMER,
    count: localSourceEntries.length,
    warnings: localSourceWarnings,
    items: localSourceEntries.map((e) => ({
      sourceUrl: e.sourceUrl,
      sourceDomain: e.sourceDomain,
      authorityClass: e.authorityClass,
      locality: e.locality,
      topic: e.topic,
      discoveryMethod: e.discoveryMethod,
      retrievedAt: e.retrievedAt,
      expectedTemporality: e.expectedTemporality,
      freshness: computeLocalSourceFreshness(e, now).status,
      extractedSnippet: e.extractedSnippet,
      robots: e.robots,
    })),
  };

  // Phase 11B — weekly-only (same gating as `rotation`/`rotationSummary`
  // below: null on daily runs, since there is no "this week's picks" to
  // ask relevance for). Deliberately its OWN section, never merged into
  // localSourceEvidenceSection above (that section stays Phase 10's
  // original "what evidence already exists on disk," regardless of
  // run type) — see buildLocalSourceCandidatesSection()'s own header.
  const localSourceCandidatesSection = rotationPriorities
    ? buildLocalSourceCandidatesSection({
        picks: rotationPriorities,
        registryEntries: localSourceRegistryEntries || [],
        evidenceEntries: localSourceEntries,
        candidateLog: localSourceCandidateLog || { blockedOrFailed: [] },
        workflowBoundary,
        now,
      })
    : null;

  // Phase 15 — "no proposal" can still mean the Agent did useful work:
  // DISCOVER -> RESEARCH -> CLASSIFY produced a real, recorded
  // conclusion for every researched opportunity, even the ones that
  // never became a proposal (WATCH/LOW_SUPPRESS/PROTECT) — see
  // agent/lib/opportunity-classification.js's header and the spec's own
  // "Daily Agent Report" example. `record.opportunityClassifications` is
  // populated by runner.js from every finding's `.opportunityClassification`
  // (including the ones that bypass classification entirely —
  // APPLY_SAFE_FIX, observation-tier NO_CHANGE — which simply never
  // appear in this list at all, same bypass this whole phase follows
  // throughout).
  const opportunityClassifications = Array.isArray(record.opportunityClassifications) ? record.opportunityClassifications : [];
  const classificationCounts = { IMPORTANT: 0, WATCH: 0, LOW_SUPPRESS: 0, PROTECT: 0 };
  for (const c of opportunityClassifications) {
    if (c && classificationCounts[c.classification] !== undefined) classificationCounts[c.classification] += 1;
  }
  // A proposal is only ever "created" here in the sense this section
  // means — synced to agent_proposals this run (proposalStatus set,
  // same signal `proposals.items` above already uses) AND the reason it
  // synced was an IMPORTANT classification, not the pre-Phase-15 path
  // (a legacy caller of syncProposals() that never classified at all —
  // see proposals-sync.js's needsProposal() fallback).
  const proposalsCreatedFromClassification = findings.filter(
    (f) => f.opportunityClassification && f.opportunityClassification.classification === "IMPORTANT" && f.proposalStatus
  ).length;
  const opportunityResearch = {
    researchedCount: opportunityClassifications.length,
    important: classificationCounts.IMPORTANT,
    watch: classificationCounts.WATCH,
    suppressed: classificationCounts.LOW_SUPPRESS,
    protect: classificationCounts.PROTECT,
    proposalsCreated: proposalsCreatedFromClassification,
    // Bounded — same "never a raw dump" discipline every other section
    // here follows (evidence-dossier.js's boundedSummary(), etc.).
    examples: opportunityClassifications.slice(0, 10).map((c) => ({
      key: c.key,
      type: c.type,
      classification: c.classification,
      reason: c.reason,
    })),
  };

  const status = computeRunStatus({
    failure,
    hasUnresolvedResearch: questionsPending.length > 0,
    hasUnresolvedFirstPartyEvidence: firstPartyQuestionsPending.length > 0,
  });

  const healthSummary = buildHealthSummary({
    status,
    actionableOpenCount,
    proposalsAwaitingApproval,
    questionsPendingCount: questionsPending.length,
    firstPartyQuestionsPendingCount: firstPartyQuestionsPending.length,
    failure,
  });

  const report = {
    runId: record.runId,
    sequence: record.sequence || 1,
    status,
    timestamp: record.timestamp,
    runType: record.runType || "manual",
    mode: record.mode,
    pagesChecked: record.summary ? record.summary.pagesScanned : 0,
    healthSummary,
    technicalIssues: {
      actionableOpen: actionableOpenCount,
      byCategory: record.summary ? record.summary.byCategory : {},
    },
    observationsCount,
    opportunitiesCount,
    research: {
      questionsRaisedCount: questionsPending.length,
      questionsPending,
      performed: researchPerformed,
    },
    safeFixes: {
      appliedCount: safeFixesApplied.length,
      items: safeFixesApplied.map((f) => ({ key: f.key, summary: f.summary, page: f.pages && f.pages[0] })),
    },
    proposals: {
      createdOrUpdatedCount: proposalsCreatedOrUpdated.length,
      awaitingApprovalCount: proposalsAwaitingApproval,
      previouslyRejectedStillSurfacingCount: previouslyRejectedStillSurfacing,
      alreadyAppliedCount: alreadyApplied,
      items: proposalsCreatedOrUpdated.map((f) => ({
        key: f.key,
        summary: f.summary,
        decision: f.decision,
        proposalStatus: f.proposalStatus || null,
      })),
    },
    changeDetection,
    opportunityResearch,
    firstPartyEvidence,
    firstPartySignals,
    localSourceEvidence: localSourceEvidenceSection,
    localSourceCandidates: localSourceCandidatesSection,
    validation: record.validation || null,
    proposalsSyncSkippedReason: record.proposalsSync && record.proposalsSync.skipped ? record.proposalsSync.reason : null,
    failure: failure || null,
    rotation: rotationPriorities
      ? {
          picks: rotationPicks,
          summary: rotationSummary,
        }
      : null,
    nextReviewHint:
      record.runType === "weekly"
        ? "Next weekly deep review will rotate to a different set of service-area topics — see agent/history/research-rotation-state.json."
        : "A weekly deep-research run has not been scheduled yet in production — see agent/README.md's scheduling recommendation.",
  };

  return report;
}

module.exports = { buildReport, buildHealthSummary, computeRunStatus, parseWorkflowStartedAt };
