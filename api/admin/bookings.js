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
const { VALID_PAYMENT_METHODS: JOB_PAYMENT_METHODS, netCollectedFromLedgerRows, effectiveRevenue } = require("../_lib/job-payments-ledger");
const { INVOICE_SELECT_COLS, mapInvoice, deriveInvoiceStatus } = require("../_lib/invoice-helpers");
const { OTHER_REVENUE_TYPES, otherRevenueTypeLabel } = require("../_lib/other-revenue-types");
const { complimentaryReasonLabel } = require("../_lib/complimentary-reasons");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Phase 3C Stage 1: the admin Schedule (?view=schedule&range=...) also lives
// in this file rather than its own api/admin/schedule.js — see the
// countsOnly comment just below for why (the Vercel Hobby plan's 12
// Serverless Function limit). Which bookings are "on the schedule": exactly
// those whose status is booked, rental_out, or completed — the sales/lead
// lifecycle (new/contacted/quoted) has no confirmed appointment yet, and
// lost fell through, so neither belongs on an operational schedule. No
// second operational-status field is introduced for this.
// Phase 3C Stage 4: "rental_out" (a dumpster rental delivered and currently
// at the client's property) added — still an active job on the schedule,
// same as "booked", just further along the rental lifecycle
// (booked -> rental_out -> completed).
const SCHEDULABLE_STATUSES = ["booked", "rental_out", "completed"];
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
  //
  // Phase 3C Stage 6 (Batch 3): resource:"other-revenue" is a sibling
  // discriminator on this exact same POST, same reasoning — the Other
  // Revenue ledger (Metal Recycling, Resale Sales) is its own small
  // resource, not a kind of expense. Checked first so it can never be
  // swallowed by handleCreateExpense()'s own resource !== "expense" 400.
  if (req.method === "POST") {
    const postResource = req.body && typeof req.body === "object" && typeof req.body.resource === "string" ? req.body.resource.trim() : "";
    if (postResource === "other-revenue") return handleCreateOtherRevenue(req, res, session);
    return handleCreateExpense(req, res, session);
  }

  // Phase 3C Stage 3 (full Expense Management): PATCH edits or voids one
  // expense row — same `resource: "expense"` discriminator as the POST
  // above, with an `action` field distinguishing "update" (default) from
  // "void". Folded into this same file/method for the same 12-function-
  // budget reason as every other resource here (see this file's header).
  //
  // Phase 3C Stage 6 (Batch 3): resource:"other-revenue" PATCH only ever
  // voids (no "update" action exists for this ledger at all — see
  // handleVoidOtherRevenue()'s own header for why).
  // Site Improvement Agent, Phase 3 — resource:"agent-proposal" is a
  // sibling discriminator on this same PATCH: approve/reject one
  // agent_proposals row. Checked first so it can never be swallowed by
  // handlePatchExpense()'s own resource !== "expense" 400, same as
  // "other-revenue" above.
  if (req.method === "PATCH") {
    const patchResource = req.body && typeof req.body === "object" && typeof req.body.resource === "string" ? req.body.resource.trim() : "";
    if (patchResource === "other-revenue") return handleVoidOtherRevenue(req, res, session);
    if (patchResource === "agent-proposal") return handleReviewAgentProposal(req, res, session);
    return handlePatchExpense(req, res, session);
  }

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

  // Site Improvement Agent (Phase 2) — Home dashboard's "Website &
  // Marketing Activity" row. Same reasoning as google-config just above:
  // dispatched before any Supabase client exists, since this never reads
  // from Supabase at all — it reads agent/history/log.ndjson, a plain
  // git-tracked file bundled into THIS function's deployment via
  // vercel.json's functions."api/admin/bookings.js".includeFiles (the
  // agent library itself is also an ordinary `require()`, which Vercel's
  // build already traces; only the *data* file needed the explicit
  // includeFiles, since it's read via fs at runtime, not required).
  if (req.query.view === "agent-activity") {
    return handleAgentActivity(req, res);
  }

  // Site Improvement Agent, Phase 5 — the report-history list/detail
  // behind the new /admin/agent-reports/ page. Same "never touches
  // Supabase" posture as agent-activity just above (reads the same
  // git-tracked log file) — a report is read-only, so there is no
  // write-side counterpart to these two views.
  if (req.query.view === "agent-reports") {
    return handleListAgentReports(req, res);
  }
  if (req.query.view === "agent-report") {
    return handleGetAgentReport(req, res);
  }

  // Website Agent dashboard (CRM UI consolidation pass) — ?view=agent-dashboard
  // bundles everything the dedicated /admin/website-agent/ command-center
  // page needs into ONE call: overall health status, integration
  // configured-flags, cumulative telemetry counters, the latest/daily/
  // weekly run summaries, a flattened recent-activity feed, and whatever
  // real first-party search evidence the agent has actually gathered (see
  // handleAgentDashboard()'s own header below). Same "never touches
  // Supabase for a query, only checks whether it's configured" posture as
  // the CRM DATA/PROPOSAL SYNC indicators need — no new Vercel function,
  // same file that already hosts every other agent-* view.
  if (req.query.view === "agent-dashboard") {
    return handleAgentDashboard(req, res);
  }

  // Site Improvement Agent, Phase 3 — the CRM-visible, approvable list
  // behind the Home dashboard's activity row (see handleAgentActivity()
  // just above for the read-only log, and handleReviewAgentProposal()
  // below for approve/reject). This DOES need Supabase (unlike
  // agent-activity, which reads a plain file) — handled with its own
  // client fetch rather than sharing the one created just below, so this
  // branch's early-return stays self-contained like google-config/
  // agent-activity above it.
  if (req.query.view === "agent-proposals") {
    return handleListAgentProposals(req, res);
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
  // Batch 2: two more Requests-page "More" filter entries, deliberately
  // sent through this exact same ?status= param (admin/dashboard.js's pill/
  // "More" menu click handler needs zero changes to support them — it
  // already just forwards whatever data-status value was tapped) even
  // though neither is a real bookings.status value. Checked before the
  // real-status allowlist below so neither can ever collide with an actual
  // status string.
  const isArchivedFilter = requestedStatus === "archived";
  const isReviewNotSentFilter = requestedStatus === "completed_review_not_sent";
  const statusFilter =
    !isArchivedFilter && !isReviewNotSentFilter && Object.prototype.hasOwnProperty.call(STATUS_LABELS, requestedStatus) ? requestedStatus : "";

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
  // Reused as-is (zero changes) by the Other Revenue ledger's own optional
  // job-link field below.
  if (req.query.view === "job-search") {
    return handleJobSearch(req, res, supabase);
  }

  // Phase 3C Stage 6 (Batch 3): ?view=other-revenue lists Other Revenue
  // ledger rows (Metal Recycling, Resale Sales) for a bounded date range —
  // same folding reasoning as every other view= mode in this file, and the
  // same shape (list + totalAmount) as ?view=expenses so
  // admin/schedule-financials.js can fetch it the same way.
  if (req.query.view === "other-revenue") {
    return handleOtherRevenueList(req, res, supabase);
  }

  // Batch 6 (Leads consolidation): ?view=leads is the merged, READ-ONLY
  // union behind the new /admin/leads/ workspace — same folding reasoning
  // as every other view= mode in this file. See handleLeadsView() below for
  // the full contract: it never writes to bookings, customers, or leads: it
  // only reads bookings (today's unchanged website-origin pipeline) and the
  // new `leads` table (screenshot-intake/phone/manual leads) side by side,
  // tagging each row with where it actually lives so nothing is migrated.
  if (req.query.view === "leads") {
    return handleLeadsView(req, res, supabase);
  }

  // Phase 2 — ?view=invoices backs the new /admin/invoices/ list page.
  // Same folding reasoning as every other view= mode in this file. Reads
  // public.invoices (sql/2026-10-19_invoice-workflow.sql) and that same
  // ledger ?resource=job-payments already uses (job_payments) side by side
  // — never a second payment table — to compute each invoice's derived
  // display status/balance via deriveInvoiceStatus()
  // (api/_lib/invoice-helpers.js), the identical helper the invoice detail
  // endpoint in api/admin/booking.js uses, so the two pages can never
  // disagree about what status an invoice is in.
  if (req.query.view === "invoices") {
    return handleInvoicesView(req, res, supabase);
  }

  // Phase 3C Stage 4: "rental_out" is counted here too, and folded into
  // knownNonNew below, specifically so it can never inflate the derived
  // "new" lead count the Requests-page badge (admin/nav-badge.js) shows —
  // a real bug found while adding this status: "new" was originally
  // total minus exactly five known statuses, and a rental_out booking would
  // have silently fallen through into that subtraction's blind spot.
  // Batch 2: every count here excludes archived jobs (.is("archived_at",
  // null)) — these back both the Requests-page pill badges and the
  // "new" derivation below (total minus every known non-new status), so
  // an archived job must never inflate any of them, matching "archived
  // jobs do not count toward Booked or Revenue."
  // Phase 4 Stage 1: every count here must also exclude service_type =
  // "dumpster_pickup" — a rental's auto-generated pickup job is the same
  // business job as the rental, never a second one, so it must never
  // inflate any of these totals (see
  // sql/2026-10-18_phase4-stage1-dumpster-pickup-auto-job.sql's header and
  // ensurePickupBooking()'s own header in api/admin/booking.js). Each query
  // now selects service_type too (never a bare head-count) and
  // countableCount() filters+counts in JS — a plain `.neq()` at the query
  // layer would have been simpler, but this file's own offline test
  // fakes (tests/*.test.js, one independent FakeQueryBuilder per file,
  // no shared fixture) only implement the filter methods this codebase's
  // production code already used before this change; counting in JS needs
  // no new fake method anywhere.
  function countableCount(rows) {
    return (rows || []).filter(function (r) { return r.service_type !== "dumpster_pickup"; }).length;
  }

  const COUNT_QUERIES = [
    supabase.from("bookings").select("id, service_type").is("archived_at", null),
    supabase.from("bookings").select("id, service_type").eq("status", "contacted").is("archived_at", null),
    supabase.from("bookings").select("id, service_type").eq("status", "quoted").is("archived_at", null),
    supabase.from("bookings").select("id, service_type").eq("status", "booked").is("archived_at", null),
    supabase.from("bookings").select("id, service_type").eq("status", "rental_out").is("archived_at", null),
    supabase.from("bookings").select("id, service_type").eq("status", "completed").is("archived_at", null),
    supabase.from("bookings").select("id, service_type").eq("status", "lost").is("archived_at", null),
  ];

  if (countsOnly) {
    try {
      const [totalRes, contactedRes, quotedRes, bookedRes, rentalOutRes, completedRes, lostRes] = await Promise.all(COUNT_QUERIES);
      for (const r of [totalRes, contactedRes, quotedRes, bookedRes, rentalOutRes, completedRes, lostRes]) {
        if (r.error) throw r.error;
      }
      const total = countableCount(totalRes.data);
      const contactedCount = countableCount(contactedRes.data);
      const quotedCount = countableCount(quotedRes.data);
      const bookedCount = countableCount(bookedRes.data);
      const rentalOutCount = countableCount(rentalOutRes.data);
      const completedCount = countableCount(completedRes.data);
      const lostCount = countableCount(lostRes.data);
      const knownNonNew = contactedCount + quotedCount + bookedCount + rentalOutCount + completedCount + lostCount;
      const newCount = Math.max(0, total - knownNonNew);
      res.status(200).json({
        ok: true,
        summary: {
          total: total,
          new: newCount,
          contacted: contactedCount,
          quoted: quotedCount,
          booked: bookedCount,
          rentalOut: rentalOutCount,
          completed: completedCount,
          lost: lostCount,
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
    // Batch 2: the archived / completed-review-not-sent pseudo-filters each
    // page a totally different WHERE than the normal status-filtered list
    // (and than each other), so filteredTotal/hasMore below can't reuse
    // countsByStatus — this extra count-only query is only ever actually
    // run when one of those two is active; every other request keeps this
    // Promise.all at exactly the same 8 queries it always had.
    const extraCountQuery = isArchivedFilter
      ? supabase.from("bookings").select("id, service_type").not("archived_at", "is", null)
      : isReviewNotSentFilter
      ? supabase.from("bookings").select("id, service_type").eq("status", "completed").is("review_request_sent_at", null).is("archived_at", null)
      : null;

    const [totalRes, contactedRes, quotedRes, bookedRes, rentalOutRes, completedRes, lostRes, pageRes, extraCountRes] = await Promise.all([
      ...COUNT_QUERIES,
      (function () {
        // "new" IS a stored value — confirmed against production
        // (2026-10-18 schema audit): bookings.status is `NOT NULL DEFAULT
        // 'new'`, enforced by bookings_status_check alongside the other 6
        // known literals. api/book.js's junk_removal/light_demo insert
        // simply omits the column and lets that default apply; it has
        // never left the row NULL (NULL isn't even possible here — the
        // NOT NULL constraint would reject it). So a plain .eq() is
        // correct and sufficient for every one of the 7 statuses,
        // including "new" — no special-case NULL filter is needed.
        let q = supabase
          .from("bookings")
          .select(
            "id, service_type, appointment_date, time_window, exact_time, status, estimated_price, estimated_price_max, final_price, customer_id, service_city, created_at, archived_at, archived_reason, review_request_sent_at"
          )
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);
        if (isArchivedFilter) {
          q = q.not("archived_at", "is", null);
        } else if (isReviewNotSentFilter) {
          q = q.eq("status", "completed").is("review_request_sent_at", null).is("archived_at", null);
        } else {
          // Batch 2: archived jobs disappear from every normal status
          // view/filter — "All" included — matching Schedule's own
          // exclusion in fetchScheduleJobs() above.
          q = q.is("archived_at", null);
          if (statusFilter) q = q.eq("status", statusFilter);
        }
        return q;
      })(),
      extraCountQuery || Promise.resolve({ data: null, error: null }),
    ]);

    for (const r of [totalRes, contactedRes, quotedRes, bookedRes, rentalOutRes, completedRes, lostRes, pageRes, extraCountRes]) {
      if (r.error) throw r.error;
    }

    // Phase 4 Stage 1: this is the Requests/dashboard booking browser, not
    // an operational Schedule view — a rental's auto-generated pickup job
    // never belongs here as its own row (it would read as a second,
    // price-less "job" in a sales-pipeline list). It still appears
    // normally on Schedule, driven by the separate fetchScheduleJobs()/
    // handleDay/Week/Month, deliberately untouched by this exclusion.
    // Filtered after the range/pagination slice above (not in the query
    // itself — see countableCount()'s comment for why), so a page that
    // happens to include a pickup row can occasionally render fewer than
    // `limit` jobs; an acceptable tradeoff given how rare that overlap is.
    const bookings = (pageRes.data || []).filter((b) => b.service_type !== "dumpster_pickup");
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
        // Only meaningful on the Archived filter's cards; harmless/unused
        // elsewhere.
        archivedAt: b.archived_at,
        archivedReason: b.archived_reason,
        reviewRequestSentAt: b.review_request_sent_at,
      };
    });

    const total = countableCount(totalRes.data);
    const contactedCount = countableCount(contactedRes.data);
    const quotedCount = countableCount(quotedRes.data);
    const bookedCount = countableCount(bookedRes.data);
    const rentalOutCount = countableCount(rentalOutRes.data);
    const completedCount = countableCount(completedRes.data);
    const lostCount = countableCount(lostRes.data);
    const knownNonNew = contactedCount + quotedCount + bookedCount + rentalOutCount + completedCount + lostCount;
    const newCount = Math.max(0, total - knownNonNew);

    // Pagination ("hasMore") must be judged against the count of whatever
    // set is actually being paged through — the global total when no
    // filter is applied, or the matching status's own count when one is.
    // Every value here was already computed above for the summary, so this
    // needs no extra query. Keyed by the raw status string (rental_out),
    // matching how statusFilter itself is stored — unlike the summary JSON
    // below, which uses rentalOut for consistency with this file's other
    // camelCase field names.
    const countsByStatus = {
      new: newCount,
      contacted: contactedCount,
      quoted: quotedCount,
      booked: bookedCount,
      rental_out: rentalOutCount,
      completed: completedCount,
      lost: lostCount,
    };
    const filteredTotal = isArchivedFilter || isReviewNotSentFilter ? countableCount(extraCountRes.data) : statusFilter ? countsByStatus[statusFilter] : total;

    res.status(200).json({
      ok: true,
      summary: {
        total: total,
        new: newCount,
        contacted: contactedCount,
        quoted: quotedCount,
        booked: bookedCount,
        rentalOut: rentalOutCount,
        completed: completedCount,
        lost: lostCount,
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
// Site Improvement Agent (Phase 2) — ?view=agent-activity
//
// A compact ACTIVITY VIEW, not an SEO analytics dashboard: returns only
// {icon, text} lines per recent run (agent/lib/history.js's
// buildDashboardSummary()), never the full findings/evidence/research
// payload that lives in the log file itself. `connected: false` (with no
// `recent`) is what admin/home.js falls back to its existing "Not
// connected yet" pill for — the log file not existing yet (or existing
// but genuinely empty) is a real, honest state, not an error.
// ---------------------------------------------------------------------
function handleAgentActivity(req, res) {
  let history;
  try {
    history = require("../../agent/lib/history");
  } catch (e) {
    console.error("Admin agent-activity: agent/lib/history.js not available in this deployment", e);
    res.status(200).json({ ok: true, connected: false, recent: [] });
    return;
  }

  // Phase 4 hardening — one try/catch around EVERYTHING past the
  // require() above, not just the file read: a structurally-valid JSON
  // line missing an expected field (e.g. a future schema change, or a
  // hand-edited log) could still throw inside buildDashboardSummary()
  // itself, not just inside readAllRuns()'s own parse step. Any failure
  // anywhere in this path falls back to the exact same honest
  // "not connected" response — this subsystem must never be able to
  // 500 the Home dashboard, no matter how it fails.
  try {
    const runs = history.readAllRuns();
    if (!runs.length) {
      res.status(200).json({ ok: true, connected: false, recent: [] });
      return;
    }
    const recent = history.buildDashboardSummary(runs, 5);
    // Phase 5 — the richer Home card (see agent/README.md's "CRM Home"
    // section): a compact `latest` summary built from the most recent
    // run's own persisted `report` (see agent/lib/report.js), when
    // present. Older log entries (recorded before Phase 5) have no
    // `report` field — `latest` is simply omitted for those, and the
    // Home card falls back to its pre-existing `recent[0].lines`
    // rendering, exactly as it already does today. Never thrown: a
    // missing/malformed report degrades to `latest: null`.
    let latest = null;
    try {
      // Phase 5B — dedupe by runId first (see history.latestByRunId()'s
      // header) so a run still awaiting research never gets superseded
      // by, or confusingly shown alongside, its own later "completed"
      // line once resumed.
      const sorted = history.latestByRunId(runs).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const mostRecent = sorted[0];
      if (mostRecent && mostRecent.report) {
        const r = mostRecent.report;
        latest = {
          runId: r.runId,
          timestamp: r.timestamp,
          runType: r.runType,
          status: r.status,
          pagesChecked: r.pagesChecked,
          healthSummary: r.healthSummary,
          safeFixesAppliedCount: r.safeFixes ? r.safeFixes.appliedCount : 0,
          researchQuestionsRaisedCount: r.research ? r.research.questionsRaisedCount : 0,
          proposalsAwaitingApprovalCount: r.proposals ? r.proposals.awaitingApprovalCount : 0,
        };
      }
    } catch (e) {
      latest = null;
    }
    res.status(200).json({ ok: true, connected: true, recent, latest });
  } catch (e) {
    console.error("Admin agent-activity failed to read/summarize agent/history/log.ndjson", e);
    res.status(200).json({ ok: true, connected: false, recent: [] });
  }
}

// ---------------------------------------------------------------------
// Site Improvement Agent, Phase 5 — ?view=agent-reports (list) and
// ?view=agent-report&runId=... (one report's full detail). Both read
// ONLY agent/history/log.ndjson (same file/require path as
// handleAgentActivity above) — never Supabase — and never return the
// full per-finding `evidence`/`research` payload in the LIST response
// (that would defeat the point of a compact history list); the DETAIL
// response does include each finding's full shape, for the one report a
// reviewer actually opened.
// ---------------------------------------------------------------------
function loadAgentHistoryModule(res) {
  try {
    return require("../../agent/lib/history");
  } catch (e) {
    console.error("Admin agent-reports: agent/lib/history.js not available in this deployment", e);
    res.status(200).json({ ok: true, connected: false, reports: [] });
    return null;
  }
}

function reportListEntry(run) {
  const report = run.report || null;
  return {
    runId: run.runId,
    timestamp: run.timestamp,
    runType: (report && report.runType) || run.runType || "manual",
    mode: run.mode,
    failed: Boolean(run.failed),
    // Phase 5B — the explicit run-status lifecycle (see
    // agent/lib/report.js's header): "completed" | "research_pending" |
    // "failed". Falls back to the old failed/all-clear-only inference
    // for a pre-Phase-5B record with no `report.status` at all.
    status: report ? report.status : run.failed ? "failed" : "completed",
    healthSummary: report ? report.healthSummary : null,
    pagesChecked: report ? report.pagesChecked : run.summary && run.summary.pagesScanned,
    proposalsAwaitingApprovalCount: report && report.proposals ? report.proposals.awaitingApprovalCount : 0,
    // Phase 5B — for the list row's SHORT outcome label (e.g. "2
    // Pending"), distinct from healthSummary.text's full sentence (which
    // is for the detail view / Home card only — a full sentence does not
    // fit a pill-shaped badge, especially on a narrow screen; see
    // admin/agent-reports.js's outcomeLabel()).
    researchQuestionsPendingCount: report && report.research ? report.research.questionsRaisedCount : 0,
    safeFixesAppliedCount: report && report.safeFixes ? report.safeFixes.appliedCount : 0,
  };
}

// Phase 5B — both views now dedupe by runId (history.latestByRunId())
// BEFORE sorting/filtering, so a run that needed research (an initial
// `research_pending` line, later superseded by a `completed`/`failed`
// line once resumed — see runner.js's `resumeRunId`) is shown as ONE
// report in its current state, never as two confusing "before research"/
// "after research" entries. See history.js's own header for why this is
// a read-time dedup rather than ever rewriting the append-only log.
function handleListAgentReports(req, res) {
  const history = loadAgentHistoryModule(res);
  if (!history) return;
  try {
    const runs = history.latestByRunId(history.readAllRuns());
    const sorted = [...runs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    res.status(200).json({ ok: true, connected: true, reports: sorted.slice(0, limit).map(reportListEntry) });
  } catch (e) {
    console.error("Admin agent-reports list failed to read agent/history/log.ndjson", e);
    res.status(200).json({ ok: true, connected: false, reports: [] });
  }
}

function handleGetAgentReport(req, res) {
  const history = loadAgentHistoryModule(res);
  if (!history) return;
  const runId = typeof req.query.runId === "string" ? req.query.runId.trim() : "";
  if (!runId) {
    res.status(400).json({ error: "A runId is required." });
    return;
  }
  try {
    // The single CURRENT state for this runId — if it was resumed after
    // research, this is the finalized (completed/failed) line, not the
    // superseded research_pending one.
    const current = history.latestByRunId(history.readAllRuns()).find((r) => r.runId === runId);
    if (!current) {
      res.status(404).json({ error: "Report not found." });
      return;
    }
    res.status(200).json({ ok: true, run: current });
  } catch (e) {
    console.error("Admin agent-report detail failed to read agent/history/log.ndjson", e);
    res.status(500).json({ error: "Could not load this report." });
  }
}

// ---------------------------------------------------------------------
// Website Agent dashboard — ?view=agent-dashboard
//
// A UI-consolidation endpoint, not a new subsystem: everything below is
// read straight from agent/history/log.ndjson (same file/require path as
// agent-activity/agent-reports above) or is a pure env-var "is this
// integration configured" check (no network call, no secret ever
// returned) — see agent/lib/search-console-client.js's/
// agent/lib/ga4-client.js's own isXConfigured(). Nothing here changes
// Agent decision logic, and nothing here queries Supabase (the one
// Supabase-backed number this page needs — live "needs review" proposal
// count — is read client-side from the existing ?view=agent-proposals
// response, not duplicated here).
//
// `metrics` are cumulative counters over the ENTIRE persisted run history
// (deduped by runId — see history.latestByRunId()), i.e. real totals this
// agent has actually recorded, never an invented score. `pagesMonitored`
// is the one exception: a snapshot of the MOST RECENT run's page count,
// since "pages monitored" doesn't make sense as a running sum.
// Audit fix — GSC/GA4's status used to be isSearchConsoleConfigured()/
// isGa4Configured() (plain env-var presence) evaluated HERE, inside this
// Vercel function. But those five env vars are, by this project's own
// documented design, never provisioned to Vercel — only to the GitHub
// Actions runner that actually runs the Agent CLI (see agent/README.md's
// "Vercel / DB impact" section) — so that check could never render
// anything but NOT CONFIGURED here, regardless of whether the real
// GitHub Actions -> WIF -> Google API path is actually working, and a
// credential that's present but broken would misleadingly render as
// CONNECTED (presence-only, no API call). This now reads
// agent/history/integration-health.json instead — a REAL probe result
// the GitHub Actions runner's new `--check-integrations` step writes
// (see agent/lib/integration-health.js's header) — the same cross-
// process-boundary pattern this dashboard already uses for every other
// number on this page (agent/history/log.ndjson).
//
// STALE_AFTER_MS: the daily scheduled run (plus weekly) refreshes this
// file roughly once a day; 36h gives one day's slack before a GOOD
// LAST READING stops being trusted as still-current — distinct from
// ERROR, which is never time-gated (a recorded failure is a failure
// regardless of how long ago it was recorded).
const INTEGRATION_HEALTH_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

function classifyIntegrationHealth(entry, checkedAt, now) {
  if (!entry || entry.configured === false) return { state: "not_configured", reason: null, checkedAt: checkedAt || null };
  if (entry.ok === false) return { state: "error", reason: entry.reason || null, checkedAt: checkedAt || null };
  const isStale = checkedAt ? now.getTime() - new Date(checkedAt).getTime() > INTEGRATION_HEALTH_STALE_AFTER_MS : true;
  return { state: isStale ? "stale" : "connected", reason: null, checkedAt: checkedAt || null };
}

function handleAgentDashboard(req, res) {
  const history = loadAgentHistoryModule(res);
  if (!history) return;

  let integrationHealth = null;
  try {
    integrationHealth = require("../../agent/lib/integration-health").loadIntegrationHealth();
  } catch (e) {
    integrationHealth = null;
  }
  const now = new Date();
  const searchConsoleStatus = classifyIntegrationHealth(integrationHealth && integrationHealth.gsc, integrationHealth && integrationHealth.at, now);
  const ga4Status = classifyIntegrationHealth(integrationHealth && integrationHealth.ga4, integrationHealth && integrationHealth.at, now);
  // Plain env-var presence check — deliberately NOT getServiceClient()
  // (which constructs a real @supabase/supabase-js client): this view
  // must never touch Supabase at all, same hard rule as agent-activity/
  // agent-reports above (see this function's header) — CRM DATA/PROPOSAL
  // SYNC both ultimately depend on these same two credentials being
  // configured, so one shared check is the honest answer for both. Unlike
  // GSC/GA4 above, these ARE read directly by this Vercel function every
  // other time it touches Supabase, so a presence check here is genuinely
  // informative, not a check against a credential this process never sees.
  const supabaseConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);

  try {
    const allRuns = history.readAllRuns();
    if (!allRuns.length) {
      res.status(200).json({
        ok: true,
        connected: false,
        status: "not-connected",
        integrations: { gsc: searchConsoleStatus, ga4: ga4Status, crmData: supabaseConfigured, proposalSync: supabaseConfigured },
        metrics: null,
        latestRun: null,
        daily: { lastRun: null },
        weekly: { lastRun: null },
        activity: [],
        searchIntelligence: { searchConsole: { available: false }, ga4: { available: false } },
      });
      return;
    }

    const deduped = history.latestByRunId(allRuns);
    const sorted = [...deduped].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const latestRun = sorted[0];
    const latestDaily = sorted.find((r) => dashboardRunType(r) === "daily") || null;
    const latestWeekly = sorted.find((r) => dashboardRunType(r) === "weekly") || null;

    let findingsTotal = 0;
    let changesAppliedTotal = 0;
    let researchCompletedTotal = 0;
    let noChangeDecisionsTotal = 0;
    for (const run of deduped) {
      const findings = Array.isArray(run.findings) ? run.findings : [];
      findingsTotal += findings.length;
      changesAppliedTotal += findings.filter((f) => f.status === "applied").length;
      researchCompletedTotal += findings.filter((f) => Array.isArray(f.research) && f.research.length > 0).length;
      noChangeDecisionsTotal += findings.filter((f) => f.decision === "NO_CHANGE").length;
    }

    const latestSummary = dashboardRunSummary(latestRun);

    res.status(200).json({
      ok: true,
      connected: true,
      status: dashboardOverallStatus(latestSummary),
      integrations: { gsc: searchConsoleStatus, ga4: ga4Status, crmData: supabaseConfigured, proposalSync: supabaseConfigured },
      metrics: {
        pagesMonitored: latestSummary.pagesChecked,
        findingsTotal,
        changesAppliedTotal,
        researchCompletedTotal,
        noChangeDecisionsTotal,
        runsRecorded: deduped.length,
      },
      latestRun: latestSummary,
      daily: { lastRun: dashboardRunSummary(latestDaily) },
      weekly: { lastRun: dashboardRunSummary(latestWeekly) },
      activity: dashboardActivityFeed(sorted),
      searchIntelligence: {
        searchConsole: dashboardSearchIntelligence(sorted, "search-console-search-analytics"),
        ga4: dashboardSearchIntelligence(sorted, "ga4"),
      },
    });
  } catch (e) {
    console.error("Admin agent-dashboard failed to read/summarize agent/history/log.ndjson", e);
    res.status(200).json({
      ok: true,
      connected: false,
      status: "unknown",
      integrations: { gsc: searchConsoleStatus, ga4: ga4Status, crmData: supabaseConfigured, proposalSync: supabaseConfigured },
      metrics: null,
      latestRun: null,
      daily: { lastRun: null },
      weekly: { lastRun: null },
      activity: [],
      searchIntelligence: { searchConsole: { available: false }, ga4: { available: false } },
    });
  }
}

function dashboardRunType(run) {
  return (run.report && run.report.runType) || run.runType || "manual";
}

// A compact, UI-ready summary of one run — same spirit as reportListEntry()
// above (list view), plus the few extra counts the dashboard's Latest
// Run / Daily / Weekly panels show (observations/opportunities/proposals
// created). Degrades to nulls for a pre-Phase-5 record with no `report`.
function dashboardRunSummary(run) {
  if (!run) return null;
  const report = run.report || null;
  return {
    runId: run.runId,
    timestamp: run.timestamp,
    runType: dashboardRunType(run),
    failed: Boolean(run.failed),
    status: report ? report.status : run.failed ? "failed" : "completed",
    healthSummary: report ? report.healthSummary : null,
    pagesChecked: report ? report.pagesChecked : run.summary && typeof run.summary.pagesScanned === "number" ? run.summary.pagesScanned : null,
    observationsCount: report ? report.observationsCount : null,
    opportunitiesCount: report ? report.opportunitiesCount : null,
    actionableOpenCount: report ? report.technicalIssues.actionableOpen : null,
    safeFixesAppliedCount: report && report.safeFixes ? report.safeFixes.appliedCount : 0,
    researchQuestionsRaisedCount: report && report.research ? report.research.questionsRaisedCount : 0,
    proposalsCreatedOrUpdatedCount: report && report.proposals ? report.proposals.createdOrUpdatedCount : 0,
    proposalsAwaitingApprovalCount: report && report.proposals ? report.proposals.awaitingApprovalCount : 0,
    failureMessage: report && report.failure ? report.failure.message : null,
  };
}

function dashboardOverallStatus(latestSummary) {
  if (!latestSummary) return "unknown";
  if (latestSummary.failed) return "failed";
  const s = latestSummary.healthSummary && latestSummary.healthSummary.status;
  if (s === "failed") return "failed";
  if (s === "research-pending") return "research-pending";
  if (s === "needs-attention") return "needs-attention";
  if (s === "all-clear") return "healthy";
  return "unknown";
}

// Flattens the most recent runs into one chronological event feed — a
// "SCAN COMPLETE" line per run plus one line per finding worth surfacing
// (reusing agent/lib/history.js's own icon/description logic, the exact
// same text already shown on Home/report-history, never re-derived
// differently here), newest first. Approve/reject events are NOT included
// here (those live in Supabase's agent_proposals, not this log) — the
// dashboard page merges those in client-side from its own
// ?view=agent-proposals fetch. Capped to a sane number of runs so one very
// old, very noisy run can't dominate the feed.
const DASHBOARD_ACTIVITY_RUN_LIMIT = 12;
function dashboardActivityFeed(sortedRuns) {
  const historyLib = require("../../agent/lib/history");
  const events = [];
  for (const run of sortedRuns.slice(0, DASHBOARD_ACTIVITY_RUN_LIMIT)) {
    const pagesScanned = run.summary && typeof run.summary.pagesScanned === "number" ? run.summary.pagesScanned : null;
    events.push({
      runId: run.runId,
      timestamp: run.timestamp,
      type: run.failed ? "error" : "scan-complete",
      label: run.failed ? "ERROR" : "SCAN COMPLETE",
      text: run.failed
        ? (run.report && run.report.failure && run.report.failure.message) || "This run did not complete successfully."
        : pagesScanned !== null
        ? `Checked ${pagesScanned} page${pagesScanned === 1 ? "" : "s"}`
        : "Run completed.",
    });
    const findings = Array.isArray(run.findings) ? run.findings : [];
    for (const f of findings) {
      events.push({
        runId: run.runId,
        timestamp: run.timestamp,
        type: ACTIVITY_TYPE_BY_ICON[historyLib.iconForFinding(f)] || "observation",
        label: ACTIVITY_LABEL_BY_ICON[historyLib.iconForFinding(f)] || "OBSERVATION",
        text: f.summary || historyLib.describeFinding(f),
      });
    }
  }
  return events;
}

const ACTIVITY_LABEL_BY_ICON = {
  check: "SAFE FIX",
  flag: "PROPOSAL",
  research: "RESEARCH",
  reject: "REJECTED",
  observation: "OBSERVATION",
};
const ACTIVITY_TYPE_BY_ICON = {
  check: "safe-fix",
  flag: "proposal",
  research: "research",
  reject: "rejected",
  observation: "observation",
};

// Most recent real, persisted first-party evidence entry of the given
// source found anywhere in a finding's `.firstPartyEvidence[]` (attached
// by agent/lib/firstparty-intake.js — see that file's header), scanning
// the most recent runs only (never a full-history crawl). Returns an
// honest {available:false} when nothing has ever been gathered — never a
// fabricated chart.
const DASHBOARD_EVIDENCE_SCAN_RUN_LIMIT = 20;
function dashboardSearchIntelligence(sortedRuns, source) {
  const { computeFirstPartyFreshness } = require("../../agent/lib/firstparty-evidence");
  for (const run of sortedRuns.slice(0, DASHBOARD_EVIDENCE_SCAN_RUN_LIMIT)) {
    const findings = Array.isArray(run.findings) ? run.findings : [];
    for (const f of findings) {
      const entries = Array.isArray(f.firstPartyEvidence) ? f.firstPartyEvidence : [];
      const match = entries.find((e) => e.source === source);
      if (match) {
        return {
          available: true,
          runId: run.runId,
          gatheredAt: match.fetchedAt,
          freshness: computeFirstPartyFreshness(match, new Date()).status,
          metric: match.metric,
          dimension: match.dimension,
          scope: match.scope,
          window: match.window,
          context: match.context,
          limitations: match.limitations,
          rows: match.observed && Array.isArray(match.observed.topRows) ? match.observed.topRows : [],
        };
      }
    }
  }
  return { available: false };
}

// ---------------------------------------------------------------------
// Site Improvement Agent, Phase 3 — ?view=agent-proposals (list) and
// resource:"agent-proposal" PATCH (approve/reject). agent_proposals (see
// sql/2026-10-12_phase3-agent-proposals.sql) is the live, CRM-mutable
// counterpart to the read-only agent/history/log.ndjson: synced to by
// agent/lib/proposals-sync.js after a run, read/written here. Approving
// or rejecting a proposal changes ONLY that one row — it is never a
// grant of broader authority, and never itself executes any website
// change (meaningful content changes stay human-executed even once
// approved; only the existing narrow mechanical-fix whitelist is ever
// auto-applied, by the unrelated --apply-safe runner path).
// ---------------------------------------------------------------------
const AGENT_PROPOSAL_STATUSES = ["proposed", "approved", "rejected", "applied", "validated", "failed"];
const AGENT_PROPOSAL_REVIEW_NOTE_MAX = 500;
const AGENT_PROPOSAL_SELECT =
  "id, finding_key, finding_type, category, risk_level, decision, decision_reason, summary, pages, evidence, research, status, reviewed_by, reviewed_at, review_note, last_run_id, created_at, updated_at";

function mapAgentProposal(row, options = {}) {
  return {
    id: row.id,
    findingKey: row.finding_key,
    findingType: row.finding_type,
    category: row.category,
    riskLevel: row.risk_level,
    decision: row.decision,
    decisionReason: row.decision_reason,
    summary: row.summary,
    pages: row.pages,
    evidence: row.evidence,
    research: row.research,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    lastRunId: row.last_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Pre-acceptance hardening (audit finding #4, baseline 2bff317) —
    // see currentOwnerReviewKeys() below for exactly what this means and
    // why it's computed fresh at READ time rather than stored on the row
    // itself. `false` whenever staleness genuinely could not be
    // determined (see that function's own fail-safe behavior) — a
    // proposal is never labeled stale on insufficient information.
    stale: Boolean(options.stale),
  };
}

// Pre-acceptance hardening (audit finding #4) — "an approved/proposed/
// rejected proposal must not remain apparently active indefinitely once
// its underlying finding no longer needs owner review" (NO_CHANGE,
// RESEARCH_MORE, APPLY_SAFE_FIX, or the finding simply stopped being
// produced at all). Rather than a new persisted `agent_proposals.status`
// value — which would require a CHECK-constraint migration (see
// sql/2026-10-12_phase3-agent-proposals.sql's `status` column) — this is
// a PURE, DERIVED, read-time annotation: never written back to the DB,
// never changes what `status` means, computed fresh on every list
// request from whatever the most recent Agent run actually decided
// (agent/history/log.ndjson — the same file agent-activity/agent-reports
// above already read this way). A row the agent hasn't touched in a
// while (because its finding genuinely still needs review) stays
// correctly non-stale; only a finding_key that's absent from the LATEST
// run's own owner-review set (proposals-sync.js's needsOwnerReview())
// is flagged.
//
// Fails safe in every direction: if history can't be read at all, or
// there's no run yet, returns `null` (not an empty Set) — the caller
// must treat `null` as "unknown, nothing is stale" (see
// handleListAgentProposals() below), never as "everything is stale."
function currentOwnerReviewKeys() {
  try {
    const history = require("../../agent/lib/history");
    const { needsOwnerReview } = require("../../agent/lib/proposals-sync");
    const runs = history.latestByRunId(history.readAllRuns());
    if (!runs.length) return null;
    const latest = [...runs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    const findings = Array.isArray(latest.findings) ? latest.findings : [];
    return new Set(findings.filter(needsOwnerReview).map((f) => f.key));
  } catch (e) {
    return null;
  }
}

async function handleListAgentProposals(req, res) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin agent-proposals list failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  // Optional filter — e.g. the Home dashboard asking only for proposals
  // still awaiting a decision, vs. the full review page showing
  // everything. Any value outside the known set is ignored (treated as
  // "no filter"), same convention as bookings' own ?status= filter.
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const filterByStatus = AGENT_PROPOSAL_STATUSES.includes(status);

  try {
    let query = supabase.from("agent_proposals").select(AGENT_PROPOSAL_SELECT).order("created_at", { ascending: false }).limit(100);
    if (filterByStatus) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;

    // Pre-acceptance hardening (audit finding #4) — `null` means
    // "unknown" (history unreadable or no run yet): every row's `stale`
    // stays false in that case, never guessed true.
    const reviewKeys = currentOwnerReviewKeys();
    const proposals = (data || []).map((row) => {
      const stillActive = row.status === "proposed" || row.status === "approved" || row.status === "rejected";
      const stale = stillActive && reviewKeys !== null && !reviewKeys.has(row.finding_key);
      return mapAgentProposal(row, { stale });
    });

    res.status(200).json({ ok: true, proposals });
  } catch (err) {
    console.error("Admin agent-proposals list failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Admin data is not available right now." });
  }
}

// PATCH body: { resource: "agent-proposal", id, action: "approve"|"reject", note }
async function handleReviewAgentProposal(req, res, session) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin agent-proposal review failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";
  const note = sanitizeExpenseText(body.note, AGENT_PROPOSAL_REVIEW_NOTE_MAX) || null;

  if (!id) {
    res.status(400).json({ error: "A proposal id is required." });
    return;
  }
  if (action !== "approve" && action !== "reject") {
    res.status(400).json({ error: "action must be 'approve' or 'reject'." });
    return;
  }

  try {
    // A fresh read first (rather than a blind update) so a proposal that
    // was already reviewed, or no longer exists, gets an honest response
    // instead of silently "succeeding" against nothing.
    const currentRes = await supabase.from("agent_proposals").select("id, status").eq("id", id).maybeSingle();
    if (currentRes.error) throw currentRes.error;
    if (!currentRes.data) {
      res.status(404).json({ error: "Proposal not found." });
      return;
    }

    const newStatus = action === "approve" ? "approved" : "rejected";
    // The literal update payload, built here — never the request body —
    // same mass-assignment discipline every other admin write endpoint
    // in this project already follows. This can only ever move a
    // proposal between review states for THIS ONE finding_key; it never
    // touches finding_type/category/pages/evidence/research (those are
    // sync-owned, see proposals-sync.js) and never executes any action
    // beyond recording the owner's decision.
    const { data, error } = await supabase
      .from("agent_proposals")
      .update({
        status: newStatus,
        reviewed_by: session.email,
        reviewed_at: new Date().toISOString(),
        review_note: note,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select(AGENT_PROPOSAL_SELECT)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "Proposal not found." });
      return;
    }

    res.status(200).json({ ok: true, proposal: mapAgentProposal(data) });
  } catch (err) {
    console.error("Admin agent-proposal review failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not save this review." });
  }
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
    // Estimate workflow — merged in as a sibling `estimates` array (never
    // mixed into `jobs` itself, so every existing caller/test reading
    // `jobs` is completely unaffected). See fetchScheduleEstimates()'s own
    // header for why Month/Year don't get this.
    const estimates = beforeHistoricalFloor ? [] : await fetchScheduleEstimates(supabase, startDate, endDate);
    const body = { ok: true, range: range, startDate: startDate, endDate: endDate, jobs: jobs, estimates: estimates, today: todayIso };
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
    const estimates = await fetchScheduleEstimates(supabase, dateRaw, dateRaw);
    res.status(200).json({ ok: true, range: "day", startDate: dateRaw, endDate: dateRaw, jobs: jobs, estimates: estimates, today: todayIso });
  } catch (err) {
    console.error("Admin day schedule failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load that date." });
  }
}

