// Vercel serverless function — creates a customer + booking (+ dumpster_rentals
// row when applicable) in Supabase from the /book/ multi-step form.
//
// Required environment variables (server-side only, never read by the browser):
//   SUPABASE_URL
//   SUPABASE_SECRET_KEY
//   UPLOAD_TOKEN_SECRET — signs the short-lived photo-upload token (see below)
//   STRIPE_SECRET_KEY — see api/_lib/stripe-client.js. Required only for the
//     dumpster_rental payment path (below); junk_removal/light_demo never
//     touch Stripe.
//   STRIPE_PUBLISHABLE_KEY — read directly by GET (below), not through
//     api/_lib/stripe-client.js: a separate, non-secret, publishable value
//     echoed to the browser so Stripe.js can initialize the Payment Element.
//
// Column names below match the live schema exactly:
//   customers(id, first_name, last_name, phone, email, address, city, state, zip,
//             phone_normalized, email_normalized, created_at)
//   bookings(id, customer_id, service_type, appointment_date, time_window, status,
//            description, estimated_price, final_price, internal_notes, created_at, updated_at,
//            service_address, service_city, service_state, service_zip)
//   dumpster_rentals(id, booking_id UNIQUE, delivery_date, pickup_date, material_type,
//                     placement_notes, created_at)
//   booking_photos(id, booking_id, storage_path, created_at) — written by api/upload-photo.js.
//   rental_payments(id, booking_id UNIQUE, idempotency_key UNIQUE, payment_status,
//                    amount_charged, stripe_payment_intent_id, stripe_customer_id,
//                    stripe_payment_method_id, payment_method_summary,
//                    dispute_status, agreement_version, agreement_accepted_at,
//                    created_at, updated_at) — Phase 3C Stage 2.5-v2, dumpster_rental only.
//
// bookings.service_address/service_city/service_state/service_zip are a
// point-in-time snapshot of where this specific job happens, copied from the
// customer's submitted address at the moment this booking is created. They
// are deliberately separate from customers.address (the client's contact
// address on file, which can change later) so a repeat client's past jobs
// keep showing the address where each job actually occurred, independent of
// any future change to that client's profile.
//
// Phase 3B Step 4a.3 — conservative repeat-client reuse: this endpoint
// reuses an existing customers.id for the new booking ONLY when the
// submitted normalized phone AND normalized email both exactly match the
// same single existing customer row (see the lookup right before the
// customer insert below, and api/_lib/customer-identity.js for the shared
// normalization rules). Every other case — no email, zero matches,
// multiple matches, a phone/email disagreement, or any lookup failure —
// creates a new customer exactly as before Step 4a.3. Reuse never updates
// the matched customer's own profile fields; it only attaches the new
// booking to their existing id. Which branch was taken is never exposed
// in the response — see the response construction at the bottom of this
// handler.
//
// On success this endpoint never returns the raw booking UUID. Instead it returns a
// short-lived, HMAC-signed "uploadToken" scoped to exactly this booking, which the
// browser presents to POST /api/upload-photo to attach photos. See verifyUploadToken
// in api/upload-photo.js for the corresponding verification logic (kept as a small,
// duplicated helper in both files rather than a shared module, matching this project's
// existing pattern of self-contained /api functions).
//
// Phase 3C Stage 2.5-v2 — dumpster_rental is now a REAL BOOKING, not a lead
// form: available + agreed + paid => status: "booked" directly (no admin
// review step), via Stripe. See
// docs/phase-3/stage2.5-stripe-rental-payments-migration.md for the full
// design (this feature was originally built on Braintree and switched to
// Stripe before any production rollout — see that doc's header for why).
// junk_removal and light_demo are completely unaffected — same validation,
// same insert sequence, same response shape as before this stage. GET is
// new (previously an unconditional 405): public, non-secret config the
// booking page needs before it can render the Stripe Payment Element — see
// handlePublicConfig() below.
//
// Stripe architecture in one paragraph (see the migration doc for the full
// reasoning): the booking flow uses a manual-capture PaymentIntent so the
// database's own slot-uniqueness index can be checked BEFORE any money
// moves — mirroring the original Braintree design's "claim the slot, then
// charge" ordering, which a naive Stripe integration (confirm = capture)
// would not preserve. `POST ?resource=payment-intent` (below) authorizes
// the card (a hold, no charge yet) once the browser has collected payment
// details via the Payment Element; the plain `POST` (no resource param)
// then inserts the booking (claiming the slot) and only THEN captures the
// already-authorized PaymentIntent. A losing race for the same delivery
// slot never gets captured — the authorization is cancelled and released
// instead, so a losing customer is never charged even a temporary amount.

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const { getClientIp, isRateLimited, isHoneypotTripped, isSubmittedTooFast } = require("./_lib/spam-protection");
const { normalizePhone, normalizeEmail } = require("./_lib/customer-identity");
const { getStripeClient } = require("./_lib/stripe-client");
const rentalPricing = require("./_lib/rental-pricing");
const { retryUpdate } = require("./_lib/db-retry");

const UPLOAD_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Generous on purpose — this only needs to stop scripted abuse, not slow
// down a real customer who might legitimately submit more than once (e.g.
// booking two separate jobs, or retrying after a typo).
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 8;
// A human filling out this multi-step wizard cannot realistically finish in
// under this long; a script that fills and submits it can.
const MIN_FILL_TIME_MS = 3000;
// GET (public rental config) is read-only and far cheaper to serve than a
// POST, and every real visitor to /book/ needs it exactly once per page
// load — a higher ceiling than RATE_LIMIT_MAX is appropriate, still on the
// same RATE_LIMIT_WINDOW_MS window and the same per-IP key namespace
// convention as the POST limiter above.
const CONFIG_RATE_LIMIT_MAX = 40;
// How far into the future GET's takenDeliverySlots list looks — comfortably
// covers book/book.js's own MONTH_COUNT (6 months) date picker with room to
// spare. Purely a display convenience (see handlePublicConfig's header
// comment) — never the actual availability authority.
const TAKEN_SLOTS_WINDOW_DAYS = 200;

const SERVICE_TYPES = ["junk_removal", "dumpster_rental", "light_demo"];
const SERVICE_LABELS = { junk_removal: "Junk Removal", dumpster_rental: "15-Yard Dumpster Rental", light_demo: "Light Demo" };
const STAIRS_OPTIONS = ["none", "some", "multiple_flights"];
const STAIRS_LABELS = { none: "No stairs", some: "Some stairs", multiple_flights: "Multiple flights" };
const YES_NO = ["yes", "no"];
// Every accepted time-window value: its display label, and the America/Denver
// hour (0–23) it begins at — the latter drives the same-day expiration check
// in isTimeWindowExpired() below. "morning"/"midday"/"afternoon"/"evening" are
// the legacy broad windows, kept valid for any service type for backwards
// compatibility with bookings submitted before the 2-hour-window date & time
// UI shipped. The "w_*" ids are the current 2-hour windows.
const TIME_WINDOW_DEFS = {
  morning: { label: "Morning (8am–11am)", startHour: 8 },
  midday: { label: "Midday (11am–2pm)", startHour: 11 },
  afternoon: { label: "Afternoon (2pm–5pm)", startHour: 14 },
  evening: { label: "Evening (5pm–7pm)", startHour: 17 },
  w_0400_0600: { label: "4:00 AM – 6:00 AM", startHour: 4 },
  w_0600_0800: { label: "6:00 AM – 8:00 AM", startHour: 6 },
  w_0800_1000: { label: "8:00 AM – 10:00 AM", startHour: 8 },
  w_1000_1200: { label: "10:00 AM – 12:00 PM", startHour: 10 },
  w_1200_1400: { label: "12:00 PM – 2:00 PM", startHour: 12 },
  w_1400_1600: { label: "2:00 PM – 4:00 PM", startHour: 14 },
  w_1600_1800: { label: "4:00 PM – 6:00 PM", startHour: 16 },
  w_1800_2000: { label: "6:00 PM – 8:00 PM", startHour: 18 },
  w_2000_2200: { label: "8:00 PM – 10:00 PM", startHour: 20 },
};
const TIME_WINDOW_LABELS = Object.keys(TIME_WINDOW_DEFS).reduce(function (acc, id) {
  acc[id] = TIME_WINDOW_DEFS[id].label;
  return acc;
}, {});

const LEGACY_TIME_WINDOWS = ["morning", "midday", "afternoon", "evening"];
// Junk removal / light demo: the full 4am–10pm range.
const STANDARD_ARRIVAL_WINDOWS = [
  "w_0400_0600",
  "w_0600_0800",
  "w_0800_1000",
  "w_1000_1200",
  "w_1200_1400",
  "w_1400_1600",
  "w_1600_1800",
  "w_1800_2000",
  "w_2000_2200",
];
// Dumpster rental delivery: 6am–8pm only — no 4–6am or 8–10pm — matching
// DUMPSTER_DELIVERY_WINDOWS in book/book.js.
const DUMPSTER_DELIVERY_WINDOWS = STANDARD_ARRIVAL_WINDOWS.filter(function (id) {
  return id !== "w_0400_0600" && id !== "w_2000_2200";
});
// The time windows accepted per service type. Legacy values remain valid for
// every service type (they always were), but the new w_* windows are scoped
// per service so, e.g., a dumpster_rental booking cannot be submitted with a
// junk-removal-only window like 4–6am.
const TIME_WINDOWS_BY_SERVICE = {
  junk_removal: LEGACY_TIME_WINDOWS.concat(STANDARD_ARRIVAL_WINDOWS),
  light_demo: LEGACY_TIME_WINDOWS.concat(STANDARD_ARRIVAL_WINDOWS),
  dumpster_rental: LEGACY_TIME_WINDOWS.concat(DUMPSTER_DELIVERY_WINDOWS),
};

const MAX = {
  name: 80,
  phone: 30,
  email: 254,
  address: 200,
  city: 80,
  state: 2,
  zip: 10,
  short: 200,
  long: 2000,
  paymentIntentId: 100, // a real Stripe PaymentIntent id ("pi_...") is far shorter
  idempotencyKey: 100,
};

const MAX_BODY_BYTES = 20 * 1024; // plenty for a text-only booking form; no photo bytes travel through this endpoint

