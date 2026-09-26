// Vercel serverless function — single-client profile + full booking/job
// history (GET), and, as of Phase 3C Stage 2.1, client creation (POST). See
// api/_lib/admin-auth.js: requireAdmin() gates this entire route before
// either the `id` query param or the request body is ever looked at.
//
// IDOR note (GET): mirrors api/admin/booking.js exactly — the client id in
// the URL identifies *which* record is being asked for, never authorizes
// the request by itself. Every code path below runs only after
// requireAdmin() has already confirmed the caller is an authenticated,
// allowlisted admin.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");
const { serviceLabel, timeWindowLabel, effectiveTimeLabel, statusLabel, normalizedStatus } = require("../_lib/booking-format");
const { normalizePhone, normalizeEmail } = require("../_lib/customer-identity");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  if (req.method === "POST") return handleCreate(req, res);
  // Batch 2D — edit and archive/restore, both PATCH, discriminated by an
  // `action` field in the body (default "edit") — same shape as
  // api/admin/bookings.js's handlePatchExpense() rather than a query-param
  // resource, since this file has only ever had one resource (customers).
  if (req.method === "PATCH") return handlePatch(req, res, session);

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
      .select(
        "id, first_name, last_name, phone, email, address, city, state, zip, created_at, updated_at, updated_by, archived_at, archived_reason, archived_note, archived_by"
      )
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
        "id, service_type, appointment_date, time_window, exact_time, status, estimated_price, estimated_price_max, final_price, service_address, service_city, service_state, service_zip, created_at"
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
      timeLabel: effectiveTimeLabel(b.time_window, b.exact_time),
      status: normalizedStatus(b.status),
      statusLabel: statusLabel(b.status),
      estimatedPrice: b.estimated_price,
      estimatedPriceMax: b.estimated_price_max,
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
        updatedAt: customer.updated_at,
        updatedBy: customer.updated_by,
        archivedAt: customer.archived_at,
        archivedReason: customer.archived_reason,
        archivedNote: customer.archived_note,
        archivedBy: customer.archived_by,
      },
      bookings: bookings,
    });
  } catch (err) {
    console.error("Admin client detail failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load client." });
  }
};

