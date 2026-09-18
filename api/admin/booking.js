// Vercel serverless function — single-booking detail including short-lived
// signed photo URLs (GET), and, as of Phase 3C Stage 2.1, job creation for
// "+ New Job" (POST). See api/_lib/admin-auth.js: requireAdmin() gates this
// entire route before either the `id` query param or the request body is
// ever looked at.
//
// IDOR note (GET): the booking id in the URL identifies *which* record is
// being asked for — it never authorizes the request by itself. Every code
// path below runs only after requireAdmin() has already confirmed the
// caller is an authenticated, allowlisted admin; changing `?id=` to another
// booking's id changes which (authorized) record comes back, never whether
// the request is authorized at all.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");
const { serviceLabel, timeWindowLabel, effectiveTimeLabel, statusLabel, normalizedStatus, SERVICE_LABELS } = require("../_lib/booking-format");
const { TIME_WINDOW_DEFS } = require("../_lib/time-windows");
const { HISTORICAL_FLOOR_ISO } = require("../_lib/historical-floor");

const BUCKET = "booking-photos";
const PHOTO_URL_TTL_SECONDS = 300; // 5 minutes — short-lived by design, minted fresh on every request, never cached or persisted
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  if (req.method === "POST") return handleCreate(req, res);
  if (req.method === "PATCH") return handleUpdate(req, res);

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
  if (!id) {
    res.status(400).json({ error: "Booking id is required." });
    return;
  }
  if (!UUID_RE.test(id)) {
    // A malformed id can never match a real row. Treated identically to
    // "not found" rather than a distinct 400, so the response never
    // confirms anything about id format/validation to the caller.
    res.status(404).json({ error: "Booking not found." });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin booking detail failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  try {
    const bookingRes = await supabase
      .from("bookings")
      .select(
        "id, service_type, appointment_date, time_window, exact_time, status, description, estimated_price, estimated_price_max, final_price, tip_amount, internal_notes, created_at, updated_at, customer_id, service_address, service_city, service_state, service_zip"
      )
      .eq("id", id)
      .maybeSingle();
    if (bookingRes.error) throw bookingRes.error;

    const booking = bookingRes.data;
    if (!booking) {
      res.status(404).json({ error: "Booking not found." });
      return;
    }

    const [customerRes, dumpsterRes, photosRes] = await Promise.all([
      supabase
        .from("customers")
        .select("first_name, last_name, phone, email, address, city, state, zip")
        .eq("id", booking.customer_id)
        .maybeSingle(),
      supabase.from("dumpster_rentals").select("delivery_date, pickup_date, material_type, placement_notes").eq("booking_id", id).maybeSingle(),
      supabase.from("booking_photos").select("id, storage_path, created_at").eq("booking_id", id).order("created_at", { ascending: true }),
    ]);
    if (customerRes.error) throw customerRes.error;
    if (dumpsterRes.error) throw dumpsterRes.error;
    if (photosRes.error) throw photosRes.error;

    const customer = customerRes.data || null;
    const dumpster = dumpsterRes.data || null;
    const photoRows = photosRes.data || [];

    // Signed URLs are minted here, after authorization has already
    // succeeded above, scoped to one storage object each, and short-lived —
    // never a permanent public URL, never reused across requests. A single
    // failed signing call degrades to a missing url for that one photo
    // rather than failing the whole page.
    const photos = await Promise.all(
      photoRows.map(async (p) => {
        try {
          const signed = await supabase.storage.from(BUCKET).createSignedUrl(p.storage_path, PHOTO_URL_TTL_SECONDS);
          if (signed.error || !signed.data) {
            console.error("Admin booking detail: failed to sign photo URL for " + p.storage_path, signed.error);
            return { id: p.id, url: null, createdAt: p.created_at };
          }
          return { id: p.id, url: signed.data.signedUrl, createdAt: p.created_at };
        } catch (err) {
          console.error("Admin booking detail: failed to sign photo URL for " + p.storage_path, err);
          return { id: p.id, url: null, createdAt: p.created_at };
        }
      })
    );

    res.status(200).json({
      ok: true,
      booking: {
        id: booking.id,
        // Exposed only so the admin UI can link to this booking's client
        // profile (/admin/client/?id=) — never used by this route itself
        // to authorize anything; requireAdmin() above already did that.
        customerId: booking.customer_id,
        serviceType: booking.service_type,
        serviceLabel: serviceLabel(booking.service_type),
        appointmentDate: booking.appointment_date,
        timeWindow: booking.time_window,
        timeWindowLabel: timeWindowLabel(booking.time_window),
        exactTime: booking.exact_time,
        // The one label Edit Job/Booking Detail should actually render —
        // exact_time when set, else the time_window label, else "—". See
        // api/_lib/booking-format.js's effectiveTimeLabel().
        timeLabel: effectiveTimeLabel(booking.time_window, booking.exact_time),
        description: booking.description,
        estimatedPrice: booking.estimated_price,
        estimatedPriceMax: booking.estimated_price_max,
        finalPrice: booking.final_price,
        tipAmount: booking.tip_amount,
        internalNotes: booking.internal_notes,
        status: normalizedStatus(booking.status),
        statusLabel: statusLabel(booking.status),
        createdAt: booking.created_at,
        // Exposed only as an opaque optimistic-concurrency token for
        // PATCH /api/admin/booking (Edit Job) — see handleUpdate() below.
        // Never interpreted or displayed as a meaningful date/time by this
        // route itself.
        updatedAt: booking.updated_at,
      },
      // Client identity/contact only — never the address. Job location is
      // reported separately below as `serviceAddress`, sourced from the
      // booking's own historical snapshot, not this (mutable) customer row.
      customer: customer
        ? {
            firstName: customer.first_name,
            lastName: customer.last_name,
            phone: customer.phone,
            email: customer.email,
          }
        : null,
      // The booking's own snapshot is primary; a legacy booking created
      // before this snapshot existed (service_address is NULL) falls back to
      // the customer's current address so the page still shows something
      // useful rather than a blank field.
      serviceAddress: {
        address: booking.service_address || (customer && customer.address) || null,
        city: booking.service_city || (customer && customer.city) || null,
        state: booking.service_state || (customer && customer.state) || null,
        zip: booking.service_zip || (customer && customer.zip) || null,
      },
      dumpster: dumpster
        ? {
            deliveryDate: dumpster.delivery_date,
            pickupDate: dumpster.pickup_date,
            materialType: dumpster.material_type,
            placementNotes: dumpster.placement_notes,
          }
        : null,
      photos: photos,
    });
  } catch (err) {
    console.error("Admin booking detail failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load booking." });
  }
};

