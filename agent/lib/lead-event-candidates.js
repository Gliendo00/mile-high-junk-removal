// Site Improvement Agent, Phase 12 — GA4 lead-event landing-page
// candidate eligibility and request building.
//
// THE GAP THIS CLOSES: firstparty-signals.js's lead-event-landing-page-
// delta signal needs TWO correlated GA4 evidence entries for the same
// finding/page at once (see that detector's own header): a landing-
// page SESSION total, and an eventName-broken-down EVENT-COUNT report.
// Nothing in this codebase decided which pages deserve that pair of
// fetches, or built the requests — this module is that decision,
// mirroring agent/lib/finding-evidence.js's own architecture almost
// exactly (same candidate-rule / mechanical-request-builder / freshness
// shape, zero network access here).
//
// DELIBERATELY NARROW (brief: "do not query GA4 lead-event evidence for
// every site page"; "candidate selection must be deterministic and
// narrow"; "prefer pages with actual conversion intent and/or pages
// already under Weekly investigation"):
//
//   Candidates are the EXACT SAME single-page findings
//   finding-evidence.js's isQueryPageEvidenceCandidate() already
//   identifies as this week's content-gap/structural-inconsistency
//   targets — "already under Weekly investigation" by construction,
//   never an independent sweep across every page on the site — NARROWED
//   further to pages with real conversion intent: not a blog page (blog
//   posts are content, not a booking/contact destination) and not a
//   utility page (privacy-policy.html etc. — no conversion intent by
//   design; see agent/lib/page-groups.js's isUtilityPage()).
//
// Deliberately reuses finding-evidence.js's own candidate set rather
// than ALSO drawing from weekly rotation picks — a rotation pick is
// never a Finding, and attachFirstPartySignals() only ever runs on
// findings (see agent/runner.js), so a pick-based candidate here would
// produce evidence with nowhere to attach a signal. Extending lead-
// event coverage to rotation picks would need attachFirstPartySignals()
// itself extended to picks first — a larger, separately-authorized
// change this phase does not make.
//
// This module NEVER fetches anything, and is NEVER imported by
// decision.js (same hard separation every other *-candidates.js/
// *-evidence.js module in this codebase maintains).

const { isQueryPageEvidenceCandidate } = require("./finding-evidence");
const { isBlogPage, isUtilityPage } = require("./page-groups");
const { LEAD_EVENT_NAMES } = require("./lead-event-instrumentation");

const SOURCE = "ga4";

/**
 * @param {object} finding - a decided finding (post decideAll(), post attachFirstPartyEvidence())
 */
function isLeadEventEvidenceCandidate(finding) {
  if (!isQueryPageEvidenceCandidate(finding)) return false;
  const page = finding.pages[0];
  if (isBlogPage(page) || isUtilityPage(page)) return false;
  return true;
}

/**
 * Mechanically builds the TWO ready-to-fetch GA4 requests a lead-event
 * candidate needs — no orchestrator judgment, same spirit as
 * finding-evidence.js's buildQueryPageEvidenceRequest(). Both requests
 * share `findingKey`, `scope`, and `compareToPreviousPeriod: true` (see
 * agent/lib/firstparty-fetch.js's fetchGa4Evidence()) so both periods'
 * evidence is available for the signal's own correlation step.
 *
 * `sessionContextRequest` — total sessions to this landing page, NOT
 * broken down by event — the denominator the lead-event signal uses to
 * contextualize an event-count change against a traffic change (brief:
 * "always contextualize event-count movement with traffic/session
 * movement").
 *
 * `eventDetailRequest` — raw eventName+eventCount for this landing
 * page, filtered to ONLY this codebase's own confirmed lead-event
 * vocabulary (lead-event-instrumentation.js's LEAD_EVENT_NAMES) — never
 * `conversions`/`keyEvents` (see that module's header on why: GA4
 * Admin-console key-event configuration is invisible to this agent's
 * `analytics.readonly` scope). GA4's own FilterExpression semantics let
 * a request FILTER by a dimension (`landingPage`) without that
 * dimension also being a BREAKDOWN dimension — the same filter-vs-
 * breakdown separation agent/lib/finding-evidence.js's own
 * buildQueryPageEvidenceRequest() already relies on for Search
 * Console's dimensionFilterGroups.
 *
 * @param {object} finding - a finding that passed isLeadEventEvidenceCandidate()
 * @param {object} [options]
 * @param {number} [options.days] - default 28, matches firstparty-fetch.js's own default
 */
function buildLeadEventEvidenceRequests(finding, options = {}) {
  const days = options.days || 28;
  const page = finding.pages[0];
  const landingPagePath = `/${page}`;

  const sessionContextRequest = {
    type: "ga4",
    findingKey: finding.key,
    scope: { type: "page", value: page },
    days,
    dimensions: ["landingPage"],
    metrics: ["sessions"],
    dimensionFilter: { filter: { fieldName: "landingPage", stringFilter: { matchType: "EXACT", value: landingPagePath } } },
    compareToPreviousPeriod: true,
    context: `Weekly lead-event refresh for "${finding.type}" on ${page} — total GA4 session volume to this landing page, for both the current and comparison period (traffic context for the paired event-count request).`,
  };

  const eventDetailRequest = {
    type: "ga4",
    findingKey: finding.key,
    scope: { type: "page", value: page },
    days,
    dimensions: ["eventName"],
    metrics: ["eventCount"],
    dimensionFilter: {
      andGroup: {
        expressions: [
          { filter: { fieldName: "landingPage", stringFilter: { matchType: "EXACT", value: landingPagePath } } },
          { filter: { fieldName: "eventName", inListFilter: { values: LEAD_EVENT_NAMES } } },
        ],
      },
    },
    compareToPreviousPeriod: true,
    context: `Weekly lead-event refresh for "${finding.type}" on ${page} — raw GA4 eventName+eventCount for this landing page's own confirmed lead events (${LEAD_EVENT_NAMES.join(
      ", "
    )}), current vs comparison period. Deliberately NOT the conversions/keyEvents metric — see lead-event-instrumentation.js's header.`,
  };

  return [sessionContextRequest, eventDetailRequest];
}

/**
 * True when `finding` needs a --refresh-lead-event-evidence fetch this
 * run: EITHER of the two required GA4 evidence shapes (landingPage
 * session-context, eventName event-detail) is missing or STALE for
 * this finding's key. Mirrors finding-evidence.js's own
 * freshlyEvidencedFindingKeys()/needsFindingEvidenceRefresh() freshness
 * discipline exactly — stale is treated as absent (eligible for
 * re-fetch), never permanently suppressed.
 * @param {object} finding
 * @param {object[]} entries - loaded first-party evidence entries
 * @param {Date} [now]
 */
function needsLeadEventEvidenceRefresh(finding, entries, now = new Date()) {
  const { computeFirstPartyFreshness } = require("./firstparty-evidence");
  let hasFreshSession = false;
  let hasFreshEvent = false;
  for (const e of entries || []) {
    if (e.source !== SOURCE || e.findingKey !== finding.key) continue;
    if (computeFirstPartyFreshness(e, now).status === "stale") continue;
    if (e.dimension === "landingPage") hasFreshSession = true;
    if (e.dimension === "eventName") hasFreshEvent = true;
  }
  return !(hasFreshSession && hasFreshEvent);
}

module.exports = {
  SOURCE,
  isLeadEventEvidenceCandidate,
  buildLeadEventEvidenceRequests,
  needsLeadEventEvidenceRefresh,
};
