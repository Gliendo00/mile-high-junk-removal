// Vercel serverless function — Batch 5, Screenshot AI Intake. The 12th slot
// freed by Batch 5 (5A)'s retirement of api/admin/booking-status.js into
// api/admin/booking.js's ?resource=status branch — see
// docs/phase-3/batch5-screenshot-intake-proposal.md §3.
//
// Scope of THIS file (5B/5C): upload screenshots, run extraction through
// the swappable vision adapter, compute client/existing-job matches, and
// let the admin review/correct/save the result as a Pending Intake record.
//
// Stage 5D (confirm-booking/confirm-attach-existing, below): this file
// STILL never creates or updates any customers/bookings row — only reads
// (to compute a match, verify a picked id, or re-validate a booking/client
// id the admin's browser just produced via the existing, independently-
// authorized POST /api/admin/client and POST /api/admin/booking endpoints).
// Every write here remains scoped to intake_sessions/intake_screenshots.
// `linked_existing_booking_id`, `matched_customer_id`,
// `resulting_customer_id`, and `resulting_booking_id` are all intake-
// session metadata recording what the admin resolved/confirmed, never a
// mutation of the customer/booking row itself. Confirm-as-Lead (lead_only/
// quote_discussion -> the `leads` table) is a separate file,
// api/admin/lead.js, for the same reason — this file has no grant on
// `leads` and never needs one.
//
// requireAdmin() gates every action below EXCEPT ?action=cleanup-expired,
// which is invoked by a Vercel Cron job rather than a logged-in admin and
// authenticates via CRON_SECRET instead — see module.exports's own comment
// and handleCleanupExpired()'s header for the full reasoning.
//
// Screenshot retention (hardening pass, before anything here was ever
// deployed): discarded intakes are cleaned up immediately (unchanged);
// processing/pending_review/extraction_failed intakes age out after
// PENDING_RETENTION_DAYS, confirmed ones (now reachable as of Stage 5D)
// after CONFIRMED_RETENTION_DAYS — see handleCleanupExpired(). Cleanup only
// ever removes screenshots (Storage objects + rows); extracted_data/
// ai_raw_extraction/classification/match/confirmed state on intake_sessions
// is never touched by it.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");
const { normalizePhone } = require("../_lib/customer-identity");
const { extractFromScreenshots, CLASSIFICATIONS, FIELD_KEYS } = require("../_lib/intake-vision-provider");
const crypto = require("crypto");

const BUCKET = "intake-screenshots";
const SCREENSHOT_URL_TTL_SECONDS = 300; // short-lived, minted fresh per request — same posture as booking.js's job photos
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024; // mirrors api/upload-photo.js's existing cap, same Vercel body-size reasoning
const MAX_SCREENSHOTS_PER_SESSION = 10; // soft operational cap — guards against runaway upload/extraction cost, not from the brief
const ALLOWED_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTAKE_STATUSES = ["processing", "pending_review", "confirmed", "discarded", "extraction_failed"];
// Only a real, currently-open appointment is a candidate to be "the same
// job" an existing_job_update screenshot is talking about — not a lead
// still in the sales pipeline (new/contacted/quoted) and not one already
// completed or lost.
const EXISTING_JOB_CANDIDATE_STATUSES = ["booked", "rental_out"];
// A screenshot upload racing another upload to the SAME session (a
// double-click, a flaky-network retry, two tabs) can read the same
// existing-screenshot count before either insert lands, producing a
// duplicate sort_order — now a hard 23505 (unique_violation) against
// intake_screenshots_session_sort_order_uniq instead of silent corruption.
// One retry (two attempts total) with a freshly recomputed sort_order
// self-heals the rare case rather than surfacing it as an error. See
// sql/2026-10-04_phase3c-batch5-intake-sessions.sql §2 for the full
// reasoning, including why this was chosen over redesigning the ordering
// scheme entirely.
const MAX_SORT_ORDER_INSERT_ATTEMPTS = 2;
const POSTGRES_UNIQUE_VIOLATION = "23505";
// Screenshot retention (hardening pass; see docs/phase-3/batch5-storage-design.md).
// Discarded intakes are cleaned up immediately and unconditionally
// (unchanged, see handleDiscard) — these two are for intakes nobody acted
// on. Swept by ?action=cleanup-expired below, never by any other action.
const PENDING_RETENTION_DAYS = 7; // processing / pending_review / extraction_failed
const CONFIRMED_RETENTION_DAYS = 30; // Stage 5D isn't built yet, so this can't fire on a real row today — implemented now so 5D needs no follow-up change here.

module.exports = async (req, res) => {
  // ?action=cleanup-expired is the one action on this file NOT gated by
  // requireAdmin() — it's invoked by a Vercel Cron job (see vercel.json),
  // which carries no admin session cookie at all. Authenticated instead by
  // a shared CRON_SECRET bearer token, Vercel's own documented pattern for
  // securing cron-triggered endpoints. This branch is checked FIRST and
  // returns before requireAdmin() or anything else runs, same as every
  // other narrow pre-dispatch carve-out in this codebase (compare
  // api/upload-photo.js's bearer-token scheme for the same reason: the
  // caller here structurally cannot present an admin cookie either).
  if (req.query.action === "cleanup-expired") return handleCleanupExpired(req, res);

  const session = await requireAdmin(req, res);
  if (!session) return;

  if (req.method === "POST") {
    if (req.query.action === "upload-screenshot") return handleUploadScreenshot(req, res);
    if (req.query.action === "extract") return handleExtract(req, res);
    return handleCreateSession(req, res, session);
  }

  if (req.method === "GET") {
    const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
    if (id) return handleDetail(req, res, id);
    return handleList(req, res);
  }

  if (req.method === "PATCH") return handlePatch(req, res, session);

  res.status(405).json({ error: "Method not allowed" });
};

