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
const { HISTORICAL_FLOOR_ISO, HISTORICAL_FLOOR_YEAR, HISTORICAL_FLOOR_MONTH } = require("../_lib/historical-floor");
const { EXPENSE_CATEGORIES } = require("../_lib/expense-categories");

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
// Phase 3C Stage 2.4: "week" became a navigable calendar week (see
// handleSchedule below) rather than the Stage 1 rolling 7-day window: the
// week starts on Sunday and moves with an explicit ?weekStart= param, but
// still spans exactly WEEK_SPAN_DAYS days either way — see
// docs/phase-3/stage2.4-calendar-address-proposal.md "Week start day" for
// why Sunday was chosen. "month" and "year" are new bounded calendar
// navigation modes added the same stage.
// Phase 3C Stage 2.4.2: "yesterday" joins today/tomorrow as a third named
// single-day range (Schedule UX polish — the owner wanted one-tap access to
// yesterday's jobs, not just today's/tomorrow's). "day" is not a tab at
// all — it backs the restrained previous-day/next-day arrows on the
// Today/Tomorrow/Yesterday view (see handleDay()), taking an explicit
// ?date= instead of computing one from "today".
const VALID_RANGES = ["today", "tomorrow", "yesterday", "day", "week", "month", "year"];
const WEEK_SPAN_DAYS = 7;

// The earliest Sunday-aligned week that calendar navigation will ever show
// — the Sunday on/before the historical floor (see handleSchedule's "Week
// start day" comment for the full reasoning). Computed once from
// HISTORICAL_FLOOR_ISO, never re-typed as a separate literal.
const FLOOR_WEEK_START_ISO = startOfWeekSundayIso(HISTORICAL_FLOOR_ISO);

// Phase 3C Stage 2.4 addendum: Daily Quick Expense Tracking. Bounded date
// range allowed per GET ?view=expenses request — generous enough for a
// Month view's worth of expenses in one call (never "one request per day"),
// nowhere near an unbounded "every expense ever" query.
const EXPENSES_MAX_RANGE_DAYS = 366;
const EXPENSE_MAX_AMOUNT = 999999;
const EXPENSE_NOTE_MAX = 500;