// ---------------------------------------------------------------------
// Create a job — POST /api/admin/booking. Creates one bookings row for an
// already-identified client (see api/admin/client.js for finding/creating
// that client — this endpoint never does that itself). Covers two explicit,
// allowlisted modes:
//   - "new" (default, Phase 3C Stage 2.1) — "+ New Job": status="booked",
//     appointment date must be today or later (America/Denver), an
//     appointment time is required (either a time_window or an exact_time —
//     see "Appointment time" below), price is an optional pre-job quote
//     written to estimated_price (+ an optional estimated_price_max for a
//     range — see "Quoted amount" below).
//   - "past" (Phase 3C Stage 2.2) — "+ Past Job": status="completed",
//     appointment date must be on/after the historical migration floor
//     (api/_lib/historical-floor.js) and no later than today, appointment
//     time optional (a real NULL when unknown, never an invented
//     placeholder), price is the actual job amount written to final_price,
//     and an optional tip is written to its own tip_amount column — never
//     merged into final_price. tipAmount is only ever read in this mode;
//     New Job has no tip field in its request shape at all.
//
// Appointment time (Phase 3C Stage 2.5) — a job carries at most one of
// time_window/exact_time, enforced at the database level by the
// bookings_time_mode_exclusive CHECK constraint. body.exactTime ("HH:MM",
// what a bare `<input type="time">` submits) and body.timeWindow are
// mutually exclusive at the request level too: sending both non-empty is
// rejected outright, before either is validated against its own allowlist.
// Whichever mode isn't chosen is written as a literal NULL, never left
// unset/undefined, so a later read can never see a stale value from a
// previous edit.
//
// Quoted amount (Phase 3C Stage 2.5) — estimated_price_max is optional and,
// when present, requires estimated_price to also be present and strictly
// greater than it (also enforced at the database level by the
// bookings_quote_max_requires_min/bookings_quote_max_greater_than_min CHECK
// constraints) — an exact quote is estimated_price alone with
// estimated_price_max left NULL, never a duplicated value. New-mode only,
// same scope as estimated_price itself.
// `mode` is read once, validated against an explicit allowlist, and never
// inferred from any other field — so the two very different rule sets below
// can never be crossed by a crafted request. `status` itself is never read
// from the request body at all in either mode: there is no field named
// "status" anywhere in the validation below, so there is no value a caller
// could send that would change it. Every other field is read individually
// as a named primitive and validated/sanitized before being placed into the
// insert payload — the request body is never spread into it, mirroring the
// discipline api/admin/booking-status.js already established for the one
// write path that existed before Stage 2.1.
async function handleCreate(req, res) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin job create failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

  let mode = "new";
  if (body.mode !== undefined) {
    const modeRaw = typeof body.mode === "string" ? body.mode.trim() : "";
    if (modeRaw !== "new" && modeRaw !== "past") {
      res.status(400).json({ error: "Invalid job mode." });
      return;
    }
    mode = modeRaw;
  }
  const isPast = mode === "past";

  const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
  if (!customerId) {
    res.status(400).json({ error: "A client is required." });
    return;
  }
  if (!UUID_RE.test(customerId)) {
    // Mirrors the rest of this file: a malformed id can never match a real
    // row, so it's treated identically to "not found."
    res.status(404).json({ error: "Client not found." });
    return;
  }

  const serviceType = typeof body.serviceType === "string" ? body.serviceType.trim() : "";
  if (!SERVICE_TYPES.includes(serviceType)) {
    res.status(400).json({ error: "Please choose a valid service type." });
    return;
  }

  const appointmentDate = typeof body.appointmentDate === "string" ? body.appointmentDate.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate) || Number.isNaN(new Date(appointmentDate + "T00:00:00").getTime())) {
    res.status(400).json({ error: "A valid appointment date is required." });
    return;
  }
  const todayIso = denverTodayIso();
  if (isPast) {
    // Past Job is bounded to the exact window the owner is manually
    // migrating: the historical floor (see api/_lib/historical-floor.js)
    // through today (America/Denver) — never earlier than the migration's
    // start, never a job that hasn't happened yet.
    if (appointmentDate < HISTORICAL_FLOOR_ISO) {
      res.status(400).json({ error: "Past Job dates cannot be before January 1, 2026." });
      return;
    }
    if (appointmentDate > todayIso) {
      res.status(400).json({ error: "Past Job dates cannot be in the future. Use New Job for upcoming jobs." });
      return;
    }
  } else {
    // New Job is for a job being booked now or in the future — a date
    // before today (America/Denver) has no meaning for a status="booked"
    // row. "+ Past Job" is the intended path for a historical date.
    if (appointmentDate < todayIso) {
      res.status(400).json({ error: "Appointment date cannot be in the past. Use Past Job for historical jobs." });
      return;
    }
  }

  const timeWindowRaw = typeof body.timeWindow === "string" ? body.timeWindow.trim() : "";
  const exactTimeRaw = typeof body.exactTime === "string" ? body.exactTime.trim() : "";
  if (timeWindowRaw && exactTimeRaw) {
    res.status(400).json({ error: "Choose either an exact time or a time window, not both." });
    return;
  }
  let timeWindow = null;
  let exactTime = null;
  if (exactTimeRaw) {
    if (!EXACT_TIME_RE.test(exactTimeRaw)) {
      res.status(400).json({ error: "Please enter a valid time." });
      return;
    }
    exactTime = exactTimeRaw;
  } else if (timeWindowRaw) {
    if (!VALID_TIME_WINDOWS.includes(timeWindowRaw)) {
      res.status(400).json({ error: "Please choose a valid time window, or leave it unknown." });
      return;
    }
    timeWindow = timeWindowRaw;
  }
  if (isPast) {
    // Past Job's time is optional — a real NULL, never an invented
    // placeholder, when the owner doesn't remember it (confirmed nullable
    // at the database level; see docs/phase-3/stage2-preflight.md). Neither
    // field being present is fine; only checked above when one was actually
    // submitted.
  } else if (!timeWindow && !exactTime) {
    res.status(400).json({ error: "A valid appointment time is required." });
    return;
  }

  const addrIn = body.serviceAddress && typeof body.serviceAddress === "object" && !Array.isArray(body.serviceAddress) ? body.serviceAddress : {};
  const serviceAddress = sanitizeText(addrIn.address, MAX.address);
  const serviceCity = sanitizeText(addrIn.city, MAX.city);
  // Validated BEFORE truncating to MAX.state (2 chars) — truncating first
  // would silently turn "Colorado" into "CO" and accept it as if it were
  // already a valid 2-letter code, rather than rejecting the real input.
  const serviceStateRaw = sanitizeText(addrIn.state, 40).toUpperCase();
  const serviceZip = sanitizeText(addrIn.zip, MAX.zip);
  if (!serviceAddress || !serviceCity) {
    res.status(400).json({ error: "A complete service address is required." });
    return;
  }
  if (!/^[A-Z]{2}$/.test(serviceStateRaw)) {
    res.status(400).json({ error: "Please enter a valid 2-letter state." });
    return;
  }
  const serviceState = serviceStateRaw;
  if (!/^\d{5}(-\d{4})?$/.test(serviceZip)) {
    res.status(400).json({ error: "Please enter a valid ZIP code." });
    return;
  }

  const description = sanitizeText(body.description, MAX.long) || null;
  const internalNotes = sanitizeText(body.internalNotes, MAX.long) || null;

  let estimatedPrice = null;
  let estimatedPriceMax = null;
  let finalPrice = null;
  let tipAmount = null;
  if (isPast) {
    // Historical actual amount — written to final_price, never
    // estimated_price (that column represents a pre-job quote, which a
    // backfilled historical job never had in this flow). Optional: some old
    // records have no recoverable pricing.
    if (body.finalPrice !== undefined && body.finalPrice !== null && body.finalPrice !== "") {
      const n = Number(body.finalPrice);
      if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
        res.status(400).json({ error: "Please enter a valid actual job amount." });
        return;
      }
      // Matches the confirmed live column type, numeric(10,2) — see
      // docs/phase-3/stage2-preflight.md.
      finalPrice = Math.round(n * 100) / 100;
    }
    // Tip is its own value, always separate from final_price — never
    // combined into the job amount. Only ever read/validated in Past Job
    // mode: New Job has no tip field in its request shape at all, so a
    // tipAmount sent alongside mode:"new" (or an omitted mode) is simply
    // never looked at here, the same way finalPrice is invisible to New Job
    // above. Zero is a valid tip ("!== undefined/null/\"\"" lets 0 through)
    // and is stored as a real 0, not treated as absent.
    if (body.tipAmount !== undefined && body.tipAmount !== null && body.tipAmount !== "") {
      const n = Number(body.tipAmount);
      if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
        res.status(400).json({ error: "Please enter a valid tip amount." });
        return;
      }
      tipAmount = Math.round(n * 100) / 100;
    }
  } else {
    if (body.estimatedPrice !== undefined && body.estimatedPrice !== null && body.estimatedPrice !== "") {
      const n = Number(body.estimatedPrice);
      if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
        res.status(400).json({ error: "Please enter a valid estimated price." });
        return;
      }
      estimatedPrice = Math.round(n * 100) / 100;
    }
    // Quote range max (Phase 3C Stage 2.5) — optional, and only meaningful
    // alongside a minimum. Mirrors the database's own
    // bookings_quote_max_requires_min / bookings_quote_max_greater_than_min
    // CHECK constraints at the application layer, so a bad request is
    // rejected with a clear message rather than surfacing as an opaque
    // constraint-violation 500 from Supabase.
    if (body.estimatedPriceMax !== undefined && body.estimatedPriceMax !== null && body.estimatedPriceMax !== "") {
      if (estimatedPrice === null) {
        res.status(400).json({ error: "A quote range needs a minimum amount." });
        return;
      }
      const n = Number(body.estimatedPriceMax);
      if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
        res.status(400).json({ error: "Please enter a valid maximum quote amount." });
        return;
      }
      const rounded = Math.round(n * 100) / 100;
      if (rounded <= estimatedPrice) {
        res.status(400).json({ error: "The maximum quote amount must be greater than the minimum." });
        return;
      }
      estimatedPriceMax = rounded;
    }
  }

  const status = isPast ? "completed" : "booked";

  try {
    const customerRes = await supabase.from("customers").select("id").eq("id", customerId).maybeSingle();
    if (customerRes.error) throw customerRes.error;
    if (!customerRes.data) {
      res.status(404).json({ error: "Client not found." });
      return;
    }

    const { data: created, error } = await supabase
      .from("bookings")
      .insert({
        customer_id: customerId,
        service_type: serviceType,
        appointment_date: appointmentDate,
        time_window: timeWindow,
        exact_time: exactTime,
        status: status,
        description: description,
        estimated_price: estimatedPrice,
        estimated_price_max: estimatedPriceMax,
        final_price: finalPrice,
        tip_amount: tipAmount,
        internal_notes: internalNotes,
        // Frozen job-location snapshot — written once, here, and never
        // re-derived from the customer's profile address later, matching
        // every existing booking everywhere else in this codebase.
        service_address: serviceAddress,
        service_city: serviceCity,
        service_state: serviceState,
        service_zip: serviceZip,
      })
      .select(
        "id, service_type, appointment_date, time_window, exact_time, status, description, estimated_price, estimated_price_max, final_price, tip_amount, internal_notes, customer_id, service_address, service_city, service_state, service_zip, created_at"
      )
      .single();

    if (error || !created) throw error || new Error("Insert returned no row.");

    res.status(200).json({
      ok: true,
      booking: {
        id: created.id,
        customerId: created.customer_id,
        serviceType: created.service_type,
        serviceLabel: serviceLabel(created.service_type),
        appointmentDate: created.appointment_date,
        timeWindow: created.time_window,
        timeWindowLabel: timeWindowLabel(created.time_window),
        exactTime: created.exact_time,
        timeLabel: effectiveTimeLabel(created.time_window, created.exact_time),
        description: created.description,
        estimatedPrice: created.estimated_price,
        estimatedPriceMax: created.estimated_price_max,
        finalPrice: created.final_price,
        tipAmount: created.tip_amount,
        internalNotes: created.internal_notes,
        status: normalizedStatus(created.status),
        statusLabel: statusLabel(created.status),
        createdAt: created.created_at,
      },
      serviceAddress: {
        address: created.service_address,
        city: created.service_city,
        state: created.service_state,
        zip: created.service_zip,
      },
    });
  } catch (err) {
    console.error("Admin job create failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not create job." });
  }
}

