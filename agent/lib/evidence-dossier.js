// Site Improvement Agent, Phase 13a — cross-source evidence dossier.
//
// Assembles, for ONE already-decided category-C finding, a small,
// inspectable summary of what EVERY evidence family already gathered by
// this agent says about that finding's own premise — never a second
// decision framework (see agent/lib/cross-source-synthesis.js, which is
// the one place that turns a dossier into a sufficiency read and,
// sometimes, a research.js-shaped result). This module only builds the
// dossier; it never classifies corroboration, never writes a file, and
// never reads/writes risk.js's category/tier/autoApplyEligible fields.
//
// PURE AND DETERMINISTIC — no network, and (per Phase 13 investigation)
// no re-running of audits either: every family here is read from data
// ALREADY gathered and persisted by an existing system (a finding's own
// `.evidence`/`.firstPartyEvidence`/`.research`, already-written
// agent/research/completed-jobs/*.json and agent/research/local-sources/
// *.json files). See agent/lib/run-synthesis.js for the one caller that
// feeds this the most recent run's persisted findings.
//
// FIVE FAMILIES, deliberately not symmetric in what they can establish:
//
//   - site: the finding's OWN generating evidence (the audit fact that
//     created this finding in the first place). ALWAYS "not-applicable"
//     for voting purposes — see "Why `site` never votes" below — but
//     still surfaced for CRM/report display, so a human sees the full
//     picture, not just the external corroboration.
//   - gsc: Search Console evidence already attached to this finding
//     (agent/lib/firstparty-intake.js's attachFirstPartyEvidence(), via
//     agent/lib/finding-evidence.js's query/page requests — today only
//     ever gathered automatically for content-gap/structural-
//     inconsistency, but this module reads whatever is actually attached
//     for ANY finding, never assuming only those two types can have it).
//   - ga4: GA4 lead-event evidence already attached (same attachment
//     point, via agent/lib/lead-event-candidates.js's requests).
//   - completedJobs: publication-safe completed-job evidence
//     (agent/lib/completed-job-intake.js), matched to this finding's own
//     city/service when the finding's premise is genuinely about
//     city/service-scoped operational demand — "not-applicable" when it
//     isn't (see matchCompletedJobs() below).
//   - localSource: curated official-source evidence
//     (agent/lib/local-source-intake.js). ALWAYS "unavailable" in Phase
//     13a — see "Local-source semantic boundary" below.
//
// Why `site` never votes: the finding's own generating evidence
// establishes the OBSERVATION the research question is asking about
// (e.g. "this page's FAQ has 3 questions vs. a 6-question sibling
// average") — it does NOT, by itself, answer that question (e.g.
// "are there specific unanswered questions worth adding"). Counting it
// as independent corroboration would be circular: it would effectively
// hand every category-C opportunity an automatic first corroborator the
// instant it's created, so every single category-C finding would
// trivially reach "partially-corroborated" with zero real external
// evidence — silently weakening/deleting RESEARCH_MORE as a practical
// outcome for the very findings this phase is supposed to be more
// careful about, not less. So `site` is always classified "not-applicable" for
// the sufficiency vote (agent/lib/cross-source-synthesis.js's
// classifySufficiency() never counts it), while still being shown in
// `familyBreakdown` for a human's full context — see
// agent/lib/cross-source-synthesis.js's header for the full reasoning
// and agent/README.md's Phase 13a section for the worked example.
//
// Local-source semantic boundary: determining whether a curated
// official-source SNIPPET actually supports or contradicts a specific
// page's claim requires reading prose — a judgment this deterministic
// module cannot honestly make (same rule Phase 10/11 already established
// for local-source-evidence.js itself). So `localSource` is always
// "unavailable" here, regardless of whether matching-locality evidence
// exists on disk; a human/Claude research session is still the only path
// that can turn curated local-source evidence into a genuine
// supports/contradicts verdict (by writing an ordinary research.js
// result directly — at which point decision.js's EXISTING logic already
// handles it, and this finding is no longer a synthesis candidate at
// all — see run-synthesis.js's candidate filter).
//
// GA4 RELEVANCE — evaluated per finding type's own premise, never
// assumed from the family's name alone (a pre-push review of this phase
// specifically asked: is GA4 genuinely a different question for EVERY
// one of the five in-scope types, or only asserted to be?). Walking
// through all five IN_SCOPE_FINDING_TYPES against what GA4 evidence
// this codebase actually gathers today
// (agent/lib/lead-event-candidates.js's landing-page session total +
// confirmed lead-event counts, Phase 12):
//
//   - content-gap / structural-inconsistency: the ONLY two types GA4
//     evidence is EVER automatically gathered for —
//     lead-event-candidates.js's isLeadEventEvidenceCandidate() narrows
//     finding-evidence.js's own QUERY_PAGE_CANDIDATE_TYPES (already
//     scoped to just these two) further to non-blog/non-utility pages.
//     Their actual premise (decision.js's questionTextFor(), verified
//     directly, not assumed): "...is there enough evidence that this
//     page's actual topic has specific, genuinely useful practical
//     questions not yet answered there..." (content-gap) / "...does
//     this specific difference reflect a real content gap worth
//     closing..." (structural-inconsistency) — both are questions about
//     CONTENT DEPTH/COMPLETENESS. GA4's lead-event-landing-page-delta
//     signal measures whether this page's visitor volume/conversion-
//     event counts moved between two periods — a question about
//     TRAFFIC/CONVERSION OUTCOMES. Neither direction of movement
//     establishes whether specific questions are unanswered or whether
//     a structural difference is a real content gap (the "sessions up /
//     lead events down" worked example in agent/README.md's Phase 13a
//     section is exactly this: real evidence, genuinely a DIFFERENT
//     question than the one this finding raises) — confirmed against
//     the real premise text, not merely asserted by family name.
//   - coverage-gap-candidate / duplicate-meta-description /
//     overlapping-intent: GA4 evidence is NEVER gathered for these
//     three under any existing mechanism — finding-evidence.js's own
//     header explicitly excludes all three from its candidate set in
//     the first place (coverage-gap-candidate: "the natural query term
//     would be the missing service's name, not this page's own
//     identity"; overlapping-intent/duplicate-meta-description: "need a
//     genuinely different, GROUP-scoped request shape this module's
//     single-target design doesn't attempt"), and
//     lead-event-candidates.js only ever builds on that same candidate
//     set. So for these three, `ga4` is "unavailable" as a simple,
//     honest consequence of no evidence EVER existing for them — not a
//     relevance judgment call at all, since there is nothing to judge.
//
// CONCLUSION: for every one of the five in-scope types, GA4 is never a
// vote in Phase 13a — either because real GA4 evidence exists but
// answers a different question (content-gap/structural-inconsistency),
// or because no GA4 evidence is ever gathered for the type at all (the
// other three). Treating a session/conversion movement as support OR
// contradiction for either case would be exactly the kind of guess the
// brief rules out. A later phase that builds a genuine comparable-
// cohort GA4 mechanism (see agent/lib/firstparty-signals.js's own
// header on why that doesn't exist yet) could revisit the first half of
// this — the second half (the other three types) would need new
// evidence-gathering scope first, which stays explicitly out of Phase
// 13a/13b's reach per the brief ("do NOT invent a new conversion/UX
// finding type").
const GA4_CANDIDATE_TYPES = new Set(["content-gap", "structural-inconsistency"]);
const PREMISE_LABEL_BY_TYPE = {
  "content-gap": "content depth/completeness",
  "structural-inconsistency": "structural completeness",
  "coverage-gap-candidate": "cross-service coverage",
  "duplicate-meta-description": "description distinctness",
  "overlapping-intent": "search-intent overlap",
};