module.exports = async (req, res) => {
  const session = await requireAdmin(req, res);
  if (!session) return;

  // Phase 3C Stage 2.4 addendum: POST creates one expense row (Daily Quick
  // Expense Tracking). Dispatched before the GET-only check below — mirrors
  // api/admin/booking.js's own method-branching pattern (requireAdmin()
  // first, then branch on req.method, each branch reading only the fields
  // it explicitly names from the body). See handleCreateExpense() for the
  // full validation/write contract.
  if (req.method === "POST") return handleCreateExpense(req, res);

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Phase 3C Stage 2.4.1: ?view=google-config returns the restricted
  // Google Maps browser key for the admin address-autocomplete forms to
  // fetch on demand. Dispatched here, before any Supabase client is even
  // created — this mode never touches Supabase at all. Admin-auth-gated
  // like every other mode in this file (requireAdmin() already ran above,
  // unconditionally, before this line is ever reached) — not because the
  // key itself is secret (a Maps JavaScript API key is designed to be
  // visible in the browser once loaded; Google's own HTTP-referrer/API
  // restrictions protect it, not secrecy — see
  // admin/address-autocomplete.js's header), but specifically so an
  // unauthenticated caller can never even learn whether a key is
  // configured: requireAdmin() already sent an identical 401 and returned
  // before this code path exists for that caller, regardless of whether
  // ADMIN_GOOGLE_MAPS_API_KEY happens to be set.
  if (req.query.view === "google-config") {
    return handleGoogleConfig(req, res);
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

  // Phase 3C Stage 2.4 addendum: ?view=expenses lists Daily Quick Expense
  // rows for a bounded date range — same "extend this file, not a new
  // function" reasoning as scheduleView/countsOnly above.
  const expensesView = req.query.view === "expenses";
  if (expensesView) {
    return handleExpensesList(req, res, supabase);
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
// Google Maps browser-key config — Phase 3C Stage 2.4.1. requireAdmin()
// has already run before this is ever reached (see module.exports above).
// Pure env-var read, no I/O, no Supabase — deliberately never logs the key
// (not even on failure; there is no failure path here beyond "unset,"
// which returns an empty string like every other unconfigured value in
// this codebase). ADMIN_GOOGLE_MAPS_API_KEY lives only in Vercel's
// environment configuration — never committed to this repository.
// ---------------------------------------------------------------------
function handleGoogleConfig(req, res) {
  const raw = process.env.ADMIN_GOOGLE_MAPS_API_KEY;
  const key = typeof raw === "string" ? raw.trim() : "";
  res.status(200).json({ ok: true, googleMapsApiKey: key });
}

// ---------------------------------------------------------------------
// Admin Schedule (?view=schedule&range=today|tomorrow|week|month|year) —
// Phase 3C Stage 1 (today/tomorrow/week), extended Stage 2.4 (navigable
// week, month, year). Kept as a clearly separated block below the main
// handler (rather than interleaved with the Requests-list logic above) so
// the two remain easy to read independently despite sharing one file/
// function purely for the Vercel Hobby-plan function-count reason explained
// above requireAdmin's call site. Read-only, same requireAdmin()/
// service-role/no-store posture — requireAdmin() and the method check
// already ran before this is reached.
//
// Week start day: Sunday. Chosen (Phase 3C Stage 2.4) to match the default
// week view of both Google Calendar and Apple Calendar for a US locale —
// the convention a Denver-based owner's phone almost certainly already
// shows — over an ISO-8601 Monday start. Documented once, here, as the
// single source of truth; admin/schedule.js's client-side copy of this same
// convention points back to this comment.
// ---------------------------------------------------------------------
async function handleSchedule(req, res, supabase) {
  const requestedRange = typeof req.query.range === "string" ? req.query.range.trim().toLowerCase() : "";
  const range = VALID_RANGES.indexOf(requestedRange) !== -1 ? requestedRange : "today";

  const todayIso = denverTodayIso();

  if (range === "month") return handleMonth(req, res, supabase, todayIso);
  if (range === "year") return handleYear(req, res, supabase, todayIso);
  if (range === "day") return handleDay(req, res, supabase, todayIso);

  let startDate, endDate, weekStart, weekEnd;
  let beforeHistoricalFloor = false;
  if (range === "today") {
    startDate = todayIso;
    endDate = todayIso;
  } else if (range === "tomorrow") {
    startDate = addDaysIso(todayIso, 1);
    endDate = startDate;
  } else if (range === "yesterday") {
    // Same Denver-local model as today/tomorrow: yesterday is simply
    // "todayIso minus one calendar day". If that falls before the
    // historical floor (only possible when "today" itself is at or just
    // past the floor), this is handled cleanly — zero jobs, no query, a
    // `beforeHistoricalFloor` flag the client shows a dedicated empty state
    // for — rather than running a query against a date range the floor was
    // never designed to bound.
    startDate = addDaysIso(todayIso, -1);
    endDate = startDate;
    beforeHistoricalFloor = startDate < HISTORICAL_FLOOR_ISO;
  } else {
    // Navigable calendar week (Phase 3C Stage 2.4) — replaces the Stage 1
    // "today + next 6 days" rolling window. An explicit ?weekStart= must be
    // the Sunday of the week the caller wants; omitted, it defaults to the
    // Sunday of the current Denver week (so a bare ?range=week keeps
    // working exactly like every existing caller expects). Every rule here
    // is enforced server-side — the client only ever sends a value it
    // itself already computed the same way, per admin/schedule.js's header.
    const requestedWeekStart = typeof req.query.weekStart === "string" ? req.query.weekStart.trim() : "";
    if (requestedWeekStart) {
      if (!isValidIsoDate(requestedWeekStart)) {
        res.status(400).json({ error: "Invalid week start date." });
        return;
      }
      if (dayOfWeekIso(requestedWeekStart) !== 0) {
        res.status(400).json({ error: "Week start date must be a Sunday." });
        return;
      }
      if (requestedWeekStart < FLOOR_WEEK_START_ISO) {
        res.status(400).json({ error: "Cannot navigate to a week before the historical floor (January 2026)." });
        return;
      }
      weekStart = requestedWeekStart;
    } else {
      weekStart = startOfWeekSundayIso(todayIso);
    }
    weekEnd = addDaysIso(weekStart, WEEK_SPAN_DAYS - 1);
    startDate = weekStart;
    endDate = weekEnd;
  }

  try {
    const jobs = beforeHistoricalFloor ? [] : await fetchScheduleJobs(supabase, startDate, endDate);
    const body = { ok: true, range: range, startDate: startDate, endDate: endDate, jobs: jobs, today: todayIso };
    if (beforeHistoricalFloor) body.beforeHistoricalFloor = true;
    if (range === "week") {
      body.weekStart = weekStart;
      body.weekEnd = weekEnd;
      body.isCurrentWeek = weekStart === startOfWeekSundayIso(todayIso);
      body.canGoPrevious = weekStart > FLOOR_WEEK_START_ISO;
    }
    res.status(200).json(body);
  } catch (err) {
    console.error("Admin schedule failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load the schedule." });
  }
}

// ---------------------------------------------------------------------
// Single explicit date (?view=schedule&range=day&date=YYYY-MM-DD) — Phase
// 3C Stage 2.4.2. Backs the Today/Tomorrow/Yesterday view's restrained
// previous-day/next-day arrows (admin/schedule.js): those buttons compute
// the adjacent calendar date client-side (the same Denver-local addDaysIso
// this file already uses) and ask for that one explicit date, rather than
// guessing which named range (if any) it corresponds to. This never
// replaces today/tomorrow/yesterday themselves, which stay their own
// explicit ranges specifically so "today" is always resolved from the real
// server clock, never trusted from the client. Same bounded single-day
// query fetchScheduleJobs() already provides for today/tomorrow/yesterday.
// ---------------------------------------------------------------------
async function handleDay(req, res, supabase, todayIso) {
  const dateRaw = typeof req.query.date === "string" ? req.query.date.trim() : "";
  if (!isValidIsoDate(dateRaw)) {
    res.status(400).json({ error: "A valid date is required." });
    return;
  }
  if (dateRaw < HISTORICAL_FLOOR_ISO) {
    res.status(400).json({ error: "Cannot navigate before the historical floor (January 1, 2026)." });
    return;
  }
  const maxYear = Number(todayIso.slice(0, 4)) + MAX_FUTURE_YEARS;
  if (Number(dateRaw.slice(0, 4)) > maxYear) {
    res.status(400).json({ error: "That date is too far in the future." });
    return;
  }

  try {
    const jobs = await fetchScheduleJobs(supabase, dateRaw, dateRaw);
    res.status(200).json({ ok: true, range: "day", startDate: dateRaw, endDate: dateRaw, jobs: jobs, today: todayIso });
  } catch (err) {
    console.error("Admin day schedule failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load that date." });
  }
}

// Shared by today/tomorrow/week (handleSchedule) and Month (handleMonth) —
// both need the exact same "full job card" shape for a bounded date range,
// just with the range itself computed differently. Never called with an
// unbounded range: every caller already validated/derived a specific
// start/end pair before reaching here.
async function fetchScheduleJobs(supabase, startDate, endDate) {
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

  return jobs;
}

// ---------------------------------------------------------------------
// Month view (?view=schedule&range=month&year=YYYY&month=1-12) — Phase 3C
// Stage 2.4. One bounded query for the whole calendar month (never one
// request per day). Returns full job cards (same shape as week/today) PLUS
// a jobCountsByDate map, so both the compact per-day indicator in the
// calendar grid and the selected-day job list below it come from this same
// single response — selecting a different day within the loaded month
// never triggers another request.
// ---------------------------------------------------------------------
async function handleMonth(req, res, supabase, todayIso) {
  const todayParts = todayIso.split("-").map(Number);
  const currentYear = todayParts[0];
  const maxYear = currentYear + MAX_FUTURE_YEARS;

  let year = currentYear;
  if (req.query.year !== undefined) {
    const raw = String(req.query.year).trim();
    if (!/^\d{4}$/.test(raw)) {
      res.status(400).json({ error: "Invalid year." });
      return;
    }
    year = parseInt(raw, 10);
  }

  let month = todayParts[1];
  if (req.query.month !== undefined) {
    const raw = String(req.query.month).trim();
    if (!/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 12) {
      res.status(400).json({ error: "Invalid month." });
      return;
    }
    month = parseInt(raw, 10);
  }

  if (year < HISTORICAL_FLOOR_YEAR || (year === HISTORICAL_FLOOR_YEAR && month < HISTORICAL_FLOOR_MONTH)) {
    res.status(400).json({ error: "Cannot navigate before the historical floor (January 2026)." });
    return;
  }
  if (year > maxYear) {
    res.status(400).json({ error: "That year is too far in the future." });
    return;
  }

  const startDate = ymdIso(year, month, 1);
  const endDate = ymdIso(year, month, daysInMonth(year, month));

  try {
    const jobs = await fetchScheduleJobs(supabase, startDate, endDate);
    const jobCountsByDate = {};
    jobs.forEach(function (j) {
      jobCountsByDate[j.appointmentDate] = (jobCountsByDate[j.appointmentDate] || 0) + 1;
    });
    res.status(200).json({
      ok: true,
      range: "month",
      year: year,
      month: month,
      startDate: startDate,
      endDate: endDate,
      jobs: jobs,
      jobCountsByDate: jobCountsByDate,
      today: todayIso,
    });
  } catch (err) {
    console.error("Admin month schedule failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load the month." });
  }
}

