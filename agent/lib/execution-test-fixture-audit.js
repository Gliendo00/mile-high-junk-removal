// Site Improvement Agent — Phase 14 execution-pipeline test-only audit.
//
// Exists SOLELY to let the Phase 14 execution engine
// (agent/lib/execute-proposal.js) be tested end-to-end against the real
// agent_proposals approve/execute pipeline, without ever touching a real
// finding type, a real page, or a real risk/decision rule.
//
// Why this is needed: every REAL finding type that carries a
// `rewrite-href` autoFix today (redirect-hop-internal-link,
// broken-internal-link-fixable — see link-audit.js) is risk.js's
// riskLevel:"low" + tier:"actionable", which classify() makes
// unconditionally autoApplyEligible. That routes it to decision
// APPLY_SAFE_FIX, which proposals-sync.js's needsOwnerReview() excludes
// from agent_proposals entirely (see that module's own header). So there
// is today no real finding that is BOTH synced to agent_proposals AND
// carries a supported autoFix — execute-proposal.js's own header already
// says as much. Phase 14 has no real finding it could ever be tested
// against.
//
// This module closes that gap with one narrow, self-contained,
// self-expiring fixture: it reads exactly one dedicated file
// (agent/test-fixtures/execution-pipeline-test.html — not a scanned
// marketing page, not linked, not indexed, not in any sitemap) and, only
// if that file still contains the exact sentinel href below, emits
// exactly one finding of a brand-new type
// ("execution-pipeline-test-fixture") that risk.js classifies as
// riskLevel:"medium" (see that file's matching RULES entry) — NOT "low"
// — so it is NEVER autoApplyEligible despite carrying an autoFix, and
// decision.js resolves it to PROPOSE_CHANGE exactly like a real
// human-reviewed proposal. Once the fix is actually applied (the
// sentinel href rewritten), this emits nothing at all on every
// subsequent run — nothing to clean up afterward.
//
// Never touches any real page, any real finding type, or any real risk
// rule. Safe to delete this file, risk.js's one matching RULES entry,
// its require() in runner.js, and the fixture file itself at any time,
// with zero effect on any other finding.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { makeFinding } = require("./findings");

const FIXTURE_FILE = "agent/test-fixtures/execution-pipeline-test.html";
const SENTINEL_HREF = "/execution-test-placeholder";
const FIXED_HREF = "/execution-test-placeholder-fixed";

function auditExecutionTestFixture() {
  const fullPath = path.join(config.SITE_ROOT, FIXTURE_FILE);
  if (!fs.existsSync(fullPath)) return [];

  const html = fs.readFileSync(fullPath, "utf8");
  const needle = `href="${SENTINEL_HREF}"`;
  if (!html.includes(needle)) return [];

  return [
    makeFinding({
      type: "execution-pipeline-test-fixture",
      summary: `Test fixture ${FIXTURE_FILE} still contains its placeholder link ("${SENTINEL_HREF}") — a Phase 14 execution-pipeline test proposal, not a real site issue.`,
      pages: [FIXTURE_FILE],
      evidence: [{ file: FIXTURE_FILE, field: "testSentinelHref", value: SENTINEL_HREF }],
      recommendation: `Test-only: rewrite the sentinel href in ${FIXTURE_FILE} from "${SENTINEL_HREF}" to "${FIXED_HREF}" to exercise the Phase 14 execution engine end-to-end.`,
      autoFix: {
        kind: "rewrite-href",
        file: FIXTURE_FILE,
        from: SENTINEL_HREF,
        to: FIXED_HREF,
      },
    }),
  ];
}

module.exports = { auditExecutionTestFixture, FIXTURE_FILE, SENTINEL_HREF, FIXED_HREF };
