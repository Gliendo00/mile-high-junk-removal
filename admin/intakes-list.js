// /admin/intakes — Pending Intake queue (Batch 5). Read-only list of
// intake_sessions awaiting review, newest first.
//
// Every dynamic value below is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string) — same discipline as
// admin/clients-list.js.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('loading');
  var emptyEl = document.getElementById('empty');
  var listEl = document.getElementById('intake-list');
  var logoutBtn = document.getElementById('logout-btn');

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  var CLASSIFICATION_TEXT = {
    lead_only: 'Lead',
    quote_discussion: 'Quote Discussion',
    booking_confirmed: 'Booking Confirmed',
    follow_up: 'Follow-Up',
    existing_job_update: 'Existing Job Update',
    unclear: 'Unclear',
  };

  var MATCH_STATUS_TEXT = {
    existing_exact: 'Existing Client',
    new_candidate: 'New Client',
    needs_confirmation: 'Needs Client Confirmation',
  };

  function formatWhen(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return iso;
    }
  }

  function renderIntakeCard(intake) {
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.className = 'admin-booking-card';
    a.href = '/admin/intake/?id=' + encodeURIComponent(intake.id);

    // Priority: an existing client's real name > the name the extraction
    // found > phone > email. Only falls through to "Unidentified client"
    // when none of those exist at all.
    var title = intake.matchedClientName || intake.extractedClientName || intake.extractedPhone || intake.extractedEmail || 'Unidentified client';
    a.appendChild(el('div', 'admin-card-name', title));

    var classificationText = CLASSIFICATION_TEXT[intake.classification] || 'Unclassified';
    if (intake.extractedServiceType) classificationText += ' · ' + intake.extractedServiceType;
    a.appendChild(el('div', 'admin-card-service', classificationText));

    var metaParts = [MATCH_STATUS_TEXT[intake.matchStatus] || 'Unresolved client match'];
    metaParts.push(formatWhen(intake.createdAt));
    a.appendChild(el('div', 'admin-card-when', metaParts.join(' · ')));

    var footer = el('div', 'admin-card-footer');
    footer.appendChild(el('span', null, intake.classificationConfidence === 'uncertain' ? 'Needs attention' : ''));
    footer.appendChild(el('span', 'admin-card-view', 'Review →'));
    a.appendChild(footer);

    li.appendChild(a);
    return li;
  }

  function loadList() {
    adminFetch('/api/admin/intake')
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/admin/login/';
          return null;
        }
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || 'Could not load intakes.');
            return body;
          });
      })
      .then(function (body) {
        if (!body) return; // redirected to login
        loadingEl.style.display = 'none';
        clearError();

        if (!body.intakes.length) {
          emptyEl.style.display = 'block';
          listEl.style.display = 'none';
          return;
        }
        listEl.style.display = 'flex';
        body.intakes.forEach(function (intake) {
          listEl.appendChild(renderIntakeCard(intake));
        });
      })
      .catch(function (err) {
        loadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load intakes.');
      });
  }

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

  loadList();
});
