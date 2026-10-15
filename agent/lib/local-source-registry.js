// Site Improvement Agent, Phase 10 -- curated local-source registry
// loader/validator.
//
// Loads agent/context/local-source-registry.json -- a small,
// human-maintained, human-VERIFIED list of official local sources
// agent/lib/local-source-fetch.js is permitted to fetch. Mirrors
// agent/lib/business-profile.js's own loader discipline exactly: one
// place reads the file, validates its shape, and exposes narrow
// accessors -- no other module should require() the JSON file
// directly.
//
// THIS MODULE NEVER WRITES TO THE REGISTRY, and nothing in this codebase
// does: .github/scripts/safe-commit.js's allowlist deliberately excludes
// agent/context/** entirely (same treatment business-profile.json
// already gets). The unattended runner can READ this file to decide
// what it may fetch, but can never autonomously add, edit, or remove an
// entry -- every entry requires a human (or Claude session) to have
// actually, manually verified the URL and its robots.txt behavior; see
// each entry's own humanVerifiedAt/verificationNotes fields.

const fs = require("fs");
const path = require("path");
const { SOURCE_TYPES, TEMPORALITY_VALUES } = require("./research");

const REGISTRY_PATH = path.join(__dirname, "..", "context", "local-source-registry.json");

let cached = null;

function assertNonEmptyString(value, fieldName, entryId) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`local-source-registry entry "${entryId || "?"}" requires a non-empty string for "${fieldName}"`);
  }
}

/**
 * Validates one registry entry's shape AND its internal consistency:
 * the entry's own declared `domain` is the SOLE authority on which host
 * its `url` may point to -- a malformed entry can never claim an
 * "official-government"/any authority classification for a URL that
 * doesn't actually belong to its own declared domain. Exact host match
 * only (apex or "www." of the declared domain) -- no subdomain
 * wildcarding, no "ends with" matching that could be tricked by a
 * similarly-named host.
 */
function validateEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("local-source-registry entry must be an object");
  }
  assertNonEmptyString(entry.id, "id", entry.id);
  assertNonEmptyString(entry.locality, "locality", entry.id);
  assertNonEmptyString(entry.domain, "domain", entry.id);
  assertNonEmptyString(entry.url, "url", entry.id);
  assertNonEmptyString(entry.topic, "topic", entry.id);
  assertNonEmptyString(entry.humanVerifiedAt, "humanVerifiedAt", entry.id);

  if (!SOURCE_TYPES.includes(entry.authorityClass)) {
    throw new Error(`local-source-registry entry "${entry.id}" authorityClass must be one of ${SOURCE_TYPES.join(", ")}, got "${entry.authorityClass}"`);
  }
  if (!TEMPORALITY_VALUES.includes(entry.expectedTemporality)) {
    throw new Error(`local-source-registry entry "${entry.id}" expectedTemporality must be one of ${TEMPORALITY_VALUES.join(", ")}, got "${entry.expectedTemporality}"`);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(entry.url);
  } catch (e) {
    throw new Error(`local-source-registry entry "${entry.id}" has an unparsable url: "${entry.url}"`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`local-source-registry entry "${entry.id}" url must be https, got "${parsedUrl.protocol}"`);
  }
  if (parsedUrl.hostname !== entry.domain && parsedUrl.hostname !== `www.${entry.domain}`) {
    throw new Error(
      `local-source-registry entry "${entry.id}" url host "${parsedUrl.hostname}" does not match its own declared domain "${entry.domain}" -- an entry's authorityClass/domain claim must match the exact host its url points to`
    );
  }
}

function loadRegistry(registryPath = REGISTRY_PATH) {
  if (cached && registryPath === REGISTRY_PATH) return cached;
  const raw = fs.readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error('local-source-registry.json must contain an "entries" array');
  }
  const seenIds = new Set();
  for (const entry of parsed.entries) {
    validateEntry(entry);
    if (seenIds.has(entry.id)) {
      throw new Error(`local-source-registry.json has a duplicate entry id "${entry.id}"`);
    }
    seenIds.add(entry.id);
  }
  if (registryPath === REGISTRY_PATH) cached = parsed;
  return parsed;
}

function getEntries(registry = loadRegistry()) {
  return registry.entries;
}

/**
 * The ONLY lookup fetch-side code should ever use. Returns `null` for an
 * unknown id -- callers must refuse to fetch, never fall back to
 * treating the id itself (or any other caller-supplied value) as a
 * literal URL. This is the structural guarantee that makes "arbitrary
 * URL injection" impossible: a fetch can only ever target a `url` this
 * registry itself already declared, never one supplied at call time.
 */
function getEntryById(id, registry = loadRegistry()) {
  return registry.entries.find((e) => e.id === id) || null;
}

module.exports = { REGISTRY_PATH, loadRegistry, getEntries, getEntryById, validateEntry };
