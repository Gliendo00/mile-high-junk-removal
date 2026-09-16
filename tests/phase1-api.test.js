// Local, offline test harness for the Phase 1 spam-protection work and the
// pre-existing /api/book, /api/contact, and /api/upload-photo handlers.
//
// This intentionally never touches the real network or the production
// Supabase project:
//   - "@supabase/supabase-js" is intercepted at require-time (see
//     interceptModule() below) and replaced with an in-memory fake that
//     records every call so assertions can check exactly what would have
//     been written, without a real database.
//   - global.fetch (used for the Resend API calls in book.js/contact.js) is
//     replaced with a fake that records the request and returns a canned
//     "ok" response — no email is ever actually sent.
//
// Run with:  node tests/phase1-api.test.js
// Exits with a non-zero code if any assertion fails.

const path = require("path");
const Module = require("module");
const assert = require("assert");

let currentFakeSupabase = null;

function createFakeSupabase(opts) {
  opts = opts || {};
  const calls = [];

  function insertBuilder(table, payload) {
    calls.push({ table: table, op: "insert", payload: payload });
    const shouldFail = opts.failOn === table;
    const idByTable = { customers: "mock-customer-id", bookings: "mock-booking-id" };

    const chain = {
      select: function () {
        return {
          single: function () {
            if (shouldFail) return Promise.resolve({ data: null, error: { message: "mock insert failure for " + table } });
            return Promise.resolve({ data: { id: idByTable[table] || "mock-id" }, error: null });
          },
        };
      },
      // dumpster_rentals / booking_photos inserts are awaited directly with
      // no .select()/.single() chain in the real code, so this object must
      // itself be thenable.
      then: function (resolve, reject) {
        const result = shouldFail ? { error: { message: "mock insert failure for " + table } } : { error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  function deleteBuilder(table) {
    return {
      eq: function (col, val) {
        calls.push({ table: table, op: "delete", id: val });
        return Promise.resolve({ error: null });
      },
    };
  }

  return {
    calls: calls,
    from: function (table) {
      return {
        insert: function (payload) {
          return insertBuilder(table, payload);
        },
        select: function (cols, selOpts) {
          if (selOpts && selOpts.count) {
            return {
              eq: function () {
                calls.push({ table: table, op: "count" });
                return Promise.resolve({ count: opts.existingPhotoCount || 0, error: null });
              },
            };
          }
          return { eq: function () { return Promise.resolve({ data: [], error: null }); } };
        },
        delete: function () {
          return deleteBuilder(table);
        },
      };
    },
    storage: {
      from: function (bucket) {
        return {
          upload: function (storagePath) {
            calls.push({ table: "storage:" + bucket, op: "upload", path: storagePath });
            return Promise.resolve(opts.storageUploadError ? { error: opts.storageUploadError } : { error: null });
          },
          remove: function (paths) {
            calls.push({ table: "storage:" + bucket, op: "remove", paths: paths });
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
}

// Intercepts require("@supabase/supabase-js") process-wide, without needing
// the package installed on disk and without writing anything to the repo
// (no node_modules/package-lock changes). createClient() always returns
// whatever `currentFakeSupabase` is set to at call time, so each test case
// can swap in a fresh fake before invoking a handler.
function interceptSupabaseModule() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return {
        createClient: function () {
          return currentFakeSupabase;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
interceptSupabaseModule();

// --- fake fetch (Resend) -----------------------------------------------
const fetchCalls = [];
global.fetch = function (url, opts) {
  fetchCalls.push({ url: url, opts: opts });
  return Promise.resolve({
    ok: true,
    json: function () { return Promise.resolve({ id: "mock-resend-id" }); },
    text: function () { return Promise.resolve("{}"); },
  });
};

// --- env required for the handlers to consider themselves "configured" --
process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
process.env.UPLOAD_TOKEN_SECRET = "mock-upload-token-secret";
process.env.RESEND_API_KEY = "mock-resend-key";

const bookHandler = require("../api/book.js");
const contactHandler = require("../api/contact.js");
const uploadPhotoHandler = require("../api/upload-photo.js");

// --- tiny req/res mocks ---------------------------------------------------
function makeReq(body, headersOverride, ipOverride) {
  const json = JSON.stringify(body === undefined ? {} : body);
  const headers = Object.assign(
    {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
      "x-forwarded-for": ipOverride || "203.0.113.1",
    },
    headersOverride || {}
  );
  return { method: "POST", headers: headers, body: body, socket: { remoteAddress: "127.0.0.1" } };
}

function makeRawReq(buffer, headersOverride, ipOverride) {
  const headers = Object.assign(
    {
      "content-type": "application/octet-stream",
      "content-length": String(buffer.length),
      "x-forwarded-for": ipOverride || "203.0.113.1",
    },
    headersOverride || {}
  );
  return { method: "POST", headers: headers, body: buffer, socket: { remoteAddress: "127.0.0.1" } };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    status: function (code) {
      res.statusCode = code;
      return res;
    },
    json: function (obj) {
      res.body = obj;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

function run(handler, req) {
  const res = makeRes();
  return Promise.resolve(handler(req, res)).then(function () {
    return res;
  });
}

// --- fixtures --------------------------------------------------------------
const FAR_FUTURE_DATE = (function () {
  const d = new Date();
  d.setDate(d.getDate() + 10);
  return d.toISOString().slice(0, 10);
})();

function validCustomer() {
  return {
    firstName: "Jamie",
    lastName: "Rivera",
    phone: "303-555-0100",
    email: "jamie@example.com",
    streetAddress: "123 Main St",
    city: "Denver",
    state: "CO",
    zip: "80202",
  };
}

function validJunkRemovalPayload(overrides) {
  return Object.assign(
    {
      serviceType: "junk_removal",
      hp: "",
      elapsedMs: 10000, // 10s of real fill time — comfortably past the 3s minimum
      jobDetails: { itemsDescription: "Old couch and mattress", location: "Garage", stairs: "none", additionalDetails: "" },
      schedule: { date: FAR_FUTURE_DATE, timeWindow: "w_0800_1000" },
      customer: validCustomer(),
    },
    overrides || {}
  );
}

function validLightDemoPayload(overrides) {
  return Object.assign(
    {
      serviceType: "light_demo",
      hp: "",
      elapsedMs: 10000,
      jobDetails: { demoDescription: "Tear out a small shed", approximateSize: "8x10 ft", debrisRemovalNeeded: "yes", additionalDetails: "" },
      schedule: { date: FAR_FUTURE_DATE, timeWindow: "w_1000_1200" },
      customer: validCustomer(),
    },
    overrides || {}
  );
}

function validDumpsterPayload(overrides) {
  const pickup = new Date(FAR_FUTURE_DATE);
  pickup.setDate(pickup.getDate() + 3);
  return Object.assign(
    {
      serviceType: "dumpster_rental",
      hp: "",
      elapsedMs: 10000,
      jobDetails: {
        materialType: "Household junk",
        deliveryDate: FAR_FUTURE_DATE,
        pickupDate: pickup.toISOString().slice(0, 10),
        placementLocation: "Driveway",
        additionalDetails: "",
      },
      schedule: { date: FAR_FUTURE_DATE, timeWindow: "w_0800_1000" },
      customer: validCustomer(),
    },
    overrides || {}
  );
}

// --- test registry -----------------------------------------------------
// Tests register here and run strictly sequentially in main() (awaited one
// at a time) — several tests share the mutable `currentFakeSupabase` /
// `fetchCalls` globals, so running them concurrently would let one test's
// setup clobber another's mid-flight.
const registered = [];
function test(name, fn) {
  registered.push({ name: name, fn: fn });
}

async function main() {
  // 1. Junk removal booking — happy path
  test("book: junk removal booking succeeds and writes customer+booking rows", async function () {
    currentFakeSupabase = createFakeSupabase();
    const res = await run(bookHandler, makeReq(validJunkRemovalPayload(), null, "198.51.100.10"));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.uploadToken, "expected an uploadToken in the response");
    const inserts = currentFakeSupabase.calls.filter(function (c) { return c.op === "insert"; });
    assert.strictEqual(inserts.length, 2, "expected exactly 2 inserts (customers, bookings)");
    assert.strictEqual(inserts[0].table, "customers");
    assert.strictEqual(inserts[1].table, "bookings");
    assert.strictEqual(inserts[1].payload.service_type, "junk_removal");
  });

  // 2. Light demo booking — happy path
  test("book: light demo booking succeeds", async function () {
    currentFakeSupabase = createFakeSupabase();
    const res = await run(bookHandler, makeReq(validLightDemoPayload(), null, "198.51.100.11"));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    const bookingInsert = currentFakeSupabase.calls.find(function (c) { return c.table === "bookings"; });
    assert.strictEqual(bookingInsert.payload.service_type, "light_demo");
  });

  // 3. Dumpster rental booking — happy path, also writes dumpster_rentals
  test("book: dumpster rental booking succeeds and writes a dumpster_rentals row", async function () {
    currentFakeSupabase = createFakeSupabase();
    const res = await run(bookHandler, makeReq(validDumpsterPayload(), null, "198.51.100.12"));
    assert.strictEqual(res.statusCode, 200);
    const tables = currentFakeSupabase.calls.filter(function (c) { return c.op === "insert"; }).map(function (c) { return c.table; });
    assert.deepStrictEqual(tables, ["customers", "bookings", "dumpster_rentals"]);
  });

  // 4. Booking without photos — the booking endpoint itself is identical
  //    whether or not the customer attaches photos afterward; this just
  //    confirms a normal booking with an empty photos flow succeeds and
  //    returns an uploadToken (photos are a separate, optional client step).
  test("book: booking with no photos still returns a usable uploadToken", async function () {
    currentFakeSupabase = createFakeSupabase();
    const res = await run(bookHandler, makeReq(validJunkRemovalPayload(), null, "198.51.100.13"));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.uploadToken);
  });

  // 5. Booking with photos — covered end-to-end together with the
  //    upload-photo tests below (#10/#11), which reuse a real uploadToken
  //    minted by this same handler.

  // 6. Invalid booking — missing required field
  test("book: invalid booking (missing item description) is rejected with 400", async function () {
    currentFakeSupabase = createFakeSupabase();
    const payload = validJunkRemovalPayload({ jobDetails: { itemsDescription: "", location: "Garage", stairs: "none", additionalDetails: "" } });
    const res = await run(bookHandler, makeReq(payload, null, "198.51.100.14"));
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.error);
    assert.strictEqual(currentFakeSupabase.calls.length, 0, "an invalid booking must never reach the database");
  });

  // 7. Honeypot submission
  test("book: honeypot-filled submission returns fake success and touches no data", async function () {
    currentFakeSupabase = createFakeSupabase();
    const fetchCallsBefore = fetchCalls.length;
    const payload = validJunkRemovalPayload({ hp: "http://spammy.example" });
    const res = await run(bookHandler, makeReq(payload, null, "198.51.100.15"));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.uploadToken, undefined, "a honeypot-caught request must not get a real upload token");
    assert.strictEqual(currentFakeSupabase.calls.length, 0);
    assert.strictEqual(fetchCalls.length, fetchCallsBefore, "no notification email should be sent for a caught bot");
  });

  // 6b. Too-fast submission (fill-time check), same code path as honeypot
  test("book: implausibly fast submission (0ms) returns fake success and touches no data", async function () {
    currentFakeSupabase = createFakeSupabase();
    const fetchCallsBefore = fetchCalls.length;
    const payload = validJunkRemovalPayload({ elapsedMs: 0 });
    const res = await run(bookHandler, makeReq(payload, null, "198.51.100.16"));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(currentFakeSupabase.calls.length, 0);
    assert.strictEqual(fetchCalls.length, fetchCallsBefore);
  });

  // 8. Rate-limit behavior (book.js: 8 requests / 15 min per IP)
  test("book: 9th request within the window from the same IP is rate-limited", async function () {
    currentFakeSupabase = createFakeSupabase();
    const ip = "198.51.100.99";
    let last;
    for (let i = 0; i < 9; i++) {
      last = await run(bookHandler, makeReq(validJunkRemovalPayload(), null, ip));
    }
    assert.strictEqual(last.statusCode, 429);
    assert.ok(last.body.error);
  });

  // 9. Existing Resend notification path (mocked network)
  test("book: successful booking calls the Resend API with expected fields", async function () {
    currentFakeSupabase = createFakeSupabase();
    const before = fetchCalls.length;
    await run(bookHandler, makeReq(validJunkRemovalPayload(), null, "198.51.100.17"));
    assert.strictEqual(fetchCalls.length, before + 1);
    const call = fetchCalls[fetchCalls.length - 1];
    assert.strictEqual(call.url, "https://api.resend.com/emails");
    const sentBody = JSON.parse(call.opts.body);
    assert.ok(sentBody.subject.indexOf("New Booking Request") === 0);
    assert.ok(sentBody.html.indexOf("Jamie Rivera") !== -1);
  });

  // 10. Photo-upload token generation (real signing code, mocked storage)
  let mintedUploadToken = null;
  test("book: response uploadToken is a well-formed signed token usable by upload-photo", async function () {
    currentFakeSupabase = createFakeSupabase();
    const res = await run(bookHandler, makeReq(validJunkRemovalPayload(), null, "198.51.100.18"));
    assert.strictEqual(res.statusCode, 200);
    mintedUploadToken = res.body.uploadToken;
    assert.strictEqual(typeof mintedUploadToken, "string");
    assert.strictEqual(mintedUploadToken.split(".").length, 2, "token should be payload.signature");
  });

  // 11. Photo-upload authorization — valid token + valid image succeeds
  test("upload-photo: valid token + valid JPEG bytes succeeds", async function () {
    assert.ok(mintedUploadToken, "previous test must have minted a token");
    currentFakeSupabase = createFakeSupabase();
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const req = makeRawReq(jpegBytes, {
      authorization: "Bearer " + mintedUploadToken,
      "x-photo-type": "image/jpeg",
    });
    const res = await run(uploadPhotoHandler, req);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    const upload = currentFakeSupabase.calls.find(function (c) { return c.op === "upload"; });
    assert.ok(upload, "expected a storage upload call");
  });

  // 11b. Photo-upload authorization — missing/garbage/expired token rejected
  test("upload-photo: missing Authorization header is rejected with 401", async function () {
    currentFakeSupabase = createFakeSupabase();
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const res = await run(uploadPhotoHandler, makeRawReq(jpegBytes, { "x-photo-type": "image/jpeg" }));
    assert.strictEqual(res.statusCode, 401);
  });

  test("upload-photo: tampered token is rejected with 401", async function () {
    currentFakeSupabase = createFakeSupabase();
    assert.ok(mintedUploadToken);
    const tampered = mintedUploadToken.slice(0, -2) + "xx";
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const req = makeRawReq(jpegBytes, { authorization: "Bearer " + tampered, "x-photo-type": "image/jpeg" });
    const res = await run(uploadPhotoHandler, req);
    assert.strictEqual(res.statusCode, 401);
  });

  test("upload-photo: expired token is rejected with 401", async function () {
    // Craft an expired token using the exact same scheme documented in
    // api/book.js's signUploadToken (payload JSON -> base64url, HMAC-SHA256
    // over the base64url payload -> base64url signature) — this only proves
    // the verification logic checks `exp`, it doesn't need book.js's
    // internal signing function to be exported.
    const crypto = require("crypto");
    const payload = JSON.stringify({ bookingId: "mock-booking-id", exp: Date.now() - 1000 });
    const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
    const sig = crypto.createHmac("sha256", process.env.UPLOAD_TOKEN_SECRET).update(payloadB64).digest("base64url");
    const expiredToken = payloadB64 + "." + sig;

    currentFakeSupabase = createFakeSupabase();
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const req = makeRawReq(jpegBytes, { authorization: "Bearer " + expiredToken, "x-photo-type": "image/jpeg" });
    const res = await run(uploadPhotoHandler, req);
    assert.strictEqual(res.statusCode, 401);
  });

  test("upload-photo: max photos per booking is enforced", async function () {
    currentFakeSupabase = createFakeSupabase({ existingPhotoCount: 6 });
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const req = makeRawReq(jpegBytes, { authorization: "Bearer " + mintedUploadToken, "x-photo-type": "image/jpeg" });
    const res = await run(uploadPhotoHandler, req);
    assert.strictEqual(res.statusCode, 400);
  });

  // 12. Contact form — happy path, honeypot (hard reject), fast-submission
  //     (soft flag, still sent — see the change-request tests below), rate-limit
  test("contact: valid submission succeeds and calls Resend", async function () {
    const before = fetchCalls.length;
    const payload = {
      name: "Taylor Doe",
      phone: "303-555-0101",
      email: "taylor@example.com",
      message: "Need a couch and two mattresses hauled away.",
      photos: [],
      hp: "",
      elapsedMs: 10000,
    };
    const res = await run(contactHandler, makeReq(payload, null, "198.51.100.30"));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fetchCalls.length, before + 1);
  });

  test("contact: honeypot-filled submission returns fake success without calling Resend", async function () {
    const before = fetchCalls.length;
    const payload = {
      name: "Bot Name",
      email: "bot@example.com",
      message: "seo services for your website",
      hp: "http://spammy.example",
      elapsedMs: 10000,
    };
    const res = await run(contactHandler, makeReq(payload, null, "198.51.100.31"));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fetchCalls.length, before, "no Resend call should be made for a caught bot");
  });

  // Change request (post-Phase-1-approval): for /contact only, a fast
  // submission must NOT be silently discarded — it's a soft signal that
  // flags the subject line and logs server-side, but the lead still goes
  // through and Resend is still called normally. This is intentionally
  // different from /api/book, where a fast submission is still hard-
  // rejected (see the "book: implausibly fast submission" test above) —
  // see docs/phase-1/fill-time-safety-review.md for why the two endpoints
  // differ.
  test("contact: suspiciously fast submission is still sent, flagged in the subject line", async function () {
    const before = fetchCalls.length;
    const payload = { name: "Fast Human", email: "fast@example.com", phone: "303-555-0102", message: "Need a couch hauled away.", hp: "", elapsedMs: 0 };
    const res = await run(contactHandler, makeReq(payload, null, "198.51.100.32"));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fetchCalls.length, before + 1, "a fast-but-not-honeypotted submission must still be sent via Resend");
    const call = fetchCalls[fetchCalls.length - 1];
    const sentBody = JSON.parse(call.opts.body);
    assert.ok(sentBody.subject.indexOf("[Fast Submission]") === 0, "subject should be flagged, not silently dropped");
  });

  test("contact: normal-speed submission is never flagged as fast", async function () {
    const before = fetchCalls.length;
    const payload = { name: "Normal Human", email: "normal@example.com", phone: "303-555-0103", message: "Need a couch hauled away.", hp: "", elapsedMs: 10000 };
    const res = await run(contactHandler, makeReq(payload, null, "198.51.100.33"));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fetchCalls.length, before + 1);
    const call = fetchCalls[fetchCalls.length - 1];
    const sentBody = JSON.parse(call.opts.body);
    assert.ok(sentBody.subject.indexOf("[Fast Submission]") === -1);
  });

  test("contact: 9th request within the window from the same IP is rate-limited", async function () {
    const ip = "198.51.100.98";
    let last;
    for (let i = 0; i < 9; i++) {
      last = await run(
        contactHandler,
        makeReq({ name: "Person " + i, email: "p" + i + "@example.com", message: "hi", hp: "", elapsedMs: 10000 }, null, ip)
      );
    }
    assert.strictEqual(last.statusCode, 429);
  });

  const settled = [];
  for (const t of registered) {
    try {
      await t.fn();
      console.log("PASS - " + t.name);
      settled.push({ name: t.name, ok: true });
    } catch (err) {
      console.log("FAIL - " + t.name);
      console.log("       " + (err && err.message ? err.message : err));
      settled.push({ name: t.name, ok: false, error: err });
    }
  }

  const failed = settled.filter(function (r) { return !r.ok; });
  console.log("\n" + settled.length + " tests run, " + failed.length + " failed.");
  if (failed.length) {
    process.exitCode = 1;
  }
}

main();
