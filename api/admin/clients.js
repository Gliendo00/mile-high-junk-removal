// Vercel serverless function — read-only client list + search for the
// admin Clients section. See api/_lib/admin-auth.js: requireAdmin() is the
// only thing standing between this data and an unauthenticated caller, and
// it runs before any Supabase query below.
//
// This never writes anything. Every query is a SELECT (or a count-only
// head request). No customer or booking row is modified by this endpoint,
// ever — mirrors api/admin/bookings.js exactly in that respect.
//
// A "client" here is simply a row in `customers`, shown once each. Phase
// 3B Step 3 does no matching/deduplication — that is explicitly deferred —
// so this reflects exactly what api/book.js has written, one row per
// customer record that exists today.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_SEARCH_LEN = 60;
// Per-field candidate cap when searching. Four fields x this value is the
// absolute ceiling of customer rows ever held in memory for one search
// request — this never dumps the whole `customers` table to satisfy a
// search, and stays well within reason even at a few thousand clients.
// (A true full-text/trigram search index would be the right next step if
// the client list ever grows large enough for a plain ilike scan to be
// slow — out of scope for this phase's small dataset.)
const SEARCH_FIELD_LIMIT = 200;

module.exports = async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin clients list failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  let offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const search = sanitizeSearchTerm(typeof req.query.search === "string" ? req.query.search : "");

  try {
    const cols = "id, first_name, last_name, phone, email, city, created_at";
    let clients;
    let total;

    if (search) {
      // Bounded, server-side, multi-field search: four independent,
      // properly-parameterized ilike() calls (never a raw filter string
      // built from user input, so there is no PostgREST filter-syntax or
      // SQL injection surface here) merged and deduped in memory, then
      // paged. Each call is capped at SEARCH_FIELD_LIMIT.
      const pattern = "%" + search + "%";
      const [byFirst, byLast, byPhone, byEmail] = await Promise.all([
        supabase.from("customers").select(cols).ilike("first_name", pattern).limit(SEARCH_FIELD_LIMIT),
        supabase.from("customers").select(cols).ilike("last_name", pattern).limit(SEARCH_FIELD_LIMIT),
        supabase.from("customers").select(cols).ilike("phone", pattern).limit(SEARCH_FIELD_LIMIT),
        supabase.from("customers").select(cols).ilike("email", pattern).limit(SEARCH_FIELD_LIMIT),
      ]);
      for (const r of [byFirst, byLast, byPhone, byEmail]) {
        if (r.error) throw r.error;
      }
      const merged = new Map();
      [byFirst, byLast, byPhone, byEmail].forEach((r) => {
        (r.data || []).forEach((c) => merged.set(c.id, c));
      });
      const all = Array.from(merged.values()).sort(byCreatedAtDesc);
      total = all.length;
      clients = all.slice(offset, offset + limit);
    } else {
      const [countRes, pageRes] = await Promise.all([
        supabase.from("customers").select("id", { count: "exact", head: true }),
        supabase.from("customers").select(cols).order("created_at", { ascending: false }).range(offset, offset + limit - 1),
      ]);
      if (countRes.error) throw countRes.error;
      if (pageRes.error) throw pageRes.error;
      total = countRes.count || 0;
      clients = pageRes.data || [];
    }

    const customerIds = clients.map((c) => c.id);
    const bookingsByCustomer = {};
    if (customerIds.length) {
      const bookingsRes = await supabase.from("bookings").select("customer_id, appointment_date, created_at").in("customer_id", customerIds);
      if (bookingsRes.error) throw bookingsRes.error;
      (bookingsRes.data || []).forEach((b) => {
        (bookingsByCustomer[b.customer_id] || (bookingsByCustomer[b.customer_id] = [])).push(b);
      });
    }

    const items = clients.map((c) => {
      const jobs = (bookingsByCustomer[c.id] || []).slice().sort(byCreatedAtDesc);
      return {
        id: c.id,
        firstName: c.first_name,
        lastName: c.last_name,
        phone: c.phone,
        email: c.email,
        city: c.city,
        bookingCount: jobs.length,
        lastJobDate: jobs.length ? jobs[0].appointment_date : null,
      };
    });

    res.status(200).json({
      ok: true,
      clients: items,
      limit: limit,
      offset: offset,
      hasMore: offset + items.length < total,
    });
  } catch (err) {
    console.error("Admin clients list failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load clients." });
  }
};

function byCreatedAtDesc(a, b) {
  if (a.created_at < b.created_at) return 1;
  if (a.created_at > b.created_at) return -1;
  return 0;
}

// Strips control characters (mirroring api/book.js's sanitizeText), trims,
// and caps length BEFORE escaping — so MAX_SEARCH_LEN bounds the visible
// search term itself, not its escaped-for-ILIKE representation. Backslash,
// "%", and "_" are then escaped so the term is matched as a literal
// substring, never as a caller-controlled ILIKE wildcard pattern.
function sanitizeSearchTerm(value) {
  if (typeof value !== "string") return "";
  var stripped = "";
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    if (code > 31) stripped += value[i];
  }
  var capped = stripped.trim().slice(0, MAX_SEARCH_LEN);
  return capped.replace(/[\\%_]/g, "\\$&");
}
