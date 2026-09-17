// Locked expense category allowlist — Phase 3C Stage 2.4 addendum (Daily
// Quick Expense Tracking). Exactly seven categories, no catch-all "Other" —
// per the owner's explicit instruction, Miscellaneous is the deliberate
// last resort instead. Server-side validation (api/admin/bookings.js's
// expense POST) checks a submitted category against these keys only; the
// client-side quick-expense UI (admin/schedule.js) keeps its own small
// mirrored copy of the same ids/labels, matching this project's established
// convention (see api/_lib/historical-floor.js's header) of duplicating a
// small constant client-side rather than sharing a module across runtimes.
const EXPENSE_CATEGORIES = {
  fuel: "Fuel",
  dump_fees: "Dump Fees",
  meals: "Meals",
  repairs_maintenance: "Repairs/Maintenance",
  advertising: "Advertising",
  supplies: "Supplies",
  miscellaneous: "Miscellaneous",
};

// The three categories the Schedule's quick-expense row surfaces as
// one-tap buttons (Fuel/Dump/Meal); every other category lives behind
// "+ More". Order matters here — it's the display order of both the quick
// row and the "+ More" list.
const QUICK_EXPENSE_CATEGORIES = ["fuel", "dump_fees", "meals"];
const MORE_EXPENSE_CATEGORIES = ["repairs_maintenance", "advertising", "supplies", "miscellaneous"];

function expenseCategoryLabel(raw) {
  return EXPENSE_CATEGORIES[raw] || String(raw || "—");
}

module.exports = { EXPENSE_CATEGORIES, QUICK_EXPENSE_CATEGORIES, MORE_EXPENSE_CATEGORIES, expenseCategoryLabel };