const { isCityPage, CITY_SLUGS } = require("./page-groups");
const { getCitiesWithPages, getServicePages } = require("./business-profile");
const { computeFirstPartyFreshness } = require("./firstparty-evidence");

const FAMILIES = ["site", "gsc", "ga4", "completedJobs", "localSource"];

// Pre-acceptance hardening (audit finding #2, baseline 2bff317) — a
// single explicit version for this file's + cross-source-synthesis.js's
// DETERMINISTIC CLASSIFICATION RULES (which family statuses are
// possible, which finding types are in scope, how completed-job/GA4/GSC
// evidence is matched and interpreted, the OPPORTUNITY_CLASS_RULES
// thresholds, etc) — folded into computeDossierFingerprint()'s basis
// below. Bump this by 1 whenever a change to those rules could change a
// family's derived `status` (or the overall sufficiency verdict) for
// SOME finding, even when the raw evidence counts/timestamps those
// rules operate on haven't changed at all.
//
// Why this exists: computeDossierFingerprint() previously hashed only
// raw evidence identity (counts + timestamps) — it had no way to notice
// that the RULES deriving a conclusion from that evidence had changed.
// Concretely: fix a bug in deriveServiceLabelForFinding()'s matching
// logic, re-run --run-synthesis against the SAME on-disk completed-job
// evidence (same count, same timestamps) — the fingerprint would be
// byte-identical to before the fix, so run-synthesis.js's existing
// `priorSynthesis.synthesisFingerprint === fingerprint` short-circuit
// (see that file's header) would skip re-evaluating this finding
// forever, even though re-deriving with the FIXED code might now
// legitimately reach a different conclusion. A prior
// supports-opportunity/contradicts-opportunity result would then stay
// authoritative indefinitely, never re-checked against the corrected
// rules — exactly the "stale belief survives a code fix" failure this
// phase's own stale-support-supersession design (see
// cross-source-synthesis.js's header) was built to prevent for evidence
// changes, but did not yet cover for RULE changes.
//
// Deliberately a single bare integer, not a generic
// migration/versioning framework: whoever next changes a classification
// rule in this file or cross-source-synthesis.js is expected to bump
// this by hand, the same way a database migration file is hand-numbered
// — see this file's own comment for why that's sufficient here (an
// explicit, reviewable diff on every rule change, not automatic
// detection of "did the rules change").
const SYNTHESIS_RULES_VERSION = 1;