module.exports = async (req, res) => {
  try {
    // Phase 3C Stage 2.5-v2: public, non-secret config for the booking
    // page — the Stripe publishable key, current rental pricing, the
    // agreement version, and (best-effort, non-authoritative — see
    // handlePublicConfig) which delivery slots already look taken. No spam
    // protection needed (nothing is written), but still IP-rate-limited as
    // cheap insurance against casual scraping, matching this endpoint's
    // existing defensive style.
    if (req.method === "GET") return handlePublicConfig(req, res);

    // Phase 3C Stage 2.5-v2 — Stripe's Payment Element needs a PaymentIntent
    // to exist (and its client_secret handed to the browser) BEFORE the
    // customer can enter card details, unlike Braintree's tokenization-key
    // model. This is a separate, clearly-scoped POST branch — dispatched the
    // same way api/admin/booking.js's `?resource=charges` is — rather than a
    // new Vercel function, keeping the 12/12 function budget unchanged. See
    // handleCreatePaymentIntent() below for the full flow and why this is
    // safe to call before any booking/customer row exists.
    if (req.query && req.query.resource === "payment-intent") {
      if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
      }
      return handleCreatePaymentIntent(req, res);
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      res.status(415).json({ error: "Unsupported content type." });
      return;
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > MAX_BODY_BYTES) {
      res.status(413).json({ error: "Request body too large." });
      return;
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !supabaseSecretKey) {
      console.error("Booking submission failed: SUPABASE_URL / SUPABASE_SECRET_KEY not configured");
      res.status(500).json({ error: "Booking is not available right now. Please call or text 303-990-1812." });
      return;
    }

    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
    if (!body) {
      res.status(400).json({ error: "Invalid request body." });
      return;
    }

    const clientIp = getClientIp(req);
    if (isRateLimited("book:" + clientIp, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX)) {
      res.status(429).json({ error: "Too many requests. Please wait a bit and try again, or call or text 303-990-1812." });
      return;
    }

    // Bot signals: a filled honeypot field or an implausibly fast submission.
    // Both are handled identically — respond as if the booking succeeded
    // (without ever touching Supabase or sending a notification email) so an
    // automated sender gets no feedback that would help it adapt.
    if (isHoneypotTripped(body.hp) || isSubmittedTooFast(body.elapsedMs, MIN_FILL_TIME_MS)) {
      console.error("Booking submission rejected as likely spam (ip=" + clientIp + ")");
      res.status(200).json({ ok: true });
      return;
    }

    const validation = validateBooking(body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const data = validation.data;

    const supabase = createClient(supabaseUrl, supabaseSecretKey, {
      auth: { persistSession: false },
    });

    // Phase 3C Stage 2.5-v2: dumpster_rental is a completely separate,
    // payment-integrated flow from here on — see
    // handleDumpsterRentalBooking() below. junk_removal/light_demo fall
    // through to the existing flow, byte-for-byte unchanged.
    if (data.serviceType === "dumpster_rental") {
      return handleDumpsterRentalBooking(res, supabase, data);
    }

    const phoneNorm = normalizePhone(data.customer.phone);
    const emailNorm = normalizeEmail(data.customer.email);

    // Repeat-client reuse lookup — see the Step 4a.3 note in the header
    // comment above for the full rule. Only ever runs when an email was
    // submitted; only ever reuses when exactly one row matches both
    // fields at once. Any failure here (thrown error, Supabase error)
    // falls open to customerId staying null, i.e. a new customer is
    // created below exactly as if no match existed — this lookup can
    // never turn into a 500 and can never block a booking.
    let customerId = null;
    if (emailNorm) {
      try {
        const { data: matches, error } = await supabase
          .from("customers")
          .select("id")
          .eq("phone_normalized", phoneNorm)
          .eq("email_normalized", emailNorm);

        if (!error && Array.isArray(matches) && matches.length === 1) {
          customerId = matches[0].id;
        }
      } catch (err) {
        console.error("Repeat-client lookup failed, creating a new customer instead:", err);
      }
    }

    // True only once THIS request has created a new customer row (set
    // right after the insert below succeeds). Every rollback deletion of
    // a customer further down in this handler is guarded by this flag —
    // a customer reused via the lookup above must never be deleted just
    // because a later step in this same request fails: bookings.customer_id
    // -> customers.id is ON DELETE CASCADE, so deleting a reused customer
    // would silently wipe out their entire pre-existing booking history.
    let customerWasCreated = false;

    if (customerId === null) {
      try {
        const { data: customerRow, error } = await supabase
          .from("customers")
          .insert({
            first_name: data.customer.firstName,
            last_name: data.customer.lastName || null,
            phone: data.customer.phone,
            email: data.customer.email || null,
            address: data.customer.streetAddress,
            city: data.customer.city,
            state: data.customer.state,
            zip: data.customer.zip,
            // Phase 3B Step 4a.2: written on every new customer for
            // future repeat-client matching (see
            // api/_lib/customer-identity.js). Reuses the same normalized
            // values already computed above for the lookup.
            phone_normalized: phoneNorm,
            email_normalized: emailNorm,
          })
          .select("id")
          .single();

        if (error || !customerRow) {
          console.error("Booking submission failed creating customer:", error);
          res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
          return;
        }
        customerId = customerRow.id;
        customerWasCreated = true;
      } catch (err) {
        console.error("Booking submission failed creating customer:", err);
        res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
        return;
      }
    }
    // On reuse (customerId set above, customerWasCreated left false): the
    // matched customer's own row (name/phone/email/address/normalized
    // fields) is never written to here — only their id is used, below, to
    // attach the new booking. Profile reconciliation is a separate,
    // future feature.

    let bookingId;
    try {
      const { data: bookingRow, error } = await supabase
        .from("bookings")
        .insert({
          customer_id: customerId,
          service_type: data.serviceType,
          appointment_date: data.appointmentDate,
          time_window: data.schedule.timeWindow,
          description: data.description,
          // Historical job-location snapshot — see the schema comment above.
          // Sourced from the same already-validated submitted address
          // fields used for the customer insert or lookup above, never a
          // separate input — this holds whether this booking got a brand
          // new customer or reused an existing one via Step 4a.3.
          service_address: data.customer.streetAddress,
          service_city: data.customer.city,
          service_state: data.customer.state,
          service_zip: data.customer.zip,
        })
        .select("id")
        .single();

      if (error || !bookingRow) {
        console.error("Booking submission failed creating booking:", error);
        // Only delete a customer THIS request created — see the
        // customerWasCreated comment above. A reused customer's id must
        // never reach safeDelete().
        if (customerWasCreated) {
          await safeDelete(supabase, "customers", customerId);
        }
        res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
        return;
      }
      bookingId = bookingRow.id;
    } catch (err) {
      console.error("Booking submission failed creating booking:", err);
      if (customerWasCreated) {
        await safeDelete(supabase, "customers", customerId);
      }
      res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
      return;
    }

    // dumpster_rental never reaches here — see the branch to
    // handleDumpsterRentalBooking() above. Only junk_removal/light_demo
    // bookings (neither of which has a dumpster_rentals row) reach this
    // point.

    // Best-effort admin notification — sent only after every required row for
    // this booking (customer and booking) has been saved. Awaited so it
    // completes before the response is sent, but fully self-contained:
    // nothing it does can change the response below.
    await sendBookingNotificationEmail(data);

    // Intentionally never returns the raw booking UUID. If photo upload is
    // configured, mint a short-lived token scoped to exactly this booking so
    // the browser can attach photos via POST /api/upload-photo without ever
    // holding a general-purpose booking identifier.
    const uploadTokenSecret = process.env.UPLOAD_TOKEN_SECRET;
    let uploadToken;
    if (uploadTokenSecret) {
      uploadToken = signUploadToken(bookingId, uploadTokenSecret);
    } else {
      console.error("Booking submission succeeded but UPLOAD_TOKEN_SECRET is not configured — photo upload will be unavailable for this booking.");
    }

    res.status(200).json(uploadToken ? { ok: true, uploadToken } : { ok: true });
  } catch (err) {
    console.error("Booking submission failed with an unexpected error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
    }
  }
};

async function safeDelete(supabase, table, id) {
  try {
    await supabase.from(table).delete().eq("id", id);
  } catch (err) {
    console.error("Rollback failed for " + table + " id " + id + ":", err);
  }
}

// Same rollback-only, never-throws contract as safeDelete() above, but
// keyed on an arbitrary column rather than always "id" — used below to
// clean up rental_payments/dumpster_rentals rows by booking_id.
async function safeDeleteByColumn(supabase, table, column, value) {
  try {
    await supabase.from(table).delete().eq(column, value);
  } catch (err) {
    console.error("Rollback failed for " + table + " where " + column + "=" + value + ":", err);
  }
}

