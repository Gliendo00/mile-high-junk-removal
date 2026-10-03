// Locked allowlist for other_revenue.type — Phase 3C Stage 6 (Batch 3).
// Money the business receives that is NOT a job's own collected/quoted
// amount: scrap-metal recycling proceeds, resale of reusable items/
// furniture recovered on jobs. Neither type is a job, and neither is ever
// summed into Job Revenue (admin/schedule-financials.js's
// completedRevenueAmount()) — both only ever add to the Total Revenue/Net
// figures, as a separate, clearly-labeled source. See
// sql/2026-10-02_phase3c-stage6-other-revenue.sql's CHECK constraint, which
// must stay in sync with these keys, and the client-side mirrored copy in
// admin/expenses.js (this project's established convention — see
// api/_lib/expense-categories.js's own header — of a small deliberate
// client-side copy rather than a module shared across runtimes).
const OTHER_REVENUE_TYPES = {
  metal_recycling: "Metal Recycling",
  resale_sale: "Resale Sales",
};

const ALL_OTHER_REVENUE_TYPE_KEYS = Object.keys(OTHER_REVENUE_TYPES);

function otherRevenueTypeLabel(raw) {
  return OTHER_REVENUE_TYPES[raw] || String(raw || "—");
}

module.exports = { OTHER_REVENUE_TYPES, ALL_OTHER_REVENUE_TYPE_KEYS, otherRevenueTypeLabel };