// Estimate workflow — the Schedule's own estimates for a bounded date
// range, fetched and merged alongside fetchScheduleJobs()'s bookings so
// Today/Tomorrow/Yesterday/a day-nav date can show both side by side (see
// admin/schedule.js's renderEstimateCard()). Deliberately NOT called by
// handleMonth()/handleYear() in this pass — those render a different,
// compact job-count-only view; estimates there is tracked as a known
// follow-up, not built in this pass (see the final report). Only
// "scheduled" and "completed" estimates are returned — a cancelled, lost,
// or converted estimate has nothing useful to show on a day view going
// forward (a converted estimate's resulting JOB is what shows instead).
// Never read by any revenue/booked counter — estimates carry no final
// price/payment/tip concept at all, only an optional, purely informational
// quotedAmount.
async function fetchScheduleEstimates(supabase, startDate, endDate) {
  const estimatesRes = await supabase
    .from("estimates")
    .select(
      "id, status, customer_id, service_type, appointment_date, time_window, exact_time, service_address, service_city, service_state, service_zip, quoted_amount, source_lead_id"
    )
    .in("status", ["scheduled", "completed"])
    .gte("appointment_date", startDate)
    .lte("appointment_date", endDate);
  if (estimatesRes.error) throw estimatesRes.error;

  const estimates = estimatesRes.data || [];
  const customerIds = Array.from(new Set(estimates.map((e) => e.customer_id).filter(Boolean)));
  const customersById = {};
  if (customerIds.length) {
    const custRes = await supabase.from("customers").select("id, first_name, last_name, phone, city").in("id", customerIds);
    if (custRes.error) throw custRes.error;
    (custRes.data || []).forEach((c) => {
      customersById[c.id] = c;
    });
  }

  const items = estimates.map((e) => {
    const customer = customersById[e.customer_id] || null;
    return {
      id: e.id,
      status: e.status,
      serviceType: e.service_type,
      serviceLabel: e.service_type ? serviceLabel(e.service_type) : null,
      appointmentDate: e.appointment_date,
      timeWindow: e.time_window,
      timeWindowLabel: timeWindowLabel(e.time_window),
      exactTime: e.exact_time,
      timeLabel: effectiveTimeLabel(e.time_window, e.exact_time),
      quotedAmount: e.quoted_amount,
      sourceLeadId: e.source_lead_id,
      customer: customer ? { firstName: customer.first_name, lastName: customer.last_name, phone: customer.phone } : null,
      serviceAddress: {
        address: e.service_address || null,
        city: e.service_city || (customer && customer.city) || null,
        state: e.service_state || null,
        zip: e.service_zip || null,
      },
    };
  });

  // Same chronological ordering as fetchScheduleJobs() — appointment date
  // first, then time-of-day via the shared effective-minute lookup.
  items.sort(function (a, b) {
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

  return items;
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
      "id, service_type, appointment_date, time_window, exact_time, status, estimated_price, estimated_price_max, final_price, is_complimentary, complimentary_value, complimentary_reason, complimentary_note, customer_id, service_address, service_city, service_state, service_zip"
    )
    .in("status", SCHEDULABLE_STATUSES)
    .gte("appointment_date", startDate)
    .lte("appointment_date", endDate)
    // Batch 2: archived jobs disappear from every active Schedule view —
    // this one query backs Today/Tomorrow/Yesterday/Day/Week/Month, so
    // excluding it here is the single point of truth for all of them (and,
    // transitively, for admin/schedule-financials.js's Revenue/Booked
    // counters, which are computed client-side from exactly this response).
    .is("archived_at", null);
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

  // Dashboard Revenue audit fix — Day/Week/Month/Home all render from this
  // one `jobs` array (admin/schedule-financials.js, admin/home.js), so
  // computing the ledger-authoritative amount HERE, once, is what makes
  // every dashboard surface agree with each other and with the booking-
  // detail/closeout page and Invoices list, which already trust
  // effectiveRevenue()/job_payments over a hand-typed final_price snapshot
  // (see api/_lib/job-payments-ledger.js's own header for the rule: "if
  // this booking has any non-voided job_payments rows, the ledger total is
  // authoritative"). Scoped to completed, non-pickup bookings only — a
  // booked/rental_out job's dollar figure is still its estimated_price
  // (Booked, not Revenue), and a dumpster_pickup helper leg never carries
  // price fields at all. Keyed by booking_id (not invoice_id), so this
  // naturally includes every kind of payment row — generic/legacy,
  // invoice-attributed manual, and Stripe-mirrored alike — with no separate
  // invoice-total addition anywhere in this file, so nothing here can ever
  // double-count a payment that's also reflected in an invoice's own
  // balance (computed independently, by invoice_id, in invoice-helpers.js).
  const completedBookingIds = bookings.filter((b) => normalizedStatus(b.status) === "completed" && b.service_type !== "dumpster_pickup").map((b) => b.id);
  const ledgerRowsByBooking = {};
  if (completedBookingIds.length) {
    const paymentsRes = await supabase.from("job_payments").select("booking_id, amount, payment_type").in("booking_id", completedBookingIds).is("voided_at", null);
    if (paymentsRes.error) throw paymentsRes.error;
    (paymentsRes.data || []).forEach((row) => {
      if (!ledgerRowsByBooking[row.booking_id]) ledgerRowsByBooking[row.booking_id] = [];
      ledgerRowsByBooking[row.booking_id].push(row);
    });
  }

  const jobs = bookings.map((b) => {
    const customer = customersById[b.customer_id] || null;
    // revenueAmount/revenueSource: null for anything that isn't a completed,
    // non-pickup job (booked/rental_out jobs are Booked, not Revenue; a
    // pickup leg is never either). A complimentary job stays $0 regardless
    // of any ledger row, matching completedRevenueAmount()'s own existing
    // isComplimentary short-circuit on the client — enforced here too so
    // revenueAmount itself is already the final truth, not something the
    // client has to re-derive.
    const isCompletedCountable = normalizedStatus(b.status) === "completed" && b.service_type !== "dumpster_pickup";
    let revenueAmount = null;
    let revenueSource = null;
    if (isCompletedCountable) {
      if (b.is_complimentary) {
        revenueAmount = 0;
        revenueSource = "complimentary";
      } else {
        const rev = effectiveRevenue(ledgerRowsByBooking[b.id] || [], b.final_price);
        revenueAmount = rev.amount === null ? 0 : rev.amount;
        revenueSource = rev.source;
      }
    }
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
      // Dashboard Revenue audit fix — the ledger-authoritative amount for a
      // completed, non-pickup job (null for anything else); see this
      // function's own comment above computeFromJobs. completedRevenueAmount()
      // in admin/schedule-financials.js and admin/home.js reads this instead
      // of finalPrice now.
      revenueAmount: revenueAmount,
      revenueSource: revenueSource,
      // Batch 3 addendum — complimentary/free job tracking. isComplimentary
      // is what admin/schedule-financials.js's completedRevenueAmount()
      // checks FIRST, before ever looking at finalPrice/estimatedPrice (see
      // that function's own comment) — complimentaryValue/Reason/Note are
      // purely informational, read only by the separate, non-summed
      // Complimentary Service breakdown, never by any revenue/Net math.
      isComplimentary: !!b.is_complimentary,
      complimentaryValue: b.complimentary_value,
      complimentaryReason: b.complimentary_reason,
      complimentaryReasonLabel: b.complimentary_reason ? complimentaryReasonLabel(b.complimentary_reason) : null,
      complimentaryNote: b.complimentary_note,
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
      // Phase 4 Stage 1: the grid's per-day count badge is a business job
      // total, not a visit total — a rental's pickup is excluded here even
      // though it still renders as its own card in the day panel below
      // (that panel reuses this same unfiltered `jobs` array).
      if (j.serviceType === "dumpster_pickup") return;
      jobCountsByDate[j.appointmentDate] = (jobCountsByDate[j.appointmentDate] || 0) + 1;
    });
    // Estimate workflow hardening pass — Month now gets the same sibling
    // `estimates` array as Today/Tomorrow/Yesterday/Day/Week (see
    // fetchScheduleEstimates()'s own header). An estimate scheduled for a
    // future date within this month must show here exactly as it does on
    // Day/Week — fetchScheduleEstimates() has no "today-relative" filter
    // at all, only the month's own [startDate, endDate] bounds, so a
    // future-dated scheduled estimate is never dropped merely because the
    // admin is viewing Month instead of Day/Week. estimateCountsByDate
    // mirrors jobCountsByDate's shape for the same reason (forward-
    // compatible, even though the client currently derives its own count
    // from the `estimates` array directly — see admin/calendar-views.js's
    // renderMonthGrid()). Never merged into jobs/jobCountsByDate — kept
    // as a clearly separate pair of fields so this response can never be
    // mistaken for carrying one combined "schedule item" concept, and so
    // admin/schedule-financials.js (fed jobs only) stays structurally
    // unable to see an estimate even if a future caller got careless.
    const estimates = await fetchScheduleEstimates(supabase, startDate, endDate);
    const estimateCountsByDate = {};
    estimates.forEach(function (e) {
      estimateCountsByDate[e.appointmentDate] = (estimateCountsByDate[e.appointmentDate] || 0) + 1;
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
      estimates: estimates,
      estimateCountsByDate: estimateCountsByDate,
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
      .select("id, appointment_date, service_type")
      .in("status", SCHEDULABLE_STATUSES)
      .gte("appointment_date", startDate)
      .lte("appointment_date", endDate)
      .is("archived_at", null); // Batch 2: same exclusion as fetchScheduleJobs()
    if (bookingsRes.error) throw bookingsRes.error;

    const countsByMonth = new Array(12).fill(0);
    (bookingsRes.data || []).forEach(function (b) {
      // Phase 4 Stage 1: Year never renders cards at all (see this
      // function's own header) — these are pure business job totals, so a
      // rental's pickup is excluded, same as every count in this file.
      if (b.service_type === "dumpster_pickup") return;
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

    // Staging bug fix (2026-09-19): `total`/`totalAmount` must reflect
    // ACTIVE (non-voided) expenses only, unconditionally — includeVoided
    // controls whether voided rows are DISPLAYED (in `expenses` below),
    // never whether they count toward the period total. The original code
    // summed/counted `rows` directly, which — once includeVoided=1 pulled
    // voided rows into `rows` for display — silently let a voided expense
    // back into the accounting total the moment "Show voided expenses" was
    // checked, even though the same response correctly labeled that row
    // VOIDED in the list below it. `nonVoidedRows` is always a strict
    // subset of `rows` (identical to `rows` itself when includeVoided=0,
    // since the query already excludes voided rows at the source in that
    // case — see applyCommonFilters above), so this changes nothing for
    // the default view; it only fixes the count/sum once voided rows are
    // ever present in `rows` at all.
    const nonVoidedRows = rows.filter(function (e) {
      return !e.voided_at;
    });
    const total = nonVoidedRows.length;
    const totalAmount = nonVoidedRows.reduce(function (sum, e) {
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
      // Pagination ("is there another page to load") is deliberately based
      // on rows.length (every row actually being paged through, voided
      // included when shown) — not on `total` above, which is now the
      // active-only accounting count and would under-report how much is
      // left to page through once voided rows are part of the displayed set.
      hasMore: offset + page.length < rows.length,
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

// ---------------------------------------------------------------------
// Other Revenue ledger (Phase 3C Stage 6 / Batch 3) — money the business
// receives that is NOT a job's own collected/quoted amount: scrap-metal
// recycling proceeds, resale of reusable items/furniture recovered on
// jobs. Modeled as its own small append-only table (other_revenue),
// closest in shape to job_payments (create + void only — no "update"
// action exists at all, since there is nothing beyond create/void to
// audit, same reasoning job_payments itself uses). See
// sql/2026-10-02_phase3c-stage6-other-revenue.sql for the full schema/
// grants writeup. Never touches bookings, job_payments, or expenses —
// admin/schedule-financials.js is the only place this ledger's totals are
// ever combined with job-derived Revenue, and only additively (Job Revenue
// itself, computed from completed jobs, is completely untouched either
// way).
// ---------------------------------------------------------------------
const OTHER_REVENUE_COLS = "id, type, amount, revenue_date, note, booking_id, voided_at, voided_reason, voided_by, created_at, created_by";
const OTHER_REVENUE_MAX_AMOUNT = 999999;
const OTHER_REVENUE_NOTE_MAX = 500;
const OTHER_REVENUE_VOID_REASON_MAX = 300;

function serializeOtherRevenue(r) {
  return {
    id: r.id,
    type: r.type,
    typeLabel: otherRevenueTypeLabel(r.type),
    amount: r.amount,
    revenueDate: r.revenue_date,
    note: r.note,
    bookingId: r.booking_id,
    voidedAt: r.voided_at,
    voidedReason: r.voided_reason,
    voidedBy: r.voided_by,
    isVoided: !!r.voided_at,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

// GET ?view=other-revenue&startDate=&endDate=&type=&includeVoided=&bookingId= —
// a bounded date range, same EXPENSES_MAX_RANGE_DAYS bound and the same
// "voided rows excluded from totalAmount unconditionally, included in the
// row list only when includeVoided=1" rule handleExpensesList uses (see
// that function's own comment for the exact staging bug this mirrors the
// fix for, applied here from the start rather than discovered later).
async function handleOtherRevenueList(req, res, supabase) {
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

  const typeRaw = typeof req.query.type === "string" ? req.query.type.trim() : "";
  const typeFilter = Object.prototype.hasOwnProperty.call(OTHER_REVENUE_TYPES, typeRaw) ? typeRaw : "";

  const bookingIdFilter = typeof req.query.bookingId === "string" ? req.query.bookingId.trim() : "";
  const includeVoided = req.query.includeVoided === "1";

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = EXPENSE_LIST_DEFAULT_LIMIT;
  limit = Math.min(limit, EXPENSE_LIST_MAX_LIMIT);
  let offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  try {
    let q = supabase.from("other_revenue").select(OTHER_REVENUE_COLS).gte("revenue_date", startDateRaw).lte("revenue_date", endDateRaw);
    if (!includeVoided) q = q.is("voided_at", null);
    if (typeFilter) q = q.eq("type", typeFilter);
    if (bookingIdFilter) q = q.eq("booking_id", bookingIdFilter);
    const { data, error } = await q.order("revenue_date", { ascending: false }).order("created_at", { ascending: false }).limit(EXPENSE_LIST_MAX_LIMIT);
    if (error) throw error;

    const rows = data || [];
    // Same discipline as handleExpensesList's nonVoidedRows: totalAmount is
    // ALWAYS active-only, unconditionally — includeVoided only controls
    // what's displayed, never what counts toward the period total.
    const nonVoidedRows = rows.filter(function (r) {
      return !r.voided_at;
    });
    const total = nonVoidedRows.length;
    const totalAmount = nonVoidedRows.reduce(function (sum, r) {
      return sum + (Number(r.amount) || 0);
    }, 0);
    const page = rows.slice(offset, offset + limit).map(serializeOtherRevenue);
    const enriched = await attachJobLabels(supabase, page);

    res.status(200).json({
      ok: true,
      startDate: startDateRaw,
      endDate: endDateRaw,
      otherRevenue: enriched,
      total: total,
      totalAmount: Math.round(totalAmount * 100) / 100,
      limit: limit,
      offset: offset,
      hasMore: offset + page.length < rows.length,
    });
  } catch (err) {
    console.error("Admin other-revenue list failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load other revenue." });
  }
}

// POST { resource: "other-revenue", type, amount, revenueDate, note,
// bookingId } — create one Other Revenue row. Every field is read
// individually and validated, same discipline as handleCreateExpense();
// the request body is never spread into the insert payload.
async function handleCreateOtherRevenue(req, res, session) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin other-revenue create failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

  const type = typeof body.type === "string" ? body.type.trim() : "";
  if (!Object.prototype.hasOwnProperty.call(OTHER_REVENUE_TYPES, type)) {
    res.status(400).json({ error: "Please choose a valid revenue type." });
    return;
  }

  if (body.amount === undefined || body.amount === null || body.amount === "") {
    res.status(400).json({ error: "An amount is required." });
    return;
  }
  const amountNum = Number(body.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0 || amountNum > OTHER_REVENUE_MAX_AMOUNT) {
    res.status(400).json({ error: "Please enter a valid amount." });
    return;
  }
  const amount = Math.round(amountNum * 100) / 100;

  const revenueDate = typeof body.revenueDate === "string" ? body.revenueDate.trim() : "";
  if (!isValidIsoDate(revenueDate)) {
    res.status(400).json({ error: "A valid revenue date is required." });
    return;
  }
  if (revenueDate < HISTORICAL_FLOOR_ISO) {
    res.status(400).json({ error: "Revenue date cannot be before January 1, 2026." });
    return;
  }
  const todayIso = denverTodayIso();
  if (revenueDate > todayIso) {
    res.status(400).json({ error: "Revenue date cannot be in the future." });
    return;
  }

  const note = sanitizeExpenseText(body.note, OTHER_REVENUE_NOTE_MAX) || null;

  let bookingId = null;
  if (body.bookingId !== undefined && body.bookingId !== null && body.bookingId !== "") {
    const bid = typeof body.bookingId === "string" ? body.bookingId.trim() : "";
    if (!bid) {
      res.status(400).json({ error: "Invalid job link." });
      return;
    }
    // A malformed/nonexistent id is caught by the FK constraint on insert
    // below (23503), not re-validated here — same as handleCreateExpense().
    bookingId = bid;
  }

  try {
    const { data: created, error } = await supabase
      .from("other_revenue")
      .insert({
        type: type,
        amount: amount,
        revenue_date: revenueDate,
        note: note,
        booking_id: bookingId,
        created_by: (session && session.email) || null,
      })
      .select(OTHER_REVENUE_COLS)
      .single();

    if (error) {
      if (error.code === "23503") {
        res.status(400).json({ error: "That job could not be found." });
        return;
      }
      throw error;
    }
    if (!created) throw new Error("Insert returned no row.");

    res.status(200).json({ ok: true, otherRevenue: serializeOtherRevenue(created) });
  } catch (err) {
    console.error("Admin other-revenue create failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not save this revenue entry." });
  }
}

// PATCH { resource: "other-revenue", id, reason } — void one Other Revenue
// row. The ONLY write this ledger's PATCH allows — type/amount/revenueDate/
// bookingId are never editable once written (append-only, same financial-
// audit requirement job_payments follows: a wrong entry is corrected by
// voiding it here, then POSTing a new, correct row, never by mutating this
// row's numbers). service_role's own column-scoped UPDATE grant enforces
// this a second way, at the database permission level.
async function handleVoidOtherRevenue(req, res, session) {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error("Admin other-revenue void failed: SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
    res.status(500).json({ error: "Admin data is not available right now." });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    res.status(400).json({ error: "An id is required." });
    return;
  }

  const reason = sanitizeExpenseText(body.reason, OTHER_REVENUE_VOID_REASON_MAX);
  if (!reason) {
    res.status(400).json({ error: "A reason is required to void a revenue entry." });
    return;
  }

  try {
    const { data: voided, error } = await supabase
      .from("other_revenue")
      .update({
        voided_at: new Date().toISOString(),
        voided_reason: reason,
        voided_by: (session && session.email) || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .is("voided_at", null)
      .select(OTHER_REVENUE_COLS)
      .maybeSingle();
    if (error) throw error;
    if (!voided) {
      res.status(409).json({ error: "This entry was not found, or has already been voided." });
      return;
    }
    res.status(200).json({ ok: true, otherRevenue: serializeOtherRevenue(voided) });
  } catch (err) {
    console.error("Admin other-revenue void failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not void this revenue entry." });
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
// Expenses and Other Revenue pages' job-link fields both use. Searches
// customers by name/phone (same bounded multi-field ilike pattern as
// api/admin/clients.js), then returns each match's recent bookings, newest
// first, capped generously — this is a lightweight picker, not a full
// booking search.
//
// Batch 4 (B) fix: archived jobs are excluded here (.is("archived_at",
// null)) — a job the owner archived should never be offered as a NEW link
// target. This intentionally does NOT touch attachJobLabels() (the
// separate lookup that enriches an already-saved expense/other-revenue
// row's job label for display) — an expense/other-revenue entry linked to
// a job that was archived AFTER the link was made must keep showing that
// job's label exactly as before; only the picker's own search RESULTS are
// scoped to active jobs.
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
      .is("archived_at", null)
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

// ---------------------------------------------------------------------
// Batch 6 (Leads consolidation) — GET ?view=leads. A READ-ONLY merge of
// two sources that never touch each other:
//   - `bookings` rows from the public /book/ flow (junk_removal/
//     light_demo), exactly as Requests already reads them today — same
//     seven status values, same archived_at exclusion. Tagged source:
//     "website" in the response; nothing about how these rows are written
//     (api/book.js) changes.
//   - `leads` rows (screenshot-intake-confirmed, phone, or manual —
//     sql/2026-10-05_phase3c-batch6-leads.sql, not yet run anywhere) —
//     their own richer status vocabulary, since this is the table that
//     actually has a slot for "waiting_on_photos"/"estimate_sent"/
//     "follow_up". Tagged source: "screenshot_intake" | "phone" | "manual".
//
// "Pending Intake" is deliberately NOT a section here — it's the existing,
// unchanged GET /api/admin/intake list (status=pending_review), which the
// Leads UI fetches directly. Folding it in here would mean this file
// querying intake_sessions, duplicating logic api/admin/intake.js already
// owns — the Leads page itself does the assembly instead.
//
// Every bucket key below matches the Leads workspace nav exactly. A
// website-origin booking and a leads-table row can both land in the same
// bucket (e.g. "contacted") — they are never merged into one record, only
// displayed side by side, each still carrying its own `kind`/`source` and
// its own real id in its own real table.
// ---------------------------------------------------------------------
const LEADS_BOOKING_COLS = "id, customer_id, service_type, service_city, status, created_at, updated_at";
const LEADS_TABLE_COLS =
  "id, source, status, first_name, last_name, phone, city, service_type, created_at, updated_at, next_follow_up_date";

const LEADS_BUCKET_LABELS = {
  websiteRequests: "Website Request",
  new: "New",
  contacted: "Contacted",
  waitingOnPhotos: "Waiting on Photos",
  estimateSent: "Estimate Sent",
  followUp: "Follow Up",
  bookedWon: "Booked/Won",
  lost: "Lost",
};

// leads.status -> Leads-workspace bucket key. Every bookings.status value
// maps to its bucket inline in handleLeadsView() below (it's a fixed, tiny
// 7-value set with no reuse elsewhere); this one's broken out because
// leads.status and bucket keys differ in spelling (snake_case vs
// camelCase) in a way worth naming once rather than inline per call site.
const LEAD_STATUS_TO_BUCKET = {
  new: "new",
  contacted: "contacted",
  waiting_on_photos: "waitingOnPhotos",
  estimate_sent: "estimateSent",
  follow_up: "followUp",
  booked: "bookedWon",
  lost: "lost",
};

// Preview QA finding (2026-10): a single environment-level schema gap —
// one column one query touches, missing on a given Supabase project —
// must never blank the ENTIRE Leads page when seven other queries would
// have succeeded fine. Named here (rather than inline per query) so a
// failure is logged against the exact section it came from, not just "the
// first error Promise.all happened to see" — the prior single combined
// throw could only ever report that, never which of the 8 queries it was.
const LEADS_QUERY_LABELS = {
  newRes: "websiteRequests",
  contactedRes: "contacted",
  quotedRes: "estimateSent",
  bookedRes: "bookedWon (booked)",
  rentalOutRes: "bookedWon (rental_out)",
  completedRes: "bookedWon (completed)",
  lostRes: "lost",
  leadsRes: "leads table",
};

async function handleLeadsView(req, res, supabase) {
  try {
    // Phase 4 Stage 1: every bookings query below also excludes
    // service_type = "dumpster_pickup" — a lead-conversion/source bucket
    // must count the rental booking that actually converted, never a
    // second entry for its auto-generated pickup job.
    const [newRes, contactedRes, quotedRes, bookedRes, rentalOutRes, completedRes, lostRes, leadsRes] = await Promise.all([
      // "new" IS a stored value, not NULL — confirmed against production
      // (2026-10-18 schema audit): bookings.status is `NOT NULL DEFAULT
      // 'new'`. See the identical note above handleList()'s own status
      // filter for the full explanation.
      supabase.from("bookings").select(LEADS_BOOKING_COLS).eq("status", "new").is("archived_at", null).order("created_at", { ascending: false }),
      supabase.from("bookings").select(LEADS_BOOKING_COLS).eq("status", "contacted").is("archived_at", null).order("created_at", { ascending: false }),
      supabase.from("bookings").select(LEADS_BOOKING_COLS).eq("status", "quoted").is("archived_at", null).order("created_at", { ascending: false }),
      supabase.from("bookings").select(LEADS_BOOKING_COLS).eq("status", "booked").is("archived_at", null).order("created_at", { ascending: false }),
      supabase.from("bookings").select(LEADS_BOOKING_COLS).eq("status", "rental_out").is("archived_at", null).order("created_at", { ascending: false }),
      supabase.from("bookings").select(LEADS_BOOKING_COLS).eq("status", "completed").is("archived_at", null).order("created_at", { ascending: false }),
      supabase.from("bookings").select(LEADS_BOOKING_COLS).eq("status", "lost").is("archived_at", null).order("created_at", { ascending: false }),
      supabase.from("leads").select(LEADS_TABLE_COLS).order("created_at", { ascending: false }),
    ]);

    // Each of the 8 queries above is now independent: one erroring (e.g.
    // a column this repo has no tracked migration for — see
    // tests/phase3c-batch6-leads-schema-contract.test.js — missing on a
    // given environment) contributes an EMPTY result to whatever
    // section(s) it feeds, logged individually, and named in the
    // response's `sectionErrors`. Every OTHER, successful query's data
    // renders exactly as it always has — no change to bucket placement or
    // any successful row's shape.
    const resultsByVar = { newRes, contactedRes, quotedRes, bookedRes, rentalOutRes, completedRes, lostRes, leadsRes };
    const sectionErrors = [];
    Object.keys(resultsByVar).forEach((key) => {
      const r = resultsByVar[key];
      if (r.error) {
        console.error("Admin leads view: " + LEADS_QUERY_LABELS[key] + " query failed:", r.error);
        sectionErrors.push(LEADS_QUERY_LABELS[key]);
        r.data = [];
      } else if (key !== "leadsRes") {
        // Phase 4 Stage 1: every bookings result here feeds a lead-
        // conversion/source bucket — a rental's auto-generated pickup job
        // must never appear as a second converted entry. Filtered in place
        // so both allBookingRows and `sections` below inherit it uniformly.
        r.data = (r.data || []).filter((b) => b.service_type !== "dumpster_pickup");
      }
    });

    const allBookingRows = []
      .concat(newRes.data || [], contactedRes.data || [], quotedRes.data || [], bookedRes.data || [], rentalOutRes.data || [], completedRes.data || [], lostRes.data || []);
    const customerIds = Array.from(new Set(allBookingRows.map((b) => b.customer_id).filter(Boolean)));
    const customersById = {};
    if (customerIds.length) {
      const custRes = await supabase.from("customers").select("id, first_name, last_name, phone, city").in("id", customerIds);
      if (custRes.error) {
        // Non-fatal: bookingCard() below already treats an unresolved
        // customer id as null name/phone/city — the page still renders,
        // just with those fields blank for website-origin cards, rather
        // than failing the whole response over a secondary enrichment
        // lookup.
        console.error("Admin leads view: customer name/phone/city lookup failed:", custRes.error);
        sectionErrors.push("client names/phone/city");
      } else {
        (custRes.data || []).forEach((c) => {
          customersById[c.id] = c;
        });
      }
    }

    function bookingCard(b, bucket) {
      const cust = b.customer_id ? customersById[b.customer_id] : null;
      const name = cust ? [cust.first_name, cust.last_name].filter(Boolean).join(" ") : "";
      return {
        id: b.id,
        kind: "booking",
        source: "website",
        name: name || null,
        phone: cust ? cust.phone : null,
        serviceType: b.service_type,
        serviceLabel: serviceLabel(b.service_type),
        city: b.service_city || (cust && cust.city) || null,
        status: bucket,
        statusLabel: LEADS_BUCKET_LABELS[bucket],
        updatedAt: b.updated_at || b.created_at,
        nextFollowUpDate: null, // bookings has no follow-up-date concept
      };
    }

    function leadCard(l) {
      const bucket = LEAD_STATUS_TO_BUCKET[l.status] || l.status;
      const name = [l.first_name, l.last_name].filter(Boolean).join(" ");
      return {
        id: l.id,
        kind: "lead",
        source: l.source,
        name: name || null,
        phone: l.phone,
        serviceType: l.service_type,
        serviceLabel: serviceLabel(l.service_type),
        city: l.city,
        status: bucket,
        statusLabel: LEADS_BUCKET_LABELS[bucket],
        updatedAt: l.updated_at || l.created_at,
        nextFollowUpDate: l.next_follow_up_date || null,
      };
    }

    const leadRows = leadsRes.data || [];
    const leadsByBucket = {};
    leadRows.forEach((l) => {
      const bucket = LEAD_STATUS_TO_BUCKET[l.status];
      if (!bucket) return; // an unrecognized status can't happen given the CHECK constraint, but never crash the view over it
      (leadsByBucket[bucket] || (leadsByBucket[bucket] = [])).push(leadCard(l));
    });

    const sections = {
      websiteRequests: (newRes.data || []).map((b) => bookingCard(b, "websiteRequests")),
      new: leadsByBucket.new || [],
      contacted: (contactedRes.data || []).map((b) => bookingCard(b, "contacted")).concat(leadsByBucket.contacted || []),
      waitingOnPhotos: leadsByBucket.waitingOnPhotos || [],
      estimateSent: (quotedRes.data || []).map((b) => bookingCard(b, "estimateSent")).concat(leadsByBucket.estimateSent || []),
      followUp: leadsByBucket.followUp || [],
      bookedWon: []
        .concat(bookedRes.data || [], rentalOutRes.data || [], completedRes.data || [])
        .map((b) => bookingCard(b, "bookedWon"))
        .concat(leadsByBucket.bookedWon || []),
      lost: (lostRes.data || []).map((b) => bookingCard(b, "lost")).concat(leadsByBucket.lost || []),
    };

    res.status(200).json({ ok: true, sections: sections, sectionErrors: sectionErrors.length ? sectionErrors : undefined });
  } catch (err) {
    // Only reachable now for a genuinely unexpected failure outside the 8
    // queries/customer lookup above (e.g. a thrown error in the mapping
    // logic itself) — every expected per-query failure is caught and
    // handled inline above instead of reaching here, so this still
    // returns ok:true for the common case of "one query had a problem."
    console.error("Admin leads view failed unexpectedly:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load leads." });
  }
}

// Phase 2 — ?view=invoices. Read-only list behind the /admin/invoices/
// page: every invoice, newest first, each enriched with the client's name
// and its derived display status/balance (via deriveInvoiceStatus(),
// api/_lib/invoice-helpers.js — the exact same helper api/admin/booking.js's
// invoice-detail endpoint uses, so the list and detail pages can never
// disagree). No pagination yet — same lean posture as handleLeadsView just
// above, which already loads full sets rather than paging.
//
// job_payments stays the one payment ledger: this bulk-fetches every
// non-voided payment row for every invoice here, in one IN(...) query,
// groups them by invoice_id in JS, and runs netCollectedFromLedgerRows()
// per group — never a second per-invoice round trip, and never a column
// on invoices itself that could drift from this computed number.
//
// Phase 3D Stage B: keyed by invoice_id, not booking_id — a generic
// booking payment (or a sibling invoice's payment, for a booking that
// somehow had more than one over time) never counts toward this invoice's
// collected total, and a standalone invoice (booking_id null) is covered
// exactly the same way every attached one is.
//
// ?status= (optional) filters by the DERIVED status (draft/finalized/
// partially_paid/paid/void) — applied in JS after deriveInvoiceStatus()
// runs, since a computed value can't be pushed into the SQL WHERE clause.
async function handleInvoicesView(req, res, supabase) {
  try {
    const invoicesRes = await supabase.from("invoices").select(INVOICE_SELECT_COLS).order("created_at", { ascending: false });
    if (invoicesRes.error) throw invoicesRes.error;
    const invoiceRows = invoicesRes.data || [];

    const customerIds = Array.from(new Set(invoiceRows.map((r) => r.customer_id).filter(Boolean)));
    const invoiceIds = invoiceRows.map((r) => r.id);

    const [customersRes, paymentsRes] = await Promise.all([
      customerIds.length
        ? supabase.from("customers").select("id, first_name, last_name").in("id", customerIds)
        : Promise.resolve({ data: [], error: null }),
      invoiceIds.length
        ? supabase
            .from("job_payments")
            .select("invoice_id, amount, payment_type, voided_at")
            .in("invoice_id", invoiceIds)
            .is("voided_at", null)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (customersRes.error) throw customersRes.error;
    if (paymentsRes.error) throw paymentsRes.error;

    const customerNameById = {};
    (customersRes.data || []).forEach((c) => {
      customerNameById[c.id] = [c.first_name, c.last_name].filter(Boolean).join(" ") || null;
    });

    const paymentsByInvoice = {};
    (paymentsRes.data || []).forEach((p) => {
      (paymentsByInvoice[p.invoice_id] || (paymentsByInvoice[p.invoice_id] = [])).push(p);
    });

    const todayIso = denverTodayIso();
    const requestedStatus = typeof req.query.status === "string" ? req.query.status.trim() : "";

    let invoices = invoiceRows.map((row) => {
      const invoice = mapInvoice(row);
      const netCollected = netCollectedFromLedgerRows(paymentsByInvoice[row.id] || []);
      const derived = deriveInvoiceStatus(invoice, netCollected, todayIso);
      return Object.assign({ customerName: customerNameById[row.customer_id] || null }, invoice, derived);
    });

    // "overdue" is deliberately not a displayStatus value (it's the
    // orthogonal isOverdue flag — see deriveInvoiceStatus()'s own header)
    // but the Invoices list page's filter pills treat it as a sixth,
    // equally-clickable filter alongside the five real buckets, so it gets
    // one special case here rather than becoming a fake displayStatus the
    // rest of this app would have to know about.
    if (requestedStatus === "overdue") {
      invoices = invoices.filter((inv) => inv.isOverdue);
    } else if (requestedStatus) {
      invoices = invoices.filter((inv) => inv.displayStatus === requestedStatus);
    }

    res.status(200).json({ ok: true, invoices: invoices });
  } catch (err) {
    console.error("Admin invoices view failed:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Could not load invoices." });
  }
}

// Strips control characters, trims, caps length, then escapes ILIKE
// wildcard characters — same discipline as api/admin/client.js's own
// sanitizeSearchTerm() (originally api/admin/clients.js's, retired into
// client.js in Batch 6), a small deliberate local copy rather than a
// shared import (this project's established convention).
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
