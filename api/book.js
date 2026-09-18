// Vercel serverless function — creates a customer + booking (+ dumpster_rentals
// row when applicable) in Supabase from the /book/ multi-step form.
//
// Required environment variables (server-side only, never read by the browser):
//   SUPABASE_URL
//   SUPABASE_SECRET_KEY
//   UPLOAD_TOKEN_SECRET — signs the short-lived photo-upload token (see below)
//   BRAINTREE_ENVIRONMENT / BRAINTREE_MERCHANT_ID / BRAINTREE_PUBLIC_KEY /
//     BRAINTREE_PRIVATE_KEY — see api/_lib/braintree-client.js. Required only
//     for the dumpster_rental payment path (below); junk_removal/light_demo
//     never touch Braintree.
//   BRAINTREE_TOKENIZATION_KEY — read directly by GET (below), not through
//     api/_lib/braintree-client.js: a separate, non-secret, publishable-style
//     value echoed to the browser so Braintree Drop-in can initialize.
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
//                    amount_charged, braintree_transaction_id, braintree_customer_id,
//                    braintree_payment_method_token, payment_method_summary,
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
// review step), via Braintree. See
// docs/phase-3/stage2.5-rental-payments-v2-proposal.md for the full design.
// junk_removal and light_demo are completely unaffected — same validation,
// same insert sequence, same response shape as before this stage. GET is
// new (previously an unconditional 405): public, non-secret config the
// booking page needs before it can render Braintree Drop-in — see
// handlePublicConfig() below.

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const { getClientIp, isRateLimited, isHoneypotTripped, isSubmittedTooFast } = require("./_lib/spam-protection");
const { normalizePhone, normalizeEmail } = require("./_lib/customer-identity");
const { getBraintreeGateway } = require("./_lib/braintree-client");
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
  paymentNonce: 4096, // generous headroom — a real Braintree nonce is far shorter
  idempotencyKey: 100,
};

const MAX_BODY_BYTES = 20 * 1024; // plenty for a text-only booking form; no photo bytes travel through this endpoint

