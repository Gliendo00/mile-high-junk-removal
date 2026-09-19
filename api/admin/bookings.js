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
const { serviceLabel, timeWindowLabel, effectiveTimeLabel, statusLabel, normalizedStatus, STATUS_LABELS } = require("../_lib/booking-format");
const { effectiveTimeSortMinutes } = require("../_lib/time-windows");
const { HISTORICAL_FLOOR_ISO, HISTORICAL_FLOOR_YEAR, HISTORICAL_FLOOR_MONTH } = require("../_lib/historical-floor");
const { EXPENSE_CATEGORIES, ALL_EXPENSE_CATEGORY_KEYS } = require("../_lib/expense-categories");
const { VALID_PAYMENT_METHODS: JOB_PAYMENT_METHODS } = require("../_lib/job-payments-ledger");

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
  if (req.method === "POST") return handleCreateExpense(req, res, session);

  // Phase 3C Stage 3 (full Expense Management): PATCH edits or voids one
  // expense row — same `resource: "expense"` discriminator as the POST
  // above, with an `action` field distinguishing "update" (default) from
  // "void". Folded into this same file/method for the same 12-function-
  // budget reason as every other resource here (see this file's header).
  if (req.method === "PATCH") return handlePatchExpense(req, res, session);

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

  // Phase 3C Stage 3: ?view=expense-audit&expenseId=... lists one expense's
  // full change history (written automatically by the database trigger —
  // see the migration SQL). Read-only, same folding reasoning as every
  // other view= mode in this file.
  if (req.query.view === "expense-audit") {
    return handleExpenseAuditLog(req, res, supabase);
  }

  // Phase 3C Stage 3: ?view=job-search&q=... is the small "link to a job"
  // picker the Expenses page's job-link field uses — searches by customer
  // name/phone, same multi-field ilike pattern api/admin/clients.js already
  // established, then returns that customer's recent bookings. Read-only.
  if (req.query.view === "job-search") {
    return handleJobSearch(req, res, supabase);
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
          .select("id, service_type, appointment_date, time_window, exact_time, status, estimated_price, estimated_price_max, final_price, customer_id, service_city, created_at")
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
        timeLabel: effectiveTimeLabel(b.time_window, b.exact_time),
        status: normalizedStatus(b.status),
        statusLabel: statusLabel(b.status),
        estimatedPrice: b.estimated_price,
        estimatedPriceMax: b.estimated_price_max,
        finalPrice: b.final_price,
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
    .select(
      "id, service_type, appointment_date, time_window, exact_time, status, estimated_price, estimated_price_max, final_price, customer_id, service_address, service_city, service_state, service_zip"
    )
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
      exactTime: b.exact_time,
      // The one label Schedule cards actually render — exact_time when set,
      // else the time_window label, else "—". See booking-format.js's
      // effectiveTimeLabel(); timeWindowLabel above is kept as an additive
      // field for any caller still reading the raw window-only label.
      timeLabel: effectiveTimeLabel(b.time_window, b.exact_time),
      status: normalizedStatus(b.status),
      statusLabel: statusLabel(b.status),
      estimatedPrice: b.estimated_price,
      estimatedPriceMax: b.estimated_price_max,
      finalPrice: b.final_price,
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
  // that date via the shared effective-minute lookup (api/_lib/time-
  // windows.js's effectiveTimeSortMinutes) — never a second, duplicated
  // time-to-minutes map. Handles a mix of exact-time and window jobs on the
  // same date: an exact-time job sorts by its precise minute, a window job
  // by its existing start-hour logic, and a legacy/unrecognized/no-time job
  // (effectiveTimeSortMinutes returns null) sorts after every recognized
  // time on the same date rather than throwing or being dropped.
  jobs.sort(function (a, b) {
    if (a.appointmentDate !== b.appointmentDate) {
      return a.appointmentDate < b.appointmentDate ? -1 : 1;
    }
    const aMinutes = effectiveTimeSortMinutes(a.timeWindow, a.exactTime);
    const bMinutes = effectiveTimeSortMinutes(b.timeWindow, b.exactTime);
    if (aMinutes === null && bMinutes === null) return 0;
    if (aMinutes === null) return 1;
    if (bMinutes === null) return -1;
    return aMinutes - bMinutes;
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

const EXPENSE_COLS =
  "id, expense_date, category, amount, note, vendor, payment_method, booking_id, receipt_reference, voided_at, voided_reason, created_by, updated_by, created_at, updated_at";
const EXPENSE_VENDOR_MAX = 120;
const EXPENSE_RECEIPT_REF_MAX = 120;
const EXPENSE_VOID_REASON_MAX = 300;
const EXPENSE_SEARCH_MAX_LEN = 60;
// Same order-of-magnitude reasoning as api/admin/clients.js's own
// SEARCH_FIELD_LIMIT: a bound on how many candidate rows one ilike() call
// ever holds in memory, not a hard product limit.
const EXPENSE_SEARCH_FIELD_LIMIT = 300;
const EXPENSE_LIST_DEFAULT_LIMIT = 200;
const EXPENSE_LIST_MAX_LIMIT = 500;
const EXPENSE_SORT_COLUMNS = { expenseDate: "expense_date", amount: "amount", category: "category", vendor: "vendor", createdAt: "created_at" };

function serializeExpense(e) {
  return {
    id: e.id,
    expenseDate: e.expense_date,
    category: e.category,
    categoryLabel: EXPENSE_CATEGORIES[e.category] || e.category,
    amount: e.amount,
    note: e.note,
    vendor: e.vendor,
    paymentMethod: e.payment_method,
    bookingId: e.booking_id,
    receiptReference: e.receipt_reference,
    voidedAt: e.voided_at,
    voidedReason: e.voided_reason,
    isVoided: !!e.voided_at,
    createdBy: e.created_by,
    updatedBy: e.updated_by,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

// Attaches a short, display-only label (customer name + appointment date)
// for every expense row that has a booking_id, via one batched lookup —
// same batching shape as this file's own main list handler (see
// customersById above). Never fails the whole response if this enrichment
// step errors; a linked expense just falls back to showing its bare
// bookingId in that case.
async function attachJobLabels(supabase, expenses) {
  const bookingIds = Array.from(new Set(expenses.map((e) => e.bookingId).filter(Boolean)));
  if (!bookingIds.length) return expenses;
  try {
    const bookingsRes = await supabase.from("bookings").select("id, appointment_date, service_type, customer_id").in("id", bookingIds);
    if (bookingsRes.error) throw bookingsRes.error;
    const bookings = bookingsRes.data || [];
    const customerIds = Array.from(new Set(bookings.map((b) => b.customer_id).filter(Boolean)));
    const customersById = {};
    if (customerIds.length) {
      const custRes = await supabase.from("customers").select("id, first_name, last_name").in("id", customerIds);
      if (custRes.error) throw custRes.error;
      (custRes.data || []).forEach((c) => {
        customersById[c.id] = c;
      });
    }
    const bookingsById = {};
    bookings.forEach((b) => {
      const cust = customersById[b.customer_id];
      const name = cust ? [cust.first_name, cust.last_name].filter(Boolean).join(" ") : "";
      bookingsById[b.id] = { label: (name || "Job") + " — " + b.appointment_date, appointmentDate: b.appointment_date, serviceLabel: serviceLabel(b.service_type) };
    });
    return expenses.map((e) => Object.assign({}, e, { job: e.bookingId ? bookingsById[e.bookingId] || null : null }));
  } catch (err) {
    console.error("Admin expenses: job-label enrichment failed (non-fatal):", err && err.stack ? err.stack : err);
    return expenses;
  }
}

// GET ?view=expenses&startDate=...&endDate=... — a bounded date range
// (the Quick Expense bar's own call is always a single day; the full
// /admin/expenses/ page passes a wider range, still capped at
// EXPENSES_MAX_RANGE_DAYS). requireAdmin() has already run before this is
// reached. Stage 3 additions, all optional: category/paymentMethod/
// bookingId filters, a vendor+note search, sort, pagination, and
// includeVoided (voided rows are excluded by default everywhere — the
// Quick Expense bar's day-sum and the full page's default view should
// never silently include a corrected-away entry).
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

  const categoryRaw = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const categoryFilter = Object.prototype.hasOwnProperty.call(EXPENSE_CATEGORIES, categoryRaw) ? categoryRaw : "";

  const paymentMethodRaw = typeof req.query.paymentMethod === "string" ? req.query.paymentMethod.trim() : "";
  const paymentMethodFilter = JOB_PAYMENT_METHODS.indexOf(paymentMethodRaw) !== -1 ? paymentMethodRaw : "";

  const bookingIdFilter = typeof req.query.bookingId === "string" ? req.query.bookingId.trim() : "";
  const includeVoided = req.query.includeVoided === "1";
  const search = sanitizeIlikeSearchTerm(typeof req.query.search === "string" ? req.query.search : "");

  const sortKey = Object.prototype.hasOwnProperty.call(EXPENSE_SORT_COLUMNS, req.query.sort) ? req.query.sort : "expenseDate";
  const sortCol = EXPENSE_SORT_COLUMNS[sortKey];
  const sortAsc = req.query.sortDir === "asc";

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = EXPENSE_LIST_DEFAULT_LIMIT;
  limit = Math.min(limit, EXPENSE_LIST_MAX_LIMIT);
  let offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  function applyCommonFilters(q) {
    q = q.gte("expense_date", startDateRaw).lte("expense_date", endDateRaw);
    if (!includeVoided) q = q.is("voided_at", null);
    if (categoryFilter) q = q.eq("category", categoryFilter);
    if (paymentMethodFilter) q = q.eq("payment_method", paymentMethodFilter);
    if (bookingIdFilter) q = q.eq("booking_id", bookingIdFilter);
    return q;
  }

  try {
    let rows;
    if (search) {
      // Same bounded, multi-field, merge-in-memory search shape as
      // api/admin/clients.js — never a single raw .or() filter string (see
      // that file's own comment for why).
      const pattern = "%" + search + "%";
      const [byVendor, byNote] = await Promise.all([
        applyCommonFilters(supabase.from("expenses").select(EXPENSE_COLS)).ilike("vendor", pattern).limit(EXPENSE_SEARCH_FIELD_LIMIT),
        applyCommonFilters(supabase.from("expenses").select(EXPENSE_COLS)).ilike("note", pattern).limit(EXPENSE_SEARCH_FIELD_LIMIT),
      ]);
      if (byVendor.error) throw byVendor.error;
      if (byNote.error) throw byNote.error;
      const merged = new Map();
      [byVendor, byNote].forEach((r) => (r.data || []).forEach((e) => merged.set(e.id, e)));
      rows = Array.from(merged.values());
    } else {
      const pageRes = await applyCommonFilters(supabase.from("expenses").select(EXPENSE_COLS)).limit(EXPENSE_LIST_MAX_LIMIT);
      if (pageRes.error) throw pageRes.error;
      rows = pageRes.data || [];
    }

    rows.sort(function (a, b) {
      const av = a[sortCol],
        bv = b[sortCol];
      if (av < bv) return sortAsc ? -1 : 1;
      if (av > bv) return sortAsc ? 1 : -1;
      // Stable, deterministic tie-break so equal-sort-key rows (e.g. two
      // expenses on the same date) don't reorder between requests.
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    });

    const total = rows.length;
    const totalAmount = rows.reduce(function (sum, e) {
      return sum + (Number(e.amount) || 0);
    }, 0);
    const page = rows.slice(offset, offset + limit).map(serializeExpense);
    const enriched = await attachJobLabels(supabase, page);

    res.status(200).json({
      ok: true,
      startDate: startDateRaw,
      endDate: endDateRaw,
      expenses: enriched,
      total: total,
      totalAmount: Math.round(totalAmount * 100) / 100,
      limit: limit,
      offset: offset,
      hasMore: offset + page.length < total,
    });
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
async function handleCreateExpense(req, res, session) {
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
  const vendor = sanitizeExpenseText(body.vendor, EXPENSE_VENDOR_MAX) || null;
  const receiptReference = sanitizeExpenseText(body.receiptReference, EXPENSE_RECEIPT_REF_MAX) || null;

  let paymentMethod = null;
  if (body.paymentMethod !== undefined && body.paymentMethod !== null && body.paymentMethod !== "") {
    const pm = typeof body.paymentMethod === "string" ? body.paymentMethod.trim() : "";
    if (JOB_PAYMENT_METHODS.indexOf(pm) === -1) {
      res.status(400).json({ error: "Please choose a valid payment method." });
      return;
    }
    paymentMethod = pm;
  }

  let bookingId = null;
  if (body.bookingId !== undefined && body.bookingId !== null && body.bookingId !== "") {
    const bid = typeof body.bookingId === "string" ? body.bookingId.trim() : "";
    if (!bid) {
      res.status(400).json({ error: "Invalid job link." });
      return;
    }
    // A malformed/nonexistent id is caught by the FK constraint on insert
    // below (23503), not re-validated here — the DB is the single source
    // of truth for whether a booking id is real.
    bookingId = bid;
  }

  try {
    const { data: created, error } = await supabase
      .from("expenses")
      .insert({
        expense_date: expenseDate,
        category: category,
        amount: amount,
        note: note,
        vendor: vendor,
        payment_method: paymentMethod,
        booking_id: bookingId,
        receipt_reference: receiptReference,
        created_by: (session && session.email) || null,
      })
      .select(EXPENSE_COLS)
      .single();

    if (error) {
      if (error.code === "23503") {
        res.status(400).json({ error: "That job could not be found." });
        return;
      }
      throw error;
    }
    if (!created) throw new Error("Insert returned no row.");

    res.status(200).json({ ok: true, expense: serializeExpense(created) });
  } catch (err) {
    console.error("Admin expense create failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not save this expense." });
  }
}

// PATCH /api/admin/bookings { resource: "expense", id, action, ... } —
// either "update" (default; edits editable fields on an active expense) or
// "void" (soft-delete). Both share this one entry point since both are
// PATCHes to one existing row, mirroring api/admin/booking.js's own
// resource=charges PATCH (single method, branch on an explicit action
// field, never inferred).
//
// Financial-audit discipline (the owner's explicit requirement): this
// handler EDITS the row's current fields — it never creates a second
// competing row for a correction. The full "preserve original, void it,
// create corrected entry" pattern applies to job_payments (an append-only
// ledger of discrete transactions), not to expenses (a single evolving
// record of one cost, e.g. "$68 dump fee" becoming "$76 dump fee" is
// correcting the SAME expense, not two different financial events). What
// makes this still safe for financial data is the database trigger (see
// the migration SQL's §3): every field this handler changes is
// automatically, unconditionally logged to expense_audit_log — old value,
// new value, when, by whom — so nothing is silently lost even though the
// row itself is mutated in place.
async function handlePatchExpense(req, res, session) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin expense update failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

  const resource = typeof body.resource === "string" ? body.resource.trim() : "";
  if (resource !== "expense") {
    res.status(400).json({ error: "Invalid or missing resource." });
    return;
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    res.status(400).json({ error: "Expense id is required." });
    return;
  }

  const action = typeof body.action === "string" ? body.action.trim() : "update";
  if (action !== "update" && action !== "void") {
    res.status(400).json({ error: "Invalid action." });
    return;
  }

  try {
    const currentRes = await supabase.from("expenses").select(EXPENSE_COLS).eq("id", id).maybeSingle();
    if (currentRes.error) throw currentRes.error;
    const current = currentRes.data;
    if (!current) {
      res.status(404).json({ error: "Expense not found." });
      return;
    }
    if (current.voided_at) {
      // A voided expense is a closed financial record — neither editable
      // nor re-voidable. The correction path is a brand-new expense entry,
      // exactly as the owner specified.
      res.status(409).json({ error: "This expense has already been voided and can no longer be changed." });
      return;
    }

    if (action === "void") {
      const reason = sanitizeExpenseText(body.reason, EXPENSE_VOID_REASON_MAX);
      if (!reason) {
        res.status(400).json({ error: "A reason is required to void an expense." });
        return;
      }
      const { data: voided, error } = await supabase
        .from("expenses")
        .update({
          voided_at: new Date().toISOString(),
          voided_reason: reason,
          updated_by: (session && session.email) || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .is("voided_at", null)
        .select(EXPENSE_COLS)
        .maybeSingle();
      if (error) throw error;
      if (!voided) {
        // Lost a race with another admin voiding/editing the same row
        // between the read above and this write.
        res.status(409).json({ error: "This expense was just changed by someone else. Please refresh and try again." });
        return;
      }
      res.status(200).json({ ok: true, expense: serializeExpense(voided) });
      return;
    }

    // action === "update" — every field is optional; only fields actually
    // present in the body are changed (a partial edit, e.g. "just fix the
    // amount", never requires resending the whole record). Same
    // per-field validation as handleCreateExpense above.
    const update = { updated_by: (session && session.email) || null, updated_at: new Date().toISOString() };

    if (body.expenseDate !== undefined) {
      const expenseDate = typeof body.expenseDate === "string" ? body.expenseDate.trim() : "";
      if (!isValidIsoDate(expenseDate)) {
        res.status(400).json({ error: "A valid expense date is required." });
        return;
      }
      if (expenseDate < HISTORICAL_FLOOR_ISO) {
        res.status(400).json({ error: "Expense date cannot be before January 1, 2026." });
        return;
      }
      if (expenseDate > denverTodayIso()) {
        res.status(400).json({ error: "Expense date cannot be in the future." });
        return;
      }
      update.expense_date = expenseDate;
    }

    if (body.category !== undefined) {
      const category = typeof body.category === "string" ? body.category.trim() : "";
      if (!Object.prototype.hasOwnProperty.call(EXPENSE_CATEGORIES, category)) {
        res.status(400).json({ error: "Please choose a valid expense category." });
        return;
      }
      update.category = category;
    }

    if (body.amount !== undefined) {
      const amountNum = Number(body.amount);
      if (!Number.isFinite(amountNum) || amountNum <= 0 || amountNum > EXPENSE_MAX_AMOUNT) {
        res.status(400).json({ error: "Please enter a valid amount." });
        return;
      }
      update.amount = Math.round(amountNum * 100) / 100;
    }

    if (body.note !== undefined) update.note = sanitizeExpenseText(body.note, EXPENSE_NOTE_MAX) || null;
    if (body.vendor !== undefined) update.vendor = sanitizeExpenseText(body.vendor, EXPENSE_VENDOR_MAX) || null;
    if (body.receiptReference !== undefined) update.receipt_reference = sanitizeExpenseText(body.receiptReference, EXPENSE_RECEIPT_REF_MAX) || null;

    if (body.paymentMethod !== undefined) {
      if (body.paymentMethod === null || body.paymentMethod === "") {
        update.payment_method = null;
      } else {
        const pm = typeof body.paymentMethod === "string" ? body.paymentMethod.trim() : "";
        if (JOB_PAYMENT_METHODS.indexOf(pm) === -1) {
          res.status(400).json({ error: "Please choose a valid payment method." });
          return;
        }
        update.payment_method = pm;
      }
    }

    if (body.bookingId !== undefined) {
      update.booking_id = body.bookingId === null || body.bookingId === "" ? null : String(body.bookingId).trim();
    }

    const { data: updated, error } = await supabase.from("expenses").update(update).eq("id", id).is("voided_at", null).select(EXPENSE_COLS).maybeSingle();
    if (error) {
      if (error.code === "23503") {
        res.status(400).json({ error: "That job could not be found." });
        return;
      }
      throw error;
    }
    if (!updated) {
      res.status(409).json({ error: "This expense was just changed by someone else. Please refresh and try again." });
      return;
    }

    res.status(200).json({ ok: true, expense: serializeExpense(updated) });
  } catch (err) {
    console.error("Admin expense update failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not save this expense." });
  }
}

// GET ?view=expense-audit&expenseId=... — one expense's full change
// history, oldest first (a readable timeline). Entirely read-only; every
// row here was written by the database trigger, never by this handler.
async function handleExpenseAuditLog(req, res, supabase) {
  const expenseId = typeof req.query.expenseId === "string" ? req.query.expenseId.trim() : "";
  if (!expenseId) {
    res.status(400).json({ error: "expenseId is required." });
    return;
  }
  try {
    const { data, error } = await supabase
      .from("expense_audit_log")
      .select("id, changed_at, changed_by, change_type, field_name, old_value, new_value")
      .eq("expense_id", expenseId)
      .order("changed_at", { ascending: true });
    if (error) throw error;
    const history = (data || []).map(function (h) {
      return {
        id: h.id,
        changedAt: h.changed_at,
        changedBy: h.changed_by,
        changeType: h.change_type,
        fieldName: h.field_name,
        fieldLabel: EXPENSE_AUDIT_FIELD_LABELS[h.field_name] || h.field_name,
        oldValue: h.old_value,
        newValue: h.new_value,
      };
    });
    res.status(200).json({ ok: true, history: history });
  } catch (err) {
    console.error("Admin expense audit log failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load this expense's history." });
  }
}

const EXPENSE_AUDIT_FIELD_LABELS = {
  expense_date: "Date",
  category: "Category",
  amount: "Amount",
  note: "Note",
  vendor: "Vendor",
  payment_method: "Payment Method",
  booking_id: "Linked Job",
  receipt_reference: "Receipt Reference",
  voided_reason: "Void Reason",
};

// GET ?view=job-search&q=... — the small "link to a job" picker the
// Expenses page's job-link field uses. Searches customers by name/phone
// (same bounded multi-field ilike pattern as api/admin/clients.js), then
// returns each match's recent bookings, newest first, capped generously —
// this is a lightweight picker, not a full booking search.
async function handleJobSearch(req, res, supabase) {
  const q = sanitizeIlikeSearchTerm(typeof req.query.q === "string" ? req.query.q : "");
  if (!q || q.length < 2) {
    res.status(200).json({ ok: true, jobs: [] });
    return;
  }
  try {
    const pattern = "%" + q + "%";
    const cols = "id, first_name, last_name, phone";
    const [byFirst, byLast, byPhone] = await Promise.all([
      supabase.from("customers").select(cols).ilike("first_name", pattern).limit(JOB_SEARCH_CUSTOMER_LIMIT),
      supabase.from("customers").select(cols).ilike("last_name", pattern).limit(JOB_SEARCH_CUSTOMER_LIMIT),
      supabase.from("customers").select(cols).ilike("phone", pattern).limit(JOB_SEARCH_CUSTOMER_LIMIT),
    ]);
    for (const r of [byFirst, byLast, byPhone]) {
      if (r.error) throw r.error;
    }
    const customersById = new Map();
    [byFirst, byLast, byPhone].forEach((r) => (r.data || []).forEach((c) => customersById.set(c.id, c)));
    const customerIds = Array.from(customersById.keys());
    if (!customerIds.length) {
      res.status(200).json({ ok: true, jobs: [] });
      return;
    }

    const bookingsRes = await supabase
      .from("bookings")
      .select("id, appointment_date, service_type, customer_id")
      .in("customer_id", customerIds)
      .order("appointment_date", { ascending: false })
      .limit(JOB_SEARCH_RESULT_LIMIT);
    if (bookingsRes.error) throw bookingsRes.error;

    const jobs = (bookingsRes.data || []).map(function (b) {
      const cust = customersById.get(b.customer_id);
      const name = cust ? [cust.first_name, cust.last_name].filter(Boolean).join(" ") : "";
      return {
        id: b.id,
        label: (name || "Job") + " — " + b.appointment_date + " — " + serviceLabel(b.service_type),
        appointmentDate: b.appointment_date,
      };
    });
    res.status(200).json({ ok: true, jobs: jobs });
  } catch (err) {
    console.error("Admin job search failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not search jobs." });
  }
}
const JOB_SEARCH_CUSTOMER_LIMIT = 100;
const JOB_SEARCH_RESULT_LIMIT = 25;

// Strips control characters, trims, caps length, then escapes ILIKE
// wildcard characters — same discipline as api/admin/clients.js's own
// sanitizeSearchTerm(), a small deliberate local copy rather than a shared
// import (this project's established convention).
function sanitizeIlikeSearchTerm(value) {
  if (typeof value !== "string") return "";
  var stripped = "";
  for (var i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 31) stripped += value[i];
  }
  var capped = stripped.trim().slice(0, EXPENSE_SEARCH_MAX_LEN);
  return capped.replace(/[\\%_]/g, "\\$&");
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
