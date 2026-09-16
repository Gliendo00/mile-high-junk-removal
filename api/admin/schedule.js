// Vercel serverless function — read-only operational schedule for the admin
// Schedule homepage (Phase 3C Stage 1). See api/_lib/admin-auth.js:
// requireAdmin() is the only thing standing between this data and an
// unauthenticated caller, and it runs before any Supabase query below.
//
// This never writes anything. Every query is a plain SELECT — mirrors
// api/admin/bookings.js and api/admin/booking.js exactly in that respect.
//
// Which bookings are "on the schedule": per the Phase 3C architecture audit,
// this deliberately does NOT introduce a second, operational status field.
// bookings.status already distinguishes the sales/lead lifecycle (new,
// contacted, quoted) from a confirmed job (booked) and its outcome
// (completed, lost) — a job belongs on the operational schedule exactly when
// it has been booked, whether or not it has happened yet. "new"/"contacted"/
// "quoted" bookings have no confirmed appointment yet and never appear here;
// "lost" bookings fell through and never appear here either. This is a
// straightforward .in("status", [...]) filter, which also naturally excludes
// NULL-status rows (Postgres/PostgREST's IN never matches NULL) without a
// separate null-check — NULL-status ("new", by the display convention in
// booking-format.js) bookings correctly never show up on the schedule.
const { requireAdmin } = require("../_lib/admin-auth");
const { getServiceClient } = require("../_lib/supabase-admin");
const { serviceLabel, timeWindowLabel, statusLabel, normalizedStatus } = require("../_lib/booking-format");
const { timeWindowStartHour } = require("../_lib/time-windows");

const SCHEDULABLE_STATUSES = ["booked", "completed"];
const VALID_RANGES = ["today", "tomorrow", "week"];
// "week" is a rolling 7-day window starting today (today + the next 6 days),
// not a Sunday-Monday calendar week — consistent with "Today"/"Tomorrow"
// being relative-to-now views rather than calendar-aligned ones, and with
// this being an operational "what's coming up" view rather than a reporting
// view. A judgment call flagged for review, not dictated by any existing
// code.
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
    console.error("Admin schedule failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

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

    // Phone is included here — unlike api/admin/bookings.js's list, which
    // deliberately omits it — because the Schedule's Call/Text actions are a
    // core requirement of this view (jobs are run from a phone) and must
    // work directly from the card, not only after drilling into the detail
    // page. This is not a new exposure category: the same admin session is
    // already authorized to see this exact phone number on the booking
    // detail page (api/admin/booking.js) and the client profile
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
        // Same historical-snapshot-first, customer-fallback rule as
        // api/admin/booking.js and api/admin/client.js: a legacy booking
        // with no service_address snapshot of its own falls back to the
        // customer's current city so the card still shows something useful.
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
    // dropped — a job must never silently disappear from the schedule
    // because of an unexpected time_window value.
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

    res.status(200).json({
      ok: true,
      range: range,
      startDate: startDate,
      endDate: endDate,
      jobs: jobs,
    });
  } catch (err) {
    console.error("Admin schedule failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load the schedule." });
  }
};

// Current date in America/Denver as a YYYY-MM-DD string — deliberately never
// the server process's own local time (UTC on Vercel), since "today" for a
// Denver-based operation must match Denver's calendar day, not UTC's (which
// can already be "tomorrow" while it's still evening in Denver). This is a
// small, self-contained copy of the same Denver-time logic in api/book.js
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
// it only computes "N calendar days after this date," so no timezone
// ambiguity carries into the result.
function addDaysIso(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return yy + "-" + mm + "-" + dd;
}