function serverNotConfigured(res) {
  console.error("Admin intake failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
  res.status(500).json({ error: "Admin data is not available right now." });
}

// Current date in America/Denver as YYYY-MM-DD — same small, deliberate
// local copy every other file in this project keeps (see
// api/_lib/job-payments-ledger.js's own denverTodayIso() for the
// established rationale: not a shared import, per this project's convention).
function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date()).forEach(function (p) {
    parts[p.type] = p.value;
  });
  return parts.year + "-" + parts.month + "-" + parts.day;
}

// Same magic-byte check as api/upload-photo.js — duplicated rather than
// shared, matching this project's existing convention of small per-file
// helpers (see e.g. denverTodayIso() above) over a premature shared module
// for two call sites.
function matchesMagicBytes(buffer, type) {
  if (type === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (type === "image/png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (buffer.length < sig.length) return false;
    for (let i = 0; i < sig.length; i++) {
      if (buffer[i] !== sig[i]) return false;
    }
    return true;
  }
  if (type === "image/webp") {
    if (buffer.length < 12) return false;
    const riff = buffer.toString("ascii", 0, 4);
    const webp = buffer.toString("ascii", 8, 12);
    return riff === "RIFF" && webp === "WEBP";
  }
  return false;
}

async function safeDeleteStorageObject(supabase, path) {
  try {
    await supabase.storage.from(BUCKET).remove([path]);
  } catch (err) {
    console.error("Intake: rollback failed deleting storage object " + path + ":", err);
  }
}

// Deletes every screenshot (Storage object + row) for one session. Shared
// by handleDiscard() (immediate, admin-triggered) and
// handleCleanupExpired() (age-triggered) — the two are the only places
// screenshots are ever bulk-removed, and both must behave identically:
// best-effort Storage cleanup (a failure is logged, never blocks the row
// delete — same posture as safeDeleteStorageObject() itself), then the rows.
// Never touches intake_sessions itself — callers decide what (if anything)
// to update there afterward.
async function cleanupSessionScreenshots(supabase, sessionId) {
  const screenshotsRes = await supabase.from("intake_screenshots").select("id, storage_path").eq("intake_session_id", sessionId);
  if (screenshotsRes.error) throw screenshotsRes.error;

  for (const shot of screenshotsRes.data || []) {
    await safeDeleteStorageObject(supabase, shot.storage_path);
  }

  const { error: deleteRowsError } = await supabase.from("intake_screenshots").delete().eq("intake_session_id", sessionId);
  if (deleteRowsError) throw deleteRowsError;
}

// Inserts one intake_screenshots row, retrying once with a freshly
// recomputed sort_order if the UNIQUE(intake_session_id, sort_order)
// constraint fires (see sql/2026-10-04_phase3c-batch5-intake-sessions.sql
// §2) — converts the rare concurrent-upload race into a self-healing retry
// instead of a surfaced 500. Any OTHER error (including a second
// unique_violation — vanishingly unlikely, since by then a THIRD concurrent
// insert would have to land in the exact gap) is still thrown as-is.
async function insertScreenshotWithRetry(supabase, sessionId, storagePath, declaredType) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_SORT_ORDER_INSERT_ATTEMPTS; attempt++) {
    const countRes = await supabase.from("intake_screenshots").select("id", { count: "exact", head: true }).eq("intake_session_id", sessionId);
    if (countRes.error) throw countRes.error;
    const nextSortOrder = countRes.count || 0;

    const { data, error } = await supabase
      .from("intake_screenshots")
      .insert({ intake_session_id: sessionId, storage_path: storagePath, content_type: declaredType, sort_order: nextSortOrder })
      .select("id, sort_order")
      .single();
    if (!error) return data;

    lastError = error;
    if (error.code !== POSTGRES_UNIQUE_VIOLATION) throw error;
    // Falls through to retry with a freshly recomputed count.
  }
  throw lastError;
}

// Phone-first client match, per docs/phase-3/batch5-screenshot-intake-proposal.md
// §5.3 — reuses the SAME normalization api/_lib/customer-identity.js already
// defines for every other matching path in this project, never a second
// definition of "the same phone number."
async function computeClientMatch(supabase, rawPhoneValue) {
  const normalizedPhone = rawPhoneValue ? normalizePhone(rawPhoneValue) : "";
  if (!normalizedPhone) {
    return { matchStatus: "new_candidate", matchedCustomerId: null, normalizedPhone: null };
  }
  const { data, error } = await supabase.from("customers").select("id").eq("phone_normalized", normalizedPhone);
  if (error) throw error;
  const rows = data || [];
  if (rows.length === 1) return { matchStatus: "existing_exact", matchedCustomerId: rows[0].id, normalizedPhone: normalizedPhone };
  if (rows.length === 0) return { matchStatus: "new_candidate", matchedCustomerId: null, normalizedPhone: normalizedPhone };
  // More than one customer row shares this normalized phone. Never guessed
  // — surfaced for the admin to resolve via PATCH ?action=set-client-match.
  return { matchStatus: "needs_confirmation", matchedCustomerId: null, normalizedPhone: normalizedPhone };
}

// ---------------------------------------------------------------------
// POST /api/admin/intake — start a new intake session. No screenshots yet.
// ---------------------------------------------------------------------
async function handleCreateSession(req, res, session) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("intake_sessions")
      .insert({ created_by: session.email, status: "processing", updated_at: nowIso })
      .select("id, status, created_at")
      .single();
    if (error) throw error;
    res.status(200).json({ ok: true, id: data.id, status: data.status, createdAt: data.created_at });
  } catch (err) {
    console.error("Intake create-session failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not start a new intake." });
  }
}