// ---------------------------------------------------------------------
// Year view (?view=schedule&range=year&year=YYYY) — Phase 3C Stage 2.4.
// Navigation only, per the stage's explicit "no revenue/profit/expenses in
// Year view" boundary — so this returns per-month JOB COUNTS only (never
// full booking rows, never a dollar figure), computed from one bounded
// query for the whole year (id + appointment_date only, the minimum needed
// to count). Never 12 or 365 separate requests.
// ---------------------------------------------------------------------
async function handleYear(req, res, supabase, todayIso) {
  const currentYear = Number(todayIso.slice(0, 4));
  const maxYear = currentYear + MAX_FUTURE_YEARS;

  let year = currentYear;
  if (req.query.year !== undefined) {
    const raw = String(req.query.year).trim();
    if (!/^\d{4}$/.test(raw)) {
      res.status(400).json({ error: "Invalid year." });
      return;
    }
    year = parseInt(raw, 10);
  }

  if (year < HISTORICAL_FLOOR_YEAR) {
    res.status(400).json({ error: "Cannot navigate before the historical floor (2026)." });
    return;
  }
  if (year > maxYear) {
    res.status(400).json({ error: "That year is too far in the future." });
    return;
  }

  const startDate = ymdIso(year, 1, 1);
  const endDate = ymdIso(year, 12, 31);

  try {
    const bookingsRes = await supabase
      .from("bookings")
      .select("id, appointment_date")
      .in("status", SCHEDULABLE_STATUSES)
      .gte("appointment_date", startDate)
      .lte("appointment_date", endDate);
    if (bookingsRes.error) throw bookingsRes.error;

    const countsByMonth = new Array(12).fill(0);
    (bookingsRes.data || []).forEach(function (b) {
      const m = Number(String(b.appointment_date).slice(5, 7));
      if (m >= 1 && m <= 12) countsByMonth[m - 1] += 1;
    });
    const monthCounts = countsByMonth.map(function (count, idx) {
      return { month: idx + 1, count: count };
    });

    res.status(200).json({ ok: true, range: "year", year: year, startDate: startDate, endDate: endDate, monthCounts: monthCounts, today: todayIso });
  } catch (err) {
    console.error("Admin year schedule failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load the year." });
  }
}