// ---------------------------------------------------------------------
// Phase 3C Stage 2.5-v2 — GET: public, non-secret rental config.
// ---------------------------------------------------------------------
// Everything this returns is safe for any caller, authenticated or not:
// the Stripe publishable key is designed by Stripe to be embedded in client
// code, pricing is public marketing information already shown on
// dumpster-rental.html, and takenDeliverySlots carries no customer data
// (just date + time_window) and is explicitly a UX convenience, not an
// authority: the real availability enforcement is the database's own
// partial unique index, checked atomically at booking-insert time in
// handleDumpsterRentalBooking() below — a caller of this endpoint could
// return stale or fabricated data here and it would change nothing about
// what can actually be booked.
async function handlePublicConfig(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const clientIp = getClientIp(req);
  if (isRateLimited("book-config:" + clientIp, RATE_LIMIT_WINDOW_MS, CONFIG_RATE_LIMIT_MAX)) {
    res.status(429).json({ error: "Too many requests. Please wait a bit and try again." });
    return;
  }

  let takenDeliverySlots = [];
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  if (supabaseUrl && supabaseSecretKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseSecretKey, { auth: { persistSession: false } });
      const fromIso = denverTodayIso();
      const toDate = new Date();
      toDate.setDate(toDate.getDate() + TAKEN_SLOTS_WINDOW_DAYS);
      const toIso = toDate.toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from("bookings")
        .select("appointment_date, time_window")
        .eq("service_type", "dumpster_rental")
        .eq("status", "booked")
        .gte("appointment_date", fromIso)
        .lte("appointment_date", toIso);
      if (!error && Array.isArray(data)) {
        takenDeliverySlots = data.map(function (row) {
          return { date: row.appointment_date, timeWindow: row.time_window };
        });
      } else if (error) {
        console.error("Public rental config: failed loading taken slots (non-fatal, list stays empty):", error);
      }
    } catch (err) {
      console.error("Public rental config: failed loading taken slots (non-fatal, list stays empty):", err);
    }
  }

  res.status(200).json({
    ok: true,
    stripe: {
      // Null when unconfigured rather than omitted — the client checks
      // this explicitly and shows "payment is temporarily unavailable"
      // rather than a confusing broken Payment Element widget. No separate
      // "environment" field: Stripe.js infers test vs. live entirely from
      // the publishable key's own value (test keys start "pk_test_", live
      // keys "pk_live_"), so echoing anything else here would just be a
      // second, potentially-inconsistent source of truth for the same fact.
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    },
    pricing: {
      baseRate: rentalPricing.BASE_RATE,
      includedDays: rentalPricing.INCLUDED_DAYS,
      includedTons: rentalPricing.INCLUDED_TONS,
      overageTonRate: rentalPricing.OVERAGE_TON_RATE,
      overageDayRate: rentalPricing.OVERAGE_DAY_RATE,
    },
    agreementVersion: rentalPricing.RENTAL_AGREEMENT_VERSION,
    takenDeliverySlots: takenDeliverySlots,
  });
}

// ---------------------------------------------------------------------
// Phase 3C Stage 2.5-v2 — POST ?resource=payment-intent: authorize (but
// never capture) a card before the booking exists.
// ---------------------------------------------------------------------
// Stripe's Payment Element requires a PaymentIntent's client_secret to
// exist before it can render — unlike Braintree's tokenization-key model,
// there is no way to collect card details first and create the charge
// object after. This endpoint is called once, when the customer reaches
// the Payment step, with the full booking payload already filled in
// (everything validateBooking() can check except the payment method
// itself, which doesn't exist yet).
//
// This function creates ZERO database rows — no customers/bookings/
// dumpster_rentals/rental_payments row exists yet. It only talks to
// Stripe: it looks up (read-only) whether this repeat customer has a
// Stripe Customer id on file from a past rental (via their most recent
// rental_payments row, if any — see findExistingStripeCustomerId() below),
// creates a Stripe Customer otherwise, and creates a PaymentIntent with
// capture_method: "manual" (authorize now, never auto-capture) and
// setup_future_usage: "off_session" (save the payment method for later
// admin-approved charges once the eventual capture succeeds).
//
// Idempotency: every Stripe write below passes payment.idempotencyKey as
// Stripe's own request Idempotency-Key. Calling this endpoint twice with
// the same key (e.g. the customer reopens the Payment panel after going
// Back to Review and forward again) returns the SAME Stripe objects rather
// than creating duplicates — Stripe enforces this natively, so no local
// tracking row is needed for this step.
async function handleCreatePaymentIntent(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseSecretKey) {
    console.error("Create payment intent failed: SUPABASE_URL / SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Payment is not available right now. Please call or text 303-990-1812." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  if (!body) {
    res.status(400).json({ error: "Invalid request body." });
    return;
  }

  const clientIp = getClientIp(req);
  if (isRateLimited("book-intent:" + clientIp, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX)) {
    res.status(429).json({ error: "Too many requests. Please wait a bit and try again, or call or text 303-990-1812." });
    return;
  }

  if (isHoneypotTripped(body.hp) || isSubmittedTooFast(body.elapsedMs, MIN_FILL_TIME_MS)) {
    // Mirrors module.exports' own bot-signal handling: respond as if
    // everything is fine (never reveal to a scripted sender that it was
    // caught), but never actually create a Stripe object for it.
    console.error("Create payment intent rejected as likely spam (ip=" + clientIp + ")");
    res.status(200).json({ ok: true, clientSecret: null });
    return;
  }

  const validation = validateBooking(body, { requirePaymentMethod: false });
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const data = validation.data;
  if (data.serviceType !== "dumpster_rental") {
    res.status(400).json({ error: "Online payment is only available for dumpster rental bookings." });
    return;
  }

  const stripe = getStripeClient();
  if (!stripe) {
    console.error("Create payment intent failed: STRIPE_SECRET_KEY not configured");
    res.status(500).json({ error: "Payment is not available right now. Please call or text 303-990-1812." });
    return;
  }

  const idempotencyKey = data.payment.idempotencyKey;
  const amount = rentalPricing.baseRentalAmount();
  const supabase = createClient(supabaseUrl, supabaseSecretKey, { auth: { persistSession: false } });

  try {
    const stripeCustomerId = await resolveStripeCustomerId(stripe, supabase, data, idempotencyKey);

    const intent = await stripe.paymentIntents.create(
      {
        amount: Math.round(amount * 100),
        currency: "usd",
        customer: stripeCustomerId,
        capture_method: "manual",
        setup_future_usage: "off_session",
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        // No bookingId yet — this PaymentIntent is created before any
        // booking row exists. handleDumpsterRentalBooking() below updates
        // this same PaymentIntent's metadata with the real bookingId the
        // moment that row is successfully inserted (see step 4 there),
        // so the Stripe object is durably linked to the booking regardless
        // of anything that happens to this database afterward.
        metadata: { idempotencyKey: idempotencyKey, serviceType: "dumpster_rental" },
      },
      { idempotencyKey: "intent:" + idempotencyKey }
    );

    res.status(200).json({ ok: true, clientSecret: intent.client_secret, paymentIntentId: intent.id });
  } catch (err) {
    console.error("Create payment intent failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Payment is not available right now. Please call or text 303-990-1812." });
  }
}

