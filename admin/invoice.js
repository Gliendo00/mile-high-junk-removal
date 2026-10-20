// /admin/invoice/?id=<uuid> — Invoice detail (Phase 2, Core Invoicing).
// Mirrors admin/estimate-detail.js's structure (hero/status badge, detail
// rows, textContent-only rendering, "PATCH then reload" pattern) with one
// addition this app has never needed before: a repeatable add/remove line-
// item editor (draft only).
//
// invoice.displayStatus (draft/finalized/partially_paid/paid/void) and
// invoice.isOverdue are both computed SERVER-SIDE on every load
// (api/_lib/invoice-helpers.js's deriveInvoiceStatus()) — this file only
// ever renders them, never derives its own copy of that logic.
//
// Payment history here is READ-ONLY by design — no payment-entry form on
// this page at all. "Record Payment" deep-links to this invoice's booking,
// where the real Payments UI (admin/booking-detail.js) already lives —
// this keeps job_payments' existing endpoints the one and only place a
// payment is ever recorded, never a second, invoice-specific path.
document.addEventListener('DOMContentLoaded', function () {
  var STATUS_LABELS = {
    draft: 'Draft',
    finalized: 'Finalized',
    partially_paid: 'Partially Paid',
    paid: 'Paid',
    void: 'Void',
  };
  var JOB_PAYMENT_METHOD_TEXT = { card_stripe: 'Card (Stripe)', cash: 'Cash', zelle: 'Zelle', venmo: 'Venmo', check: 'Check', card_venmo: 'Card (Venmo)', other: 'Other' };

  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var detailEl = document.getElementById('detail');
  var logoutBtn = document.getElementById('logout-btn');
  var toastEl = document.getElementById('admin-toast');

  function showError(msg) {
    loadingEl.style.display = 'none';
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  var toastTimer = null;
  function showToast(msg, kind) {
    if (!toastEl) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = 'admin-toast is-visible' + (kind ? ' is-' + kind : '');
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-visible'); }, 3200);
  }

  function set(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text === null || text === undefined || text === '' ? '—' : text;
  }
  function formatDate(iso) {
    if (!iso) return null;
    var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function formatDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function buildTelHref(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length === 10 ? 'tel:+1' + digits : 'tel:+' + digits;
  }
  function formatPhone(p) {
    return window.formatPhone ? window.formatPhone(p) : p;
  }

  function getInvoiceId() {
    var params = new URLSearchParams(window.location.search);
    return (params.get('id') || '').trim();
  }
  var invoiceId = getInvoiceId();

  // ---------------------------------------------------------------------
  // Print mode — ?print=1 opens straight into the clean, chrome-free
  // on-screen preview (admin.css's body.admin-print-mode rules); the
  // Print button below also enters it before calling window.print(). The
  // @media print stylesheet is a second, independent guard: even a plain
  // Ctrl/Cmd+P without ever clicking into preview still hides chrome/
  // controls, so print safety never depends on this JS having run first.
  // ---------------------------------------------------------------------
  var exitPrintBar = document.getElementById('exit-print-bar');
  function enterPrintMode() {
    document.body.classList.add('admin-print-mode');
    exitPrintBar.style.display = 'block';
  }
  function exitPrintMode() {
    document.body.classList.remove('admin-print-mode');
    exitPrintBar.style.display = 'none';
  }
  document.getElementById('exit-print-btn').addEventListener('click', exitPrintMode);
  if (new URLSearchParams(window.location.search).get('print') === '1') {
    enterPrintMode();
  }
  document.getElementById('iv-print-btn').addEventListener('click', function () {
    enterPrintMode();
    window.print();
  });

  // ---------------------------------------------------------------------
  // State — refreshed wholesale from the server on every load()/action;
  // this file never computes or guesses a derived value itself.
  // ---------------------------------------------------------------------
  var currentInvoice = null;
  var editingLineItemId = null; // null = "Add Line Item" mode; a line item's id = editing that row
  var lineItemSaveInFlight = false;
  var detailsSaveInFlight = false;
  var finalizeInFlight = false;
  var voidInFlight = false;

  var finalizeBtn = document.getElementById('iv-finalize-btn');
  var sendBtn = document.getElementById('iv-send-btn');
  var sendInFlight = false;
  var voidBtn = document.getElementById('iv-void-btn');
  var lineItemsListEl = document.getElementById('iv-line-items-list');
  var lineItemFormSection = document.getElementById('iv-line-item-form-section');
  var lineItemFormLabel = document.getElementById('iv-line-item-form-label');
  var liDescriptionEl = document.getElementById('iv-li-description');
  var liQuantityEl = document.getElementById('iv-li-quantity');
  var liUnitPriceEl = document.getElementById('iv-li-unit-price');
  var liSaveBtn = document.getElementById('iv-li-save-btn');
  var liCancelBtn = document.getElementById('iv-li-cancel-btn');
  var detailsFormSection = document.getElementById('iv-details-form-section');
  var dueDateInputEl = document.getElementById('iv-due-date-input');
  var notesInputEl = document.getElementById('iv-notes-input');
  var detailsSaveBtn = document.getElementById('iv-details-save-btn');
  var paymentsListEl = document.getElementById('iv-payments-list');

  function resetLineItemForm() {
    editingLineItemId = null;
    liDescriptionEl.value = '';
    liQuantityEl.value = '1';
    liUnitPriceEl.value = '';
    lineItemFormLabel.textContent = 'Add Line Item';
    liSaveBtn.textContent = 'Add Line Item';
    liCancelBtn.style.display = 'none';
  }

  function renderLineItems(lineItems, isDraft) {
    while (lineItemsListEl.firstChild) lineItemsListEl.removeChild(lineItemsListEl.firstChild);
    if (!lineItems.length) {
      var empty = document.createElement('p');
      empty.className = 'admin-row-value';
      empty.style.color = 'var(--color-neutral-600, #82796a)';
      empty.textContent = 'No line items yet.';
      lineItemsListEl.appendChild(empty);
      return;
    }

    lineItems.forEach(function (li) {
      var row = document.createElement('div');
      row.className = 'admin-line-item-row';

      var main = document.createElement('div');
      main.className = 'admin-line-item-main';
      var desc = document.createElement('div');
      desc.className = 'admin-line-item-desc';
      desc.textContent = li.description;
      main.appendChild(desc);
      var meta = document.createElement('div');
      meta.className = 'admin-line-item-meta';
      meta.textContent = li.quantity + ' x ' + (formatPrice(li.unitPrice) || '$0.00');
      main.appendChild(meta);
      row.appendChild(main);

      var side = document.createElement('div');
      side.className = 'admin-line-item-side';
      var amount = document.createElement('span');
      amount.className = 'admin-line-item-amount';
      amount.textContent = formatPrice(li.amount) || '$0.00';
      side.appendChild(amount);

      if (isDraft) {
        var actions = document.createElement('div');
        actions.className = 'admin-line-item-actions admin-print-hide';
        var editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'admin-btn admin-btn-outline';
        editBtn.style.cssText = 'padding:2px 10px;min-height:auto;';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', function () { startEditLineItem(li); });
        actions.appendChild(editBtn);
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'admin-btn admin-btn-danger';
        removeBtn.style.cssText = 'padding:2px 10px;min-height:auto;';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', function () { removeLineItem(li.id); });
        actions.appendChild(removeBtn);
        side.appendChild(actions);
      }

      row.appendChild(side);
      lineItemsListEl.appendChild(row);
    });
  }

  function renderPayments(jobPayments) {
    while (paymentsListEl.firstChild) paymentsListEl.removeChild(paymentsListEl.firstChild);
    if (!jobPayments.length) {
      var empty = document.createElement('p');
      empty.className = 'admin-row-value';
      empty.style.color = 'var(--color-neutral-600, #82796a)';
      empty.textContent = 'No payments recorded yet.';
      paymentsListEl.appendChild(empty);
      return;
    }

    jobPayments.forEach(function (payment) {
      var row = document.createElement('div');
      row.className = 'admin-charge-row';

      var top = document.createElement('div');
      top.className = 'admin-charge-row-top';
      var amountEl = document.createElement('span');
      amountEl.className = 'admin-charge-row-amount';
      amountEl.textContent = (payment.paymentType === 'refund' ? '− ' : '') + (formatPrice(payment.amount) || '$0.00');
      top.appendChild(amountEl);
      var badge = document.createElement('span');
      badge.className = 'admin-status-badge ' + (payment.isVoided ? 'admin-status-lost' : 'admin-status-completed');
      badge.textContent = payment.isVoided ? 'VOIDED' : payment.paymentType === 'refund' ? 'Refund' : 'Payment';
      top.appendChild(badge);
      row.appendChild(top);

      var metaLine = document.createElement('div');
      metaLine.className = 'admin-charge-row-meta';
      var metaParts = [JOB_PAYMENT_METHOD_TEXT[payment.paymentMethod] || payment.paymentMethod, formatDate(payment.paymentDate) || payment.paymentDate];
      if (payment.stripePaymentIntentId) metaParts.push('Auto-recorded from Stripe');
      else if (payment.recordedBy) metaParts.push('Recorded by ' + payment.recordedBy);
      metaLine.textContent = metaParts.join(' · ');
      row.appendChild(metaLine);

      if (payment.notes) {
        var notesLine = document.createElement('div');
        notesLine.className = 'admin-charge-row-meta';
        notesLine.textContent = payment.notes;
        row.appendChild(notesLine);
      }
      if (payment.isVoided && payment.voidedReason) {
        var reasonLine = document.createElement('div');
        reasonLine.className = 'admin-charge-row-meta';
        reasonLine.style.color = '#b91c1c';
        reasonLine.textContent = 'Voided: ' + payment.voidedReason;
        row.appendChild(reasonLine);
      }

      paymentsListEl.appendChild(row);
    });
  }

  function render(data) {
    var invoice = data.invoice;
    var lineItems = data.lineItems || [];
    var jobPayments = data.jobPayments || [];
    var customer = data.customer;
    var booking = data.booking;
    currentInvoice = invoice;

    var isDraft = invoice.status === 'draft';
    var isVoid = invoice.status === 'void';

    set('iv-number', invoice.invoiceNumber || 'Draft Invoice');

    var statusBadge = document.getElementById('iv-status-badge');
    statusBadge.className = 'admin-status-badge admin-invoice-status-' + invoice.displayStatus;
    set('iv-status-label', STATUS_LABELS[invoice.displayStatus] || invoice.displayStatus);

    var overdueBadge = document.getElementById('iv-overdue-badge');
    overdueBadge.style.display = invoice.isOverdue ? 'inline-flex' : 'none';

    var name = customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') : '';
    var subtitleParts = [];
    if (booking && booking.serviceLabel) subtitleParts.push(booking.serviceLabel);
    if (booking && booking.appointmentDate) subtitleParts.push(formatDate(booking.appointmentDate));
    set('iv-subtitle', subtitleParts.join(' · ') || 'INVOICE');

    // Void banner
    var voidSection = document.getElementById('iv-void-banner-section');
    if (isVoid) {
      voidSection.style.display = 'block';
      document.getElementById('iv-voided-at-text').textContent = invoice.voidedAt ? ' on ' + formatDateTime(invoice.voidedAt) : '';
      set('iv-void-reason-text', 'Reason: ' + (invoice.voidedReason || 'No reason recorded.'));
    } else {
      voidSection.style.display = 'none';
    }

    // Bill To
    var clientLink = document.getElementById('iv-client-link');
    if (customer) {
      clientLink.href = '/admin/client/?id=' + encodeURIComponent(customer.id);
      clientLink.textContent = name || 'Unnamed client';
    } else {
      clientLink.removeAttribute('href');
      clientLink.textContent = '—';
    }
    var phoneRow = document.getElementById('iv-phone-row');
    if (customer && customer.phone) {
      phoneRow.style.display = '';
      set('iv-phone', formatPhone(customer.phone));
    } else {
      phoneRow.style.display = 'none';
    }
    var addressSource = booking || customer || {};
    var addrLine1 = addressSource.serviceAddress || addressSource.address;
    var addrLine2 = [addressSource.serviceCity || addressSource.city, addressSource.serviceState || addressSource.state, addressSource.serviceZip || addressSource.zip].filter(Boolean).join(', ');
    set('iv-address', [addrLine1, addrLine2].filter(Boolean).join('\n') || 'No address on file.');
    var jobLink = document.getElementById('iv-job-link');
    jobLink.href = '/admin/booking/?id=' + encodeURIComponent(invoice.bookingId);

    // Line items
    renderLineItems(lineItems, isDraft);
    set('iv-total', formatPrice(invoice.totalAmount) || '$0.00');
    lineItemFormSection.style.display = isDraft ? 'block' : 'none';
    if (isDraft && editingLineItemId && !lineItems.some(function (li) { return li.id === editingLineItemId; })) {
      resetLineItemForm(); // the row being edited was removed from under us (e.g. a concurrent tab) — fall back to Add mode
    }

    // Due date / notes
    set('iv-due-date', formatDate(invoice.dueDate) || 'Not set');
    var notesRow = document.getElementById('iv-notes-row');
    if (invoice.notes) {
      notesRow.style.display = '';
      set('iv-notes', invoice.notes);
    } else {
      notesRow.style.display = isDraft ? '' : 'none';
      set('iv-notes', 'Not set');
    }
    detailsFormSection.style.display = isDraft ? 'block' : 'none';
    if (isDraft && document.activeElement !== dueDateInputEl && document.activeElement !== notesInputEl) {
      dueDateInputEl.value = invoice.dueDate || '';
      notesInputEl.value = invoice.notes || '';
    }

    // Payment history. "Collected" always reflects real job_payments money
    // (invoice.netCollected, computed server-side from that booking's
    // ledger — never algebraically backed out of totalAmount/balanceDue,
    // which would misreport a voided invoice's collected amount as
    // "fully paid" since balanceDue is hardcoded to 0 once voided).
    set('iv-collected', isDraft ? 'Not billed yet' : formatPrice(invoice.netCollected));
    set('iv-balance-due', isDraft ? '—' : formatPrice(invoice.balanceDue));
    renderPayments(jobPayments);
    var recordPaymentLink = document.getElementById('iv-record-payment-link');
    recordPaymentLink.href = '/admin/booking/?id=' + encodeURIComponent(invoice.bookingId);

    // Actions — status-gated, mirroring api/admin/booking.js's own
    // handlePatchInvoice() transition rules exactly, so the UI never
    // offers a button the server would reject.
    finalizeBtn.style.display = isDraft ? 'inline-flex' : 'none';
    sendBtn.style.display = invoice.status === 'finalized' ? 'inline-flex' : 'none';
    voidBtn.style.display = isVoid ? 'none' : 'inline-flex';

    renderDeliveryHistory(data.deliveryAttempts || []);

    loadingEl.style.display = 'none';
    detailEl.style.display = 'block';
  }

  // ---------------------------------------------------------------------
  // Phase 3 — Send history. "Accepted" means accepted BY THE EMAIL
  // PROVIDER (Resend returned success) — never "delivered to an inbox" or
  // "opened by the client," which this app has no way to know.
  // ---------------------------------------------------------------------
  var DELIVERY_STATUS_TEXT = {
    pending: 'Pending',
    accepted: 'Accepted by email provider',
    rejected: 'Rejected',
    superseded: 'Superseded by a later send',
    unrecoverable: 'Unrecoverable — needs review',
  };
  function renderDeliveryHistory(attempts) {
    var section = document.getElementById('iv-delivery-section');
    var list = document.getElementById('iv-delivery-list');
    list.innerHTML = '';
    if (!attempts.length) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';
    attempts.forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'admin-charge-row';
      var top = document.createElement('div');
      top.textContent = 'Generation ' + a.generation + ' — ' + (DELIVERY_STATUS_TEXT[a.status] || a.status) + (a.recipientEmail ? ' — ' + a.recipientEmail : '');
      row.appendChild(top);
      var meta = document.createElement('div');
      meta.className = 'admin-charge-row-meta';
      var metaParts = [];
      if (a.acceptedAt) metaParts.push('Accepted by provider: ' + formatDateTime(a.acceptedAt));
      else if (a.startedAt) metaParts.push('Started: ' + formatDateTime(a.startedAt));
      meta.textContent = metaParts.join(' · ');
      row.appendChild(meta);
      list.appendChild(row);
    });
  }

  function load() {
    return adminFetch('/api/admin/booking?resource=invoice&id=' + encodeURIComponent(invoiceId))
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not load this invoice.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return; // redirected to login
        render(body);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not load this invoice.');
      });
  }

  function patchInvoice(payload) {
    return adminFetch('/api/admin/booking?resource=invoice', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ id: invoiceId }, payload)),
    }).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return null;
      }
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) throw new Error((body && body.error) || 'That did not work.');
        return body;
      });
    });
  }

  // ---------------------------------------------------------------------
  // Line items — one shared form handles both Add and Edit (see
  // editingLineItemId above); each row's own Edit button loads its values
  // into the form rather than this page building N independent inline
  // forms.
  // ---------------------------------------------------------------------
  function startEditLineItem(li) {
    editingLineItemId = li.id;
    liDescriptionEl.value = li.description;
    liQuantityEl.value = li.quantity;
    liUnitPriceEl.value = li.unitPrice;
    lineItemFormLabel.textContent = 'Edit Line Item';
    liSaveBtn.textContent = 'Save Changes';
    liCancelBtn.style.display = 'inline-flex';
    liDescriptionEl.focus();
  }

  liCancelBtn.addEventListener('click', resetLineItemForm);

  liSaveBtn.addEventListener('click', function () {
    if (lineItemSaveInFlight) return;
    var description = liDescriptionEl.value.trim();
    if (!description) {
      showToast('A description is required.', 'error');
      return;
    }
    var quantity = Number(liQuantityEl.value);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      showToast('Please enter a valid quantity.', 'error');
      return;
    }
    var unitPrice = Number(liUnitPriceEl.value);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      showToast('Please enter a valid unit price.', 'error');
      return;
    }

    lineItemSaveInFlight = true;
    liSaveBtn.disabled = true;
    var payload = editingLineItemId
      ? { action: 'updateLineItem', lineItemId: editingLineItemId, description: description, quantity: quantity, unitPrice: unitPrice }
      : { action: 'addLineItem', description: description, quantity: quantity, unitPrice: unitPrice };

    patchInvoice(payload)
      .then(function (body) {
        if (!body) return;
        showToast(editingLineItemId ? 'Line item updated.' : 'Line item added.', 'success');
        resetLineItemForm();
        return load();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not save this line item.', 'error');
      })
      .finally(function () {
        lineItemSaveInFlight = false;
        liSaveBtn.disabled = false;
      });
  });

  function removeLineItem(lineItemId) {
    if (lineItemSaveInFlight) return;
    if (!window.confirm('Remove this line item?')) return;
    lineItemSaveInFlight = true;
    patchInvoice({ action: 'removeLineItem', lineItemId: lineItemId })
      .then(function (body) {
        if (!body) return;
        if (editingLineItemId === lineItemId) resetLineItemForm();
        showToast('Line item removed.', 'success');
        return load();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not remove this line item.', 'error');
      })
      .finally(function () {
        lineItemSaveInFlight = false;
      });
  }

  // ---------------------------------------------------------------------
  // Due date / notes
  // ---------------------------------------------------------------------
  detailsSaveBtn.addEventListener('click', function () {
    if (detailsSaveInFlight) return;
    detailsSaveInFlight = true;
    detailsSaveBtn.disabled = true;
    patchInvoice({ action: 'updateDetails', dueDate: dueDateInputEl.value, notes: notesInputEl.value })
      .then(function (body) {
        if (!body) return;
        showToast('Saved.', 'success');
        return load();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not save.', 'error');
      })
      .finally(function () {
        detailsSaveInFlight = false;
        detailsSaveBtn.disabled = false;
      });
  });

  // ---------------------------------------------------------------------
  // Finalize — irreversible (assigns a permanent invoice number and locks
  // line items/total), hence the confirm() rather than a one-tap button.
  // ---------------------------------------------------------------------
  finalizeBtn.addEventListener('click', function () {
    if (finalizeInFlight) return;
    if (!currentInvoice || !currentInvoice.dueDate) {
      showToast('Set a due date before finalizing this invoice.', 'error');
      return;
    }
    if (!window.confirm('Finalize this invoice? It will be assigned a permanent invoice number and its line items will be locked. This cannot be undone.')) return;
    finalizeInFlight = true;
    finalizeBtn.disabled = true;
    patchInvoice({ action: 'finalize' })
      .then(function (body) {
        if (!body) return;
        showToast('Invoice finalized: ' + (body.invoice && body.invoice.invoiceNumber) + '.', 'success');
        return load();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not finalize this invoice.', 'error');
      })
      .finally(function () {
        finalizeInFlight = false;
        finalizeBtn.disabled = false;
      });
  });

  // ---------------------------------------------------------------------
  // Send — emails the client a secure, token-gated view/pay link. If the
  // server reports an unresolved prior send (its own idempotency safety
  // window expired, or it couldn't be automatically decrypted), this
  // re-prompts to explicitly start a fresh attempt — the previously
  // emailed link, if delivered, stays valid until a replacement is
  // actually confirmed sent (see api/admin/booking.js's handleSendInvoice).
  // ---------------------------------------------------------------------
  function doSend(confirmNewAttempt) {
    if (sendInFlight) return;
    sendInFlight = true;
    sendBtn.disabled = true;
    patchInvoice({ action: 'send', confirmNewAttempt: !!confirmNewAttempt })
      .then(function (body) {
        sendInFlight = false;
        sendBtn.disabled = false;
        if (!body) return;
        showToast('Invoice sent to ' + body.sentTo + '.', 'success');
        return load();
      })
      .catch(function (err) {
        sendInFlight = false;
        sendBtn.disabled = false;
        var msg = err && err.message ? err.message : 'Could not send this invoice.';
        if (!confirmNewAttempt && (/unresolved/i.test(msg) || /could not be automatically recovered/i.test(msg))) {
          if (window.confirm(msg + '\n\nStart a new send attempt now? The previously emailed link, if delivered, stays valid until a replacement is confirmed sent.')) {
            doSend(true);
            return;
          }
        }
        showToast(msg, 'error');
      });
  }
  sendBtn.addEventListener('click', function () { doSend(false); });

  // ---------------------------------------------------------------------
  // Void — same "prompt for a required reason" pattern as
  // admin/booking-detail.js's voidJobPayment(), rather than a bottom
  // sheet, since this is a single free-text field. If the invoice was
  // just paid by card (reconciled as part of this same request), the
  // server asks for explicit confirmation before actually voiding.
  // ---------------------------------------------------------------------
  function doVoid(reason, confirmVoidPaidInvoice) {
    if (voidInFlight) return;
    voidInFlight = true;
    voidBtn.disabled = true;
    patchInvoice({ action: 'void', reason: reason, confirmVoidPaidInvoice: !!confirmVoidPaidInvoice })
      .then(function (body) {
        voidInFlight = false;
        voidBtn.disabled = false;
        if (!body) return;
        showToast('Invoice voided.', 'success');
        return load();
      })
      .catch(function (err) {
        voidInFlight = false;
        voidBtn.disabled = false;
        var msg = err && err.message ? err.message : 'Could not void this invoice.';
        if (!confirmVoidPaidInvoice && /just paid by card/i.test(msg)) {
          if (window.confirm(msg + '\n\nVoid anyway?')) {
            doVoid(reason, true);
            return;
          }
        }
        showToast(msg, 'error');
      });
  }
  voidBtn.addEventListener('click', function () {
    var reason = window.prompt('Reason for voiding this invoice (required):');
    if (reason === null) return; // cancelled
    reason = reason.trim();
    if (!reason) {
      showToast('A reason is required to void an invoice.', 'error');
      return;
    }
    doVoid(reason, false);
  });

  if (!invoiceId) {
    showError('Missing invoice id.');
  } else {
    load();
  }

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () { window.location.href = '/admin/login/'; });
  });

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });
});
