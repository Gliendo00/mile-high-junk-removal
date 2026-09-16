// TEMPORARY — FOR PHASE 2 PREVIEW SECURITY VERIFICATION ONLY.
// Not part of the admin product surface. Will be deleted immediately after
// the RLS/storage-privacy check it exists for is complete.
//
// Makes real requests to Supabase's REST and Storage APIs using ONLY the
// anon key (never the service-role key) — exactly what an unauthenticated
// internet visitor could do directly against Supabase if Row Level
// Security or bucket privacy were misconfigured, independent of this
// site's own admin auth entirely. Returns ONLY row counts and short fixed
// verdict strings — never actual row contents, ids, names, or storage
// paths, even if it finds a real leak.
//
// Protected by a one-time secret (RLS_PROBE_SECRET) rather than the normal
// admin login: generating and using this diagnostic doesn't require
// possessing the site owner's admin password. Any request without the
// exact matching secret gets a plain 404 — this route's existence is never
// confirmed to a caller who doesn't already have the secret.
const REQUIRED_SECRET_HEADER = "x-probe-secret";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const expected = process.env.RLS_PROBE_SECRET;
  const provided = req.headers[REQUIRED_SECRET_HEADER];
  if (!expected || !provided || String(provided) !== expected) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    res.status(500).json({ error: "Probe misconfigured: SUPABASE_URL/SUPABASE_ANON_KEY missing" });
    return;
  }

  const tables = ["customers", "bookings", "dumpster_rentals", "booking_photos"];
  const results = {};

  for (const table of tables) {
    try {
      const r = await fetch(supabaseUrl + "/rest/v1/" + table + "?select=id&limit=1", {
        headers: { apikey: anonKey, Authorization: "Bearer " + anonKey },
      });
      let rowCount = null;
      if (r.status === 200) {
        const json = await r.json().catch(() => null);
        rowCount = Array.isArray(json) ? json.length : null;
        // json is deliberately discarded here — never assigned into
        // `results` or logged. Only its length is ever kept.
      }
      results[table] = {
        httpStatus: r.status,
        rowsReturned: rowCount,
        verdict:
          r.status !== 200
            ? "blocked (HTTP " + r.status + ") — secure"
            : rowCount === 0
            ? "0 rows returned — secure (RLS filtered anon access)"
            : "SECURITY ISSUE: anon request returned " + rowCount + " row(s)",
      };
    } catch (err) {
      results[table] = { httpStatus: null, rowsReturned: null, verdict: "probe request failed: " + (err && err.message) };
    }
  }

  // Storage: request a guaranteed-nonexistent object through the PUBLIC
  // object route. That route only resolves at all for a bucket marked
  // public — a private bucket rejects it before ever checking whether the
  // object exists, so this needs no real storage_path from any real photo.
  let storageResult;
  try {
    const probePath = "__rls_probe_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".jpg";
    const r = await fetch(supabaseUrl + "/storage/v1/object/public/booking-photos/" + probePath);
    const body = await r.json().catch(() => null);
    const message = body && (body.message || body.error) ? String(body.message || body.error) : "";
    let verdict;
    if (r.status === 400 && /bucket not found/i.test(message)) {
      verdict = "bucket is private — secure (public route rejected before checking the object)";
    } else if (r.status === 404 && /object not found/i.test(message)) {
      verdict = "SECURITY ISSUE: bucket appears PUBLIC (public route resolved; only the fake object was missing)";
    } else {
      verdict = "unexpected response (HTTP " + r.status + ") — needs manual review";
    }
    storageResult = { httpStatus: r.status, verdict: verdict };
  } catch (err) {
    storageResult = { httpStatus: null, verdict: "probe request failed: " + (err && err.message) };
  }

  res.status(200).json({ ok: true, tables: results, storageBucketPublicRouteProbe: storageResult });
};
