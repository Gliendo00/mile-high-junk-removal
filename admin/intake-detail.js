// /admin/intake/?id=<uuid> — Screenshot AI Intake review screen (Batch 5,
// Stage 5D NOT included: there is no Confirm action here, and nothing on
// this page ever creates or updates a customers/bookings row — it only
// edits intake_sessions metadata via api/admin/intake.js's PATCH actions.
// See docs/phase-3/batch5-screenshot-intake-proposal.md.
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
  var screenshotGrid = document.getElementById('screenshot-grid');
  var saveBtn = document.getElementById('save-btn');
  var discardBtn = document.getElementById('discard-btn');

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

    linkedBookingId = intake.linkedExistingBookingId || null;
    originalLinkedBookingId = linkedBookingId;
    renderCandidates(intake.existingJobCandidates, linkedBookingId);

    renderConflicts(intake.conflicts);
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

  saveBtn.addEventListener('click', function () {
    saveBtn.disabled = true;
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

    chain
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
