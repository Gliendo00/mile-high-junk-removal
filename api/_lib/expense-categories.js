// Locked expense category allowlist — originally Phase 3C Stage 2.4
// (Daily Quick Expense Tracking), expanded in Stage 3 (full Expense
// Management) to cover more of the business's real expense types. Server-
// side validation (api/admin/bookings.js's expense create/update handlers)
// checks a submitted category against these keys only; the client-side
// quick-expense UI (admin/quick-expense.js) and the full Expenses page
// (admin/expenses.js) each keep their own small mirrored copy of the same
// ids/labels, matching this project's established convention (see
// api/_lib/historical-floor.js's header) of duplicating a small constant
// client-side rather than sharing a module across runtimes.
//
// IMPORTANT — stable keys, relabeled display text: the original seven DB
// keys (fuel, dump_fees, meals, repairs_maintenance, advertising, supplies,
// miscellaneous) are NEVER renamed here, only their display label changed
// where the owner asked for cleaner wording (e.g. "Dump Fees" ->
// "Dump Fee"). Renaming a key instead of relabeling it would silently
// orphan every already-persisted expense row using the old key (including
// staging's real data) — this object is the single place old key -> new
// label is decided, so every UI surface stays consistent automatically.
// Four new keys were added for categories the business asked for that had
// no prior equivalent: labor, subcontractor, vehicle, disposal_recycling.
const EXPENSE_CATEGORIES = {
  fuel: "Fuel",
  dump_fees: "Dump Fee",
  labor: "Labor",
  supplies: "Supplies",
  repairs_maintenance: "Equipment / Repair",
  advertising: "Advertising / Marketing",
  subcontractor: "Subcontractor",
  vehicle: "Vehicle",
  disposal_recycling: "Disposal / Recycling",
  meals: "Meals",
  // Same stable key as before (miscellaneous); the owner's requested
  // display wording for this stage is "Other" instead of "Miscellaneous".
  miscellaneous: "Other",
};

// The three categories the Schedule's quick-expense row surfaces as
// one-tap buttons (Fuel/Dump/Meal); every other category lives behind
// "+ More". Order matters here — it's the display order of both the quick
// row and the "+ More" list. Unchanged by the Stage 3 expansion — Quick
// Expense stays a fast, small surface; the full category list is what the
// new /admin/expenses/ page's category picker/filter uses (see
// EXPENSE_CATEGORIES directly, via ALL_EXPENSE_CATEGORY_KEYS below).
const QUICK_EXPENSE_CATEGORIES = ["fuel", "dump_fees", "meals"];
const MORE_EXPENSE_CATEGORIES = ["labor", "repairs_maintenance", "advertising", "subcontractor", "vehicle", "disposal_recycling", "supplies", "miscellaneous"];

// Every valid key, in the same display order as EXPENSE_CATEGORIES — used
// by the full Expenses page (category picker + filter dropdown) and by
// server-side validation's Object.keys() equivalent.
const ALL_EXPENSE_CATEGORY_KEYS = Object.keys(EXPENSE_CATEGORIES);

function expenseCategoryLabel(raw) {
  return EXPENSE_CATEGORIES[raw] || String(raw || "—");
}

module.exports = { EXPENSE_CATEGORIES, QUICK_EXPENSE_CATEGORIES, MORE_EXPENSE_CATEGORIES, ALL_EXPENSE_CATEGORY_KEYS, expenseCategoryLabel };