// ---------------------------------------------------------------------
// Create a client (Phase 3C Stage 2.1) — POST /api/admin/client. Used both
// by inline creation during "+ New Job" (and, next stage, "+ Past Job") and
// a future standalone "+ New Client" page. This is the only place a new
// customers row is ever written from the admin side. Every field is read
// individually as a named primitive and sanitized/validated below — the
// request body is never spread into the insert payload.
//
// Only firstName is required (locked 2026-09-17, see
// docs/phase-3/stage2-decisions.md#3-admin-duplicate-client-behavior--locked
// and its phone-optional amendment): historical migration may include a
// legitimate client the owner no longer has a working phone number for, so
// phone/email/address are all optional and are normalized only when
// actually provided — never a placeholder value invented to satisfy a
// requirement that doesn't apply.
//
// Duplicate-safety policy (locked):
//   - phone_normalized AND email_normalized both match one existing row
//     ("exact match"): block creation, return 409 with that client's
//     summary, unless the caller explicitly resubmits with
//     confirmCreateAnyway:true.
//   - phone-only or email-only match: never blocks — creation proceeds,
//     the response carries a non-blocking `warnings` array.
//   - multiple/ambiguous matches: never auto-merged or auto-selected,
//     surfaced the same way as a partial match.
//   - neither phone nor email provided (or neither matches anything):
//     created outright, no fuzzy name/address matching of any kind.
// This is deliberately separate from api/book.js's own repeat-client
// lookup (Phase 3B Step 4a.3), which silently auto-reuses a single exact
// match with no human in the loop — correct for an unattended public form,
// wrong here, where a person can and must decide. Public booking behavior
// is completely unchanged by this addition.
async function handleCreate(req, res) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin client create failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

  const firstName = sanitizeText(body.firstName, MAX.name);
  if (!firstName) {
    res.status(400).json({ error: "First name is required." });
    return;
  }
  const lastName = sanitizeText(body.lastName, MAX.name) || null;

  const phoneInput = sanitizeText(body.phone, MAX.phone);
  if (phoneInput && !isValidPhone(phoneInput)) {
    res.status(400).json({ error: "Please enter a valid phone number." });
    return;
  }
  const phone = phoneInput || null;

  const emailInput = sanitizeText(body.email, MAX.email);
  if (emailInput && !isValidEmail(emailInput)) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }
  const email = emailInput || null;

  const address = sanitizeText(body.address, MAX.address) || null;
  const city = sanitizeText(body.city, MAX.city) || null;
  // Validated BEFORE truncating to MAX.state (2 chars) — truncating first
  // would silently turn "Colorado" into "CO" and accept it as if it were
  // already a valid 2-letter code, rather than rejecting the real input.
  const stateInput = sanitizeText(body.state, 40).toUpperCase();
  if (stateInput && !/^[A-Z]{2}$/.test(stateInput)) {
    res.status(400).json({ error: "Please enter a valid 2-letter state." });
    return;
  }
  const state = stateInput || null;
  const zipInput = sanitizeText(body.zip, MAX.zip);
  if (zipInput && !/^\d{5}(-\d{4})?$/.test(zipInput)) {
    res.status(400).json({ error: "Please enter a valid ZIP code." });
    return;
  }
  const zip = zipInput || null;

  const confirmCreateAnyway = body.confirmCreateAnyway === true;

  // Normalize only when provided. NULL (not "") when absent, so an absent
  // phone/email on two different clients can never itself register as a
  // "match" in the lookups below.
  const phoneNorm = phone ? normalizePhone(phone) : null;
  const emailNorm = email ? normalizeEmail(email) : null;

  let phoneMatches = [];
  let emailMatches = [];
  try {
    if (phoneNorm) {
      const r = await supabase.from("customers").select("id, first_name, last_name, phone, email, city").eq("phone_normalized", phoneNorm);
      if (r.error) throw r.error;
      phoneMatches = r.data || [];
    }
    if (emailNorm) {
      const r = await supabase.from("customers").select("id, first_name, last_name, phone, email, city").eq("email_normalized", emailNorm);
      if (r.error) throw r.error;
      emailMatches = r.data || [];
    }
  } catch (err) {
    console.error("Admin client create: duplicate lookup failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not check for existing clients. Please try again." });
    return;
  }

  // "Exact match" = present in both lookups at once — only possible when
  // both a phone and an email were submitted. A match on only one lookup
  // (or a lookup that never ran because that field was omitted) can never
  // be an exact match, by construction.
  const phoneMatchIds = new Set(phoneMatches.map((c) => c.id));
  const exactMatches = emailMatches.filter((c) => phoneMatchIds.has(c.id));

  if (exactMatches.length === 1 && !confirmCreateAnyway) {
    const existing = exactMatches[0];
    // 409 Conflict: the request is well-formed, but creating this exact
    // client now would silently duplicate one that already exists. Not an
    // error to log or retry — the client-picker UI is expected to offer
    // "Use this client" (existingClient.id, no further call needed) or
    // resubmit this same body with confirmCreateAnyway:true.
    res.status(409).json({
      error: "A client with this exact phone and email already exists.",
      code: "duplicate_client",
      existingClient: summarizeMatch(existing),
    });
    return;
  }

  // Non-blocking signal only, for every remaining case: a partial
  // (phone-only or email-only) match, or more than one exact match at once
  // (rare — phone_normalized+email_normalized together should identify at
  // most one row in practice — but never treated as license to auto-pick
  // one). Creation proceeds regardless of anything in `warnings`.
  const exactMatchIds = new Set(exactMatches.map((c) => c.id));
  const phoneOnly = phoneMatches.filter((c) => !exactMatchIds.has(c.id));
  const emailOnly = emailMatches.filter((c) => !exactMatchIds.has(c.id));
  const warnings = [];
  if (phoneOnly.length) warnings.push({ type: "phone_match", clients: phoneOnly.map(summarizeMatch) });
  if (emailOnly.length) warnings.push({ type: "email_match", clients: emailOnly.map(summarizeMatch) });
  if (exactMatches.length > 1) warnings.push({ type: "ambiguous_match", clients: exactMatches.map(summarizeMatch) });

  try {
    const { data: created, error } = await supabase
      .from("customers")
      .insert({
        first_name: firstName,
        last_name: lastName,
        phone: phone,
        email: email,
        address: address,
        city: city,
        state: state,
        zip: zip,
        phone_normalized: phoneNorm,
        email_normalized: emailNorm,
      })
      .select("id, first_name, last_name, phone, email, address, city, state, zip, created_at")
      .single();

    if (error || !created) throw error || new Error("Insert returned no row.");

    res.status(200).json({
      ok: true,
      client: {
        id: created.id,
        firstName: created.first_name,
        lastName: created.last_name,
        phone: created.phone,
        email: created.email,
        address: created.address,
        city: created.city,
        state: created.state,
        zip: created.zip,
        createdAt: created.created_at,
      },
      warnings: warnings,
    });
  } catch (err) {
    console.error("Admin client create failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not create client." });
  }
}

