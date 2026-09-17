// Vercel serverless function — single-booking detail including short-lived
// signed photo URLs (GET), and, as of Phase 3C Stage 2.1, job creation for
// "+ New Job" (POST). See api/_lib/admin-auth.js: requireAdmin() gates this
// entire route before either the `id` query param or the request body is
// ever looked at.
//
// IDOR note (GET): the booking id in the URL identifies *which* record is
// being asked for — it never authorizes the request by itself. Every code
// path below runs only after requireAdmin() has already confirmed the
// caller is an authenticated, allowlisted admin; changing `?id=` to another
// booking's id changes which (authorized) record comes back, never whether
// the request is authorized at all.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");
const { serviceLabel, timeWindowLabel, statusLabel, normalizedStatus, SERVICE_LABELS } = require("../_lib/booking-format");
const { TIME_WINDOW_DEFS } = require("../_lib/time-windows");

const BUCKET = "booking-photos";
const PHOTO_URL_TTL_SECONDS = 300; // 5 minutes — short-lived by design, minted fresh on every request, never cached or persisted
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  if (req.method === "POST") return handleCreate(req, res);

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
  if (!id) {
    res.status(400).json({ error: "Booking id is required." });
    return;
  }
  if (!UUID_RE.test(id)) {
    // A malformed id can never match a real row. Treated identically to
    // "not found" rather than a distinct 400, so the response never
    // confirms anything about id format/validation to the caller.
    res.status(404).json({ error: "Booking not found." });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin booking detail failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  try {
    const bookingRes = await supabase
      .from("bookings")
      .select(
        "id, service_type, appointment_date, time_window, status, description, estimated_price, final_price, internal_notes, created_at, customer_id, service_address, service_city, service_state, service_zip"
      )
      .eq("id", id)
      .maybeSingle();
    if (bookingRes.error) throw bookingRes.error;

    const booking = bookingRes.data;
    if (!booking) {
      res.status(404).json({ error: "Booking not found." });
      return;
    }

    const [customerRes, dumpsterRes, photosRes] = await Promise.all([
      supabase
        .from("customers")
        .select("first_name, last_name, phone, email, address, city, state, zip")
        .eq("id", booking.customer_id)
        .maybeSingle(),
      supabase.from("dumpster_rentals").select("delivery_date, pickup_date, material_type, placement_notes").eq("booking_id", id).maybeSingle(),
      supabase.from("booking_photos").select("id, storage_path, created_at").eq("booking_id", id).order("created_at", { ascending: true }),
    ]);
    if (customerRes.error) throw customerRes.error;
    if (dumpsterRes.error) throw dumpsterRes.error;
    if (photosRes.error) throw photosRes.error;

    const customer = customerRes.data || null;
    const dumpster = dumpsterRes.data || null;
    const photoRows = photosRes.data || [];

    // Signed URLs are minted here, after authorization has already
    // succeeded above, scoped to one storage object each, and short-lived —
    // never a permanent public URL, never reused across requests. A single
    // failed signing call degrades to a missing url for that one photo
    // rather than failing the whole page.
    const photos = await Promise.all(
      photoRows.map(async (p) => {
        try {
          const signed = await supabase.storage.from(BUCKET).createSignedUrl(p.storage_path, PHOTO_URL_TTL_SECONDS);
          if (signed.error || !signed.data) {
            console.error("Admin booking detail: failed to sign photo URL for " + p.storage_path, signed.error);
            return { id: p.id, url: null, createdAt: p.created_at };
          }
          return { id: p.id, url: signed.data.signedUrl, createdAt: p.created_at };
        } catch (err) {
          console.error("Admin booking detail: failed to sign photo URL for " + p.storage_path, err);
          return { id: p.id, url: null, createdAt: p.created_at };
        }
      })
    );

    res.status(200).json({
      ok: true,
      booking: {
        id: booking.id,
        // Exposed only so the admin UI can link to this booking's client
        // profile (/admin/client/?id=) — never used by this route itself
        // to authorize anything; requireAdmin() above already did that.
        customerId: booking.customer_id,
        serviceType: booking.service_type,
        serviceLabel: serviceLabel(booking.service_type),
        appointmentDate: booking.appointment_date,
        timeWindow: booking.time_window,
        timeWindowLabel: timeWindowLabel(booking.time_window),
        description: booking.description,
        estimatedPrice: booking.estimated_price,
        finalPrice: booking.final_price,
        internalNotes: booking.internal_notes,
        status: normalizedStatus(booking.status),
        statusLabel: statusLabel(booking.status),
        createdAt: booking.created_at,
      },
      // Client identity/contact only — never the address. Job location is
      // reported separately below as `serviceAddress`, sourced from the
      // booking's own historical snapshot, not this (mutable) customer row.
      customer: customer
        ? {
            firstName: customer.first_name,
            lastName: customer.last_name,
            phone: customer.phone,
            email: customer.email,
          }
        : null,
      // The booking's own snapshot is primary; a legacy booking created
      // before this snapshot existed (service_address is NULL) falls back to
      // the customer's current address so the page still shows something
      // useful rather than a blank field.
      serviceAddress: {
        address: booking.service_address || (customer && customer.address) || null,
        city: booking.service_city || (customer && customer.city) || null,
        state: booking.service_state || (customer && customer.state) || null,
        zip: booking.service_zip || (customer && customer.zip) || null,
      },
      dumpster: dumpster
        ? {
            deliveryDate: dumpster.delivery_date,
            pickupDate: dumpster.pickup_date,
            materialType: dumpster.material_type,
            placementNotes: dumpster.placement_notes,
          }
        : null,
      photos: photos,
    });
  } catch (err) {
    console.error("Admin booking detail failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load booking." });
  }
};

