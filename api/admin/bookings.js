// Vercel serverless function — read-only booking list + summary counts for
// the admin dashboard. See api/_lib/admin-auth.js: requireAdmin() is the
// only thing standing between this data and an unauthenticated caller, and
// it runs before any Supabase query below.
//
// This never writes anything. Every query is a SELECT (or a count-only
// head request). No booking, customer, or status row is modified by this
// endpoint, ever.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");
const { serviceLabel, timeWindowLabel, statusLabel, normalizedStatus, STATUS_LABELS } = require("../_lib/booking-format");
const { timeWindowStartHour } = require("../_lib/time-windows");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Phase 3C Stage 1: the admin Schedule (?view=schedule&range=...) also lives
// in this file rather than its own api/admin/schedule.js — see the
// countsOnly comment just below for why (the Vercel Hobby plan's 12
// Serverless Function limit). Which bookings are "on the schedule": exactly
// those whose status is booked or completed — the sales/lead lifecycle
// (new/contacted/quoted) has no confirmed appointment yet, and lost fell
// through, so neither belongs on an operational schedule. No second
// operational-status field is introduced for this.
const SCHEDULABLE_STATUSES = ["booked", "completed"];
const VALID_RANGES = ["today", "tomorrow", "week"];
// "week" is a rolling 7-day window starting today (today + the next 6 days),
// not a Sunday-Saturday calendar week — see docs/phase-3/schedule-architecture.md.
const WEEK_SPAN_DAYS = 7;

