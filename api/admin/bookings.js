// Vercel serverless function — read-only booking list + summary counts for
// the admin dashboard. See api/_lib/admin-auth.js: requireAdmin() is the
// only thing standing between this data and an unauthenticated caller, and
// it runs before any Supabase query below.
//
// This never writes anything. Every query is a SELECT (or a count-only
// head request). No booking, customer, or status row is modified by this
// endpoint, ever.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");
const { serviceLabel, timeWindowLabel, statusLabel, normalizedStatus } = require("../_lib/booking-format");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

module.exports = async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin bookings list failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  let offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  try {
    // Six well-understood .eq()/count-only queries rather than a single
    // .or("status.is.null,status.eq.") filter — this avoids depending on
    // exactly how PostgREST parses an empty-string comparison inside an
    // `or()` filter, which was never verified against the live project
    // (see docs/phase-1/database-schema.md's NEEDS VERIFICATION notes).
    // "new" is then derived as total minus every known non-new status,
    // which is correct however NULL/empty status is actually represented
    // in the database.
    const [totalRes, contactedRes, quotedRes, bookedRes, completedRes, lostRes, pageRes] = await Promise.all([
      supabase.from("bookings").select("id", { count: "exact", head: true }),
      supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "contacted"),
      supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "quoted"),
      supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "booked"),
      supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "completed"),
      supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "lost"),
      supabase
        .from("bookings")
        .select("id, service_type, appointment_date, time_window, status, estimated_price, customer_id, created_at")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1),
    ]);

    for (const r of [totalRes, contactedRes, quotedRes, bookedRes, completedRes, lostRes, pageRes]) {
      if (r.error) throw r.error;
    }

    const bookings = pageRes.data || [];
    const customerIds = Array.from(new Set(bookings.map((b) => b.customer_id).filter(Boolean)));
    const bookingIds = bookings.map((b) => b.id);

    const customersById = {};
    if (customerIds.length) {
      const custRes = await supabase.from("customers").select("id, first_name, last_name, city").in("id", customerIds);
      if (custRes.error) throw custRes.error;
      (custRes.data || []).forEach((c) => {
        customersById[c.id] = c;
      });
    }

    const photoCountByBooking = {};
    if (bookingIds.length) {
      const photosRes = await supabase.from("booking_photos").select("id, booking_id").in("booking_id", bookingIds);
      if (photosRes.error) throw photosRes.error;
      (photosRes.data || []).forEach((p) => {
        photoCountByBooking[p.booking_id] = (photoCountByBooking[p.booking_id] || 0) + 1;
      });
    }

    const items = bookings.map((b) => {
      const customer = customersById[b.customer_id] || null;
      return {
        id: b.id,
        serviceType: b.service_type,
        serviceLabel: serviceLabel(b.service_type),
        appointmentDate: b.appointment_date,
        timeWindow: b.time_window,
        timeWindowLabel: timeWindowLabel(b.time_window),
        status: normalizedStatus(b.status),
        statusLabel: statusLabel(b.status),
        estimatedPrice: b.estimated_price,
        createdAt: b.created_at,
        photoCount: photoCountByBooking[b.id] || 0,
        customer: customer ? { firstName: customer.first_name, lastName: customer.last_name, city: customer.city } : null,
      };
    });

    const total = totalRes.count || 0;
    const knownNonNew = (contactedRes.count || 0) + (quotedRes.count || 0) + (bookedRes.count || 0) + (completedRes.count || 0) + (lostRes.count || 0);

    res.status(200).json({
      ok: true,
      summary: {
        total: total,
        new: Math.max(0, total - knownNonNew),
        contacted: contactedRes.count || 0,
        quoted: quotedRes.count || 0,
        booked: bookedRes.count || 0,
        completed: completedRes.count || 0,
        lost: lostRes.count || 0,
      },
      bookings: items,
      limit: limit,
      offset: offset,
      hasMore: offset + items.length < total,
    });
  } catch (err) {
    console.error("Admin bookings list failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load bookings." });
  }
};