// ---------------------------------------------------------------------
// Edit an existing job — PATCH /api/admin/booking (Phase 3C, "Edit Job").
// requireAdmin() has already run (see module.exports above) before this
// function is ever reached — authentication happens before any booking
// lookup or body processing.
//
// Explicit editable-field allowlist. The request body is never spread into
// the Supabase update payload anywhere below: every field is read
// individually as a named primitive, validated, and only then placed into a
// literal update object built from scratch. This means:
//   - customer_id can never be changed (there is no code path that reads a
//     customerId from the body here at all — the attached client is fixed
//     for this stage).
//   - id can never be changed (the id in the body is only ever used in
//     .eq("id", id) to select which row to update, never written to any
//     column).
//   - created_at can never be changed (there is no code path that reads or
//     writes it).
//   - status can never be changed (mirrors booking.js's create-time
//     guarantee: there is no field named "status" read anywhere below, so
//     no value a caller sends can change it — status stays the exclusive
//     responsibility of api/admin/booking-status.js, untouched by this
//     stage).
//   - an arbitrary/unrecognized field in the body simply has no code path
//     that ever reads it, so it can never become writable no matter what
//     the request body contains.
//
// Pricing mode (which of estimated_price vs final_price+tip_amount is
// editable) is decided by the CURRENT row's status, read fresh from the
// database in this same request — never by anything the client claims.
// This is what makes it structurally impossible for editing one pricing
// mode to write into the other column: the code path for a given mode
// simply never reads or writes the other mode's field(s).
//
// Date-editing contract (see docs/phase-3/job-editing-proposal.md for the
// full writeup): reusing New Job's/Past Job's create-time date rules
// verbatim would make some legitimate existing rows impossible to save
// (e.g. a legacy row already dated before the historical floor, or a
// "booked" row whose date has quietly slipped into the past because no one
// has marked it completed yet) merely because of fields the owner isn't
// even touching. So the rule here is keyed off whether the date is actually
// changing:
//   - Submitting the SAME appointment_date the row already has is always
//     accepted, whatever that value is — editing an unrelated field (say,
//     the description) can never be blocked by the row's pre-existing date.
//   - A CHANGED date must be on/after the historical floor (never move a
//     job earlier than the CRM's historical period).
//   - A CHANGED date on a "completed" job must also be on/after the floor
//     and on/before today (America/Denver) — corrected within the
//     historical period, never into the future.
//   - A CHANGED date on any other (non-completed) job must be on/after
//     today (America/Denver) — an upcoming/booked job can move to another
//     valid current/future date, matching New Job's own rule.
// Changing the date never changes status.
//
// Appointment-time contract mirrors booking.js's create-time rules exactly,
// keyed off the same current-status read: optional (neither time_window nor
// exact_time required — a real NULL/NULL, never an invented placeholder)
// for a completed job, one of the two required otherwise. Sending both a
// non-empty timeWindow and a non-empty exactTime is always rejected,
// regardless of status. Whichever mode isn't chosen is written as an
// explicit NULL on every save — so switching an existing job from Time
// Window to Exact Time (or back) always clears the field the new mode isn't
// using, never leaves a stale value from before the edit. No exception was
// needed for legacy time_window values beyond what already existed — every
// existing booking's time_window is either NULL or already one of the
// allowlisted ids, so there is no equivalent "legacy value now out of
// range" case the way dates have; exact_time has no legacy values at all
// (the column is new as of Phase 3C Stage 2.5).
//
// Quote range (Phase 3C Stage 2.5): editable only in the same non-completed
// branch estimated_price itself already is — estimated_price_max follows
// estimated_price's existing scope exactly, never touched by a completed-
// mode edit. Same min-required/strictly-greater-than validation as
// handleCreate above.
//
// Concurrency: optimistic, via bookings.updated_at. The client must send
// back the exact `updatedAt` value it read when Edit Job loaded. The update
// itself is conditioned on that value still matching what's in the database
// (.eq("updated_at", ...) / .is("updated_at", null)) so the check and the
// write are atomic — no separate read-then-write race window. Zero matched
// rows after that point (for a booking already confirmed to exist earlier
// in this same request) means someone else changed it in the meantime; the
// caller gets back a 409 and is told to reload rather than the request
// silently overwriting those newer changes. This endpoint always sets a
// fresh updated_at itself (never relies on an assumed database trigger), so
// the next Edit Job load has a reliable token to check against.
async function handleUpdate(req, res) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin job update failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    res.status(400).json({ error: "Booking id is required." });
    return;
  }
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Booking not found." });
    return;
  }

  // The concurrency token. Required on every request (never silently
  // skippable) — undefined (the field simply absent, or of the wrong type)
  // is rejected outright rather than treated as "skip the check."
  let submittedUpdatedAt;
  if (body.updatedAt === null) {
    submittedUpdatedAt = null;
  } else if (typeof body.updatedAt === "string" && body.updatedAt) {
    submittedUpdatedAt = body.updatedAt;
  } else {
    res.status(400).json({ error: "Missing or invalid concurrency token." });
    return;
  }

  const serviceType = typeof body.serviceType === "string" ? body.serviceType.trim() : "";
  if (!SERVICE_TYPES.includes(serviceType)) {
    res.status(400).json({ error: "Please choose a valid service type." });
    return;
  }

  const appointmentDate = typeof body.appointmentDate === "string" ? body.appointmentDate.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate) || Number.isNaN(new Date(appointmentDate + "T00:00:00").getTime())) {
    res.status(400).json({ error: "A valid appointment date is required." });
    return;
  }

  const addrIn = body.serviceAddress && typeof body.serviceAddress === "object" && !Array.isArray(body.serviceAddress) ? body.serviceAddress : {};
  const serviceAddress = sanitizeText(addrIn.address, MAX.address);
  const serviceCity = sanitizeText(addrIn.city, MAX.city);
  const serviceStateRaw = sanitizeText(addrIn.state, 40).toUpperCase();
  const serviceZip = sanitizeText(addrIn.zip, MAX.zip);
  if (!serviceAddress || !serviceCity) {
    res.status(400).json({ error: "A complete service address is required." });
    return;
  }
  if (!/^[A-Z]{2}$/.test(serviceStateRaw)) {
    res.status(400).json({ error: "Please enter a valid 2-letter state." });
    return;
  }
  const serviceState = serviceStateRaw;
  if (!/^\d{5}(-\d{4})?$/.test(serviceZip)) {
    res.status(400).json({ error: "Please enter a valid ZIP code." });
    return;
  }

  const description = sanitizeText(body.description, MAX.long) || null;
  const internalNotes = sanitizeText(body.internalNotes, MAX.long) || null;

  const timeWindowRaw = typeof body.timeWindow === "string" ? body.timeWindow.trim() : "";
  const exactTimeRaw = typeof body.exactTime === "string" ? body.exactTime.trim() : "";
  if (timeWindowRaw && exactTimeRaw) {
    res.status(400).json({ error: "Choose either an exact time or a time window, not both." });
    return;
  }

  try {
    const currentRes = await supabase
      .from("bookings")
      .select("id, status, appointment_date")
      .eq("id", id)
      .maybeSingle();
    if (currentRes.error) throw currentRes.error;
    const current = currentRes.data;
    if (!current) {
      res.status(404).json({ error: "Booking not found." });
      return;
    }

    const isCompleted = current.status === "completed";
    const todayIso = denverTodayIso();

    // Date rules — see this function's header comment for the full
    // reasoning. Only enforced when the date is actually being changed.
    if (appointmentDate !== current.appointment_date) {
      if (appointmentDate < HISTORICAL_FLOOR_ISO) {
        res.status(400).json({ error: "Appointment date cannot be before January 1, 2026." });
        return;
      }
      if (isCompleted) {
        if (appointmentDate > todayIso) {
          res.status(400).json({ error: "A completed job's date cannot be moved into the future." });
          return;
        }
      } else if (appointmentDate < todayIso) {
        res.status(400).json({ error: "Appointment date cannot be in the past. Use Past Job for historical jobs, or leave this job's date unchanged." });
        return;
      }
    }

    // Appointment-time rules — mirrors create-time rules exactly (see
    // header). Whichever mode isn't chosen is set to null explicitly below,
    // never left as whatever the row previously had.
    let timeWindow = null;
    let exactTime = null;
    if (exactTimeRaw) {
      if (!EXACT_TIME_RE.test(exactTimeRaw)) {
        res.status(400).json({ error: "Please enter a valid time." });
        return;
      }
      exactTime = exactTimeRaw;
    } else if (timeWindowRaw) {
      if (!VALID_TIME_WINDOWS.includes(timeWindowRaw)) {
        res.status(400).json({ error: "Please choose a valid time window, or leave it unknown." });
        return;
      }
      timeWindow = timeWindowRaw;
    }
    if (!isCompleted && !timeWindow && !exactTime) {
      res.status(400).json({ error: "A valid appointment time is required." });
      return;
    }

    // Pricing — decided by the CURRENT (just-read, server-side) status, not
    // anything the client sent. Only one mode's field(s) are ever placed
    // into the update payload below; the other mode's column is never even
    // named in this request, so it can never be touched by it.
    const pricingUpdate = {};
    if (isCompleted) {
      if (body.finalPrice !== undefined && body.finalPrice !== null && body.finalPrice !== "") {
        const n = Number(body.finalPrice);
        if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
          res.status(400).json({ error: "Please enter a valid actual job amount." });
          return;
        }
        pricingUpdate.final_price = Math.round(n * 100) / 100;
      } else {
        pricingUpdate.final_price = null;
      }
      if (body.tipAmount !== undefined && body.tipAmount !== null && body.tipAmount !== "") {
        const n = Number(body.tipAmount);
        if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
          res.status(400).json({ error: "Please enter a valid tip amount." });
          return;
        }
        pricingUpdate.tip_amount = Math.round(n * 100) / 100;
      } else {
        pricingUpdate.tip_amount = null;
      }
    } else {
      let estimatedPriceForMaxCheck = null;
      if (body.estimatedPrice !== undefined && body.estimatedPrice !== null && body.estimatedPrice !== "") {
        const n = Number(body.estimatedPrice);
        if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
          res.status(400).json({ error: "Please enter a valid estimated price." });
          return;
        }
        estimatedPriceForMaxCheck = Math.round(n * 100) / 100;
        pricingUpdate.estimated_price = estimatedPriceForMaxCheck;
      } else {
        pricingUpdate.estimated_price = null;
      }
      // Quote range max — same rules as handleCreate (see this function's
      // header comment): optional, requires a minimum, must be strictly
      // greater than it.
      if (body.estimatedPriceMax !== undefined && body.estimatedPriceMax !== null && body.estimatedPriceMax !== "") {
        if (estimatedPriceForMaxCheck === null) {
          res.status(400).json({ error: "A quote range needs a minimum amount." });
          return;
        }
        const n = Number(body.estimatedPriceMax);
        if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
          res.status(400).json({ error: "Please enter a valid maximum quote amount." });
          return;
        }
        const rounded = Math.round(n * 100) / 100;
        if (rounded <= estimatedPriceForMaxCheck) {
          res.status(400).json({ error: "The maximum quote amount must be greater than the minimum." });
          return;
        }
        pricingUpdate.estimated_price_max = rounded;
      } else {
        pricingUpdate.estimated_price_max = null;
      }
    }

    const updatePayload = Object.assign(
      {
        service_type: serviceType,
        appointment_date: appointmentDate,
        time_window: timeWindow,
        exact_time: exactTime,
        description: description,
        internal_notes: internalNotes,
        service_address: serviceAddress,
        service_city: serviceCity,
        service_state: serviceState,
        service_zip: serviceZip,
        // Self-maintained rather than assumed to come from a database
        // trigger — see this function's header comment. This is also what
        // gives the *next* edit a reliable concurrency token to check.
        updated_at: new Date().toISOString(),
      },
      pricingUpdate
    );

    let updateQuery = supabase.from("bookings").update(updatePayload).eq("id", id);
    updateQuery = submittedUpdatedAt === null ? updateQuery.is("updated_at", null) : updateQuery.eq("updated_at", submittedUpdatedAt);

    const { data: updated, error } = await updateQuery
      .select(
        "id, service_type, appointment_date, time_window, exact_time, status, description, estimated_price, estimated_price_max, final_price, tip_amount, internal_notes, customer_id, service_address, service_city, service_state, service_zip, created_at, updated_at"
      )
      .maybeSingle();
    if (error) throw error;

    if (!updated) {
      // The booking was confirmed to exist just above in this same request,
      // so reaching here means the .eq("updated_at", ...) / .is(...) guard
      // didn't match — someone else changed this booking since Edit Job
      // loaded. Nothing was written.
      res.status(409).json({
        error: "This job was changed since you opened it. Please reload and try again.",
        code: "stale_update",
      });
      return;
    }

    res.status(200).json({
      ok: true,
      booking: {
        id: updated.id,
        customerId: updated.customer_id,
        serviceType: updated.service_type,
        serviceLabel: serviceLabel(updated.service_type),
        appointmentDate: updated.appointment_date,
        timeWindow: updated.time_window,
        timeWindowLabel: timeWindowLabel(updated.time_window),
        exactTime: updated.exact_time,
        timeLabel: effectiveTimeLabel(updated.time_window, updated.exact_time),
        description: updated.description,
        estimatedPrice: updated.estimated_price,
        estimatedPriceMax: updated.estimated_price_max,
        finalPrice: updated.final_price,
        tipAmount: updated.tip_amount,
        internalNotes: updated.internal_notes,
        status: normalizedStatus(updated.status),
        statusLabel: statusLabel(updated.status),
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      },
      serviceAddress: {
        address: updated.service_address,
        city: updated.service_city,
        state: updated.service_state,
        zip: updated.service_zip,
      },
    });
  } catch (err) {
    console.error("Admin job update failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not save changes." });
  }
}

