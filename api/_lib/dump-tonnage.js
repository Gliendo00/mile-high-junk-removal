// Dump Fee Tonnage Tracking (2026-10-31). Small pure helpers shared by the
// expense create/update handlers and the Home dashboard's ?view=tonnage
// summary in api/admin/bookings.js. See sql/2026-10-31_dump-fee-tonnage.sql
// for the column itself.
//
// Pounds are the canonical stored value (expenses.dump_weight_lbs); tons
// are always derived here as lbs / 2000 and never stored. Weight is purely
// informational — nothing in this file ever touches an expense's dollar
// amount or any revenue/net figure.
//
// The admin UI (admin/expenses.js, admin/quick-expense.js) keeps its own
// tiny mirrored copy of lbsToTons() for the live "5,000 lbs = 2.50 tons"
// preview, same convention as api/_lib/expense-categories.js's header.

const DUMP_FEE_CATEGORY = "dump_fees";
const LBS_PER_TON = 2000;
// Matches the migration's CHECK constraint (100 tons).
const DUMP_WEIGHT_MAX_LBS = 200000;

// Parses an optional submitted weight. Absent/null/blank -> { value: null }
// (clearing a weight means NULL, never 0). Accepts a number or a numeric
// string, tolerating thousands separators ("5,000") since that's how the
// number reads off a scale ticket. Rounded to 2 decimals to match the
// numeric(10,2) column.
function parseDumpWeightLbs(raw) {
  if (raw === undefined || raw === null) return { value: null };
  let n;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const cleaned = raw.trim().replace(/,/g, "");
    if (!cleaned) return { value: null };
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return { error: "Please enter a valid dump weight in pounds." };
    n = Number(cleaned);
  } else {
    return { error: "Please enter a valid dump weight in pounds." };
  }
  if (!Number.isFinite(n) || n <= 0 || n > DUMP_WEIGHT_MAX_LBS) {
    return { error: "Please enter a valid dump weight in pounds." };
  }
  return { value: Math.round(n * 100) / 100 };
}

function lbsToTons(lbs) {
  const n = Number(lbs);
  if (!Number.isFinite(n)) return null;
  return n / LBS_PER_TON;
}

function roundTons(tons) {
  return Math.round((Number(tons) || 0) * 100) / 100;
}

function hasCountableWeight(row) {
  if (!row || row.voided_at) return false;
  if (row.category !== DUMP_FEE_CATEGORY) return false;
  if (row.dump_weight_lbs === null || row.dump_weight_lbs === undefined || row.dump_weight_lbs === "") return false;
  const n = Number(row.dump_weight_lbs);
  return Number.isFinite(n) && n > 0;
}

// rows: raw expenses rows (expense_date, category, dump_weight_lbs,
// voided_at at minimum). todayIso: the caller's denverTodayIso(). Only
// non-voided dump-fee rows with a real positive weight count — every other
// row is ignored rather than treated as 0 lbs.
function summarizeTonnage(rows, todayIso) {
  const monthPrefix = String(todayIso || "").slice(0, 7); // YYYY-MM
  const yearPrefix = String(todayIso || "").slice(0, 4); // YYYY
  let monthLbs = 0;
  let yearLbs = 0;
  let allLbs = 0;
  let count = 0;
  (rows || []).forEach(function (row) {
    if (!hasCountableWeight(row)) return;
    const lbs = Number(row.dump_weight_lbs);
    const date = String(row.expense_date || "");
    count += 1;
    allLbs += lbs;
    if (yearPrefix && date.slice(0, 4) === yearPrefix) yearLbs += lbs;
    if (monthPrefix && date.slice(0, 7) === monthPrefix) monthLbs += lbs;
  });
  return {
    thisMonthTons: roundTons(lbsToTons(monthLbs)),
    thisYearTons: roundTons(lbsToTons(yearLbs)),
    allTimeTons: roundTons(lbsToTons(allLbs)),
    thisMonthLbs: Math.round(monthLbs * 100) / 100,
    thisYearLbs: Math.round(yearLbs * 100) / 100,
    allTimeLbs: Math.round(allLbs * 100) / 100,
    weighedCount: count,
  };
}

module.exports = { DUMP_FEE_CATEGORY, LBS_PER_TON, DUMP_WEIGHT_MAX_LBS, parseDumpWeightLbs, lbsToTons, roundTons, hasCountableWeight, summarizeTonnage };