// ---------------------------------------------------------------------
// Create a job (Phase 3C Stage 2.1) — POST /api/admin/booking. Creates one
// bookings row for an already-identified client (see api/admin/client.js
// for finding/creating that client — this endpoint never does that
// itself). Covers "+ New Job" only. "+ Past Job" (a later stage) is a
// different mode with different defaults — status=completed, an optional
// time window, past dates allowed — and is NOT implemented here.
//
// `status` is hardcoded to "booked" below and is never read from the
// request body at all: there is no field named "status" anywhere in the
// validation below, so there is no value a caller could send that would
// change it. Every other field is read individually as a named primitive
// and validated/sanitized before being placed into the insert payload —
// the request body is never spread into it, mirroring the discipline
// api/admin/booking-status.js already established for the one write path
// that existed before this stage.
async function handleCreate(req, res) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin job create failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

  const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
  if (!customerId) {
    res.status(400).json({ error: "A client is required." });
    return;
  }
  if (!UUID_RE.test(customerId)) {
    // Mirrors the rest of this file: a malformed id can never match a real
    // row, so it's treated identically to "not found."
    res.status(404).json({ error: "Client not found." });
    return;
  }

  const serviceType = typeof body.serviceType === "string" ? body.serviceType.trim() : "";
  if (!SERVICE_TYPES.includes(serviceType)) {
    res.status(400).json({ error: "Please choose a valid service type." });
    return;
  }

  const appointmentDate = typeof body.appointmentDate === "string" ? body.appointmentDate.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate) || Number.isNaN(new Date(appointmentDate + "T00:00:00").getTime())) {
    res.status(400).json({ error: "A valid appointment date is required." });
    return;
  }
  // New Job is for a job being booked now or in the future — a date before
  // today (America/Denver) has no meaning for a status="booked" row.
  // "+ Past Job" (a later stage) is the intended path for a historical date.
  if (appointmentDate < denverTodayIso()) {
    res.status(400).json({ error: "Appointment date cannot be in the past. Use Past Job for historical jobs." });
    return;
  }

  const timeWindow = typeof body.timeWindow === "string" ? body.timeWindow.trim() : "";
  if (!VALID_TIME_WINDOWS.includes(timeWindow)) {
    res.status(400).json({ error: "A valid appointment time is required." });
    return;
  }

  const addrIn = body.serviceAddress && typeof body.serviceAddress === "object" && !Array.isArray(body.serviceAddress) ? body.serviceAddress : {};
  const serviceAddress = sanitizeText(addrIn.address, MAX.address);
  const serviceCity = sanitizeText(addrIn.city, MAX.city);
  // Validated BEFORE truncating to MAX.state (2 chars) — truncating first
  // would silently turn "Colorado" into "CO" and accept it as if it were
  // already a valid 2-letter code, rather than rejecting the real input.
  const serviceStateRaw = sanitizeText(addrIn.state, 40).toUpperCase();
  const serviceZip = sanitizeText(addrIn.zip, MAX.zip);
  if (!serviceAddress || !serviceCity) {
    res.status(400).json({ error: "A complete service address is required." });
    return;
  }
  if (!/^[A-Z]{2}$/.test(serviceStateRaw)) {
    res.status(400).json({ error: "Please enter a valid 2-letter state." });
    return;
  }
  const serviceState = serviceStateRaw;
  if (!/^\d{5}(-\d{4})?$/.test(serviceZip)) {
    res.status(400).json({ error: "Please enter a valid ZIP code." });
    return;
  }

  const description = sanitizeText(body.description, MAX.long) || null;
  const internalNotes = sanitizeText(body.internalNotes, MAX.long) || null;

  let estimatedPrice = null;
  if (body.estimatedPrice !== undefined && body.estimatedPrice !== null && body.estimatedPrice !== "") {
    const n = Number(body.estimatedPrice);
    if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
      res.status(400).json({ error: "Please enter a valid estimated price." });
      return;
    }
    // Matches the confirmed live column type, numeric(10,2) — see
    // docs/phase-3/stage2-preflight.md.
    estimatedPrice = Math.round(n * 100) / 100;
  }

  try {
    const customerRes = await supabase.from("customers").select("id").eq("id", customerId).maybeSingle();
    if (customerRes.error) throw customerRes.error;
    if (!customerRes.data) {
      res.status(404).json({ error: "Client not found." });
      return;
    }

    const { data: created, error } = await supabase
      .from("bookings")
      .insert({
        customer_id: customerId,
        service_type: serviceType,
        appointment_date: appointmentDate,
        time_window: timeWindow,
        status: "booked",
        description: description,
        estimated_price: estimatedPrice,
        internal_notes: internalNotes,
        // Frozen job-location snapshot — written once, here, and never
        // re-derived from the customer's profile address later, matching
        // every existing booking everywhere else in this codebase.
        service_address: serviceAddress,
        service_city: serviceCity,
        service_state: serviceState,
        service_zip: serviceZip,
      })
      .select(
        "id, service_type, appointment_date, time_window, status, description, estimated_price, internal_notes, customer_id, service_address, service_city, service_state, service_zip, created_at"
      )
      .single();

    if (error || !created) throw error || new Error("Insert returned no row.");

    res.status(200).json({
      ok: true,
      booking: {
        id: created.id,
        customerId: created.customer_id,
        serviceType: created.service_type,
        serviceLabel: serviceLabel(created.service_type),
        appointmentDate: created.appointment_date,
        timeWindow: created.time_window,
        timeWindowLabel: timeWindowLabel(created.time_window),
        description: created.description,
        estimatedPrice: created.estimated_price,
        internalNotes: created.internal_notes,
        status: normalizedStatus(created.status),
        statusLabel: statusLabel(created.status),
        createdAt: created.created_at,
      },
      serviceAddress: {
        address: created.service_address,
        city: created.service_city,
        state: created.service_state,
        zip: created.service_zip,
      },
    });
  } catch (err) {
    console.error("Admin job create failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not create job." });
  }
}

