// Interactive Pricing Calculator — server side of "Save to Job".
// Dispatched from api/admin/booking.js's ?resource=price-estimate branch
// (same "one more branch on an existing route" convention every other CRM
// feature uses, so no new Vercel function slot is consumed). requireAdmin()
// has ALREADY run before either handler here is reached.
//
// What a save does — and, just as important, never does:
//   - Writes exactly one row in public.job_price_estimates
//     (sql/2026-11-16_job-price-estimates.sql): the selections plus a
//     breakdown RE-COMPUTED HERE by admin/pricing-calculator-core.js. The
//     browser's own total is only compared against ours (a mismatch is a
//     409, never "trust the client").
//   - Optionally, only when the request explicitly asks
//     (applyToQuotedAmount: true), sets bookings.estimated_price — the
//     job's existing "Quoted" field, the same one Edit Job writes. Refused
//     for completed/lost/archived/complimentary jobs (a completed job with
//     no final_price is counted as revenue FROM estimated_price by
//     admin/schedule-financials.js, so writing it there would change
//     reported revenue). Replacing an existing, different quote requires
//     confirmQuotedOverwrite: true.
//   - NEVER touches final_price, tip_amount, status, invoices,
//     invoice_line_items, job_payments, Stripe, or sends any email/SMS.
//     Nothing in this file imports any of those modules.
//
// Overwrite + duplicate protection:
//   - expectedRevision: null means "create the first saved breakdown"; a
//     job that already has one gets 409 estimate_exists (the UI then asks
//     the user to explicitly replace it). A number means "replace the
//     revision I loaded"; the UPDATE is conditioned on that revision, so a
//     concurrent save from another device gets 409 revision_conflict.
//   - requestKey: a client-generated key per save intent. Re-sending the
//     same key (double tap, network retry after a lost response) returns
//     the already-saved row with duplicate: true instead of writing again.
const Core = require("../../admin/pricing-calculator-core.js");
const { getServiceClient } = require("./supabase-admin");
const { normalizedStatus, statusLabel, serviceLabel } = require("./booking-format");
const { decimalDollarsToCents, centsToDecimalString } = require("./money");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ESTIMATE_COLS = "id, booking_id, load_tier, input, line_items, subtotal_cents, discount_cents, total_cents, confirmed_on_site, staff_notes, revision, last_request_key, created_at, created_by, updated_at, updated_by";
const BOOKING_COLS = "id, customer_id, service_type, status, appointment_date, estimated_price, estimated_price_max, final_price, is_complimentary, archived_at, updated_at";

// Service types this calculator prices. Dumpster rentals have their own
// flat-rate pricing (api/_lib/rental-pricing.js) and a pickup leg never
// carries price fields at all.
const PRICEABLE_SERVICE_TYPES = ["junk_removal", "light_demo"];
// Statuses where the job's Quoted Amount may be set from a saved
// breakdown — i.e. the job has not happened yet. See header.
const QUOTE_WRITABLE_STATUSES = ["new", "contacted", "quoted", "booked"];

function isMissingTableError(err) {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" || /job_price_estimates/.test(String(err.message || "")) && /does not exist|schema cache/i.test(String(err.message || ""));
}

function mapEstimate(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookingId: row.booking_id,
    loadTier: row.load_tier,
    input: row.input,
    lineItems: row.line_items,
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    totalCents: row.total_cents,
    confirmedOnSite: !!row.confirmed_on_site,
    staffNotes: row.staff_notes || "",
    revision: row.revision,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function quoteEligibility(booking) {
  const status = normalizedStatus(booking.status);
  if (booking.archived_at) return { allowed: false, reason: "This job is archived." };
  if (booking.is_complimentary) return { allowed: false, reason: "This job is marked complimentary." };
  if (QUOTE_WRITABLE_STATUSES.indexOf(status) === -1) return { allowed: false, reason: "The quoted amount can't be changed on a " + statusLabel(status).toLowerCase() + " job." };
  return { allowed: true, reason: null };
}

function mapBooking(booking, customer) {
  const status = normalizedStatus(booking.status);
  const q = quoteEligibility(booking);
  return {
    id: booking.id,
    status: status,
    statusLabel: statusLabel(status),
    serviceType: booking.service_type,
    serviceLabel: serviceLabel(booking.service_type),
    appointmentDate: booking.appointment_date,
    estimatedPrice: booking.estimated_price,
    estimatedPriceMax: booking.estimated_price_max,
    priceable: PRICEABLE_SERVICE_TYPES.indexOf(booking.service_type) !== -1,
    quoteWritable: q.allowed,
    quoteWritableReason: q.reason,
    customerName: customer ? [customer.first_name, customer.last_name].filter(Boolean).join(" ") : "",
  };
}

async function loadBookingAndCustomer(supabase, bookingId) {
  const bRes = await supabase.from("bookings").select(BOOKING_COLS).eq("id", bookingId).maybeSingle();
  if (bRes.error) throw bRes.error;
  if (!bRes.data) return { booking: null, customer: null };
  let customer = null;
  if (bRes.data.customer_id) {
    const cRes = await supabase.from("customers").select("id, first_name, last_name").eq("id", bRes.data.customer_id).maybeSingle();
    if (cRes.error) throw cRes.error;
    customer = cRes.data;
  }
  return { booking: bRes.data, customer: customer };
}

// GET ?resource=price-estimate&bookingId=<uuid>
async function handleGetPriceEstimate(req, res) {
  const bookingId = typeof req.query.bookingId === "string" ? req.query.bookingId.trim() : "";
  if (!UUID_RE.test(bookingId)) {
    res.status(404).json({ error: "Job not found." });
    return;
  }
  const supabase = getServiceClient();
  if (!supabase) {
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }
  try {
    const { booking, customer } = await loadBookingAndCustomer(supabase, bookingId);
    if (!booking) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const eRes = await supabase.from("job_price_estimates").select(ESTIMATE_COLS).eq("booking_id", bookingId).maybeSingle();
    if (eRes.error) {
      if (isMissingTableError(eRes.error)) {
        res.status(200).json({ ok: true, booking: mapBooking(booking, customer), estimate: null, storageReady: false });
        return;
      }
      throw eRes.error;
    }
    res.status(200).json({ ok: true, booking: mapBooking(booking, customer), estimate: mapEstimate(eRes.data), storageReady: true });
  } catch (err) {
    console.error("Price estimate load failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load this job's saved estimate." });
  }
}