module.exports = async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin bookings list failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  let offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  // Optional read-only filter for the dashboard's status pills/menu. Any
  // value outside the known set is silently ignored (treated as "no
  // filter") rather than erroring — this is a display convenience, not a
  // security boundary, so an unrecognized value just falls back to the
  // unfiltered list rather than adding a new failure mode to this endpoint.
  const requestedStatus = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
  const statusFilter = Object.prototype.hasOwnProperty.call(STATUS_LABELS, requestedStatus) ? requestedStatus : "";

  // Phase 3C Stage 1: ?countsOnly=1 returns just the six-way status summary
  // (the same numbers this endpoint already computes on every call), never
  // the booking/customer rows. Added here — rather than as its own
  // api/admin/new-count.js function — specifically because the Vercel
  // Hobby plan caps a deployment at 12 Serverless Functions; this project
  // was already at exactly that limit before Phase 3C Stage 1, confirmed by
  // a real deploy failure ("No more than 12 Serverless Functions can be
  // added to a Deployment on the Hobby plan"). Folding the Requests-badge
  // count into this endpoint — which already runs these exact six
  // count-only queries for its own summary — avoids a new function. See
  // docs/phase-3/vercel-function-limit.md.
  const countsOnly = req.query.countsOnly === "1";
  // Same reasoning, same limit: the admin Schedule (?view=schedule) also
  // lives here rather than in its own api/admin/schedule.js file.
  const scheduleView = req.query.view === "schedule";

  if (scheduleView) {
    return handleSchedule(req, res, supabase);
  }

  const COUNT_QUERIES = [
    supabase.from("bookings").select("id", { count: "exact", head: true }),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "contacted"),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "quoted"),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "booked"),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "completed"),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "lost"),
  ];

  if (countsOnly) {
    try {
      const [totalRes, contactedRes, quotedRes, bookedRes, completedRes, lostRes] = await Promise.all(COUNT_QUERIES);
      for (const r of [totalRes, contactedRes, quotedRes, bookedRes, completedRes, lostRes]) {
        if (r.error) throw r.error;
      }
      const total = totalRes.count || 0;
      const knownNonNew = (contactedRes.count || 0) + (quotedRes.count || 0) + (bookedRes.count || 0) + (completedRes.count || 0) + (lostRes.count || 0);
      const newCount = Math.max(0, total - knownNonNew);
      res.status(200).json({
        ok: true,
        summary: {
          total: total,
          new: newCount,
          contacted: contactedRes.count || 0,
          quoted: quotedRes.count || 0,
          booked: bookedRes.count || 0,
          completed: completedRes.count || 0,
          lost: lostRes.count || 0,
        },
      });
    } catch (err) {
      console.error("Admin bookings counts-only failed:", err && err.stack ? err.stack : err);
      res.status(500).json({ error: "Could not load booking counts." });
    }
    return;
  }

  try {
    // Six well-understood .eq()/count-only queries rather than a single
    // .or("status.is.null,status.eq.") filter — this avoids depending on
    // exactly how PostgREST parses an empty-string comparison inside an
    // `or()` filter, which was never verified against the live project
    // (see docs/phase-1/database-schema.md's NEEDS VERIFICATION notes).
    // "new" is then derived as total minus every known non-new status,
    // which is correct however NULL/empty status is actually represented
    // in the database.
    const [totalRes, contactedRes, quotedRes, bookedRes, completedRes, lostRes, pageRes] = await Promise.all([
      ...COUNT_QUERIES,
      (function () {
        // "new" isn't a stored value (see docs/phase-1/crm-status-plan.md) —
        // every booking created so far has left status NULL, and nothing in
        // this codebase has ever written the literal string "new". Filtering
        // by NULL therefore matches every row the rest of this endpoint
        // already counts as "new". The other five values are stored
        // verbatim by api/admin/booking-status.js, so a plain .eq() is
        // sufficient for them.
        let q = supabase
          .from("bookings")
          .select("id, service_type, appointment_date, time_window, status, estimated_price, customer_id, service_city, created_at")
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);
        if (statusFilter === "new") q = q.is("status", null);
        else if (statusFilter) q = q.eq("status", statusFilter);
        return q;
      })(),
    ]);

    for (const r of [totalRes, contactedRes, quotedRes, bookedRes, completedRes, lostRes, pageRes]) {
      if (r.error) throw r.error;
    }

    const bookings = pageRes.data || [];
    const customerIds = Array.from(new Set(bookings.map((b) => b.customer_id).filter(Boolean)));
    const bookingIds = bookings.map((b) => b.id);

    // "city" is selected here only as a compatibility fallback for a legacy
    // booking with no service_city snapshot of its own (see the mapping
    // below) — the customer's current city is never the primary source once
    // a booking has its own snapshot.
    const customersById = {};
    if (customerIds.length) {
      const custRes = await supabase.from("customers").select("id, first_name, last_name, city").in("id", customerIds);
      if (custRes.error) throw custRes.error;
      (custRes.data || []).forEach((c) => {
        customersById[c.id] = c;
      });
    }

    const photoCountByBooking = {};
    if (bookingIds.length) {
      const photosRes = await supabase.from("booking_photos").select("id, booking_id").in("booking_id", bookingIds);
      if (photosRes.error) throw photosRes.error;
      (photosRes.data || []).forEach((p) => {
        photoCountByBooking[p.booking_id] = (photoCountByBooking[p.booking_id] || 0) + 1;
      });
    }

    const items = bookings.map((b) => {
      const customer = customersById[b.customer_id] || null;
      return {
        id: b.id,
        serviceType: b.service_type,
        serviceLabel: serviceLabel(b.service_type),
        appointmentDate: b.appointment_date,
        timeWindow: b.time_window,
        timeWindowLabel: timeWindowLabel(b.time_window),
        status: normalizedStatus(b.status),
        statusLabel: statusLabel(b.status),
        estimatedPrice: b.estimated_price,
        createdAt: b.created_at,
        photoCount: photoCountByBooking[b.id] || 0,
        // Job location: the booking's own snapshot is primary; a legacy
        // booking created before this snapshot existed (service_city is
        // NULL) falls back to the customer's current city.
        serviceCity: b.service_city || (customer && customer.city) || null,
        customer: customer ? { firstName: customer.first_name, lastName: customer.last_name } : null,
      };
    });

    const total = totalRes.count || 0;
    const knownNonNew = (contactedRes.count || 0) + (quotedRes.count || 0) + (bookedRes.count || 0) + (completedRes.count || 0) + (lostRes.count || 0);
    const newCount = Math.max(0, total - knownNonNew);

    // Pagination ("hasMore") must be judged against the count of whatever
    // set is actually being paged through — the global total when no
    // filter is applied, or the matching status's own count when one is.
    // Every value here was already computed above for the summary, so this
    // needs no extra query.
    const countsByStatus = { new: newCount, contacted: contactedRes.count || 0, quoted: quotedRes.count || 0, booked: bookedRes.count || 0, completed: completedRes.count || 0, lost: lostRes.count || 0 };
    const filteredTotal = statusFilter ? countsByStatus[statusFilter] : total;

    res.status(200).json({
      ok: true,
      summary: {
        total: total,
        new: newCount,
        contacted: contactedRes.count || 0,
        quoted: quotedRes.count || 0,
        booked: bookedRes.count || 0,
        completed: completedRes.count || 0,
        lost: lostRes.count || 0,
      },
      bookings: items,
      limit: limit,
      offset: offset,
      hasMore: offset + items.length < filteredTotal,
    });
  } catch (err) {
    console.error("Admin bookings list failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load bookings." });
  }
};