// ---------------------------------------------------------------------
// POST /api/admin/intake?action=upload-screenshot — one screenshot per
// call, same raw-octet-stream-body shape as api/upload-photo.js (the only
// content type Vercel's Node runtime auto-buffers into req.body as a
// Buffer). The target session is named by the X-Intake-Session-Id header,
// not the body, since the body here IS the image bytes.
// ---------------------------------------------------------------------
async function handleUploadScreenshot(req, res) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const sessionId = String(req.headers["x-intake-session-id"] || "").trim();
  if (!sessionId || !UUID_RE.test(sessionId)) {
    res.status(400).json({ error: "A valid intake session id is required." });
    return;
  }

  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/octet-stream")) {
    res.status(415).json({ error: "Unsupported content type." });
    return;
  }

  const declaredType = String(req.headers["x-screenshot-type"] || "").toLowerCase().trim();
  if (!ALLOWED_TYPES[declaredType]) {
    res.status(400).json({ error: "Unsupported screenshot type." });
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_SCREENSHOT_BYTES) {
    res.status(413).json({ error: "Screenshot is too large." });
    return;
  }

  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    res.status(400).json({ error: "Invalid screenshot data." });
    return;
  }
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    res.status(413).json({ error: "Screenshot is too large." });
    return;
  }
  if (!matchesMagicBytes(buffer, declaredType)) {
    res.status(400).json({ error: "Screenshot data does not match its declared type." });
    return;
  }

  try {
    const sessionRes = await supabase.from("intake_sessions").select("id, status").eq("id", sessionId).maybeSingle();
    if (sessionRes.error) throw sessionRes.error;
    if (!sessionRes.data) {
      res.status(404).json({ error: "Intake session not found." });
      return;
    }
    // Only while still building the session, before extraction has run —
    // once extraction runs the screenshot set this stage reviewed against
    // must not silently change underneath it. See handleExtract()'s own
    // status gate for the matching rule on the other side.
    if (sessionRes.data.status !== "processing") {
      res.status(400).json({ error: "Screenshots can only be added before extraction has run." });
      return;
    }

    const countRes = await supabase.from("intake_screenshots").select("id", { count: "exact", head: true }).eq("intake_session_id", sessionId);
    if (countRes.error) throw countRes.error;
    const existingCount = countRes.count || 0;
    if (existingCount >= MAX_SCREENSHOTS_PER_SESSION) {
      res.status(400).json({ error: "Maximum number of screenshots already added to this intake." });
      return;
    }

    const fileName = crypto.randomUUID() + "." + ALLOWED_TYPES[declaredType];
    const storagePath = "intake/" + sessionId + "/" + fileName;

    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: declaredType,
      upsert: false,
    });
    if (uploadError) throw uploadError;

    let screenshotRow;
    try {
      screenshotRow = await insertScreenshotWithRetry(supabase, sessionId, storagePath, declaredType);
    } catch (insertError) {
      await safeDeleteStorageObject(supabase, storagePath);
      throw insertError;
    }

    res.status(200).json({ ok: true, screenshotId: screenshotRow.id, sortOrder: screenshotRow.sort_order });
  } catch (err) {
    console.error("Intake screenshot upload failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not upload screenshot. Please try again." });
  }
}

// ---------------------------------------------------------------------
// POST /api/admin/intake?action=extract — body { id }. Runs the whole
// session's screenshots through the vision adapter in ONE call (so the
// model can reason across them — see
// api/_lib/intake-vision-provider.js's own header), then computes the
// client match deterministically in THIS code, never the model. Allowed
// from 'processing' (the normal path) or 'extraction_failed' (retry with
// the same already-uploaded screenshots) — never from 'pending_review' or
// later, so a second call can never silently clobber an admin's review.
// ---------------------------------------------------------------------
async function handleExtract(req, res) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || !UUID_RE.test(id)) {
    res.status(404).json({ error: "Intake session not found." });
    return;
  }

  try {
    const sessionRes = await supabase.from("intake_sessions").select("id, status").eq("id", id).maybeSingle();
    if (sessionRes.error) throw sessionRes.error;
    if (!sessionRes.data) {
      res.status(404).json({ error: "Intake session not found." });
      return;
    }
    if (sessionRes.data.status !== "processing" && sessionRes.data.status !== "extraction_failed") {
      res.status(400).json({ error: "Extraction has already run for this intake." });
      return;
    }

    const screenshotsRes = await supabase
      .from("intake_screenshots")
      .select("id, storage_path, content_type, sort_order")
      .eq("intake_session_id", id)
      .order("sort_order", { ascending: true });
    if (screenshotsRes.error) throw screenshotsRes.error;
    const screenshots = screenshotsRes.data || [];
    if (screenshots.length === 0) {
      res.status(400).json({ error: "Add at least one screenshot before extracting." });
      return;
    }

    const images = [];
    for (const shot of screenshots) {
      const downloadRes = await supabase.storage.from(BUCKET).download(shot.storage_path);
      if (downloadRes.error) throw downloadRes.error;
      const arrayBuffer = await downloadRes.data.arrayBuffer();
      images.push({ base64: Buffer.from(arrayBuffer).toString("base64"), mimeType: shot.content_type });
    }

    const nowIso = new Date().toISOString();

    let extraction = null;
    let extractionError = null;
    try {
      extraction = await extractFromScreenshots({ images: images });
    } catch (err) {
      // Every failure mode (missing OPENAI_API_KEY today, a network error,
      // a malformed model response) reaches here identically — see
      // api/_lib/intake-vision-provider.js's own contract. The session
      // moves to extraction_failed; the uploaded screenshots are never
      // lost, and the admin can discard or retry.
      extractionError = err && err.message ? err.message : "Extraction failed.";
    }

    if (extractionError) {
      const { error: failUpdateError } = await supabase
        .from("intake_sessions")
        .update({ status: "extraction_failed", extraction_error: extractionError, updated_at: nowIso })
        .eq("id", id);
      if (failUpdateError) throw failUpdateError;
      res.status(200).json({ ok: true, id: id, status: "extraction_failed", error: extractionError });
      return;
    }

    const matchInfo = await computeClientMatch(supabase, extraction.fields.phone.value);

    const { error: updateError } = await supabase
      .from("intake_sessions")
      .update({
        status: "pending_review",
        ai_raw_extraction: extraction,
        extracted_data: extraction,
        extraction_error: null,
        classification: extraction.classification,
        classification_confidence: extraction.classificationConfidence,
        match_status: matchInfo.matchStatus,
        matched_customer_id: matchInfo.matchedCustomerId,
        extracted_phone_normalized: matchInfo.normalizedPhone,
        updated_at: nowIso,
      })
      .eq("id", id);
    if (updateError) throw updateError;

    res.status(200).json({ ok: true, id: id, status: "pending_review" });
  } catch (err) {
    console.error("Intake extraction failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not extract intake information." });
  }
}

