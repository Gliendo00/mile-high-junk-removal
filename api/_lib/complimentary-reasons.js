// Locked allowlist for bookings.complimentary_reason — Batch 3 addendum
// (complimentary/free job tracking). A completed job can be explicitly
// marked complimentary (its Job Revenue is forced to $0 — see
// api/admin/booking.js's parseComplimentary()); this is the reason given
// for why. "other" requires complimentary_note to be set (enforced in
// parseComplimentary(), not here — this array is only the allowed value
// list, same convention as api/_lib/expense-categories.js/
// other-revenue-types.js). Mirrored client-side in admin/booking-past.js
// and admin/booking-edit.js (this project's established convention of a
// small deliberate client-side copy rather than a module shared across
// runtimes).
const COMPLIMENTARY_REASONS = {
  loyal_client: "Loyal Client",
  community_charity: "Community / Charity",
  service_recovery: "Service Recovery",
  friends_family: "Friends & Family",
  other: "Other",
};

const ALL_COMPLIMENTARY_REASON_KEYS = Object.keys(COMPLIMENTARY_REASONS);

function complimentaryReasonLabel(raw) {
  return COMPLIMENTARY_REASONS[raw] || String(raw || "—");
}

module.exports = { COMPLIMENTARY_REASONS, ALL_COMPLIMENTARY_REASON_KEYS, complimentaryReasonLabel };
