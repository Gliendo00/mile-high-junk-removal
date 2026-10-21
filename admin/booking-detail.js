// /admin/booking/?id=<uuid> — booking detail. Read-only except for one
// control: the status badge, which PATCHes /api/admin/booking?resource=status.
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

  var STATUS_CLASSES = ['new', 'contacted', 'quoted', 'booked', 'rental_out', 'completed', 'lost'];
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
    // Phase 5 — this charge became an invoice line item via "Create Final
    // Charges," never a direct card charge. A genuinely different terminal
    // state from "Paid" above (see api/admin/booking.js's
    // handleInvoiceCharges() header).
    invoiced: 'Invoiced',
  };
  var CHARGE_TYPE_TEXT = {
    overweight_tonnage: 'Overweight',
    additional_days: 'Extra rental days',
    relocation: 'Relocation',
    blocked_pickup: 'Blocked pickup / dry run',
    rule_violation: 'Rule violation / special handling',
    other: 'Custom charge',
  };

  var bookingId = null;
  var currentStatus = 'new';
  // Batch 2 — archive/restore + review-request state, set fresh from
  // render() on every load. Never guessed/cached across bookings.
  var currentArchivedAt = null;
  var reviewRequestInFlight = false;
  // Phase 3C Stage 4: gates 'rental_out' out of the status picker for any
  // job that isn't a dumpster rental (see openStatusSheet() below) — set
  // from the loaded booking's own serviceType in render(), never guessed.
  var currentServiceType = null;
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
  // Phase 5 — raw ISO dates (not the formatted display strings set() writes
  // into #d-delivery-date/#d-pickup-date), kept for the Extra Rental Days
  // live preview below (updateDaysContext()). Null until render() runs for
  // a dumpster_rental booking that actually has a dumpster_rentals row.
  var currentDeliveryDateIso = null;
  var currentPickupDateIso = null;

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
    currentServiceType = booking.serviceType;

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
        phoneLink.textContent = formatPhone(customer.phone);
        callBtn.href = telHref;
        textBtn.href = smsHref;
      } else {
        phoneLink.removeAttribute('href');
        phoneLink.textContent = formatPhone(customer.phone) || '—';
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

    // Batch 3 addendum — complimentary/free job tracking. Informational
    // only: never affects what's shown above as Actual Collected (which
    // already correctly reads $0.00 for a complimentary job — the server
    // forces final_price to 0 at write time).
    var complimentaryRow = document.getElementById('d-complimentary-row');
    if (booking.isComplimentary) {
      var compParts = [booking.complimentaryReasonLabel || 'Complimentary'];
      var compValueText = formatPrice(booking.complimentaryValue);
      if (compValueText) compParts.push('Value ' + compValueText);
      if (booking.complimentaryNote) compParts.push(booking.complimentaryNote);
      set('d-complimentary-value', compParts.join(' · '));
      complimentaryRow.style.display = 'block';
    } else {
      complimentaryRow.style.display = 'none';
    }

    set('d-notes', booking.internalNotes || 'No internal notes yet.');

    if (data.dumpster) {
      document.getElementById('d-dumpster-section').style.display = 'block';
      set('d-delivery-date', formatDate(data.dumpster.deliveryDate));
      // Batch 2C — a manually-overridden pickup date is called out so it's
      // never mistaken for the plain delivery+5 default (see
      // api/admin/booking.js's handleUpdate() header for the full
      // auto-vs-manual contract).
      set('d-pickup-date', formatDate(data.dumpster.pickupDate) + (data.dumpster.pickupDateIsManual ? ' (manually set)' : ''));
      set('d-material', data.dumpster.materialType);
      set('d-placement', data.dumpster.placementNotes);
      currentActualWeightLbs = data.dumpster.actualWeightLbs != null ? data.dumpster.actualWeightLbs : null;
      currentDeliveryDateIso = data.dumpster.deliveryDate || null;
      currentPickupDateIso = data.dumpster.pickupDate || null;
    }
    currentPricingContext = data.rentalPricingContext || null;
    if (chargeWeightEl && currentActualWeightLbs != null && !chargeWeightEl.value) {
      chargeWeightEl.value = currentActualWeightLbs;
    }
    updateWeightContext();
    updateDaysContext();

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

    renderArchiveState(booking);
    renderJobPayments(data);
    updateInvoiceEntryPoint(booking.serviceType);

    renderPhotos(data.photos);

    loadingEl.style.display = 'none';
    detailEl.style.display = 'block';
  }

  // The bare network call, with zero UI side effects, used by saveStatus()
  // below for every status transition EXCEPT the one to 'completed' — that
  // one goes through the shared admin/job-closeout.js instead (see
  // openCompletionCloseout() below), which carries the operational note in
  // its own identical PATCH. Resolves with the parsed response body, or
  // `null` specifically when a 401 has already redirected to /admin/login/
  // (the one case a caller must NOT treat as "nothing happened").
  function patchStatus(newStatus) {
    var body = { id: bookingId, status: newStatus };
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

  function saveStatus(newStatus) {
    if (savingInFlight || newStatus === currentStatus) return;

    savingInFlight = true;

    var targetLabel = STATUS_TEXT[newStatus] || newStatus;
    statusTrigger.disabled = true;
    statusTrigger.classList.add('is-saving');
    statusLabelEl.textContent = 'Saving to ' + targetLabel + '…';
    statusManageTrigger.disabled = true;

    patchStatus(newStatus)
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
    // 'rental_out' only makes sense for a dumpster rental — the owner
    // explicitly asked that a junk-removal/light-demo job never accidentally
    // land there. Reuses the booking's own already-loaded serviceType rather
    // than a second field/lookup. The server (api/admin/booking.js's
    // ?resource=status branch) re-checks this independently regardless of
    // what the picker offers.
    var values = window.AdminStatusUI.STATUS_ORDER.filter(function (key) {
      return key !== 'rental_out' || currentServiceType === 'dumpster_rental';
    });
    window.AdminStatusUI.open({
      title: 'Change status',
      values: values,
      selected: currentStatus,
      // Phase 4 hardening — completing a job (and ONLY that specific
      // transition — picking "Completed" again while already completed
      // is a no-op in saveStatus() anyway) opens the one coherent
      // closeout sheet instead of firing the status change immediately.
      // Every other status still saves the instant it's tapped, exactly
      // as before.
      onSelect: function (newStatus) {
        if (newStatus === 'completed' && currentStatus !== 'completed') {
          openCompletionCloseout();
        } else {
          saveStatus(newStatus);
        }
      },
    });
  }

  // ---------------------------------------------------------------------
  // CRM-only UX fix — the Job Closeout sheet (Payment + Tip + How'd it
  // go?) now lives in the shared admin/job-closeout.js, reused as-is by
  // admin/schedule.js's clickable status pill (Schedule → tap a job's
  // status → Completed) — this is the ONE implementation, not a second
  // Schedule-specific copy of it or its writes. This page no longer
  // builds its own closeout sheet DOM; it only reacts to the shared
  // module's result.
  //
  // Cancelling the shared sheet calls nothing here (onCancel/onComplete
  // are the only callbacks this page supplies), so the job's status/
  // badge is left completely untouched unless the module reports an
  // actual confirmed server-side status change via onComplete().
  // ---------------------------------------------------------------------
  function openCompletionCloseout() {
    window.AdminJobCloseout.open({
      bookingId: bookingId,
      serviceType: currentServiceType,
      onComplete: function (result) {
        applyStatusDisplay(result.status);
        var messages = ['Status updated to Completed.'];
        if (result.paymentSaved) messages.push('Payment saved.');
        if (result.paymentError) messages.push('Payment NOT saved: ' + result.paymentError);
        if (result.tipSaved) messages.push('Tip saved.');
        if (result.tipError) messages.push('Tip NOT saved: ' + result.tipError);
        var hadError = !!(result.paymentError || result.tipError);
        showToast(messages.join(' '), hadError ? 'error' : 'success');
        reloadJobPayments();
      },
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
  var chargeDaysRow = document.getElementById('d-charge-days-row');
  var chargeDaysIncludedEl = document.getElementById('d-charge-days-included');
  var chargeDaysTotalEl = document.getElementById('d-charge-days-total');
  var chargeDaysExtraEl = document.getElementById('d-charge-days-extra');
  var chargeDaysRateEl = document.getElementById('d-charge-days-rate');
  var chargeDaysAmountEl = document.getElementById('d-charge-days-amount');
  var chargeWeightRow = document.getElementById('d-charge-weight-row');
  var chargeWeightEl = document.getElementById('d-charge-weight');
  var chargeWeightContext = document.getElementById('d-charge-weight-context');
  var chargeWeightIncludedEl = document.getElementById('d-charge-weight-included');
  var chargeWeightOverEl = document.getElementById('d-charge-weight-over');
  var chargeWeightRateEl = document.getElementById('d-charge-weight-rate');
  var chargeWeightAmountEl = document.getElementById('d-charge-weight-amount');
  var chargeOverrideRow = document.getElementById('d-charge-override-row');
  var chargeOverrideAmountEl = document.getElementById('d-charge-override-amount');
  var chargeOverrideReasonEl = document.getElementById('d-charge-override-reason');
  var chargeAmountRow = document.getElementById('d-charge-amount-row');
  var chargeAmountEl = document.getElementById('d-charge-amount');
  var chargeDescriptionRow = document.getElementById('d-charge-description-row');
  var chargeDescriptionEl = document.getElementById('d-charge-description');
  var chargeProposeBtn = document.getElementById('d-charge-propose-btn');
  var chargeApproveInFlight = false;
  var chargeCheckStatusInFlight = false;
  // The 4 flat, admin-entered-amount charge types (Part 1) — all share the
  // exact same Amount+Description form fields and server validation (see
  // api/admin/booking.js's FLAT_CHARGE_TYPES).
  var FLAT_CHARGE_TYPES = ['relocation', 'blocked_pickup', 'rule_violation', 'other'];
  var RATE_BASED_CHARGE_TYPES = ['overweight_tonnage', 'additional_days'];

  function updateChargeFormMode() {
    var type = chargeTypeEl.value;
    var isFlat = FLAT_CHARGE_TYPES.indexOf(type) !== -1;
    var isWeight = type === 'overweight_tonnage';
    var isDays = type === 'additional_days';
    chargeDaysRow.style.display = isDays ? '' : 'none';
    chargeWeightRow.style.display = isWeight ? '' : 'none';
    chargeOverrideRow.style.display = RATE_BASED_CHARGE_TYPES.indexOf(type) !== -1 ? '' : 'none';
    chargeAmountRow.style.display = isFlat ? '' : 'none';
    chargeDescriptionRow.style.display = isFlat ? '' : 'none';
    if (isWeight) updateWeightContext();
    if (isDays) updateDaysContext();
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

  // Phase 5 — Extra Rental Days live preview, mirroring
  // api/_lib/rental-pricing.js's additionalDaysCharge() formula exactly
  // (plain calendar-day difference between the rental's own delivery/pickup
  // dates, never a manually typed day count). The REAL charge is always
  // recomputed server-side from the same booking's own dumpster_rentals
  // dates — this only ever informs what the admin sees before submitting.
  function updateDaysContext() {
    if (chargeTypeEl.value !== 'additional_days') return;
    if (!currentPricingContext || !currentDeliveryDateIso || !currentPickupDateIso) {
      chargeDaysTotalEl.textContent = '—';
      chargeDaysExtraEl.textContent = '—';
      chargeDaysRateEl.textContent = '—';
      chargeDaysAmountEl.textContent = 'No delivery/pickup dates on file yet.';
      return;
    }
    var includedDays = Number(currentPricingContext.includedDays);
    var rate = Number(currentPricingContext.overageDayRate);
    var deliveryMs = Date.parse(currentDeliveryDateIso + 'T00:00:00Z');
    var pickupMs = Date.parse(currentPickupDateIso + 'T00:00:00Z');
    var totalDays = Math.round((pickupMs - deliveryMs) / 86400000);
    var extraDays = Math.max(0, totalDays - includedDays);
    var amount = Math.round(extraDays * rate * 100) / 100;

    chargeDaysIncludedEl.textContent = includedDays + ' days';
    chargeDaysTotalEl.textContent = totalDays + ' day' + (totalDays === 1 ? '' : 's');
    chargeDaysExtraEl.textContent = extraDays + ' day' + (extraDays === 1 ? '' : 's');
    chargeDaysRateEl.textContent = '$' + rate.toFixed(2) + '/day' + (currentPricingContext.isDaysRateBookingSpecific ? ' (this booking’s locked-in rate)' : ' (current rate — no rate locked in for this booking)');
    chargeDaysAmountEl.textContent = amount > 0 ? formatPrice(amount) : '$0.00 — within the included rental period';
  }
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
    return charge.description || CHARGE_TYPE_TEXT[charge.chargeType] || 'Charge';
  }

  // Sum of every still-'proposed' charge — the amount "Create Final
  // Charges" would currently add to this rental's invoice. Recomputed
  // every renderCharges() call so it can never drift from what's actually
  // on screen.
  var currentCharges = [];
  function updateCloseoutSummary() {
    var dueEl = document.getElementById('d-closeout-due');
    var finalizeBtn = document.getElementById('d-closeout-finalize-btn');
    var proposed = currentCharges.filter(function (c) { return c.status === 'proposed'; });
    var total = proposed.reduce(function (sum, c) { return sum + Number(c.amount || 0); }, 0);
    dueEl.textContent = formatPrice(Math.round(total * 100) / 100) || '$0.00';
    finalizeBtn.disabled = proposed.length === 0;
  }

  function renderCharges(charges) {
    currentCharges = charges || [];
    while (chargesListEl.firstChild) chargesListEl.removeChild(chargesListEl.firstChild);
    if (!charges.length) {
      var empty = document.createElement('p');
      empty.className = 'admin-row-value';
      empty.style.color = 'var(--color-neutral-600, #82796a)';
      empty.textContent = 'No additional charges yet.';
      chargesListEl.appendChild(empty);
      updateCloseoutSummary();
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

      // Phase 5 — override audit trail (Part 2/3's "preserve the original
      // calculated information"). calculatedAmount is only ever non-null
      // when an admin actually overrode the server-computed amount.
      if (charge.calculatedAmount != null) {
        var overrideLine = document.createElement('div');
        overrideLine.className = 'admin-charge-row-meta';
        overrideLine.textContent =
          'Overridden from calculated ' + (formatPrice(charge.calculatedAmount) || '$0.00') + ' by ' + (charge.overriddenBy || '—') + ' · ' + formatDateTime(charge.overriddenAt) + (charge.overrideReason ? ' — ' + charge.overrideReason : '');
        row.appendChild(overrideLine);
      }

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
    updateCloseoutSummary();
  }

  function loadCharges() {
    adminFetch('/api/admin/booking?resource=charges&bookingId=' + encodeURIComponent(bookingId))
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
    if (FLAT_CHARGE_TYPES.indexOf(chargeType) !== -1) {
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
    }
    // additional_days — Phase 5: no client-submitted quantity at all; the
    // server always computes it from this rental's own delivery/pickup
    // dates (see updateDaysContext() above for the display-only mirror).

    // Phase 5 — optional override (overweight_tonnage/additional_days
    // only; the override row is hidden for every other type, so
    // chargeOverrideAmountEl.value is always '' for those).
    if (RATE_BASED_CHARGE_TYPES.indexOf(chargeType) !== -1 && chargeOverrideAmountEl.value.trim() !== '') {
      var overrideAmount = Number(chargeOverrideAmountEl.value);
      if (!Number.isFinite(overrideAmount) || overrideAmount <= 0) {
        showToast('Please enter a valid override amount, or leave it blank.', 'error');
        return;
      }
      body.overrideAmount = overrideAmount;
      if (chargeOverrideReasonEl.value.trim()) body.overrideReason = chargeOverrideReasonEl.value.trim();
    }

    chargeProposeBtn.disabled = true;
    adminFetch('/api/admin/booking?resource=charges', {
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
        chargeAmountEl.value = '';
        chargeDescriptionEl.value = '';
        chargeOverrideAmountEl.value = '';
        chargeOverrideReasonEl.value = '';
        if (resBody && resBody.weightRecorded) {
          currentActualWeightLbs = resBody.actualWeightLbs != null ? resBody.actualWeightLbs : Number(chargeWeightEl.value);
        }
        if (resBody && resBody.charge === null && resBody.weightRecorded) {
          // Weight at or under the included amount, no override given —
          // nothing was charged, only recorded. rental_additional_charges
          // never gets a $0 row (its own CHECK (amount > 0) wouldn't allow
          // one), so this is a normal, non-error outcome, not a failed
          // charge attempt.
          showToast('Scale weight recorded — at or under the included weight, so no overage charge.', 'success');
        } else if (resBody && resBody.charge === null && resBody.extraDaysRecorded) {
          showToast('Within the included rental period — no extra-days charge.', 'success');
        } else {
          showToast(chargeType === 'overweight_tonnage' ? 'Scale weight recorded and overage charge added.' : 'Charge added.', 'success');
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

  // Phase 5 — "Create Final Charges": turns every currently-proposed
  // charge for this rental into a line item on its own invoice. See
  // api/admin/booking.js's handleInvoiceCharges() for the full write
  // sequence; this click handler only ever sends bookingId — the server
  // decides which charges qualify and is itself idempotent against a
  // double-click (a second click simply finds nothing left to invoice).
  var closeoutFinalizeBtn = document.getElementById('d-closeout-finalize-btn');
  var closeoutResultEl = document.getElementById('d-closeout-result');
  var closeoutInFlight = false;
  closeoutFinalizeBtn.addEventListener('click', function () {
    if (closeoutInFlight) return;
    closeoutInFlight = true;
    closeoutFinalizeBtn.disabled = true;
    closeoutFinalizeBtn.textContent = 'Creating…';

    adminFetch('/api/admin/booking?resource=charges', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'invoice', bookingId: bookingId }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (resBody) {
            if (!res.ok) throw new Error((resBody && resBody.error) || 'Could not add these charges to an invoice.');
            return resBody;
          });
      })
      .then(function (resBody) {
        var invoice = resBody && resBody.invoice;
        showToast('Final charges created. Added to the invoice.', 'success');
        while (closeoutResultEl.firstChild) closeoutResultEl.removeChild(closeoutResultEl.firstChild);
        if (invoice) {
          var link = document.createElement('a');
          link.className = 'admin-btn admin-btn-outline';
          link.href = '/admin/invoice/?id=' + encodeURIComponent(invoice.id);
          link.textContent = 'View Invoice — Balance Due ' + (formatPrice(invoice.balanceDue != null ? invoice.balanceDue : invoice.totalAmount) || '$0.00');
          closeoutResultEl.appendChild(link);
          closeoutResultEl.style.display = 'block';
        }
        loadCharges();
        updateInvoiceEntryPoint(currentServiceType);
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not add these charges to an invoice.', 'error');
      })
      .finally(function () {
        closeoutInFlight = false;
        closeoutFinalizeBtn.disabled = false;
        closeoutFinalizeBtn.textContent = 'Create Final Charges';
        updateCloseoutSummary();
      });
  });

  function approveCharge(chargeId, btn) {
    if (chargeApproveInFlight) return;
    chargeApproveInFlight = true;
    btn.disabled = true;
    btn.textContent = 'Processing…';

    adminFetch('/api/admin/booking?resource=charges', {
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

    adminFetch('/api/admin/booking?resource=charges', {
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

  // Site Improvement Agent, Phase 3 — "How'd it go?" (bookings.
  // operational_note). Same completed-only, edit-in-place-via-prompt
  // pattern as Tip just above — the initial capture happens inline at the
  // moment of completion instead (see saveStatus()'s own prompt), this
  // control is only for viewing/correcting it afterward.
  var operationalNoteRow = document.getElementById('d-operational-note-row');
  var operationalNoteTextEl = document.getElementById('d-operational-note-text');
  var operationalNoteEditBtn = document.getElementById('d-operational-note-edit-btn');
  var operationalNoteEditInFlight = false;
  var currentOperationalNote = null;

  // Batch 2 — review-request tracking, same Payments-section home as Tip.
  var reviewRequestRow = document.getElementById('d-review-request-row');
  var reviewRequestCheckbox = document.getElementById('d-review-request-checkbox');
  var reviewRequestTextEl = document.getElementById('d-review-request-text');
  var currentReviewRequestSentAt = null;

  function renderJobPayments(data) {
    var booking = data.booking || {};
    // A pickup leg carries no price/revenue by design (Phase 4 Stage 1) — show
    // an explicit non-economic state instead of the generic "no ledger yet"
    // wording below, which would otherwise read as "payment still pending".
    if (booking.serviceType === 'dumpster_pickup') {
      set('d-collected-revenue', 'N/A — pickup, no charge');
    } else {
      set('d-collected-revenue', data.collectedRevenue != null ? formatPrice(data.collectedRevenue) : 'Not collected yet');
    }

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

    currentOperationalNote = booking.operationalNote || null;
    if (currentStatus === 'completed') {
      operationalNoteRow.style.display = '';
      operationalNoteTextEl.textContent = currentOperationalNote || 'Not recorded';
      operationalNoteEditBtn.textContent = currentOperationalNote ? 'Edit' : 'Add';
    } else {
      operationalNoteRow.style.display = 'none';
    }

    // Batch 2 — review-request tracking, completed jobs only (same rule as
    // Tip above). The checkbox's own change handler (below) is what
    // actually sends/clears — this only ever reflects current server state.
    if (currentStatus === 'completed') {
      reviewRequestRow.style.display = '';
      currentReviewRequestSentAt = booking.reviewRequestSentAt || null;
      reviewRequestCheckbox.checked = !!currentReviewRequestSentAt;
      reviewRequestTextEl.textContent = currentReviewRequestSentAt ? 'Sent ' + formatDateTime(currentReviewRequestSentAt) : 'Not sent';
    } else {
      reviewRequestRow.style.display = 'none';
    }

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

        // Phase 5 — Refund, only on a non-voided "payment" row (refunding
        // a refund doesn't mean anything) that still has something left to
        // refund. refundableHint is computed from this SAME already-loaded
        // list — see admin/refund-ui.js's own header for why the server
        // re-validates this independently regardless.
        if (payment.paymentType !== 'refund') {
          var alreadyRefunded = payments
            .filter(function (p) { return p.paymentType === 'refund' && !p.isVoided && p.reversesPaymentId === payment.id; })
            .reduce(function (sum, p) { return sum + Number(p.amount || 0); }, 0);
          var refundable = Math.round((Number(payment.amount) - alreadyRefunded) * 100) / 100;
          if (refundable > 0) {
            var refundBtn = document.createElement('button');
            refundBtn.type = 'button';
            refundBtn.className = 'admin-btn admin-btn-outline';
            refundBtn.style.marginTop = '6px';
            refundBtn.style.marginLeft = '8px';
            refundBtn.textContent = 'Refund';
            refundBtn.addEventListener('click', function () {
              window.AdminRefund.open({
                payment: payment,
                refundableHint: refundable,
                onComplete: function () {
                  showToast('Refund recorded.', 'success');
                  reloadJobPayments();
                },
              });
            });
            row.appendChild(refundBtn);
          }
        }
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

    adminFetch('/api/admin/booking?resource=job-payments', {
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

  // ---------------------------------------------------------------------
  // Phase 2 — Core Invoicing entry point. A pickup leg (dumpster_pickup)
  // never gets this button at all — same rule the Payments section and
  // api/admin/booking.js's handleCreateInvoice() both already enforce.
  // Otherwise: a lightweight GET ?resource=invoice&bookingId= lookup (never
  // a mutating POST just to render a label) decides the button's label —
  // Create Invoice (none yet), Open Draft Invoice, or View Invoice — and
  // where clicking it goes. Clicking when no invoice exists yet POSTs to
  // create one (idempotent on the server, so this can never race into a
  // duplicate) and navigates straight to it.
  // ---------------------------------------------------------------------
  var invoiceActionsEl = document.getElementById('d-invoice-actions');
  var invoiceLinkEl = document.getElementById('d-invoice-link');
  var invoiceCreateInFlight = false;

  function updateInvoiceEntryPoint(serviceType) {
    if (serviceType === 'dumpster_pickup') {
      invoiceActionsEl.style.display = 'none';
      return;
    }
    invoiceActionsEl.style.display = 'block';
    invoiceLinkEl.textContent = 'Loading…';
    invoiceLinkEl.removeAttribute('href');

    adminFetch('/api/admin/booking?resource=invoice&bookingId=' + encodeURIComponent(bookingId))
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not check this job\'s invoice.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return; // redirected to login
        if (body.invoice) {
          invoiceLinkEl.textContent = body.invoice.status === 'draft' ? 'Open Draft Invoice' : 'View Invoice';
          invoiceLinkEl.href = '/admin/invoice/?id=' + encodeURIComponent(body.invoice.id);
        } else {
          invoiceLinkEl.textContent = 'Create Invoice';
          invoiceLinkEl.href = '#';
        }
      })
      .catch(function () {
        // Non-fatal — the rest of Booking Detail already rendered. Falls
        // back to a plain "Create Invoice" link; clicking it still works
        // (handleCreateInvoice() is idempotent either way), it just won't
        // have pre-detected an existing draft.
        invoiceLinkEl.textContent = 'Create Invoice';
        invoiceLinkEl.href = '#';
      });
  }

  invoiceLinkEl.addEventListener('click', function (e) {
    if (invoiceLinkEl.getAttribute('href') && invoiceLinkEl.getAttribute('href') !== '#') return; // already resolved to a real invoice — plain navigation
    e.preventDefault();
    if (invoiceCreateInFlight) return;
    invoiceCreateInFlight = true;
    invoiceLinkEl.textContent = 'Creating…';

    adminFetch('/api/admin/booking?resource=invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId: bookingId }),
    })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not create an invoice for this job.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return; // redirected to login
        window.location.href = '/admin/invoice/?id=' + encodeURIComponent(body.invoice.id);
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not create an invoice for this job.', 'error');
        invoiceLinkEl.textContent = 'Create Invoice';
        invoiceCreateInFlight = false;
      });
  });

  // Re-fetches just the booking-detail GET (which already embeds
  // jobPayments/collectedRevenue) rather than a separate job-payments
  // endpoint call, so Collected and the list always stay in sync from one
  // source of truth after an add/void.
  function reloadJobPayments() {
    adminFetch('/api/admin/booking?id=' + encodeURIComponent(bookingId))
      .then(function (res) { return res.json().catch(function () { return null; }); })
      .then(function (body) {
        if (body && body.ok) renderJobPayments(body);
      })
      .catch(function () {});
  }

  // Used by the standalone Tip "Edit"/"Add Tip" control below (the
  // completion closeout sheet has its own identical PATCH ?resource=tip
  // call inside admin/job-closeout.js — same endpoint/validation, just not
  // this function, since that module is shared with pages that don't load
  // this file at all). Zero UI side effects of its own (no toast, no
  // disabling anything) — the caller handles that.
  function submitTipAmount(tipAmount) {
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

    submitTipAmount(tipAmount)
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

  // Site Improvement Agent, Phase 3 — "How'd it go?" edit-in-place,
  // same pattern as Tip just above. Blank clears it back to "Not recorded".
  operationalNoteEditBtn.addEventListener('click', function () {
    if (operationalNoteEditInFlight) return;
    var raw = window.prompt('How\'d it go? (internal note, leave blank to clear):', currentOperationalNote || '');
    if (raw === null) return; // cancelled
    raw = raw.trim();

    operationalNoteEditInFlight = true;
    operationalNoteEditBtn.disabled = true;

    adminFetch('/api/admin/booking?resource=operational-note', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookingId, operationalNote: raw }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not save this note.');
            return body;
          });
      })
      .then(function () {
        showToast('Note saved.', 'success');
        reloadJobPayments();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not save this note.', 'error');
      })
      .finally(function () {
        operationalNoteEditInFlight = false;
        operationalNoteEditBtn.disabled = false;
      });
  });

  // Batch 2 — review-request tracking. Checking sends, unchecking clears
  // (a correction, not a delete — see api/admin/booking.js's
  // handleReviewRequestAction() for why booking_audit_log keeps both
  // events). The checkbox is the whole control; no separate save button.
  reviewRequestCheckbox.addEventListener('change', function () {
    if (reviewRequestInFlight) return;
    var checking = reviewRequestCheckbox.checked;
    reviewRequestInFlight = true;
    reviewRequestCheckbox.disabled = true;

    adminFetch('/api/admin/booking?resource=review-request', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookingId, action: checking ? 'send' : 'clear' }),
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
            if (!res.ok) throw new Error((body && body.error) || 'Could not update the review request status.');
            return body;
          });
      })
      .then(function (body) {
        if (!body) return; // redirected to login
        currentReviewRequestSentAt = body.reviewRequestSentAt || null;
        reviewRequestCheckbox.checked = !!currentReviewRequestSentAt;
        reviewRequestTextEl.textContent = currentReviewRequestSentAt ? 'Sent ' + formatDateTime(currentReviewRequestSentAt) : 'Not sent';
        showToast(checking ? 'Marked as sent.' : 'Cleared.', 'success');
      })
      .catch(function (err) {
        reviewRequestCheckbox.checked = !checking; // revert the optimistic toggle
        showToast(err && err.message ? err.message : 'Could not update the review request status.', 'error');
      })
      .finally(function () {
        reviewRequestInFlight = false;
        reviewRequestCheckbox.disabled = false;
      });
  });

  // -----------------------------------------------------------------
  // Batch 2 — Archive/Restore. Built directly here (not through
  // window.AdminStatusUI, which is shaped for a flat option list with no
  // form fields) but reusing the exact same .admin-sheet-overlay/
  // .admin-sheet chrome admin/expenses.js, admin/quick-expense.js,
  // admin/client-picker.js, and admin/status-ui.js already established.
  // -----------------------------------------------------------------
  var ARCHIVE_REASON_TEXT = {
    client_canceled: 'Client canceled',
    duplicate_booking: 'Duplicate booking',
    test_spam: 'Test / spam',
    no_show: 'No-show',
    entered_by_mistake: 'Entered by mistake',
    other: 'Other',
  };
  var archiveBtn = document.getElementById('d-archive-btn');
  var restoreBtn = document.getElementById('d-restore-btn');
  var archivedInfoEl = document.getElementById('d-archived-info');

  function renderArchiveState(state) {
    currentArchivedAt = state.archivedAt || null;
    if (currentArchivedAt) {
      archiveBtn.style.display = 'none';
      restoreBtn.style.display = '';
      var parts = ['Archived ' + formatDateTime(currentArchivedAt)];
      if (state.archivedReason) parts.push('Reason: ' + (ARCHIVE_REASON_TEXT[state.archivedReason] || state.archivedReason));
      if (state.archivedNote) parts.push(state.archivedNote);
      if (state.archivedBy) parts.push('by ' + state.archivedBy);
      archivedInfoEl.textContent = parts.join(' — ');
      archivedInfoEl.classList.add('is-visible');
    } else {
      archiveBtn.style.display = '';
      restoreBtn.style.display = 'none';
      archivedInfoEl.classList.remove('is-visible');
      archivedInfoEl.textContent = '';
    }
  }

  var archiveOverlay = null;
  var archiveSheet = null;
  function ensureArchiveSheetDom() {
    if (archiveOverlay) return;
    archiveOverlay = document.createElement('div');
    archiveOverlay.className = 'admin-sheet-overlay';
    archiveOverlay.setAttribute('hidden', '');
    archiveSheet = document.createElement('div');
    archiveSheet.className = 'admin-sheet';
    archiveSheet.setAttribute('role', 'dialog');
    archiveSheet.setAttribute('aria-modal', 'true');
    archiveOverlay.appendChild(archiveSheet);
    archiveOverlay.addEventListener('click', function (e) {
      if (e.target === archiveOverlay) closeArchiveSheet();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !archiveOverlay.hasAttribute('hidden')) closeArchiveSheet();
    });
    document.body.appendChild(archiveOverlay);
  }
  function clearArchiveSheet() {
    while (archiveSheet.firstChild) archiveSheet.removeChild(archiveSheet.firstChild);
  }
  function closeArchiveSheet() {
    if (!archiveOverlay) return;
    archiveOverlay.setAttribute('hidden', '');
    clearArchiveSheet();
  }

  function openArchiveSheet() {
    ensureArchiveSheetDom();
    clearArchiveSheet();

    var title = document.createElement('div');
    title.className = 'admin-sheet-title';
    title.textContent = 'Archive Job';
    archiveSheet.appendChild(title);

    var hint = document.createElement('p');
    hint.className = 'admin-field-hint';
    hint.textContent = 'This job will be hidden from Schedule and Requests, and excluded from Booked/Revenue totals. It stays in the record permanently and can be restored at any time.';
    archiveSheet.appendChild(hint);

    var errorBox = document.createElement('div');
    errorBox.className = 'admin-alert admin-alert-error';
    archiveSheet.appendChild(errorBox);

    var reasonField = document.createElement('div');
    reasonField.className = 'admin-field';
    var reasonLabel = document.createElement('label');
    reasonLabel.setAttribute('for', 'archive-reason-select');
    reasonLabel.textContent = 'Reason';
    reasonField.appendChild(reasonLabel);
    var reasonSelect = document.createElement('select');
    reasonSelect.id = 'archive-reason-select';
    var placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = 'Select a reason…';
    reasonSelect.appendChild(placeholderOpt);
    ['client_canceled', 'duplicate_booking', 'test_spam', 'no_show', 'entered_by_mistake', 'other'].forEach(function (key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = ARCHIVE_REASON_TEXT[key];
      reasonSelect.appendChild(opt);
    });
    reasonField.appendChild(reasonSelect);
    archiveSheet.appendChild(reasonField);

    var noteField = document.createElement('div');
    noteField.className = 'admin-field';
    noteField.style.display = 'none';
    var noteLabel = document.createElement('label');
    noteLabel.setAttribute('for', 'archive-note-input');
    noteLabel.textContent = 'Note (required for Other)';
    noteField.appendChild(noteLabel);
    var noteInput = document.createElement('textarea');
    noteInput.id = 'archive-note-input';
    noteInput.rows = 2;
    noteField.appendChild(noteInput);
    archiveSheet.appendChild(noteField);

    reasonSelect.addEventListener('change', function () {
      noteField.style.display = reasonSelect.value === 'other' ? 'block' : 'none';
    });

    var actions = document.createElement('div');
    actions.className = 'admin-duplicate-card-actions';
    archiveSheet.appendChild(actions);

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'admin-btn admin-btn-danger';
    confirmBtn.textContent = 'Archive Job';
    actions.appendChild(confirmBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'admin-btn admin-btn-outline';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeArchiveSheet);
    actions.appendChild(cancelBtn);

    confirmBtn.addEventListener('click', function () {
      var reason = reasonSelect.value;
      if (!reason) {
        errorBox.textContent = 'Please choose a reason.';
        errorBox.classList.add('is-visible');
        return;
      }
      var note = noteInput.value.trim();
      if (reason === 'other' && !note) {
        errorBox.textContent = 'A note is required when the reason is Other.';
        errorBox.classList.add('is-visible');
        return;
      }
      errorBox.classList.remove('is-visible');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Archiving…';

      adminFetch('/api/admin/booking?resource=archive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: bookingId, action: 'archive', reason: reason, note: note }),
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
              if (!res.ok) throw new Error((body && body.error) || 'Could not archive this job.');
              return body;
            });
        })
        .then(function (body) {
          if (!body) return; // redirected to login
          closeArchiveSheet();
          renderArchiveState(body);
          showToast('Job archived.', 'success');
        })
        .catch(function (err) {
          errorBox.textContent = err && err.message ? err.message : 'Could not archive this job.';
          errorBox.classList.add('is-visible');
        })
        .finally(function () {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Archive Job';
        });
    });

    archiveOverlay.removeAttribute('hidden');
  }

  function openRestoreSheet() {
    ensureArchiveSheetDom();
    clearArchiveSheet();

    var title = document.createElement('div');
    title.className = 'admin-sheet-title';
    title.textContent = 'Restore Job';
    archiveSheet.appendChild(title);

    var hint = document.createElement('p');
    hint.className = 'admin-field-hint';
    hint.textContent = 'This job will reappear in Schedule/Requests and count toward Booked/Revenue again.';
    archiveSheet.appendChild(hint);

    var errorBox = document.createElement('div');
    errorBox.className = 'admin-alert admin-alert-error';
    archiveSheet.appendChild(errorBox);

    var actions = document.createElement('div');
    actions.className = 'admin-duplicate-card-actions';
    archiveSheet.appendChild(actions);

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'admin-btn admin-btn-primary';
    confirmBtn.textContent = 'Restore Job';
    actions.appendChild(confirmBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'admin-btn admin-btn-outline';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeArchiveSheet);
    actions.appendChild(cancelBtn);

    confirmBtn.addEventListener('click', function () {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Restoring…';

      adminFetch('/api/admin/booking?resource=archive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: bookingId, action: 'restore' }),
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
              if (!res.ok) throw new Error((body && body.error) || 'Could not restore this job.');
              return body;
            });
        })
        .then(function (body) {
          if (!body) return; // redirected to login
          closeArchiveSheet();
          renderArchiveState(body);
          showToast('Job restored.', 'success');
        })
        .catch(function (err) {
          errorBox.textContent = err && err.message ? err.message : 'Could not restore this job.';
          errorBox.classList.add('is-visible');
        })
        .finally(function () {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Restore Job';
        });
    });

    archiveOverlay.removeAttribute('hidden');
  }

  archiveBtn.addEventListener('click', openArchiveSheet);
  restoreBtn.addEventListener('click', openRestoreSheet);

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

    adminFetch('/api/admin/booking?resource=job-payments', {
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

  adminFetch('/api/admin/booking?id=' + encodeURIComponent(id))
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

  // A back-navigation restored from bfcache can show a stale booking (e.g.
  // after changing its status here, tapping Back to Schedule, then Forward
  // again) — force a clean reload, same reasoning as admin/dashboard.js and
  // admin/schedule.js.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });
});