// Repeat-client Stripe Customer reuse: if the submitted phone+email match
// exactly one existing local customer (the same Step 4a.3 rule used
// elsewhere in this file), and that customer has a prior rental_payments
// row with a stripe_customer_id on it, reuse that Stripe Customer instead
// of creating a new one for every rental the same person books. This
// project stores no dedicated customers.stripe_customer_id column — reusing
// the most recent per-booking record is a deliberately minimal way to get
// this without adding schema for a feature (cross-booking Stripe Customer
// tracking) nothing else here needs. Any lookup failure falls open to
// creating a fresh Stripe Customer, exactly like the analogous local
// customer-reuse lookup elsewhere in this file — this must never turn into
// a 500 or block payment.
async function resolveStripeCustomerId(stripe, supabase, data, idempotencyKey) {
  const phoneNorm = normalizePhone(data.customer.phone);
  const emailNorm = normalizeEmail(data.customer.email);

  if (emailNorm) {
    try {
      const { data: matches, error } = await supabase.from("customers").select("id").eq("phone_normalized", phoneNorm).eq("email_normalized", emailNorm);
      if (!error && Array.isArray(matches) && matches.length === 1) {
        const { data: pastBookings, error: bookingsErr } = await supabase.from("bookings").select("id").eq("customer_id", matches[0].id);
        const pastBookingIds = !bookingsErr && Array.isArray(pastBookings) ? pastBookings.map((b) => b.id) : [];
        if (pastBookingIds.length) {
          const { data: pastPayments, error: pastErr } = await supabase
            .from("rental_payments")
            .select("stripe_customer_id, created_at")
            .in("booking_id", pastBookingIds)
            .not("stripe_customer_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(1);
          if (!pastErr && Array.isArray(pastPayments) && pastPayments.length && pastPayments[0].stripe_customer_id) {
            return pastPayments[0].stripe_customer_id;
          }
        }
      }
    } catch (err) {
      console.error("Stripe Customer reuse lookup failed, creating a new Stripe Customer instead:", err);
    }
  }

  const customer = await stripe.customers.create(
    {
      name: data.customer.firstName + " " + data.customer.lastName,
      email: data.customer.email || undefined,
      phone: data.customer.phone,
    },
    { idempotencyKey: "customer:" + idempotencyKey }
  );
  return customer.id;
}

// ---------------------------------------------------------------------
// Phase 3C Stage 2.5-v2 — dumpster_rental booking + payment.
// ---------------------------------------------------------------------
// Reached only from module.exports' plain POST branch, only for
// data.serviceType === "dumpster_rental", only after validateBooking() has
// already confirmed every field (including payment.paymentIntentId/
// idempotencyKey/agreementAccepted) is present and well-formed.
// junk_removal/light_demo never reach this function. By the time this runs,
// handleCreatePaymentIntent() above has already authorized the card (a
// Stripe hold, not a charge) and the browser has confirmed it client-side
// via Stripe.js — this function's job is to claim the delivery slot and
// only THEN convert that authorization into an actual charge.
//
// Sequence (see docs/phase-3/stage2.5-stripe-rental-payments-migration.md
// for the full design and reasoning):
//   1. Idempotency check by payment.idempotencyKey — BEFORE any customer/
//      booking row is touched, so a retried/duplicated submit can never
//      create a second customer or double-charge.
//   2. Retrieve the PaymentIntent from Stripe and verify it's actually this
//      request's own authorized-but-uncaptured intent (status
//      "requires_capture", metadata.idempotencyKey matches) — never trust
//      the client-submitted paymentIntentId/amount for anything beyond
//      looking the object up.
//   3. Customer lookup/reuse — identical logic to the generic flow above.
//   4. Insert rental_payments FIRST, with payment_status: "processing" and
//      booking_id left NULL — this atomically claims the idempotency key
//      (via its own UNIQUE constraint) BEFORE the delivery slot is ever
//      touched. This ordering — the opposite of the original Braintree
//      design's — is the one real architectural change Stripe required:
//      because the PaymentIntent's authorization already exists by this
//      point, a same-key concurrent duplicate must be caught here, never
//      at the slot-uniqueness check below, or it could end up cancelling a
//      sibling request's still-needed shared authorization.
//   5. Insert bookings with status: "booked" directly (not left NULL) —
//      this insert is what the database's partial unique index
//      (idx_bookings_dumpster_delivery_slot) actually protects. A
//      collision here means a genuinely DIFFERENT customer just took this
//      exact delivery-date/time-window combination (our own idempotency
//      key was already uniquely claimed in step 4, so this can never be a
//      same-key duplicate) — the PaymentIntent's authorization is safely
//      CANCELLED (never captured — the hold is simply released), and the
//      customer is told to pick a different slot. A losing race never
//      gets charged, not even temporarily.
//   6. Link rental_payments.booking_id to the new booking, and (best-effort)
//      attach bookingId to the PaymentIntent's own metadata.
//   7. Insert dumpster_rentals — same as the generic flow.
//   8. Capture the PaymentIntent. Success -> update rental_payments to
//      "paid" and respond booked. Decline/error -> roll back every row
//      this request created (freeing the delivery slot immediately) and
//      respond with a customer-safe reason, never a generic 500 for an
//      actual decline.
async function handleDumpsterRentalBooking(res, supabase, data) {
  const idempotencyKey = data.payment.idempotencyKey;

  // 1. Idempotency check.
  let existingPayment;
  try {
    const { data: rows, error } = await supabase.from("rental_payments").select("id, booking_id, payment_status").eq("idempotency_key", idempotencyKey);
    if (error) throw error;
    existingPayment = Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (err) {
    console.error("Dumpster rental booking failed: idempotency lookup errored:", err);
    res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
    return;
  }

  if (existingPayment) {
    if (existingPayment.payment_status === "paid" || existingPayment.payment_status === "paid_reconciliation_required") {
      // A genuine repeat of an already-successful submit (double-click,
      // browser back/resubmit, a retried fetch) — return the same success
      // shape again rather than re-processing anything. No email is
      // re-sent; that already happened on the original successful attempt.
      // 'paid_reconciliation_required' is included here deliberately: that
      // status means Stripe DEFINITELY captured the charge (see the
      // capture() success block below) — the customer genuinely is booked,
      // even though our own confirmation record is incomplete. That's an
      // admin reconciliation concern, never a reason to tell the customer
      // anything other than the truth.
      res.status(200).json(withUploadToken(existingPayment.booking_id, { ok: true, booked: true }));
      return;
    }
    if (existingPayment.payment_status === "error_pending_review") {
      // A previous attempt with this exact idempotency key had an
      // ambiguous Stripe outcome (see the capture() catch block below) —
      // never silently retried. The customer must call in so a human can
      // confirm what actually happened before anything moves forward.
      res.status(409).json({
        error: "There was a problem confirming a previous attempt for this exact request. Please call or text 303-990-1812 so we can sort it out before trying again — this avoids any risk of being charged twice.",
      });
      return;
    }
    // "processing" (a genuine concurrent duplicate racing the first
    // request) — any other lingering status shouldn't exist given the
    // rollback discipline below, but is treated identically, defensively.
    res.status(409).json({ error: "This booking is already being processed. Please wait a moment before trying again." });
    return;
  }

  const stripe = getStripeClient();
  if (!stripe) {
    console.error("Dumpster rental booking failed: STRIPE_SECRET_KEY not configured");
    res.status(500).json({ error: "Payment is not available right now. Please call or text 303-990-1812." });
    return;
  }

  // 2. Retrieve & verify the PaymentIntent handleCreatePaymentIntent()
  // already authorized. This is the one place a client-submitted value
  // (paymentIntentId) is trusted at all — and only to look the object up;
  // every fact used below (amount, whether it's actually authorized, which
  // idempotencyKey it belongs to) comes back from Stripe itself, never
  // from the request body.
  const amount = rentalPricing.baseRentalAmount();
  const paymentIntentId = data.payment.paymentIntentId;
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (err) {
    console.error("Dumpster rental booking failed: could not retrieve PaymentIntent " + paymentIntentId + ":", err && err.message ? err.message : err);
    res.status(400).json({ error: "We couldn't find your payment authorization. Please go back and try again." });
    return;
  }
  if (!intent || !intent.metadata || intent.metadata.idempotencyKey !== idempotencyKey) {
    // Guards against a paymentIntentId that doesn't belong to this exact
    // checkout attempt — e.g. a stale id from an abandoned earlier session.
    res.status(400).json({ error: "Invalid payment session. Please refresh the page and try again." });
    return;
  }
  if (intent.status !== "requires_capture") {
    // Any definitive decline or in-page validation failure was already
    // surfaced to the customer by Stripe.js's own confirmPayment() before
    // this endpoint was ever called (see book/book.js) — reaching here with
    // a status other than "requires_capture" means the authorization
    // expired, was already cancelled/captured, or never actually completed
    // client-side. Never proceed to claim a delivery slot or attempt a
    // capture against an intent that isn't a live, authorized hold.
    res.status(402).json({ error: "Your payment could not be confirmed. Please go back to Review and try again." });
    return;
  }
  if (intent.amount !== Math.round(amount * 100)) {
    // Defense in depth — amount is always server-set at PaymentIntent
    // creation time (handleCreatePaymentIntent), so this should never
    // actually mismatch. Treated as a hard stop rather than trusting
    // anything else about this PaymentIntent if it ever does.
    console.error("Dumpster rental booking: PaymentIntent amount mismatch — expected " + Math.round(amount * 100) + ", got " + intent.amount);
    res.status(400).json({ error: "Invalid payment session. Please refresh the page and try again." });
    return;
  }

  // 3. Customer lookup/reuse — identical rule to the generic flow's own
  // Step 4a.3 logic above (kept as a separate, deliberately duplicated
  // block rather than a shared helper — see that flow's own comment for
  // why repeat-client reuse lives inline per call site in this file).
  const phoneNorm = normalizePhone(data.customer.phone);
  const emailNorm = normalizeEmail(data.customer.email);
  let customerId = null;
  if (emailNorm) {
    try {
      const { data: matches, error } = await supabase.from("customers").select("id").eq("phone_normalized", phoneNorm).eq("email_normalized", emailNorm);
      if (!error && Array.isArray(matches) && matches.length === 1) {
        customerId = matches[0].id;
      }
    } catch (err) {
      console.error("Repeat-client lookup failed, creating a new customer instead:", err);
    }
  }

  let customerWasCreated = false;
  if (customerId === null) {
    try {
      const { data: customerRow, error } = await supabase
        .from("customers")
        .insert({
          first_name: data.customer.firstName,
          last_name: data.customer.lastName || null,
          phone: data.customer.phone,
          email: data.customer.email || null,
          address: data.customer.streetAddress,
          city: data.customer.city,
          state: data.customer.state,
          zip: data.customer.zip,
          phone_normalized: phoneNorm,
          email_normalized: emailNorm,
        })
        .select("id")
        .single();
      if (error || !customerRow) {
        console.error("Dumpster rental booking failed creating customer:", error);
        await cancelPaymentIntent(stripe, paymentIntentId);
        res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
        return;
      }
      customerId = customerRow.id;
      customerWasCreated = true;
    } catch (err) {
      console.error("Dumpster rental booking failed creating customer:", err);
      await cancelPaymentIntent(stripe, paymentIntentId);
      res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
      return;
    }
  }

  // 4. Insert rental_payments ("processing", booking_id: null) FIRST —
  // claims the idempotency key as its own atomic, unique DB operation
  // BEFORE the delivery slot is ever touched. This ordering (rental_payments
  // before bookings) is deliberately the opposite of the original Braintree
  // design's and is the one real architectural change this Stripe migration
  // required: because a Stripe PaymentIntent's authorization already exists
  // by this point (created in handleCreatePaymentIntent(), before any DB
  // row does), a concurrent duplicate submission sharing this SAME
  // idempotency key must be caught here — atomically, via
  // rental_payments.idempotency_key's UNIQUE constraint — before it could
  // ever reach the bookings-slot-uniqueness check and risk cancelling a
  // sibling request's still-needed shared authorization. booking_id starts
  // NULL (the column is UNIQUE but nullable — Postgres allows multiple
  // NULLs under a UNIQUE constraint) and is linked in step 6, once the
  // booking actually exists. See
  // docs/phase-3/stage2.5-stripe-rental-payments-migration.md for the full
  // reasoning.
  //
  // A UNIQUE-constraint collision here means a concurrent duplicate request
  // with the SAME idempotency key won the race — that request shares this
  // SAME PaymentIntent (Stripe's own idempotency key on the create call
  // guarantees it), so this branch must NOT cancel it: the other request
  // may be about to capture it successfully.
  let paymentRowId;
  try {
    const { data: paymentRow, error } = await supabase
      .from("rental_payments")
      .insert({
        booking_id: null,
        idempotency_key: idempotencyKey,
        payment_status: "processing",
        amount_charged: amount,
        // Rate-schedule snapshot (2026-09-18 hardening audit, §11) — frozen
        // at the moment of booking, never re-derived from possibly-changed
        // global config later. api/admin/booking.js's handleProposeCharge()
        // reads these back for THIS booking's overage charges in preference
        // to the current global rate.
        base_rate: rentalPricing.BASE_RATE,
        included_days: rentalPricing.INCLUDED_DAYS,
        included_tons: rentalPricing.INCLUDED_TONS,
        overage_ton_rate: rentalPricing.OVERAGE_TON_RATE,
        overage_day_rate: rentalPricing.OVERAGE_DAY_RATE,
        stripe_payment_intent_id: paymentIntentId,
        stripe_customer_id: intent.customer || null,
        agreement_version: rentalPricing.RENTAL_AGREEMENT_VERSION,
        agreement_accepted_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) {
      if (isUniqueViolation(error)) {
        if (customerWasCreated) await safeDelete(supabase, "customers", customerId);
        res.status(409).json({ error: "This booking is already being processed. Please wait a moment before trying again." });
        return;
      }
      throw error;
    }
    if (!paymentRow) throw new Error("Insert returned no row.");
    paymentRowId = paymentRow.id;
  } catch (err) {
    console.error("Dumpster rental booking failed creating rental_payments row:", err);
    if (customerWasCreated) await safeDelete(supabase, "customers", customerId);
    await cancelPaymentIntent(stripe, paymentIntentId);
    res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
    return;
  }

  // 5. Insert bookings with status: "booked" directly — this insert is what
  // the database's partial unique index (idx_bookings_dumpster_delivery_slot)
  // actually protects. A collision here means someone else just took this
  // exact delivery-date/time-window combination — and because step 4 above
  // already uniquely claimed OUR idempotency key, reaching here means we
  // are definitely not a same-key duplicate of whoever won the slot, so
  // cancelling our own distinct PaymentIntent is always safe.
  let bookingId;
  try {
    const { data: bookingRow, error } = await supabase
      .from("bookings")
      .insert({
        customer_id: customerId,
        service_type: "dumpster_rental",
        appointment_date: data.appointmentDate,
        time_window: data.schedule.timeWindow,
        status: "booked",
        description: data.description,
        service_address: data.customer.streetAddress,
        service_city: data.customer.city,
        service_state: data.customer.state,
        service_zip: data.customer.zip,
      })
      .select("id")
      .single();

    if (error) {
      if (isUniqueViolation(error)) {
        await rollbackDumpsterBooking(supabase, null, customerId, customerWasCreated, { stripe, paymentIntentId }, idempotencyKey);
        res.status(409).json({ error: "That delivery window was just booked by someone else. Please choose a different date or time." });
        return;
      }
      throw error;
    }
    if (!bookingRow) throw new Error("Insert returned no row.");
    bookingId = bookingRow.id;
  } catch (err) {
    console.error("Dumpster rental booking failed creating booking:", err);
    await rollbackDumpsterBooking(supabase, null, customerId, customerWasCreated, { stripe, paymentIntentId }, idempotencyKey);
    res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
    return;
  }

  // 6. Link rental_payments to the now-existing booking, and (best-effort)
  // attach bookingId to the PaymentIntent's own metadata on Stripe's side —
  // durable regardless of anything that happens to this database afterward
  // (the last-resort correlation path if every write below fails). Losing
  // the Stripe metadata write doesn't affect the charge's correctness, only
  // how easy it is to find by bookingId later — the idempotencyKey already
  // in metadata since creation remains the primary correlation key either
  // way, so it never blocks the booking. The rental_payments link-back
  // update, however, is treated as a real failure: if it doesn't land,
  // nothing has been charged yet, so a full rollback is still safe.
  try {
    const { error } = await supabase.from("rental_payments").update({ booking_id: bookingId, updated_at: new Date().toISOString() }).eq("id", paymentRowId);
    if (error) throw error;
  } catch (err) {
    console.error("Dumpster rental booking failed linking rental_payments to its booking:", err);
    await rollbackDumpsterBooking(supabase, bookingId, customerId, customerWasCreated, { stripe, paymentIntentId }, idempotencyKey);
    res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
    return;
  }
  try {
    await stripe.paymentIntents.update(paymentIntentId, { metadata: { idempotencyKey: idempotencyKey, serviceType: "dumpster_rental", bookingId: bookingId } });
  } catch (err) {
    console.error("Dumpster rental booking: failed to attach bookingId to PaymentIntent metadata (non-fatal):", err && err.message ? err.message : err);
  }

  // 7. Insert dumpster_rentals — same rollback pattern as the generic flow.
  try {
    const { error } = await supabase.from("dumpster_rentals").insert({
      booking_id: bookingId,
      delivery_date: data.jobDetails.deliveryDate,
      pickup_date: data.jobDetails.pickupDate,
      material_type: data.jobDetails.materialType,
      placement_notes: data.jobDetails.placementLocation,
    });
    if (error) throw error;
  } catch (err) {
    console.error("Dumpster rental booking failed creating dumpster_rentals row:", err);
    await rollbackDumpsterBooking(supabase, bookingId, customerId, customerWasCreated, { stripe, paymentIntentId }, idempotencyKey);
    res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
    return;
  }

  // 8. Capture the already-authorized PaymentIntent — this is the moment
  // money actually moves.
  //
  // 2026-09-18 hardening-audit-equivalent reasoning, carried over from the
  // original Braintree design and still load-bearing for Stripe:
  //   - The catch block below distinguishes a DEFINITIVE decline
  //     (err.type === "StripeCardError" — Stripe's own card network
  //     telling us plainly no money moved, safe to roll back and free the
  //     slot immediately) from an AMBIGUOUS failure (a network error,
  //     timeout, or any other Stripe error type — no definitive answer,
  //     the capture may have actually succeeded on Stripe's side). Rolling
  //     back on an ambiguous failure would be actively dangerous: deleting
  //     rental_payments would both lose our only record that a capture may
  //     have happened AND free the delivery slot for someone else to book
  //     (and pay for) while the first charge's fate is unknown. So the
  //     ambiguous path preserves every row exactly as-is and marks the
  //     payment "error_pending_review" for a human to reconcile against
  //     the Stripe Dashboard — never an automatic retry, never a silent
  //     rollback.
  //   - metadata.bookingId (set just above, right after the bookings
  //     insert succeeded) and metadata.idempotencyKey (set at PaymentIntent
  //     creation) are both standard, Dashboard-searchable Stripe fields —
  //     durable on Stripe's side regardless of anything that happens to
  //     this database afterward. This is the last-resort correlation path:
  //     if every local write below fails, an admin can search the Stripe
  //     Dashboard for either value and find the PaymentIntent directly.
  let captured;
  try {
    captured = await stripe.paymentIntents.capture(paymentIntentId, { expand: ["payment_method"] }, { idempotencyKey: "capture:" + idempotencyKey });
  } catch (err) {
    if (err && err.type === "StripeCardError") {
      // A definitive decline at capture time — rare (the authorization
      // already succeeded once) but possible (e.g. the card was cancelled
      // in the intervening minutes) — Stripe confirms no money moved, so
      // rolling back and freeing the slot immediately is correct and safe.
      console.error("Dumpster rental booking: payment declined at capture —", err.code, err.message);
      await rollbackDumpsterBooking(supabase, bookingId, customerId, customerWasCreated, { stripe, paymentIntentId }, idempotencyKey);
      res.status(402).json({ error: extractDeclineMessage(err) });
      return;
    }
    console.error(
      "AMBIGUOUS PAYMENT OUTCOME — Stripe capture call failed/threw, actual result unknown. Check the Stripe Dashboard for a PaymentIntent matching bookingId=" +
        bookingId +
        " idempotencyKey=" +
        idempotencyKey +
        " paymentIntentId=" +
        paymentIntentId +
        " amount=" +
        amount.toFixed(2) +
        " before any manual action:",
      err && err.stack ? err.stack : err
    );
    await markPaymentErrorPendingReview(supabase, bookingId, "Stripe capture request failed/timed out before a definitive response was received. Outcome unknown — check the Stripe Dashboard for PaymentIntent " + paymentIntentId + " before taking any action.");
    res.status(502).json({
      error: "We couldn't confirm your payment went through. Please do not submit again — call or text 303-990-1812 so we can confirm your charge before booking to avoid being charged twice.",
    });
    return;
  }

  if (!captured || captured.status !== "succeeded") {
    // Defensive: capture() resolving without throwing but not reaching
    // "succeeded" shouldn't normally happen for a card capture, but is
    // treated the same as a definitive decline rather than assumed safe.
    console.error("Dumpster rental booking: capture did not reach 'succeeded' — status=" + (captured && captured.status));
    await rollbackDumpsterBooking(supabase, bookingId, customerId, customerWasCreated, { stripe, paymentIntentId }, idempotencyKey);
    res.status(402).json({ error: "Your payment could not be completed. Please try again or use a different payment method." });
    return;
  }

  // 9. Success — finalize the payment row. The charge has ALREADY
  // happened at this point — every write below is best-effort persistence
  // of that fact, never a condition for whether the customer is told
  // they're booked (see the response at the end of this function, which
  // is unconditional from here on).
  const methodInfo = extractPaymentMethodInfo(captured.payment_method);

  // 2026-09-18 readiness-pass-equivalent reasoning, carried over from the
  // original Braintree design: a bounded, practical saga step, not
  // pretended atomicity — retry the full confirmation write a few times
  // (short backoff — a transient blip is the most likely real-world cause
  // of this specific write failing) before giving up on it. Wrapped in
  // try/catch, not just relying on retryUpdate's own internal catch,
  // because building the update payload itself never throws but this
  // stays defensive regardless.
  let confirmed = false;
  try {
    confirmed = await retryUpdate(
      () =>
        supabase
          .from("rental_payments")
          .update({
            payment_status: "paid",
            stripe_payment_intent_id: captured.id,
            stripe_customer_id: captured.customer || null,
            stripe_payment_method_id: methodInfo.id,
            payment_method_summary: methodInfo.summary,
            updated_at: new Date().toISOString(),
          })
          .eq("booking_id", bookingId),
      [150, 400]
    );
  } catch (err) {
    confirmed = false;
  }

  if (!confirmed) {
    // Every retry of the full update failed. Fall back to the smallest
    // possible write — just enough to durably record THAT Stripe succeeded
    // and WHICH PaymentIntent it was — in case the original failure was
    // shaped by the payload (e.g. one unexpected field) rather than a
    // total outage. This is deliberately a DIFFERENT status from "paid":
    // 'paid_reconciliation_required' means "Stripe definitely captured the
    // charge, but the full record could not be persisted" — never confused
    // with 'error_pending_review' ("outcome unknown"), and never reachable
    // by any retry/replay path (see the idempotency pre-check above and
    // rollbackDumpsterBooking, neither of which treat this status as
    // anything but a dead end requiring a human — api/stripe-webhook.js's
    // payment_intent.succeeded handler is the one path that can still
    // self-heal a row stuck here, once that asynchronous event arrives).
    let minimalConfirmed = false;
    try {
      minimalConfirmed = await retryUpdate(
        () =>
          supabase
            .from("rental_payments")
            .update({ payment_status: "paid_reconciliation_required", stripe_payment_intent_id: captured.id, updated_at: new Date().toISOString() })
            .eq("booking_id", bookingId),
        [150]
      );
    } catch (err) {
      minimalConfirmed = false;
    }

    // Whether or not even the minimal write succeeded, this is logged
    // loudly either way — Vercel logs are a real but last-resort trace;
    // the durable, database-independent one is the metadata set on the
    // Stripe PaymentIntent itself, above, which exists regardless of
    // anything that happens from here on.
    console.error(
      "CRITICAL: Stripe capture succeeded (status=succeeded) but rental_payments could not be fully confirmed after retries. " +
        (minimalConfirmed ? "Minimal fallback write (status + PaymentIntent id only) DID succeed — see rental_payments.payment_status='paid_reconciliation_required' for this booking. " : "Even the minimal fallback write failed — this booking's payment record does not reflect this charge at all. ") +
        "Search the Stripe Dashboard for PaymentIntent '" +
        captured.id +
        "' or metadata.bookingId='" +
        bookingId +
        "' to find this transaction. bookingId=" +
        bookingId +
        " stripePaymentIntentId=" +
        captured.id +
        " amount=" +
        amount.toFixed(2)
    );
  }

  await sendBookingNotificationEmail(data, { amount: amount, transactionId: captured.id, methodSummary: methodInfo.summary });

  // Unconditional success from here regardless of `confirmed` above — the
  // booking (status: "booked") and the delivery-slot claim both already
  // existed before capture was ever attempted (step 4), and Stripe has now
  // definitively confirmed the charge. Telling the customer anything other
  // than "booked" here would be false, and — per the explicit design
  // principle carried over from the original Braintree hardening pass —
  // the browser must never be nudged toward resubmitting a payment that
  // has already succeeded.
  res.status(200).json(withUploadToken(bookingId, { ok: true, booked: true }));
}

// Best-effort release of an authorized-but-not-yet-captured PaymentIntent's
// hold. Safe to call even if the intent was already cancelled/expired
// (Stripe's cancel() throws in that case; swallowed here) — never called
// once a capture has actually been attempted (see rollbackDumpsterBooking's
// own cancelIntent contract below, and the idempotency-race branch in step
// 6, which deliberately passes no cancelIntent at all).
async function cancelPaymentIntent(stripe, paymentIntentId) {
  try {
    await stripe.paymentIntents.cancel(paymentIntentId);
  } catch (err) {
    console.error("Could not cancel PaymentIntent " + paymentIntentId + " (may already be settled/canceled):", err && err.message ? err.message : err);
  }
}

// Deletes every row a dumpster-rental booking attempt may have created, in
// FK-safe order, freeing the delivery slot (and the idempotency key)
// immediately. Safe to call even when some of these rows were never
// created (each delete is a harmless no-op if nothing matches). Used for a
// failed insert partway through, and for a Stripe DECLINE (a definitive
// "no money moved" answer) — never for an ambiguous Stripe capture
// failure, where markPaymentErrorPendingReview() below is used instead
// specifically because deleting these rows in that case could destroy the
// only record of a possibly-successful charge.
//
// `bookingId` may be null (the rental_payments row is inserted in step 4,
// before bookings exists yet — see the sequence comment above) — deleting
// rental_payments by `idempotencyKey` (its own UNIQUE column) works
// regardless of whether booking_id has been linked yet, unlike deleting by
// booking_id which can't identify an unlinked row.
//
// `cancelIntent` is `{ stripe, paymentIntentId }` — always safe to pass
// here, since by the time this function can be reached, this exact
// idempotency key has already been uniquely claimed by step 4, meaning
// this is never a same-key duplicate racing a sibling that still needs the
// PaymentIntent alive (that race is instead caught earlier, atomically, by
// step 4's own unique-constraint branch, which never calls this function).
async function rollbackDumpsterBooking(supabase, bookingId, customerId, customerWasCreated, cancelIntent, idempotencyKey) {
  await safeDeleteByColumn(supabase, "rental_payments", "idempotency_key", idempotencyKey);
  await safeDeleteByColumn(supabase, "dumpster_rentals", "booking_id", bookingId);
  await safeDelete(supabase, "bookings", bookingId);
  if (customerWasCreated) {
    await safeDelete(supabase, "customers", customerId);
  }
  if (cancelIntent && cancelIntent.stripe && cancelIntent.paymentIntentId) {
    await cancelPaymentIntent(cancelIntent.stripe, cancelIntent.paymentIntentId);
  }
}

// Called only when the Stripe capture call itself threw with no definitive
// response. Never deletes anything: the booking, dumpster_rentals, and
// this rental_payments row all stay exactly as they are (the slot stays
// claimed, the idempotency key stays claimed), so neither a possibly-
// successful charge nor the evidence of it is ever destroyed. A human must
// resolve this by checking the Stripe Dashboard directly — this function
// only records why. (api/stripe-webhook.js's payment_intent.succeeded
// handler can also self-heal this row automatically if the asynchronous
// event later confirms the capture did succeed.)
async function markPaymentErrorPendingReview(supabase, bookingId, reason) {
  try {
    await supabase
      .from("rental_payments")
      .update({ payment_status: "error_pending_review", failure_reason: reason, updated_at: new Date().toISOString() })
      .eq("booking_id", bookingId);
  } catch (err) {
    console.error("CRITICAL: could not even record error_pending_review for bookingId=" + bookingId + " — reconcile manually via the Stripe Dashboard:", err);
  }
}

function isUniqueViolation(error) {
  return !!error && (error.code === "23505" || /duplicate key value violates unique constraint/i.test(String(error.message || "")));
}

// A customer-safe message for a declined/failed Stripe charge. Stripe's own
// card-error messages (err.message on a StripeCardError, e.g. "Your card
// was declined.") are already written to be shown to the cardholder, so
// they're used directly when present, falling back to a generic message
// that still clearly invites a retry with a different payment method —
// never a bare "something went wrong" for an actual decline, since that
// reads as a site error rather than a payment problem.
function extractDeclineMessage(err) {
  try {
    if (err && err.message) {
      return "Payment declined: " + err.message + " Please try a different payment method, or call or text 303-990-1812.";
    }
  } catch (e) {
    // fall through to the generic message below
  }
  return "Your payment could not be processed. Please check your payment details or try a different payment method.";
}

// Extracts the vaultable PaymentMethod id (never card data itself) and a
// display-safe summary from a captured PaymentIntent's expanded
// payment_method, regardless of which payment method the customer used.
// Returns an id of null (never throws) for a payment-method shape this
// doesn't recognize, so a future Stripe-supported method this code doesn't
// yet know about degrades to "no later-charge capability for this booking"
// rather than crashing the success path.
function extractPaymentMethodInfo(pm) {
  if (!pm || typeof pm !== "object") return { id: null, summary: "Payment method on file" };
  if (pm.card) {
    const last4 = pm.card.last4 || "????";
    const brand = pm.card.brand ? pm.card.brand.charAt(0).toUpperCase() + pm.card.brand.slice(1) : "Card";
    return { id: pm.id, summary: brand + " ending in " + last4 };
  }
  if (pm.cashapp) {
    const cashtag = pm.cashapp.cashtag;
    return { id: pm.id, summary: cashtag ? "Cash App Pay ($" + cashtag + ")" : "Cash App Pay" };
  }
  if (pm.us_bank_account) {
    const last4 = pm.us_bank_account.last4 || "????";
    return { id: pm.id, summary: "Bank account ending in " + last4 };
  }
  return { id: pm.id || null, summary: "Payment method on file" };
}

// Mints the same short-lived photo-upload token every other success path in
// this file returns, merged into `body`. Kept as one small helper since
// handleDumpsterRentalBooking() above needs it from two different places
// (the idempotent-replay branch and the real success branch).
function withUploadToken(bookingId, body) {
  const uploadTokenSecret = process.env.UPLOAD_TOKEN_SECRET;
  if (!uploadTokenSecret) {
    console.error("Dumpster rental booking succeeded but UPLOAD_TOKEN_SECRET is not configured — photo upload will be unavailable for this booking.");
    return body;
  }
  return Object.assign({}, body, { uploadToken: signUploadToken(bookingId, uploadTokenSecret) });
}

// Admin notification email via Resend, mirroring the raw-fetch pattern already
// used in api/contact.js (no @resend/node dependency in this project). Reuses
// the same RESEND_API_KEY / RESEND_FROM_EMAIL / CONTACT_TO_EMAIL env vars —
// no new sending identity or recipient variable is introduced. Every failure
// path here only logs server-side and returns normally: this function must
// never throw, since its caller awaits it in the middle of an already-
// successful booking response.
//
// `paymentInfo` (Phase 3C Stage 2.5-v2) is only ever passed by
// handleDumpsterRentalBooking(), after a successful Stripe charge —
// junk_removal/light_demo always call this with just `data`, and the
// subject/body render exactly as before this stage for them.
async function sendBookingNotificationEmail(data, paymentInfo) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("Booking notification email skipped: RESEND_API_KEY is not configured.");
    return;
  }

  try {
    const fromEmail = process.env.RESEND_FROM_EMAIL || "Mile High Junk Removal <leads@milehighjunkremoval.net>";
    const toEmail = process.env.CONTACT_TO_EMAIL || "contact@milehighjunkremoval.net";
    const serviceLabel = SERVICE_LABELS[data.serviceType] || data.serviceType;
    const customerName = data.customer.firstName + " " + data.customer.lastName;
    const subjectPrefix = paymentInfo ? "New Booking (Paid) — " : "New Booking Request — ";

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: subjectPrefix + serviceLabel + " — " + customerName,
        html: buildBookingNotificationHtml(data, serviceLabel, customerName, paymentInfo),
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error("Booking notification email failed:", resendRes.status, errText);
    }
  } catch (err) {
    console.error("Booking notification email failed:", err && err.stack ? err.stack : err);
  }
}

