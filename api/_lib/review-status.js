// Client review status, shared by every /api/admin/* route that returns a
// client's name, so the CRM can show the same star next to that name on
// any screen (see admin/review-badge.js for the front-end half).
//
//   "received"  — customers.review_received_at is set (Rocky marked it)
//   "requested" — at least one of the client's jobs has
//                 bookings.review_request_sent_at set
//   "none"      — neither
//
// Fails open, never throws: the star is informational, so a lookup error
// (including customers.review_received_at not existing yet because
// sql/2026-11-26_client-review-received.sql hasn't been run) must never
// break the screen that asked for it. A failed "received" lookup still
// lets "requested" through; a failed "requested" lookup still lets
// "received" through.

const CHUNK_SIZE = 100;

function chunk(list) {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK_SIZE) out.push(list.slice(i, i + CHUNK_SIZE));
  return out;
}

function deriveReviewStatus(received, requested) {
  if (received) return "received";
  if (requested) return "requested";
  return "none";
}

// Returns a plain object: { [customerId]: "received" | "requested" | "none" }.
// Every id passed in gets an entry (default "none").
async function fetchReviewStatusMap(supabase, customerIds) {
  const ids = Array.from(new Set((customerIds || []).filter(Boolean)));
  const received = {};
  const requested = {};
  if (ids.length && supabase) {
    const groups = chunk(ids);
    await Promise.all(
      groups.map(async (group) => {
        try {
          const r = await supabase.from("customers").select("id, review_received_at").in("id", group);
          if (r.error) throw r.error;
          (r.data || []).forEach((c) => {
            if (c.review_received_at) received[c.id] = true;
          });
        } catch (err) {
          console.error("review-status: received lookup failed (falling open):", err && err.message ? err.message : err);
        }
      })
    );
    await Promise.all(
      groups.map(async (group) => {
        try {
          const r = await supabase
            .from("bookings")
            .select("customer_id")
            .in("customer_id", group)
            .not("review_request_sent_at", "is", null);
          if (r.error) throw r.error;
          (r.data || []).forEach((b) => {
            if (b.customer_id) requested[b.customer_id] = true;
          });
        } catch (err) {
          console.error("review-status: requested lookup failed (falling open):", err && err.message ? err.message : err);
        }
      })
    );
  }
  const map = {};
  ids.forEach((id) => {
    map[id] = deriveReviewStatus(!!received[id], !!requested[id]);
  });
  return map;
}

// Client profile page: the received date/by fields too. `requested` is
// passed in by the caller (it already has the client's bookings). Fails
// open to "not received" if the columns don't exist yet.
async function fetchClientReviewDetail(supabase, customerId, requested) {
  let receivedAt = null;
  let receivedBy = null;
  let available = true;
  try {
    const r = await supabase.from("customers").select("review_received_at, review_received_by").eq("id", customerId).maybeSingle();
    if (r.error) throw r.error;
    if (r.data) {
      receivedAt = r.data.review_received_at || null;
      receivedBy = r.data.review_received_by || null;
    }
  } catch (err) {
    available = false;
    console.error("review-status: client detail lookup failed (falling open):", err && err.message ? err.message : err);
  }
  return {
    status: deriveReviewStatus(!!receivedAt, !!requested),
    receivedAt: receivedAt,
    receivedBy: receivedBy,
    // false until sql/2026-11-26_client-review-received.sql has been run;
    // the client page uses it to explain why the toggle can't save yet.
    trackingAvailable: available,
  };
}

module.exports = { fetchReviewStatusMap, deriveReviewStatus, fetchClientReviewDetail };