// ---------------------------------------------------------------------
// Daily Quick Expense Tracking — Phase 3C Stage 2.4 addendum. Tracking
// only: no totals beyond the raw rows are computed anywhere in this file
// (the client sums a single day's rows for the "Tracked expenses: $X"
// line — see admin/schedule.js — deliberately never labeled Profit/Net
// Profit). Depends on a production `expenses` table that does NOT exist
// yet as of this stage — see docs/phase-3/stage2.4-expenses-migration.md.
// Both handlers below fail safely (a clean 500, logged server-side) if the
// table is missing; nothing else in this file is affected either way.
// ---------------------------------------------------------------------

// GET ?view=expenses&startDate=...&endDate=... — a bounded date range
// (normally a single day from the Schedule's selected-day panel, but wide
// enough — capped at EXPENSES_MAX_RANGE_DAYS — that a future Month/Year
// expense summary could reuse this exact query shape without a new
// endpoint). requireAdmin() has already run before this is reached.
async function handleExpensesList(req, res, supabase) {
  const startDateRaw = typeof req.query.startDate === "string" ? req.query.startDate.trim() : "";
  const endDateRaw = typeof req.query.endDate === "string" ? req.query.endDate.trim() : "";
  if (!isValidIsoDate(startDateRaw) || !isValidIsoDate(endDateRaw)) {
    res.status(400).json({ error: "A valid startDate and endDate are required." });
    return;
  }
  if (endDateRaw < startDateRaw) {
    res.status(400).json({ error: "endDate cannot be before startDate." });
    return;
  }
  const spanDays = Math.round((parseIsoAsUtcMs(endDateRaw) - parseIsoAsUtcMs(startDateRaw)) / 86400000) + 1;
  if (spanDays > EXPENSES_MAX_RANGE_DAYS) {
    res.status(400).json({ error: "Date range is too wide." });
    return;
  }

  try {
    const expensesRes = await supabase
      .from("expenses")
      .select("id, expense_date, category, amount, note, created_at, updated_at")
      .gte("expense_date", startDateRaw)
      .lte("expense_date", endDateRaw)
      .order("expense_date", { ascending: true })
      .order("created_at", { ascending: true });
    if (expensesRes.error) throw expensesRes.error;

    const expenses = (expensesRes.data || []).map(function (e) {
      return {
        id: e.id,
        expenseDate: e.expense_date,
        category: e.category,
        categoryLabel: EXPENSE_CATEGORIES[e.category] || e.category,
        amount: e.amount,
        note: e.note,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      };
    });

    res.status(200).json({ ok: true, startDate: startDateRaw, endDate: endDateRaw, expenses: expenses });
  } catch (err) {
    console.error("Admin expenses list failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load expenses." });
  }
}

