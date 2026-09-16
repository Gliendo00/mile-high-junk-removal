// Vercel serverless function — returns ONLY the count of "new" (NULL-status)
// bookings, for the small Requests nav badge shown on every admin page.
//
// Deliberately its own tiny endpoint rather than reusing
// api/admin/bookings.js's full list response: the badge renders on every
// admin page load (Schedule, Clients, booking/client detail — not just the
// Requests page itself), so it must not pull a page of booking/customer rows
// just to display one integer. This is a count-only HEAD query — the same
// primitive api/admin/bookings.js already uses six times for its own summary
// — and the response carries no booking or customer data at all, only a
// number.
//
// requireAdmin() gates this exactly like every other admin route. The count
// itself is not sensitive (it reveals nothing about any individual booking),
// but the endpoint is still fully authenticated — there is no "public badge"
// exception anywhere in this admin surface.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");

module.exports = async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin new-count failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  try {
    // Matches api/admin/bookings.js's own "new" definition exactly: every
    // booking created so far has left status NULL for "new" (see
    // docs/phase-1/crm-status-plan.md) — nothing has ever written the
    // literal string "new" — so a plain .is("status", null) count is
    // correct and needs no other table's data.
    const { count, error } = await supabase.from("bookings").select("id", { count: "exact", head: true }).is("status", null);
    if (error) throw error;

    res.status(200).json({ ok: true, new: count || 0 });
  } catch (err) {
    console.error("Admin new-count failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load the new-request count." });
  }
};
