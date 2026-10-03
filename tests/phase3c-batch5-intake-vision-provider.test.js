// Local, offline test harness for Batch 5's vision-provider adapter
// (api/_lib/intake-vision-provider.js). See
// docs/phase-3/batch5-screenshot-intake-proposal.md §6.
//
// This never touches the real network or a real OpenAI account.
// global.fetch is stubbed per-test (same approach as
// tests/phase3b-step4a2-customer-identity.test.js /
// tests/phase1-api.test.js's Resend stubbing) so every test controls
// exactly what "OpenAI" returns.
//
// Scope: proves the adapter (a) builds a correct OpenAI vision + strict
// JSON-schema request, (b) normalizes a valid response into the documented
// shape, (c) fails safely and identically (a generic Error, never a leaked
// provider detail or a crash) on every failure mode, and (d) never does any
// matching/dedup/booking-decision work itself — it only maps the model's
// JSON into the normalized extraction shape.
//
// Run with:  node tests/phase3c-batch5-intake-vision-provider.test.js
// Exits with a non-zero code if any assertion fails.

const assert = require("assert");

let fetchCalls = [];
let fetchImpl = null;
global.fetch = function (url, opts) {
  fetchCalls.push({ url: url, opts: opts });
  return fetchImpl(url, opts);
};

function okFetch(bodyObj) {
  return function () {
    return Promise.resolve({
      ok: true,
      json: function () {
        return Promise.resolve(bodyObj);
      },
    });
  };
}

function openAiEnvelope(contentObj) {
  return { choices: [{ message: { content: JSON.stringify(contentObj) } }] };
}

function fullValidExtraction(overrides) {
  const fieldKeys = [
    "firstName",
    "lastName",
    "phone",
    "email",
    "address",
    "city",
    "state",
    "zip",
    "serviceType",
    "serviceDetails",
    "itemDescription",
    "estimatedLoadSize",
    "quotedAmount",
    "date",
    "appointmentTime",
    "schedulingStatus",
    "internalNotes",
    "photosReferenced",
    "clientConstraints",
  ];
  const fields = {};
  fieldKeys.forEach((k) => {
    fields[k] = { value: null, confidence: "missing", sourceIndex: null };
  });
  fields.firstName = { value: "Jamie", confidence: "confirmed", sourceIndex: 0 };
  fields.phone = { value: "303-555-0100", confidence: "confirmed", sourceIndex: 0 };
  return Object.assign(
    {
      fields: fields,
      classification: "lead_only",
      classificationConfidence: "likely",
      conflicts: [],
    },
    overrides || {}
  );
}

// Re-require fresh each time env vars change, since the module reads
// process.env at call time (not at require time) — no cache-busting needed,
// but kept isolated in one require at the top for clarity.
const { extractFromScreenshots, FIELD_KEYS } = require("../api/_lib/intake-vision-provider.js");

const SAMPLE_IMAGES = [{ base64: "ZmFrZS1pbWFnZS1ieXRlcw==", mimeType: "image/png" }];

function resetEnv() {
  delete process.env.OPENAI_API_KEY;
  delete process.env.INTAKE_VISION_PROVIDER;
  delete process.env.INTAKE_VISION_MODEL;
  delete process.env.VERCEL_ENV;
  fetchCalls = [];
  fetchImpl = okFetch(openAiEnvelope(fullValidExtraction()));
}

const registered = [];
function test(name, fn) {
  registered.push({ name, fn });
}

test("no OPENAI_API_KEY configured -> rejects with a generic error, never calls fetch", async () => {
  resetEnv();
  await assert.rejects(() => extractFromScreenshots({ images: SAMPLE_IMAGES }));
  assert.strictEqual(fetchCalls.length, 0, "must never call out to OpenAI without a configured key");
});

test("no images provided -> rejects without calling fetch", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  await assert.rejects(() => extractFromScreenshots({ images: [] }));
  assert.strictEqual(fetchCalls.length, 0);
});

test("unknown INTAKE_VISION_PROVIDER -> rejects with a generic error, never calls fetch", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.INTAKE_VISION_PROVIDER = "some-future-provider";
  await assert.rejects(() => extractFromScreenshots({ images: SAMPLE_IMAGES }));
  assert.strictEqual(fetchCalls.length, 0);
});