// POST /api/admin/bookings { resource: "expense", ... } — create one
// expense row. `resource` is an explicit, allowlisted discriminator (never
// inferred) distinguishing this from any other future POST-able resource
// this file might grow, mirroring api/admin/booking.js's own `mode`
// discriminator. Every field is read individually as a named primitive and
// validated before being placed into the insert payload — the request body
// is never spread into it. Never trusts category/date/amount merely because
// the client supplied them, per the stage's explicit instruction.
async function handleCreateExpense(req, res) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin expense create failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

  const resource = typeof body.resource === "string" ? body.resource.trim() : "";
  if (resource !== "expense") {
    res.status(400).json({ error: "Invalid or missing resource." });
    return;
  }

  const expenseDate = typeof body.expenseDate === "string" ? body.expenseDate.trim() : "";
  if (!isValidIsoDate(expenseDate)) {
    res.status(400).json({ error: "A valid expense date is required." });
    return;
  }
  if (expenseDate < HISTORICAL_FLOOR_ISO) {
    res.status(400).json({ error: "Expense date cannot be before January 1, 2026." });
    return;
  }
  const todayIso = denverTodayIso();
  if (expenseDate > todayIso) {
    res.status(400).json({ error: "Expense date cannot be in the future." });
    return;
  }

  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (!Object.prototype.hasOwnProperty.call(EXPENSE_CATEGORIES, category)) {
    res.status(400).json({ error: "Please choose a valid expense category." });
    return;
  }

  if (body.amount === undefined || body.amount === null || body.amount === "") {
    res.status(400).json({ error: "An amount is required." });
    return;
  }
  const amountNum = Number(body.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0 || amountNum > EXPENSE_MAX_AMOUNT) {
    res.status(400).json({ error: "Please enter a valid amount." });
    return;
  }
  const amount = Math.round(amountNum * 100) / 100;

  const note = sanitizeExpenseText(body.note, EXPENSE_NOTE_MAX) || null;

  try {
    const { data: created, error } = await supabase
      .from("expenses")
      .insert({
        expense_date: expenseDate,
        category: category,
        amount: amount,
        note: note,
      })
      .select("id, expense_date, category, amount, note, created_at, updated_at")
      .single();

    if (error || !created) throw error || new Error("Insert returned no row.");

    res.status(200).json({
      ok: true,
      expense: {
        id: created.id,
        expenseDate: created.expense_date,
        category: created.category,
        categoryLabel: EXPENSE_CATEGORIES[created.category] || created.category,
        amount: created.amount,
        note: created.note,
        createdAt: created.created_at,
        updatedAt: created.updated_at,
      },
    });
  } catch (err) {
    console.error("Admin expense create failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not save this expense." });
  }
}

