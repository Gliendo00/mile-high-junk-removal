// Site Improvement Agent — tests for the private/publication-safe
// business-context boundary. Uses synthetic fixture data — the real
// completed-job data behind fromCompletedBooking() below is new as of
// Phase 3 (bookings.operational_note) and has no real content in
// production yet, so these tests exercise the mapping with realistic
// fixtures shaped exactly like api/admin/booking.js's real GET response
// and raw Supabase row, including every private column that row actually
// has, to prove none of it can leak through this boundary.
//
// Run with:  node tests/agent-business-context.test.js

const assert = require("assert");
const { redactForPublication, assertNoPrivateLeakage, isPrivateFieldName, fromCompletedBooking } = require("../agent/lib/business-context");

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

// -----------------------------------------------------------------------
// fromCompletedBooking() — Phase 3's real completed-job source
// (bookings.operational_note). Fixture shaped exactly like a real raw
// Supabase row (snake_case), with every private column that row actually
// has in production (see sql/*.sql migrations), to prove the mapping
// picks only the four safe fields and nothing else — not because the
// private fields happen to get caught by a pattern, but because they are
// simply never read.
// -----------------------------------------------------------------------
function realBookingRowFixture(overrides) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    customer_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    service_type: "junk_removal",
    appointment_date: "2026-10-01",
    status: "completed",
    description: "Hot tub removal",
    estimated_price: 450,
    final_price: 420,
    tip_amount: 40,
    internal_notes: "Gate code 1234, client is a friend of Rocky's",
    operational_note: "Hot tub removal in Wheat Ridge. Backyard access was easy. Cut it into sections.",
    is_complimentary: false,
    complimentary_value: null,
    complimentary_reason: null,
    complimentary_note: null,
    service_address: "123 Example St",
    service_city: "Wheat Ridge",
    service_state: "CO",
    service_zip: "80033",
    created_at: "2026-09-28T12:00:00Z",
    updated_at: "2026-10-01T18:00:00Z",
    ...overrides,
  };
}

test("fromCompletedBooking maps a real booking row to only the four publication-safe fields", () => {
  const safe = fromCompletedBooking(realBookingRowFixture());
  assert.deepStrictEqual(safe, {
    serviceType: "junk_removal",
    city: "Wheat Ridge",
    accessNotes: "Hot tub removal in Wheat Ridge. Backyard access was easy. Cut it into sections.",
    outcomeTag: "completed",
  });
});

test("fromCompletedBooking: none of the real row's private/financial fields appear anywhere in the output, even as substrings", () => {
  const booking = realBookingRowFixture();
  const safe = fromCompletedBooking(booking);
  const serialized = JSON.stringify(safe);
  assert.ok(!serialized.includes("420")); // final_price
  assert.ok(!serialized.includes("450")); // estimated_price
  assert.ok(!serialized.includes("40"), "tip_amount (40) must not appear"); // careful: also not a substring of anything kept
  assert.ok(!serialized.includes("123 Example St"));
  assert.ok(!serialized.includes("Gate code"));
  assert.ok(!serialized.includes("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")); // customer_id
  assert.ok(!("customerId" in safe));
  assert.ok(!("finalPrice" in safe));
  assert.ok(!("tipAmount" in safe));
  assert.ok(!("internalNotes" in safe));
  assert.ok(!("serviceAddress" in safe));
});

test("fromCompletedBooking also accepts the already-camelCased API response shape (api/admin/booking.js's GET)", () => {
  const apiShapedBooking = {
    serviceType: "junk_removal",
    serviceCity: "Wheat Ridge",
    operationalNote: "Garage cleanout in Parker. Mostly furniture and cardboard.",
    status: "completed",
    tipAmount: 25,
    internalNotes: "private",
    customerId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  };
  const safe = fromCompletedBooking(apiShapedBooking);
  assert.deepStrictEqual(safe, {
    serviceType: "junk_removal",
    city: "Wheat Ridge",
    accessNotes: "Garage cleanout in Parker. Mostly furniture and cardboard.",
    outcomeTag: "completed",
  });
});

test("fromCompletedBooking returns null (not an empty object) when there is no operational note at all", () => {
  const booking = realBookingRowFixture({ operational_note: null });
  assert.strictEqual(fromCompletedBooking(booking), null);
});

test("fromCompletedBooking: outcomeTag is only ever 'completed' for a genuinely completed job, never guessed for any other status", () => {
  const booking = realBookingRowFixture({ status: "booked" });
  const safe = fromCompletedBooking(booking);
  assert.strictEqual(safe.outcomeTag, undefined);
});

test("fromCompletedBooking throws on non-object input instead of silently returning nothing", () => {
  assert.throws(() => fromCompletedBooking(null));
  assert.throws(() => fromCompletedBooking("a string"));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
