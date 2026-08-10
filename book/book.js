// Multi-step booking wizard for /book/. Vanilla JS, no build step, matches
// the pattern used by the on-page contact form in index.html.
document.addEventListener('DOMContentLoaded', function () {
  var TOTAL_STEPS = 6;
  var GENERIC_ERROR = 'Something went wrong submitting that — please call or text 303-990-1812.';
  var currentStep = 1;
  var state = {
    serviceType: null,
    photos: [], // File objects kept in memory for preview only — never uploaded in this iteration.
  };

  var errorBox = document.getElementById('wizard-error');
  var stepEls = Array.prototype.slice.call(document.querySelectorAll('.wizard-step'));
  var stepIndicatorEls = Array.prototype.slice.call(document.querySelectorAll('#wizard-steps li'));

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add('is-visible');
  }
  function clearError() {
    errorBox.classList.remove('is-visible');
    errorBox.textContent = '';
  }

  function goToStep(n) {
    currentStep = n;
    stepEls.forEach(function (el) {
      el.hidden = Number(el.getAttribute('data-step')) !== n;
    });
    stepIndicatorEls.forEach(function (li) {
      var s = Number(li.getAttribute('data-step'));
      li.classList.toggle('is-active', s === n);
      li.classList.toggle('is-done', s < n);
    });
    clearError();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (n === 2) showJobDetailsPanel();
    if (n === 6) renderReview();
  }

  // — STEP 1: service selection —
  var serviceRadios = Array.prototype.slice.call(document.querySelectorAll('input[name="serviceType"]'));
  serviceRadios.forEach(function (radio) {
    radio.addEventListener('change', function () {
      state.serviceType = radio.value;
    });
  });

  function showJobDetailsPanel() {
    ['junk_removal', 'dumpster_rental', 'light_demo'].forEach(function (type) {
      var panel = document.getElementById('details-' + type);
      if (panel) panel.hidden = type !== state.serviceType;
    });
  }

  // — STEP 3: photo previews (in-memory only, never uploaded) —
  var photoInput = document.getElementById('photo-input');
  var photoGrid = document.getElementById('photo-preview-grid');
  photoInput.addEventListener('change', function () {
    var files = Array.prototype.slice.call(photoInput.files || []);
    state.photos = state.photos.concat(files);
    photoInput.value = '';
    renderPhotoPreviews();
  });
  function renderPhotoPreviews() {
    photoGrid.innerHTML = '';
    state.photos.forEach(function (file, index) {
      var url = URL.createObjectURL(file);
      var wrap = document.createElement('div');
      wrap.className = 'photo-preview';
      var img = document.createElement('img');
      img.src = url;
      img.alt = 'Selected photo ' + (index + 1);
      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', 'Remove photo');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', function () {
        state.photos.splice(index, 1);
        renderPhotoPreviews();
      });
      wrap.appendChild(img);
      wrap.appendChild(removeBtn);
      photoGrid.appendChild(wrap);
    });
  }

  // — min date = today, for all date inputs —
  var todayStr = new Date().toISOString().slice(0, 10);
  ['dr-delivery', 'dr-pickup', 'pref-date'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.min = todayStr;
  });

  // — validation per step —
  function validateStep(n) {
    if (n === 1) {
      if (!state.serviceType) return 'Please choose a service to continue.';
      return null;
    }
    if (n === 2) {
      if (state.serviceType === 'junk_removal') {
        if (!val('jr-items')) return 'Please describe what needs to be removed.';
        if (!val('jr-location')) return 'Please tell us where the items are located.';
        if (!val('jr-stairs')) return 'Please select a stairs option.';
      } else if (state.serviceType === 'dumpster_rental') {
        if (!val('dr-material')) return 'Please describe the type of material.';
        if (!val('dr-delivery')) return 'Please choose a desired delivery date.';
        if (!val('dr-pickup')) return 'Please choose a desired pickup date.';
        if (val('dr-pickup') < val('dr-delivery')) return 'Pickup date must be on or after the delivery date.';
        if (!val('dr-placement')) return 'Please tell us where the dumpster should be placed.';
      } else if (state.serviceType === 'light_demo') {
        if (!val('ld-what')) return 'Please describe what needs to be demolished.';
        if (!val('ld-size')) return 'Please give an approximate size.';
        if (!val('ld-debris')) return 'Please select whether debris removal is needed.';
      }
      return null;
    }
    if (n === 3) return null; // photos optional
    if (n === 4) {
      if (!val('pref-date')) return 'Please choose a preferred appointment date.';
      if (!val('pref-window')) return 'Please choose a preferred time window.';
      return null;
    }
    if (n === 5) {
      if (!val('cust-first')) return 'First name is required.';
      if (!val('cust-last')) return 'Last name is required.';
      if (!val('cust-phone')) return 'Phone number is required.';
      if (!isValidPhone(val('cust-phone'))) return 'Please enter a valid phone number.';
      var email = val('cust-email');
      if (email && !isValidEmail(email)) return 'Please enter a valid email address.';
      if (!val('cust-address')) return 'Street address is required.';
      if (!val('cust-city')) return 'City is required.';
      if (!/^[A-Za-z]{2}$/.test(val('cust-state'))) return 'Please enter a valid 2-letter state.';
      if (!/^\d{5}(-\d{4})?$/.test(val('cust-zip'))) return 'Please enter a valid ZIP code.';
      return null;
    }
    return null;
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }
  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }
  function isValidPhone(v) {
    var digits = v.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15;
  }

  // — wire up Next/Back buttons —
  document.querySelectorAll('[data-next]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var err = validateStep(currentStep);
      if (err) {
        showError(err);
        return;
      }
      if (currentStep < TOTAL_STEPS) goToStep(currentStep + 1);
    });
  });
  document.querySelectorAll('[data-back]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (currentStep > 1) goToStep(currentStep - 1);
    });
  });

  // — review step —
  var reviewContent = document.getElementById('review-content');
  var serviceLabels = {
    junk_removal: 'Junk Removal',
    dumpster_rental: '15-Yard Dumpster Rental',
    light_demo: 'Light Demo',
  };
  var stairsLabels = { none: 'No stairs', some: 'Some stairs', multiple_flights: 'Multiple flights' };
  var windowLabels = {
    morning: 'Morning (8am–11am)',
    midday: 'Midday (11am–2pm)',
    afternoon: 'Afternoon (2pm–5pm)',
    evening: 'Evening (5pm–7pm)',
  };

  function renderReview() {
    reviewContent.innerHTML = '';
    reviewContent.appendChild(reviewGroup('Service', 1, [['Service', serviceLabels[state.serviceType] || '—']]));

    var detailRows = [];
    if (state.serviceType === 'junk_removal') {
      detailRows = [
        ['Items', val('jr-items')],
        ['Location', val('jr-location')],
        ['Stairs', stairsLabels[val('jr-stairs')] || '—'],
        ['Notes', val('jr-notes') || '—'],
      ];
    } else if (state.serviceType === 'dumpster_rental') {
      detailRows = [
        ['Material', val('dr-material')],
        ['Delivery date', val('dr-delivery')],
        ['Pickup date', val('dr-pickup')],
        ['Placement', val('dr-placement')],
        ['Notes', val('dr-notes') || '—'],
      ];
    } else if (state.serviceType === 'light_demo') {
      detailRows = [
        ['What', val('ld-what')],
        ['Approx. size', val('ld-size')],
        ['Debris removal needed', val('ld-debris') === 'yes' ? 'Yes' : 'No'],
        ['Notes', val('ld-notes') || '—'],
      ];
    }
    reviewContent.appendChild(reviewGroup('Job Details', 2, detailRows));

    reviewContent.appendChild(
      reviewGroup('Photos', 3, [['Selected photos', state.photos.length + (state.photos.length === 1 ? ' photo' : ' photos') + ' (not uploaded in this preview)']])
    );

    reviewContent.appendChild(
      reviewGroup('Preferred Date & Time', 4, [
        ['Date', val('pref-date')],
        ['Time window', windowLabels[val('pref-window')] || '—'],
      ])
    );

    reviewContent.appendChild(
      reviewGroup('Your Information', 5, [
        ['Name', val('cust-first') + ' ' + val('cust-last')],
        ['Phone', val('cust-phone')],
        ['Email', val('cust-email') || '—'],
        ['Address', val('cust-address') + ', ' + val('cust-city') + ', ' + val('cust-state').toUpperCase() + ' ' + val('cust-zip')],
      ])
    );
  }

  function reviewGroup(title, stepNum, rows) {
    var group = document.createElement('div');
    group.className = 'review-group';

    var head = document.createElement('div');
    head.className = 'review-group-head';
    var h4 = document.createElement('h4');
    h4.textContent = title;
    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'review-edit-link';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function () {
      goToStep(stepNum);
    });
    head.appendChild(h4);
    head.appendChild(editBtn);
    group.appendChild(head);

    var dl = document.createElement('dl');
    rows.forEach(function (pair) {
      var dt = document.createElement('dt');
      dt.textContent = pair[0];
      var dd = document.createElement('dd');
      dd.textContent = pair[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    group.appendChild(dl);
    return group;
  }

  // — submit —
  var submitBtn = document.getElementById('submit-booking');
  var successBox = document.getElementById('wizard-success');
  submitBtn.addEventListener('click', function () {
    clearError();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    var jobDetails = { additionalDetails: null };
    if (state.serviceType === 'junk_removal') {
      jobDetails = {
        itemsDescription: val('jr-items'),
        location: val('jr-location'),
        stairs: val('jr-stairs'),
        additionalDetails: val('jr-notes'),
      };
    } else if (state.serviceType === 'dumpster_rental') {
      jobDetails = {
        materialType: val('dr-material'),
        deliveryDate: val('dr-delivery'),
        pickupDate: val('dr-pickup'),
        placementLocation: val('dr-placement'),
        additionalDetails: val('dr-notes'),
      };
    } else if (state.serviceType === 'light_demo') {
      jobDetails = {
        demoDescription: val('ld-what'),
        approximateSize: val('ld-size'),
        debrisRemovalNeeded: val('ld-debris'),
        additionalDetails: val('ld-notes'),
      };
    }

    var payload = {
      serviceType: state.serviceType,
      jobDetails: jobDetails,
      schedule: { date: val('pref-date'), timeWindow: val('pref-window') },
      customer: {
        firstName: val('cust-first'),
        lastName: val('cust-last'),
        phone: val('cust-phone'),
        email: val('cust-email'),
        streetAddress: val('cust-address'),
        city: val('cust-city'),
        state: val('cust-state').toUpperCase(),
        zip: val('cust-zip'),
      },
    };

    fetch('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            if (!res.ok) {
              var err = new Error(body && body.error ? body.error : GENERIC_ERROR);
              err.isServerMessage = true;
              throw err;
            }
            return body;
          });
      })
      .then(function () {
        document.querySelector('.wizard-step[data-step="6"] .wizard-actions').style.display = 'none';
        reviewContent.style.display = 'none';
        successBox.classList.add('is-visible');
      })
      .catch(function (err) {
        showError(err && err.isServerMessage && err.message ? err.message : GENERIC_ERROR);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Request';
      });
  });

  goToStep(1);
});
