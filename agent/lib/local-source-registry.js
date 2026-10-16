// Site Improvement Agent, Phase 10 -- curated local-source registry
// loader/validator. Phase 11A extends this with multi-city relevance
// (`relevantCities`) and a structural jurisdiction-safety guarantee
// (`eligibilityNotes`) -- see this file's validateEntry() header below.
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
const { getAllServiceAreaCities } = require("./business-profile");

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
 *
 * Phase 11A -- JURISDICTION SAFETY. `relevantCities` is GEOGRAPHIC
 * RELEVANCE ONLY -- it says "this source's own jurisdiction/subject
 * matter concerns these service-area cities," and nothing more. It is
 * never read anywhere in this codebase as "every resident of each city
 * is eligible for whatever this source describes" (see
 * agent/lib/local-source-candidates.js's header, which names its own
 * functions accordingly). Each slug must be a canonical service-area
 * city from agent/context/business-profile.json (business-profile.js's
 * getAllServiceAreaCities()) -- an unknown slug is rejected outright,
 * never silently accepted as a new, unvetted locality. `eligibilityNotes`
 * is a second, REQUIRED, human-authored field (same discipline as
 * local-source-evidence.js's required `limitations`) that must state
 * what this source does and does NOT establish about who actually
 * qualifies for whatever it describes -- a registry entry claiming
 * geographic relevance with no stated eligibility boundary is exactly
 * the mechanical over-inference this phase exists to prevent, so it is
 * refused at validation time, not left to convention.
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
  assertNonEmptyString(entry.eligibilityNotes, "eligibilityNotes", entry.id);

  if (!SOURCE_TYPES.includes(entry.authorityClass)) {
    throw new Error(`local-source-registry entry "${entry.id}" authorityClass must be one of ${SOURCE_TYPES.join(", ")}, got "${entry.authorityClass}"`);
  }
  if (!TEMPORALITY_VALUES.includes(entry.expectedTemporality)) {
    throw new Error(`local-source-registry entry "${entry.id}" expectedTemporality must be one of ${TEMPORALITY_VALUES.join(", ")}, got "${entry.expectedTemporality}"`);
  }

  if (!Array.isArray(entry.relevantCities) || entry.relevantCities.length === 0) {
    throw new Error(`local-source-registry entry "${entry.id || "?"}" requires a non-empty "relevantCities" array of canonical service-area city slugs`);
  }
  const validSlugs = new Set(getAllServiceAreaCities().map((c) => c.slug));
  for (const slug of entry.relevantCities) {
    if (typeof slug !== "string" || !validSlugs.has(slug)) {
      throw new Error(
        `local-source-registry entry "${entry.id}" relevantCities contains "${slug}" -- not a canonical service-area city slug in agent/context/business-profile.json; unknown cities are rejected, never silently accepted`
      );
    }
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

/**
 * Phase 11A -- duplicate SOURCE/TOPIC identity prevention: the same
 * curated page must never appear twice (an exact-url duplicate), and
 * the same domain must never be registered twice for the same `topic`
 * (two differently-worded entries that actually represent the same
 * real-world source/subject pair) -- either would make candidate
 * selection ambiguous about which entry is "the" curated source for a
 * location/topic. Entry-id uniqueness (already enforced) is a
 * different, narrower guarantee (no two entries share a KEY) --
 * this is about the underlying real-world identity they represent.
 */
function assertNoDuplicateSourceIdentity(entries) {
  const seenIds = new Set();
  const seenUrls = new Set();
  const seenSourceTopics = new Set();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`local-source-registry.json has a duplicate entry id "${entry.id}"`);
    }
    seenIds.add(entry.id);

    if (seenUrls.has(entry.url)) {
      throw new Error(`local-source-registry.json has a duplicate url "${entry.url}" (entry "${entry.id}") -- the same page must never be registered twice`);
    }
    seenUrls.add(entry.url);

    const sourceTopicKey = `${entry.domain}::${entry.topic}`;
    if (seenSourceTopics.has(sourceTopicKey)) {
      throw new Error(
        `local-source-registry.json has a duplicate source/topic identity: domain "${entry.domain}" + topic "${entry.topic}" (entry "${entry.id}") -- the same source/topic pair must never be registered twice`
      );
    }
    seenSourceTopics.add(sourceTopicKey);
  }
}

function loadRegistry(registryPath = REGISTRY_PATH) {
  if (cached && registryPath === REGISTRY_PATH) return cached;
  const raw = fs.readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error('local-source-registry.json must contain an "entries" array');
  }
  for (const entry of parsed.entries) {
    validateEntry(entry);
  }
  assertNoDuplicateSourceIdentity(parsed.entries);
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
