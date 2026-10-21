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

  var actionInFlight = false;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
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
    proposed.forEach(function (p) {
      listEl.appendChild(buildQueueCard(p));
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

  // -----------------------------------------------------------------
  // Search intelligence — real, persisted first-party evidence only
  // (see api/admin/bookings.js's dashboardSearchIntelligence()). An
  // honest "not yet collected" state when nothing has ever been gathered
  // — never a fabricated chart. Clearly labeled as raw Google evidence,
  // distinct from any Agent conclusion.
  // -----------------------------------------------------------------
  function renderEvidencePanel(containerId, title, evidence, rowColumns) {
    var panel = document.getElementById(containerId);
    clear(panel);
    panel.appendChild(el('div', 'admin-wa-panel-title', title));

    if (!evidence || !evidence.available) {
      panel.appendChild(el('p', 'admin-wa-muted', 'Not yet collected — the Agent hasn’t gathered this evidence yet.'));
      return;
    }

    panel.appendChild(el('p', 'admin-wa-evidence-meta', evidence.window ? evidence.window.label : ''));
    panel.appendChild(el('p', 'admin-wa-evidence-meta', 'Scope: ' + (evidence.scope ? evidence.scope.type + ' — ' + evidence.scope.value : '—')));
    panel.appendChild(el('p', 'admin-wa-evidence-context', evidence.context));

    if (Array.isArray(evidence.rows) && evidence.rows.length) {
      var table = el('div', 'admin-wa-evidence-rows');
      evidence.rows.forEach(function (row) {
        table.appendChild(rowColumns(row));
      });
      panel.appendChild(table);
    } else {
      panel.appendChild(el('p', 'admin-wa-muted', 'No rows returned for this query.'));
    }

    panel.appendChild(el('p', 'admin-wa-evidence-limitations', evidence.limitations));
    panel.appendChild(el('p', 'admin-wa-evidence-meta', 'Gathered ' + formatRelative(evidence.gatheredAt) + ' · ' + (evidence.freshness || 'unknown') + ' · raw Google evidence, not an Agent conclusion'));
  }
  function gscRow(row) {
    var line = el('div', 'admin-wa-evidence-row');
    var key = Array.isArray(row.keys) ? row.keys.join(' / ') : '—';
    line.appendChild(el('span', 'admin-wa-evidence-row-key', key));
    line.appendChild(el('span', 'admin-wa-evidence-row-val', (row.clicks || 0) + ' clicks'));
    line.appendChild(el('span', 'admin-wa-evidence-row-val', (row.impressions || 0) + ' impr.'));
    line.appendChild(el('span', 'admin-wa-evidence-row-val', typeof row.position === 'number' ? 'pos ' + row.position.toFixed(1) : '—'));
    return line;
  }
  function ga4Row(row) {
    var line = el('div', 'admin-wa-evidence-row');
    var dims = Array.isArray(row.dimensions) ? row.dimensions.join(' / ') : '—';
    var mets = Array.isArray(row.metrics) ? row.metrics.join(' / ') : '—';
    line.appendChild(el('span', 'admin-wa-evidence-row-key', dims));
    line.appendChild(el('span', 'admin-wa-evidence-row-val', mets));
    return line;
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
    combined.forEach(function (event) {
      listEl.appendChild(buildActivityRow(event));
    });
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

        if (!dash.connected) {
          notConnectedEl.style.display = 'block';
          bodyEl.style.display = 'none';
          return;
        }
        notConnectedEl.style.display = 'none';
        bodyEl.style.display = 'block';

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
        renderEvidencePanel('wa-evidence-gsc', 'SEARCH CONSOLE', dash.searchIntelligence && dash.searchIntelligence.searchConsole, gscRow);
        renderEvidencePanel('wa-evidence-ga4', 'GA4', dash.searchIntelligence && dash.searchIntelligence.ga4, ga4Row);
        renderActivity(dash.activity, proposals);
      })
      .catch(function (err) {
        loadingEl.style.display = 'none';
        showError(err && err.message ? err.message : 'Could not load the Website Agent dashboard.');
      });
  }

  load();
});