function summarizeMatch(c) {
  return { id: c.id, firstName: c.first_name, lastName: c.last_name, phone: c.phone, email: c.email, city: c.city };
}

// ---------------------------------------------------------------------
// Batch 2D — Edit Client (?action=edit, the default) and Archive/Restore
// Client (?action=archive|restore). See
// sql/2026-09-26_phase3c-stage5-archive-review-rental-client.sql for the
// full schema design.
// ---------------------------------------------------------------------

async function handlePatch(req, res, session) {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const action = typeof body.action === "string" ? body.action.trim() : "edit";
  if (action === "archive" || action === "restore") return handleArchiveAction(req, res, session, body, action);
  if (action === "edit") return handleEditAction(req, res, session, body);
  res.status(400).json({ error: "Invalid action." });
}

// PATCH { action: 'edit' (default), id, firstName, lastName, phone, email,
// address, city, state, zip } — the same field set and validation
// (sanitizeText/isValidPhone/isValidEmail/MAX below) as handleCreate()
// above, reused rather than duplicated. Never accepts or writes
// customer_id-adjacent or booking-specific fields — a client's existing
// bookings stay linked to the exact same customer_id by construction,
// since nothing here ever touches the bookings table at all. Recomputes
// phone_normalized/email_normalized whenever phone/email change, same
// invariant handleCreate() already maintains, so duplicate-detection on a
// future client creation keeps working correctly against this edited row.
async function handleEditAction(req, res, session, body) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin client edit failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || !UUID_RE.test(id)) {
    res.status(404).json({ error: "Client not found." });
    return;
  }

  const firstName = sanitizeText(body.firstName, MAX.name);
  if (!firstName) {
    res.status(400).json({ error: "First name is required." });
    return;
  }
  const lastName = sanitizeText(body.lastName, MAX.name) || null;

  const phoneInput = sanitizeText(body.phone, MAX.phone);
  if (phoneInput && !isValidPhone(phoneInput)) {
    res.status(400).json({ error: "Please enter a valid phone number." });
    return;
  }
  const phone = phoneInput || null;

  const emailInput = sanitizeText(body.email, MAX.email);
  if (emailInput && !isValidEmail(emailInput)) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }
  const email = emailInput || null;

  const address = sanitizeText(body.address, MAX.address) || null;
  const city = sanitizeText(body.city, MAX.city) || null;
  const stateInput = sanitizeText(body.state, 40).toUpperCase();
  if (stateInput && !/^[A-Z]{2}$/.test(stateInput)) {
    res.status(400).json({ error: "Please enter a valid 2-letter state." });
    return;
  }
  const state = stateInput || null;
  const zipInput = sanitizeText(body.zip, MAX.zip);
  if (zipInput && !/^\d{5}(-\d{4})?$/.test(zipInput)) {
    res.status(400).json({ error: "Please enter a valid ZIP code." });
    return;
  }
  const zip = zipInput || null;

  const phoneNorm = phone ? normalizePhone(phone) : null;
  const emailNorm = email ? normalizeEmail(email) : null;

  try {
    const { data: updated, error } = await supabase
      .from("customers")
      .update({
        first_name: firstName,
        last_name: lastName,
        phone: phone,
        email: email,
        address: address,
        city: city,
        state: state,
        zip: zip,
        phone_normalized: phoneNorm,
        email_normalized: emailNorm,
        updated_at: new Date().toISOString(),
        updated_by: session.email,
      })
      .eq("id", id)
      .select("id, first_name, last_name, phone, email, address, city, state, zip, created_at, updated_at, updated_by")
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(404).json({ error: "Client not found." });
      return;
    }

    res.status(200).json({
      ok: true,
      client: {
        id: updated.id,
        firstName: updated.first_name,
        lastName: updated.last_name,
        phone: updated.phone,
        email: updated.email,
        address: updated.address,
        city: updated.city,
        state: updated.state,
        zip: updated.zip,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
        updatedBy: updated.updated_by,
      },
    });
  } catch (err) {
    console.error("Admin client edit failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not save changes." });
  }
}

const ARCHIVE_REASONS = ["duplicate_client", "test_spam", "requested_removal", "entered_by_mistake", "other"];

