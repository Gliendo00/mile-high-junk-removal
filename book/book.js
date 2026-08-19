// Multi-step booking wizard for /book/. Vanilla JS, no build step, matches
// the pattern used by the on-page contact form in index.html.
document.addEventListener('DOMContentLoaded', function () {
  var TOTAL_STEPS = 6;
  var GENERIC_ERROR = 'Something went wrong submitting that — please call or text 303-990-1812.';
  var currentStep = 1;
  var state = {
    serviceType: null,
    photos: [], // File objects kept in memory until submit; uploaded only after the booking is confirmed.
  };

  // GA4: booking flow entered. Fires once per page load — not on step
  // navigation — since this runs a single time here, not inside goToStep().
  if (typeof window.gtag === 'function') {
    window.gtag('event', 'booking_started');
  }

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
    if (n === 2) { showJobDetailsPanel(); dumpsterDeliveryPicker.init(); }
    if (n === 4) prefDateTimePicker.init();
    if (n === 6) renderReview();
  }

  // Dumpster rental collects its delivery date + time window together in
  // step 2, so step 4 (the generic Date & Time step) doesn't apply to it.
  function nextStepNumber(n) {
    var next = n + 1;
    if (next === 4 && state.serviceType === 'dumpster_rental') next = 5;
    return next;
  }
  function prevStepNumber(n) {
    var prev = n - 1;
    if (prev === 4 && state.serviceType === 'dumpster_rental') prev = 3;
    return prev;
  }

  // — STEP 1: service selection —
  var serviceRadios = Array.prototype.slice.call(document.querySelectorAll('input[name="serviceType"]'));
  serviceRadios.forEach(function (radio) {
    radio.addEventListener('change', function () {
      state.serviceType = radio.value;
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'booking_service_selected', { service_type: radio.value });
      }
    });
  });

  function showJobDetailsPanel() {
    ['junk_removal', 'dumpster_rental', 'light_demo'].forEach(function (type) {
      var panel = document.getElementById('details-' + type);
      if (panel) panel.hidden = type !== state.serviceType;
    });
  }

  // — STEP 3: photo selection + local previews. Photos are uploaded after the
  // booking itself is confirmed (see the submit handler below) — never before.
  var MAX_PHOTOS = 6;
  var ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  var photoInput = document.getElementById('photo-input');
  var photoGrid = document.getElementById('photo-preview-grid');
  var photoSelectNote = document.getElementById('photo-select-note');
  photoInput.addEventListener('change', function () {
    var incoming = Array.prototype.slice.call(photoInput.files || []);
    photoInput.value = '';

    var accepted = incoming.filter(function (f) {
      return ALLOWED_PHOTO_TYPES.indexOf(f.type) !== -1;
    });
    var rejectedType = incoming.length - accepted.length;

    var room = MAX_PHOTOS - state.photos.length;
    var toAdd = accepted.slice(0, Math.max(0, room));
    var rejectedCap = accepted.length - toAdd.length;

    state.photos = state.photos.concat(toAdd);

    if (rejectedType > 0 || rejectedCap > 0) {
      var msgs = [];
      if (rejectedType > 0) msgs.push(rejectedType + (rejectedType === 1 ? ' file wasn’t a supported photo type (JPG, PNG, WEBP only).' : ' files weren’t a supported photo type (JPG, PNG, WEBP only).'));
      if (rejectedCap > 0) msgs.push('Only ' + MAX_PHOTOS + ' photos allowed — ' + rejectedCap + (rejectedCap === 1 ? ' photo was' : ' photos were') + ' not added.');
      photoSelectNote.textContent = msgs.join(' ');
      photoSelectNote.hidden = false;
    } else {
      photoSelectNote.hidden = true;
    }

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
    photoInput.disabled = state.photos.length >= MAX_PHOTOS;
  }

  // — client-side compression, purely a convenience so customers never have to
  // manually resize phone photos. The server independently re-enforces the 4MB
  // cap, MIME/magic-byte checks, and photo count regardless of what the client
  // sends — this pipeline is not a security boundary.
  var UPLOAD_MAX_BYTES = 4 * 1024 * 1024; // must match api/upload-photo.js
  var COMPRESS_TRIGGER_BYTES = 3.8 * 1024 * 1024; // only bother compressing if already close to/over the cap
  var COMPRESS_TARGET_BYTES = 3.5 * 1024 * 1024; // aim comfortably under the server's 4MB limit
  var MAX_DIMENSION = 2000; // px, longer side — plenty of detail for evaluating a job, far smaller than a typical phone original
  var JPEG_QUALITY_STEPS = [0.82, 0.7, 0.55, 0.4];

  // Returns a Promise<Blob> ready to upload. Never rejects for "just didn't
  // need compressing" — only rejects on a genuine failure (bad/corrupt image),
  // which the caller treats as "this one photo failed" without touching the
  // booking itself.
  function prepareFileForUpload(file) {
    if (file.size <= COMPRESS_TRIGGER_BYTES) {
      return Promise.resolve(file);
    }
    return compressImage(file).catch(function () {
      // Fall back to the original file — the server will reject it if it's
      // still over the limit, which surfaces as a normal per-photo failure.
      return file;
    });
  }

  function compressImage(file) {
    return loadImageSource(file).then(function (source) {
      var width = source.naturalWidth || source.width;
      var height = source.naturalHeight || source.height;
      if (!width || !height) throw new Error('Could not read image dimensions.');

      var scale = Math.min(1, MAX_DIMENSION / Math.max(width, height)); // never upscale
      var targetWidth = Math.max(1, Math.round(width * scale));
      var targetHeight = Math.max(1, Math.round(height * scale));

      var canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
      if (typeof source.close === 'function') source.close(); // release ImageBitmap memory

      return compressToTargetSize(canvas, 0);
    });
  }

  function compressToTargetSize(canvas, stepIndex) {
    if (stepIndex >= JPEG_QUALITY_STEPS.length) {
      return Promise.reject(new Error('Could not compress photo under the size limit.'));
    }
    return canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY_STEPS[stepIndex]).then(function (blob) {
      if (!blob) return Promise.reject(new Error('Compression produced no output.'));
      if (blob.size <= COMPRESS_TARGET_BYTES) return blob;
      return compressToTargetSize(canvas, stepIndex + 1);
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(function (blob) {
          resolve(blob);
        }, type, quality);
      } catch (err) {
        reject(err);
      }
    });
  }

  function loadImageSource(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).catch(function () {
        return loadImageViaElement(file);
      });
    }
    return loadImageViaElement(file);
  }

  function loadImageViaElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not load image.'));
      };
      img.src = url;
    });
  }

  // Uploads one photo, returning a Promise<boolean> that resolves to whether
  // it succeeded — never rejects, so one failure can't stop the others.
  function uploadPhoto(uploadToken, file) {
    return prepareFileForUpload(file)
      .then(function (blobToUpload) {
        var photoType = blobToUpload.type || file.type;
        return fetch('/api/upload-photo', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + uploadToken,
            'Content-Type': 'application/octet-stream',
            'X-Photo-Type': photoType,
          },
          body: blobToUpload,
        });
      })
      .then(function (res) {
        return res.ok;
      })
      .catch(function () {
        return false;
      });
  }

  // Uploads all selected photos sequentially (simpler and avoids any race on
  // the server's per-booking photo-count check). Reports progress via callback
  // and resolves to the number that succeeded — never rejects.
  function uploadAllPhotos(uploadToken, photos, onProgress) {
    var successCount = 0;
    var chain = Promise.resolve();
    photos.forEach(function (file, index) {
      chain = chain.then(function () {
        onProgress(index + 1, photos.length);
        return uploadPhoto(uploadToken, file).then(function (ok) {
          if (ok) successCount++;
        });
      });
    });
    return chain.then(function () {
      return successCount;
    });
  }

  // — min date = today, for the remaining native date input (dumpster pickup) —
  var todayStr = new Date().toISOString().slice(0, 10);
  var drPickupInput = document.getElementById('dr-pickup');
  if (drPickupInput) drPickupInput.min = todayStr;

  // — date & time bubbles (junk removal / light demo step 4, and the dumpster
  // rental delivery date/window in step 2) — replacing native date inputs and
  // the old broad morning/midday/afternoon/evening dropdowns. Same-day
  // availability is evaluated in America/Denver local time regardless of the
  // visitor's own timezone.
  var DENVER_TZ = 'America/Denver';
  var ARRIVAL_WINDOWS = [
    { id: 'w_0400_0600', label: '4:00 AM – 6:00 AM', startHour: 4 },
    { id: 'w_0600_0800', label: '6:00 AM – 8:00 AM', startHour: 6 },
    { id: 'w_0800_1000', label: '8:00 AM – 10:00 AM', startHour: 8 },
    { id: 'w_1000_1200', label: '10:00 AM – 12:00 PM', startHour: 10 },
    { id: 'w_1200_1400', label: '12:00 PM – 2:00 PM', startHour: 12 },
    { id: 'w_1400_1600', label: '2:00 PM – 4:00 PM', startHour: 14 },
    { id: 'w_1600_1800', label: '4:00 PM – 6:00 PM', startHour: 16 },
    { id: 'w_1800_2000', label: '6:00 PM – 8:00 PM', startHour: 18 },
    { id: 'w_2000_2200', label: '8:00 PM – 10:00 PM', startHour: 20 },
  ];
  // Dumpster rental delivery only offers 6am–8pm starts — no 4–6am or
  // 8–10pm — while junk removal / light demo keep the full 4am–10pm range.
  var DUMPSTER_DELIVERY_WINDOWS = ARRIVAL_WINDOWS.filter(function (w) {
    return w.id !== 'w_0400_0600' && w.id !== 'w_2000_2200';
  });
  var DATE_BUBBLE_COUNT = 14; // ~2 weeks of selectable dates

  function getDenverNow() {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: DENVER_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    var parts = {};
    fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    var hour = parseInt(parts.hour, 10);
    if (hour === 24) hour = 0; // some engines report midnight as "24" with hour12:false
    return {
      year: parseInt(parts.year, 10),
      month: parseInt(parts.month, 10),
      day: parseInt(parts.day, 10),
      hour: hour,
      minute: parseInt(parts.minute, 10),
    };
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  // Returns a UTC-midnight Date representing the calendar date `offsetDays`
  // after Denver's current date. Using UTC internally (anchored on Denver's
  // y/m/d) keeps calendar-day arithmetic simple and immune to the browser's
  // own timezone — every format/read of this Date below explicitly uses
  // timeZone: 'UTC' so nothing silently reinterprets it.
  function denverDateAtOffset(offsetDays) {
    var now = getDenverNow();
    var d = new Date(Date.UTC(now.year, now.month - 1, now.day));
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d;
  }
  function isoDate(d) {
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  // Windows (from the given list) available for the date at `offsetDays` from
  // Denver "today". For today (offset 0), a window disappears once its start
  // time has passed; future dates always show the full list.
  function windowsForDate(offsetDays, windows) {
    if (offsetDays > 0) return windows.slice();
    var now = getDenverNow();
    var nowDecimalHour = now.hour + now.minute / 60;
    return windows.filter(function (w) { return w.startHour > nowDecimalHour; });
  }
  function firstOffsetWithWindows(windows) {
    for (var i = 0; i < DATE_BUBBLE_COUNT; i++) {
      if (windowsForDate(i, windows).length > 0) return i;
    }
    return 0;
  }

  // Builds one date-bubbles + time-bubbles picker wired to a given pair of
  // hidden inputs. Used twice below: once for the junk removal / light demo
  // preferred date (step 4), once for the dumpster rental delivery date
  // (step 2) — each keeps its own selection and its own list of windows.
  function createDateTimePicker(opts) {
    var dateRowEl = opts.dateRowEl;
    var timeGridEl = opts.timeGridEl;
    var dateInput = document.getElementById(opts.dateInputId);
    var windowInput = document.getElementById(opts.windowInputId);
    var windows = opts.windows;
    var emptyMessage = opts.emptyMessage;
    var selectedOffset = null; // null until this picker has been initialized once

    function renderDateBubbles() {
      if (!dateRowEl) return;
      dateRowEl.innerHTML = '';
      for (var i = 0; i < DATE_BUBBLE_COUNT; i++) {
        var d = denverDateAtOffset(i);
        var weekday = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
        var month = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'date-bubble';
        btn.setAttribute('data-offset', i);
        if (i === selectedOffset) btn.classList.add('is-selected');
        btn.innerHTML =
          '<span class="db-weekday">' + weekday + '</span>' +
          '<span class="db-month">' + month + '</span>' +
          '<span class="db-day">' + d.getUTCDate() + '</span>';
        btn.addEventListener('click', function () {
          selectDate(Number(this.getAttribute('data-offset')));
        });
        dateRowEl.appendChild(btn);
      }
    }

    function selectDate(offset) {
      var wasChanged = selectedOffset !== offset;
      selectedOffset = offset;
      dateInput.value = isoDate(denverDateAtOffset(offset));
      Array.prototype.forEach.call(dateRowEl.querySelectorAll('.date-bubble'), function (b) {
        b.classList.toggle('is-selected', Number(b.getAttribute('data-offset')) === offset);
      });

      // Drop a previously chosen window if it no longer applies to the new
      // date (e.g. it just expired for today, or the date changed entirely).
      var stillAvailable = windowsForDate(offset, windows).some(function (w) { return w.id === windowInput.value; });
      if (!stillAvailable) windowInput.value = '';

      renderTimeBubbles(offset);

      if (wasChanged && typeof window.gtag === 'function') {
        window.gtag('event', 'booking_date_selected');
      }
    }

    function renderTimeBubbles(offset) {
      if (!timeGridEl) return;
      var available = windowsForDate(offset, windows);
      var selected = windowInput.value;
      timeGridEl.innerHTML = '';
      if (!available.length) {
        var empty = document.createElement('p');
        empty.className = 'time-bubble-empty';
        empty.textContent = emptyMessage;
        timeGridEl.appendChild(empty);
        return;
      }
      available.forEach(function (w) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'time-bubble';
        btn.textContent = w.label;
        if (w.id === selected) btn.classList.add('is-selected');
        btn.addEventListener('click', function () {
          windowInput.value = w.id;
          Array.prototype.forEach.call(timeGridEl.querySelectorAll('.time-bubble'), function (b) {
            b.classList.toggle('is-selected', b === btn);
          });
        });
        timeGridEl.appendChild(btn);
      });
    }

    // Called every time this picker's step is shown. The very first time,
    // default to the next date/time that actually has an available window
    // (today, unless today's windows have all passed — then the next date
    // with windows) so the visitor never lands on an empty state. After
    // that, re-render around whatever they've already chosen rather than
    // resetting their selection.
    function init() {
      if (selectedOffset === null) {
        selectedOffset = firstOffsetWithWindows(windows);
        renderDateBubbles();
        dateInput.value = isoDate(denverDateAtOffset(selectedOffset));
        renderTimeBubbles(selectedOffset);
      } else {
        renderDateBubbles();
        renderTimeBubbles(selectedOffset);
      }
    }

    return { init: init };
  }

  var prefDateTimePicker = createDateTimePicker({
    dateRowEl: document.getElementById('date-bubble-row'),
    timeGridEl: document.getElementById('time-bubble-grid'),
    dateInputId: 'pref-date',
    windowInputId: 'pref-window',
    windows: ARRIVAL_WINDOWS,
    emptyMessage: 'No more arrival windows today — please choose another date above.',
  });
  var dumpsterDeliveryPicker = createDateTimePicker({
    dateRowEl: document.getElementById('dr-delivery-date-bubble-row'),
    timeGridEl: document.getElementById('dr-delivery-time-bubble-grid'),
    dateInputId: 'dr-delivery',
    windowInputId: 'dr-window',
    windows: DUMPSTER_DELIVERY_WINDOWS,
    emptyMessage: 'No more delivery windows today — please choose another date above.',
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
        if (!val('dr-window')) return 'Please choose a preferred delivery time window.';
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
      if (!val('pref-date')) return 'Please choose a preferred date.';
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
      var next = nextStepNumber(currentStep);
      if (next <= TOTAL_STEPS) goToStep(next);
    });
  });
  document.querySelectorAll('[data-back]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var prev = prevStepNumber(currentStep);
      if (prev >= 1) goToStep(prev);
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
  // The legacy morning/midday/afternoon/evening keys are no longer written
  // by any current step, but are kept here in case an older in-progress
  // booking (loaded from a stale cached copy of this page) still submits
  // one. The w_* entries are the current 2-hour arrival/delivery windows,
  // shared by the step-4 preferred date & time and the dumpster rental
  // delivery date & time (dr-window).
  var windowLabels = {
    morning: 'Morning (8am–11am)',
    midday: 'Midday (11am–2pm)',
    afternoon: 'Afternoon (2pm–5pm)',
    evening: 'Evening (5pm–7pm)',
  };
  ARRIVAL_WINDOWS.forEach(function (w) { windowLabels[w.id] = w.label; });

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
        ['Desired delivery date', val('dr-delivery')],
        ['Preferred delivery window', windowLabels[val('dr-window')] || '—'],
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
      reviewGroup('Photos', 3, [
        ['Selected photos', state.photos.length ? state.photos.length + (state.photos.length === 1 ? ' photo, uploaded after you submit' : ' photos, uploaded after you submit') : 'None selected'],
      ])
    );

    // Dumpster rental's delivery date + time window are already shown above
    // under Job Details (step 2) — step 4 doesn't apply to it, so this group
    // is skipped entirely rather than showing an empty/redundant entry.
    if (state.serviceType !== 'dumpster_rental') {
      reviewContent.appendChild(
        reviewGroup('Preferred Date & Time', 4, [
          ['Date', val('pref-date')],
          ['Time window', windowLabels[val('pref-window')] || '—'],
        ])
      );
    }

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
  var photoUploadStatus = document.getElementById('photo-upload-status');
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

    var timeWindow = state.serviceType === 'dumpster_rental' ? val('dr-window') : val('pref-window');
    var payload = {
      serviceType: state.serviceType,
      jobDetails: jobDetails,
      schedule: { date: val('pref-date'), timeWindow: timeWindow },
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
      .then(function (body) {
        // The booking itself is confirmed the moment we get here — everything
        // below is best-effort photo upload and must never undo that.
        document.querySelector('.wizard-step[data-step="6"] .wizard-actions').style.display = 'none';
        reviewContent.style.display = 'none';
        successBox.classList.add('is-visible');

        // GA4: the most important conversion event. Fires exactly once, only
        // after the backend has confirmed the booking was saved (never on
        // validation failure, a failed request, or mere submit-click) — the
        // submit button also stays disabled from here on, so this branch
        // can't be re-entered by a second click.
        if (typeof window.gtag === 'function') {
          window.gtag('event', 'booking_form_completed');
        }

        var uploadToken = body && body.uploadToken;
        var photos = state.photos;

        if (!photos.length) return;

        if (!uploadToken) {
          // Defensive fallback — shouldn't happen once upload is configured,
          // but the booking must never appear to have failed because of this.
          photoUploadStatus.textContent = 'Photos could not be uploaded automatically. Please text them to 303-990-1812.';
          photoUploadStatus.hidden = false;
          return;
        }

        photoUploadStatus.hidden = false;
        photoUploadStatus.textContent = 'Uploading photo 1 of ' + photos.length + '…';

        uploadAllPhotos(uploadToken, photos, function (current, total) {
          photoUploadStatus.textContent = 'Uploading photo ' + current + ' of ' + total + '…';
        }).then(function (successCount) {
          if (successCount === photos.length) {
            photoUploadStatus.textContent = photos.length === 1 ? '1 of 1 photo uploaded.' : successCount + ' of ' + photos.length + ' photos uploaded.';
          } else {
            photoUploadStatus.textContent = successCount + ' of ' + photos.length + ' photos uploaded. The rest didn’t make it — no problem, text them to 303-990-1812 and we’ll add them to your booking.';
          }
        });
      })
      .catch(function (err) {
        showError(err && err.isServerMessage && err.message ? err.message : GENERIC_ERROR);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Request';
      });
  });

  goToStep(1);
});
