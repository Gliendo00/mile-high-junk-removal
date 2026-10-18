// Vercel serverless function — Phase 3C Stage 5D: Confirm as Lead. The
// 12th/last Vercel Hobby-plan function slot (see
// sql/2026-10-04_phase3c-batch5-intake-sessions.sql's header and
// sql/2026-10-05_phase3c-batch6-leads.sql's header, both of which left this
// exact file reserved for this exact purpose).
//
// Scope: ONE action — convert a reviewed, pending_review intake_sessions
// row (classification lead_only/quote_discussion, though nothing here
// actually gates on that string — see handleConfirm()'s own comment) into
// a real `leads` row. This is the only file in the codebase with a write
// grant on `leads`; api/admin/intake.js deliberately has none (see that
// file's own header) and api/admin/bookings.js's ?view=leads is read-only.
//
// Safety discipline (same posture as every other Batch 5/6 write path):
//   - AI never writes directly — every field written here came from
//     intake_sessions.extracted_data, which only ever holds what the admin
//     has already reviewed/corrected via api/admin/intake.js's own PATCH
//     actions (?action=update/reclassify/set-client-match).
//   - No duplicate customer is ever created — a lead only ever points at
//     an EXISTING customers.id (matched_customer_id, copied verbatim from
//     the intake's own already-resolved match) or no customer at all.
//     Nothing in this file inserts into `customers`.
//   - An ambiguous client match (match_status = 'needs_confirmation') is
//     refused outright rather than guessed — the admin must resolve it via
//     api/admin/intake.js's ?action=set-client-match first (same rule
//     applied to Confirm Booking; see api/admin/intake.js's
//     handleConfirmBooking()).
//   - Idempotent against a double-click/retry: leads_source_intake_id_uniq
//     (sql/2026-10-05_...sql §1) makes a second POST for the same intake a
//     structural no-op (23505 -> this file fetches and returns the row
//     that already exists), never a second lead row.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");
const { normalizePhone } = require("../_lib/customer-identity");
const { serviceLabel, normalizedStatus, statusLabel } = require("../_lib/booking-format");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSTGRES_UNIQUE_VIOLATION = "23505";
const MAX_TEXT = 2000;

// UI batch (lead-detail navigation fix): the Leads workspace bucket labels,
// duplicated from api/admin/bookings.js's LEADS_BUCKET_LABELS rather than
// imported — this project's established per-file convention (see this
// file's own header re: not sharing api/admin/intake.js's helpers). Only
// the 7 values leads.status's own CHECK constraint allows are here.
const LEAD_STATUS_LABELS = {
  new: "New",
  contacted: "Contacted",
  waiting_on_photos: "Waiting on Photos",
  estimate_sent: "Estimate Sent",
  follow_up: "Follow Up",
  booked: "Booked/Won",
  lost: "Lost",
};

module.exports = async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  if (req.method === "GET") {
    return handleGet(req, res);
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  return handleConfirm(req, res, session);
};

