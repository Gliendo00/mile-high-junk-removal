// Shared "Mark Job Completed" closeout sheet — Payment (optional) + Tip
// (optional) + How'd it go? (optional, internal only), all in one sheet.
//
// Used by BOTH admin/booking-detail.js's Status control and
// admin/schedule.js's clickable status pill (Schedule → tap a job's status
// → Completed), so there is exactly one place this flow is built and
// exactly one place each of its writes is sent — this is the single
// implementation, not a second Schedule-specific copy of it.
//
// This module owns no booking state of its own: open() is handed a
// bookingId and submits straight to the SAME endpoints every other admin
// payment/status control already uses — no new endpoint, no duplicated
// validation or financial calculation:
//   - PATCH /api/admin/booking?resource=status      (the status change
//     itself, carrying the optional operational note in the SAME request
//     — see api/admin/booking.js's handleStatusAction())
//   - POST  /api/admin/booking?resource=job-payments (the SAME manual
//     payment-ledger entry the booking detail page's own "Record Payment"
//     control sends — identical endpoint, identical validation)
//   - PATCH /api/admin/booking?resource=tip          (the SAME tip write
//     the booking detail page's own Tip "Edit"/"Add Tip" control sends)
//
// Sequencing is deliberate: the status PATCH runs FIRST and must succeed
// before anything else is attempted. If it fails, nothing else is ever
// sent and the sheet's own error box reports it — the job is left
// completely uncompleted ("no partial complete"). Payment and tip are only
// attempted after that success; if either of THOSE then fails, the job IS
// already completed (same trade-off this app already accepted for tip
// failures before this sheet existed) — reported back to the caller via
// the result object's own paymentError/tipError rather than rolling back
// the status, since either can always be added afterward from the
// booking's own Payments section.
//
// Cancelling (the Cancel button, the overlay backdrop, or Escape) sends
// nothing at all — no status change, no payment, no tip, no note.
//
// Same DOM discipline as every other admin script: textContent only, never
// innerHTML/insertAdjacentHTML/document.write.
window.AdminJobCloseout = (function () {
  // Mirrors admin/booking/index.html's #d-payment-method-select options
  // exactly — "card_stripe" is deliberately never offered here, same as
  // there (reserved for rows the server writes itself from a real Stripe
  // collection; see api/admin/booking.js's handleCreateJobPayment()).
  var JOB_PAYMENT_METHODS = [
    { value: 'cash', label: 'Cash' },
    { value: 'zelle', label: 'Zelle' },
    { value: 'venmo', label: 'Venmo' },
    { value: 'check', label: 'Check' },
    { value: 'card_venmo', label: 'Card (Venmo)' },
    { value: 'other', label: 'Other' },
  ];

  var overlay = null;
  var sheet = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'admin-sheet-overlay';
    overlay.setAttribute('hidden', '');
    sheet = document.createElement('div');
    sheet.className = 'admin-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    overlay.appendChild(sheet);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.hasAttribute('hidden')) close();
    });
    document.body.appendChild(overlay);
  }

  function clearSheet() {
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild);
  }

  function close() {
    if (!overlay) return;
    overlay.setAttribute('hidden', '');
    clearSheet();
  }

  // ---- Network calls — zero UI side effects; callers own their own
  // toasts/badge updates via open()'s onComplete/onStatusError. ----

  function patchStatusCompleted(bookingId, operationalNote) {
    var body = { id: bookingId, status: 'completed' };
    if (operationalNote) body.operationalNote = operationalNote;
    return adminFetch('/api/admin/booking?resource=status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return null;
      }
      return res
        .json()
        .catch(function () { return null; })
        .then(function (respBody) {
          if (!res.ok) throw new Error((respBody && respBody.error) || 'Could not update status.');
          return respBody;
        });
    });
  }

  function submitTip(bookingId, tipAmount) {
    return adminFetch('/api/admin/booking?resource=tip', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookingId, tipAmount: tipAmount }),
    }).then(function (res) {
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not save the tip.');
          return body;
        });
    });
  }

  function submitPayment(bookingId, payment) {
    return adminFetch('/api/admin/booking?resource=job-payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookingId: bookingId,
        amount: payment.amount,
        paymentMethod: payment.method,
        paymentDate: payment.date || undefined,
        notes: payment.notes,
      }),
    }).then(function (res) {
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not save this payment.');
          return body;
        });
    });
  }

  // opts: { bookingId, serviceType, onComplete(result), onCancel(),
  // onStatusError(err) }
  // result = { status, paymentSaved, paymentError, tipSaved, tipError }
  //
  // Phase 4 Stage 1: a dumpster_pickup booking carries no price/revenue/tip
  // fields, by requirement — opts.serviceType === 'dumpster_pickup' skips
  // the Payment/Tip sections entirely (note-only completion) rather than
  // showing fields that would just fail server-side (see
  // api/admin/booking.js's handleCreateJobPayment()/handleUpdateTip() for
  // that same rule enforced independently, server-side).
  function open(opts) {
    opts = opts || {};
    var bookingId = opts.bookingId;
    var isPickup = opts.serviceType === 'dumpster_pickup';
    ensureDom();
    clearSheet();

    sheet.appendChild(el('div', 'admin-sheet-title', 'Mark Job Completed'));
    sheet.appendChild(el(
      'p',
      'admin-row-value',
      isPickup
        ? 'Optionally add a quick internal note — this is an operational pickup visit, which carries no payment or tip of its own.'
        : 'Optionally record a payment, a tip, and a quick internal note — all of this can also be added or edited later from the job’s detail page.'
    ));

    var errorBox = el('div', 'admin-alert admin-alert-error');
    sheet.appendChild(errorBox);
    function showFormError(msg) {
      errorBox.textContent = msg;
      errorBox.classList.add('is-visible');
    }

    var methodSelect = null;
    var amountInput = null;
    var dateInput = null;
    var paymentNotesInput = null;
    var tipInput = null;

    if (!isPickup) {
      // --- Payment (optional) ---
      sheet.appendChild(el('div', 'admin-sheet-section-label', 'Payment (optional)'));

      methodSelect = document.createElement('select');
      JOB_PAYMENT_METHODS.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        methodSelect.appendChild(opt);
      });
      var methodField = el('div', 'admin-field');
      methodField.appendChild(el('label', null, 'Method'));
      methodField.appendChild(methodSelect);
      sheet.appendChild(methodField);

      amountInput = document.createElement('input');
      amountInput.type = 'number';
      amountInput.inputMode = 'decimal';
      amountInput.min = '0.01';
      amountInput.step = '0.01';
      amountInput.placeholder = 'e.g. 250.00';
      var amountField = el('div', 'admin-field');
      amountField.appendChild(el('label', null, 'Amount'));
      amountField.appendChild(amountInput);
      sheet.appendChild(amountField);

      dateInput = document.createElement('input');
      dateInput.type = 'date';
      var dateField = el('div', 'admin-field');
      dateField.appendChild(el('label', null, 'Date'));
      dateField.appendChild(dateInput);
      sheet.appendChild(dateField);

      paymentNotesInput = document.createElement('input');
      paymentNotesInput.type = 'text';
      paymentNotesInput.maxLength = 500;
      paymentNotesInput.placeholder = 'e.g. deposit, balance, partial payment';
      var paymentNotesField = el('div', 'admin-field');
      paymentNotesField.appendChild(el('label', null, 'Notes (required for "Other")'));
      paymentNotesField.appendChild(paymentNotesInput);
      sheet.appendChild(paymentNotesField);

      // --- Tip (optional) ---
      tipInput = document.createElement('input');
      tipInput.type = 'number';
      tipInput.inputMode = 'decimal';
      tipInput.min = '0';
      tipInput.step = '0.01';
      tipInput.placeholder = 'e.g. 20.00';
      var tipField = el('div', 'admin-field');
      tipField.appendChild(el('label', null, 'Tip (optional)'));
      tipField.appendChild(tipInput);
      sheet.appendChild(tipField);
    }

    // --- How'd it go? (optional, internal only) ---
    var noteInput = document.createElement('textarea');
    noteInput.rows = 3;
    noteInput.placeholder = 'e.g. "Hot tub removal, easy backyard access, cut into sections."';
    var noteField = el('div', 'admin-field');
    noteField.appendChild(el('label', null, "How'd it go? (optional, internal only)"));
    noteField.appendChild(noteInput);
    sheet.appendChild(noteField);

    var actions = el('div', 'admin-duplicate-card-actions');
    sheet.appendChild(actions);

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'admin-btn admin-btn-primary';
    confirmBtn.textContent = 'Mark Completed';
    actions.appendChild(confirmBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'admin-btn admin-btn-outline';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () {
      close();
      if (opts.onCancel) opts.onCancel();
    });
    actions.appendChild(cancelBtn);

    confirmBtn.addEventListener('click', function () {
      errorBox.classList.remove('is-visible');

      // Payment is optional as a WHOLE — only validated once an amount is
      // actually entered, mirroring the standalone Record Payment
      // control's own rule exactly (api/admin/booking.js's
      // handleCreateJobPayment()). Neither field exists at all for a
      // pickup job (isPickup) — payment/tipAmount stay null, and nothing
      // below ever reads the (nonexistent) inputs.
      var payment = null;
      if (!isPickup) {
        var amountRaw = amountInput.value.trim();
        if (amountRaw !== '') {
          var amountNum = Number(amountRaw);
          if (!Number.isFinite(amountNum) || amountNum <= 0) {
            showFormError('Please enter a valid payment amount, or leave it blank.');
            return;
          }
          var method = methodSelect.value;
          var paymentNotes = paymentNotesInput.value.trim();
          if (method === 'other' && !paymentNotes) {
            showFormError('Please enter a description for an "Other" payment.');
            return;
          }
          payment = { amount: amountNum, method: method, date: dateInput.value || null, notes: paymentNotes };
        }
      }

      var tipAmount = null;
      if (!isPickup) {
        var tipRaw = tipInput.value.trim();
        if (tipRaw !== '') {
          var n = Number(tipRaw);
          if (!Number.isFinite(n) || n < 0) {
            showFormError('Please enter a valid tip amount, or leave it blank.');
            return;
          }
          tipAmount = n;
        }
      }
      var operationalNote = noteInput.value.trim();

      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Saving…';
      cancelBtn.disabled = true;

      patchStatusCompleted(bookingId, operationalNote || null)
        .then(function (body) {
          if (!body) return; // redirected to login — nothing more to do here

          var result = { status: body.status, paymentSaved: false, paymentError: null, tipSaved: false, tipError: null };

          var chain = Promise.resolve();
          if (payment) {
            chain = chain.then(function () {
              return submitPayment(bookingId, payment).then(
                function () { result.paymentSaved = true; },
                function (err) { result.paymentError = (err && err.message) || 'Could not save the payment.'; }
              );
            });
          }
          if (tipAmount !== null) {
            chain = chain.then(function () {
              return submitTip(bookingId, tipAmount).then(
                function () { result.tipSaved = true; },
                function (err) { result.tipError = (err && err.message) || 'Could not save the tip.'; }
              );
            });
          }

          return chain.then(function () {
            close();
            if (opts.onComplete) opts.onComplete(result);
          });
        })
        .catch(function (err) {
          showFormError((err && err.message) || 'Could not complete this job.');
          if (opts.onStatusError) opts.onStatusError(err);
        })
        .finally(function () {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Mark Completed';
          cancelBtn.disabled = false;
        });
    });

    overlay.removeAttribute('hidden');
  }

  return { open: open, close: close };
})();
