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
  // Phase 16 — 'rejected' is now labeled "Dismissed" here (the Dismiss
  // button writes this exact same status — see sql/2026-10-28_phase16-
  // proposal-decision-states.sql's own header for why it reuses
  // 'rejected' rather than adding a new value). The three genuinely new
  // statuses (no_change/needs_revision/recheck) get their own labels.
  var STATUS_LABELS = {
    proposed: 'Needs review',
    approved: 'Approved / Pending execution',
    rejected: 'Dismissed',
    applied: 'Applied',
    validated: 'Validated',
    failed: 'Failed',
    applying: 'Applying…',
    validating: 'Validating…',
    deploying: 'Deploying…',
    deployed: 'Deployed',
    needs_review: 'Needs review (execution stopped)',
    no_change: 'Verified — No Change Needed',
    needs_revision: 'Needs Revision',
    recheck: 'Recheck Later',
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

  // Phase 16 — "Open Proposal" deep-linking from admin/website-agent.js's
  // queue/execution cards: /admin/agent-proposals/?id=<proposal.id>.
  // Read once at load; the matching card gets a stable DOM id (see
  // buildCard() below) so it can be scrolled into view and briefly
  // outlined once the list has rendered. Reusing the EXISTING
  // proposal.id/finding_key relationship already returned by ?view=
  // agent-proposals — no new identifier, no duplicate lookup, never a
  // reason to create a second proposal row for the same finding.
  var deepLinkProposalId = (function () {
    try {
      return new URLSearchParams(window.location.search).get('id') || null;
    } catch (e) {
      return null;
    }
  })();

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

  // Site Improvement Agent, Phase 15 — the new default workflow's core
  // UI surface: a classification badge, and a "Copy Claude Report"
  // action that puts the pre-generated handoff report (see
  // agent/lib/claude-handoff-report.js) on the clipboard so Gerardo can
  // paste it straight into Claude. Added to the EXISTING proposal card
  // — no new admin page, per the spec's own "do not build another admin
  // page" instruction.
  var RESEARCH_DETAIL_FIELDS = ['evidenceFor', 'evidenceAgainst', 'protectedSignals', 'risks', 'missingEvidence'];
  var RESEARCH_DETAIL_LABELS = {
    evidenceFor: 'Evidence for',
    evidenceAgainst: 'Evidence against',
    protectedSignals: 'Protected signals',
    risks: 'Risks',
    missingEvidence: 'Missing evidence',
  };

  function hasResearchDetail(classification) {
    return RESEARCH_DETAIL_FIELDS.some(function (key) {
      return Array.isArray(classification[key]) && classification[key].length > 0;
    });
  }

  function buildResearchPanel(classification) {
    var panel = el('div', 'admin-proposal-research-panel');
    RESEARCH_DETAIL_FIELDS.forEach(function (key) {
      var items = classification[key];
      if (!Array.isArray(items) || !items.length) return;
      panel.appendChild(el('p', 'admin-proposal-card-meta', RESEARCH_DETAIL_LABELS[key] + ':'));
      var list = el('ul', null);
      items.forEach(function (item) {
        list.appendChild(el('li', null, item));
      });
      panel.appendChild(list);
    });
    return panel;
  }

  function copyClaudeReport(text, button) {
    var original = button.textContent;
    function settle(ok) {
      button.textContent = ok ? 'Copied!' : 'Could not copy';
      setTimeout(function () {
        button.textContent = original;
      }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        settle(true);
      }).catch(function () {
        settle(false);
      });
    } else {
      settle(false);
    }
  }

  function buildCard(proposal) {
    var card = el('div', 'admin-proposal-card');
    // Phase 16 — a stable, deep-linkable id for every card (see
    // deepLinkProposalId above and highlightDeepLinkedCard() below).
    card.id = 'proposal-' + proposal.id;

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

    // Phase 15 — importance and evidence confidence are deliberately
    // two SEPARATE badges (see admin.css's own header: an IMPORTANT
    // finding with MEDIUM confidence is not the same as one with HIGH
    // confidence, and this UI never collapses the two into one pill).
    // Absent entirely for a legacy proposal (synced before this
    // workflow existed) — shown as a plain note instead, never a
    // misleading blank badge.
    if (proposal.opportunityClassification) {
      var classificationRow = el('div', 'admin-proposal-card-top');
      var importance = proposal.opportunityClassification.classification || 'UNKNOWN';
      classificationRow.appendChild(el('span', 'admin-status-badge admin-proposal-importance-' + importance.toLowerCase(), importance));
      if (proposal.opportunityClassification.evidenceConfidence) {
        classificationRow.appendChild(el('span', 'admin-proposal-confidence-badge', proposal.opportunityClassification.evidenceConfidence.toUpperCase() + ' confidence'));
      }
      card.appendChild(classificationRow);
    } else {
      card.appendChild(el('p', 'admin-proposal-card-reviewed-note', 'Legacy proposal — predates the research/classification workflow.'));
    }

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

    // Phase 15 — the primary new-workflow action. Only rendered when a
    // handoff report actually exists (IMPORTANT-classified proposals
    // only — see proposals-sync.js's buildHandoffReportIfImportant()) —
    // never a disabled button for a proposal that has none. "View
    // Research" is the optional secondary action the spec calls for,
    // only added when there's actually something to show.
    if (proposal.claudeHandoffReport) {
      var handoffActions = el('div', 'admin-proposal-card-actions');
      var copyBtn = el('button', 'admin-btn admin-btn-primary', 'Copy Claude Report');
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', function () {
        copyClaudeReport(proposal.claudeHandoffReport, copyBtn);
      });
      handoffActions.appendChild(copyBtn);

      if (proposal.opportunityClassification && hasResearchDetail(proposal.opportunityClassification)) {
        var researchPanel = buildResearchPanel(proposal.opportunityClassification);
        researchPanel.style.display = 'none';
        var viewResearchBtn = el('button', 'admin-btn admin-btn-outline', 'View Research');
        viewResearchBtn.type = 'button';
        viewResearchBtn.addEventListener('click', function () {
          var hidden = researchPanel.style.display === 'none';
          researchPanel.style.display = hidden ? 'block' : 'none';
          viewResearchBtn.textContent = hidden ? 'Hide Research' : 'View Research';
        });
        handoffActions.appendChild(viewResearchBtn);
        card.appendChild(handoffActions);
        card.appendChild(researchPanel);
      } else {
        card.appendChild(handoffActions);
      }
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

    // Phase 16 — RETRYABLE_STATUSES widened to include the two new
    // non-terminal decision states (needs_revision/recheck): both mean
    // "not resolved yet, still open for any of the 5 actions below" —
    // the same posture 'proposed'/'failed'/'needs_review' already had.
    // 'no_change' and 'rejected' (Dismiss) are deliberately NOT in this
    // list — see the final `else` branch below: those are resolved
    // outcomes that read as reviewed history, not unfinished work.
    var RETRYABLE_STATUSES = ['proposed', 'failed', 'needs_review', 'needs_revision', 'recheck'];
    var IN_PROGRESS_STATUSES = ['applying', 'validating', 'deploying'];

    if (RETRYABLE_STATUSES.indexOf(proposal.status) !== -1) {
      var noteInput = el('textarea', 'admin-proposal-card-note-input');
      noteInput.rows = 2;
      noteInput.placeholder = 'Optional note (e.g. why you chose this)';
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
        : 'Choosing any action below only updates this proposal’s decision here — it does not, by itself, change the website.';
      card.appendChild(el('p', 'admin-proposal-card-reviewed-note', reviewNoteText));

      // Phase 16 — five actions, one click each (no confirmation dialog
      // for any of them — see the spec's own UX requirement). Visual
      // hierarchy: Approve & Execute is the sole solid/primary button;
      // No Change and Recheck are neutral outlines; Needs Revision gets
      // its own warm-outline color (admin-btn-warn, admin.css) so it
      // reads as distinct from a plain neutral choice; Dismiss reuses
      // the existing danger-outline style Reject always had (same
      // status, same meaning — see sql/2026-10-28_phase16-proposal-
      // decision-states.sql's header).
      var actions = el('div', 'admin-proposal-card-actions');
      var approveBtn = el('button', 'admin-btn admin-btn-primary', 'Approve & Execute');
      approveBtn.type = 'button';
      var noChangeBtn = el('button', 'admin-btn admin-btn-outline', 'Verified — No Change Needed');
      noChangeBtn.type = 'button';
      var needsRevisionBtn = el('button', 'admin-btn admin-btn-warn', 'Needs Revision');
      needsRevisionBtn.type = 'button';
      var recheckBtn = el('button', 'admin-btn admin-btn-outline', 'Recheck Later');
      recheckBtn.type = 'button';
      var dismissBtn = el('button', 'admin-btn admin-btn-danger', 'Dismiss');
      dismissBtn.type = 'button';

      var decisionButtons = [approveBtn, noChangeBtn, needsRevisionBtn, recheckBtn, dismissBtn];

      approveBtn.addEventListener('click', function () {
        reviewProposal(proposal.id, 'approve', noteInput.value, decisionButtons);
      });
      noChangeBtn.addEventListener('click', function () {
        reviewProposal(proposal.id, 'no_change', noteInput.value, decisionButtons);
      });
      needsRevisionBtn.addEventListener('click', function () {
        reviewProposal(proposal.id, 'needs_revision', noteInput.value, decisionButtons);
      });
      recheckBtn.addEventListener('click', function () {
        reviewProposal(proposal.id, 'recheck', noteInput.value, decisionButtons);
      });
      dismissBtn.addEventListener('click', function () {
        reviewProposal(proposal.id, 'reject', noteInput.value, decisionButtons);
      });

      actions.appendChild(approveBtn);
      actions.appendChild(noChangeBtn);
      actions.appendChild(needsRevisionBtn);
      actions.appendChild(recheckBtn);
      actions.appendChild(dismissBtn);
      card.appendChild(actions);
    } else if (proposal.status === 'approved') {
      card.appendChild(el('p', 'admin-proposal-card-reviewed-note', 'Approved — ready to execute.'));
      // Phase 15 — Execute remains fully functional (legacy
      // functionality, per the spec: "do not remove existing execute
      // infrastructure"), but the new default workflow is Copy Claude
      // Report above, not Execute — labeled here so it's clear without
      // removing or disabling anything.
      card.appendChild(el('p', 'admin-proposal-card-reviewed-note', 'Execute is a legacy auto-apply path (today, only a single mechanical link-rewrite fixer). The current default workflow is Copy Claude Report above.'));

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
    highlightDeepLinkedCard();
  }

  // Phase 16 — scrolls the ?id=-matched card into view and briefly
  // outlines it (admin.css's .admin-proposal-card-linked), then clears
  // deepLinkProposalId so a later reload (after taking an action on some
  // OTHER card) doesn't keep jumping the page back to this one. Silently
  // does nothing if the id isn't found (e.g. a stale/bad link, or the
  // owner is viewing a status filter that happens to exclude it) —
  // never an error, since this is a pure navigation convenience.
  function highlightDeepLinkedCard() {
    if (!deepLinkProposalId) return;
    var target = document.getElementById('proposal-' + deepLinkProposalId);
    deepLinkProposalId = null;
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.classList.add('admin-proposal-card-linked');
    setTimeout(function () {
      target.classList.remove('admin-proposal-card-linked');
    }, 4000);
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