test("builds the OpenAI request: correct URL, auth header, model default, image_url data URIs, strict json_schema response_format", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test-key-12345";
  await extractFromScreenshots({ images: SAMPLE_IMAGES });

  assert.strictEqual(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.strictEqual(call.url, "https://api.openai.com/v1/chat/completions");
  assert.strictEqual(call.opts.method, "POST");
  assert.strictEqual(call.opts.headers["Authorization"], "Bearer sk-test-key-12345");

  const body = JSON.parse(call.opts.body);
  assert.strictEqual(body.model, "gpt-4o", "must default to gpt-4o when INTAKE_VISION_MODEL is unset");
  assert.strictEqual(body.messages[0].role, "system");
  assert.strictEqual(body.messages[1].role, "user");
  const imageParts = body.messages[1].content.filter((c) => c.type === "image_url");
  assert.strictEqual(imageParts.length, 1);
  assert.strictEqual(imageParts[0].image_url.url, "data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==");

  assert.strictEqual(body.response_format.type, "json_schema");
  assert.strictEqual(body.response_format.json_schema.strict, true);
  assert.strictEqual(body.response_format.json_schema.schema.additionalProperties, false);
  FIELD_KEYS.forEach((key) => {
    assert.ok(body.response_format.json_schema.schema.properties.fields.properties[key], "schema must include field: " + key);
  });
});

test("INTAKE_VISION_MODEL override is respected", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.INTAKE_VISION_MODEL = "gpt-4o-mini";
  await extractFromScreenshots({ images: SAMPLE_IMAGES });
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.strictEqual(body.model, "gpt-4o-mini");
});

test("multiple screenshots are all included, in order, as separate image_url parts", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  const images = [
    { base64: "aaaa", mimeType: "image/jpeg" },
    { base64: "bbbb", mimeType: "image/webp" },
  ];
  await extractFromScreenshots({ images: images });
  const body = JSON.parse(fetchCalls[0].opts.body);
  const imageParts = body.messages[1].content.filter((c) => c.type === "image_url");
  assert.strictEqual(imageParts.length, 2);
  assert.strictEqual(imageParts[0].image_url.url, "data:image/jpeg;base64,aaaa");
  assert.strictEqual(imageParts[1].image_url.url, "data:image/webp;base64,bbbb");
});

test("hintContext, when provided, is included in the user text; omitted entirely when not provided", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  await extractFromScreenshots({ images: SAMPLE_IMAGES, hintContext: "  this client called about a dumpster  " });
  let body = JSON.parse(fetchCalls[0].opts.body);
  const textPart = body.messages[1].content.find((c) => c.type === "text");
  assert.ok(textPart.text.includes("this client called about a dumpster"));

  fetchCalls = [];
  await extractFromScreenshots({ images: SAMPLE_IMAGES });
  body = JSON.parse(fetchCalls[0].opts.body);
  const textPart2 = body.messages[1].content.find((c) => c.type === "text");
  assert.ok(!textPart2.text.includes("Additional context"));
});

test("a fully-populated valid response is normalized into the documented shape", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  fetchImpl = okFetch(
    openAiEnvelope(
      fullValidExtraction({
        classification: "quote_discussion",
        classificationConfidence: "confirmed",
        conflicts: [
          {
            field: "date",
            values: [
              { value: "Wednesday", sourceIndex: 0 },
              { value: "Thursday", sourceIndex: 1 },
            ],
          },
        ],
      })
    )
  );
  const result = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  assert.strictEqual(result.classification, "quote_discussion");
  assert.strictEqual(result.classificationConfidence, "confirmed");
  assert.deepStrictEqual(result.fields.firstName, { value: "Jamie", confidence: "confirmed", sourceIndex: 0 });
  assert.deepStrictEqual(result.fields.email, { value: null, confidence: "missing", sourceIndex: null });
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].field, "date");
  assert.strictEqual(result.conflicts[0].values.length, 2);
});