function serverNotConfigured(res) {
  console.error("Admin lead failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
  res.status(500).json({ error: "Admin data is not available right now." });
}

// Same sanitize helper every other admin write endpoint keeps as its own
// small local copy (see api/admin/booking.js's sanitizeText()) rather than
// a shared import — this project's established convention.
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

// One extracted field's reviewed value, or null — never the field object
// itself. extracted_data.fields.<key> is always { value, confidence,
// sourceIndex } (see api/_lib/intake-vision-provider.js's FIELD_SCHEMA) by
// the time an intake has reached pending_review; defensively tolerant of a
// missing key regardless.
function fieldValue(fields, key) {
  const f = fields && fields[key];
  const raw = f && typeof f.value === "string" ? f.value.trim() : "";
  return raw ? sanitizeText(raw, MAX_TEXT) : null;
}

// leads.quoted_amount / quoted_amount_max are numeric — the intake field
// they come from is free text an admin typed or the model read off a
// screenshot (e.g. "$350", "around $300-350"). Detects a two-ended range
// ("$200-$275", "$200 to $275") and returns BOTH ends rather than the
// previous behavior of stripping everything but digits/decimal point,
// which silently concatenated a range into one garbled number (e.g.
// "around $300-350" -> "300350" -> $300,350). A single value parses as
// { min, max: null }; anything unparseable/ambiguous (no number, 3+
// numbers, two numbers with no range-like separator between them, "TBD",
// empty) is { min: null, max: null } — same "never guess, let the admin
// fill it in" posture as before, just no longer able to merge digits
// together. Never blocks lead creation either way.
//
// IMPORTANT: this is duplicated (not imported) in admin/intake-detail.js's
// own parseQuotedAmountRange() — that file runs in the browser with no
// module system, so a shared api/_lib import isn't reachable from it (same
// reasoning as every other client/server pair of "identical small helper"
// in this codebase, e.g. admin/booking-new.js's own TIME_WINDOWS copy).
// Keep both copies in sync if this logic ever changes.
function parseQuotedAmountRange(raw) {
  function toNumber(s) {
    const n = Number(String(s).replace(/,/g, ""));
    return Number.isFinite(n) && n >= 0 && n <= 999999 ? Math.round(n * 100) / 100 : null;
  }
  if (!raw) return { min: null, max: null };
  const matches = raw.match(/\d[\d,]*\.?\d*/g);
  if (!matches) return { min: null, max: null };
  if (matches.length === 1) return { min: toNumber(matches[0]), max: null };
  if (matches.length === 2) {
    const firstIdx = raw.indexOf(matches[0]);
    const betweenStart = firstIdx + matches[0].length;
    const secondIdx = raw.indexOf(matches[1], betweenStart);
    const between = raw.slice(betweenStart, secondIdx);
    if (/^\s*(-|–|—|to|~)\s*\$?\s*$/i.test(between)) {
      const a = toNumber(matches[0]);
      const b = toNumber(matches[1]);
      // Ordered by VALUE, not by which one appears first in the text — a
      // reversed/typo'd range ("$275-$200") must still become a real
      // {min:200, max:275} range, never silently collapse to just the
      // first-seen number (which, for a reversed range, would read as
      // picking "the maximum" — exactly the forbidden silent collapse).
      if (a !== null && b !== null) {
        if (a === b) return { min: a, max: null };
        return { min: Math.min(a, b), max: Math.max(a, b) };
      }
      if (a !== null) return { min: a, max: null };
      if (b !== null) return { min: b, max: null };
    }
  }
  return { min: null, max: null };
}

// Combines serviceDetails (the primary field) with itemDescription (what's
// actually being removed/dropped off) when both are present — leads has no
// separate itemDescription column (unlike intake_sessions.extracted_data),
// so this is the one place that information folds into service_details
// rather than being silently dropped.
function buildServiceDetails(fields) {
  const details = fieldValue(fields, "serviceDetails");
  const item = fieldValue(fields, "itemDescription");
  if (details && item) return sanitizeText(details + " — Items: " + item, MAX_TEXT);
  return details || item;
}

// Combines internalNotes + clientConstraints (+ a one-line flag when
// photosReferenced === "yes") into leads.notes, leads' one free-text notes
// column — same "fold multiple intake fields into the closest matching
// column, never silently drop one" reasoning as buildServiceDetails above.
function buildNotes(fields) {
  const parts = [];
  const internal = fieldValue(fields, "internalNotes");
  const constraints = fieldValue(fields, "clientConstraints");
  if (internal) parts.push(internal);
  if (constraints) parts.push(constraints);
  const photos = fields && fields.photosReferenced && fields.photosReferenced.value;
  if (photos === "yes") parts.push("Photos referenced in conversation.");
  return parts.length ? sanitizeText(parts.join("\n\n"), MAX_TEXT) : null;
}

// ---------------------------------------------------------------------
// POST /api/admin/lead — body { intakeSessionId }. See file header.
// ---------------------------------------------------------------------
async function handleConfirm(req, res, session) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const intakeSessionId = typeof body.intakeSessionId === "string" ? body.intakeSessionId.trim() : "";
  if (!intakeSessionId || !UUID_RE.test(intakeSessionId)) {
    res.status(404).json({ error: "Intake not found." });
    return;
  }

  try {
    const intakeRes = await supabase
      .from("intake_sessions")
      .select("id, status, match_status, matched_customer_id, extracted_data, resulting_customer_id")
      .eq("id", intakeSessionId)
      .maybeSingle();
    if (intakeRes.error) throw intakeRes.error;
    const intake = intakeRes.data;
    if (!intake) {
      res.status(404).json({ error: "Intake not found." });
      return;
    }

    if (intake.status === "confirmed") {
      // Idempotent re-POST (double-click/retry): if a lead already points
      // back at this intake, this is the SAME confirmation completing
      // again, never a second one — leads_source_intake_id_uniq guarantees
      // at most one exists. If none exists, this intake was confirmed via
      // a DIFFERENT path (Confirm Booking/Confirm Attach), which this
      // action can't retroactively convert.
      const existingRes = await supabase.from("leads").select("id, status, created_at").eq("source_intake_id", intakeSessionId).maybeSingle();
      if (existingRes.error) throw existingRes.error;
      if (existingRes.data) {
        res.status(200).json({ ok: true, lead: { id: existingRes.data.id, status: existingRes.data.status, createdAt: existingRes.data.created_at } });
        return;
      }
      res.status(400).json({ error: "This intake was already confirmed through a different action." });
      return;
    }
    if (intake.status !== "pending_review") {
      res.status(400).json({ error: "This intake cannot be confirmed right now." });
      return;
    }
    if (intake.match_status === "needs_confirmation") {
      res.status(400).json({ error: "Select a client before confirming this as a lead." });
      return;
    }

    const fields = (intake.extracted_data && intake.extracted_data.fields) || {};
    const firstName = fieldValue(fields, "firstName");
    const lastName = fieldValue(fields, "lastName");
    const phone = fieldValue(fields, "phone");
    const email = fieldValue(fields, "email");
    if (!firstName && !phone && !email) {
      res.status(400).json({ error: "Add a name, phone, or email before confirming this as a lead." });
      return;
    }

    const quotedRange = parseQuotedAmountRange(fieldValue(fields, "quotedAmount"));

    const leadPayload = {
      created_by: session.email,
      source: "screenshot_intake",
      source_intake_id: intakeSessionId,
      status: "new",
      first_name: firstName,
      last_name: lastName,
      phone: phone,
      phone_normalized: phone ? normalizePhone(phone) : null,
      email: email,
      address: fieldValue(fields, "address"),
      city: fieldValue(fields, "city"),
      state: fieldValue(fields, "state"),
      zip: fieldValue(fields, "zip"),
      service_type: fieldValue(fields, "serviceType"),
      service_details: buildServiceDetails(fields),
      estimated_load_size: fieldValue(fields, "estimatedLoadSize"),
      quoted_amount: quotedRange.min,
      quoted_amount_max: quotedRange.max,
      notes: buildNotes(fields),
      matched_customer_id: intake.matched_customer_id || null,
    };

    let lead;
    const insertRes = await supabase.from("leads").insert(leadPayload).select("id, status, created_at").single();
    if (insertRes.error) {
      if (insertRes.error.code === POSTGRES_UNIQUE_VIOLATION) {
        // Lost a race with another admin/tab/retry that confirmed this
        // exact intake a moment ago — leads_source_intake_id_uniq fired.
        // Fetch and return THAT row rather than erroring; never a second
        // lead for the same intake.
        const racedRes = await supabase.from("leads").select("id, status, created_at").eq("source_intake_id", intakeSessionId).maybeSingle();
        if (racedRes.error) throw racedRes.error;
        if (!racedRes.data) throw insertRes.error;
        lead = racedRes.data;
      } else {
        throw insertRes.error;
      }
    } else {
      lead = insertRes.data;
    }

    const nowIso = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("intake_sessions")
      .update({
        status: "confirmed",
        confirmed_at: nowIso,
        confirmed_by: session.email,
        resulting_customer_id: intake.matched_customer_id || null,
        updated_at: nowIso,
      })
      .eq("id", intakeSessionId);
    if (updateError) throw updateError;

    res.status(200).json({ ok: true, lead: { id: lead.id, status: lead.status, createdAt: lead.created_at } });
  } catch (err) {
    console.error("Admin lead confirm failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not confirm this intake as a lead." });
  }
}

