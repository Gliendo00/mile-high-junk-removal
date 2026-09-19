// /admin/booking/?id=<uuid> — booking detail. Read-only except for one
// control: the status badge, which PATCHes /api/admin/booking-status.
//
// Every dynamic value is written with textContent, and every link's href is
// built from a plain string assignment (never HTML concatenation), so
// customer-supplied text (name, address, description, notes) can never be
// interpreted as markup no matter what it contains.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var detailEl = document.getElementById('detail');
  var logoutBtn = document.getElementById('logout-btn');
  var toastEl = document.getElementById('admin-toast');
  var statusTrigger = document.getElementById('d-status-trigger');
  var statusLabelEl = document.getElementById('d-status-badge-label');
  var statusManageTrigger = document.getElementById('d-status-manage-trigger');
  var statusManageBadge = document.getElementById('d-status-manage-badge');
  var statusManageLabel = document.getElementById('d-status-manage-label');

  var STATUS_CLASSES = ['new', 'contacted', 'quoted', 'booked', 'completed', 'lost'];
  var STATUS_TEXT = window.AdminStatusUI.STATUS_TEXT;

  // Phase 3C Stage 2.5-v2 — display labels for rental_payments.payment_status
  // and rental_additional_charges.status. Display-only, mirroring
  // STATUS_TEXT's own pattern; never written back anywhere from this file.
  // 'error_pending_review': the Stripe call itself failed/timed out with no
  // definitive answer — outcome unknown, never auto-resolved. Labeled
  // distinctly so this never reads like an ordinary failure the admin can
  // just retry.
  // 'paid_reconciliation_required': Stripe DEFINITELY succeeded (a
  // PaymentIntent id exists) but the full local record couldn't be
  // confirmed even after retries — distinct from 'error_pending_review'
  // ("outcome unknown"), which is why the label says "Paid" up front
  // rather than "Needs Review" first.
  // 'requires_customer_action' (charges only — no equivalent state existed
  // under the original Braintree design): an off-session confirmation came
  // back requiring Strong Customer Authentication the customer isn't
  // present to complete. Recovered via the "Check Status" action below,
  // never by re-approving.
  var PAYMENT_STATUS_TEXT = {
    processing: 'Processing',
    paid: 'Paid',
    failed: 'Failed',
    voided: 'Voided',
    refunded: 'Refunded',
    error_pending_review: 'Needs Review — Check Stripe',
    paid_reconciliation_required: 'Paid — Record Incomplete, Check Stripe',
  };
  var CHARGE_STATUS_TEXT = {
    proposed: 'Proposed',
    approved: 'Approved',
    processing: 'Processing',
    paid: 'Paid',
    failed: 'Failed',
    voided: 'Voided',
    error_pending_review: 'Needs Review — Check Stripe',
    paid_reconciliation_required: 'Paid — Record Incomplete, Check Stripe',
    requires_customer_action: 'Needs Customer Authentication',
  };
  var CHARGE_TYPE_TEXT = { overweight_tonnage: 'Overweight tonnage', additional_days: 'Additional days', other: 'Other' };

  var bookingId = null;
  var currentStatus = 'new';
  var savingInFlight = false;
  var toastTimer = null;
  // 2026-09-18-v2 pricing update — this booking's own applicable overweight
  // rate schedule (data.rentalPricingContext, already resolved server-side
  // with the exact same booking-rate-first/global-fallback rule
  // api/admin/booking.js's handleProposeCharge() itself uses) and its
  // already-recorded actual scale weight, if any. Populated in render();
  // read by the weight-context live preview below. Never used to compute
  // the real charge — that's always recomputed server-side.
  var currentPricingContext = null;
  var currentActualWeightLbs = null;

  function showError(msg) {
    loadingEl.style.display = 'none';
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }

  function showToast(msg, kind) {
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = 'admin-toast is-visible' + (kind ? ' is-' + kind : '');
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
    }, 3200);
  }

  function set(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text === null || text === undefined || text === '' ? '—' : text;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch (e) {
      return iso;
    }
  }

  // Phase 3C Stage 2.5-v2 — a full timestamptz (rental_payments.
  // agreement_accepted_at), unlike formatDate()'s date-only inputs.
  function formatDateTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return iso;
    }
  }

  // Lower-case sentence-style relative time ("12 min ago"), for the
  // subtitle line — mirrors admin/dashboard.js's timeAgo() (kept as a
  // separate small copy rather than a shared import, matching the existing
  // deliberate-duplication convention documented in
  // api/_lib/booking-format.js, since these two pages load independent
  // <script> files with no bundler tying them together).
  function timeAgo(iso) {
    if (!iso) return '—';
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '—';
    var diffMs = Math.max(0, Date.now() - then);
    var mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' hr ago';
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    try {
      return 'on ' + new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // "$350" for an exact quote, "$350 – $475" for a range — never a
  // duplicated value when there's no max (Phase 3C Stage 2.5).
  function formatQuotedAmount(min, max) {
    var minText = formatPrice(min);
    if (!minText) return null;
    var maxText = formatPrice(max);
    return maxText ? minText + ' – ' + maxText : minText;
  }

  // Builds a tel: href from digits only — never from the raw display
  // string — mirroring the same safe-href pattern used server-side in
  // api/book.js's admin notification email.
  function buildTelHref(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length === 10 ? 'tel:+1' + digits : 'tel:+' + digits;
  }

  // Same digit-only normalization as buildTelHref, for the sms: launcher.
  function buildSmsHref(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length === 10 ? 'sms:+1' + digits : 'sms:+' + digits;
  }

  function getBookingId() {
    var params = new URLSearchParams(window.location.search);
    return (params.get('id') || '').trim();
  }

  function renderPhotos(photos) {
    var section = document.getElementById('d-photos-section');
    var grid = document.getElementById('d-photo-grid');
    if (!photos || !photos.length) return;
    section.style.display = 'block';
    photos.forEach(function (p) {
      if (p.url) {
        var a = document.createElement('a');
        a.href = p.url;
        a.target = '_blank';
        a.rel = 'noopener';
        var img = document.createElement('img');
        img.src = p.url;
        img.loading = 'lazy';
        img.alt = '';
        a.appendChild(img);
        grid.appendChild(a);
      } else {
        var div = document.createElement('div');
        div.className = 'admin-photo-unavailable';
        div.textContent = 'Unavailable';
        grid.appendChild(div);
      }
    });
  }

  function applyStatusDisplay(statusKey) {
    var key = STATUS_CLASSES.indexOf(statusKey) !== -1 ? statusKey : 'new';
    currentStatus = key;
    var label = STATUS_TEXT[key] || key;
    statusTrigger.className = 'admin-status-badge admin-status-' + key + ' admin-status-trigger';
    statusLabelEl.textContent = label;
    statusManageBadge.className = 'admin-status-badge admin-status-' + key;
    statusManageLabel.textContent = label;
  }

  function render(data) {
    var booking = data.booking;
    var customer = data.customer;
    var serviceAddress = data.serviceAddress || null;
    bookingId = booking.id;

    var name = customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') : '';
    set('d-name', name || 'Unknown client');

    var viewClientLink = document.getElementById('d-view-client-link');
    if (customer && booking.customerId) {
      viewClientLink.href = '/admin/client/?id=' + encodeURIComponent(booking.customerId);
      viewClientLink.style.display = 'inline-flex';
    } else {
      viewClientLink.style.display = 'none';
    }

    document.getElementById('d-edit-job-link').href = '/admin/booking-edit/?id=' + encodeURIComponent(booking.id);

    applyStatusDisplay(booking.status);

    var whenParts = [formatDate(booking.appointmentDate)];
    if (booking.timeLabel && booking.timeLabel !== '—') whenParts.push(booking.timeLabel);
    set('d-when', whenParts.join(' · '));

    var serviceCityParts = [booking.serviceLabel || booking.serviceType || ''];
    if (serviceAddress && serviceAddress.city) serviceCityParts.push(serviceAddress.city);
    set('d-subtitle', serviceCityParts.filter(Boolean).join(' · '));
    set('d-created', 'Submitted ' + timeAgo(booking.createdAt));

    var callBtn = document.getElementById('d-call-btn');
    var textBtn = document.getElementById('d-text-btn');
    var emailBtn = document.getElementById('d-email-btn');
    var directionsBtn = document.getElementById('d-directions-btn');

    function disableAction(btn) {
      btn.setAttribute('aria-disabled', 'true');
      btn.removeAttribute('href');
    }

    if (customer) {
      var phoneLink = document.getElementById('d-phone-link');
      var telHref = buildTelHref(customer.phone);
      var smsHref = buildSmsHref(customer.phone);
      if (telHref) {
        phoneLink.href = telHref;
        phoneLink.textContent = customer.phone;
        callBtn.href = telHref;
        textBtn.href = smsHref;
      } else {
        phoneLink.removeAttribute('href');
        phoneLink.textContent = customer.phone || '—';
        disableAction(callBtn);
        disableAction(textBtn);
      }

      if (customer.email) {
        document.getElementById('d-email-row').style.display = 'block';
        var emailLink = document.getElementById('d-email-link');
        emailLink.href = 'mailto:' + customer.email;
        emailLink.textContent = customer.email;
        emailBtn.href = 'mailto:' + customer.email;
      } else {
        disableAction(emailBtn);
      }
    } else {
      disableAction(callBtn);
      disableAction(textBtn);
      disableAction(emailBtn);
    }

    // Job location comes from the booking's own service-address snapshot
    // (api/admin/booking.js), never the client's current contact record —
    // this is independent of whether a customer record exists at all, so a
    // booking retains its historical job address even if the client's
    // profile is later missing or changed.
    if (serviceAddress && (serviceAddress.address || serviceAddress.city)) {
      var addressLines = [serviceAddress.address, [serviceAddress.city, serviceAddress.state, serviceAddress.zip].filter(Boolean).join(', ')]
        .filter(Boolean)
        .join('\n');
      set('d-address', addressLines);

      var mapsQuery = [serviceAddress.address, serviceAddress.city, serviceAddress.state, serviceAddress.zip].filter(Boolean).join(', ');
      if (mapsQuery) {
        directionsBtn.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapsQuery);
      } else {
        disableAction(directionsBtn);
      }
    } else {
      set('d-address', 'No service address on file.');
      disableAction(directionsBtn);
    }

    set('d-service', booking.serviceLabel);
    set('d-description', booking.description);

    var quoted = formatQuotedAmount(booking.estimatedPrice, booking.estimatedPriceMax);
    var final = formatPrice(booking.finalPrice);
    set('d-estimated-price', quoted || 'Not set yet');
    set('d-final-price', final || 'Not set yet');

    set('d-notes', booking.internalNotes || 'No internal notes yet.');

    if (data.dumpster) {
      document.getElementById('d-dumpster-section').style.display = 'block';
      set('d-delivery-date', formatDate(data.dumpster.deliveryDate));
      set('d-pickup-date', formatDate(data.dumpster.pickupDate));
      set('d-material', data.dumpster.materialType);
      set('d-placement', data.dumpster.placementNotes);
      currentActualWeightLbs = data.dumpster.actualWeightLbs != null ? data.dumpster.actualWeightLbs : null;
    }
    currentPricingContext = data.rentalPricingContext || null;
    if (chargeWeightEl && currentActualWeightLbs != null && !chargeWeightEl.value) {
      chargeWeightEl.value = currentActualWeightLbs;
    }
    updateWeightContext();

    // Phase 3C Stage 2.5-v2 — Payment (only present for a dumpster rental
    // that was booked and paid online) + Additional Charges (shown for any
    // dumpster rental, whether or not it was paid online — approving a
    // charge on one with no payment method on file just fails cleanly with
    // a clear reason, handled server-side).
    if (data.payment) {
      document.getElementById('d-payment-section').style.display = 'block';
      set('d-payment-status', PAYMENT_STATUS_TEXT[data.payment.status] || data.payment.status);
      set('d-payment-amount', formatPrice(data.payment.amountCharged) || '—');
      set('d-payment-method', data.payment.methodSummary || '—');
      set('d-payment-txn', data.payment.transactionId || '—');
      set('d-payment-agreement', data.payment.agreementVersion ? data.payment.agreementVersion + ' · ' + formatDateTime(data.payment.agreementAcceptedAt) : '—');
      if (data.payment.disputeStatus) {
        document.getElementById('d-payment-dispute-row').style.display = 'block';
        set('d-payment-dispute', data.payment.disputeStatus);
      }
      if (data.payment.failureReason) {
        document.getElementById('d-payment-reason-row').style.display = 'block';
        set('d-payment-reason', data.payment.failureReason);
      }
    }
    if (booking.serviceType === 'dumpster_rental') {
      document.getElementById('d-charges-section').style.display = 'block';
      loadCharges();
    }

    renderJobPayments(data);

    renderPhotos(data.photos);

    loadingEl.style.display = 'none';
    detailEl.style.display = 'block';
  }

  function saveStatus(newStatus) {
    if (savingInFlight || newStatus === currentStatus) return;
    savingInFlight = true;

    var targetLabel = STATUS_TEXT[newStatus] || newStatus;
    statusTrigger.disabled = true;
    statusTrigger.classList.add('is-saving');
    statusLabelEl.textContent = 'Saving to ' + targetLabel + '…';
    statusManageTrigger.disabled = true;

    fetch('/api/admin/booking-status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookingId, status: newStatus }),
    })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) {
              throw new Error((body && body.error) || 'Could not update status.');
            }
            return body;
          });
      })
      .then(function (body) {
        if (!body) return; // redirected to login
        // The badge only ever shows the server's confirmed value — never
        // the optimistically-tapped target — so a save can never visually
        // claim success before the database update is actually confirmed.
        applyStatusDisplay(body.status);
        showToast('Status updated to ' + (STATUS_TEXT[body.status] || body.status) + '.', 'success');
      })
      .catch(function (err) {
        // Nothing to revert visually: the badge was never changed to the
        // target status in the first place, only its "Saving…" state.
        applyStatusDisplay(currentStatus);
        showToast(err && err.message ? err.message : 'Could not update status. Please try again.', 'error');
      })
      .finally(function () {
        savingInFlight = false;
        statusTrigger.disabled = false;
        statusTrigger.classList.remove('is-saving');
        statusManageTrigger.disabled = false;
      });
  }

  function openStatusSheet() {
    if (savingInFlight) return;
    window.AdminStatusUI.open({
      title: 'Change status',
      selected: currentStatus,
      onSelect: saveStatus,
    });
  }

  // ---------------------------------------------------------------------
  // Phase 3C Stage 2.5-v2 — Additional Charges (propose + approve). Every
  // amount displayed here comes straight from the server response — this
  // file never computes or edits a charge amount itself, matching
  // api/admin/booking.js's own discipline of always recomputing from
  // api/_lib/rental-pricing.js rather than trusting anything client-side.
  // ---------------------------------------------------------------------
  var chargesListEl = document.getElementById('d-charges-list');
  var chargeTypeEl = document.getElementById('d-charge-type');
  var chargeQuantityRow = document.getElementById('d-charge-quantity-row');
  var chargeQuantityLabel = document.getElementById('d-charge-quantity-label');
  var chargeQuantityEl = document.getElementById('d-charge-quantity');
  var chargeWeightRow = document.getElementById('d-charge-weight-row');
  var chargeWeightEl = document.getElementById('d-charge-weight');
  var chargeWeightContext = document.getElementById('d-charge-weight-context');
  var chargeWeightIncludedEl = document.getElementById('d-charge-weight-included');
  var chargeWeightOverEl = document.getElementById('d-charge-weight-over');
  var chargeWeightRateEl = document.getElementById('d-charge-weight-rate');
  var chargeWeightAmountEl = document.getElementById('d-charge-weight-amount');
  var chargeAmountRow = document.getElementById('d-charge-amount-row');
  var chargeAmountEl = document.getElementById('d-charge-amount');
  var chargeDescriptionRow = document.getElementById('d-charge-description-row');
  var chargeDescriptionEl = document.getElementById('d-charge-description');
  var chargeProposeBtn = document.getElementById('d-charge-propose-btn');
  var chargeApproveInFlight = false;
  var chargeCheckStatusInFlight = false;

  function updateChargeFormMode() {
    var type = chargeTypeEl.value;
    var isOther = type === 'other';
    var isWeight = type === 'overweight_tonnage';
    chargeQuantityRow.style.display = !isOther && !isWeight ? '' : 'none';
    chargeWeightRow.style.display = isWeight ? '' : 'none';
    chargeAmountRow.style.display = isOther ? '' : 'none';
    chargeDescriptionRow.style.display = isOther ? '' : 'none';
    chargeQuantityLabel.textContent = 'Extra days beyond the included 5';
    if (isWeight) updateWeightContext();
  }

  // 2026-09-18-v2 pricing update — live preview only, mirroring
  // api/_lib/rental-pricing.js's overweightCharge() formula exactly
  // (max(0, actualLbs - includedTons*2000) * (rate/2000), rounded only at
  // the very end). The REAL charge is always recomputed server-side in
  // handleProposeCharge() from the same booking's own rentalPricingContext
  // — this function only ever informs what the admin sees before
  // submitting, never what actually gets charged.
  function updateWeightContext() {
    if (!chargeWeightEl || chargeTypeEl.value !== 'overweight_tonnage') return;
    var raw = chargeWeightEl.value;
    if (raw === '' || !currentPricingContext) {
      chargeWeightContext.style.display = 'none';
      return;
    }
    var actualLbs = Number(raw);
    if (!Number.isFinite(actualLbs) || actualLbs < 0) {
      chargeWeightContext.style.display = 'none';
      return;
    }
    var includedTons = Number(currentPricingContext.includedTons);
    var rate = Number(currentPricingContext.overageTonRate);
    var includedLbs = includedTons * 2000;
    var overweightLbs = Math.max(0, Math.round(actualLbs) - includedLbs);
    var amount = Math.round(overweightLbs * (rate / 2000) * 100) / 100;

    chargeWeightContext.style.display = '';
    chargeWeightIncludedEl.textContent = includedLbs.toLocaleString() + ' lbs';
    chargeWeightOverEl.textContent = overweightLbs.toLocaleString() + ' lbs';
    chargeWeightRateEl.textContent = '$' + rate.toFixed(2) + '/ton' + (currentPricingContext.isBookingSpecific ? ' (this booking’s locked-in rate)' : ' (current rate — no rate locked in for this booking)');
    chargeWeightAmountEl.textContent = amount > 0 ? formatPrice(amount) : '$0.00 — no overage charge';
  }
  chargeWeightEl.addEventListener('input', updateWeightContext);
  chargeTypeEl.addEventListener('change', updateChargeFormMode);
  updateChargeFormMode();

  function formatChargeQuantity(charge) {
    if (charge.chargeType === 'overweight_tonnage') {
      // Pounds-first display: quantity (tons) is stored at numeric(10,4)
      // precision specifically so this round-trip is exact for any
      // integer overweightLbs (see api/_lib/rental-pricing.js's
      // overweightCharge()) — a small overage now reads as "1 lb over
      // (0.0005 tons)" instead of a bare, easy-to-misread "0.0005 tons
      // over", which was the whole point of widening this column.
      var lbs = Math.round(Number(charge.quantity) * 2000);
      return lbs + ' lb' + (lbs === 1 ? '' : 's') + ' over (' + charge.quantity + ' tons) · $' + Number(charge.rate).toFixed(2) + '/ton';
    }
    if (charge.chargeType === 'additional_days') return charge.quantity + ' extra day' + (charge.quantity === 1 ? '' : 's') + ' · $' + Number(charge.rate).toFixed(2) + '/day';
    return charge.description || 'Other';
  }

  function renderCharges(charges) {
    while (chargesListEl.firstChild) chargesListEl.removeChild(chargesListEl.firstChild);
    if (!charges.length) {
      var empty = document.createElement('p');
      empty.className = 'admin-row-value';
      empty.style.color = 'var(--color-neutral-600, #82796a)';
      empty.textContent = 'No additional charges yet.';
      chargesListEl.appendChild(empty);
      return;
    }
    charges.forEach(function (charge) {
      var row = document.createElement('div');
      row.className = 'admin-charge-row';

      var top = document.createElement('div');
      top.className = 'admin-charge-row-top';
      var amountEl = document.createElement('span');
      amountEl.className = 'admin-charge-row-amount';
      amountEl.textContent = formatPrice(charge.amount) || '$0.00';
      var badge = document.createElement('span');
      badge.className = 'admin-status-badge admin-charge-status-' + charge.status;
      badge.textContent = CHARGE_STATUS_TEXT[charge.status] || charge.status;
      top.appendChild(amountEl);
      top.appendChild(badge);
      row.appendChild(top);

      var typeLine = document.createElement('div');
      typeLine.className = 'admin-charge-row-meta';
      typeLine.textContent = (CHARGE_TYPE_TEXT[charge.chargeType] || charge.chargeType) + ' — ' + formatChargeQuantity(charge);
      row.appendChild(typeLine);

      var metaLine = document.createElement('div');
      metaLine.className = 'admin-charge-row-meta';
      metaLine.textContent = 'Proposed by ' + (charge.proposedBy || '—') + ' · ' + formatDateTime(charge.proposedAt);
      row.appendChild(metaLine);

      if (charge.status === 'failed' && charge.failureReason) {
        var reasonLine = document.createElement('div');
        reasonLine.className = 'admin-charge-row-meta';
        reasonLine.style.color = '#b91c1c';
        reasonLine.textContent = 'Failed: ' + charge.failureReason;
        row.appendChild(reasonLine);
      }
      if (charge.disputeStatus) {
        var disputeLine = document.createElement('div');
        disputeLine.className = 'admin-charge-row-meta';
        disputeLine.textContent = 'Dispute: ' + charge.disputeStatus;
        row.appendChild(disputeLine);
      }

      // 'failed' (a clean decline) is retryable — the server allows
      // re-approving it. 'error_pending_review' (an ambiguous Stripe
      // outcome) and 'requires_customer_action' (Stripe-specific — the
      // off-session confirmation needs Strong Customer Authentication the
      // customer isn't present to complete) deliberately are NOT — no
      // Approve button for either; a human must resolve them via "Check
      // Status" below or the Stripe Dashboard first (see the server-side
      // comment in handleApprove for why retrying it here could
      // double-charge).
      if (charge.status === 'proposed' || charge.status === 'failed') {
        var approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.className = 'admin-btn admin-btn-outline';
        approveBtn.style.alignSelf = 'flex-start';
        approveBtn.style.marginTop = '4px';
        approveBtn.textContent = charge.status === 'failed' ? 'Retry: Approve & Charge' : 'Approve & Charge';
        approveBtn.addEventListener('click', function () {
          approveCharge(charge.id, approveBtn);
        });
        row.appendChild(approveBtn);
      }
      if (charge.status === 'requires_customer_action' || charge.status === 'error_pending_review') {
        var checkStatusBtn = document.createElement('button');
        checkStatusBtn.type = 'button';
        checkStatusBtn.className = 'admin-btn admin-btn-outline';
        checkStatusBtn.style.alignSelf = 'flex-start';
        checkStatusBtn.style.marginTop = '4px';
        checkStatusBtn.textContent = 'Check Status';
        checkStatusBtn.addEventListener('click', function () {
          checkChargeStatus(charge.id, checkStatusBtn);
        });
        row.appendChild(checkStatusBtn);
      }

      chargesListEl.appendChild(row);
    });
  }

  function loadCharges() {
    fetch('/api/admin/booking?resource=charges&bookingId=' + encodeURIComponent(bookingId))
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res.json().catch(function () { return null; });
      })
      .then(function (body) {
        if (!body) return;
        if (body.ok) renderCharges(body.charges || []);
      })
      .catch(function () {
        // Non-fatal — the rest of the page (already loaded) stays usable;
        // the charges list just stays empty rather than blocking anything.
      });
  }

  chargeProposeBtn.addEventListener('click', function () {
    var chargeType = chargeTypeEl.value;
    var body = { bookingId: bookingId, chargeType: chargeType };
    if (chargeType === 'other') {
      var amount = Number(chargeAmountEl.value);
      if (!chargeAmountEl.value || !Number.isFinite(amount) || amount <= 0) {
        showToast('Please enter a valid amount.', 'error');
        return;
      }
      if (!chargeDescriptionEl.value.trim()) {
        showToast('Please describe this charge.', 'error');
        return;
      }
      body.amount = amount;
      body.description = chargeDescriptionEl.value.trim();
    } else if (chargeType === 'overweight_tonnage') {
      // 2026-09-18-v2 pricing update — actual scale weight, not a manually
      // computed tons-over quantity. The server independently recomputes
      // and persists this; the live preview above is display-only.
      var weightRaw = chargeWeightEl.value;
      var weightLbs = Number(weightRaw);
      if (!weightRaw || !Number.isInteger(weightLbs) || weightLbs < 0) {
        showToast('Please enter a valid actual scale weight, in whole pounds.', 'error');
        return;
      }
      body.actualWeightLbs = weightLbs;
    } else {
      var quantity = Number(chargeQuantityEl.value);
      if (!chargeQuantityEl.value || !Number.isFinite(quantity) || quantity <= 0) {
        showToast('Please enter a valid quantity.', 'error');
        return;
      }
      body.quantity = quantity;
    }

    chargeProposeBtn.disabled = true;
    fetch('/api/admin/booking?resource=charges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (resBody) {
            if (!res.ok) throw new Error((resBody && resBody.error) || 'Could not propose this charge.');
            return resBody;
          });
      })
      .then(function (resBody) {
        chargeQuantityEl.value = '';
        chargeAmountEl.value = '';
        chargeDescriptionEl.value = '';
        if (resBody && resBody.weightRecorded) {
          currentActualWeightLbs = resBody.actualWeightLbs != null ? resBody.actualWeightLbs : Number(chargeWeightEl.value);
        }
        if (resBody && resBody.charge === null && resBody.weightRecorded) {
          // Weight at or under the included amount — nothing was charged,
          // only recorded. rental_additional_charges never gets a $0 row
          // (its own CHECK (amount > 0) wouldn't allow one), so this is a
          // normal, non-error outcome, not a failed charge attempt.
          showToast('Scale weight recorded — at or under the included weight, so no overage charge.', 'success');
        } else {
          showToast(chargeType === 'overweight_tonnage' ? 'Scale weight recorded and overage charge proposed.' : 'Charge proposed.', 'success');
        }
        loadCharges();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not propose this charge.', 'error');
      })
      .finally(function () {
        chargeProposeBtn.disabled = false;
      });
  });

  function approveCharge(chargeId, btn) {
    if (chargeApproveInFlight) return;
    chargeApproveInFlight = true;
    btn.disabled = true;
    btn.textContent = 'Processing…';

    fetch('/api/admin/booking?resource=charges', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: chargeId, action: 'approve' }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (resBody) {
            if (!res.ok) throw new Error((resBody && resBody.error) || 'Could not process this charge.');
            return resBody;
          });
      })
      .then(function (resBody) {
        var charge = resBody && resBody.charge;
        if (charge && charge.status === 'paid') {
          showToast('Charge approved and processed.', 'success');
        } else if (charge && charge.status === 'failed') {
          showToast('Charge declined: ' + (charge.failureReason || 'unknown reason') + '.', 'error');
        } else {
          showToast('Charge updated.', 'success');
        }
        loadCharges();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not process this charge.', 'error');
      })
      .finally(function () {
        chargeApproveInFlight = false;
      });
  }

  // Safe, non-charging reconciliation action — re-fetches the charge's
  // stored PaymentIntent status from Stripe and advances the local row to
  // match reality. Never calls confirm/capture itself (see
  // api/admin/booking.js's handleCheckStatus()), so this can be clicked any
  // number of times without risk.
  function checkChargeStatus(chargeId, btn) {
    if (chargeCheckStatusInFlight) return;
    chargeCheckStatusInFlight = true;
    btn.disabled = true;
    btn.textContent = 'Checking…';

    fetch('/api/admin/booking?resource=charges', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: chargeId, action: 'check-status' }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (resBody) {
            if (!res.ok) throw new Error((resBody && resBody.error) || 'Could not check this charge.');
            return resBody;
          });
      })
      .then(function (resBody) {
        var charge = resBody && resBody.charge;
        if (charge && charge.status === 'paid') {
          showToast('Customer completed authentication — charge is paid.', 'success');
        } else if (charge && charge.status === 'failed') {
          showToast('Customer did not complete authentication — charge failed, safely retryable.', 'error');
        } else {
          showToast('Still pending — no change yet.', 'success');
        }
        loadCharges();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not check this charge.', 'error');
      })
      .finally(function () {
        chargeCheckStatusInFlight = false;
      });
  }

  // ---------------------------------------------------------------------
  // Phase 3C Stage 3 — Payments (job_payments, the cross-service-type
  // ledger). Unlike Additional Charges above (dumpster-rental-only, its
  // own separate ?resource=charges fetch), job_payments/collectedRevenue
  // arrive already embedded in the plain booking-detail GET response — see
  // api/admin/booking.js — so no extra request is needed here, only
  // rendering. Voiding is the ONLY edit this file ever sends for an
  // existing row (amount/method/type are immutable once written — see
  // handleVoidJobPayment()'s own header for why); a correction is void,
  // then Record Payment again with the right amount/method.
  // ---------------------------------------------------------------------
  var jobPaymentsListEl = document.getElementById('d-job-payments-list');
  var paymentMethodSelectEl = document.getElementById('d-payment-method-select');
  var paymentAmountEl = document.getElementById('d-payment-amount-input');
  var paymentDateEl = document.getElementById('d-payment-date-input');
  var paymentNotesEl = document.getElementById('d-payment-notes-input');
  var paymentAddBtn = document.getElementById('d-payment-add-btn');
  var paymentAddInFlight = false;
  var paymentVoidInFlight = false;

  var JOB_PAYMENT_METHOD_TEXT = { card_stripe: 'Card (Stripe)', cash: 'Cash', zelle: 'Zelle', venmo: 'Venmo', check: 'Check', card_venmo: 'Card (Venmo)', other: 'Other' };

  // Tip (bookings.tip_amount) — restored here in the Payments section,
  // alongside Collected/Total received. Edited in place via window.prompt,
  // same lightweight pattern voidJobPayment() below already uses for its
  // one text input, rather than building a dedicated form for a single
  // field. Never touches job_payments — see handleUpdateTip()'s header in
  // api/admin/booking.js for why tip stays completely independent of the
  // ledger. Completed-only, matching the same rule the full Edit Job form
  // already enforces for this column.
  var tipAmountTextEl = document.getElementById('d-tip-amount-text');
  var tipEditBtn = document.getElementById('d-tip-edit-btn');
  var tipEditInFlight = false;
  var currentTipAmount = null;

  function renderJobPayments(data) {
    var booking = data.booking || {};
    set('d-collected-revenue', data.collectedRevenue != null ? formatPrice(data.collectedRevenue) : 'Not set yet');

    currentTipAmount = booking.tipAmount != null ? booking.tipAmount : null;
    var tipText = formatPrice(currentTipAmount);
    tipAmountTextEl.textContent = tipText || '—';
    if (currentStatus === 'completed') {
      tipEditBtn.style.display = '';
      tipEditBtn.textContent = tipText ? 'Edit' : 'Add Tip';
    } else {
      tipEditBtn.style.display = 'none';
    }

    var totalReceived = data.collectedRevenue != null || currentTipAmount != null ? (data.collectedRevenue || 0) + (currentTipAmount || 0) : null;
    set('d-total-received', totalReceived != null ? formatPrice(totalReceived) : 'Not set yet');

    while (jobPaymentsListEl.firstChild) jobPaymentsListEl.removeChild(jobPaymentsListEl.firstChild);
    var payments = data.jobPayments || [];
    if (!payments.length) {
      var empty = document.createElement('p');
      empty.className = 'admin-row-value';
      empty.style.color = 'var(--color-neutral-600, #82796a)';
      empty.textContent = 'No payments recorded yet.';
      jobPaymentsListEl.appendChild(empty);
      return;
    }

    payments.forEach(function (payment) {
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
      var metaParts = [JOB_PAYMENT_METHOD_TEXT[payment.paymentMethod] || payment.paymentMethod, formatDate(payment.paymentDate)];
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

      if (!payment.isVoided) {
        var voidBtn = document.createElement('button');
        voidBtn.type = 'button';
        voidBtn.className = 'admin-btn admin-btn-danger';
        voidBtn.style.marginTop = '6px';
        voidBtn.textContent = 'Void';
        voidBtn.addEventListener('click', function () { voidJobPayment(payment.id, voidBtn); });
        row.appendChild(voidBtn);
      }

      jobPaymentsListEl.appendChild(row);
    });
  }

  function voidJobPayment(paymentId, btn) {
    if (paymentVoidInFlight) return;
    var reason = window.prompt('Reason for voiding this payment (required):');
    if (reason === null) return; // cancelled
    reason = reason.trim();
    if (!reason) {
      showToast('A reason is required to void a payment.', 'error');
      return;
    }
    paymentVoidInFlight = true;
    btn.disabled = true;
    btn.textContent = 'Voiding…';

    fetch('/api/admin/booking?resource=job-payments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: paymentId, reason: reason }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not void this payment.');
            return body;
          });
      })
      .then(function () {
        showToast('Payment voided.', 'success');
        reloadJobPayments();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not void this payment.', 'error');
        btn.disabled = false;
        btn.textContent = 'Void';
      })
      .finally(function () {
        paymentVoidInFlight = false;
      });
  }

  // Re-fetches just the booking-detail GET (which already embeds
  // jobPayments/collectedRevenue) rather than a separate job-payments
  // endpoint call, so Collected and the list always stay in sync from one
  // source of truth after an add/void.
  function reloadJobPayments() {
    fetch('/api/admin/booking?id=' + encodeURIComponent(bookingId))
      .then(function (res) { return res.json().catch(function () { return null; }); })
      .then(function (body) {
        if (body && body.ok) renderJobPayments(body);
      })
      .catch(function () {});
  }

  tipEditBtn.addEventListener('click', function () {
    if (tipEditInFlight) return;
    var raw = window.prompt('Tip amount (leave blank to clear):', currentTipAmount != null ? String(currentTipAmount) : '');
    if (raw === null) return; // cancelled
    raw = raw.trim();
    var tipAmount;
    if (raw === '') {
      tipAmount = '';
    } else {
      var n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        showToast('Please enter a valid tip amount.', 'error');
        return;
      }
      tipAmount = n;
    }

    tipEditInFlight = true;
    tipEditBtn.disabled = true;

    fetch('/api/admin/booking?resource=tip', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookingId, tipAmount: tipAmount }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not save the tip.');
            return body;
          });
      })
      .then(function () {
        showToast('Tip saved.', 'success');
        reloadJobPayments();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not save the tip.', 'error');
      })
      .finally(function () {
        tipEditInFlight = false;
        tipEditBtn.disabled = false;
      });
  });

  paymentAddBtn.addEventListener('click', function () {
    if (paymentAddInFlight) return;
    var amount = Number(paymentAmountEl.value);
    if (!paymentAmountEl.value || !Number.isFinite(amount) || amount <= 0) {
      showToast('Please enter a valid amount.', 'error');
      return;
    }
    if (paymentMethodSelectEl.value === 'other' && !paymentNotesEl.value.trim()) {
      showToast('Please enter a description for this payment.', 'error');
      return;
    }

    paymentAddInFlight = true;
    paymentAddBtn.disabled = true;
    paymentAddBtn.textContent = 'Saving…';

    fetch('/api/admin/booking?resource=job-payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookingId: bookingId,
        amount: amount,
        paymentMethod: paymentMethodSelectEl.value,
        paymentDate: paymentDateEl.value || undefined,
        notes: paymentNotesEl.value.trim(),
      }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not save this payment.');
            return body;
          });
      })
      .then(function () {
        showToast('Payment recorded.', 'success');
        paymentAmountEl.value = '';
        paymentNotesEl.value = '';
        reloadJobPayments();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not save this payment.', 'error');
      })
      .finally(function () {
        paymentAddInFlight = false;
        paymentAddBtn.disabled = false;
        paymentAddBtn.textContent = 'Record Payment';
      });
  });

  statusTrigger.addEventListener('click', openStatusSheet);
  statusManageTrigger.addEventListener('click', openStatusSheet);

  var id = getBookingId();
  if (!id) {
    showError('Missing booking id.');
    return;
  }

  fetch('/api/admin/booking?id=' + encodeURIComponent(id))
    .then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return null;
      }
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) {
          if (!res.ok) {
            throw new Error((body && body.error) || 'Could not load this request.');
          }
          return body;
        });
    })
    .then(function (body) {
      if (!body) return; // redirected to login
      render(body);
    })
    .catch(function (err) {
      showError(err && err.message ? err.message : 'Could not load this request.');
    });

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        window.location.href = '/admin/login/';
      });
  });
});