test("every declared field key is present in the result even if the model omits some entirely", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  fetchImpl = okFetch(openAiEnvelope({ fields: { firstName: { value: "Alex", confidence: "confirmed", sourceIndex: 0 } }, classification: "lead_only", classificationConfidence: "likely", conflicts: [] }));
  const result = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  FIELD_KEYS.forEach((key) => {
    assert.ok(result.fields[key], "missing field in normalized result: " + key);
    assert.ok(["value", "confidence", "sourceIndex"].every((k) => k in result.fields[key]));
  });
  assert.strictEqual(result.fields.firstName.value, "Alex");
  assert.strictEqual(result.fields.lastName.value, null);
  assert.strictEqual(result.fields.lastName.confidence, "missing");
});

test("an unrecognized classification/confidence string is normalized to a safe default, never passed through raw", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  fetchImpl = okFetch(openAiEnvelope(fullValidExtraction({ classification: "definitely_booked_trust_me", classificationConfidence: "100%" })));
  const result = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  assert.strictEqual(result.classification, "unclear");
  assert.strictEqual(result.classificationConfidence, "uncertain");
});

test("a field with an unrecognized confidence string still carries its value through, defaulted to 'missing' only when value is null", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  const extraction = fullValidExtraction();
  extraction.fields.serviceType = { value: "junk removal", confidence: "very sure", sourceIndex: 0 };
  fetchImpl = okFetch(openAiEnvelope(extraction));
  const result = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  assert.strictEqual(result.fields.serviceType.value, "junk removal");
  assert.strictEqual(result.fields.serviceType.confidence, "missing", "an unrecognized confidence string is not trusted/passed through raw");
});

test("malformed conflict entries are dropped rather than crashing the whole extraction", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  fetchImpl = okFetch(
    openAiEnvelope(
      fullValidExtraction({
        conflicts: [
          { field: "not_a_real_field", values: [{ value: "x", sourceIndex: 0 }] },
          { field: "date", values: "not-an-array" },
          { field: "date", values: [{ value: "Wednesday", sourceIndex: 0 }] },
        ],
      })
    )
  );
  const result = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].field, "date");
});

test("non-OK HTTP response from OpenAI -> generic error, raw provider error body never leaked", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  fetchImpl = function () {
    return Promise.resolve({
      ok: false,
      status: 401,
      json: function () {
        return Promise.resolve({ error: { message: "Incorrect API key provided: sk-test" } });
      },
    });
  };
  let caught = null;
  try {
    await extractFromScreenshots({ images: SAMPLE_IMAGES });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.ok(!caught.message.includes("sk-test"), "must never leak the raw OpenAI error/key into the thrown message");
});

test("a network error calling OpenAI -> generic error, never an unhandled rejection", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  fetchImpl = function () {
    return Promise.reject(new Error("ECONNRESET actual network detail"));
  };
  let caught = null;
  try {
    await extractFromScreenshots({ images: SAMPLE_IMAGES });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.ok(!caught.message.includes("ECONNRESET"), "must not leak the raw network error detail");
});

test("the model returning non-JSON content -> generic error, not a crash", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  fetchImpl = okFetch({ choices: [{ message: { content: "Sure! Here's the info you wanted: ..." } }] });
  await assert.rejects(() => extractFromScreenshots({ images: SAMPLE_IMAGES }));
});

test("an unexpected OpenAI response shape (no choices[0].message.content) -> generic error, not a crash", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  fetchImpl = okFetch({ unexpected: "shape" });
  await assert.rejects(() => extractFromScreenshots({ images: SAMPLE_IMAGES }));
});

test("the API key never appears anywhere in a thrown error's message, across every failure mode", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-super-secret-value";
  fetchImpl = function () {
    return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({ error: "boom" }); } });
  };
  let caught = null;
  try {
    await extractFromScreenshots({ images: SAMPLE_IMAGES });
  } catch (err) {
    caught = err;
  }
  assert.ok(!caught.message.includes("sk-super-secret-value"));
});

// ---------------------------------------------------------------------
// Mock provider (INTAKE_VISION_PROVIDER=mock) — Preview/test only.
// ---------------------------------------------------------------------
test("mock provider: never calls fetch and needs no OPENAI_API_KEY", async () => {
  resetEnv();
  process.env.INTAKE_VISION_PROVIDER = "mock";
  const result = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  assert.strictEqual(fetchCalls.length, 0, "mock must never touch the network");
  assert.ok(result);
});