// ---------------------------------------------------------------------
// GET /api/admin/intake — Pending Intake queue (default ?status=pending_review).
// ?countsOnly=1 returns just the pending count — same folding trick
// api/admin/bookings.js's Requests badge already uses, so the Pending
// Intake nav badge needs no new function either.
// ---------------------------------------------------------------------
async function handleList(req, res) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const countsOnly = req.query.countsOnly === "1";
  const statusFilter = typeof req.query.status === "string" && INTAKE_STATUSES.indexOf(req.query.status) !== -1 ? req.query.status : "pending_review";

  try {
    if (countsOnly) {
      const countRes = await supabase.from("intake_sessions").select("id", { count: "exact", head: true }).eq("status", "pending_review");
      if (countRes.error) throw countRes.error;
      res.status(200).json({ ok: true, pendingCount: countRes.count || 0 });
      return;
    }

    const listRes = await supabase
      .from("intake_sessions")
      .select("id, created_at, updated_at, status, classification, classification_confidence, match_status, matched_customer_id, extracted_data")
      .eq("status", statusFilter)
      .order("created_at", { ascending: false });
    if (listRes.error) throw listRes.error;

    const rows = listRes.data || [];
    // One batched lookup for every matched customer's display name, never
    // N+1 queries for an N-row list.
    const customerIds = Array.from(new Set(rows.map((r) => r.matched_customer_id).filter(Boolean)));
    const customersById = {};
    if (customerIds.length) {
      const custRes = await supabase.from("customers").select("id, first_name, last_name").in("id", customerIds);
      if (custRes.error) throw custRes.error;
      (custRes.data || []).forEach((c) => {
        customersById[c.id] = c;
      });
    }

    const intakes = rows.map((r) => {
      const customer = r.matched_customer_id ? customersById[r.matched_customer_id] : null;
      // extracted_data.fields.<key>.value is already null when the model
      // (or an admin correction) found nothing for that field — see
      // intake-vision-provider.js's normalizeExtractionResult(). No
      // confidence gate here: even a "likely"/"uncertain" OCR read is a
      // better list-card label than "Unidentified client", and the review
      // screen is where confidence actually gets corrected.
      const extractedFields = (r.extracted_data && r.extracted_data.fields) || {};
      const extractedName = [extractedFields.firstName, extractedFields.lastName]
        .map((f) => (f && f.value ? f.value : null))
        .filter(Boolean)
        .join(" ");
      return {
        id: r.id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        status: r.status,
        classification: r.classification,
        classificationConfidence: r.classification_confidence,
        matchStatus: r.match_status,
        // Priority: a matched existing client's real name (authoritative,
        // from `customers`) > a name the extraction found > phone > email.
        // "Unidentified client" is now only shown when NONE of those exist.
        matchedClientName: customer ? [customer.first_name, customer.last_name].filter(Boolean).join(" ") : null,
        extractedClientName: extractedName || null,
        extractedPhone: extractedFields.phone && extractedFields.phone.value ? extractedFields.phone.value : null,
        extractedEmail: extractedFields.email && extractedFields.email.value ? extractedFields.email.value : null,
        extractedServiceType: extractedFields.serviceType && extractedFields.serviceType.value ? extractedFields.serviceType.value : null,
      };
    });

    res.status(200).json({ ok: true, intakes: intakes });
  } catch (err) {
    console.error("Intake list failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load intakes." });
  }
}