// Only these five finding types are in scope for Phase 13a (verified
// against agent/lib/risk.js's RULES — every category "C" type EXCEPT
// "research-gap", which risk.js still lists but no audit module ever
// actually emits — see agent/lib/finding-evidence.js's own header, which
// already documented this as a dead type).
const IN_SCOPE_FINDING_TYPES = [
  "content-gap",
  "structural-inconsistency",
  "coverage-gap-candidate",
  "duplicate-meta-description",
  "overlapping-intent",
];

const CITY_PAGE_RE = new RegExp(`^(${CITY_SLUGS.join("|")})-junk-removal\\.html$`);

/**
 * The city NAME (e.g. "Wheat Ridge"), never a slug, for a finding's own
 * page(s) — only when EXACTLY ONE of the finding's pages is a true city
 * page (business-profile.js's own vocabulary, matching completed-job
 * evidence's `city` field). Returns null for a blog/service page, or when
 * more than one of the finding's pages is a city page (an ambiguous,
 * multi-city finding this module never guesses a single city for).
 * @param {object} finding - carries `.pages` (repo-relative file names)
 */
function deriveCityNameForFinding(finding) {
  const pages = Array.isArray(finding.pages) ? finding.pages : [];
  const cityPages = pages.filter(isCityPage);
  if (cityPages.length !== 1) return null;
  const match = CITY_PAGE_RE.exec(cityPages[0]);
  if (!match) return null;
  const slug = match[1];
  const city = getCitiesWithPages().find((c) => c.slug === slug);
  return city ? city.name : null;
}

/**
 * The service LABEL (e.g. "Furniture Removal") a coverage-gap-candidate
 * finding's `serviceFile` evidence field names, via business-profile.js's
 * own services.pages list — never re-derived from the filename by
 * stripping/replacing characters (that would be a guess; this is a
 * direct lookup against the one canonical list). Returns null if the
 * finding carries no `serviceFile` evidence field, or if it names a file
 * not in that list.
 * @param {object} finding
 */
function deriveServiceLabelForFinding(finding) {
  const entry = (finding.evidence || []).find((e) => e.field === "serviceFile");
  if (!entry || !entry.value) return null;
  const service = getServicePages().find((s) => s.file === entry.value);
  return service ? service.label : null;
}

function boundedSummary(items, max = 3) {
  const list = Array.isArray(items) ? items : [];
  const shown = list.slice(0, max).map((e) => (e && typeof e === "object" ? JSON.stringify(e) : String(e)));
  const suffix = list.length > max ? ` (+${list.length - max} more)` : "";
  return shown.join("; ") + suffix;
}

// --- site family ------------------------------------------------------

