// /admin/website-agent/ — Website Agent command-center dashboard.
//
// A UI-organization pass around the EXISTING Site Improvement Agent
// (agent/lib/*, Phases 1-6) — this page does not change Agent decision
// logic, the database model, or any Google integration. It reads:
//   - GET /api/admin/bookings?view=agent-dashboard (new view, same
//     existing Vercel function as every other agent-* view — see that
//     handler's own header in api/admin/bookings.js) for health/status,
//     integration flags, cumulative metrics, the latest/daily/weekly run
//     summaries, the activity feed, and whatever real first-party search
//     evidence the agent has gathered.
//   - GET /api/admin/bookings?view=agent-proposals (existing, Supabase-
//     backed) for the live approval queue and recent approve/reject
//     events merged into the activity feed.
//
// Approve/Reject still only ever PATCHes resource:"agent-proposal" (the
// exact existing endpoint admin/agent-proposals.js already uses) — this
// page does not bypass or duplicate that safety architecture, just gives
// it a more prominent home. Every dynamic value is written with
// createElement/textContent, never innerHTML — same discipline as every
// other admin script in this project.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('wa-loading');
  var notConnectedEl = document.getElementById('wa-not-connected');
  var bodyEl = document.getElementById('wa-body');
  var operationsEl = document.getElementById('wa-operations');

  var actionInFlight = false;

  // Phase 14 hotfix — this dashboard's own Approval Queue only ever
  // showed status "proposed" (see renderQueue()/load() below), so the
  // instant Execute moved a proposal to "applying" it simply vanished
  // from this page with no execution status visible anywhere on it —
  // even though the proposal was still fully alive and actionable at
  // /admin/agent-proposals/, which already understands this whole
  // lifecycle (same STATUS_LABELS there). A proposal must never appear
  // to disappear just because Execute was clicked — same status labels
  // reused here, not re-invented, so the two pages can never drift.
  var EXECUTION_STATUS_LABELS = {
    applying: 'Applying…',
    validating: 'Validating…',
    deploying: 'Deploying…',
    deployed: 'Deployed',
    failed: 'Failed',
    needs_review: 'Needs review (execution stopped)',
  };
  var EXECUTION_LIFECYCLE_STATUSES = Object.keys(EXECUTION_STATUS_LABELS);

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // Long-card-list fix (2026-10, after two false starts: collapsing whole
  // sections looked "dead" with nothing visible, and a subtle inline
  // chevron on the section label read as "the section vanished" rather
  // than "click to expand") — render only the first `limit` item(s) of a
  // long card list, with an explicit, clearly-labeled button to reveal
  // the rest (and collapse back). A real button (not a bare disclosure
  // triangle) so "there's more here" is never ambiguous. `items.length
  // <= limit` renders every item with no button at all — never a button
  // that would do nothing.
  function renderExpandableList(container, items, buildItemFn, limit) {
    clear(container);
    if (!items || !items.length) return;
    var expanded = false;
    function paint() {
      clear(container);
      var visible = expanded ? items : items.slice(0, limit);
      visible.forEach(function (item) {
        container.appendChild(buildItemFn(item));
      });
      if (items.length > limit) {
        var toggleBtn = el('button', 'admin-btn admin-btn-primary admin-wa-list-toggle-btn', expanded ? 'Show less ▲' : 'Show ' + (items.length - limit) + ' more ▼');
        toggleBtn.type = 'button';
        toggleBtn.addEventListener('click', function () {
          expanded = !expanded;
          paint();
        });
        container.appendChild(toggleBtn);
      }
    }
    paint();
  }
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
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
  function formatRelative(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var now = new Date();
    var isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return (isToday ? 'Today, ' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ') + time;
  }
  function evidenceLine(item) {
    if (!item || typeof item !== 'object') return String(item);
    var parts = [];
    if (item.field) parts.push(item.field);
    if (item.value !== undefined) parts.push(JSON.stringify(item.value));
    if (item.file) parts.push('(' + item.file + ')');
    return parts.join(' ') || JSON.stringify(item);
  }

  // Site Improvement Agent, Phase 15 — the classification badge / Copy
  // Claude Report / View Research block, duplicated from
  // admin/agent-proposals.js's own copy (same per-page-duplication
  // convention this file's header already follows for the rest of the
  // proposal-card rendering) so this dashboard's "Needs Your Review"
  // queue shows the same new-workflow UI as the dedicated review page,
  // instead of silently staying on the pre-Phase-15 card forever.
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

  // -----------------------------------------------------------------
  // Overall status pill
  // -----------------------------------------------------------------
  var STATUS_TEXT = {
    healthy: 'SYSTEM HEALTHY',
    'needs-attention': 'NEEDS ATTENTION',
    'research-pending': 'RESEARCH PENDING',
    failed: 'RUN FAILED',
    'not-connected': 'NOT CONNECTED YET',
    unknown: 'STATUS UNKNOWN',
  };
  function renderStatusPill(status) {
    var pill = document.getElementById('wa-status-pill');
    var dot = document.getElementById('wa-status-dot');
    var text = document.getElementById('wa-status-text');
    pill.className = 'admin-wa-status-pill admin-wa-status-pill-' + status;
    dot.className = 'admin-wa-status-dot admin-wa-status-dot-' + status;
    text.textContent = STATUS_TEXT[status] || STATUS_TEXT.unknown;
  }

  // The immediate reason behind a non-healthy status, shown right under
  // the pill — reuses the SAME healthSummary.text agent/lib/report.js
  // already computes for the latest run (e.g. "1 proposal awaiting
  // approval"), never a new/invented line. Hidden entirely once the
  // status is healthy (or there's nothing to explain), same restrained
  // posture as every other "only show it when it's real" state on this
  // page.
  function renderStatusReason(status, latestRun) {
    var reasonEl = document.getElementById('wa-status-reason');
    var text = latestRun && latestRun.healthSummary && latestRun.healthSummary.text;
    if (status === 'healthy' || status === 'not-connected' || !text) {
      reasonEl.hidden = true;
      reasonEl.textContent = '';
      return;
    }
    reasonEl.hidden = false;
    reasonEl.textContent = text;
  }

  // -----------------------------------------------------------------
  // Integration indicators — GSC / GA4 / CRM DATA / PROPOSAL SYNC.
  // Audit fix: GSC/GA4 now carry a real 4-state status object
  // ({state: 'connected'|'error'|'stale'|'not_configured', reason,
  // checkedAt} — see api/admin/bookings.js's handleAgentDashboard(),
  // which derives this from agent/history/integration-health.json, a
  // REAL probe result from the GitHub Actions runner, never from this
  // Vercel function's own env vars) instead of a plain configured-or-not
  // boolean — a credential that's present but broken now reads as ERROR,
  // never a false CONNECTED, and an API/auth failure is never collapsed
  // into NOT CONFIGURED. CRM DATA/PROPOSAL SYNC stay plain booleans (a
  // real Supabase client IS constructible in this Vercel function, so a
  // presence check is still the honest answer for those two) — this
  // function accepts either shape. No secret value ever reaches this
  // page either way.
  // -----------------------------------------------------------------
  var INTEGRATION_STATE_LABELS = { connected: 'CONNECTED', error: 'ERROR', stale: 'STALE', not_configured: 'NOT CONFIGURED' };
  function buildIntegrationChip(label, value) {
    var state = value && typeof value === 'object' ? value.state : value ? 'connected' : 'not_configured';
    var reason = value && typeof value === 'object' ? value.reason : null;
    var stateClass = 'is-' + String(state).replace(/_/g, '-');
    var chip = el('span', 'admin-wa-integration-chip ' + stateClass);
    chip.appendChild(el('span', 'admin-wa-integration-dot'));
    chip.appendChild(el('span', null, label + ' ● ' + (INTEGRATION_STATE_LABELS[state] || 'NOT CONFIGURED')));
    if (reason) chip.title = reason;
    return chip;
  }
  function renderIntegrations(integrations) {
    var wrap = document.getElementById('wa-integrations');
    clear(wrap);
    if (!integrations) return;
    wrap.appendChild(buildIntegrationChip('GSC', integrations.gsc));
    wrap.appendChild(buildIntegrationChip('GA4', integrations.ga4));
    wrap.appendChild(buildIntegrationChip('CRM DATA', integrations.crmData));
    wrap.appendChild(buildIntegrationChip('PROPOSAL SYNC', integrations.proposalSync));
  }

  // -----------------------------------------------------------------
  // Top metrics — split into two unambiguous timeframes (final-polish
  // fix: these used to sit in one undifferentiated row, where a lifetime
  // sum like "126 Findings" could easily be misread as "126 things wrong
  // right now"):
  //   - CURRENT STATUS: pagesMonitored (the latest run's own page count)
  //     and the LIVE needs-review queue count — both reflect right now,
  //     never a sum across history.
  //   - ALL-TIME TOTALS: cumulative counters across the Agent's full run
  //     history (see the server's own header for why these are sums, not
  //     invented scores), clearly labeled as such in the section heading.
  // -----------------------------------------------------------------
  function buildMetricCard(label, value) {
    var card = el('div', 'admin-wa-metric-card');
    card.appendChild(el('div', 'admin-wa-metric-value', typeof value === 'number' ? String(value) : '—'));
    card.appendChild(el('div', 'admin-wa-metric-label', label));
    return card;
  }
  function renderMetrics(metrics, liveNeedsReviewCount) {
    var currentWrap = document.getElementById('wa-metrics-current');
    var lifetimeWrap = document.getElementById('wa-metrics-lifetime');
    clear(currentWrap);
    clear(lifetimeWrap);
    if (!metrics) return;

    currentWrap.appendChild(buildMetricCard('Pages Monitored', metrics.pagesMonitored));
    currentWrap.appendChild(buildMetricCard('Needs Review', liveNeedsReviewCount));

    lifetimeWrap.appendChild(buildMetricCard('Findings', metrics.findingsTotal));
    lifetimeWrap.appendChild(buildMetricCard('Changes Applied', metrics.changesAppliedTotal));
    lifetimeWrap.appendChild(buildMetricCard('Research Completed', metrics.researchCompletedTotal));
    lifetimeWrap.appendChild(buildMetricCard('No-Change Decisions', metrics.noChangeDecisionsTotal));
  }

  // -----------------------------------------------------------------
  // Daily / Weekly schedule panels — last-run info now; the "NEXT RUN"
  // row is a labeled placeholder so a real value can appear later
  // without a layout change, once scheduling is ever enabled (explicitly
  // NOT implemented by this pass).
  // -----------------------------------------------------------------
  function runTypeLabel(runType) {
    if (runType === 'daily') return 'Daily';
    if (runType === 'weekly') return 'Weekly';
    return 'Manual';
  }
  function renderScheduleCard(containerId, lastRun) {
    var container = document.getElementById(containerId);
    clear(container);
    if (!lastRun) {
      container.appendChild(el('p', 'admin-wa-muted', 'No run recorded yet.'));
      return;
    }
    container.appendChild(el('div', 'admin-wa-schedule-line', 'Last run: ' + formatRelative(lastRun.timestamp)));
    var outcomeStatus = (lastRun.healthSummary && lastRun.healthSummary.status) || (lastRun.failed ? 'failed' : 'unknown');
    var statusLine = el('div', 'admin-wa-schedule-line');
    statusLine.appendChild(el('span', 'admin-status-badge admin-report-row-outcome-' + outcomeStatus, runOutcomeLabel(lastRun)));
    container.appendChild(statusLine);
    if (typeof lastRun.pagesChecked === 'number') {
      container.appendChild(el('div', 'admin-wa-schedule-line admin-wa-muted', lastRun.pagesChecked + ' pages checked'));
    }
    container.appendChild(el('div', 'admin-wa-schedule-next', 'NEXT RUN — not scheduled'));
  }
  function runOutcomeLabel(run) {
    if (run.failed) return 'Failed';
    var status = (run.healthSummary && run.healthSummary.status) || 'unknown';
    if (status === 'research-pending') return (run.researchQuestionsRaisedCount || 0) + ' Pending';
    if (status === 'all-clear') return 'All Clear';
    if (status === 'needs-attention') {
      if (run.proposalsAwaitingApprovalCount > 0) return run.proposalsAwaitingApprovalCount + ' Proposal' + (run.proposalsAwaitingApprovalCount === 1 ? '' : 's');
      return 'Needs Attention';
    }
    return '—';
  }

  // -----------------------------------------------------------------
  // Latest Run panel
  // -----------------------------------------------------------------
  function renderLatestRun(run) {
    var panel = document.getElementById('wa-latest-run');
    clear(panel);
    if (!run) {
      panel.appendChild(el('p', 'admin-wa-muted', 'No run recorded yet.'));
      return;
    }
    var top = el('div', 'admin-wa-latest-run-top');
    top.appendChild(el('span', 'admin-status-badge admin-report-row-type', runTypeLabel(run.runType)));
    top.appendChild(el('span', 'admin-wa-latest-run-time', formatRelative(run.timestamp)));
    panel.appendChild(top);

    if (run.healthSummary && run.healthSummary.text) {
      panel.appendChild(el('p', 'admin-wa-latest-run-health admin-wa-health-text-' + run.healthSummary.status, run.healthSummary.text));
    } else if (run.failureMessage) {
      panel.appendChild(el('p', 'admin-wa-latest-run-health admin-wa-health-text-failed', run.failureMessage));
    }

    var stats = el('div', 'admin-wa-latest-run-stats');
    function stat(value, label) {
      var cell = el('div', 'admin-wa-latest-run-stat');
      cell.appendChild(el('div', 'admin-wa-latest-run-stat-value', value === null || value === undefined ? '—' : String(value)));
      cell.appendChild(el('div', 'admin-wa-latest-run-stat-label', label));
      stats.appendChild(cell);
    }
    stat(run.pagesChecked, 'pages scanned');
    stat(run.observationsCount, 'observations');
    stat(run.proposalsCreatedOrUpdatedCount, 'proposal' + (run.proposalsCreatedOrUpdatedCount === 1 ? '' : 's'));
    stat(run.safeFixesAppliedCount, 'fixes applied');
    stat(run.researchQuestionsRaisedCount, 'research tasks');
    panel.appendChild(stats);

    var link = document.createElement('a');
    link.className = 'admin-wa-more-link';
    link.href = '/admin/agent-reports/?run=' + encodeURIComponent(run.runId);
    link.textContent = 'View Full Report →';
    panel.appendChild(link);
  }

  // -----------------------------------------------------------------
  // Approval queue — reuses the exact existing agent_proposals
  // approve/reject workflow (admin/agent-proposals.js's own PATCH
  // contract, duplicated here per this project's established per-page-
  // duplication convention — see admin/home.js's header for the same
  // reasoning elsewhere in this app).
  // -----------------------------------------------------------------
  function buildQueueCard(proposal) {
    var card = el('div', 'admin-proposal-card admin-wa-queue-card');
    var top = el('div', 'admin-proposal-card-top');
    top.appendChild(el('span', null, proposal.findingType));
    top.appendChild(el('span', 'admin-status-badge admin-proposal-status-' + proposal.status, 'Needs review'));
    card.appendChild(top);

    // Phase 15 — importance and evidence confidence as two SEPARATE
    // badges (see admin.css's own header on this page's twin,
    // admin/agent-proposals.js, for why they're never collapsed into
    // one). Absent entirely for a legacy proposal (synced before this
    // workflow existed) — a plain note instead, never a misleading
    // blank badge.
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
    card.appendChild(el('p', 'admin-proposal-card-meta', 'Created ' + formatDateTime(proposal.createdAt)));
    if (proposal.decisionReason) {
      card.appendChild(el('p', 'admin-proposal-card-reason', proposal.decisionReason));
    }

    if (Array.isArray(proposal.evidence) && proposal.evidence.length) {
      card.appendChild(el('p', 'admin-proposal-card-meta', 'Evidence:'));
      var evidenceList = el('ul', 'admin-proposal-card-meta');
      evidenceList.style.margin = '0 0 8px';
      evidenceList.style.paddingLeft = '18px';
      proposal.evidence.slice(0, 5).forEach(function (item) {
        evidenceList.appendChild(el('li', null, evidenceLine(item)));
      });
      card.appendChild(evidenceList);
    }

    // Phase 15 — the primary new-workflow action. Only rendered when a
    // handoff report actually exists (IMPORTANT-classified proposals
    // only — see proposals-sync.js's buildHandoffReportIfImportant()).
    // "View Research" is the optional secondary action, only added when
    // there's actually something to show.
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

    var noteInput = el('textarea', 'admin-proposal-card-note-input');
    noteInput.rows = 2;
    noteInput.placeholder = 'Optional note (e.g. why you approved/rejected this)';
    card.appendChild(noteInput);
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

    return card;
  }

  function renderQueue(proposed) {
    var listEl = document.getElementById('wa-queue-list');
    var emptyEl = document.getElementById('wa-queue-empty');
    var countEl = document.getElementById('wa-queue-count');
    clear(listEl);
    countEl.textContent = proposed.length ? '(' + proposed.length + ')' : '';
    if (!proposed.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    renderExpandableList(listEl, proposed, buildQueueCard, 1);
  }

  // Phase 14 hotfix — the execution-in-progress / recently-executed
  // card: deliberately read-only (no Approve/Reject/Execute here — this
  // page is not where those actions live) so a proposal moving through
  // applying -> validating -> deploying -> deployed/failed/needs_review
  // always stays VISIBLE on this dashboard, with a link to
  // /admin/agent-proposals/ for whatever action (re-approve to retry,
  // etc.) its status allows next.
  function buildExecutionCard(proposal) {
    var card = el('div', 'admin-proposal-card admin-wa-queue-card');
    var top = el('div', 'admin-proposal-card-top');
    top.appendChild(el('span', null, proposal.findingType));
    top.appendChild(el('span', 'admin-status-badge admin-proposal-status-' + proposal.status, EXECUTION_STATUS_LABELS[proposal.status] || proposal.status));
    card.appendChild(top);

    card.appendChild(el('p', 'admin-proposal-card-summary', proposal.summary));

    var exec = proposal.execution || {};
    if (exec.failureReason) {
      card.appendChild(el('p', 'admin-proposal-execution-failure', exec.failureReason));
    }
    if (exec.commitSha) {
      card.appendChild(el('p', 'admin-proposal-card-meta', 'Commit: ' + exec.commitSha.slice(0, 12) + (exec.filesChanged ? ' (' + exec.filesChanged.join(', ') + ')' : '')));
    }

    var link = el('a', 'admin-wa-more-link', 'View / act on this in the full proposals list →');
    link.href = '/admin/agent-proposals/';
    card.appendChild(link);
    return card;
  }

  function renderExecutionStatus(proposals) {
    var section = document.getElementById('wa-execution-section');
    var listEl = document.getElementById('wa-execution-list');
    var countEl = document.getElementById('wa-execution-count');
    clear(listEl);
    var inProgress = (proposals || []).filter(function (p) { return EXECUTION_LIFECYCLE_STATUSES.indexOf(p.status) !== -1; });
    if (!inProgress.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    countEl.textContent = '(' + inProgress.length + ')';
    inProgress.forEach(function (p) { listEl.appendChild(buildExecutionCard(p)); });
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

  // -----------------------------------------------------------------
  // Search intelligence — stored Supabase snapshots only (see
  // api/admin/bookings.js's handleAgentDashboard() / agent/lib/search-
  // snapshots.js's latestSnapshots()). An honest "not yet collected" /
  // "property not configured" / "storage unavailable" state when there's
  // nothing real to show — never a fabricated chart. Clearly labeled as
  // raw Google evidence, distinct from any Agent conclusion.
  // -----------------------------------------------------------------
  function renderEvidencePanel(containerId, title, evidence) {
    var panel = document.getElementById(containerId);
    clear(panel);
    panel.appendChild(el('div', 'admin-wa-panel-title', title));
    renderSnapshot(panel, evidence || { available: false, state: 'storage_error' }, title === 'GA4');
  }
  // Charts summarize only the rows in this stored snapshot, not a time series.
  function renderSnapshotVisuals(panel, evidence, isGa4) {
    var totals = evidence.snapshot.totals;
    var metrics = isGa4
      ? [['Organic users', totals.organic_users], ['Organic sessions', totals.organic_sessions], ['Engaged sessions', totals.engaged_sessions], ['Property key events', totals.key_events]]
      : [['Search clicks', totals.clicks], ['Impressions', totals.impressions], ['Click-through rate', (Number(totals.ctr || 0) * 100).toFixed(2) + '%'], ['Average position', Number(totals.position || 0).toFixed(1)]];
    var cards = el('div', 'admin-wa-search-metrics');
    metrics.forEach(function (metric) {
      var card = el('div', 'admin-wa-search-stat');
      card.appendChild(el('span', 'admin-wa-search-value', metric[1] === undefined || metric[1] === null ? '—' : String(metric[1])));
      card.appendChild(el('span', 'admin-wa-search-label', metric[0]));
      cards.appendChild(card);
    });
    panel.appendChild(cards);
    var field = isGa4 ? 'organic_sessions' : 'clicks';
    var rows = (evidence.rows || []).filter(function (row) { return Number.isFinite(Number(row[field])) && Number(row[field]) >= 0; })
      .slice().sort(function (a, b) { return Number(b[field]) - Number(a[field]); }).slice(0, 5);
    if (!rows.length) return;
    var chart = el('div', 'admin-wa-bar-chart');
    chart.setAttribute('role', 'figure');
    chart.setAttribute('aria-label', isGa4 ? 'Top stored landing pages by organic sessions' : 'Top stored query and landing-page rows by clicks');
    chart.appendChild(el('div', 'admin-wa-chart-title', isGa4 ? 'Landing-page sessions' : 'Query clicks'));
    chart.appendChild(el('p', 'admin-wa-muted', 'Top 5 stored rows · selected snapshot period'));
    var max = Math.max.apply(null, rows.map(function (row) { return Number(row[field]); }));
    rows.forEach(function (row) {
      var label = isGa4 ? row.landing_page : row.query;
      var entry = el('div', 'admin-wa-bar-row');
      var heading = el('div', 'admin-wa-bar-heading');
      var name = el('span', 'admin-wa-bar-name', label);
      name.title = isGa4 ? label : label + ' · ' + row.landing_page;
      heading.appendChild(name);
      heading.appendChild(el('span', 'admin-wa-bar-number', String(row[field])));
      entry.appendChild(heading);
      if (!isGa4) entry.appendChild(el('small', 'admin-wa-bar-page', row.landing_page));
      var track = el('div', 'admin-wa-bar-track');
      track.setAttribute('aria-hidden', 'true');
      var bar = el('div', 'admin-wa-bar-fill');
      bar.style.width = (max > 0 ? Number(row[field]) / max * 100 : 0) + '%';
      track.appendChild(bar); entry.appendChild(track); chart.appendChild(entry);
    });
    panel.appendChild(chart);
  }

  function renderSnapshot(panel, evidence, isGa4) {
    if (evidence.state === 'property_not_configured') {
      panel.appendChild(el('p', 'admin-wa-evidence-context', (isGa4 ? 'GA4_PROPERTY_ID' : 'GSC_SITE_URL') + ' is not configured on the admin runtime — snapshot evidence is hidden rather than shown unscoped across properties.'));
      return;
    }
    if (evidence.state === 'failed' || evidence.state === 'storage_error') {
      panel.appendChild(el('p', 'admin-wa-evidence-context', evidence.state === 'storage_error' ? 'Snapshot storage unavailable — check database setup.' : 'Latest collection failed: ' + (evidence.attempt && evidence.attempt.error_category || 'API error') + '.'));
    }
    if (!evidence.available) {
      panel.appendChild(el('p', 'admin-wa-muted', evidence.state === 'not_collected' ? 'Not yet collected — no successful snapshot stored.' : 'No successful snapshot available. Collection did not return a valid empty report.'));
      return;
    }
    var snap = evidence.snapshot;
    var totals = snap.totals;
    function percent(n) { return (Number(n || 0) * 100).toFixed(2) + '%'; }
    panel.appendChild(el('p', 'admin-wa-evidence-meta', snap.period_start + ' – ' + snap.period_end + ' · ' + snap.property));
    panel.appendChild(el('p', 'admin-wa-evidence-meta', 'Last successful collection: ' + new Date(snap.collected_at).toLocaleString()));
    if (Date.now() - new Date(snap.collected_at).getTime() > 36 * 3600000) panel.appendChild(el('p', 'admin-wa-muted', 'Stored evidence is stale; awaiting a successful refresh.'));
    panel.appendChild(el('p', 'admin-wa-snapshot-totals', isGa4
      ? totals.organic_users + ' organic users · ' + totals.organic_sessions + ' sessions · ' + totals.engaged_sessions + ' engaged · ' + percent(totals.engagement_rate) + ' engagement rate · ' + totals.key_events + ' property key events'
      : totals.clicks + ' clicks · ' + totals.impressions + ' impressions · ' + percent(totals.ctr) + ' CTR · ' + Number(totals.position).toFixed(1) + ' average position'));
    if (isGa4) {
      panel.appendChild(el('p', 'admin-wa-muted', 'Conversion mapping unresolved — property key events are not verified booking conversions.'));
      var events = snap.metadata.events || [];
      panel.appendChild(el('p', 'admin-wa-evidence-meta', snap.metadata.eventStatus === 'collection_failed' ? 'Lead event counts: collection failed.' : 'Tracked event counts: ' + (events.map(function (e) { return e.event + ': ' + e.count; }).join(' · ') || 'zero matching events')));
    }
    renderSnapshotVisuals(panel, evidence, isGa4);
    var details = el('details', 'admin-wa-raw-evidence');
    details.appendChild(el('summary', '', 'Inspect raw evidence rows'));
    var wrap = el('div', 'admin-wa-snapshot-scroll');
    var table = el('table', 'admin-wa-snapshot-table');
    var head = el('thead'); var header = el('tr');
    (isGa4 ? ['Landing page', 'Users', 'Sessions', 'Engaged', 'Engagement', 'Key events'] : ['Query', 'Clicks', 'Impressions', 'CTR', 'Position', 'Ranking landing page']).forEach(function (label) { header.appendChild(el('th', '', label)); });
    head.appendChild(header); table.appendChild(head);
    var body = el('tbody');
    (evidence.rows || []).forEach(function (r) {
      var tr = el('tr');
      var values = isGa4 ? [r.landing_page, r.organic_users, r.organic_sessions, r.engaged_sessions, percent(r.engagement_rate), r.key_events] : [r.query, r.clicks, r.impressions, percent(r.ctr), Number(r.position).toFixed(1), r.landing_page];
      values.forEach(function (v) { tr.appendChild(el('td', '', String(v))); }); body.appendChild(tr);
    });
    table.appendChild(body); wrap.appendChild(table); details.appendChild(wrap); panel.appendChild(details);
    if (!(evidence.rows || []).length) panel.appendChild(el('p', 'admin-wa-muted', 'Successful collection returned zero rows.'));
    panel.appendChild(el('p', 'admin-wa-evidence-limitations', snap.metadata.limitations || ''));
    panel.appendChild(el('p', 'admin-wa-evidence-meta', 'Raw Google evidence, not an Agent conclusion. Metrics alone do not justify a website change.'));
  }

  // -----------------------------------------------------------------
  // Keyword Opportunities (Phase 2) — explainable classification of real
  // Search Console queries, computed server-side by agent/lib/keyword-
  // opportunities.js (see api/admin/bookings.js's handleAgentDashboard()).
  // Evidence/recommendations only — this panel never triggers a website
  // change; the existing proposal queue above is still the only path to
  // one. Honest empty/unavailable states, same spirit as renderSnapshot().
  // -----------------------------------------------------------------
  var KW_CATEGORY_ORDER = ['priority-now', 'near-page-1', 'ctr-opportunity', 'content-gap', 'protect-maintain'];
  var KW_PRIORITY_CLASS = { HIGH: 'admin-wa-kw-priority-high', MEDIUM: 'admin-wa-kw-priority-medium', LOW: 'admin-wa-kw-priority-low', MAINTAIN: 'admin-wa-kw-priority-maintain' };
  var KW_CONFIDENCE_CLASS = { HIGH: 'admin-wa-kw-confidence-high', MEDIUM: 'admin-wa-kw-confidence-medium', LOW: 'admin-wa-kw-confidence-low' };

  function percent1(n) { return (Number(n || 0) * 100).toFixed(2) + '%'; }

  // Card layout is deliberately operational, not a debug log (independent-
  // review feedback): query+priority first, then how much to TRUST that
  // priority (evidence confidence — a separate axis, never folded into
  // priority itself), then the suggested action (the one thing a reader
  // actually needs to decide on), then the raw metrics, and finally the
  // scoring "reasons" as supporting detail at the bottom, not the headline.
  function buildKwCard(item) {
    var card = el('div', 'admin-wa-kw-card' + (item.likelyLocalPack ? ' admin-wa-kw-card-localpack' : ''));

    var top = el('div', 'admin-wa-kw-card-top');
    top.appendChild(el('span', 'admin-wa-kw-query', item.query));
    top.appendChild(el('span', 'admin-wa-kw-priority ' + (KW_PRIORITY_CLASS[item.priority] || ''), item.priority));
    card.appendChild(top);

    var confRow = el('div', 'admin-wa-kw-confidence-row');
    confRow.appendChild(el('span', 'admin-wa-kw-confidence ' + (KW_CONFIDENCE_CLASS[item.evidenceConfidence] || ''), (item.evidenceConfidence || '—') + ' confidence'));
    if (item.likelyLocalPack) confRow.appendChild(el('span', 'admin-wa-kw-tag admin-wa-kw-tag-localpack', 'Possible local-pack effect'));
    if (item.contentGapSeverityLabel) confRow.appendChild(el('span', 'admin-wa-kw-tag', item.contentGapSeverityLabel));
    card.appendChild(confRow);

    card.appendChild(el('p', 'admin-wa-kw-action', item.recommendedAction));

    card.appendChild(el('p', 'admin-wa-evidence-meta',
      item.metrics.impressions + ' impressions · ' + item.metrics.clicks + ' clicks · ' + percent1(item.metrics.ctr) + ' CTR · position ' + Number(item.metrics.position).toFixed(1)));
    card.appendChild(el('p', 'admin-wa-evidence-meta', 'Landing page: ' + item.landingPage.label));
    if (item.trend && item.trend.landingPageChanged) {
      card.appendChild(el('p', 'admin-wa-muted', 'Note: the ranking page changed since the prior period, so trend was not scored.'));
    }
    if (item.alsoQualifiesFor && item.alsoQualifiesFor.length) {
      var labels = item.alsoQualifiesFor.map(function (k) { return KW_CATEGORY_LABELS[k] || k; }).join(', ');
      card.appendChild(el('p', 'admin-wa-muted', 'Also relevant to: ' + labels));
    }

    var reasons = el('ul', 'admin-wa-kw-reasons');
    (item.reasons || []).forEach(function (r) { reasons.appendChild(el('li', '', r)); });
    card.appendChild(reasons);

    return card;
  }

  var KW_CATEGORY_LABELS = { 'priority-now': 'Priority Now', 'near-page-1': 'Near Page 1', 'ctr-opportunity': 'CTR Opportunity', 'content-gap': 'Content Gap', 'protect-maintain': 'Protect / Maintain' };

  function renderKeywordOpportunities(data) {
    var metaEl = document.getElementById('wa-kw-meta');
    var groupsEl = document.getElementById('wa-kw-groups');
    clear(groupsEl);

    if (!data || !data.available) {
      var state = data && data.state;
      metaEl.textContent = state === 'property_not_configured'
        ? 'GSC_SITE_URL is not configured on the admin runtime — keyword opportunities are hidden rather than shown unscoped.'
        : state === 'not_collected'
          ? 'Not yet collected — no successful Search Console snapshot stored.'
          : state === 'failed'
            ? 'Latest Search Console collection failed — keyword opportunities need a successful snapshot.'
            : 'Keyword-opportunity evidence unavailable — check database setup.';
      return;
    }

    metaEl.textContent = data.period.start + ' – ' + data.period.end + ' · ' + data.totalQueriesAnalyzed + ' queries analyzed'
      + (data.excludedLowEvidenceCount ? ' · ' + data.excludedLowEvidenceCount + ' excluded as low-evidence' : '')
      + (data.previousPeriod ? ' · trend vs. ' + data.previousPeriod.start + ' – ' + data.previousPeriod.end : ' · no prior-period trend available');

    var filters = el('div', 'admin-wa-kw-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Filter keyword opportunities');
    var filterButtons = [];
    ['all'].concat(KW_CATEGORY_ORDER).forEach(function (key) {
      var group = data.categories && data.categories[key];
      var button = el('button', 'admin-wa-kw-filter', key === 'all' ? 'All opportunities' : KW_CATEGORY_LABELS[key] + ' (' + (group ? group.total : 0) + ')');
      button.type = 'button';
      button.setAttribute('aria-pressed', key === 'all' ? 'true' : 'false');
      button.addEventListener('click', function () {
        filterButtons.forEach(function (other) { other.setAttribute('aria-pressed', other === button ? 'true' : 'false'); });
        Array.prototype.forEach.call(groupsEl.querySelectorAll('[data-kw-category]'), function (section) {
          section.hidden = key !== 'all' && section.getAttribute('data-kw-category') !== key;
        });
      });
      filterButtons.push(button); filters.appendChild(button);
    });
    groupsEl.appendChild(filters);

    KW_CATEGORY_ORDER.forEach(function (key) {
      var group = data.categories && data.categories[key];
      var section = el('div', 'admin-wa-kw-group');
      section.setAttribute('data-kw-category', key);
      var header = el('div', 'admin-wa-kw-group-header');
      header.appendChild(el('span', 'admin-wa-kw-group-title', KW_CATEGORY_LABELS[key]));
      header.appendChild(el('span', 'admin-wa-section-count', group ? '(' + group.total + ')' : '(0)'));
      section.appendChild(header);

      if (!group || !group.items.length) {
        section.appendChild(el('p', 'admin-wa-empty-note', 'Nothing in this category right now.'));
      } else {
        var list = el('div', 'admin-wa-kw-list');
        section.appendChild(list);
        renderExpandableList(list, group.items, buildKwCard, 1);
        if (group.total > group.items.length) {
          section.appendChild(el('p', 'admin-wa-muted', '+' + (group.total - group.items.length) + ' more not shown.'));
        }
      }
      groupsEl.appendChild(section);
    });
  }

  // -----------------------------------------------------------------
  // Agent activity — the dashboard's own flattened run/finding feed,
  // merged with APPROVED/REJECTED events read from the live proposals
  // fetch (those live in Supabase, not the history log — see
  // api/admin/bookings.js's handleAgentDashboard() header).
  // -----------------------------------------------------------------
  var ACTIVITY_ICON_GLYPH = {
    'scan-complete': '✓',
    'safe-fix': '✓',
    proposal: '!',
    research: '○',
    rejected: '✕',
    observation: '·',
    error: '✕',
    approved: '✓',
  };
  function buildActivityRow(event) {
    var row = el('div', 'admin-wa-activity-row');
    row.appendChild(el('span', 'admin-wa-activity-icon admin-wa-activity-icon-' + event.type, ACTIVITY_ICON_GLYPH[event.type] || '·'));
    var body = el('div', 'admin-wa-activity-body');
    var top = el('div', 'admin-wa-activity-top');
    top.appendChild(el('span', 'admin-wa-activity-label', event.label));
    top.appendChild(el('span', 'admin-wa-activity-time', formatRelative(event.timestamp)));
    body.appendChild(top);
    body.appendChild(el('div', 'admin-wa-activity-text', event.text));
    row.appendChild(body);
    return row;
  }
  var ACTIVITY_FEED_LIMIT = 40;
  function renderActivity(serverEvents, proposals) {
    var listEl = document.getElementById('wa-activity-list');
    clear(listEl);

    var reviewEvents = (proposals || [])
      .filter(function (p) { return (p.status === 'approved' || p.status === 'rejected') && p.reviewedAt; })
      .map(function (p) {
        return {
          timestamp: p.reviewedAt,
          type: p.status === 'approved' ? 'approved' : 'rejected',
          label: p.status === 'approved' ? 'APPROVED' : 'REJECTED',
          text: p.summary + (p.reviewedBy ? ' — by ' + p.reviewedBy : ''),
        };
      });

    var combined = (serverEvents || []).concat(reviewEvents);
    combined.sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
    combined = combined.slice(0, ACTIVITY_FEED_LIMIT);

    if (!combined.length) {
      listEl.appendChild(el('p', 'admin-wa-muted', 'No activity recorded yet.'));
      return;
    }
    renderExpandableList(listEl, combined, buildActivityRow, 1);
  }

  // -----------------------------------------------------------------
  // Fetch + render
  // -----------------------------------------------------------------
  function load() {
    Promise.all([
      adminFetch('/api/admin/bookings?view=agent-dashboard'),
      adminFetch('/api/admin/bookings?view=agent-proposals'),
    ])
      .then(function (results) {
        var dashRes = results[0], propRes = results[1];
        if (handleAuthRedirect(dashRes) || handleAuthRedirect(propRes)) return null;
        return Promise.all([
          dashRes.json().catch(function () { return null; }),
          propRes.json().catch(function () { return null; }),
        ]);
      })
      .then(function (bodies) {
        if (!bodies) return;
        var dash = bodies[0];
        var propBody = bodies[1];
        if (!dash || !dash.ok) throw new Error('Could not load the Website Agent dashboard.');

        loadingEl.style.display = 'none';

        renderEvidencePanel('wa-evidence-gsc', 'SEARCH CONSOLE', dash.searchIntelligence && dash.searchIntelligence.searchConsole);
        renderEvidencePanel('wa-evidence-ga4', 'GA4', dash.searchIntelligence && dash.searchIntelligence.ga4);
        renderKeywordOpportunities(dash.keywordOpportunities);
        if (!dash.connected) {
          notConnectedEl.style.display = 'block';
          bodyEl.style.display = 'none';
          operationsEl.style.display = 'none';
          return;
        }
        notConnectedEl.style.display = 'none';
        bodyEl.style.display = 'block';
        operationsEl.style.display = 'block';

        var proposals = (propBody && propBody.proposals) || [];
        var proposed = proposals.filter(function (p) { return p.status === 'proposed'; });

        renderStatusPill(dash.status);
        renderStatusReason(dash.status, dash.latestRun);
        renderIntegrations(dash.integrations);
        renderMetrics(dash.metrics, proposed.length);
        renderScheduleCard('wa-daily-body', dash.daily && dash.daily.lastRun);
        renderScheduleCard('wa-weekly-body', dash.weekly && dash.weekly.lastRun);
        renderLatestRun(dash.latestRun);
        renderQueue(proposed);
        renderExecutionStatus(proposals);
        renderActivity(dash.activity, proposals);
      })
      .catch(function (err) {
        loadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load the Website Agent dashboard.');
      });
  }

  load();
});
