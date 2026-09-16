// Vercel serverless function — read-only single-client profile + full
// booking/job history. See api/_lib/admin-auth.js: requireAdmin() gates
// this entire route before the `id` query param is ever looked at.
//
// IDOR note: mirrors api/admin/booking.js exactly — the client id in the
// URL identifies *which* record is being asked for, never authorizes the
// request by itself. Every code path below runs only after requireAdmin()
// has already confirmed the caller is an authenticated, allowlisted admin.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");
const { serviceLabel, timeWindowLabel, statusLabel, normalizedStatus } = require("../_lib/booking-format");

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
    res.status(400).json({ error: "Client id is required." });
    return;
  }
  if (!UUID_RE.test(id)) {
    // A malformed id can never match a real row. Treated identically to
    // "not found" rather than a distinct 400 — mirrors api/admin/booking.js
    // so the response never confirms anything about id format/validation.
    res.status(404).json({ error: "Client not found." });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin client detail failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  try {
    const customerRes = await supabase
      .from("customers")
      .select("id, first_name, last_name, phone, email, address, city, state, zip, created_at")
      .eq("id", id)
      .maybeSingle();
    if (customerRes.error) throw customerRes.error;

    const customer = customerRes.data;
    if (!customer) {
      res.status(404).json({ error: "Client not found." });
      return;
    }

    // Every booking for this client, newest first — scoped strictly by
    // customer_id, so this can never surface another client's history no
    // matter what id was requested (the id itself was already validated as
    // a real row above; this query just can't match rows belonging to a
    // different customer_id).
    const bookingsRes = await supabase
      .from("bookings")
      .select(
        "id, service_type, appointment_date, time_window, status, estimated_price, final_price, service_address, service_city, service_state, service_zip, created_at"
      )
      .eq("customer_id", id)
      .order("created_at", { ascending: false });
    if (bookingsRes.error) throw bookingsRes.error;

    const bookings = (bookingsRes.data || []).map((b) => ({
      id: b.id,
      serviceType: b.service_type,
      serviceLabel: serviceLabel(b.service_type),
      appointmentDate: b.appointment_date,
      timeWindow: b.time_window,
      timeWindowLabel: timeWindowLabel(b.time_window),
      status: normalizedStatus(b.status),
      statusLabel: statusLabel(b.status),
      estimatedPrice: b.estimated_price,
      finalPrice: b.final_price,
      createdAt: b.created_at,
      // Historical job location — always this booking's own snapshot first.
      // The fallback to the client's current address only covers a legacy
      // booking with no snapshot of its own (same behavior as
      // api/admin/booking.js, added in Phase 3B Step 2) — the client's
      // current address is never used as the primary source, so a later
      // change to it can never rewrite what this card shows for a past job.
      serviceAddress: {
        address: b.service_address || customer.address || null,
        city: b.service_city || customer.city || null,
        state: b.service_state || customer.state || null,
        zip: b.service_zip || customer.zip || null,
      },
    }));

    res.status(200).json({
      ok: true,
      client: {
        id: customer.id,
        firstName: customer.first_name,
        lastName: customer.last_name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        city: customer.city,
        state: customer.state,
        zip: customer.zip,
        createdAt: customer.created_at,
      },
      bookings: bookings,
    });
  } catch (err) {
    console.error("Admin client detail failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load client." });
  }
};