function buildSiteFamily(finding) {
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  return {
    family: "site",
    status: "not-applicable",
    detail:
      `This finding's own generating evidence (${boundedSummary(evidence) || "none recorded"}) establishes the OBSERVATION ` +
      `this synthesis is evaluating — it is the premise being tested, not independent corroboration of it, so it is never counted as a supporting/contradicting vote (see evidence-dossier.js's header).`,
    evidenceRefs: evidence.map((e) => `finding.evidence: ${e.field}=${JSON.stringify(e.value)}`),
  };
}

// --- gsc family ---------------------------------------------------------

function mostRecentNonStale(entries, now) {
  let best = null;
  for (const e of entries) {
    if (computeFirstPartyFreshness(e, now).status === "stale") continue;
    if (!best || new Date(e.fetchedAt).getTime() > new Date(best.fetchedAt).getTime()) best = e;
  }
  return best;
}

function buildGscFamily(finding, now) {
  const all = (finding.firstPartyEvidence || []).filter((e) => e.source === "search-console-search-analytics");
  if (all.length === 0) {
    return { family: "gsc", status: "unavailable", detail: "No Search Console evidence has been gathered yet for this finding.", evidenceRefs: [] };
  }

  const fresh = mostRecentNonStale(all, now);
  if (!fresh) {
    const mostRecentAny = [...all].sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt))[0];
    const freshness = computeFirstPartyFreshness(mostRecentAny, now);
    return {
      family: "gsc",
      status: "insufficient-data",
      detail: `Search Console evidence exists but is stale (age ${freshness.ageDays} day(s)) — treated as insufficient, not current support, until re-fetched.`,
      evidenceRefs: [`${mostRecentAny.window.label}: ${JSON.stringify(mostRecentAny.observed)}`],
    };
  }

  const observed = fresh.observed || {};
  const rows = Array.isArray(observed.topRows) ? observed.topRows : [];
  if (rows.length === 0 || observed.totalRowsReturned === 0) {
    return {
      family: "gsc",
      status: "insufficient-data",
      detail: `Search Console returned zero rows for this finding's own query term over ${fresh.window.label} — honest absence of demonstrated SIGNAL, never evidence the opportunity is unreal (absence of evidence is not evidence of absence).`,
      evidenceRefs: [`${fresh.window.label}: 0 rows`],
    };
  }

  const subjectPages = new Set((finding.pages || []).map((p) => String(p).toLowerCase()));
  const dims = String(fresh.dimension || "").split("+");
  const pageIndex = dims.indexOf("page");
  let anyOnPage = false;
  let allMismatched = true;
  for (const row of rows) {
    const keys = Array.isArray(row.keys) ? row.keys : [];
    const rowPage = pageIndex === -1 ? undefined : keys[pageIndex];
    if (rowPage === undefined) continue;
    const normalized = String(rowPage).replace(/^\/+/, "").toLowerCase();
    if (subjectPages.has(normalized)) {
      anyOnPage = true;
      allMismatched = false;
    }
  }

  if (anyOnPage) {
    return {
      family: "gsc",
      status: "supports",
      detail: `Search Console shows real query traffic over ${fresh.window.label} landing directly on this page — demonstrated search demand for this page's own topic, directly relevant to whether investing further here is warranted.`,
      evidenceRefs: [`${fresh.window.label}: ${rows.length} row(s), at least one landing on ${finding.pages[0]}`],
    };
  }

  if (allMismatched && pageIndex !== -1) {
    return {
      family: "gsc",
      status: "different-question",
      detail: `Search Console shows query traffic over ${fresh.window.label}, but every row lands on a DIFFERENT URL than this finding's own page(s) — this is a query/page routing question (see agent/lib/firstparty-signals.js's query-page-mismatch signal), not evidence for or against this finding's own content-depth/structure premise.`,
      evidenceRefs: [`${fresh.window.label}: ${rows.length} row(s), none landing on ${finding.pages[0]}`],
    };
  }

  return {
    family: "gsc",
    status: "insufficient-data",
    detail: `Search Console evidence exists for ${fresh.window.label} but its dimensions don't let this synthesis tell which page each row actually landed on.`,
    evidenceRefs: [`${fresh.window.label}: ${rows.length} row(s)`],
  };
}

// --- ga4 family -----------------------------------------------------------