// Presentation only — every value that reaches the HTML goes through
// escapeHtml() (via infoRowText/infoRow's callers below) or is a
// server-derived href built from safe parts (digits-only for tel:,
// encodeURIComponent for the Maps query string), never raw customer input
// concatenated straight into an attribute. `paymentInfo` is server-derived
// (Stripe's own response + the authoritative rental-pricing amount,
// never anything customer-submitted) so it needs no separate escaping
// discipline beyond what infoRowText already applies.
function buildBookingNotificationHtml(data, serviceLabel, customerName, paymentInfo) {
  const c = data.customer;
  const j = data.jobDetails;

  const telHref = buildTelHref(c.phone);
  const phoneValueHtml = telHref
    ? '<a href="' + escapeHtml(telHref) + '" style="color:#2f6f13;text-decoration:none;">' + escapeHtml(c.phone) + "</a>"
    : escapeHtml(c.phone);

  let customerSection = sectionHeading("Customer") + infoRow("Phone", phoneValueHtml);
  if (c.email) {
    const mailtoHtml =
      '<a href="mailto:' + escapeHtml(c.email) + '" style="color:#2f6f13;text-decoration:none;">' + escapeHtml(c.email) + "</a>";
    customerSection += infoRow("Email", mailtoHtml);
  }

  const appointmentSection =
    sectionHeading("Requested Appointment") +
    infoRowText("Requested Date", formatHumanDate(data.appointmentDate)) +
    infoRowText("Requested Time / Window", TIME_WINDOW_LABELS[data.schedule.timeWindow] || data.schedule.timeWindow);

  const mapsQuery = c.streetAddress + ", " + c.city + ", " + c.state + " " + c.zip;
  const mapsHref = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(mapsQuery);
  const addressValueHtml =
    '<a href="' + escapeHtml(mapsHref) + '" style="color:#2f6f13;text-decoration:none;">' +
    escapeHtml(c.streetAddress) +
    "<br>" +
    escapeHtml(c.city + ", " + c.state + " " + c.zip) +
    "</a>";
  const addressSection = sectionHeading("Service Address") + infoRow("Address", addressValueHtml);

  // Only the fields relevant to the selected service type are included —
  // nothing blank or irrelevant to other service types.
  let detailRows = "";
  if (data.serviceType === "junk_removal") {
    detailRows += infoRowText("Items to Remove", j.itemsDescription);
    detailRows += infoRowText("Pickup Location", j.location);
    detailRows += infoRowText("Stairs", STAIRS_LABELS[j.stairs] || j.stairs);
  } else if (data.serviceType === "dumpster_rental") {
    detailRows += infoRowText("Material Type", j.materialType);
    detailRows += infoRowText("Delivery Date", formatHumanDate(j.deliveryDate));
    detailRows += infoRowText("Pickup Date", formatHumanDate(j.pickupDate));
    detailRows += infoRowText("Placement Notes", j.placementLocation);
  } else if (data.serviceType === "light_demo") {
    detailRows += infoRowText("What Needs to Be Demolished", j.demoDescription);
    detailRows += infoRowText("Approximate Size", j.approximateSize);
    detailRows += infoRowText("Debris Removal Needed", j.debrisRemovalNeeded === "yes" ? "Yes" : "No");
  }
  if (j.additionalDetails) {
    detailRows += infoRowText("Additional Details", j.additionalDetails);
  }
  const jobDetailsSection = sectionHeading("Job Details") + detailRows;

  // Phase 3C Stage 2.5-v2 — only ever present for a paid dumpster_rental
  // booking (see sendBookingNotificationEmail's header comment). Renders as
  // an empty string for junk_removal/light_demo, leaving their email
  // byte-for-byte the same as before this stage.
  const paymentSection = paymentInfo
    ? sectionHeading("Payment") +
      infoRowText("Amount Charged", "$" + paymentInfo.amount.toFixed(2)) +
      infoRowText("Payment Method", paymentInfo.methodSummary) +
      infoRowText("Stripe PaymentIntent ID", paymentInfo.transactionId)
    : "";

  const fontStack = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const bannerText = paymentInfo ? "NEW BOOKING — PAID & CONFIRMED" : "NEW BOOKING REQUEST";

  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3e6;">' +
    '<tr><td align="center" style="padding:28px 14px;font-family:' +
    fontStack +
    ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e3e8dc;">' +
    // header
    '<tr><td style="background:#141414;padding:26px 30px 22px;">' +
    '<div style="color:#ffffff;font-size:13px;font-weight:700;letter-spacing:0.12em;opacity:0.85;">MILE HIGH JUNK REMOVAL</div>' +
    '<div style="color:#8ce85a;font-size:23px;font-weight:800;letter-spacing:0.02em;margin-top:6px;">' + bannerText + "</div>" +
    "</td></tr>" +
    // service + name banner
    '<tr><td style="background:#eaf7de;padding:18px 30px;border-bottom:1px solid #d7ecc4;">' +
    '<div style="font-size:19px;font-weight:800;color:#1c1c1c;">' +
    escapeHtml(serviceLabel) +
    " — " +
    escapeHtml(customerName) +
    "</div>" +
    "</td></tr>" +
    // customer
    '<tr><td style="padding:28px 30px 8px;">' + customerSection + "</td></tr>" +
    // appointment
    '<tr><td style="padding:14px 30px 8px;">' + appointmentSection + "</td></tr>" +
    // address
    '<tr><td style="padding:14px 30px 8px;">' + addressSection + "</td></tr>" +
    // job details
    '<tr><td style="padding:14px 30px' +
    (paymentSection ? " 8px" : " 28px") +
    ';">' + jobDetailsSection + "</td></tr>" +
    // payment (dumpster_rental only)
    (paymentSection ? '<tr><td style="padding:14px 30px 28px;">' + paymentSection + "</td></tr>" : "") +
    // photos footer
    '<tr><td style="background:#f6f8f2;padding:18px 30px;border-top:1px solid #ececec;">' +
    '<div style="font-size:12.5px;color:#666666;font-style:italic;line-height:1.5;">Customer may have uploaded photos with this booking. View Supabase to review booking photos.</div>' +
    "</td></tr>" +
    "</table>" +
    "</td></tr>" +
    "</table>"
  );
}

