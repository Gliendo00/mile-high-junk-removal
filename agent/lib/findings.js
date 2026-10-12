// Site Improvement Agent — Finding factory.
//
// A Finding is the one structured unit every audit module emits and every
// consumer (risk classifier, runner, history, future CRM feed) reads. The
// shape is deliberately strict: every finding must carry `evidence`
// (concrete facts pulled from a scan, never invented), so nothing can
// become a finding just because it "sounds right" — see makeFinding's
// validation below.

let counter = 0;

function nextId(type) {
  counter += 1;
  return `${type}-${counter}`;
}

// A stable, content-derived key — unlike `id` (a per-run counter, never
// comparable across runs), `key` is the same across runs for "the same
// observation" (same type + same pages), so Phase 2's research layer can
// attach a researched answer today to the matching finding in next week's
// run without relying on any run-specific identifier.
function makeKey(type, pages) {
  return `${type}::${[...pages].sort().join(",")}`;
}

/**
 * @param {object} args
 * @param {string} args.type - stable machine-readable finding type, e.g. "broken-internal-link"
 * @param {string} args.summary - one-sentence human description of what was found
 * @param {string[]} args.pages - repo-relative file names this finding concerns
 * @param {object[]} args.evidence - concrete facts, e.g. [{file, field, value}]
 * @param {string} [args.recommendation] - what the agent suggests doing about it
 * @param {object} [args.action] - present only when a mechanical fix is available: {kind, apply(file-system)->result}
 */
function makeFinding(args) {
  if (!args || !args.type) throw new Error("finding requires a type");
  if (!args.summary) throw new Error(`finding ${args.type} requires a summary`);
  if (!Array.isArray(args.pages) || args.pages.length === 0) {
    throw new Error(`finding ${args.type} requires at least one page`);
  }
  if (!Array.isArray(args.evidence) || args.evidence.length === 0) {
    throw new Error(
      `finding ${args.type} requires non-empty evidence — findings may not be asserted without supporting data`
    );
  }
  return {
    id: nextId(args.type),
    key: makeKey(args.type, args.pages),
    type: args.type,
    summary: args.summary,
    pages: args.pages,
    evidence: args.evidence,
    recommendation: args.recommendation || null,
    autoFix: args.autoFix || null, // { kind, apply: (page) => {changed, before, after} }
    // risk classification is attached later by risk.js, research by
    // research-intake.js, and a decision by decision.js — keep this
    // factory focused only on "is this a well-evidenced observation".
  };
}

module.exports = { makeFinding, makeKey };
