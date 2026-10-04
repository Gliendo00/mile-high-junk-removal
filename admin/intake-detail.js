// /admin/intake/?id=<uuid> — Screenshot AI Intake review screen (Batch 5 +
// Stage 5D). This page itself never creates/updates a customer or booking
// row directly — Confirm Booking calls the existing POST /api/admin/client
// and POST /api/admin/booking endpoints (same two calls "+ New Job" makes)
// from the admin's own browser session, then tells api/admin/intake.js
// which ids resulted; Confirm as Lead calls api/admin/lead.js, the one file
// with a write grant on `leads`; Attach to Existing Job only ever records a
// pointer to a booking the admin already picked, never modifies it. See
// docs/phase-3/batch5-screenshot-intake-proposal.md (5B/5C) and each
// confirm handler's own comment below (5D).
//
// Every dynamic value is written with textContent/DOM construction (never
// innerHTML/insertAdjacentHTML with a concatenated string) — same
// discipline as admin/client-detail.js, which this file's structure
// mirrors.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var detailEl = document.getElementById('detail');
  var logoutBtn = document.getElementById('logout-btn');
  var toastEl = document.getElementById('admin-toast');
  var toastTimer = null;

  var statusSub = document.getElementById('status-sub');
  var statusBanner = document.getElementById('status-banner');
  var matchBanner = document.getElementById('match-banner');
  var matchedSummary = document.getElementById('matched-client-summary');
  var matchedName = document.getElementById('matched-client-name');
  var matchedMeta = document.getElementById('matched-client-meta');
  var changeClientBtn = document.getElementById('change-client-btn');
  var clientSearchWrap = document.getElementById('client-search-wrap');
  var clientSearchInput = document.getElementById('client-search-input');
  var clientSearchResults = document.getElementById('client-search-results');
  var clientFieldsEl = document.getElementById('client-fields');
  var classificationSelect = document.getElementById('classification-select');
  var jobFieldsEl = document.getElementById('job-fields');
  var schedulingFieldsEl = document.getElementById('scheduling-fields');
  var conflictsSection = document.getElementById('conflicts-section');
  var conflictsList = document.getElementById('conflicts-list');
  var candidatesSection = document.getElementById('candidates-section');
  var candidatesList = document.getElementById('candidates-list');
  var notesFieldsEl = document.getElementById('notes-fields');
  var screenshotsExpiredNote = document.getElementById('screenshots-expired-note');
  var screenshotGrid = document.getElementById('screenshot-grid');
  var saveBtn = document.getElementById('save-btn');
  var discardBtn = document.getElementById('discard-btn');

  // Stage 5D — Confirm / Convert panels.
  var confirmSectionEl = document.getElementById('confirm-section');
  var confirmBookingPanel = document.getElementById('confirm-booking-panel');
  var confirmLeadPanel = document.getElementById('confirm-lead-panel');
  var confirmAttachPanel = document.getElementById('confirm-attach-panel');
  var confirmBookingAiHint = document.getElementById('confirm-booking-ai-hint');
  var confirmBookingDateInput = document.getElementById('confirm-booking-appointment-date');
  var confirmBookingTimeModeToggle = document.getElementById('confirm-booking-time-mode-toggle');
  var confirmBookingTimeWindowSelect = document.getElementById('confirm-booking-time-window');
  var confirmBookingExactTimeInput = document.getElementById('confirm-booking-exact-time');
  var confirmBookingServiceTypeSelect = document.getElementById('confirm-booking-service-type');
  var confirmBookingDumpsterFields = document.getElementById('confirm-booking-dumpster-fields');
  var confirmBookingPickupDateInput = document.getElementById('confirm-booking-pickup-date');
  var confirmBookingMaterialTypeInput = document.getElementById('confirm-booking-material-type');
  var confirmBookingPlacementNotesInput = document.getElementById('confirm-booking-placement-notes');
  var confirmBookingAddressInput = document.getElementById('confirm-booking-address');
  var confirmBookingCityInput = document.getElementById('confirm-booking-city');
  var confirmBookingStateInput = document.getElementById('confirm-booking-state');
  var confirmBookingZipInput = document.getElementById('confirm-booking-zip');
  var confirmBookingPriceInput = document.getElementById('confirm-booking-estimated-price');
  var confirmBookingNotesInput = document.getElementById('confirm-booking-internal-notes');
  var confirmBookingBtn = document.getElementById('confirm-booking-btn');
  var confirmLeadBtn = document.getElementById('confirm-lead-btn');
  var confirmAttachBtn = document.getElementById('confirm-attach-btn');

  // Mirrors api/_lib/time-windows.js's TIME_WINDOW_DEFS labels — same
  // deliberate client-side copy admin/booking-new.js already keeps (see
  // that file's own header for why this isn't a shared cross-runtime
  // module in this project).
  var TIME_WINDOWS = [
    { value: 'w_0400_0600', label: '4:00 AM – 6:00 AM' },
    { value: 'w_0600_0800', label: '6:00 AM – 8:00 AM' },
    { value: 'w_0800_1000', label: '8:00 AM – 10:00 AM' },
    { value: 'w_1000_1200', label: '10:00 AM – 12:00 PM' },
    { value: 'w_1200_1400', label: '12:00 PM – 2:00 PM' },
    { value: 'w_1400_1600', label: '2:00 PM – 4:00 PM' },
    { value: 'w_1600_1800', label: '4:00 PM – 6:00 PM' },
    { value: 'w_1800_2000', label: '6:00 PM – 8:00 PM' },
    { value: 'w_2000_2200', label: '8:00 PM – 10:00 PM' },
  ];
  TIME_WINDOWS.forEach(function (w) {
    var opt = document.createElement('option');
    opt.value = w.value;
    opt.textContent = w.label;
    confirmBookingTimeWindowSelect.appendChild(opt);
  });

  var confirmBookingTimeMode = 'window';
  function setupSegmented(container, onSelect) {
    var buttons = container.querySelectorAll('.admin-segmented-btn');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(buttons, function (b) { b.classList.toggle('is-active', b === btn); });
        onSelect(btn.getAttribute('data-mode'));
      });
    });
  }
  setupSegmented(confirmBookingTimeModeToggle, function (mode) {
    confirmBookingTimeMode = mode;
    var isExact = mode === 'exact';
    confirmBookingExactTimeInput.style.display = isExact ? 'block' : 'none';
    confirmBookingTimeWindowSelect.style.display = isExact ? 'none' : 'block';
  });

  function updateConfirmBookingDumpsterVisibility() {
    confirmBookingDumpsterFields.style.display = confirmBookingServiceTypeSelect.value === 'dumpster_rental' ? 'block' : 'none';
  }
  confirmBookingServiceTypeSelect.addEventListener('change', updateConfirmBookingDumpsterVisibility);

  // A previously-attempted Confirm Booking whose job/client write succeeded
  // but whose final "mark this intake confirmed" step failed (a transient
  // network/server error) — retrying must re-send ONLY that last step
  // against the SAME already-created booking/client, never create a
  // second booking. Cleared on success or when the admin navigates away
  // from this classification/reloads.
  var pendingBookingConfirmation = null;

  var CLIENT_FIELDS = ['firstName', 'lastName', 'phone', 'email'];
  var JOB_FIELDS = ['serviceType', 'serviceDetails', 'itemDescription', 'estimatedLoadSize', 'quotedAmount', 'address', 'city', 'state', 'zip'];
  var SCHEDULING_FIELDS = ['date', 'appointmentTime', 'schedulingStatus'];
  var NOTES_FIELDS = ['internalNotes', 'photosReferenced', 'clientConstraints'];
  var LONG_TEXT_FIELDS = { serviceDetails: true, itemDescription: true, internalNotes: true, clientConstraints: true };

  var FIELD_LABELS = {
    firstName: 'First Name',
    lastName: 'Last Name',
    phone: 'Phone',
    email: 'Email',
    address: 'Address',
    city: 'City',
    state: 'State',
    zip: 'ZIP',
    serviceType: 'Service Type',
    serviceDetails: 'Requested Service Details',
    itemDescription: 'Item / Junk Description',
    estimatedLoadSize: 'Estimated Load Size',
    quotedAmount: 'Quoted Amount',
    date: 'Date',
    appointmentTime: 'Appointment Time / Window',
    schedulingStatus: 'Tentative vs Confirmed',
    internalNotes: 'Internal Notes',
    photosReferenced: 'Photos Referenced',
    clientConstraints: 'Client Constraints / Requests',
  };

  var CONFIDENCE_LABELS = { confirmed: 'Confirmed', likely: 'Likely', uncertain: 'Uncertain', missing: 'Missing' };
  var CLASSIFICATION_LABELS = {
    lead_only: 'Lead Only',
    quote_discussion: 'Quote Discussion',
    booking_confirmed: 'Booking Confirmed',
    follow_up: 'Follow-Up',
    existing_job_update: 'Existing Job Update',
    unclear: 'Unclear',
  };
  var MATCH_STATUS_LABELS = {
    existing_exact: 'Existing Client Found',
    new_candidate: 'New Client Candidate',
    needs_confirmation: 'Needs Client Confirmation',
  };
  var STATUS_LABELS = {
    processing: 'Processing',
    pending_review: 'Pending Review',
    confirmed: 'Confirmed',
    discarded: 'Discarded',
    extraction_failed: 'Extraction Failed',
  };

  var intakeId = new URLSearchParams(window.location.search).get('id');
  var currentIntake = null;
  var fieldInputs = {}; // key -> { el, original }
  var matchedCustomerId = null; // current (possibly just-picked) value
  var originalMatchedCustomerId = null;
  var pickedClientPreview = null; // { firstName, lastName, phone, email } when freshly picked, for the optimistic summary
  var linkedBookingId = null;
  var originalLinkedBookingId = null;
  var discardArmed = false;
  var searchDebounce = null;

  function showError(msg) {
    loadingEl.style.display = 'none';
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
  }
  function showToast(msg, kind) {
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = 'admin-toast is-visible' + (kind ? ' is-' + kind : '');
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
    }, 3200);
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function confidenceBadge(confidence) {
    var wrap = el('span', 'admin-intake-confidence');
    var dot = el('span', 'admin-sheet-dot admin-confidence-dot-' + (confidence || 'missing'));
    wrap.appendChild(dot);
    wrap.appendChild(document.createTextNode(CONFIDENCE_LABELS[confidence] || 'Missing'));
    return wrap;
  }

  function renderField(container, key, fieldData) {
    var data = fieldData || { value: null, confidence: 'missing' };
    var row = el('div', 'admin-field admin-intake-field');
    var label = document.createElement('label');
    label.setAttribute('for', 'field-' + key);
    var labelText = el('span', null, FIELD_LABELS[key] || key);
    label.appendChild(labelText);
    label.appendChild(confidenceBadge(data.confidence));
    row.appendChild(label);

    var input = LONG_TEXT_FIELDS[key] ? document.createElement('textarea') : document.createElement('input');
    if (!LONG_TEXT_FIELDS[key]) input.type = 'text';
    input.id = 'field-' + key;
    input.value = data.value || '';
    row.appendChild(input);

    fieldInputs[key] = { el: input, original: data.value || '' };
    container.appendChild(row);
  }

  function renderFieldGroup(container, keys, fields) {
    clear(container);
    keys.forEach(function (key) {
      renderField(container, key, fields ? fields[key] : null);
    });
  }

  function formatPhone(p) {
    return window.formatPhone ? window.formatPhone(p) : p;
  }

  function renderMatchedClient(client) {
    if (!client) {
      matchedSummary.style.display = 'none';
      return;
    }
    matchedSummary.style.display = 'flex';
    matchedName.textContent = [client.firstName, client.lastName].filter(Boolean).join(' ') || 'Unnamed client';
    var metaParts = [];
    if (client.phone) metaParts.push(formatPhone(client.phone));
    if (client.email) metaParts.push(client.email);
    if (typeof client.jobCount === 'number') metaParts.push(client.jobCount + (client.jobCount === 1 ? ' job' : ' jobs'));
    matchedMeta.textContent = metaParts.length ? metaParts.join(' · ') : '—';
  }

  function renderMatchBanner(matchStatus) {
    matchBanner.textContent = MATCH_STATUS_LABELS[matchStatus] || 'Unresolved';
    matchBanner.style.display = 'block';
  }

  function renderClientSearchResult(client) {
    var row = el('div', 'admin-picker-item');
    var main = el('div', 'admin-picker-item-name', [client.firstName, client.lastName].filter(Boolean).join(' ') || 'Unnamed client');
    row.appendChild(main);
    var meta = [];
    if (client.phone) meta.push(formatPhone(client.phone));
    if (client.city) meta.push(client.city);
    row.appendChild(el('div', 'admin-picker-item-meta', meta.join(' · ') || '—'));
    row.addEventListener('click', function () {
      matchedCustomerId = client.id;
      pickedClientPreview = client;
      clientSearchWrap.style.display = 'none';
      clientSearchInput.value = '';
      clear(clientSearchResults);
      renderMatchedClient(client);
    });
    return row;
  }

  function runClientSearch(term) {
    clear(clientSearchResults);
    if (!term.trim()) return;
    adminFetch('/api/admin/clients?limit=8&search=' + encodeURIComponent(term.trim()))
      .then(function (res) {
        if (!res.ok) return null;
        return res.json().catch(function () { return null; });
      })
      .then(function (body) {
        clear(clientSearchResults);
        if (!body || !body.clients || !body.clients.length) {
          clientSearchResults.appendChild(el('div', 'admin-picker-empty', 'No matching clients.'));
          return;
        }
        body.clients.forEach(function (c) {
          clientSearchResults.appendChild(renderClientSearchResult(c));
        });
      })
      .catch(function () {});
  }

  clientSearchInput.addEventListener('input', function () {
    clearTimeout(searchDebounce);
    var value = clientSearchInput.value;
    searchDebounce = setTimeout(function () {
      runClientSearch(value);
    }, 200);
  });

  changeClientBtn.addEventListener('click', function () {
    clientSearchWrap.style.display = 'block';
    clientSearchInput.focus();
  });

  function renderCandidates(candidates, linkedId) {
    clear(candidatesList);
    if (!candidates || !candidates.length) {
      candidatesSection.style.display = 'none';
      return;
    }
    candidatesSection.style.display = 'block';
    candidates.forEach(function (b) {
      var row = el('div', 'admin-intake-candidate-row');
      var main = el('div');
      main.appendChild(el('div', null, b.serviceType || 'Job'));
      main.appendChild(el('div', 'admin-field-hint', b.appointmentDate || '—'));
      row.appendChild(main);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'admin-btn admin-btn-outline';
      var isLinked = linkedBookingId === b.id;
      btn.textContent = isLinked ? 'Linked ✓' : 'Link';
      btn.addEventListener('click', function () {
        linkedBookingId = linkedBookingId === b.id ? null : b.id;
        renderCandidates(candidates, linkedBookingId);
      });
      row.appendChild(btn);
      candidatesList.appendChild(row);
    });
  }

  function renderConflicts(conflicts) {
    clear(conflictsList);
    if (!conflicts || !conflicts.length) {
      conflictsSection.style.display = 'none';
      return;
    }
    conflictsSection.style.display = 'block';
    conflicts.forEach(function (c) {
      var box = el('div', 'admin-intake-conflict');
      box.appendChild(el('div', 'admin-intake-conflict-field', (FIELD_LABELS[c.field] || c.field) + ' — conflicting values found'));
      var valuesText = (c.values || [])
        .map(function (v) {
          return v.value + (v.sourceIndex !== null && v.sourceIndex !== undefined ? ' (screenshot ' + (v.sourceIndex + 1) + ')' : '');
        })
        .join('; ');
      box.appendChild(el('div', null, valuesText));
      conflictsList.appendChild(box);
    });
  }

  function formatExpiredDate(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      return iso;
    }
  }

  // Screenshot retention (hardening pass): a session's screenshots can be
  // gone not because anyone discarded it, but because nobody reviewed it
  // within the retention window (see
  // docs/phase-3/batch5-storage-design.md) — an empty grid in that case is
  // expected, not a bug, and should say so rather than looking broken.
  function renderScreenshotsExpiredNote(screenshotsExpiredAt) {
    if (!screenshotsExpiredAt) {
      screenshotsExpiredNote.style.display = 'none';
      return;
    }
    screenshotsExpiredNote.textContent = 'The original screenshots were automatically removed on ' + formatExpiredDate(screenshotsExpiredAt) + ' (retention window expired). The extracted information below was kept.';
    screenshotsExpiredNote.style.display = 'block';
  }

  function renderScreenshots(screenshots, editable) {
    clear(screenshotGrid);
    (screenshots || []).forEach(function (shot) {
      var li = document.createElement('li');
      if (shot.url) {
        var img = document.createElement('img');
        img.src = shot.url;
        img.alt = 'Screenshot';
        li.appendChild(img);
      } else {
        li.appendChild(el('div', 'admin-photo-unavailable', 'Unavailable'));
      }
      if (editable) {
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'admin-btn admin-btn-ghost';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', function () {
          removeBtn.disabled = true;
          adminFetch('/api/admin/intake', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: intakeId, action: 'remove-screenshot', screenshotId: shot.id }),
          })
            .then(function (res) {
              if (res.status === 401) {
                window.location.href = '/admin/login/';
                return null;
              }
              return res.json().catch(function () { return null; }).then(function (body) {
                if (!res.ok) throw new Error((body && body.error) || 'Could not remove screenshot.');
                return body;
              });
            })
            .then(function (body) {
              if (!body) return;
              li.parentNode.removeChild(li);
              showToast('Screenshot removed.');
            })
            .catch(function (err) {
              removeBtn.disabled = false;
              showToast(err && err.message ? err.message : 'Could not remove screenshot.', 'error');
            });
        });
        li.appendChild(removeBtn);
      }
      screenshotGrid.appendChild(li);
    });
  }

  // Denver-local "today", matching admin/booking-new.js's own copy (see
  // that file's header for why this is never the browser's own local
  // time) — used only to default/floor the Confirm Booking date field.
  function denverTodayIso() {
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });
    var parts = {};
    fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }

  // Best-effort "what did the extracted date field actually mean" prefill
  // — never trusted as-is; the admin can always correct it, and the server
  // independently re-validates whatever ends up submitted. Returns ''
  // (never a wrong-looking placeholder) when the raw text can't be
  // confidently parsed as a real calendar date.
  function guessIsoDate(raw) {
    if (!raw) return '';
    var d = new Date(raw);
    if (isNaN(d.getTime())) return '';
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  // Best-effort "which of our 3 service types is this" prefill from the
  // extracted serviceType free text — a convenience default only; the
  // select is always left fully editable. Falls back to Junk Removal
  // (this business's most common job) rather than guessing wrong in a way
  // that reads as confident.
  function guessServiceType(raw) {
    var text = (raw || '').toLowerCase();
    if (text.indexOf('dumpster') !== -1 || text.indexOf('rental') !== -1) return 'dumpster_rental';
    if (text.indexOf('demo') !== -1) return 'light_demo';
    return 'junk_removal';
  }

  // Strips everything but digits/decimal point from a free-text quoted
  // amount (e.g. "$350", "around $300") and parses it — an unparseable or
  // ambiguous string (a range, "TBD") prefills blank rather than guessed.
  function guessPrice(raw) {
    if (!raw) return '';
    var cleaned = raw.replace(/[^0-9.]/g, '');
    if (!cleaned) return '';
    var n = Number(cleaned);
    return Number.isFinite(n) && n >= 0 ? String(n) : '';
  }

  function fieldRawValue(fields, key) {
    var f = fields && fields[key];
    return f && f.value ? f.value : '';
  }

  // Fills the Confirm Booking panel's structured inputs from the intake's
  // extracted/reviewed fields — a one-time convenience prefill on load,
  // never re-applied after (the admin's own edits always win; this never
  // runs again on a later render() call within the same page view, see
  // bookingPanelPrefilled below).
  var bookingPanelPrefilled = false;
  function prefillConfirmBookingPanel(fields) {
    if (bookingPanelPrefilled) return;
    bookingPanelPrefilled = true;

    var todayIso = denverTodayIso();
    var guessedDate = guessIsoDate(fieldRawValue(fields, 'date'));
    confirmBookingDateInput.value = guessedDate && guessedDate >= todayIso ? guessedDate : todayIso;
    confirmBookingDateInput.min = todayIso;

    confirmBookingServiceTypeSelect.value = guessServiceType(fieldRawValue(fields, 'serviceType'));
    updateConfirmBookingDumpsterVisibility();

    confirmBookingAddressInput.value = fieldRawValue(fields, 'address');
    confirmBookingCityInput.value = fieldRawValue(fields, 'city');
    confirmBookingStateInput.value = fieldRawValue(fields, 'state');
    confirmBookingZipInput.value = fieldRawValue(fields, 'zip');
    confirmBookingPriceInput.value = guessPrice(fieldRawValue(fields, 'quotedAmount'));

    var notesParts = [fieldRawValue(fields, 'internalNotes'), fieldRawValue(fields, 'clientConstraints')].filter(Boolean);
    confirmBookingNotesInput.value = notesParts.join('\n\n');

    var timeRaw = fieldRawValue(fields, 'appointmentTime');
    var schedulingRaw = fieldRawValue(fields, 'schedulingStatus');
    if (timeRaw || schedulingRaw) {
      confirmBookingAiHint.textContent = 'AI found: ' + [timeRaw, schedulingRaw].filter(Boolean).join(' · ') + ' — pick the exact time or window below.';
      confirmBookingAiHint.style.display = 'block';
    } else {
      confirmBookingAiHint.style.display = 'none';
    }
  }

  // Shows exactly the one Confirm panel matching the current (possibly
  // just-changed, not-yet-saved) classification — kept live on every
  // classificationSelect change, not just on initial render, so switching
  // classification during review immediately reflects which confirm action
  // is available, same as the brief's "bottom action area should clearly
  // reflect the classification" requirement.
  function updateConfirmPanelVisibility() {
    var cls = classificationSelect.value;
    confirmBookingPanel.style.display = cls === 'booking_confirmed' ? 'block' : 'none';
    confirmLeadPanel.style.display = cls === 'lead_only' || cls === 'quote_discussion' ? 'block' : 'none';
    confirmAttachPanel.style.display = cls === 'existing_job_update' ? 'block' : 'none';
  }
  classificationSelect.addEventListener('change', updateConfirmPanelVisibility);

  function render(intake) {
    currentIntake = intake;
    loadingEl.style.display = 'none';
    detailEl.style.display = 'block';

    statusSub.textContent = STATUS_LABELS[intake.status] || intake.status;

    var editable = intake.status === 'pending_review';
    saveBtn.style.display = editable ? 'inline-flex' : 'none';
    discardBtn.style.display = intake.status === 'confirmed' || intake.status === 'discarded' ? 'none' : 'inline-flex';

    if (intake.status === 'extraction_failed') {
      statusBanner.className = 'admin-alert admin-alert-error';
      statusBanner.textContent = 'Extraction failed: ' + (intake.extractionError || 'unknown error') + '. You can discard this intake and try again from + New Intake.';
      statusBanner.style.display = 'block';
    } else if (intake.status === 'discarded') {
      statusBanner.className = 'admin-alert admin-alert-neutral';
      statusBanner.textContent = 'This intake has been discarded.';
      statusBanner.style.display = 'block';
    } else if (intake.status === 'processing') {
      statusBanner.className = 'admin-alert admin-alert-neutral';
      statusBanner.textContent = 'Extraction has not finished for this intake yet.';
      statusBanner.style.display = 'block';
    } else if (intake.status === 'confirmed') {
      statusBanner.className = 'admin-alert admin-alert-success';
      var confirmedWhen = intake.confirmedAt ? new Date(intake.confirmedAt).toLocaleString('en-US') : 'unknown time';
      var confirmedText = 'Confirmed on ' + confirmedWhen + (intake.confirmedBy ? ' by ' + intake.confirmedBy : '') + '.';
      clear(statusBanner);
      statusBanner.appendChild(document.createTextNode(confirmedText + ' '));
      if (intake.resultingBookingId) {
        var bookingLink = document.createElement('a');
        bookingLink.href = '/admin/booking/?id=' + encodeURIComponent(intake.resultingBookingId);
        bookingLink.textContent = 'View booking';
        statusBanner.appendChild(bookingLink);
      } else if (intake.resultingCustomerId) {
        var clientLink = document.createElement('a');
        clientLink.href = '/admin/client/?id=' + encodeURIComponent(intake.resultingCustomerId);
        clientLink.textContent = 'View client';
        statusBanner.appendChild(clientLink);
      }
      statusBanner.style.display = 'block';
    } else {
      statusBanner.style.display = 'none';
    }

    matchedCustomerId = intake.matchedClient ? intake.matchedClient.id : null;
    originalMatchedCustomerId = matchedCustomerId;
    pickedClientPreview = null;
    if (intake.matchStatus) renderMatchBanner(intake.matchStatus);
    renderMatchedClient(intake.matchedClient);

    renderFieldGroup(clientFieldsEl, CLIENT_FIELDS, intake.fields);
    renderFieldGroup(jobFieldsEl, JOB_FIELDS, intake.fields);
    renderFieldGroup(schedulingFieldsEl, SCHEDULING_FIELDS, intake.fields);
    renderFieldGroup(notesFieldsEl, NOTES_FIELDS, intake.fields);

    classificationSelect.value = intake.classification || 'unclear';

    confirmSectionEl.style.display = editable ? 'block' : 'none';
    if (editable) {
      prefillConfirmBookingPanel(intake.fields);
      updateConfirmPanelVisibility();
    }

    linkedBookingId = intake.linkedExistingBookingId || null;
    originalLinkedBookingId = linkedBookingId;
    renderCandidates(intake.existingJobCandidates, linkedBookingId);

    renderConflicts(intake.conflicts);
    renderScreenshotsExpiredNote(intake.screenshotsExpiredAt);
    renderScreenshots(intake.screenshots, editable);

    [clientFieldsEl, jobFieldsEl, schedulingFieldsEl, notesFieldsEl, classificationSelect].forEach(function (node) {
      var inputs = node.tagName === 'SELECT' ? [node] : node.querySelectorAll('input, textarea, select');
      (inputs.length !== undefined ? Array.prototype.slice.call(inputs) : [inputs]).forEach(function (input) {
        if (!editable) input.disabled = true;
      });
    });
    changeClientBtn.style.display = editable ? 'inline-flex' : 'none';
  }

  function load() {
    if (!intakeId) {
      showError('No intake specified.');
      return;
    }
    adminFetch('/api/admin/intake?id=' + encodeURIComponent(intakeId))
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not load intake.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return;
        clearError();
        render(body.intake);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not load intake.');
      });
  }

  function patchAction(body) {
    return adminFetch('/api/admin/intake', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return Promise.reject(new Error('Session expired.'));
      }
      return res.json().catch(function () { return null; }).then(function (respBody) {
        if (!res.ok) throw new Error((respBody && respBody.error) || 'Could not save changes.');
        return respBody;
      });
    });
  }

  // Shared POST helper for the two Stage 5D confirm flows that call OTHER
  // admin endpoints (POST /api/admin/client, POST /api/admin/booking,
  // POST /api/admin/lead) — not /api/admin/intake, so patchAction() above
  // doesn't fit. `res` is attached to a thrown error's `.response` so a
  // caller can branch on status (e.g. 409 duplicate_client) without a
  // second fetch.
  function postJson(url, body) {
    return adminFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return Promise.reject(new Error('Session expired.'));
      }
      return res.json().catch(function () { return null; }).then(function (respBody) {
        if (!res.ok) {
          var err = new Error((respBody && respBody.error) || 'Request failed.');
          err.response = { status: res.status, body: respBody };
          throw err;
        }
        return respBody;
      });
    });
  }

  // Builds (but does not start showing toasts for) the same diff-only save
  // chain the Save button has always used — every edited field, a changed
  // classification, a changed client match, a changed linked-existing-
  // booking, each as its own patchAction() only when it actually changed.
  // Shared with the three Stage 5D confirm handlers below: every one of
  // them must persist whatever's currently on screen BEFORE converting,
  // since the server-side confirm actions read matched_customer_id/
  // linked_existing_booking_id/extracted_data straight off the
  // intake_sessions row, not off the request body.
  function buildSaveChain() {
    var chain = Promise.resolve();

    var fieldsDiff = {};
    var anyFieldChanged = false;
    Object.keys(fieldInputs).forEach(function (key) {
      var entry = fieldInputs[key];
      var current = entry.el.value.trim();
      if (current !== (entry.original || '')) {
        fieldsDiff[key] = current;
        anyFieldChanged = true;
      }
    });
    if (anyFieldChanged) {
      chain = chain.then(function () {
        return patchAction({ id: intakeId, action: 'update', fields: fieldsDiff });
      });
    }

    if (classificationSelect.value !== currentIntake.classification) {
      chain = chain.then(function () {
        return patchAction({ id: intakeId, action: 'reclassify', classification: classificationSelect.value });
      });
    }

    if (matchedCustomerId !== originalMatchedCustomerId) {
      chain = chain.then(function () {
        return patchAction({ id: intakeId, action: 'set-client-match', matchedCustomerId: matchedCustomerId });
      });
    }

    if (linkedBookingId !== originalLinkedBookingId) {
      chain = chain.then(function () {
        return patchAction({ id: intakeId, action: 'link-existing-booking', bookingId: linkedBookingId });
      });
    }

    return chain;
  }

  saveBtn.addEventListener('click', function () {
    saveBtn.disabled = true;
    buildSaveChain()
      .then(function () {
        showToast('Changes saved.');
        loadingEl.style.display = 'block';
        detailEl.style.display = 'none';
        load();
      })
      .catch(function (err) {
        showToast(err && err.message ? err.message : 'Could not save changes.', 'error');
      })
      .then(function () {
        saveBtn.disabled = false;
      });
  });

  discardBtn.addEventListener('click', function () {
    if (!discardArmed) {
      discardArmed = true;
      discardBtn.textContent = 'Click again to confirm discard';
      setTimeout(function () {
        discardArmed = false;
        discardBtn.textContent = 'Discard Intake';
      }, 4000);
      return;
    }
    discardArmed = false;
    discardBtn.disabled = true;
    patchAction({ id: intakeId, action: 'discard' })
      .then(function () {
        window.location.href = '/admin/intakes/';
      })
      .catch(function (err) {
        discardBtn.disabled = false;
        discardBtn.textContent = 'Discard Intake';
        showToast(err && err.message ? err.message : 'Could not discard intake.', 'error');
      });
  });

  // ---------------------------------------------------------------------
  // Stage 5D — Confirm Booking. Never writes a customer/booking from this
  // file directly: it calls the SAME two already-reviewed endpoints
  // "+ New Job" uses (POST /api/admin/client, then POST /api/admin/booking)
  // from the admin's own authenticated browser session, then tells
  // api/admin/intake.js which ids resulted so it can record the outcome.
  // See api/admin/intake.js's handleConfirmBooking() for the server-side
  // half of this contract.
  // ---------------------------------------------------------------------
  confirmBookingBtn.addEventListener('click', function () {
    confirmBookingBtn.disabled = true;
    clearError();

    function resolveCustomerId() {
      if (matchedCustomerId) return Promise.resolve(matchedCustomerId);

      var firstName = (fieldInputs.firstName ? fieldInputs.firstName.el.value : '').trim();
      if (!firstName) {
        return Promise.reject(new Error('First name is required to create a new client. Fill it in above, or use Change to pick an existing client.'));
      }
      var clientPayload = {
        firstName: firstName,
        lastName: (fieldInputs.lastName ? fieldInputs.lastName.el.value : '').trim(),
        phone: (fieldInputs.phone ? fieldInputs.phone.el.value : '').trim(),
        email: (fieldInputs.email ? fieldInputs.email.el.value : '').trim(),
      };
      return postJson('/api/admin/client', clientPayload)
        .then(function (body) {
          return body.client.id;
        })
        .catch(function (err) {
          if (err.response && err.response.status === 409) {
            throw new Error('A client with this exact phone and email already exists. Use Change (in the Client section above) to search for and select them, then try again.');
          }
          throw err;
        });
    }

    function createBooking(customerId) {
      var timeWindow = confirmBookingTimeMode === 'window' ? confirmBookingTimeWindowSelect.value : '';
      var exactTime = confirmBookingTimeMode === 'exact' ? confirmBookingExactTimeInput.value : '';
      if (confirmBookingTimeMode === 'exact' && !exactTime) throw new Error('Please choose an exact time.');
      if (confirmBookingTimeMode === 'window' && !timeWindow) throw new Error('Please select a time window.');
      if (!confirmBookingDateInput.value) throw new Error('Please choose an appointment date.');

      var bookingPayload = {
        customerId: customerId,
        serviceType: confirmBookingServiceTypeSelect.value,
        appointmentDate: confirmBookingDateInput.value,
        timeWindow: timeWindow,
        exactTime: exactTime,
        serviceAddress: {
          address: confirmBookingAddressInput.value.trim(),
          city: confirmBookingCityInput.value.trim(),
          state: confirmBookingStateInput.value.trim(),
          zip: confirmBookingZipInput.value.trim(),
        },
        internalNotes: confirmBookingNotesInput.value.trim(),
      };
      var priceRaw = confirmBookingPriceInput.value.trim();
      if (priceRaw) bookingPayload.estimatedPrice = Number(priceRaw);
      if (confirmBookingServiceTypeSelect.value === 'dumpster_rental') {
        var pickupRaw = confirmBookingPickupDateInput.value.trim();
        if (pickupRaw) bookingPayload.pickupDate = pickupRaw;
        var materialRaw = confirmBookingMaterialTypeInput.value.trim();
        if (materialRaw) bookingPayload.materialType = materialRaw;
        var placementRaw = confirmBookingPlacementNotesInput.value.trim();
        if (placementRaw) bookingPayload.placementNotes = placementRaw;
      }

      return postJson('/api/admin/booking', bookingPayload).then(function (body) {
        return { bookingId: body.booking.id, customerId: customerId };
      });
    }

    function markConfirmed(ids) {
      return patchAction({ id: intakeId, action: 'confirm-booking', bookingId: ids.bookingId, customerId: ids.customerId })
        .then(function () {
          pendingBookingConfirmation = null;
          window.location.href = '/admin/booking/?id=' + encodeURIComponent(ids.bookingId);
        })
        .catch(function (err) {
          // The booking (and possibly a new client) now genuinely exist —
          // only the final "mark this intake confirmed" step failed.
          // Remembering the ids lets a retry skip straight back to just
          // this step instead of ever creating a second booking.
          pendingBookingConfirmation = ids;
          throw new Error('The booking was created, but this intake could not be marked confirmed (' + (err.message || 'unknown error') + '). Click Confirm Booking again to retry — it will not create a duplicate.');
        });
    }

    var flow;
    if (pendingBookingConfirmation) {
      flow = markConfirmed(pendingBookingConfirmation);
    } else {
      flow = buildSaveChain()
        .then(resolveCustomerId)
        .then(createBooking)
        .then(markConfirmed);
    }

    flow
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not confirm this booking.');
      })
      .then(function () {
        confirmBookingBtn.disabled = false;
      });
  });

  // ---------------------------------------------------------------------
  // Stage 5D — Confirm as Lead. Saves any pending edits first (the server
  // reads extracted_data/matched_customer_id straight off the row — see
  // api/admin/lead.js), then creates the lead via the one write path that
  // file owns. Idempotent against a double-click/retry at the server
  // level (leads_source_intake_id_uniq) — this button has no special
  // retry-state of its own to track.
  // ---------------------------------------------------------------------
  confirmLeadBtn.addEventListener('click', function () {
    confirmLeadBtn.disabled = true;
    clearError();
    buildSaveChain()
      .then(function () {
        return postJson('/api/admin/lead', { intakeSessionId: intakeId });
      })
      .then(function () {
        window.location.href = '/admin/leads/?bucket=new';
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not confirm this as a lead.');
      })
      .then(function () {
        confirmLeadBtn.disabled = false;
      });
  });

  // ---------------------------------------------------------------------
  // Stage 5D — Attach to Existing Job. The admin already picked which
  // booking via the "Link" button in the Existing Upcoming Jobs section
  // above; buildSaveChain() is what actually persists linkedBookingId
  // (and anything else pending) before the server-side confirm reads it
  // back off the row. Never modifies the linked booking itself.
  // ---------------------------------------------------------------------
  confirmAttachBtn.addEventListener('click', function () {
    if (!linkedBookingId) {
      showError('Select an existing job above (click Link) before confirming.');
      return;
    }
    confirmAttachBtn.disabled = true;
    clearError();
    buildSaveChain()
      .then(function () {
        return patchAction({ id: intakeId, action: 'confirm-attach-existing' });
      })
      .then(function (body) {
        window.location.href = '/admin/booking/?id=' + encodeURIComponent(body.resultingBookingId);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not confirm this attachment.');
      })
      .then(function () {
        confirmAttachBtn.disabled = false;
      });
  });

  logoutBtn.addEventListener('click', function () {
    logoutBtn.disabled = true;
    fetch('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        window.location.href = '/admin/login/';
      });
  });

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });

  load();
});