// Derived from booking-format.js's SERVICE_LABELS keys rather than a third
// hardcoded copy of the three service-type strings (api/book.js has the
// live one; booking-format.js already has the admin-shared one this file
// already imports from).
const SERVICE_TYPES = Object.keys(SERVICE_LABELS);
// Derived from the shared api/_lib/time-windows.js module — same source
// used to sort the Schedule chronologically — rather than a separate copy.
const VALID_TIME_WINDOWS = Object.keys(TIME_WINDOW_DEFS);

const MAX = { address: 200, city: 80, zip: 10, long: 2000 };
const MAX_PRICE = 999999;

// Same sanitize helper as api/book.js's own: strip control characters and
// any "<...>"-shaped text, trim, bound length.
function sanitizeText(value, maxLen) {
  if (typeof value !== "string") return "";
  var stripped = "";
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    var isControl = code <= 31 && code !== 9 && code !== 10 && code !== 13;
    if (!isControl) stripped += value[i];
  }
  return stripped.replace(/<[^>]*>/g, "").trim().slice(0, maxLen);
}

// Current date in America/Denver as YYYY-MM-DD — same small, deliberate
// local copy as api/admin/bookings.js's own denverTodayIso() (see that
// file's comment for why this isn't a shared import).
function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date()).forEach(function (p) {
    parts[p.type] = p.value;
  });
  return parts.year + "-" + parts.month + "-" + parts.day;
}
