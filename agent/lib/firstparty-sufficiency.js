// Site Improvement Agent, Phase 12 — minimum-data-sufficiency
// classification for first-party signals.
//
// This codebase has already, repeatedly, rejected invented 0-100
// confidence/health scores (see agent/lib/report.js's own header: "NOT
// a 0-100 site health score"). This module applies that same discipline
// to first-party signals: a DISCRETE, named sufficiency bucket
// ("insufficient"/"limited"/"sufficient"), computed from a real observed
// count against a documented, centralized, openly-labeled-as-arbitrary
// threshold pair -- never a numeric score, never hidden per-detector
// magic numbers scattered across firstparty-signals.js.
//
// "insufficient" means a detector MUST return null (no signal) -- same
// rule agent/lib/firstparty-signals.js's existing deriveQueryPageMismatchSignal()
// already applies to a zero-row result, generalized. "limited" still
// produces a signal, but the signal's own text must say the underlying
// volume is thin -- never silently presented with the same confidence
// as "sufficient". Evidence/report visibility is NEVER gated by this
// module -- report.firstPartyEvidence already shows every fetch
// regardless of row count (see report.js's own "zero evidence is a
// valid, ordinary result" rule); this module only gates SIGNAL emission,
// never evidence visibility, so "insufficient data" can never be
// confused with "nothing was checked."

const SUFFICIENCY_LEVELS = ["insufficient", "limited", "sufficient"];

// Centralized, inspectable, documented as conservative ENGINEERING
// DEFAULTS -- not business facts, same explicit framing
// firstparty-evidence.js's FRESHNESS_WINDOWS_DAYS already uses. Keyed by
// a short, stable "metric family" name each signal detector declares
// for itself (never re-derived ad hoc per detector).
const SUFFICIENCY_THRESHOLDS = {
  // search-visibility-change / query-visibility-shift: combined
  // impressions across BOTH the current and previous window. Below 10,
  // a single-digit impression count makes any CTR/position movement
  // almost certainly noise on a low-traffic property (this site's own
  // real evidence files show mostly zero-row results today).
  "gsc-impressions": { insufficient: 10, limited: 50 },
  // lead-event-landing-page-delta: combined GA4 sessions to the
  // landing page across both windows. Below 5, an event-count delta is
  // just as likely to be sampling noise as a real change.
  "ga4-sessions": { insufficient: 5, limited: 20 },
};

/**
 * @param {number} combinedValue - the SAME real observed count a
 *   detector is about to base a signal on (e.g. combined impressions,
 *   combined sessions) -- never a derived/normalized score.
 * @param {string} family - one of SUFFICIENCY_THRESHOLDS' own keys
 * @returns {"insufficient"|"limited"|"sufficient"}
 */
function classifySufficiency(combinedValue, family) {
  const thresholds = SUFFICIENCY_THRESHOLDS[family];
  if (!thresholds) {
    throw new Error(`firstparty-sufficiency.js: unknown metric family "${family}" -- add it to SUFFICIENCY_THRESHOLDS explicitly, never fall back to a guessed default`);
  }
  const value = typeof combinedValue === "number" && !Number.isNaN(combinedValue) ? combinedValue : 0;
  if (value < thresholds.insufficient) return "insufficient";
  if (value < thresholds.limited) return "limited";
  return "sufficient";
}

module.exports = { SUFFICIENCY_LEVELS, SUFFICIENCY_THRESHOLDS, classifySufficiency };
