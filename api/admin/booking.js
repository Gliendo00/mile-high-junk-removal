// Vercel serverless function — read-only single-booking detail, including
// short-lived signed photo URLs. See api/_lib/admin-auth.js: requireAdmin()
// gates this entire route before the `id` query param is ever looked at.
//
// IDOR note: the booking id in the URL identifies *which* record is being
// asked for — it never authorizes the request by itself. Every code path
// below runs only after requireAdmin() has already confirmed the caller is
// an authenticated, allowlisted admin; changing `?id=` to another booking's
// id changes which (authorized) record comes back, never whether the
// request is authorized at all.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");
const { serviceLabel, timeWindowLabel, statusLabel, normalizedStatus } = require("../_lib/booking-format");

const BUCKET = "booking-photos";
const PHOTO_URL_TTL_SECONDS = 300; // 5 minutes — short-lived by design, minted fresh on every request, never cached or persisted
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

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
