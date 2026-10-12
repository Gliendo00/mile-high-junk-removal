// Site Improvement Agent — tests for the private/publication-safe
// business-context boundary. Uses synthetic fixture data only (there is
// no real CRM completed-job integration yet) — these tests exist to prove
// the separation works correctly BEFORE that integration is ever built.
//
// Run with:  node tests/agent-business-context.test.js

const assert = require("assert");
const { redactForPublication, assertNoPrivateLeakage, isPrivateFieldName } = require("../agent/lib/business-context");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

// Synthetic example matching the shape described in the product spec's
// "Private CRM data vs publication-safe business context" section. None
// of this is real client data.
const syntheticRawJobNote = {
  serviceType: "hot tub removal",
  city: "Wheat Ridge",
  accessNotes: "Backyard access was easy, cut it into sections.",
  outcomeTag: "completed-no-issues",
  clientName: "Jane Example",
  customerPhone: "303-555-0100",
  customerEmail: "jane@example.com",
  streetAddress: "123 Example St",
  price: 450,
  tipAmount: 40,
  paymentMethod: "card",
  privateNotes: "Client mentioned a divorce, be discreet.",
};

test("redactForPublication keeps only the publication-safe allowlisted fields", () => {
  const safe = redactForPublication(syntheticRawJobNote);
  assert.deepStrictEqual(Object.keys(safe).sort(), [
    "accessNotes",
    "city",
    "outcomeTag",
    "serviceType",
  ]);
});

test("redactForPublication strips every private field even though the input also had an allowlisted field by the same name pattern", () => {
  const safe = redactForPublication(syntheticRawJobNote);
  for (const key of ["clientName", "customerPhone", "customerEmail", "streetAddress", "price", "tipAmount", "paymentMethod", "privateNotes"]) {
    assert.ok(!(key in safe), `private field "${key}" leaked into publication-safe output`);
  }
});

test("redactForPublication never includes the private values anywhere in the output, even under a different key name", () => {
  const safe = redactForPublication(syntheticRawJobNote);
  const serialized = JSON.stringify(safe);
  assert.ok(!serialized.includes("450"));
  assert.ok(!serialized.includes("Jane Example"));
  assert.ok(!serialized.includes("303-555-0100"));
  assert.ok(!serialized.includes("123 Example St"));
});

test("redactForPublication throws on non-object input instead of silently returning nothing", () => {
  assert.throws(() => redactForPublication(null));
  assert.throws(() => redactForPublication("a string"));
});

test("isPrivateFieldName recognizes common private field name patterns", () => {
  assert.strictEqual(isPrivateFieldName("price"), true);
  assert.strictEqual(isPrivateFieldName("tip"), true);
  assert.strictEqual(isPrivateFieldName("clientName"), true);
  assert.strictEqual(isPrivateFieldName("customerEmail"), true);
  assert.strictEqual(isPrivateFieldName("serviceType"), false);
  assert.strictEqual(isPrivateFieldName("city"), false);
});

test("assertNoPrivateLeakage throws if generated text contains a private raw value", () => {
  const generatedCopy = "We handled a hot tub removal for Jane Example in Wheat Ridge.";
  assert.throws(
    () => assertNoPrivateLeakage(generatedCopy, syntheticRawJobNote),
    /private field "clientName"/
  );
});

test("assertNoPrivateLeakage passes for genuinely redacted text", () => {
  const generatedCopy = "We handled a hot tub removal in Wheat Ridge. Backyard access was easy.";
  assert.strictEqual(assertNoPrivateLeakage(generatedCopy, syntheticRawJobNote), true);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