function buildGa4Family(finding) {
  const all = (finding.firstPartyEvidence || []).filter((e) => e.source === "ga4");
  const premiseLabel = PREMISE_LABEL_BY_TYPE[finding.type] || "this finding's own premise";

  if (all.length === 0) {
    const reason = GA4_CANDIDATE_TYPES.has(finding.type)
      ? "No GA4 evidence has been gathered yet for this finding."
      : `No GA4 evidence has ever been gathered for "${finding.type}" findings — no existing mechanism targets this finding type (see evidence-dossier.js's GA4-relevance header).`;
    return { family: "ga4", status: "unavailable", detail: reason, evidenceRefs: [] };
  }

  // GA4 evidence existing at all here means finding.type is one of
  // GA4_CANDIDATE_TYPES (the only types any mechanism ever gathers it
  // for) — still read defensively rather than assumed, in case a human
  // ever hand-writes GA4 evidence for a different type.
  return {
    family: "ga4",
    status: "different-question",
    detail: `GA4 evidence exists for this finding (session/lead-event volume over ${all
      .map((e) => e.window.label)
      .join(", ")}), but it measures traffic/conversion outcomes — a materially different question than this finding's own premise (${premiseLabel}). Phase 13a deliberately never treats a session or lead-event movement as support or contradiction here (verified against this finding type's actual premise, not assumed by family name — see evidence-dossier.js's GA4-relevance header) — never guessed, never counted either way.`,
    evidenceRefs: all.map((e) => `${e.dimension || e.metric}: ${e.window.label}`),
  };
}

// --- completedJobs family --------------------------------------------------

// Only these two in-scope types have a premise that is genuinely about
// city/service-scoped OPERATIONAL demand — see evidence-dossier.js's
// header. The other three (structural-inconsistency, duplicate-meta-
// description, overlapping-intent) are about content structure/
// duplication/intent-overlap, which completed-job counts don't bear on.
const COMPLETED_JOBS_APPLICABLE_TYPES = new Set(["content-gap", "coverage-gap-candidate"]);

/**
 * The exact completed-job evidence entries buildCompletedJobsFamily()
 * treats as relevant votes for this finding — city-matched always,
 * additionally service-matched for coverage-gap-candidate once a
 * service label is resolvable. Factored out as its OWN function (rather
 * than inlined separately in buildCompletedJobsFamily() and
 * computeDossierFingerprint(), as it originally was) specifically so the
 * two can never drift apart again — see computeDossierFingerprint()'s
 * own header for the real drift bug this closes (pre-acceptance
 * hardening, audit finding #2, baseline 2bff317): the fingerprint used
 * to count only city-matched rows, never applying
 * coverage-gap-candidate's own service filter, so a change in which
 * completed jobs service-match (without any change in the city-matched
 * count) could silently change buildCompletedJobsFamily()'s status
 * (insufficient-data <-> supports) while leaving the fingerprint
 * unchanged — exactly the "evidence changed in a way that matters, but
 * the fingerprint didn't notice" failure mode run-synthesis.js's
 * freshness check exists to prevent.
 * @param {object} finding
 * @param {object[]} completedJobEvidence
 * @returns {object[]}
 */
function relevantCompletedJobMatches(finding, completedJobEvidence) {
  if (!COMPLETED_JOBS_APPLICABLE_TYPES.has(finding.type)) return [];
  const cityName = deriveCityNameForFinding(finding);
  if (!cityName) return [];

  const cityMatches = (completedJobEvidence || []).filter((e) => e && typeof e.city === "string" && e.city.toLowerCase() === cityName.toLowerCase());
  if (finding.type !== "coverage-gap-candidate") return cityMatches;

  const serviceLabel = deriveServiceLabelForFinding(finding);
  // No resolvable service label: buildCompletedJobsFamily() falls back
  // to reporting the (unfiltered) city matches as its own
  // "insufficient-data" detail in this exact case — mirror that here so
  // the fingerprint still reacts to a changing city-matched set even
  // when the service label can't be resolved (a condition that is
  // itself already captured by `siteEvidence` in the fingerprint basis,
  // since it's derived from the finding's own evidence fields).
  if (!serviceLabel) return cityMatches;
  return cityMatches.filter((e) => typeof e.serviceType === "string" && e.serviceType.toLowerCase().includes(serviceLabel.toLowerCase()));
}