function sectionHeading(title) {
  return (
    '<div style="font-size:13px;font-weight:800;letter-spacing:0.09em;text-transform:uppercase;color:#3f7a1a;margin:0 0 14px;padding-bottom:8px;border-bottom:2px solid #dff0c9;">' +
    escapeHtml(title) +
    "</div>"
  );
}

// valueHtml must already be escaped/safely constructed by the caller — this
// function does not escape it, so every call site below either passes it
// through escapeHtml() directly (infoRowText) or builds an <a> tag from
// escapeHtml()-wrapped parts only (the phone/email/address blocks above).
function infoRow(label, valueHtml) {
  return (
    '<div style="margin:0 0 18px;">' +
    '<div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#8a8a8a;margin-bottom:4px;">' +
    escapeHtml(label) +
    "</div>" +
    '<div style="font-size:16px;color:#161616;font-weight:600;line-height:1.5;">' +
    valueHtml +
    "</div>" +
    "</div>"
  );
}

function infoRowText(label, value) {
  return infoRow(label, escapeHtml(String(value)).replace(/\n/g, "<br>"));
}

function formatHumanDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate))) return String(isoDate);
  try {
    const parsed = new Date(isoDate + "T00:00:00");
    if (Number.isNaN(parsed.getTime())) return isoDate;
    return parsed.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch (err) {
    return isoDate;
  }
}