// ---------------------------------------------------------------------
// Admin Schedule (?view=schedule&range=today|tomorrow|week) — Phase 3C
// Stage 1. Kept as a clearly separated block below the main handler (rather
// than interleaved with the Requests-list logic above) so the two remain
// easy to read independently despite sharing one file/function purely for
// the Vercel Hobby-plan function-count reason explained above requireAdmin's
// call site. Read-only, same requireAdmin()/service-role/no-store posture —
// requireAdmin() and the method check already ran before this is reached.
// ---------------------------------------------------------------------
async function handleSchedule(req, res, supabase) {
  const requestedRange = typeof req.query.range === "string" ? req.query.range.trim().toLowerCase() : "";
  const range = VALID_RANGES.indexOf(requestedRange) !== -1 ? requestedRange : "today";

  const todayIso = denverTodayIso();
  let startDate, endDate;
  if (range === "today") {
    startDate = todayIso;
    endDate = todayIso;
  } else if (range === "tomorrow") {
    startDate = addDaysIso(todayIso, 1);
    endDate = startDate;
  } else {
    startDate = todayIso;
    endDate = addDaysIso(todayIso, WEEK_SPAN_DAYS - 1);
  }

  try {
    const bookingsRes = await supabase
      .from("bookings")
      .select("id, service_type, appointment_date, time_window, status, estimated_price, customer_id, service_address, service_city, service_state, service_zip")
      .in("status", SCHEDULABLE_STATUSES)
      .gte("appointment_date", startDate)
      .lte("appointment_date", endDate);
    if (bookingsRes.error) throw bookingsRes.error;

    const bookings = bookingsRes.data || [];
    const customerIds = Array.from(new Set(bookings.map((b) => b.customer_id).filter(Boolean)));

    // Phone is included here — unlike the default (non-schedule) response
    // above, which deliberately omits it — because the Schedule's
    // Call/Text actions are a core requirement of this view (jobs are run
    // from a phone) and must work directly from the card, not only after
    // drilling into the detail page. Not a new exposure category: the same
    // admin session is already shown this exact phone number on the
    // booking detail page (api/admin/booking.js) and the client profile
    // (api/admin/client.js); requireAdmin() is still the only gate.
    const customersById = {};
    if (customerIds.length) {
      const custRes = await supabase.from("customers").select("id, first_name, last_name, phone, city").in("id", customerIds);
      if (custRes.error) throw custRes.error;
      (custRes.data || []).forEach((c) => {
        customersById[c.id] = c;
      });
    }

    const jobs = bookings.map((b) => {
      const customer = customersById[b.customer_id] || null;
      return {
        id: b.id,
        serviceType: b.service_type,
        serviceLabel: serviceLabel(b.service_type),
        appointmentDate: b.appointment_date,
        timeWindow: b.time_window,
        timeWindowLabel: timeWindowLabel(b.time_window),
        status: normalizedStatus(b.status),
        statusLabel: statusLabel(b.status),
        estimatedPrice: b.estimated_price,
        customer: customer ? { firstName: customer.first_name, lastName: customer.last_name, phone: customer.phone } : null,
        serviceAddress: {
          address: b.service_address || null,
          city: b.service_city || (customer && customer.city) || null,
          state: b.service_state || null,
          zip: b.service_zip || null,
        },
      };
    });

    // Chronological order: appointment date first, then time-of-day within
    // that date via the shared start-hour lookup (api/_lib/time-windows.js)
    // — never a second, duplicated windows-to-hour map. An unrecognized
    // time_window (timeWindowStartHour returns null) sorts after every
    // recognized window on the same date rather than throwing or being
    // dropped.
    jobs.sort(function (a, b) {
      if (a.appointmentDate !== b.appointmentDate) {
        return a.appointmentDate < b.appointmentDate ? -1 : 1;
      }
      const aHour = timeWindowStartHour(a.timeWindow);
      const bHour = timeWindowStartHour(b.timeWindow);
      if (aHour === null && bHour === null) return 0;
      if (aHour === null) return 1;
      if (bHour === null) return -1;
      return aHour - bHour;
    });

    res.status(200).json({ ok: true, range: range, startDate: startDate, endDate: endDate, jobs: jobs });
  } catch (err) {
    console.error("Admin schedule failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load the schedule." });
  }
}

// Current date in America/Denver as a YYYY-MM-DD string — deliberately never
// the server process's own local time (UTC on Vercel), since "today" for a
// Denver-based operation must match Denver's calendar day, not UTC's (which
// can already be "tomorrow" while it's still evening in Denver). A small,
// self-contained copy of the same Denver-time logic in api/book.js
// (getDenverNow/denverTodayIso) rather than an import from it — consistent
// with this project's existing convention (see api/_lib/booking-format.js
// and api/_lib/time-windows.js) of not reaching into the live public booking
// endpoint from admin code.
function denverTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = {};
  fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
  return parts.year + "-" + parts.month + "-" + parts.day;
}

// Adds `days` calendar days to a YYYY-MM-DD string, returning a new
// YYYY-MM-DD string. Uses a UTC-anchored Date purely as a calendar
// calculator (noon UTC avoids any DST-transition edge case shifting the
// result onto the wrong day) — this never represents a real moment in time,
// it only computes "N calendar days after this date."
function addDaysIso(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return yy + "-" + mm + "-" + dd;
}