function conflict(res, code, message, extra) {
  res.status(409).json(Object.assign({ error: message, code: code }, extra || {}));
}

// POST ?resource=price-estimate
async function handleSavePriceEstimate(req, res, session) {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

  const bookingId = typeof body.bookingId === "string" ? body.bookingId.trim() : "";
  if (!UUID_RE.test(bookingId)) {
    res.status(400).json({ error: "Choose a job to save this estimate to." });
    return;
  }
  const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
  if (!REQUEST_KEY_RE.test(requestKey)) {
    res.status(400).json({ error: "Missing or invalid request key." });
    return;
  }
  let expectedRevision;
  if (body.expectedRevision === null || body.expectedRevision === undefined) expectedRevision = null;
  else if (Number.isInteger(body.expectedRevision) && body.expectedRevision >= 1) expectedRevision = body.expectedRevision;
  else {
    res.status(400).json({ error: "Invalid revision." });
    return;
  }
  if (!Number.isInteger(body.clientTotalCents)) {
    res.status(400).json({ error: "Missing estimate total." });
    return;
  }
  const applyToQuotedAmount = body.applyToQuotedAmount === true;
  const confirmQuotedOverwrite = body.confirmQuotedOverwrite === true;

  const normalized = Core.normalizeInput(body.input, { requireLoadTier: true });
  if (!normalized.ok) {
    res.status(400).json({ error: normalized.errors[0], errors: normalized.errors });
    return;
  }
  const computed = Core.computeEstimate(normalized.value);
  if (computed.totalCents !== body.clientTotalCents) {
    conflict(res, "total_mismatch", "The estimate total didn't match the server's calculation. Reload the calculator and try again.", { serverTotalCents: computed.totalCents });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) {
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  try {
    const { booking, customer } = await loadBookingAndCustomer(supabase, bookingId);
    if (!booking) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    if (PRICEABLE_SERVICE_TYPES.indexOf(booking.service_type) === -1) {
      res.status(400).json({ error: "This calculator prices junk removal. " + serviceLabel(booking.service_type) + " jobs use their own pricing." });
      return;
    }

    const existingRes = await supabase.from("job_price_estimates").select(ESTIMATE_COLS).eq("booking_id", bookingId).maybeSingle();
    if (existingRes.error) {
      if (isMissingTableError(existingRes.error)) {
        res.status(503).json({ error: "Saving estimates to jobs isn't set up yet (database migration pending). Nothing was saved.", code: "storage_not_ready" });
        return;
      }
      throw existingRes.error;
    }
    const existing = existingRes.data;

    // Same request already applied (double tap / retry after a lost
    // response): answer with what's stored, write nothing.
    if (existing && existing.last_request_key === requestKey) {
      res.status(200).json({ ok: true, duplicate: true, estimate: mapEstimate(existing), booking: mapBooking(booking, customer), quotedAmountUpdated: false });
      return;
    }
    if (existing && expectedRevision === null) {
      conflict(res, "estimate_exists", "This job already has a saved estimate. Replace it?", { existing: mapEstimate(existing) });
      return;
    }
    if (!existing && expectedRevision !== null) {
      conflict(res, "estimate_missing", "The saved estimate you were editing no longer exists. Save it as a new estimate instead?");
      return;
    }
    if (existing && existing.revision !== expectedRevision) {
      conflict(res, "revision_conflict", "This job's saved estimate was changed somewhere else. Reload it before saving.", { existing: mapEstimate(existing) });
      return;
    }

    // Quoted Amount gate — checked BEFORE any write, so a refused quote
    // update never leaves a half-saved request behind.
    const totalDecimal = centsToDecimalString(computed.totalCents);
    let writeQuote = false;
    if (applyToQuotedAmount) {
      const q = quoteEligibility(booking);
      if (!q.allowed) {
        res.status(400).json({ error: q.reason + " Save the breakdown without updating the quoted amount.", code: "quote_not_writable" });
        return;
      }
      const currentCents = booking.estimated_price === null || booking.estimated_price === undefined ? null : decimalDollarsToCents(Number(booking.estimated_price).toFixed(2));
      const hasRange = booking.estimated_price_max !== null && booking.estimated_price_max !== undefined;
      const differs = currentCents !== null && (currentCents !== computed.totalCents || hasRange);
      if (differs && !confirmQuotedOverwrite) {
        conflict(res, "quote_overwrite_required", "This job already has a different quoted amount. Replace it?", {
          currentQuote: { estimatedPrice: booking.estimated_price, estimatedPriceMax: booking.estimated_price_max },
          newQuote: totalDecimal,
        });
        return;
      }
      writeQuote = currentCents === null || differs;
    }

    const nowIso = new Date().toISOString();
    const v = normalized.value;
    const storedInput = {
      loadTier: v.loadTier,
      disposal: v.disposal,
      laborQuarterHours: v.laborQuarterHours,
      customCharges: v.customCharges,
      discounts: v.discounts,
      confirmedOnSite: v.confirmedOnSite,
    };
    const row = {
      load_tier: v.loadTier,
      input: storedInput,
      line_items: computed.lines,
      subtotal_cents: computed.subtotalCents,
      discount_cents: computed.discountCents,
      total_cents: computed.totalCents,
      confirmed_on_site: v.confirmedOnSite,
      staff_notes: v.notes || null,
      last_request_key: requestKey,
      updated_at: nowIso,
      updated_by: session && session.email ? session.email : null,
    };

    let saved;
    if (!existing) {
      const ins = await supabase
        .from("job_price_estimates")
        .insert(Object.assign({ booking_id: bookingId, revision: 1, created_at: nowIso, created_by: row.updated_by }, row))
        .select(ESTIMATE_COLS)
        .single();
      if (ins.error) {
        if (ins.error.code === "23505") {
          conflict(res, "estimate_exists", "This job already has a saved estimate. Replace it?");
          return;
        }
        throw ins.error;
      }
      saved = ins.data;
    } else {
      const upd = await supabase
        .from("job_price_estimates")
        .update(Object.assign({ revision: existing.revision + 1 }, row))
        .eq("id", existing.id)
        .eq("revision", existing.revision)
        .select(ESTIMATE_COLS)
        .maybeSingle();
      if (upd.error) throw upd.error;
      if (!upd.data) {
        conflict(res, "revision_conflict", "This job's saved estimate was changed somewhere else. Reload it before saving.");
        return;
      }
      saved = upd.data;
    }

    let quotedAmountUpdated = false;
    let quoteWarning = null;
    let bookingAfter = booking;
    if (writeQuote) {
      // Conditioned on the exact quote/updated_at we just read, so a
      // concurrent Edit Job save is never silently overwritten; bumping
      // updated_at makes any Edit Job form still open elsewhere get its
      // normal 409 "reload" instead of overwriting this quote.
      let q = supabase
        .from("bookings")
        .update({ estimated_price: Number(totalDecimal), estimated_price_max: null, updated_at: nowIso })
        .eq("id", bookingId);
      q = booking.updated_at === null || booking.updated_at === undefined ? q.is("updated_at", null) : q.eq("updated_at", booking.updated_at);
      const bUpd = await q.select(BOOKING_COLS).maybeSingle();
      if (bUpd.error || !bUpd.data) {
        if (bUpd.error) console.error("Price estimate quote update failed:", bUpd.error);
        quoteWarning = "The breakdown was saved, but the job's quoted amount was not updated because the job changed at the same time. Reload the job and try again.";
      } else {
        quotedAmountUpdated = true;
        bookingAfter = bUpd.data;
      }
    }

    res.status(200).json({
      ok: true,
      duplicate: false,
      estimate: mapEstimate(saved),
      booking: mapBooking(bookingAfter, customer),
      quotedAmountUpdated: quotedAmountUpdated,
      warning: quoteWarning,
    });
  } catch (err) {
    console.error("Price estimate save failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not save this estimate. Nothing was charged or sent — try again." });
  }
}

module.exports = {
  handleGetPriceEstimate,
  handleSavePriceEstimate,
  PRICEABLE_SERVICE_TYPES,
  QUOTE_WRITABLE_STATUSES,
};