// Builds a tel: href from digits only — never from the raw display string —
// so no customer-supplied character can end up inside the href attribute.
function buildTelHref(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.length === 10 ? "tel:+1" + digits : "tel:+" + digits;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function signUploadToken(bookingId, secret) {
  const payload = JSON.stringify({ bookingId, exp: Date.now() + UPLOAD_TOKEN_TTL_MS });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return payloadB64 + "." + sig;
}

// `options.requirePaymentMethod` (default true) controls whether a
// dumpster_rental submission must carry `payment.agreementAccepted`/
// `payment.paymentIntentId` — the two-phase Stripe flow validates the SAME
// booking payload twice:
//   - handleCreatePaymentIntent() (before any PaymentIntent exists yet,
//     and before the customer has necessarily checked the agreement box —
//     see the payment-panel UX note below) calls this with
//     `{ requirePaymentMethod: false }` — everything about the booking
//     itself must already be valid, but neither the agreement nor a
//     payment method is checked yet.
//   - the plain POST finalize path (module.exports, after the browser has
//     confirmed payment client-side) calls this with the default (true) —
//     both `payment.agreementAccepted` and `payment.paymentIntentId` must
//     be present.
// `payment.idempotencyKey` is required in BOTH calls either way, since
// it's what ties a PaymentIntent created in the first call back to the
// exact same checkout attempt in the second.
function validateBooking(body, options) {
  const requirePaymentMethod = !options || options.requirePaymentMethod !== false;
  if (!SERVICE_TYPES.includes(body.serviceType)) {
    return { ok: false, error: "Please choose a valid service." };
  }
  const serviceType = body.serviceType;

  const customerIn = body.customer && typeof body.customer === "object" ? body.customer : {};
  const firstName = sanitizeText(customerIn.firstName, MAX.name);
  const lastName = sanitizeText(customerIn.lastName, MAX.name);
  const phoneRaw = sanitizeText(customerIn.phone, MAX.phone);
  const emailRaw = sanitizeText(customerIn.email, MAX.email);
  const streetAddress = sanitizeText(customerIn.streetAddress, MAX.address);
  const city = sanitizeText(customerIn.city, MAX.city);
  const state = sanitizeText(customerIn.state, MAX.state).toUpperCase();
  const zip = sanitizeText(customerIn.zip, MAX.zip);

  if (!firstName) return { ok: false, error: "First name is required." };
  if (!lastName) return { ok: false, error: "Last name is required." };
  if (!phoneRaw) return { ok: false, error: "Phone number is required." };
  if (!isValidPhone(phoneRaw)) return { ok: false, error: "Please enter a valid phone number." };
  if (emailRaw && !isValidEmail(emailRaw)) return { ok: false, error: "Please enter a valid email address." };
  if (!streetAddress) return { ok: false, error: "Street address is required." };
  if (!city) return { ok: false, error: "City is required." };
  if (!/^[A-Z]{2}$/.test(state)) return { ok: false, error: "Please enter a valid 2-letter state." };
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return { ok: false, error: "Please enter a valid ZIP code." };

  const scheduleIn = body.schedule && typeof body.schedule === "object" ? body.schedule : {};
  const date = sanitizeText(scheduleIn.date, 10);
  const timeWindow = sanitizeText(scheduleIn.timeWindow, 20);

  const allowedWindows = TIME_WINDOWS_BY_SERVICE[serviceType] || [];
  if (!allowedWindows.includes(timeWindow)) {
    return { ok: false, error: "That time window isn't valid for this service. Please choose another time." };
  }

  // For dumpster_rental the delivery date collected below is the appointment date —
  // no generic preferred date is collected or required for that service type, so its
  // date + window are validated in the dumpster_rental branch below instead (against
  // deliveryDate), not here.
  if (serviceType !== "dumpster_rental") {
    if (!isValidDenverFutureDate(date)) {
      return { ok: false, error: "Please choose a valid preferred date." };
    }
    if (isTimeWindowExpired(date, timeWindow)) {
      return { ok: false, error: "That arrival window is no longer available. Please choose another time." };
    }
  }

  const jobIn = body.jobDetails && typeof body.jobDetails === "object" ? body.jobDetails : {};
  const additionalDetails = sanitizeText(jobIn.additionalDetails, MAX.long);
  let jobDetails = { additionalDetails: additionalDetails || null };
  let appointmentDate = date;
  // Only ever populated in the dumpster_rental branch below — stays null
  // for junk_removal/light_demo, which never carry payment fields at all.
  let payment = null;

  if (serviceType === "junk_removal") {
    const itemsDescription = sanitizeText(jobIn.itemsDescription, MAX.long);
    const location = sanitizeText(jobIn.location, MAX.short);
    const stairs = sanitizeText(jobIn.stairs, 30);
    if (!itemsDescription) return { ok: false, error: "Please describe what needs to be removed." };
    if (!location) return { ok: false, error: "Please tell us where the items are located." };
    if (!STAIRS_OPTIONS.includes(stairs)) return { ok: false, error: "Please select a stairs option." };
    jobDetails = { ...jobDetails, itemsDescription, location, stairs };
  } else if (serviceType === "dumpster_rental") {
    const materialType = sanitizeText(jobIn.materialType, MAX.short);
    const deliveryDate = sanitizeText(jobIn.deliveryDate, 10);
    const pickupDate = sanitizeText(jobIn.pickupDate, 10);
    const placementLocation = sanitizeText(jobIn.placementLocation, MAX.short);
    if (!materialType) return { ok: false, error: "Please describe the type of material." };
    if (!isValidDenverFutureDate(deliveryDate)) return { ok: false, error: "Please choose a valid delivery date." };
    if (isTimeWindowExpired(deliveryDate, timeWindow)) {
      return { ok: false, error: "That delivery window is no longer available. Please choose another time." };
    }
    // Pickup date has no associated time window and isn't part of this
    // date/time feature — kept on the original (non-Denver-specific) check.
    if (!isValidFutureDate(pickupDate)) return { ok: false, error: "Please choose a valid pickup date." };
    if (new Date(pickupDate) < new Date(deliveryDate)) {
      return { ok: false, error: "Pickup date must be on or after the delivery date." };
    }
    if (!placementLocation) return { ok: false, error: "Please tell us where the dumpster should be placed." };
    jobDetails = { ...jobDetails, materialType, deliveryDate, pickupDate, placementLocation };
    // The main bookings table stays useful for scheduling: for a dumpster rental,
    // appointment_date represents the requested delivery date, not the generic
    // "preferred date" collected in the schedule step.
    appointmentDate = deliveryDate;

    // Phase 3C Stage 2.5-v2 — required for every dumpster_rental submission,
    // and validated here alongside everything else so a missing/invalid
    // payment field fails exactly like a missing/invalid job-detail field
    // (a clean 400, before any Supabase or Stripe call). See
    // handleCreatePaymentIntent()/handleDumpsterRentalBooking() for what
    // happens with this once validation passes.
    const paymentIn = body.payment && typeof body.payment === "object" && !Array.isArray(body.payment) ? body.payment : {};
    const idempotencyKey = sanitizeText(paymentIn.idempotencyKey, MAX.idempotencyKey);
    // A UUID (crypto.randomUUID(), what book/book.js actually generates) —
    // checked defensively rather than trusted freeform, since this value
    // becomes a UNIQUE database column (rental_payments.idempotency_key)
    // and a Stripe idempotency key. Required at BOTH validation stages —
    // even PaymentIntent creation needs it, since it's what ties that
    // Stripe object back to this exact checkout attempt.
    if (!idempotencyKey || !/^[A-Za-z0-9-]{8,100}$/.test(idempotencyKey)) {
      return { ok: false, error: "Invalid request. Please refresh the page and try again." };
    }
    payment = { idempotencyKey: idempotencyKey };
    // agreementAccepted and paymentIntentId are both only required to
    // FINALIZE the booking (capture the charge) — not to create the
    // PaymentIntent/authorize a hold. This matches the pre-existing UX
    // (carried over from the original Braintree design): the payment
    // widget loads and the card can be entered as soon as the panel opens,
    // before the customer has necessarily checked the agreement box yet;
    // the checkbox is enforced (both client- and server-side) only when
    // they click "Pay & Book Now".
    if (requirePaymentMethod) {
      if (paymentIn.agreementAccepted !== true) {
        return { ok: false, error: "You must accept the rental agreement to book online." };
      }
      const paymentIntentId = sanitizeText(paymentIn.paymentIntentId, MAX.paymentIntentId);
      if (!paymentIntentId || !/^pi_[A-Za-z0-9_]{5,95}$/.test(paymentIntentId)) {
        return { ok: false, error: "Payment information is missing. Please try again." };
      }
      payment.paymentIntentId = paymentIntentId;
    }
  } else if (serviceType === "light_demo") {
    const demoDescription = sanitizeText(jobIn.demoDescription, MAX.long);
    const approximateSize = sanitizeText(jobIn.approximateSize, MAX.short);
    const debrisRemovalNeeded = sanitizeText(jobIn.debrisRemovalNeeded, 10);
    if (!demoDescription) return { ok: false, error: "Please describe what needs to be demolished." };
    if (!approximateSize) return { ok: false, error: "Please give an approximate size." };
    if (!YES_NO.includes(debrisRemovalNeeded)) return { ok: false, error: "Please select whether debris removal is needed." };
    jobDetails = { ...jobDetails, demoDescription, approximateSize, debrisRemovalNeeded };
  }

  return {
    ok: true,
    data: {
      serviceType,
      jobDetails,
      description: buildDescription(serviceType, jobDetails),
      appointmentDate,
      schedule: { date, timeWindow },
      payment,
      customer: {
        firstName,
        lastName,
        phone: phoneRaw,
        email: emailRaw || null,
        streetAddress,
        city,
        state,
        zip,
      },
    },
  };
}

function buildDescription(serviceType, jobDetails) {
  const lines = [];
  if (serviceType === "junk_removal") {
    lines.push("Items to remove: " + jobDetails.itemsDescription);
    lines.push("Location: " + jobDetails.location);
    lines.push("Stairs: " + (STAIRS_LABELS[jobDetails.stairs] || jobDetails.stairs));
  } else if (serviceType === "dumpster_rental") {
    lines.push("Material type: " + jobDetails.materialType);
    lines.push("Delivery date: " + jobDetails.deliveryDate);
    lines.push("Pickup date: " + jobDetails.pickupDate);
    lines.push("Placement: " + jobDetails.placementLocation);
  } else if (serviceType === "light_demo") {
    lines.push("What needs to be demolished: " + jobDetails.demoDescription);
    lines.push("Approximate size: " + jobDetails.approximateSize);
    lines.push("Debris removal needed: " + (jobDetails.debrisRemovalNeeded === "yes" ? "Yes" : "No"));
  }
  if (jobDetails.additionalDetails) {
    lines.push("Additional details: " + jobDetails.additionalDetails);
  }
  return lines.join("\n");
}

function sanitizeText(value, maxLen) {
  if (typeof value !== "string") return "";
  var stripped = "";
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    var isControl = code <= 31 && code !== 9 && code !== 10 && code !== 13;
    if (!isControl) stripped += value[i];
  }
  return stripped
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, maxLen);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= MAX.email;
}