// ---------------------------------------------------------------------
// GET /api/admin/intake?id=... — full review detail: fields, conflicts,
// classification, client match (with a job count when matched), existing-
// job candidates (only computed for classification = existing_job_update
// with a resolved client), and signed screenshot URLs.
// ---------------------------------------------------------------------
async function handleDetail(req, res, id) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Intake not found." });
    return;
  }

  try {
    const sessionRes = await supabase
      .from("intake_sessions")
      .select(
        "id, created_at, updated_at, status, extraction_error, extracted_data, classification, classification_confidence, match_status, matched_customer_id, linked_existing_booking_id, screenshots_expired_at, confirmed_at, confirmed_by, resulting_customer_id, resulting_booking_id"
      )
      .eq("id", id)
      .maybeSingle();
    if (sessionRes.error) throw sessionRes.error;
    const row = sessionRes.data;
    if (!row) {
      res.status(404).json({ error: "Intake not found." });
      return;
    }

    const screenshotsRes = await supabase
      .from("intake_screenshots")
      .select("id, storage_path, sort_order, created_at")
      .eq("intake_session_id", id)
      .order("sort_order", { ascending: true });
    if (screenshotsRes.error) throw screenshotsRes.error;

    const screenshots = [];
    for (const shot of screenshotsRes.data || []) {
      const signed = await supabase.storage.from(BUCKET).createSignedUrl(shot.storage_path, SCREENSHOT_URL_TTL_SECONDS);
      screenshots.push({
        id: shot.id,
        sortOrder: shot.sort_order,
        url: signed.data ? signed.data.signedUrl : null,
        createdAt: shot.created_at,
      });
    }

    let matchedClient = null;
    if (row.matched_customer_id) {
      const custRes = await supabase.from("customers").select("id, first_name, last_name, phone, email").eq("id", row.matched_customer_id).maybeSingle();
      if (custRes.error) throw custRes.error;
      if (custRes.data) {
        const jobCountRes = await supabase.from("bookings").select("id", { count: "exact", head: true }).eq("customer_id", row.matched_customer_id);
        if (jobCountRes.error) throw jobCountRes.error;
        matchedClient = {
          id: custRes.data.id,
          firstName: custRes.data.first_name,
          lastName: custRes.data.last_name,
          phone: custRes.data.phone,
          email: custRes.data.email,
          jobCount: jobCountRes.count || 0,
        };
      }
    }

    let existingJobCandidates = [];
    if (row.classification === "existing_job_update" && row.matched_customer_id) {
      const candRes = await supabase
        .from("bookings")
        .select("id, service_type, appointment_date, time_window, exact_time, status")
        .eq("customer_id", row.matched_customer_id)
        .in("status", EXISTING_JOB_CANDIDATE_STATUSES)
        .gte("appointment_date", denverTodayIso())
        .order("appointment_date", { ascending: true });
      if (candRes.error) throw candRes.error;
      existingJobCandidates = (candRes.data || []).map((b) => ({
        id: b.id,
        serviceType: b.service_type,
        appointmentDate: b.appointment_date,
        timeWindow: b.time_window,
        exactTime: b.exact_time,
        status: b.status,
      }));
    }

    res.status(200).json({
      ok: true,
      intake: {
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: row.status,
        extractionError: row.extraction_error,
        fields: row.extracted_data ? row.extracted_data.fields : null,
        conflicts: row.extracted_data ? row.extracted_data.conflicts : [],
        classification: row.classification,
        classificationConfidence: row.classification_confidence,
        matchStatus: row.match_status,
        matchedClient: matchedClient,
        linkedExistingBookingId: row.linked_existing_booking_id,
        existingJobCandidates: existingJobCandidates,
        screenshots: screenshots,
        screenshotsExpiredAt: row.screenshots_expired_at,
        confirmedAt: row.confirmed_at,
        confirmedBy: row.confirmed_by,
        resultingCustomerId: row.resulting_customer_id,
        resultingBookingId: row.resulting_booking_id,
      },
    });
  } catch (err) {
    console.error("Intake detail failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load intake." });
  }
}

// ---------------------------------------------------------------------
// PATCH /api/admin/intake — every review/edit/save-pending/confirm action,
// discriminated by body.action (same convention as api/admin/client.js's
// own PATCH).
//
// Stage 5D (confirm-booking/confirm-attach-existing): still NEVER writes to
// customers or bookings — see tests/phase3c-batch5-intake-endpoint.test.js's
// "never writes to customers or bookings" regression test, deliberately
// kept green. A booking/customer is created by the ADMIN'S BROWSER calling
// the existing, already-reviewed POST /api/admin/client and POST
// /api/admin/booking endpoints directly (exactly the same two calls the
// "+ New Job" flow already makes) — this file only ever records the
// resulting ids as read-pointers on its own intake_sessions row afterward.
// AI never writes directly anywhere, and neither does this file: every
// write below is either intake-session metadata (as always) or a pointer
// to a row an authenticated admin's own browser action just created/
// resolved through its own, independently-validated endpoint.
// ---------------------------------------------------------------------
async function handlePatch(req, res, session) {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const action = typeof body.action === "string" ? body.action.trim() : "";

  if (action === "update") return handleUpdateFields(req, res, body);
  if (action === "reclassify") return handleReclassify(req, res, body);
  if (action === "set-client-match") return handleSetClientMatch(req, res, body);
  if (action === "link-existing-booking") return handleLinkExistingBooking(req, res, body);
  if (action === "remove-screenshot") return handleRemoveScreenshot(req, res, body);
  if (action === "discard") return handleDiscard(req, res, body);
  if (action === "confirm-booking") return handleConfirmBooking(req, res, body, session);
  if (action === "confirm-attach-existing") return handleConfirmAttachExisting(req, res, body, session);

  res.status(400).json({ error: "Unknown action." });
}

// Admin just created or resolved a real booking (via POST /api/admin/client
// then POST /api/admin/booking, exactly like "+ New Job" — see this
// function's own module-level header) and is now recording that outcome on
// the intake. Body: { id, bookingId, customerId }. Re-validates bookingId
// actually belongs to customerId (defense in depth against a caller
// claiming an unrelated booking as this intake's outcome) before writing
// anything — never trusts the browser's say-so alone for the one fact that
// actually matters here.
//
// Idempotent against a double-click/retry: calling this again with the
// SAME bookingId/customerId on an already-confirmed intake is a no-op
// success (the booking was already created once; this merely re-records an
// identical outcome). Calling it with a DIFFERENT bookingId/customerId on
// an already-confirmed intake is refused — that would silently overwrite
// which booking this intake resolved to, which must never happen silently.
async function handleConfirmBooking(req, res, body, session) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const bookingId = typeof body.bookingId === "string" ? body.bookingId.trim() : "";
  const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
  if (!id || !UUID_RE.test(id)) {
    res.status(404).json({ error: "Intake not found." });
    return;
  }
  if (!bookingId || !UUID_RE.test(bookingId) || !customerId || !UUID_RE.test(customerId)) {
    res.status(400).json({ error: "A valid booking and client are required to confirm this intake." });
    return;
  }

  try {
    const sessionRes = await supabase
      .from("intake_sessions")
      .select("id, status, resulting_booking_id, resulting_customer_id")
      .eq("id", id)
      .maybeSingle();
    if (sessionRes.error) throw sessionRes.error;
    const row = sessionRes.data;
    if (!row) {
      res.status(404).json({ error: "Intake not found." });
      return;
    }

    if (row.status === "confirmed") {
      if (row.resulting_booking_id === bookingId && row.resulting_customer_id === customerId) {
        res.status(200).json({ ok: true, id: id, status: "confirmed", resultingBookingId: bookingId, resultingCustomerId: customerId });
        return;
      }
      res.status(400).json({ error: "This intake has already been confirmed to a different booking." });
      return;
    }
    if (row.status !== "pending_review") {
      res.status(400).json({ error: "This intake cannot be confirmed right now." });
      return;
    }

    const bookingRes = await supabase.from("bookings").select("id, customer_id").eq("id", bookingId).maybeSingle();
    if (bookingRes.error) throw bookingRes.error;
    if (!bookingRes.data || bookingRes.data.customer_id !== customerId) {
      res.status(400).json({ error: "That booking does not belong to the given client." });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("intake_sessions")
      .update({
        status: "confirmed",
        confirmed_at: nowIso,
        confirmed_by: session.email,
        resulting_customer_id: customerId,
        resulting_booking_id: bookingId,
        // The booking just confirmed into existence IS the resolved client
        // — any earlier needs_confirmation/new_candidate match state on
        // this intake is now moot, same as handleSetClientMatch's own
        // existing_exact transition.
        matched_customer_id: customerId,
        match_status: "existing_exact",
        updated_at: nowIso,
      })
      .eq("id", id);
    if (updateError) throw updateError;

    res.status(200).json({ ok: true, id: id, status: "confirmed", resultingBookingId: bookingId, resultingCustomerId: customerId });
  } catch (err) {
    console.error("Intake confirm-booking failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not confirm this intake." });
  }
}