test("mock provider: returns the same deterministic result across repeated calls", async () => {
  resetEnv();
  process.env.INTAKE_VISION_PROVIDER = "mock";
  const r1 = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  const r2 = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  assert.deepStrictEqual(r1, r2);
});

test("mock provider: result matches the normalized shape (every FIELD_KEYS key present, valid classification/confidence)", async () => {
  resetEnv();
  process.env.INTAKE_VISION_PROVIDER = "mock";
  const result = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  FIELD_KEYS.forEach((key) => {
    assert.ok(result.fields[key], "missing field: " + key);
    assert.ok(["value", "confidence", "sourceIndex"].every((k) => k in result.fields[key]));
  });
  assert.strictEqual(result.fields.firstName.value, "Mock");
  assert.strictEqual(result.fields.phone.value, "(303) 555-0199");
  assert.strictEqual(result.classification, "lead_only");
  assert.strictEqual(Array.isArray(result.conflicts), true);
});

test("mock provider: a single screenshot produces no conflicts; more than one produces a date conflict (exercises the Conflicts UI)", async () => {
  resetEnv();
  process.env.INTAKE_VISION_PROVIDER = "mock";
  const single = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  assert.strictEqual(single.conflicts.length, 0);

  const multi = await extractFromScreenshots({ images: [SAMPLE_IMAGES[0], SAMPLE_IMAGES[0]] });
  assert.strictEqual(multi.conflicts.length, 1);
  assert.strictEqual(multi.conflicts[0].field, "date");
  assert.strictEqual(multi.conflicts[0].values.length, 2);
});

test("mock provider: refuses outright when VERCEL_ENV=production, regardless of how INTAKE_VISION_PROVIDER got set to mock", async () => {
  resetEnv();
  process.env.INTAKE_VISION_PROVIDER = "mock";
  process.env.VERCEL_ENV = "production";
  await assert.rejects(() => extractFromScreenshots({ images: SAMPLE_IMAGES }));
  assert.strictEqual(fetchCalls.length, 0);
});

test("a failing/unconfigured openai provider NEVER silently falls back to the mock's deterministic output", async () => {
  resetEnv();
  // INTAKE_VISION_PROVIDER left unset -> defaults to "openai" per the file's
  // own contract; OPENAI_API_KEY also left unset -> must reject, not quietly
  // hand back mock's "Mock"/"(303) 555-0199" fixture.
  let caught = null;
  let result = null;
  try {
    result = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  } catch (err) {
    caught = err;
  }
  assert.strictEqual(result, null, "must never resolve at all when openai has no key configured");
  assert.ok(caught instanceof Error);

  // Same check for a configured-but-failing openai (network/HTTP error) —
  // still never silently resolves with mock data.
  process.env.OPENAI_API_KEY = "sk-test";
  fetchImpl = function () {
    return Promise.reject(new Error("network down"));
  };
  let caught2 = null;
  let result2 = null;
  try {
    result2 = await extractFromScreenshots({ images: SAMPLE_IMAGES });
  } catch (err) {
    caught2 = err;
  }
  assert.strictEqual(result2, null);
  assert.ok(caught2 instanceof Error);
});

test("INTAKE_VISION_PROVIDER still defaults to openai when unset, even with mock implemented", async () => {
  resetEnv();
  process.env.OPENAI_API_KEY = "sk-test";
  await extractFromScreenshots({ images: SAMPLE_IMAGES });
  assert.strictEqual(fetchCalls.length, 1, "the default path must still be openai (a real fetch call), not mock");
});

// ---------------------------------------------------------------------
async function main() {
  const settled = [];
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
      settled.push({ name: t.name, ok: true });
    } catch (err) {
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.stack ? err.stack : err));
      settled.push({ name: t.name, ok: false });
    }
  }
  const failed = settled.filter((r) => !r.ok);
  console.log("\n" + settled.length + " tests run, " + failed.length + " failed.");
  if (failed.length) process.exitCode = 1;
}

main();