function isValidPhone(value) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 && /^[0-9+()\-.\s]+$/.test(value);
}

function isValidFutureDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00");
  if (Number.isNaN(parsed.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parsed.getTime() >= today.getTime();
}

// Current America/Denver local time as {year, month (1–12), day, hour,
// minute} — deliberately never the server process's own local time (UTC on
// Vercel), so "today" and window-expiration checks match what the customer
// actually saw in the browser regardless of where this function runs. The
// IANA timeZone database entry for America/Denver resolves MST/MDT (DST)
// automatically, so no manual DST math is needed here. Mirrors the
// client-side getDenverNow() in book/book.js.
function getDenverNow() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = {};
  fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // some engines report midnight as "24" with hour12:false
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: hour,
    minute: parseInt(parts.minute, 10),
  };
}
function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}
function denverTodayIso() {
  const now = getDenverNow();
  return now.year + "-" + pad2(now.month) + "-" + pad2(now.day);
}

// Denver-timezone counterpart to isValidFutureDate() above, used for the
// schedule date (junk removal / light demo) and the dumpster delivery date —
// both of which pair with a time window and so must use the same "today" as
// the expiration check below. Zero-padded ISO (YYYY-MM-DD) strings compare
// correctly with a plain string comparison for "is it today or later", so no
// Date-object month/year rollover arithmetic is needed for that part. The
// Date.UTC() round-trip below only checks that the value is a real calendar
// date (rejects e.g. month 13 or day 40, which JS silently normalizes rather
// than erroring on) — UTC is used purely for that check, so it carries no
// timezone/DST ambiguity of its own.
function isValidDenverFutureDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  if (asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== m - 1 || asUtc.getUTCDate() !== d) return false;
  return value >= denverTodayIso();
}

// True only when `date` (already known to be today-or-later in Denver terms
// via isValidDenverFutureDate) is today in America/Denver AND the given
// window's start time has already passed. Future dates are never expired. An
// unrecognized window on today's date is treated as expired/unavailable
// rather than silently accepted — TIME_WINDOWS_BY_SERVICE is what actually
// enforces "is this a recognized/allowed window" and runs before this check.
function isTimeWindowExpired(date, timeWindowId) {
  if (date !== denverTodayIso()) return false;
  const def = TIME_WINDOW_DEFS[timeWindowId];
  if (!def) return true;
  const now = getDenverNow();
  const nowDecimalHour = now.hour + now.minute / 60;
  return def.startHour <= nowDecimalHour;
}