// Existing Job Update classification: the admin already picked which of the
// matched client's existing bookings this screenshot is about (PATCH
// ?action=link-existing-booking, unchanged, still the only way
// linked_existing_booking_id gets set). Confirming here only ever records
// that pointer onto the intake — it NEVER modifies the linked booking
// itself, per the brief's explicit requirement ("any actual booking field
// changes must be separately reviewed/confirmed"). Body: { id } only.
async function handleConfirmAttachExisting(req, res, body, session) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || !UUID_RE.test(id)) {
    res.status(404).json({ error: "Intake not found." });
    return;
  }

  try {
    const sessionRes = await supabase
      .from("intake_sessions")
      .select("id, status, matched_customer_id, linked_existing_booking_id, resulting_booking_id, resulting_customer_id")
      .eq("id", id)
      .maybeSingle();
    if (sessionRes.error) throw sessionRes.error;
    const row = sessionRes.data;
    if (!row) {
      res.status(404).json({ error: "Intake not found." });
      return;
    }

    if (row.status === "confirmed") {
      if (row.resulting_booking_id === row.linked_existing_booking_id && row.linked_existing_booking_id) {
        res.status(200).json({ ok: true, id: id, status: "confirmed", resultingBookingId: row.resulting_booking_id, resultingCustomerId: row.resulting_customer_id });
        return;
      }
      res.status(400).json({ error: "This intake has already been confirmed." });
      return;
    }
    if (row.status !== "pending_review") {
      res.status(400).json({ error: "This intake cannot be confirmed right now." });
      return;
    }
    if (!row.linked_existing_booking_id) {
      res.status(400).json({ error: "Select an existing job to attach before confirming." });
      return;
    }
    if (!row.matched_customer_id) {
      // Can't happen in practice — linking a booking already requires a
      // matched client (see handleLinkExistingBooking) — but never trust
      // that invariant blindly when writing a confirmed/terminal state.
      res.status(400).json({ error: "Select a client before confirming." });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("intake_sessions")
      .update({
        status: "confirmed",
        confirmed_at: nowIso,
        confirmed_by: session.email,
        resulting_customer_id: row.matched_customer_id,
        resulting_booking_id: row.linked_existing_booking_id,
        updated_at: nowIso,
      })
      .eq("id", id);
    if (updateError) throw updateError;

    res.status(200).json({ ok: true, id: id, status: "confirmed", resultingBookingId: row.linked_existing_booking_id, resultingCustomerId: row.matched_customer_id });
  } catch (err) {
    console.error("Intake confirm-attach-existing failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not confirm this intake." });
  }
}

// Admin corrections to extracted field values, before confirming. Only
// ever merges into extracted_data.fields for keys in the fixed FIELD_KEYS
// list — an unrecognized key is silently ignored, never written, and
// nothing outside `fields` can be touched through this action (status/
// classification/match have their own dedicated actions below).
async function handleUpdateFields(req, res, body) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || !UUID_RE.test(id)) {
    res.status(404).json({ error: "Intake not found." });
    return;
  }
  const fieldsInput = body.fields && typeof body.fields === "object" && !Array.isArray(body.fields) ? body.fields : null;
  if (!fieldsInput || Object.keys(fieldsInput).length === 0) {
    res.status(400).json({ error: "No field corrections provided." });
    return;
  }

  try {
    const sessionRes = await supabase.from("intake_sessions").select("id, status, extracted_data").eq("id", id).maybeSingle();
    if (sessionRes.error) throw sessionRes.error;
    if (!sessionRes.data) {
      res.status(404).json({ error: "Intake not found." });
      return;
    }
    if (sessionRes.data.status !== "pending_review") {
      res.status(400).json({ error: "This intake cannot be edited right now." });
      return;
    }

    const current = sessionRes.data.extracted_data || { fields: {}, classification: null, classificationConfidence: null, conflicts: [] };
    const updatedFields = Object.assign({}, current.fields);

    Object.keys(fieldsInput).forEach((key) => {
      if (FIELD_KEYS.indexOf(key) === -1) return;
      const raw = fieldsInput[key];
      const value = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      // A human just supplied this value directly, so it is now confirmed
      // — and it stops being attributed to any particular screenshot,
      // since it may no longer match what that screenshot actually said.
      updatedFields[key] = { value: value, confidence: value === null ? "missing" : "confirmed", sourceIndex: null };
    });

    const updatedExtractedData = Object.assign({}, current, { fields: updatedFields });

    const { error: updateError } = await supabase
      .from("intake_sessions")
      .update({ extracted_data: updatedExtractedData, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (updateError) throw updateError;

    res.status(200).json({ ok: true, id: id });
  } catch (err) {
    console.error("Intake field update failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not save changes." });
  }
}

