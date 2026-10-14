// /admin/agent-proposals/ — Site Improvement Agent, Phase 3's detailed
// review surface. Talks to api/admin/bookings.js's ?view=agent-proposals
// (GET list) and resource:"agent-proposal" (PATCH approve/reject) — no
// new Vercel function, same file that already hosts ?view=agent-activity.
//
// Deliberately minimal: no dashboard redesign, no raw research JSON dump
// — each proposal shows its summary, the agent's own reason, which pages
// it concerns, and (compactly) its evidence, with a Approve/Reject
// action that only ever updates that ONE proposal's review state. It
// never executes any website change by itself, approved or not — see
// this page's own intro paragraph in admin/agent-proposals/index.html.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
document.addEventListener('DOMContentLoaded', function () {
  var STATUS_LABELS = {
    proposed: 'Needs review',
    approved: 'Approved',
    rejected: 'Rejected',
    applied: 'Applied',
    validated: 'Validated',
    failed: 'Failed',
  };

  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('proposals-loading');
  var emptyEl = document.getElementById('proposals-empty');
  var listEl = document.getElementById('proposals-list');
  var filterBar = document.getElementById('proposals-filter-bar');

  var currentStatusFilter = '';
  var actionInFlight = false;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }
  function clearError() {
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
  }
  function handleAuthRedirect(res) {
    if (res.status === 401) {
      window.location.href = '/admin/login/';
      return true;
    }
    return false;
  }
  function formatDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function evidenceLine(item) {
    if (!item || typeof item !== 'object') return String(item);
    var parts = [];
    if (item.field) parts.push(item.field);
    if (item.value !== undefined) parts.push(JSON.stringify(item.value));
    if (item.file) parts.push('(' + item.file + ')');
    return parts.join(' ') || JSON.stringify(item);
  }

  function buildCard(proposal) {
    var card = el('div', 'admin-proposal-card');

    var top = el('div', 'admin-proposal-card-top');
    var badge = el('span', 'admin-status-badge admin-proposal-status-' + proposal.status, STATUS_LABELS[proposal.status] || proposal.status);
    top.appendChild(el('span', null, proposal.findingType));
    top.appendChild(badge);
    card.appendChild(top);

    card.appendChild(el('p', 'admin-proposal-card-summary', proposal.summary));
    card.appendChild(el(
      'p',
      'admin-proposal-card-meta',
      'Category ' + proposal.category + ' · ' + (proposal.riskLevel || 'unknown') + ' risk · ' + (proposal.pages || []).join(', ')
    ));
    if (proposal.decisionReason) {
      card.appendChild(el('p', 'admin-proposal-card-reason', proposal.decisionReason));
    }

    if (Array.isArray(proposal.evidence) && proposal.evidence.length) {
      var evidenceHeading = el('p', 'admin-proposal-card-meta', 'Evidence:');
      card.appendChild(evidenceHeading);
      var evidenceList = el('ul', 'admin-proposal-card-meta');
      evidenceList.style.margin = '0 0 8px';
      evidenceList.style.paddingLeft = '18px';
      proposal.evidence.slice(0, 5).forEach(function (item) {
        evidenceList.appendChild(el('li', null, evidenceLine(item)));
      });
      card.appendChild(evidenceList);
    }

    if (Array.isArray(proposal.research) && proposal.research.length) {
      proposal.research.forEach(function (r) {
        var line = el('p', 'admin-proposal-card-meta', 'Researched (' + (r.confidence || '?') + ' confidence, ' + (r.verdict || '?') + '): ' + (r.source || ''));
        card.appendChild(line);
      });
    }

    if (proposal.status === 'proposed') {
      var noteInput = el('textarea', 'admin-proposal-card-note-input');
      noteInput.rows = 2;
      noteInput.placeholder = 'Optional note (e.g. why you approved/rejected this)';
      card.appendChild(noteInput);

      // Phase 4 hardening — stated right at the point of action, not
      // just in the page's top intro paragraph, so it's truthful even
      // for someone who scrolled straight to a card: approving records
      // a decision only. It does not publish, edit, or otherwise touch
      // the website — only the narrow mechanical-fix whitelist
      // (unrelated to this screen) ever writes to the site on its own.
      card.appendChild(el('p', 'admin-proposal-card-reviewed-note', 'Approve/Reject only records your decision here — it does not change the website.'));

      var actions = el('div', 'admin-proposal-card-actions');
      var approveBtn = el('button', 'admin-btn admin-btn-primary', 'Approve');
      approveBtn.type = 'button';
      var rejectBtn = el('button', 'admin-btn admin-btn-danger', 'Reject');
      rejectBtn.type = 'button';

      approveBtn.addEventListener('click', function () {
        reviewProposal(proposal.id, 'approve', noteInput.value, [approveBtn, rejectBtn]);
      });
      rejectBtn.addEventListener('click', function () {
        reviewProposal(proposal.id, 'reject', noteInput.value, [approveBtn, rejectBtn]);
      });

      actions.appendChild(approveBtn);
      actions.appendChild(rejectBtn);
      card.appendChild(actions);
    } else {
      var reviewedLine = 'Reviewed';
      if (proposal.reviewedBy) reviewedLine += ' by ' + proposal.reviewedBy;
      if (proposal.reviewedAt) reviewedLine += ' on ' + formatDateTime(proposal.reviewedAt);
      card.appendChild(el('p', 'admin-proposal-card-meta', reviewedLine));
      if (proposal.reviewNote) {
        card.appendChild(el('p', 'admin-proposal-card-reviewed-note', '"' + proposal.reviewNote + '"'));
      }
    }

    return card;
  }

  function render(proposals) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    if (!proposals.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    proposals.forEach(function (p) {
      listEl.appendChild(buildCard(p));
    });
  }

  function load() {
    loadingEl.style.display = 'block';
    emptyEl.style.display = 'none';
    clearError();
    var url = '/api/admin/bookings?view=agent-proposals' + (currentStatusFilter ? '&status=' + encodeURIComponent(currentStatusFilter) : '');
    adminFetch(url)
      .then(function (res) {
        if (handleAuthRedirect(res)) return null;
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not load proposals.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return;
        render(body.proposals || []);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not load proposals.');
        render([]);
      })
      .finally(function () {
        loadingEl.style.display = 'none';
      });
  }

  function reviewProposal(id, action, note, buttonsToDisable) {
    if (actionInFlight) return;
    actionInFlight = true;
    buttonsToDisable.forEach(function (b) { b.disabled = true; });

    adminFetch('/api/admin/bookings?resource=agent-proposal', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: 'agent-proposal', id: id, action: action, note: note }),
    })
      .then(function (res) {
        if (handleAuthRedirect(res)) return null;
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not save this review.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return;
        load();
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not save this review.');
        buttonsToDisable.forEach(function (b) { b.disabled = false; });
      })
      .finally(function () {
        actionInFlight = false;
      });
  }

  var pills = filterBar.querySelectorAll('.admin-filter-pill');
  pills.forEach(function (pill) {
    pill.addEventListener('click', function () {
      pills.forEach(function (p) {
        p.classList.remove('is-active');
        p.setAttribute('aria-selected', 'false');
      });
      pill.classList.add('is-active');
      pill.setAttribute('aria-selected', 'true');
      currentStatusFilter = pill.getAttribute('data-status') || '';
      load();
    });
  });

  load();
});
