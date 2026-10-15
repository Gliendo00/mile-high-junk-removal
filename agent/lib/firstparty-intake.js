// Site Improvement Agent, Phase 6 — first-party evidence intake.
//
// Reads every committed evidence file under agent/research/firstparty/
// (one JSON array per targeted fetch — see firstparty-fetch.js's
// writeFirstPartyEvidence()), re-validates each entry against
// firstparty-evidence.js's makeFirstPartyEvidence() shape, and attaches
// matching entries to the findings they inform (matched by Finding.key —
// same mechanism as research-intake.js's attachResearch()). Fails safe:
// a missing directory, an empty one, or an individual malformed file are
// all treated as "no first-party evidence available" — never a thrown
// error, never a run taken down by a stray malformed file.
//
// STRUCTURAL SAFETY RULE — this is the half of the "metrics are signals,
// not decisions" boundary that lives in code, not just discipline:
// agent/runner.js's gatherFindings() calls this ONLY *after*
// decision.js's decideAll() has already produced every finding's
// `.decision` (see runner.js's own comment at that call site). So even
// though this module attaches data onto the same finding objects
// decision.js read moments earlier, decision.js's decide() function
// itself has no parameter, destructure, or property access anywhere in
// its body that reads `.firstPartyEvidence` — nothing here could change
// a decision even if the call order were ever accidentally reversed.
// tests/agent-firstparty-safety.test.js proves this directly: decide()
// produces byte-identical output for two findings that differ ONLY in
// whether `.firstPartyEvidence` is populated.
//
// `finding.firstPartyEvidence` exists purely for REPORT/PROVENANCE
// display (agent/lib/report.js's firstPartyEvidence summary, and
// admin/agent-reports.js's detail view) — "here is the first-party
// evidence a human/orchestrator gathered while investigating this
// finding," never "here is what changed the finding's outcome."

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { makeFirstPartyEvidence } = require("./firstparty-evidence");

const EVIDENCE_DIR = path.join(config.SITE_ROOT, "agent", "research", "firstparty");

function loadFirstPartyEvidence() {
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
        entries.push(makeFirstPartyEvidence(item));
      }
    } catch (e) {
      warnings.push(`agent/research/firstparty/${file}: ${e.message}`);
    }
  }

  return { entries, warnings };
}

/**
 * Attaches any matching first-party evidence to each finding's
 * `.firstPartyEvidence` array (always an array, even when empty). Entries
 * with no `findingKey` are informational-only and are never attached to
 * anything — see firstparty-evidence.js's header on that field being
 * optional.
 *
 * MUST be called after decision.js's decideAll() in any pipeline that
 * wants the structural guarantee described in this file's header to
 * actually hold for THIS call (decision.js itself never reads this field
 * regardless of order, but calling it after is what makes the ordering
 * itself proof, not just an unused capability).
 */
function attachFirstPartyEvidence(findings, loaded) {
  const { entries, warnings } = loaded || loadFirstPartyEvidence();
  const byKey = new Map();
  for (const e of entries) {
    if (!e.findingKey) continue;
    const list = byKey.get(e.findingKey) || [];
    list.push(e);
    byKey.set(e.findingKey, list);
  }

  for (const finding of findings) {
    finding.firstPartyEvidence = byKey.get(finding.key) || [];
  }

  return { findings, warnings };
}

/**
 * Phase 7B — mirrors attachFirstPartyEvidence() exactly, but matches by
 * `rotationSlug` instead of `findingKey`: a weekly rotation pick
 * (agent/lib/research-rotation.js's computePriorities() shape) is never
 * a Finding, so it needed its own, independent key space rather than
 * overloading `findingKey` — see firstparty-evidence.js's header on
 * why the two fields coexist without conflict (an evidence entry has
 * exactly one of them set, never both, by construction of whoever wrote
 * it: agent/lib/rotation-evidence.js's buildRotationEvidenceRequest()
 * only ever sets `rotationSlug`).
 *
 * Same fail-safe contract as attachFirstPartyEvidence(): every pick
 * gets a `.firstPartyEvidence` array, even when empty; a missing/empty/
 * malformed evidence directory degrades to "nothing attached," never a
 * thrown error.
 */
function attachRotationEvidence(picks, loaded) {
  const { entries, warnings } = loaded || loadFirstPartyEvidence();
  const bySlug = new Map();
  for (const e of entries) {
    if (!e.rotationSlug) continue;
    const list = bySlug.get(e.rotationSlug) || [];
    list.push(e);
    bySlug.set(e.rotationSlug, list);
  }

  for (const pick of picks) {
    pick.firstPartyEvidence = bySlug.get(pick.slug) || [];
  }

  return { picks, warnings };
}

module.exports = { loadFirstPartyEvidence, attachFirstPartyEvidence, attachRotationEvidence, EVIDENCE_DIR };