// Admin overrides the classification the model (or a prior reclassify)
// picked. Always treated as confirmed — the admin said so explicitly.
async function handleReclassify(req, res, body) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || !UUID_RE.test(id)) {
    res.status(404).json({ error: "Intake not found." });
    return;
  }
  const classification = typeof body.classification === "string" ? body.classification.trim() : "";
  if (CLASSIFICATIONS.indexOf(classification) === -1) {
    res.status(400).json({ error: "Invalid classification." });
    return;
  }

  try {
    const sessionRes = await supabase.from("intake_sessions").select("id, status, extracted_data").eq("id", id).maybeSingle();
    if (sessionRes.error) throw sessionRes.error;
    if (!sessionRes.data) {
      res.status(404).json({ error: "Intake not found." });
      return;
    }
    if (sessionRes.data.status !== "pending_review") {
      res.status(400).json({ error: "This intake cannot be edited right now." });
      return;
    }

    const current = sessionRes.data.extracted_data || {};
    const updatedExtractedData = Object.assign({}, current, { classification: classification, classificationConfidence: "confirmed" });

    const { error: updateError } = await supabase
      .from("intake_sessions")
      .update({
        classification: classification,
        classification_confidence: "confirmed",
        extracted_data: updatedExtractedData,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (updateError) throw updateError;

    res.status(200).json({ ok: true, id: id, classification: classification });
  } catch (err) {
    console.error("Intake reclassify failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not update classification." });
  }
}

// Admin resolves (or overrides) which existing customer this intake
// attaches to, or explicitly marks it as a new client. This is intake-
// session metadata only — see the file header: no customers row is ever
// touched here, only read once to confirm the given id is real.
async function handleSetClientMatch(req, res, body) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || !UUID_RE.test(id)) {
    res.status(404).json({ error: "Intake not found." });
    return;
  }
  const hasCustomerId = typeof body.matchedCustomerId === "string" && body.matchedCustomerId.trim() !== "";
  const matchedCustomerId = hasCustomerId ? body.matchedCustomerId.trim() : null;
  if (matchedCustomerId && !UUID_RE.test(matchedCustomerId)) {
    res.status(400).json({ error: "Invalid client id." });
    return;
  }

  try {
    const sessionRes = await supabase.from("intake_sessions").select("id, status").eq("id", id).maybeSingle();
    if (sessionRes.error) throw sessionRes.error;
    if (!sessionRes.data) {
      res.status(404).json({ error: "Intake not found." });
      return;
    }
    if (sessionRes.data.status !== "pending_review") {
      res.status(400).json({ error: "This intake cannot be edited right now." });
      return;
    }

    if (matchedCustomerId) {
      const custRes = await supabase.from("customers").select("id").eq("id", matchedCustomerId).maybeSingle();
      if (custRes.error) throw custRes.error;
      if (!custRes.data) {
        res.status(404).json({ error: "Client not found." });
        return;
      }
    }

    const { error: updateError } = await supabase
      .from("intake_sessions")
      .update({
        matched_customer_id: matchedCustomerId,
        match_status: matchedCustomerId ? "existing_exact" : "new_candidate",
        // A link to an existing booking only ever makes sense for the
        // client it was found under — changing (or clearing) the match
        // must always clear any previously-linked booking too.
        linked_existing_booking_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (updateError) throw updateError;

    res.status(200).json({ ok: true, id: id, matchStatus: matchedCustomerId ? "existing_exact" : "new_candidate" });
  } catch (err) {
    console.error("Intake set-client-match failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not update client match." });
  }
}

// Admin links this intake to one of the matched client's existing upcoming
// bookings (the existing_job_update case) — or clears that link. Records
// the choice on the intake row only; the linked booking itself is never
// read for anything beyond confirming it really belongs to the matched
// client, and is never written to.
async function handleLinkExistingBooking(req, res, body) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || !UUID_RE.test(id)) {
    res.status(404).json({ error: "Intake not found." });
    return;
  }
  const hasBookingId = typeof body.bookingId === "string" && body.bookingId.trim() !== "";
  const bookingId = hasBookingId ? body.bookingId.trim() : null;
  if (bookingId && !UUID_RE.test(bookingId)) {
    res.status(400).json({ error: "Invalid booking id." });
    return;
  }

  try {
    const sessionRes = await supabase.from("intake_sessions").select("id, status, matched_customer_id").eq("id", id).maybeSingle();
    if (sessionRes.error) throw sessionRes.error;
    if (!sessionRes.data) {
      res.status(404).json({ error: "Intake not found." });
      return;
    }
    if (sessionRes.data.status !== "pending_review") {
      res.status(400).json({ error: "This intake cannot be edited right now." });
      return;
    }

    if (bookingId) {
      if (!sessionRes.data.matched_customer_id) {
        res.status(400).json({ error: "Select a client before linking an existing job." });
        return;
      }
      const bookingRes = await supabase.from("bookings").select("id, customer_id").eq("id", bookingId).maybeSingle();
      if (bookingRes.error) throw bookingRes.error;
      if (!bookingRes.data || bookingRes.data.customer_id !== sessionRes.data.matched_customer_id) {
        res.status(400).json({ error: "That job does not belong to the matched client." });
        return;
      }
    }

    const { error: updateError } = await supabase
      .from("intake_sessions")
      .update({ linked_existing_booking_id: bookingId, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (updateError) throw updateError;

    res.status(200).json({ ok: true, id: id, linkedExistingBookingId: bookingId });
  } catch (err) {
    console.error("Intake link-existing-booking failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not update the linked job." });
  }
}