function buildCompletedJobsFamily(finding, completedJobEvidence) {
  if (!COMPLETED_JOBS_APPLICABLE_TYPES.has(finding.type)) {
    return {
      family: "completedJobs",
      status: "not-applicable",
      detail: `"${finding.type}" findings are not about city/service-scoped operational demand — completed-job evidence does not bear on this premise.`,
      evidenceRefs: [],
    };
  }

  const cityName = deriveCityNameForFinding(finding);
  if (!cityName) {
    return {
      family: "completedJobs",
      status: "not-applicable",
      detail: "This finding's page is not a single, identifiable city page — completed-job evidence (which is city-scoped) has no natural mapping here.",
      evidenceRefs: [],
    };
  }

  const cityMatches = (completedJobEvidence || []).filter((e) => e && typeof e.city === "string" && e.city.toLowerCase() === cityName.toLowerCase());
  if (cityMatches.length === 0) {
    return {
      family: "completedJobs",
      status: "insufficient-data",
      detail: `No completed-job evidence has been gathered for ${cityName} in the available window — honest absence of operational signal, never evidence demand doesn't exist.`,
      evidenceRefs: [],
    };
  }

  if (finding.type === "coverage-gap-candidate") {
    const serviceLabel = deriveServiceLabelForFinding(finding);
    if (!serviceLabel) {
      return {
        family: "completedJobs",
        status: "insufficient-data",
        detail: `Completed-job evidence exists for ${cityName}, but this finding's own missing-service field could not be resolved to a known service label to match against.`,
        evidenceRefs: cityMatches.slice(0, 3).map((e) => `${cityName}: ${e.serviceType || "(no serviceType)"}`),
      };
    }
    const serviceMatches = relevantCompletedJobMatches(finding, completedJobEvidence);
    if (serviceMatches.length === 0) {
      return {
        family: "completedJobs",
        status: "insufficient-data",
        detail: `Completed-job evidence exists for ${cityName}, but none of it is for "${serviceLabel}" specifically — operational activity exists in this city, but not demonstrably for the exact missing service this finding is about.`,
        evidenceRefs: cityMatches.slice(0, 3).map((e) => `${cityName}: ${e.serviceType || "(no serviceType)"}`),
      };
    }
    return {
      family: "completedJobs",
      status: "supports",
      detail: `Real, publication-safe completed-job evidence shows "${serviceLabel}" work actually happened in ${cityName} — direct operational evidence for the exact service/city gap this finding raises.`,
      evidenceRefs: serviceMatches.slice(0, 3).map((e) => `${cityName}: ${e.serviceType}`),
    };
  }

  // content-gap on a city page: city-scoped operational activity is
  // weaker, more general corroboration (it supports that this page's
  // city/audience is real and active, not specifically that the exact
  // missing FAQ questions matter) — still an honest "supports", not
  // upgraded to anything stronger.
  return {
    family: "completedJobs",
    status: "supports",
    detail: `Real, publication-safe completed-job evidence shows genuine recent activity in ${cityName} — supports that this page serves a real, active local audience worth investing further content for.`,
    evidenceRefs: cityMatches.slice(0, 3).map((e) => `${cityName}: ${e.serviceType || "(no serviceType)"}`),
  };
}

// --- localSource family ----------------------------------------------------

function buildLocalSourceFamily(finding, localSourceEvidence) {
  const cityName = deriveCityNameForFinding(finding);
  const matches = cityName
    ? (localSourceEvidence || []).filter((e) => e && typeof e.locality === "string" && e.locality.toLowerCase().includes(cityName.toLowerCase()))
    : [];

  if (matches.length === 0) {
    return {
      family: "localSource",
      status: "unavailable",
      detail: "No curated local-source evidence exists for this finding's locality — unavailable, never contradiction.",
      evidenceRefs: [],
    };
  }

  return {
    family: "localSource",
    status: "unavailable",
    detail: `${matches.length} curated local-source evidence item(s) exist for ${cityName}, but whether any of them actually, semantically supports or contradicts THIS finding's specific premise has not been confirmed by a human/Claude review — mechanical keyword/locality matching alone cannot establish that (see evidence-dossier.js's header). Still "unavailable," never treated as support or contradiction.`,
    evidenceRefs: matches.slice(0, 3).map((e) => `${e.sourceDomain} — ${e.topic}`),
  };
}

