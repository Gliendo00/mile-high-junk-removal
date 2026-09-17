// Google Maps/Places browser API key — Phase 3C Stage 2.4 (Google Address
// Autocomplete UX). Deliberately EMPTY until the owner configures a real,
// RESTRICTED browser key in Google Cloud Console. See
// docs/phase-3/stage2.4-calendar-address-proposal.md's "Google Cloud setup"
// section for the exact steps (HTTP-referrer restriction, API restriction
// to only "Maps JavaScript API" + "Places API (New)", separate
// Production/Preview referrer entries).
//
// This is safe to commit even once filled in: a Google Maps JavaScript API
// key is DESIGNED to be visible in browser source — Google's own security
// model for this key type is HTTP-referrer + API restriction, never
// secrecy — unlike a Supabase service-role key or any other server secret
// in this codebase (those stay in Vercel environment variables, read only
// by serverless functions, never shipped to the browser).
//
// admin/address-autocomplete.js checks this value before doing anything:
// empty/missing means Google Places is treated as unavailable and every
// address field on New Job / Past Job / Edit Job falls back to fully
// manual entry, which always works regardless of this file's contents —
// see that file's header for the full fallback contract.
//
// To enable autocomplete once the Google Cloud key exists: replace the
// empty string below with the real key. Nothing else in this codebase
// needs to change.
window.ADMIN_GOOGLE_MAPS_API_KEY = "";