module.exports = async (req, res) => {
  try {
    // Phase 3C Stage 2.5-v2: public, non-secret config for the booking
    // page — the Braintree tokenization key, current rental pricing, the
    // agreement version, and (best-effort, non-authoritative — see
    // handlePublicConfig) which delivery slots already look taken. No spam
    // protection needed (nothing is written), but still IP-rate-limited as
    // cheap insurance against casual scraping, matching this endpoint's
    // existing defensive style.
    if (req.method === "GET") return handlePublicConfig(req, res);

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
// the Braintree tokenization key is designed by Braintree to be embedded
// in client code (same trust model as a Stripe publishable key — see
// docs/phase-3/stage2.5-rental-payments-v2-proposal.md §3), pricing is
// public marketing information already shown on dumpster-rental.html, and
// takenDeliverySlots carries no customer data (just date + time_window) and
// is explicitly a UX convenience, not an authority: the real availability
// enforcement is the database's own partial unique index, checked
// atomically at booking-insert time in handleDumpsterRentalBooking() below
// — a caller of this endpoint could return stale or fabricated data here
// and it would change nothing about what can actually be booked.
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
    braintree: {
      // Null when unconfigured rather than omitted — the client checks
      // this explicitly and shows "payment is temporarily unavailable"
      // rather than a confusing broken Drop-in widget. No separate
      // "environment" field: Braintree Drop-in infers sandbox vs.
      // production entirely from the tokenization key's own value, so
      // echoing BRAINTREE_ENVIRONMENT here too would just be a second,
      // potentially-inconsistent source of truth for the same fact.
      tokenizationKey: process.env.BRAINTREE_TOKENIZATION_KEY || null,
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
// Phase 3C Stage 2.5-v2 — dumpster_rental booking + payment.
// ---------------------------------------------------------------------
// Reached only from module.exports' POST branch, only for
// data.serviceType === "dumpster_rental", only after validateBooking() has
// already confirmed every field (including payment.nonce/idempotencyKey/
// agreementAccepted) is present and well-formed. junk_removal/light_demo
// never reach this function.
//
// Sequence (see docs/phase-3/stage2.5-rental-payments-v2-proposal.md §6 for
// the full design and reasoning):
//   1. Idempotency check by payment.idempotencyKey — BEFORE any customer/
//      booking row is touched, so a retried/duplicated submit can never
//      create a second customer or double-charge.
//   2. Customer lookup/reuse — identical logic to the generic flow above.
//   3. Insert bookings with status: "booked" directly (not left NULL) —
//      this insert is what the database's partial unique index
//      (idx_bookings_dumpster_delivery_slot) actually protects. A
//      collision here means someone else just took this exact
//      delivery-date/time-window combination; it's caught specifically and
//      turned into a clean 409, and — critically — Braintree is never
//      called for a slot that turned out to be unavailable, so a losing
//      race never touches the customer's card.
//   4. Insert dumpster_rentals — same as the generic flow.
//   5. Insert rental_payments with payment_status: "processing" — this row
//      plus the "booked" bookings row above together ARE the reservation
//      for the remainder of this one request.
//   6. Call Braintree. Success -> update rental_payments to "paid" and
//      respond booked. Failure/decline/error -> roll back every row this
//      request created (freeing the delivery slot immediately) and respond
//      with a customer-safe reason, never a generic 500 for an actual
//      decline.
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
      // status means Braintree DEFINITELY succeeded (see the sale()
      // success block below) — the customer genuinely is booked, even
      // though our own confirmation record is incomplete. That's an admin
      // reconciliation concern, never a reason to tell the customer
      // anything other than the truth.
      res.status(200).json(withUploadToken(existingPayment.booking_id, { ok: true, booked: true }));
      return;
    }
    if (existingPayment.payment_status === "error_pending_review") {
      // A previous attempt with this exact idempotency key had an
      // ambiguous Braintree outcome (see the sale() catch block below) —
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

  // 2. Customer lookup/reuse — identical rule to the generic flow's own
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
        res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
        return;
      }
      customerId = customerRow.id;
      customerWasCreated = true;
    } catch (err) {
      console.error("Dumpster rental booking failed creating customer:", err);
      res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
      return;
    }
  }

  // 3. Authoritative price — NEVER trust a client-submitted amount. This is
  // the only dollar figure Braintree is ever asked to charge below.
  const amount = rentalPricing.baseRentalAmount();

  // 4. Insert bookings with status: "booked" directly.
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
        if (customerWasCreated) await safeDelete(supabase, "customers", customerId);
        res.status(409).json({ error: "That delivery window was just booked by someone else. Please choose a different date or time." });
        return;
      }
      throw error;
    }
    if (!bookingRow) throw new Error("Insert returned no row.");
    bookingId = bookingRow.id;
  } catch (err) {
    console.error("Dumpster rental booking failed creating booking:", err);
    if (customerWasCreated) await safeDelete(supabase, "customers", customerId);
    res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
    return;
  }

  // 5. Insert dumpster_rentals — same rollback pattern as the generic flow.
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
    await rollbackDumpsterBooking(supabase, bookingId, customerId, customerWasCreated);
    res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
    return;
  }

  // 6. Insert rental_payments ("processing") — claims the idempotency key.
  // A UNIQUE-constraint collision here (the backstop for a race this
  // function's own pre-check at step 1 can't fully close) means a
  // concurrent duplicate request with the same key won the race.
  try {
    const { error } = await supabase.from("rental_payments").insert({
      booking_id: bookingId,
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
      agreement_version: rentalPricing.RENTAL_AGREEMENT_VERSION,
      agreement_accepted_at: new Date().toISOString(),
    });
    if (error) {
      if (isUniqueViolation(error)) {
        await rollbackDumpsterBooking(supabase, bookingId, customerId, customerWasCreated);
        res.status(409).json({ error: "This booking is already being processed. Please wait a moment before trying again." });
        return;
      }
      throw error;
    }
  } catch (err) {
    console.error("Dumpster rental booking failed creating rental_payments row:", err);
    await rollbackDumpsterBooking(supabase, bookingId, customerId, customerWasCreated);
    res.status(500).json({ error: "Could not submit your booking. Please try again or call us." });
    return;
  }

  // 7. Charge via Braintree.
  const gateway = getBraintreeGateway();
  if (!gateway) {
    console.error("Dumpster rental booking failed: BRAINTREE_* environment variables not configured");
    await rollbackDumpsterBooking(supabase, bookingId, customerId, customerWasCreated);
    res.status(500).json({ error: "Payment is not available right now. Please call or text 303-990-1812." });
    return;
  }

  // 2026-09-18 hardening audit, §6 — the distinction below is deliberate
  // and load-bearing, not stylistic:
  //   - The catch block below means the transaction.sale() CALL ITSELF
  //     failed (network error, timeout, gateway 5xx) — Braintree may or
  //     may not have actually processed the charge; we have NO definitive
  //     answer and, critically, no transaction id to look up or void. This
  //     is AMBIGUOUS, not a decline. Rolling everything back here would be
  //     actively dangerous: if the charge in fact succeeded on Braintree's
  //     side, deleting rental_payments (freeing the idempotency key and the
  //     delivery slot) would both lose our only record that a real charge
  //     may have happened AND let the slot be re-sold/re-charged to someone
  //     else. So this path preserves every row exactly as-is and marks the
  //     payment "error_pending_review" for a human to reconcile against the
  //     Braintree dashboard — never an automatic retry, never a silent
  //     rollback.
  //   - The `!saleResult.success` branch further below is a DEFINITIVE
  //     answer from Braintree (a clean decline or a request-validation
  //     failure) — Braintree is explicitly telling us no money moved, so
  //     rolling back and freeing the slot immediately is correct and safe.
  // 2026-09-18 readiness pass, §2-3 — orderId is a standard, searchable
  // Braintree transaction field (Control Panel search + the Search API),
  // set here as part of the SAME request that creates the charge — so it
  // exists on the Braintree transaction regardless of anything that
  // happens afterward, including a total Supabase outage. This is the
  // last-resort correlation path: if every local write below fails, an
  // admin can search the Braintree dashboard for orderId = this booking's
  // id and find the transaction directly. Deliberately just the internal
  // booking UUID — no name, address, phone, or other customer data ever
  // reaches Braintree's metadata.
  let saleResult;
  try {
    saleResult = await gateway.transaction.sale({
      amount: amount.toFixed(2),
      paymentMethodNonce: data.payment.nonce,
      orderId: bookingId,
      options: { submitForSettlement: true, storeInVaultOnSuccess: true },
    });
  } catch (err) {
    console.error(
      "AMBIGUOUS PAYMENT OUTCOME — Braintree call threw, actual result unknown. Check the Braintree dashboard for a transaction matching bookingId=" +
        bookingId +
        " idempotencyKey=" +
        idempotencyKey +
        " amount=" +
        amount.toFixed(2) +
        " before any manual action:",
      err && err.stack ? err.stack : err
    );
    await markPaymentErrorPendingReview(supabase, bookingId, "Braintree request failed/timed out before a response was received. Outcome unknown — check the Braintree dashboard for a matching transaction before taking any action.");
    res.status(502).json({
      error: "We couldn't confirm your payment went through. Please do not submit again — call or text 303-990-1812 so we can confirm your charge before booking to avoid being charged twice.",
    });
    return;
  }

  if (!saleResult || !saleResult.success) {
    // A definitive decline/validation failure — Braintree confirms no
    // money moved, so this is the one branch where a full rollback
    // (freeing the slot immediately) is genuinely safe.
    console.error("Dumpster rental booking: payment declined —", describeDeclineForLogs(saleResult));
    await rollbackDumpsterBooking(supabase, bookingId, customerId, customerWasCreated);
    res.status(402).json({ error: extractDeclineMessage(saleResult) });
    return;
  }

  // 8. Success — finalize the payment row. The charge has ALREADY
  // happened at this point — every write below is best-effort persistence
  // of that fact, never a condition for whether the customer is told
  // they're booked (see the response at the end of this function, which
  // is unconditional from here on).
  const txn = saleResult.transaction;
  const methodInfo = extractPaymentMethodInfo(txn);

  // 2026-09-18 readiness pass, §2-3 — a bounded, practical saga step, not
  // pretended atomicity: retry the full confirmation write a few times
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
            braintree_transaction_id: txn.id,
            braintree_customer_id: txn.customer && txn.customer.id ? txn.customer.id : null,
            braintree_payment_method_token: methodInfo.token,
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
    // possible write — just enough to durably record THAT Braintree
    // succeeded and WHICH transaction it was — in case the original
    // failure was shaped by the payload (e.g. one unexpected field) rather
    // than a total outage. This is deliberately a DIFFERENT status from
    // "paid": 'paid_reconciliation_required' means "Braintree definitely
    // succeeded, but the full record could not be persisted" — never
    // confused with 'error_pending_review' ("outcome unknown"), and never
    // reachable by any retry/replay path (see the idempotency pre-check
    // above and rollbackDumpsterBooking, neither of which treat this
    // status as anything but a dead end requiring a human).
    let minimalConfirmed = false;
    try {
      minimalConfirmed = await retryUpdate(
        () =>
          supabase
            .from("rental_payments")
            .update({ payment_status: "paid_reconciliation_required", braintree_transaction_id: txn.id, updated_at: new Date().toISOString() })
            .eq("booking_id", bookingId),
        [150]
      );
    } catch (err) {
      minimalConfirmed = false;
    }

    // Whether or not even the minimal write succeeded, this is logged
    // loudly either way — Vercel logs are a real but last-resort trace;
    // the durable, database-independent one is the orderId set on the
    // Braintree transaction itself, above, which exists regardless of
    // anything that happens from here on.
    console.error(
      "CRITICAL: Braintree charge succeeded (transaction.sale() success=true) but rental_payments could not be fully confirmed after retries. " +
        (minimalConfirmed ? "Minimal fallback write (status + transaction id only) DID succeed — see rental_payments.payment_status='paid_reconciliation_required' for this booking. " : "Even the minimal fallback write failed — this booking's payment record does not reflect this charge at all. ") +
        "Search the Braintree dashboard for orderId='" +
        bookingId +
        "' to find this transaction. bookingId=" +
        bookingId +
        " braintreeTransactionId=" +
        txn.id +
        " amount=" +
        amount.toFixed(2)
    );
  }

  await sendBookingNotificationEmail(data, { amount: amount, transactionId: txn.id, methodSummary: methodInfo.summary });

  // Unconditional success from here regardless of `confirmed` above — the
  // booking (status: "booked") and the delivery-slot claim both already
  // existed before Braintree was ever called (step 4), and Braintree has
  // now definitively confirmed the charge. Telling the customer anything
  // other than "booked" here would be false, and — per the explicit design
  // principle this pass confirmed — the browser must never be nudged
  // toward resubmitting a payment that has already succeeded.
  res.status(200).json(withUploadToken(bookingId, { ok: true, booked: true }));
}

