// Site Improvement Agent, Phase 10 -- Curated Official Source Evidence
// intake. Mirrors agent/lib/firstparty-intake.js's loader discipline
// exactly: reads every committed evidence file under
// agent/research/local-sources/, re-validates each against
// local-source-evidence.js's makeLocalSourceEvidence() shape. Fails
// safe -- a missing directory, an empty one, or an individual malformed
// file are all treated as "no local-source evidence available," never a
// thrown error.
//
// UNLIKE firstparty-intake.js, this module does NOT attach anything to
// a finding or a rotation pick -- Phase 1 deliberately ties this
// evidence to no decision-relevant object at all (see
// agent/README.md's Phase 10 section on why: there is no rotation/
// finding integration yet, by design, so there is nothing to attach
// to). report.js surfaces the whole loaded list as its OWN, independent
// report section instead.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { makeLocalSourceEvidence } = require("./local-source-evidence");

const EVIDENCE_DIR = path.join(config.SITE_ROOT, "agent", "research", "local-sources");

function loadLocalSourceEvidence() {
  const entries = [];
  const warnings = [];

  if (!fs.existsSync(EVIDENCE_DIR)) {
    return { entries, warnings };
  }

  const files = fs.readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const fullPath = path.join(EVIDENCE_DIR, file);
    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        entries.push(makeLocalSourceEvidence(item));
      }
    } catch (e) {
      warnings.push(`agent/research/local-sources/${file}: ${e.message}`);
    }
  }

  return { entries, warnings };
}

module.exports = { loadLocalSourceEvidence, EVIDENCE_DIR };