/**
 * Assembles the full five-family dossier for one finding. `finding` is
 * expected to be an already-decided, persisted-shape finding (the same
 * shape agent/runner.js writes to history — see agent/lib/run-synthesis.js)
 * carrying `.evidence`, `.firstPartyEvidence`, `.pages`, `.type`, `.key`.
 * @param {object} finding
 * @param {object} context
 * @param {object[]} [context.completedJobEvidence] - loadCompletedJobEvidence().evidence
 * @param {object[]} [context.localSourceEvidence] - loadLocalSourceEvidence().entries
 * @param {Date} [context.now]
 */
function assembleDossier(finding, context = {}) {
  const now = context.now || new Date();
  const families = {
    site: buildSiteFamily(finding),
    gsc: buildGscFamily(finding, now),
    ga4: buildGa4Family(finding),
    completedJobs: buildCompletedJobsFamily(finding, context.completedJobEvidence || []),
    localSource: buildLocalSourceFamily(finding, context.localSourceEvidence || []),
  };
  return {
    findingKey: finding.key,
    findingType: finding.type,
    pages: finding.pages,
    families,
  };
}

/**
 * A deterministic fingerprint of exactly which evidence a dossier was
 * built from — NOT a hash of the dossier's own derived status/detail
 * text (two runs reaching the same conclusion from the same inputs
 * should fingerprint identically even if wording changes), so
 * agent/lib/run-synthesis.js can tell "the underlying evidence hasn't
 * changed" apart from "something changed, re-derive and possibly write a
 * newer file" — see agent/lib/run-synthesis.js's header. Deliberately
 * NOT a generic dependency graph — just a bounded summary of each
 * family's own raw input identity (counts + most-recent timestamps),
 * hashed with Node's built-in crypto (no new dependency).
 * @param {object} finding
 * @param {object} context - same shape assembleDossier() takes
 */
function computeDossierFingerprint(finding, context = {}) {
  const crypto = require("crypto");
  // `context.rulesVersion` is an injectable override for tests ONLY
  // (see tests/agent-evidence-dossier.test.js and
  // tests/agent-run-synthesis.test.js's rules-version-bump scenarios) —
  // production callers never pass it, so this always resolves to the
  // real SYNTHESIS_RULES_VERSION constant above in actual runs. Lets a
  // test simulate "the classification rules changed" deterministically,
  // without needing a generic migration/versioning framework or
  // mutating the module's own source at test time.
  const rulesVersion = context.rulesVersion !== undefined ? context.rulesVersion : SYNTHESIS_RULES_VERSION;
  const gsc = (finding.firstPartyEvidence || []).filter((e) => e.source === "search-console-search-analytics");
  const ga4 = (finding.firstPartyEvidence || []).filter((e) => e.source === "ga4");
  const cityName = deriveCityNameForFinding(finding);
  // Pre-acceptance hardening (audit finding #2) — reuses the SAME
  // matching function buildCompletedJobsFamily() itself calls (via
  // relevantCompletedJobMatches()), instead of a separately-maintained,
  // weaker city-only filter that used to live here. See that function's
  // own header for the exact drift bug this closes.
  const completedJobs = relevantCompletedJobMatches(finding, context.completedJobEvidence || []);
  const localSource = (context.localSourceEvidence || []).filter((e) => e && cityName && typeof e.locality === "string" && e.locality.toLowerCase().includes(cityName.toLowerCase()));

  const latestTimestamp = (entries, field) => entries.map((e) => e[field]).sort().slice(-1)[0] || null;

  const basis = {
    rulesVersion,
    findingType: finding.type,
    siteEvidence: (finding.evidence || []).map((e) => `${e.field}=${JSON.stringify(e.value)}`),
    gscCount: gsc.length,
    gscLatestFetchedAt: latestTimestamp(gsc, "fetchedAt"),
    ga4Count: ga4.length,
    ga4LatestFetchedAt: latestTimestamp(ga4, "fetchedAt"),
    completedJobsCount: completedJobs.length,
    localSourceCount: localSource.length,
    localSourceLatestRetrievedAt: latestTimestamp(localSource, "retrievedAt"),
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

module.exports = {
  FAMILIES,
  IN_SCOPE_FINDING_TYPES,
  COMPLETED_JOBS_APPLICABLE_TYPES,
  SYNTHESIS_RULES_VERSION,
  deriveCityNameForFinding,
  deriveServiceLabelForFinding,
  relevantCompletedJobMatches,
  assembleDossier,
  computeDossierFingerprint,
};