// Deletes every row a dumpster-rental booking attempt may have created, in
// FK-safe order, freeing the delivery slot (and the idempotency key)
// immediately. Safe to call even when some of these rows were never
// created (each delete is a harmless no-op if nothing matches). Used for a
// failed insert partway through, and for a Braintree DECLINE (a definitive
// "no money moved" answer) — never for an ambiguous Braintree call
// failure, where markPaymentErrorPendingReview() below is used instead
// specifically because deleting these rows in that case could destroy the
// only record of a possibly-successful charge.
async function rollbackDumpsterBooking(supabase, bookingId, customerId, customerWasCreated) {
  await safeDeleteByColumn(supabase, "rental_payments", "booking_id", bookingId);
  await safeDeleteByColumn(supabase, "dumpster_rentals", "booking_id", bookingId);
  await safeDelete(supabase, "bookings", bookingId);
  if (customerWasCreated) {
    await safeDelete(supabase, "customers", customerId);
  }
}

// 2026-09-18 hardening audit, §6 — called only when gateway.transaction.sale()
// itself threw (no definitive response from Braintree). Never deletes
// anything: the booking, dumpster_rentals, and this rental_payments row all
// stay exactly as they are (the slot stays claimed, the idempotency key
// stays claimed), so neither a possibly-successful charge nor the evidence
// of it is ever destroyed. A human must resolve this by checking the
// Braintree dashboard directly — this function only records why.
async function markPaymentErrorPendingReview(supabase, bookingId, reason) {
  try {
    await supabase
      .from("rental_payments")
      .update({ payment_status: "error_pending_review", failure_reason: reason, updated_at: new Date().toISOString() })
      .eq("booking_id", bookingId);
  } catch (err) {
    console.error("CRITICAL: could not even record error_pending_review for bookingId=" + bookingId + " — reconcile manually via the Braintree dashboard:", err);
  }
}