// Same reasoning as api/admin/booking.js's writeBookingAuditLog(): an
// application-level write (not a trigger — this is administrative state,
// not financial data), run AFTER the customers update that made the event
// true, with a small immutable summary snapshot so the row stays readable
// even after customer_id later goes NULL (a hard customer delete — see
// docs/phase-3/database-schema-updates.md — has no code path in this repo
// today, but the FK is designed to survive one regardless).
async function writeCustomerAuditLog(supabase, customer, customerId, eventType, reason, note, changedBy) {
  const summary = [customer.first_name, customer.last_name].filter(Boolean).join(" ") + (customer.phone ? " — " + customer.phone : "") || "Unknown client";
  const { error } = await supabase.from("customer_audit_log").insert({
    customer_id: customerId,
    customer_id_snapshot: customerId,
    customer_summary_snapshot: summary,
    event_type: eventType,
    reason: reason || null,
    note: note || null,
    changed_by: changedBy || null,
  });
  if (error) throw error;
}

// PATCH { action: 'archive'|'restore', id, reason?, note? }. Archive/
// restore is a visibility flag only — this handler touches customers and
// customer_audit_log alone, never bookings/job_payments/dumpster_rentals/
// expenses, so a client's existing job history is structurally untouched
// by construction. Archiving never touches that client's existing
// bookings either — they keep displaying this client's information via
// the same GET this file already serves (unfiltered by archived_at, see
// module.exports above), exactly as before.
async function handleArchiveAction(req, res, session, body, action) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin client archive failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || !UUID_RE.test(id)) {
    res.status(404).json({ error: "Client not found." });
    return;
  }

  try {
    const currentRes = await supabase
      .from("customers")
      .select("id, first_name, last_name, phone, archived_at")
      .eq("id", id)
      .maybeSingle();
    if (currentRes.error) throw currentRes.error;
    const current = currentRes.data;
    if (!current) {
      res.status(404).json({ error: "Client not found." });
      return;
    }

    const nowIso = new Date().toISOString();

    if (action === "archive") {
      if (current.archived_at) {
        res.status(409).json({ error: "This client is already archived." });
        return;
      }

      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (ARCHIVE_REASONS.indexOf(reason) === -1) {
        res.status(400).json({ error: "Please choose a valid archive reason." });
        return;
      }
      const note = sanitizeText(body.note, 2000) || null;
      if (reason === "other" && !note) {
        res.status(400).json({ error: "A note is required when the reason is Other." });
        return;
      }

      const { data: updated, error } = await supabase
        .from("customers")
        .update({ archived_at: nowIso, archived_reason: reason, archived_note: note, archived_by: session.email, updated_at: nowIso })
        .eq("id", id)
        .is("archived_at", null)
        .select("id, archived_at, archived_reason, archived_note, archived_by")
        .maybeSingle();
      if (error) throw error;
      if (!updated) {
        res.status(409).json({ error: "This client was just archived by someone else. Please refresh and try again." });
        return;
      }

      await writeCustomerAuditLog(supabase, current, id, "archive", reason, note, session.email);

      res.status(200).json({
        ok: true,
        archivedAt: updated.archived_at,
        archivedReason: updated.archived_reason,
        archivedNote: updated.archived_note,
        archivedBy: updated.archived_by,
      });
      return;
    }

    // action === "restore"
    if (!current.archived_at) {
      res.status(409).json({ error: "This client is not archived." });
      return;
    }

    const { data: restored, error } = await supabase
      .from("customers")
      .update({ archived_at: null, archived_reason: null, archived_note: null, archived_by: null, updated_at: nowIso })
      .eq("id", id)
      .not("archived_at", "is", null)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!restored) {
      res.status(409).json({ error: "This client was just restored by someone else. Please refresh and try again." });
      return;
    }

    await writeCustomerAuditLog(supabase, current, id, "restore", null, null, session.email);

    res.status(200).json({ ok: true, archivedAt: null });
  } catch (err) {
    console.error("Admin client archive/restore failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not update this client's archive status." });
  }
}

// Same bounded-length values as api/book.js's own MAX (kept as a small,
// deliberate local copy per this project's established convention — see
// api/_lib/booking-format.js's header — rather than importing from the
// public booking endpoint).
const MAX = { name: 80, phone: 30, email: 254, address: 200, city: 80, zip: 10 };

// Same sanitize/validate helpers as api/book.js's own: strip control
// characters and any "<...>"-shaped text, trim, bound length; phone format
// is 10-15 digits; email is a plain shape check bounded by MAX.email.
function sanitizeText(value, maxLen) {
  if (typeof value !== "string") return "";
  var stripped = "";
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    var isControl = code <= 31 && code !== 9 && code !== 10 && code !== 13;
    if (!isControl) stripped += value[i];
  }
  return stripped.replace(/<[^>]*>/g, "").trim().slice(0, maxLen);
}

function isValidPhone(value) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 && /^[0-9+()\-.\s]+$/.test(value);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= MAX.email;
}