const LEAD_DETAIL_COLS =
  "id, created_at, created_by, updated_at, updated_by, source, source_intake_id, status, first_name, last_name, phone, email, address, city, state, zip, service_type, service_details, estimated_load_size, quoted_amount, quoted_amount_max, notes, next_follow_up_date, matched_customer_id";

// ---------------------------------------------------------------------
// GET /api/admin/lead?id=<uuid> — UI batch (lead-detail navigation fix).
// This file's existing POST write path (handleConfirm above) is the only
// place a `leads` row is created; nothing here writes anything. A lead's
// own matched client (if any) is read-only enrichment, exactly like every
// other admin detail endpoint's customer lookup (api/admin/booking.js,
// api/admin/intake.js) — never a second source of truth for the match.
// ---------------------------------------------------------------------
async function handleGet(req, res) {
  const supabase = getServiceClient();
  if (!supabase) return serverNotConfigured(res);

  const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
  if (!id || !UUID_RE.test(id)) {
    // Same "malformed id reads as not found" posture as api/admin/client.js
    // and api/admin/booking.js — never confirms anything about id format.
    res.status(404).json({ error: "Lead not found." });
    return;
  }

  try {
    const leadRes = await supabase.from("leads").select(LEAD_DETAIL_COLS).eq("id", id).maybeSingle();
    if (leadRes.error) throw leadRes.error;
    const lead = leadRes.data;
    if (!lead) {
      res.status(404).json({ error: "Lead not found." });
      return;
    }

    let matchedClient = null;
    if (lead.matched_customer_id) {
      const custRes = await supabase
        .from("customers")
        .select("id, first_name, last_name, phone, email, city")
        .eq("id", lead.matched_customer_id)
        .maybeSingle();
      // Non-fatal: an unresolved match (e.g. the customer was since
      // archived/deleted — customers are never hard-deleted today, but this
      // stays defensive either way) just means matchedClient renders null
      // rather than failing the whole lead view over a secondary lookup.
      if (!custRes.error && custRes.data) {
        const c = custRes.data;
        matchedClient = { id: c.id, firstName: c.first_name, lastName: c.last_name, phone: c.phone, email: c.email, city: c.city };
      }
    }

    // Estimate workflow — Lead pipeline visibility. Read-only enrichment,
    // same non-fatal posture as matchedClient above: this is the ONE most
    // recent estimate (if any) and the ONE most recent booking (if any)
    // this lead has produced, so Lead Detail can show "no estimate/job yet
    // / estimate scheduled / estimate completed / job booked" without a
    // second page or a Kanban board. Never written here — purely a read of
    // what api/admin/booking.js's handleCreateEstimate()/handleCreate()
    // already wrote.
    let pipelineEstimate = null;
    let pipelineBooking = null;
    try {
      const [estimateRes, bookingRes] = await Promise.all([
        supabase
          .from("estimates")
          .select("id, status, appointment_date, converted_booking_id")
          .eq("source_lead_id", id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("bookings")
          .select("id, status, appointment_date")
          .eq("source_lead_id", id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (!estimateRes.error && estimateRes.data) {
        const e = estimateRes.data;
        pipelineEstimate = { id: e.id, status: e.status, appointmentDate: e.appointment_date, convertedBookingId: e.converted_booking_id };
      }
      if (!bookingRes.error && bookingRes.data) {
        const b = bookingRes.data;
        pipelineBooking = { id: b.id, status: normalizedStatus(b.status), statusLabel: statusLabel(b.status), appointmentDate: b.appointment_date };
      }
    } catch (pipelineErr) {
      // Non-fatal — the lead view must never 500 over this enrichment.
      console.error("Admin lead detail: pipeline enrichment failed (non-fatal):", pipelineErr);
    }

    res.status(200).json({
      ok: true,
      lead: {
        id: lead.id,
        source: lead.source,
        sourceIntakeId: lead.source_intake_id,
        status: lead.status,
        statusLabel: LEAD_STATUS_LABELS[lead.status] || lead.status,
        firstName: lead.first_name,
        lastName: lead.last_name,
        phone: lead.phone,
        email: lead.email,
        address: lead.address,
        city: lead.city,
        state: lead.state,
        zip: lead.zip,
        serviceType: lead.service_type,
        serviceLabel: lead.service_type ? serviceLabel(lead.service_type) : null,
        serviceDetails: lead.service_details,
        estimatedLoadSize: lead.estimated_load_size,
        quotedAmount: lead.quoted_amount,
        quotedAmountMax: lead.quoted_amount_max,
        notes: lead.notes,
        nextFollowUpDate: lead.next_follow_up_date,
        createdAt: lead.created_at,
        createdBy: lead.created_by,
        updatedAt: lead.updated_at,
        updatedBy: lead.updated_by,
        matchedClient: matchedClient,
        pipelineEstimate: pipelineEstimate,
        pipelineBooking: pipelineBooking,
      },
    });
  } catch (err) {
    console.error("Admin lead detail failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load this lead." });
  }
}
