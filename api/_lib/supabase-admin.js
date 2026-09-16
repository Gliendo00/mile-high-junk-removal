// Service-role Supabase client factory for /api/admin/* data routes.
//
// The service-role key bypasses Row Level Security entirely, so this must
// only ever be used AFTER api/_lib/admin-auth.js's requireAdmin() has
// already verified the caller is an authenticated, allowlisted admin —
// never to answer an unauthenticated request. This mirrors the exact
// pattern already used in api/book.js and api/upload-photo.js: the key is
// read from process.env inside a server function and never sent to, echoed
// to, or otherwise reachable from client-side code.
const { createClient } = require("@supabase/supabase-js");

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

module.exports = { getServiceClient };
