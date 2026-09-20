// Vercel serverless function — the ONE intentional write capability in the
// entire admin portal: change bookings.status to one of seven allowlisted
// values. See api/_lib/admin-auth.js: requireAdmin() gates this route
// before the request body is ever read.
//
// This is deliberately narrow. It does not become a generic "update a
// booking" endpoint: the only column this code can ever write is
// bookings.status, to one of exactly seven hardcoded strings (plus a
// service_type check for the one rental-only value — see
// RENTAL_ONLY_STATUS below). The request body is never spread into the
// update payload — id and status are read individually as primitives, so a
// caller cannot smuggle extra column names or values through the request no
// matter what the JSON body contains.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");
const { normalizedStatus } = require("../_lib/booking-format");

// The only seven values this endpoint will ever write. Deliberately not
// derived from booking-format.js's STATUS_LABELS keys — that object exists
// for display formatting and could one day gain a display-only alias; this
// allowlist is a security boundary and is spelled out explicitly so it only
// ever changes via a deliberate edit to this file.
const ALLOWED_STATUSES = ["new", "contacted", "quoted", "booked", "rental_out", "completed", "lost"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Phase 3C Stage 4: "rental_out" (a dumpster rental delivered and currently
// at the client's property) only ever makes sense for a dumpster-rental
// job — the owner explicitly asked that a junk-removal/light-demo job can
// never accidentally end up in this status. There is no separate
// "rental lifecycle" column to check; service_type is already reliable,
// existing data on every booking, so this reuses it directly rather than
// adding a new field or a bigger validation layer.
const RENTAL_ONLY_STATUS = "rental_out";
const RENTAL_SERVICE_TYPE = "dumpster_rental";

module.exports = async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  if (req.method !== "PATCH") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

  // Only ever read exactly these two primitives off the body. Anything else
  // the caller sends (extra fields, nested objects, arbitrary column names)
  // is silently ignored — it is never inspected, never logged as if it were
  // meaningful, and never reaches the database query below.
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const requestedStatus = typeof body.status === "string" ? body.status.trim() : "";

  if (!id) {
    res.status(400).json({ error: "Booking id is required." });
    return;
  }
  if (!UUID_RE.test(id)) {
    // Mirrors api/admin/booking.js: a malformed id can never match a real
    // row, so it's treated identically to "not found" rather than a
    // distinct 400 — the response never confirms anything about id format.
    res.status(404).json({ error: "Booking not found." });
    return;
  }

  if (!requestedStatus) {
    res.status(400).json({ error: "Status is required." });
    return;
  }
  // Exact, case-sensitive membership only. No trimming/lowercasing beyond
  // the plain .trim() above, no fuzzy matching — "BOOKED" or " Booked" is
  // rejected outright rather than silently coerced, so the six values this
  // endpoint accepts are exactly the six values it was told to accept.
  if (ALLOWED_STATUSES.indexOf(requestedStatus) === -1) {
    res.status(400).json({ error: "Invalid status." });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin booking-status update failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  try {
    // Only fetched for the one status that needs it — every other status
    // write stays exactly the single-query round trip it always was.
    if (requestedStatus === RENTAL_ONLY_STATUS) {
      const currentRes = await supabase.from("bookings").select("id, service_type").eq("id", id).maybeSingle();
      if (currentRes.error) throw currentRes.error;
      if (!currentRes.data) {
        res.status(404).json({ error: "Booking not found." });
        return;
      }
      if (currentRes.data.service_type !== RENTAL_SERVICE_TYPE) {
        res.status(400).json({ error: "Rental Out can only be set on a dumpster rental job." });
        return;
      }
    }

    // The update payload is a literal object with exactly one key, built
    // here — never the request body, never a spread of the request body.
    // .eq("id", id) scopes the write to the one row the (already-verified)
    // admin asked for; .select(...).maybeSingle() confirms whether a row
    // was actually matched and returns only the two fields the response
    // needs, nothing else.
    const { data, error } = await supabase.from("bookings").update({ status: requestedStatus }).eq("id", id).select("id, status").maybeSingle();

    if (error) throw error;

    if (!data) {
      res.status(404).json({ error: "Booking not found." });
      return;
    }

    res.status(200).json({ ok: true, id: data.id, status: normalizedStatus(data.status) });
  } catch (err) {
    console.error("Admin booking-status update failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not update status." });
  }
};
