// Site Improvement Agent, Phase 5 — completed-job evidence intake.
//
// Wires up agent/lib/business-context.js's fromCompletedBooking()/
// redactForPublication(), which existed since Phase 3 but, per its own
// header, was "completely unwired — nothing in runner.js or anywhere else
// in production code calls it." The offline runner still has no Supabase
// access by design (see agent/README.md) and this module does not change
// that: it never queries Supabase itself.
//
// Instead, this mirrors research-intake.js's existing pattern exactly:
// whoever DOES have real Supabase access (a Claude-assisted session, or a
// future small script) pulls recent completed bookings, maps each through
// business-context.fromCompletedBooking() (never hand-rolls its own
// redaction), and writes the ALREADY-REDACTED result as one JSON file
// under agent/research/completed-jobs/*.json. This module only ever reads
// that directory back — offline, no network, same as every other intake
// step in this agent.
//
// Defense in depth: even though every file here is supposed to already be
// publication-safe (it's the OUTPUT of redactForPublication()), this
// loader re-validates each entry only contains allowlisted fields before
// trusting it — a hand-edited or stale file can never smuggle a private
// field back in just because it's sitting in this directory.
//
// This is EVIDENCE for the weekly research rotation to weigh (see
// research-rotation.js) — never a trigger to publish anything by itself,
// and never wired into the mechanical daily audits' finding-producing
// logic (which would risk the Finding.key stability issue documented in
// research-intake.js's own header).

const fs = require("fs");
const path = require("path");
const { PUBLICATION_SAFE_FIELDS, isPrivateFieldName } = require("./business-context");

const DEFAULT_DIR = path.join(__dirname, "..", "research", "completed-jobs");

function isSafeEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  for (const key of Object.keys(entry)) {
    if (!PUBLICATION_SAFE_FIELDS.has(key)) return false;
    if (isPrivateFieldName(key)) return false; // belt-and-suspenders, mirrors business-context.js
  }
  return true;
}

/**
 * Reads every *.json file under agent/research/completed-jobs/ (or
 * `dir`), keeping only entries that pass the publication-safe field
 * check. Never throws — a missing directory, empty directory, or a
 * malformed/unsafe file all degrade to being skipped (with a warning),
 * exactly like research-intake.js's loadResearchResults().
 */
function loadCompletedJobEvidence(dir = DEFAULT_DIR) {
  const warnings = [];
  if (!fs.existsSync(dir)) {
    return { evidence: [], warnings };
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const evidence = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (isSafeEntry(entry)) {
          evidence.push(entry);
        } else {
          warnings.push(`${file}: skipped an entry with a field outside the publication-safe allowlist`);
        }
      }
    } catch (e) {
      warnings.push(`${file}: ${e && e.message ? e.message : String(e)}`);
    }
  }
  return { evidence, warnings };
}

// Aggregates safe evidence entries into simple per-city counts — exactly
// the kind of coarse signal research-rotation.js's scoring can use
// ("several real jobs mention X in city Y"), with nothing more granular
// (no dates, no counts of counts, no per-job detail) ever exposed beyond
// city/serviceType tallies.
function summarizeByCity(evidenceEntries) {
  const byCity = {};
  for (const entry of evidenceEntries) {
    if (!entry.city) continue;
    byCity[entry.city] = (byCity[entry.city] || 0) + 1;
  }
  return byCity;
}

module.exports = { loadCompletedJobEvidence, summarizeByCity, DEFAULT_DIR };
