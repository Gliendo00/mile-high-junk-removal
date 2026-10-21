// Phase 5 — shared "Refund Payment" sheet, mirroring admin/job-closeout.js's
// own pattern exactly (same .admin-sheet-overlay/.admin-sheet chrome, same
// el()/ensureDom()/close() shape) — used by BOTH admin/booking-detail.js's
// Payments list and admin/invoice.js's own payments list, so there is
// exactly one place a refund is ever built/sent, not two drifting copies.
//
// Two modes, chosen purely from the original payment's own paymentMethod
// (never a user choice — see Part 6's split):
//   - "card_stripe": the Stripe-backed path. Submits
//     PATCH ?resource=job-payments {action:"refund", paymentId, amount,
//     reason, clientRequestId} — api/admin/booking.js's
//     handleRefundJobPayment() actually calls stripe.refunds.create();
//     this file never talks to Stripe directly. clientRequestId is a
//     fresh, random token generated once per sheet-open (not per click —
//     see genClientRequestId()), reused if "Confirm" is clicked more than
//     once for the SAME open sheet (e.g. a slow response, not a retry of a
//     different intent) so the server's own Stripe idempotency key stays
//     stable across that single attempt.
//   - anything else (cash/zelle/venmo/check/card_venmo/other): a MANUAL
//     refund — this CRM never moves money for these methods, only records
//     that a refund already happened some other way. Submits through the
//     SAME existing manual-payment endpoints every other manual entry
//     already uses (?resource=job-payments or ?resource=invoice-payment,
//     chosen by whether the original payment is invoice-attributed) with
//     paymentType:"refund", reversesPaymentId pointing at the original,
//     and confirmedExternalReturn:true — never a new endpoint.
//
// payment (required): the original job_payments row this refund is
// against, in the exact shape serializeJobPayment() already returns
// (id, amount, paymentMethod, bookingId, invoiceId, paymentDate). Never
// mutated here — see this module's own header note on why a refund is
// always a brand-new row, never an edit.
// refundableHint (optional): the caller's own best-effort client-side
// computation of the remaining refundable balance (original amount minus
// already-visible non-voided refund rows pointing at it), used ONLY to
// prefill the amount field and show a friendly number before the first
// network round trip — the server independently recomputes and enforces
// this authoritatively regardless of what this sheet shows or sends.
window.AdminRefund = (function () {
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

  // Not a real UUID — doesn't need to be. Just needs to be unique enough
  // per sheet-open to serve as half of a Stripe idempotency key (the other
  // half is the server's own paymentId) and match the server's
  // ^[A-Za-z0-9_-]{1,100}$ shape.
  function genClientRequestId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function formatMoney(n) {
    var num = Number(n);
    return '$' + (Number.isFinite(num) ? num.toFixed(2) : '0.00');
  }

  function submitStripeRefund(paymentId, amount, reason, clientRequestId) {
    return adminFetch('/api/admin/booking?resource=job-payments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refund', paymentId: paymentId, amount: amount, reason: reason, clientRequestId: clientRequestId }),
    }).then(function (res) {
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not process this refund.');
          return body;
        });
    });
  }

  function submitManualRefund(payment, amount, method, reason) {
    var basePayload = {
      amount: amount,
      paymentMethod: method,
      paymentType: 'refund',
      notes: reason,
      reversesPaymentId: payment.id,
      confirmedExternalReturn: true,
    };
    var url;
    var body;
    if (payment.invoiceId) {
      url = '/api/admin/booking?resource=invoice-payment';
      body = Object.assign({ invoiceId: payment.invoiceId }, basePayload);
    } else {
      url = '/api/admin/booking?resource=job-payments';
      body = Object.assign({ bookingId: payment.bookingId }, basePayload);
    }
    return adminFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res
        .json()
        .catch(function () { return null; })
        .then(function (resBody) {
          if (!res.ok) throw new Error((resBody && resBody.error) || 'Could not record this refund.');
          return resBody;
        });
    });
  }

  // opts: { payment, refundableHint, onComplete(result), onCancel() }
  // result (onComplete) = the server's { ok, jobPayment } response.
  function open(opts) {
    opts = opts || {};
    var payment = opts.payment;
    if (!payment || !payment.id) return;
    var isStripe = payment.paymentMethod === 'card_stripe';
    var clientRequestId = genClientRequestId();

    ensureDom();
    clearSheet();

    sheet.appendChild(el('div', 'admin-sheet-title', 'Refund Payment'));
    sheet.appendChild(
      el(
        'p',
        'admin-row-value',
        'Original payment: ' + (formatMoney(payment.amount) || '$0.00') + ' (' + (payment.paymentMethod || '').replace('_', ' ') + '). The original payment is never changed — this creates a separate refund entry.'
      )
    );

    var hint = opts.refundableHint;
    if (typeof hint === 'number') {
      sheet.appendChild(el('p', 'admin-row-value', 'Remaining refundable balance: ' + formatMoney(hint)));
    }

    var errorBox = el('div', 'admin-alert admin-alert-error');
    sheet.appendChild(errorBox);
    function showFormError(msg) {
      errorBox.textContent = msg;
      errorBox.classList.add('is-visible');
    }

    var amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.inputMode = 'decimal';
    amountInput.min = '0.01';
    amountInput.step = '0.01';
    if (typeof hint === 'number' && hint > 0) amountInput.value = hint.toFixed(2);
    var amountField = el('div', 'admin-field');
    amountField.appendChild(el('label', null, 'Refund amount'));
    amountField.appendChild(amountInput);
    sheet.appendChild(amountField);

    var methodSelect = null;
    if (!isStripe) {
      methodSelect = document.createElement('select');
      JOB_PAYMENT_METHODS.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        if (m.value === payment.paymentMethod) opt.selected = true;
        methodSelect.appendChild(opt);
      });
      var methodField = el('div', 'admin-field');
      methodField.appendChild(el('label', null, 'Refund method'));
      methodField.appendChild(methodSelect);
      sheet.appendChild(methodField);
    }

    var reasonInput = document.createElement('input');
    reasonInput.type = 'text';
    reasonInput.maxLength = 300;
    reasonInput.placeholder = 'e.g. customer canceled, overcharged, goodwill adjustment';
    var reasonField = el('div', 'admin-field');
    reasonField.appendChild(el('label', null, 'Reason'));
    reasonField.appendChild(reasonInput);
    sheet.appendChild(reasonField);

    var confirmCheckbox = null;
    if (!isStripe) {
      var confirmRow = el('label', 'admin-checkbox-row');
      confirmCheckbox = document.createElement('input');
      confirmCheckbox.type = 'checkbox';
      confirmRow.appendChild(confirmCheckbox);
      confirmRow.appendChild(el('span', null, 'I confirm this amount was already returned to the customer outside the CRM. This only records the refund — it does not move any money.'));
      sheet.appendChild(confirmRow);
    } else {
      sheet.appendChild(el('p', 'admin-row-value', 'This will refund the customer’s card through Stripe.'));
    }

    var actions = el('div', 'admin-duplicate-card-actions');
    sheet.appendChild(actions);

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'admin-btn admin-btn-danger';
    confirmBtn.textContent = isStripe ? 'Refund via Stripe' : 'Record Refund';
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

      var amountRaw = amountInput.value.trim();
      var amountNum = Number(amountRaw);
      if (!amountRaw || !Number.isFinite(amountNum) || amountNum <= 0) {
        showFormError('Please enter a valid refund amount.');
        return;
      }
      var reason = reasonInput.value.trim();
      if (!reason) {
        showFormError('Please enter a reason for this refund.');
        return;
      }
      if (!isStripe && (!confirmCheckbox || !confirmCheckbox.checked)) {
        showFormError('Please confirm the money was already returned to the customer outside the CRM.');
        return;
      }

      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Processing…';
      cancelBtn.disabled = true;

      var submit = isStripe ? submitStripeRefund(payment.id, amountNum, reason, clientRequestId) : submitManualRefund(payment, amountNum, methodSelect.value, reason);

      submit
        .then(function (body) {
          close();
          if (opts.onComplete) opts.onComplete(body);
        })
        .catch(function (err) {
          showFormError((err && err.message) || 'Could not process this refund.');
          confirmBtn.disabled = false;
          confirmBtn.textContent = isStripe ? 'Refund via Stripe' : 'Record Refund';
          cancelBtn.disabled = false;
        });
    });

    overlay.removeAttribute('hidden');
  }

  return { open: open, close: close };
})();
