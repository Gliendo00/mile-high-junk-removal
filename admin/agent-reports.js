// /admin/agent-reports/ — Site Improvement Agent, Phase 5's report-history
// surface. Talks to api/admin/bookings.js's ?view=agent-reports (list) and
// ?view=agent-report&runId=... (one run's full detail) — no new Vercel
// function, same file that already hosts ?view=agent-activity/
// ?view=agent-proposals. Read-only: there is nothing to approve/reject
// here (see admin/agent-proposals/ for that).
//
// Every dynamic value is written with textContent (never innerHTML/
// insertAdjacentHTML with a concatenated string), matching every other
// admin script's discipline.
document.addEventListener('DOMContentLoaded', function () {
  var errorBanner = document.getElementById('error-banner');
  var loadingEl = document.getElementById('reports-loading');
  var emptyEl = document.getElementById('reports-empty');
  var listEl = document.getElementById('reports-list');
  var detailEl = document.getElementById('report-detail');

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
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
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
  // "Today" / "Yesterday" / "Oct 12" — matches agent/README.md's own
  // report-history mockup.
  function formatRunDateLabel(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var now = new Date();
    var startOfDay = function (dt) { return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime(); };
    var diffDays = Math.round((startOfDay(now) - startOfDay(d)) / (24 * 60 * 60 * 1000));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function runTypeLabel(runType) {
    if (runType === 'daily') return 'Daily';
    if (runType === 'weekly') return 'Weekly';
    return 'Manual';
  }
  function outcomeLabel(entry) {
    if (entry.failed) return 'Failed';
    if (entry.healthSummary && entry.healthSummary.text) return entry.healthSummary.text;
    return '—';
  }
  function outcomeStatusClass(entry) {
    var status = entry.failed ? 'failed' : (entry.healthSummary && entry.healthSummary.status) || 'unknown';
    return 'admin-report-row-outcome-' + status;
  }

  function evidenceLine(item) {
    if (!item || typeof item !== 'object') return String(item);
    var parts = [];
    if (item.field) parts.push(item.field);
    if (item.value !== undefined) parts.push(JSON.stringify(item.value));
    if (item.file) parts.push('(' + item.file + ')');
    return parts.join(' ') || JSON.stringify(item);
  }

  function buildRow(entry) {
    var row = el('button', 'admin-report-row');
    row.type = 'button';

    var dateCol = el('span', 'admin-report-row-date', formatRunDateLabel(entry.timestamp));
    var typeCol = el('span', 'admin-status-badge admin-report-row-type', runTypeLabel(entry.runType));
    var outcomeCol = el('span', 'admin-status-badge ' + outcomeStatusClass(entry), outcomeLabel(entry));

    row.appendChild(dateCol);
    row.appendChild(typeCol);
    row.appendChild(outcomeCol);

    row.addEventListener('click', function () {
      loadDetail(entry.runId);
    });
    return row;
  }

  function renderList(reports) {
    clear(listEl);
    if (!reports.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    reports.forEach(function (entry) {
      listEl.appendChild(buildRow(entry));
    });
  }

  function loadList() {
    loadingEl.style.display = 'block';
    emptyEl.style.display = 'none';
    clearError();
    adminFetch('/api/admin/bookings?view=agent-reports')
      .then(function (res) {
        if (handleAuthRedirect(res)) return null;
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not load the report history.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return;
        renderList(body.reports || []);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not load the report history.');
        renderList([]);
      })
      .finally(function () {
        loadingEl.style.display = 'none';
      });
  }

  function statLine(label, value) {
    return el('p', 'admin-report-detail-stat', label + ': ' + value);
  }

  function buildFindingRow(f) {
    var row = el('div', 'admin-report-finding');
    var top = el('div', 'admin-proposal-card-top');
    top.appendChild(el('span', null, f.type));
    top.appendChild(el('span', 'admin-status-badge', f.decision));
    row.appendChild(top);
    row.appendChild(el('p', 'admin-proposal-card-summary', f.summary));
    if (f.decisionReason) row.appendChild(el('p', 'admin-proposal-card-reason', f.decisionReason));
    if (Array.isArray(f.evidence) && f.evidence.length) {
      var list = el('ul', 'admin-proposal-card-meta');
      list.style.margin = '4px 0 4px';
      list.style.paddingLeft = '18px';
      f.evidence.slice(0, 5).forEach(function (item) {
        list.appendChild(el('li', null, evidenceLine(item)));
      });
      row.appendChild(list);
    }
    return row;
  }

  function renderDetail(run) {
    clear(detailEl);
    detailEl.hidden = false;

    var closeBtn = el('button', 'admin-btn admin-btn-outline', '← Back to list');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', function () {
      detailEl.hidden = true;
      clear(detailEl);
    });
    detailEl.appendChild(closeBtn);

    var report = run.report;
    var heading = el('h2', 'admin-report-detail-heading', formatRunDateLabel(run.timestamp) + ' — ' + runTypeLabel(run.runType) + ' run');
    detailEl.appendChild(heading);
    detailEl.appendChild(el('p', 'admin-report-detail-meta', formatDateTime(run.timestamp) + ' · ' + run.runId));

    if (run.failed) {
      detailEl.appendChild(el('p', 'admin-proposal-card-reviewed-note', 'This run did not complete successfully.' + (run.report && run.report.failure ? ' ' + run.report.failure.message : '')));
      return;
    }

    if (!report) {
      detailEl.appendChild(el('p', 'admin-report-detail-meta', 'This run was recorded before the report format existed — showing the raw summary instead.'));
      detailEl.appendChild(statLine('Pages checked', run.summary ? run.summary.pagesScanned : '—'));
      detailEl.appendChild(statLine('Findings', run.summary ? run.summary.findingsTotal : '—'));
      return;
    }

    detailEl.appendChild(el('p', 'admin-report-detail-health admin-home-marketing-summary-health-' + report.healthSummary.status, report.healthSummary.text));
    detailEl.appendChild(statLine('Pages checked', report.pagesChecked));
    detailEl.appendChild(statLine('Open technical issues', report.technicalIssues.actionableOpen));
    detailEl.appendChild(statLine('Observations', report.observationsCount));
    detailEl.appendChild(statLine('Opportunities', report.opportunitiesCount));
    detailEl.appendChild(statLine('Safe fixes applied', report.safeFixes.appliedCount));
    detailEl.appendChild(statLine('Research questions raised', report.research.questionsRaisedCount));
    detailEl.appendChild(statLine('Proposals created/updated', report.proposals.createdOrUpdatedCount));
    detailEl.appendChild(statLine('Proposals awaiting approval', report.proposals.awaitingApprovalCount));

    var cd = report.changeDetection;
    detailEl.appendChild(el('h3', 'admin-report-detail-subheading', 'Since the previous run'));
    detailEl.appendChild(statLine('New', cd.counts.new));
    detailEl.appendChild(statLine('Still open', cd.counts.stillOpen));
    detailEl.appendChild(statLine('Resolved', cd.counts.resolved));

    if (report.rotation && report.rotation.picks && report.rotation.picks.length) {
      detailEl.appendChild(el('h3', 'admin-report-detail-subheading', "This week's research-rotation picks"));
      report.rotation.picks.forEach(function (p) {
        detailEl.appendChild(el('p', 'admin-report-detail-stat', p.name + (p.hasPage ? '' : ' (no dedicated page yet)') + ' — ' + p.reasons.join('; ')));
      });
    }

    if (run.findings && run.findings.length) {
      detailEl.appendChild(el('h3', 'admin-report-detail-subheading', 'Findings this run'));
      run.findings.forEach(function (f) {
        detailEl.appendChild(buildFindingRow(f));
      });
    } else {
      detailEl.appendChild(el('p', 'admin-proposal-card-reviewed-note', 'No worthwhile change found this run.'));
    }
  }

  function loadDetail(runId) {
    clearError();
    adminFetch('/api/admin/bookings?view=agent-report&runId=' + encodeURIComponent(runId))
      .then(function (res) {
        if (handleAuthRedirect(res)) return null;
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || 'Could not load this report.');
          return body;
        });
      })
      .then(function (body) {
        if (!body) return;
        renderDetail(body.run);
        detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Could not load this report.');
      });
  }

  loadList();

  // Deep-link support: /admin/agent-reports/?run=<runId> opens straight
  // to that run's detail (e.g. a future link from elsewhere in the CRM).
  var params = new URLSearchParams(window.location.search);
  var runParam = params.get('run');
  if (runParam) loadDetail(runParam);
});