function isUniqueViolation(error) {
  return !!error && (error.code === "23505" || /duplicate key value violates unique constraint/i.test(String(error.message || "")));
}

// A customer-safe message for a declined/failed Braintree sale. Prefers
// Braintree's own processor-response text (written by Braintree/the card
// networks specifically to be shown to the cardholder, e.g. "Do Not
// Honor") when present, falling back to a generic message that still
// clearly invites a retry with a different payment method — never a bare
// "something went wrong" for an actual decline, since that reads as a site
// error rather than a payment problem.
function extractDeclineMessage(saleResult) {
  try {
    const txn = saleResult && saleResult.transaction;
    if (txn && txn.processorResponseText) {
      return "Payment declined: " + txn.processorResponseText + ". Please try a different payment method, or call or text 303-990-1812.";
    }
    if (saleResult && saleResult.message) {
      return "Your payment could not be processed. Please check your payment details and try again, or try a different payment method.";
    }
  } catch (err) {
    // fall through to the generic message below
  }
  return "Your payment could not be processed. Please check your payment details or try a different payment method.";
}

// Server-log-only detail (never sent to the client) — kept separate from
// extractDeclineMessage() so a change to the customer-facing wording can
// never accidentally also change what gets logged, or vice versa.
function describeDeclineForLogs(saleResult) {
  try {
    if (saleResult && saleResult.transaction) {
      return "status=" + saleResult.transaction.status + " processorResponseText=" + saleResult.transaction.processorResponseText;
    }
    if (saleResult && saleResult.message) {
      return saleResult.message;
    }
  } catch (err) {
    // fall through
  }
  return "unknown reason (no transaction/message on result)";
}