// Removes one screenshot from a still-open (not yet confirmed/discarded)
// intake — a real row delete plus its Storage object, per the brief. Does
// NOT re-run extraction; a field that screenshot was the sole source for
// stays as-is until the admin corrects it (handleUpdateFields) or the
// whole intake is discarded and re-uploaded.
async function handleRemoveScreenshot(req, res, body) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const screenshotId = typeof body.screenshotId === "string" ? body.screenshotId.trim() : "";
  if (!id || !UUID_RE.test(id) || !screenshotId || !UUID_RE.test(screenshotId)) {
    res.status(404).json({ error: "Intake or screenshot not found." });
    return;
  }

  try {
    const sessionRes = await supabase.from("intake_sessions").select("id, status").eq("id", id).maybeSingle();
    if (sessionRes.error) throw sessionRes.error;
    if (!sessionRes.data) {
      res.status(404).json({ error: "Intake not found." });
      return;
    }
    if (sessionRes.data.status !== "processing" && sessionRes.data.status !== "pending_review") {
      res.status(400).json({ error: "Screenshots cannot be changed on this intake anymore." });
      return;
    }

    const shotRes = await supabase.from("intake_screenshots").select("id, storage_path").eq("id", screenshotId).eq("intake_session_id", id).maybeSingle();
    if (shotRes.error) throw shotRes.error;
    if (!shotRes.data) {
      res.status(404).json({ error: "Screenshot not found." });
      return;
    }

    const { error: deleteError } = await supabase.from("intake_screenshots").delete().eq("id", screenshotId);
    if (deleteError) throw deleteError;

    await safeDeleteStorageObject(supabase, shotRes.data.storage_path);

    res.status(200).json({ ok: true, id: id, screenshotId: screenshotId });
  } catch (err) {
    console.error("Intake remove-screenshot failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not remove screenshot." });
  }
}

// Marks an intake discarded and cleans up its screenshots (rows + Storage
// objects). Idempotent: discarding an already-discarded intake is a no-op
// success, never an error. A confirmed intake can never be discarded —
// Stage 5D's job once it exists.
async function handleDiscard(req, res, body) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || !UUID_RE.test(id)) {
    res.status(404).json({ error: "Intake not found." });
    return;
  }

  try {
    const sessionRes = await supabase.from("intake_sessions").select("id, status").eq("id", id).maybeSingle();
    if (sessionRes.error) throw sessionRes.error;
    if (!sessionRes.data) {
      res.status(404).json({ error: "Intake not found." });
      return;
    }
    if (sessionRes.data.status === "confirmed") {
      res.status(400).json({ error: "A confirmed intake cannot be discarded." });
      return;
    }
    if (sessionRes.data.status === "discarded") {
      res.status(200).json({ ok: true, id: id, status: "discarded" });
      return;
    }

    await cleanupSessionScreenshots(supabase, id);

    const { error: updateError } = await supabase
      .from("intake_sessions")
      .update({ status: "discarded", updated_at: new Date().toISOString() })
      .eq("id", id);
    if (updateError) throw updateError;

    res.status(200).json({ ok: true, id: id, status: "discarded" });
  } catch (err) {
    console.error("Intake discard failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not discard intake." });
  }
}

// ---------------------------------------------------------------------
// GET/POST /api/admin/intake?action=cleanup-expired — Vercel Cron target
// (see vercel.json's "crons" entry), authenticated by CRON_SECRET instead
// of an admin session (see module.exports's own comment for why). NOT
// gated by requireAdmin() — this function performs its own auth check
// first, before touching the database, and fails closed (401) whenever
// CRON_SECRET isn't configured — exactly like api/_lib/intake-vision-
// provider.js's OPENAI_API_KEY: documented, inert until explicitly set.
//
// Sweeps two independent sets, per docs/phase-3/batch5-storage-design.md:
//   - processing/pending_review/extraction_failed older than
//     PENDING_RETENTION_DAYS (nobody reviewed it in time)
//   - confirmed older than CONFIRMED_RETENTION_DAYS (Stage 5D isn't built,
//     so no row can be 'confirmed' yet — this branch is a no-op today,
//     included so 5D needs no follow-up change here)
// Never touches a session that already has screenshots_expired_at set
// (nothing left to clean up) or one that's 'discarded' (already cleaned up
// immediately, by a different code path, for a different reason — see
// handleDiscard()). Only ever deletes screenshots (rows + Storage) and sets
// screenshots_expired_at/updated_at — extracted_data, ai_raw_extraction,
// classification, and every other column survive untouched, per the
// explicit requirement that the structured record outlives its source
// images.
// ---------------------------------------------------------------------
async function handleCleanupExpired(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = String(req.headers["authorization"] || "");
  if (!cronSecret || authHeader !== "Bearer " + cronSecret) {
    res.status(401).json({ error: "Not authorized." });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  try {
    const nowIso = new Date().toISOString();
    const pendingCutoff = new Date(Date.now() - PENDING_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const confirmedCutoff = new Date(Date.now() - CONFIRMED_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const pendingRes = await supabase
      .from("intake_sessions")
      .select("id")
      .in("status", ["processing", "pending_review", "extraction_failed"])
      .lt("created_at", pendingCutoff)
      .is("screenshots_expired_at", null);
    if (pendingRes.error) throw pendingRes.error;

    const confirmedRes = await supabase
      .from("intake_sessions")
      .select("id")
      .eq("status", "confirmed")
      .lt("created_at", confirmedCutoff)
      .is("screenshots_expired_at", null);
    if (confirmedRes.error) throw confirmedRes.error;

    const sessionIds = (pendingRes.data || []).concat(confirmedRes.data || []).map((r) => r.id);

    let cleanedCount = 0;
    for (const sessionId of sessionIds) {
      await cleanupSessionScreenshots(supabase, sessionId);
      const { error: markError } = await supabase
        .from("intake_sessions")
        .update({ screenshots_expired_at: nowIso, updated_at: nowIso })
        .eq("id", sessionId);
      if (markError) throw markError;
      cleanedCount++;
    }

    res.status(200).json({ ok: true, cleaned: cleanedCount });
  } catch (err) {
    console.error("Intake cleanup-expired failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Cleanup failed." });
  }
}