// Derived from booking-format.js's SERVICE_LABELS keys rather than a third
// hardcoded copy of the three service-type strings (api/book.js has the
// live one; booking-format.js already has the admin-shared one this file
// already imports from).
const SERVICE_TYPES = Object.keys(SERVICE_LABELS);
// Derived from the shared api/_lib/time-windows.js module — same source
// used to sort the Schedule chronologically — rather than a separate copy.
const VALID_TIME_WINDOWS = Object.keys(TIME_WINDOW_DEFS);

const MAX = { address: 200, city: 80, zip: 10, long: 2000 };
const MAX_PRICE = 999999;
// What a bare `<input type="time">.value` submits (24-hour "HH:MM", no
// seconds) — the only shape this endpoint ever accepts from a client for
// exact_time; Postgres accepts it directly, no ":00" suffix needed.
const EXACT_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Same sanitize helper as api/book.js's own: strip control characters and
// any "<...>"-shaped text, trim, bound length.
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

// Current date in America/Denver as YYYY-MM-DD — same small, deliberate
// local copy as api/admin/bookings.js's own denverTodayIso() (see that
// file's comment for why this isn't a shared import).
function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date()).forEach(function (p) {
    parts[p.type] = p.value;
  });
  return parts.year + "-" + parts.month + "-" + parts.day;
}