// Extracts the vaultable payment-method token (never card data itself) and
// a display-safe summary from a successful transaction result, regardless
// of which payment method the customer used. Returns a token of null (never
// throws) for a payment-method shape this doesn't recognize, so a future
// Braintree-supported method this code doesn't yet know about degrades to
// "no later-charge capability for this booking" rather than crashing the
// success path.
function extractPaymentMethodInfo(txn) {
  if (txn.creditCard && txn.creditCard.token) {
    const last4 = txn.creditCard.last4 || "????";
    const cardType = txn.creditCard.cardType || "Card";
    return { token: txn.creditCard.token, summary: cardType + " ending in " + last4 };
  }
  if (txn.venmoAccount && txn.venmoAccount.token) {
    const username = txn.venmoAccount.username;
    return { token: txn.venmoAccount.token, summary: username ? "Venmo (@" + username + ")" : "Venmo" };
  }
  if (txn.paypalAccount && txn.paypalAccount.token) {
    return { token: txn.paypalAccount.token, summary: txn.paypalAccount.payerEmail ? "PayPal (" + txn.paypalAccount.payerEmail + ")" : "PayPal" };
  }
  return { token: null, summary: "Payment method on file" };
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
// handleDumpsterRentalBooking(), after a successful Braintree charge —
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
// (Braintree's own response + the authoritative rental-pricing amount,
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
      infoRowText("Braintree Transaction ID", paymentInfo.transactionId)
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

function validateBooking(body) {
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
    // (a clean 400, before any Supabase or Braintree call). See
    // handleDumpsterRentalBooking() for what happens with this once
    // validation passes.
    const paymentIn = body.payment && typeof body.payment === "object" && !Array.isArray(body.payment) ? body.payment : {};
    const paymentNonce = sanitizeText(paymentIn.nonce, MAX.paymentNonce);
    const idempotencyKey = sanitizeText(paymentIn.idempotencyKey, MAX.idempotencyKey);
    const agreementAccepted = paymentIn.agreementAccepted === true;
    if (!paymentNonce) return { ok: false, error: "Payment information is missing. Please try again." };
    // A UUID (crypto.randomUUID(), what book/book.js actually generates) —
    // checked defensively rather than trusted freeform, since this value
    // becomes a UNIQUE database column.
    if (!idempotencyKey || !/^[A-Za-z0-9-]{8,100}$/.test(idempotencyKey)) {
      return { ok: false, error: "Invalid request. Please refresh the page and try again." };
    }
    if (!agreementAccepted) {
      return { ok: false, error: "You must accept the rental agreement to book online." };
    }
    payment = { nonce: paymentNonce, idempotencyKey: idempotencyKey };
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