// Strip control characters and any "<...>"-shaped text, trim, bound length
// — same discipline as api/admin/booking.js's own sanitizeText(), kept as
// its own small copy here rather than a shared import (this project's
// established convention — see denverTodayIso's own comment just below).
function sanitizeExpenseText(value, maxLen) {
  if (typeof value !== "string") return "";
  var stripped = "";
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    var isControl = code <= 31 && code !== 9 && code !== 10 && code !== 13;
    if (!isControl) stripped += value[i];
  }
  return stripped.replace(/<[^>]*>/g, "").trim().slice(0, maxLen);
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

// How many years past the current Denver year Month/Year navigation (and
// the expense floor's upper bound) will accept — generous enough for
// ordinary future business planning, bounded enough that a crafted
// ?year=9999 can't force an absurd query. Not a hard product limit (the
// business will keep operating past this window; the constant just moves
// forward every year on its own since it's always current-year-relative).
const MAX_FUTURE_YEARS = 3;

// ---------------------------------------------------------------------
// Small pure calendar-math helpers — Phase 3C Stage 2.4 (Month/Year/
// navigable-week calendar navigation). Every one of these is a calendar
// calculator only, never a real moment in time: each anchors at UTC noon
// (addDaysIso above already established this pattern) specifically so nothing
// here can be shifted onto the wrong calendar day by a DST transition.
// ---------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// True only for a real calendar date in YYYY-MM-DD form — rejects both a
// malformed string and a syntactically-shaped but impossible date (e.g.
// "2026-02-30"), by round-tripping the parsed value back through Date and
// comparing every part rather than trusting that new Date(...) itself
// would reject an out-of-range day (it silently rolls over instead).
function isValidIsoDate(s) {
  if (typeof s !== "string" || !ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
}

// Milliseconds since epoch for a YYYY-MM-DD string's UTC-noon anchor —
// purely for measuring the number of calendar days between two ISO dates
// (see handleExpensesList's span-days bound); never used as a real instant.
function parseIsoAsUtcMs(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12, 0, 0);
}

// Day of week for a YYYY-MM-DD string: 0=Sunday .. 6=Saturday.
function dayOfWeekIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

// The Sunday on/before `iso` — see handleSchedule's "Week start day"
// comment for why Sunday. Used both to default an omitted ?weekStart= to
// the current Denver week, and to compute FLOOR_WEEK_START_ISO once at
// module load from HISTORICAL_FLOOR_ISO.
function startOfWeekSundayIso(iso) {
  return addDaysIso(iso, -dayOfWeekIso(iso));
}

// The last calendar day of `month` (1-12) in `year`, as an integer 28-31 —
// day 0 of the following month is the standard trick for "last day of this
// month" with JS's Date.
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
}

function ymdIso(year, month, day) {
  return year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}
