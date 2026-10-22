// /admin/agent-proposals/ — Site Improvement Agent, Phase 3's detailed
// review surface. Talks to api/admin/bookings.js's ?view=agent-proposals
// (GET list) and resource:"agent-proposal" (PATCH approve/reject/
// execute) — no new Vercel function, same file that already hosts
// ?view=agent-activity.
//
// Deliberately minimal: no dashboard redesign, no raw research JSON dump
// — each proposal shows its summary, the agent's own reason, which pages
// it concerns, and (compactly) its evidence, with an Approve/Reject
// action that only ever updates that ONE proposal's review state. It
// never executes any website change by itself, approved or not — see
// this page's own intro paragraph in admin/agent-proposals/index.html.
//
// Phase 14 — Execute is a DISTINCT, separately-gated action, only ever
// offered for an 'approved' proposal, and only on desktop (requirement:
// mobile may approve/reject/view status, but must never be offered
// execution). This file enforces that client-side (both the CSS class
// and an explicit window.innerWidth check below — never rendering the
// button at all under the breakpoint, not just hiding it); the
// authoritative enforcement is server-side (bookings.js's
// isLikelyMobileUserAgent()) — see this file's own executeProposal().
// Clicking Execute never itself applies/commits/pushes anything from
// this page or from the Vercel function behind it — it asks that
// endpoint to dispatch a GitHub Actions workflow, which is the only
// place with a real git checkout; see agent/lib/execute-proposal.js's
// header for the full lifecycle this card's status badge/execution
// panel are reflecting.
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
document.addEventListener('DOMContentLoaded', function () {
  var STATUS_LABELS = {
    proposed: 'Needs review',
    approved: 'Approved / Pending execution',
    rejected: 'Rejected',
    applied: 'Applied',
    validated: 'Validated',
    failed: 'Failed',
    applying: 'Applying…',
    validating: 'Validating…',
    deploying: 'Deploying…',
    deployed: 'Deployed',
    needs_review: 'Needs review (execution stopped)',
  };
  // Same breakpoint admin.css's .admin-proposal-execute-btn media query
  // uses — kept in one place here so the JS gate and the CSS gate never
  // drift to different pixel values.
  var DESKTOP_MIN_WIDTH = 860;
  function isDesktopViewport() {
    return typeof window !== 'undefined' && window.innerWidth >= DESKTOP_MIN_WIDTH;
  }

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
    // Pre-acceptance hardening (audit finding #4) — `stale` is a
    // derived, read-time flag (see api/admin/bookings.js's
    // currentOwnerReviewKeys()): the underlying finding no longer needs
    // owner review (it moved to NO_CHANGE/RESEARCH_MORE, or stopped
    // appearing entirely) even though this row's own status is still
    // showing whatever was last decided (or not decided) on it. Never
    // hides/changes the real status badge above — only adds this
    // explicit, truthful caveat next to it.
    if (proposal.stale) {
      top.appendChild(el('span', 'admin-proposal-stale-badge', 'Stale — finding no longer needs review'));
    }
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

        // Phase 13a — a cross-source-synthesis result carries a
        // per-family breakdown (what supports this, what argues against
        // it, what's still insufficient/unavailable) instead of one
        // human-written source — render ONE concise line per family
        // rather than the generic single line above being the only
        // detail shown. Still never a raw JSON dump.
        if (r.sourceType === 'cross-source-synthesis' && Array.isArray(r.familyBreakdown) && r.familyBreakdown.length) {
          var breakdownList = el('ul', 'admin-proposal-card-meta');
          breakdownList.style.margin = '0 0 8px';
          breakdownList.style.paddingLeft = '18px';
          r.familyBreakdown.forEach(function (fam) {
            breakdownList.appendChild(el('li', null, fam.family + ': ' + fam.status + ' — ' + fam.detail));
          });
          card.appendChild(breakdownList);
          if (r.limitations) {
            card.appendChild(el('p', 'admin-proposal-card-meta', 'What the Agent still doesn\'t know: ' + r.limitations));
          }
        }
      });
    }

    // Phase 14 — execution details (commit/files/validation/test/
    // failure reason), shown whenever ANY of it exists, regardless of
    // which branch below is also showing — so a 'failed'/'needs_review'
    // card explains WHY, and a 'deployed' one shows what actually
    // shipped, without this panel's presence itself implying a status.
    var exec = proposal.execution || {};
    var hasExecutionDetail = exec.commitSha || exec.failureReason || exec.testResult || exec.validation;
    if (hasExecutionDetail) {
      var execPanel = el('div', 'admin-proposal-execution-panel');
      if (exec.failureReason) {
        execPanel.appendChild(el('p', 'admin-proposal-execution-failure', exec.failureReason));
      }
      if (exec.validation && exec.validation.status) {
        execPanel.appendChild(el('p', null, 'Validation: ' + exec.validation.status));
      }
      if (exec.testResult) {
        execPanel.appendChild(el('p', null, 'Tests: ' + (exec.testResult.passed ? 'passed' : 'FAILED')));
      }
      if (exec.commitSha) {
        execPanel.appendChild(el('p', null, 'Commit: ' + exec.commitSha.slice(0, 12) + (exec.filesChanged ? ' (' + exec.filesChanged.join(', ') + ')' : '')));
      }
      if (exec.requestedBy) {
        execPanel.appendChild(el('p', null, 'Requested by ' + exec.requestedBy + (exec.requestedAt ? ' on ' + formatDateTime(exec.requestedAt) : '')));
      }
      card.appendChild(execPanel);
    }

    var RETRYABLE_STATUSES = ['proposed', 'failed', 'needs_review'];
    var IN_PROGRESS_STATUSES = ['applying', 'validating', 'deploying'];

    if (RETRYABLE_STATUSES.indexOf(proposal.status) !== -1) {
      var noteInput = el('textarea', 'admin-proposal-card-note-input');
      noteInput.rows = 2;
      noteInput.placeholder = 'Optional note (e.g. why you approved/rejected this)';
      card.appendChild(noteInput);

      // Phase 4 hardening — stated right at the point of action, not
      // just in the page's top intro paragraph, so it's truthful even
      // for someone who scrolled straight to a card: approving records
      // a decision only — execution is a separate, later, explicit
      // step (Execute, below, once this becomes 'approved'). For a
      // proposal retried after a failed/needs_review execution,
      // approving again simply re-queues it for a fresh Execute click;
      // it does not retry anything by itself.
      var reviewNoteText = proposal.status === 'proposed'
        ? 'Approve/Reject only records your decision here — it does not change the website.'
        : 'Approve again to make this eligible for Execute once more. Reject to stop it for good.';
      card.appendChild(el('p', 'admin-proposal-card-reviewed-note', reviewNoteText));

      var actions = el('div', 'admin-proposal-card-actions');
      var approveBtn = el('button', 'admin-btn admin-btn-primary', proposal.status === 'proposed' ? 'Approve' : 'Approve again');
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
    } else if (proposal.status === 'approved') {
      card.appendChild(el('p', 'admin-proposal-card-reviewed-note', 'Approved — ready to execute.'));

      // Desktop-only (requirement: execution must never be offered on
      // mobile) — both an explicit viewport check (so the button is
      // never even added to the DOM on a narrow screen) and the
      // .admin-proposal-execute-btn CSS class (admin.css) as a second,
      // redundant layer in case the viewport is resized wider later
      // without a reload. The real enforcement is server-side — see
      // this file's own top-of-file comment.
      if (isDesktopViewport()) {
        var executeBtn = el('button', 'admin-btn admin-btn-primary admin-proposal-execute-btn', 'Execute');
        executeBtn.type = 'button';
        executeBtn.addEventListener('click', function () {
          executeProposal(proposal.id, [executeBtn]);
        });
        var executeActions = el('div', 'admin-proposal-card-actions');
        executeActions.appendChild(executeBtn);
        card.appendChild(executeActions);
      } else {
        card.appendChild(el('p', 'admin-proposal-mobile-execute-note', 'Execution can only be started from a desktop browser.'));
      }
    } else if (IN_PROGRESS_STATUSES.indexOf(proposal.status) !== -1) {
      card.appendChild(el('p', 'admin-proposal-card-reviewed-note', 'Execution in progress — reload this page to check its result.'));
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

  // Phase 14 — distinct from reviewProposal() above: this never itself
  // changes the website. It asks api/admin/bookings.js to claim the
  // proposal and dispatch the real execution workflow — see this file's
  // own top-of-file comment and agent/lib/execute-proposal.js's header.
  function executeProposal(id, buttonsToDisable) {
    if (actionInFlight) return;
    actionInFlight = true;
    buttonsToDisable.forEach(function (b) { b.disabled = true; });

    adminFetch('/api/admin/bookings?resource=agent-proposal', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: 'agent-proposal', id: id, action: 'execute' }),
    })
      .then(function (res) {
        if (handleAuthRedirect(res)) return null;
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not start execution.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return;
        load();
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not start execution.');
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
