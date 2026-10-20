// Phase 2 — shared helpers for public.invoices / public.invoice_line_items
// (see sql/2026-10-19_invoice-workflow.sql). Used by api/admin/booking.js's
// ?resource=invoice handlers (detail/create/finalize/void/line-items) and
// api/admin/bookings.js's ?view=invoices list — same reuse posture as
// api/_lib/job-payments-ledger.js, which this file deliberately does not
// duplicate anything from: job_payments stays the one payment ledger, and
// deriveInvoiceStatus() below only ever READS it (via the caller passing in
// an already-computed netCollected number), never writes to it.

const INVOICE_SELECT_COLS =
  "id, created_at, created_by, updated_at, updated_by, status, booking_id, customer_id, invoice_number, due_date, notes, total_amount, finalized_at, voided_at, voided_reason";

const LINE_ITEM_SELECT_COLS = "id, invoice_id, sort_order, description, quantity, unit_price, amount, created_at, updated_at";

function mapInvoice(row) {
  return {
    id: row.id,
    status: row.status,
    bookingId: row.booking_id,
    customerId: row.customer_id,
    invoiceNumber: row.invoice_number,
    dueDate: row.due_date,
    notes: row.notes,
    totalAmount: row.total_amount,
    finalizedAt: row.finalized_at,
    voidedAt: row.voided_at,
    voidedReason: row.voided_reason,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function mapLineItem(row) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    sortOrder: row.sort_order,
    description: row.description,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    amount: row.amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// invoice.status's three STORED values (draft/finalized/void) map to five
// DISPLAY values (draft/finalized/partially_paid/paid/void) plus one
// orthogonal isOverdue flag — never a sixth "overdue" bucket of its own,
// since overdue modifies a balance state rather than replacing it (an
// unpaid, past-due, finalized invoice is both "finalized" and "overdue" at
// once, same as a partially-paid one can be). "finalized" (not "sent") is
// deliberately the display label too, for the same reason the action is
// called Finalize, not Send — this app has no client-delivery/email
// capability yet, and "Sent" would wrongly claim it does.
//
// invoice: a mapInvoice()-shaped object ({status, totalAmount, dueDate}
// at minimum). netCollected: that invoice's booking's non-voided
// job_payments, net of refunds (job-payments-ledger.js's
// netCollectedFromLedgerRows() — computed by the caller, never here).
// todayIso: the caller's own denverTodayIso() — not computed in this file,
// so every call site stays on exactly one "today" definition.
function deriveInvoiceStatus(invoice, netCollected, todayIso) {
  if (!invoice || invoice.status === "draft") {
    return { displayStatus: "draft", balanceDue: null, isOverdue: false };
  }
  if (invoice.status === "void") {
    return { displayStatus: "void", balanceDue: 0, isOverdue: false };
  }

  const total = Number(invoice.totalAmount) || 0;
  const collected = Number(netCollected) || 0;
  const balanceDue = Math.max(Math.round((total - collected) * 100) / 100, 0);
  const displayStatus = balanceDue <= 0 ? "paid" : collected > 0 ? "partially_paid" : "finalized";
  const isOverdue = displayStatus !== "paid" && !!invoice.dueDate && typeof todayIso === "string" && invoice.dueDate < todayIso;

  return { displayStatus, balanceDue, isOverdue };
}

module.exports = {
  INVOICE_SELECT_COLS,
  LINE_ITEM_SELECT_COLS,
  mapInvoice,
  mapLineItem,
  deriveInvoiceStatus,
};
