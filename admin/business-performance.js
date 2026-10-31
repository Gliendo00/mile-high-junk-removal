// Read-only daily view of the existing Schedule financial data.
window.AdminBusinessPerformance = (function () {
  function addDays(iso, days) {
    var date = new Date(iso + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  function today() {
    var parts = {};
    new Intl.DateTimeFormat('en-US', {timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  function aggregate(start, end, jobs, expenses, otherRevenue) {
    var rows = [], byDate = {};
    for (var day = start; day <= end; day = addDays(day, 1)) {
      var row = {date: day, revenue: 0, expenses: 0, jobs: 0};
      rows.push(row); byDate[day] = row;
    }
    jobs.forEach(function (job) {
      var row = byDate[job.appointmentDate];
      if (!row || job.serviceType === 'dumpster_pickup') return;
      row.jobs += 1;
      if (job.status !== 'completed' || job.isComplimentary) return;
      // Same ledger-aware amount and legacy fallback as schedule-financials.js.
      var hasFinal = job.finalPrice !== null && job.finalPrice !== undefined && job.finalPrice !== '';
      var amount = typeof job.revenueAmount === 'number' ? job.revenueAmount : Number(hasFinal ? job.finalPrice : job.estimatedPrice);
      row.revenue += Number.isFinite(amount) ? amount : 0;
    });
    expenses.forEach(function (entry) { if (!entry.voidedAt && byDate[entry.expenseDate]) byDate[entry.expenseDate].expenses += Number(entry.amount) || 0; });
    otherRevenue.forEach(function (entry) { if (!entry.voidedAt && byDate[entry.revenueDate]) byDate[entry.revenueDate].revenue += Number(entry.amount) || 0; });
    return rows;
  }
  async function read(url) {
    var response = await adminFetch(url);
    if (response.status === 401) { window.location.href = '/admin/login/'; throw new Error('Please sign in.'); }
    if (response.status === 403) throw new Error('Access denied.');
    var body = await response.json();
    if (!response.ok || !body.ok) throw new Error('Business performance is unavailable. Try again.');
    return body;
  }
  async function pages(view, key, query) {
    var rows = [], offset = 0, body;
    do {
      body = await read('/api/admin/bookings?view=' + view + '&' + query + '&limit=200&offset=' + offset);
      if (!Array.isArray(body[key]) || (body.hasMore && !body[key].length)) throw new Error('Incomplete business performance data.');
      rows = rows.concat(body[key]); offset += body[key].length;
    } while (body.hasMore);
    return rows;
  }
  function mount(root) {
    var days = 30, rows = null, request = 0;
    var enabled = {revenue: true, expenses: true, jobs: true};
    var labels = {revenue: 'Revenue', expenses: 'Expenses', jobs: 'Job Count'};
    var colors = {revenue: '#b4fa65', expenses: '#ffb86b', jobs: '#80caff'};
    function el(tag, cls, text) { var n = document.createElement(tag); n.className = cls || ''; if (text !== undefined) n.textContent = text; return n; }
    var ranges = el('div', 'admin-wa-kw-filters'); ranges.setAttribute('role', 'group'); ranges.setAttribute('aria-label', 'Business performance date range');
    [7, 30, 90].forEach(function (value) {
      var button = el('button', 'admin-wa-kw-filter', value + 'D'); button.type = 'button';
      button.setAttribute('aria-pressed', String(value === days));
      button.onclick = function () { days = value; Array.from(ranges.children).forEach(function (b) { b.setAttribute('aria-pressed', String(b === button)); }); load(); };
      ranges.appendChild(button);
    });
    root.appendChild(ranges);
    var toggles = el('div', 'admin-wa-kw-filters');
    toggles.setAttribute('role', 'group'); toggles.setAttribute('aria-label', 'Business performance metrics');
    Object.keys(labels).forEach(function (key) {
      var button = el('button', 'admin-wa-kw-filter', labels[key]); button.type = 'button';
      button.setAttribute('aria-pressed', 'true');
      button.onclick = function () { enabled[key] = !enabled[key]; button.setAttribute('aria-pressed', String(enabled[key])); draw(); };
      toggles.appendChild(button);
    }); root.appendChild(toggles);
    var status = el('p', 'admin-wa-muted'); status.setAttribute('role', 'status'); root.appendChild(status);
    var plot = el('div', 'admin-wa-bar-chart admin-wa-performance-plot'); root.appendChild(plot);
    var details = el('details', 'admin-wa-raw-evidence'); details.appendChild(el('summary', '', 'Daily values')); root.appendChild(details);
    function draw() {
      plot.replaceChildren();
      if (!rows) return;
      if (!Object.keys(enabled).some(function (key) { return enabled[key]; })) { plot.textContent = 'Select a metric to show the chart.'; return; }
      var hasMoney = enabled.revenue || enabled.expenses;
      var axes = [hasMoney ? 'Dollars (left)' : '', enabled.jobs ? 'Jobs (right)' : ''].filter(Boolean).join(' · ');
      var money = Math.max(1, ...rows.flatMap(function (r) { return [enabled.revenue ? r.revenue : 0, enabled.expenses ? r.expenses : 0]; }));
      var count = Math.max(1, ...rows.map(function (r) { return r.jobs; }));
      var minMoney = Math.min(0, ...rows.flatMap(function (r) { return [enabled.revenue ? r.revenue : 0, enabled.expenses ? r.expenses : 0]; }));
      var width = Math.max(300, Math.min(760, (plot.clientWidth || 796) - 36));
      var left = 60, right = width - 45;
      var ns = 'http://www.w3.org/2000/svg';
      function svgNode(tag, attrs, text) { var n = document.createElementNS(ns, tag); Object.keys(attrs).forEach(function (a) { n.setAttribute(a, attrs[a]); }); if (text !== undefined) n.textContent = text; return n; }
      var svg = svgNode('svg', {viewBox: '0 0 ' + width + ' 280', role: 'img', 'aria-label': 'Daily business performance. ' + axes + '. Daily values available below.'});
      for (var tick = 0; tick <= 4; tick++) {
        var y = 24 + tick * 52;
        svg.appendChild(svgNode('line', {x1: left, x2: right, y1: y, y2: y, stroke: '#ffffff25'}));
        if (hasMoney) svg.appendChild(svgNode('text', {x: 2, y: y + 4, fill: '#bfd2c1', 'font-size': 12}, '$' + (money - tick / 4 * (money - minMoney)).toFixed(money - minMoney < 4 ? 2 : 0)));
        if (enabled.jobs) svg.appendChild(svgNode('text', {x: right + 8, y: y + 4, fill: colors.jobs, 'font-size': 12}, (count * (1 - tick / 4)).toFixed(1)));
      }
      Object.keys(enabled).forEach(function (key) {
        if (!enabled[key]) return;
        var points = rows.map(function (r, i) { return (left + i / (rows.length - 1) * (right - left)) + ',' + (232 - (key === 'jobs' ? r[key] / count : (r[key] - minMoney) / (money - minMoney)) * 208); }).join(' ');
        svg.appendChild(svgNode('polyline', {points: points, fill: 'none', stroke: colors[key], 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke'}));
      });
      svg.appendChild(svgNode('text', {x: left, y: 264, fill: '#bfd2c1', 'font-size': 12}, rows[0].date));
      svg.appendChild(svgNode('text', {x: right, y: 264, fill: '#bfd2c1', 'font-size': 12, 'text-anchor': 'end'}, rows[rows.length - 1].date));
      plot.appendChild(el('p', '', axes));
      plot.appendChild(svg);
      var colorNames = {revenue: 'green', expenses: 'orange', jobs: 'blue'};
      plot.appendChild(el('p', '', Object.keys(enabled).filter(function (key) { return enabled[key]; }).map(function (key) { return labels[key] + ' · ' + colorNames[key]; }).join(' | ')));
    }
    async function load() {
      var current = ++request; rows = null; draw(); status.textContent = 'Loading business performance…';
      details.querySelectorAll('table').forEach(function (n) { n.remove(); });
      var end = today(), start = addDays(end, 1 - days);
      if (start < '2026-01-01') start = '2026-01-01';
      var months = [], cursor = start.slice(0, 7) + '-01';
      while (cursor <= end) { var parts = cursor.split('-'); months.push(read('/api/admin/bookings?view=schedule&range=month&year=' + parts[0] + '&month=' + Number(parts[1]))); cursor = addDays(cursor, 32).slice(0, 7) + '-01'; }
      var query = 'startDate=' + start + '&endDate=' + end;
      try {
        var data = await Promise.all([Promise.all(months), pages('expenses', 'expenses', query), pages('other-revenue', 'otherRevenue', query)]);
        if (current !== request) return;
        rows = aggregate(start, end, data[0].flatMap(function (b) { return b.jobs; }), data[1], data[2]);
        status.textContent = start + ' – ' + end + ' · Denver dates · Revenue includes other revenue. Job Count follows the Schedule (pickup visits excluded).';
        var table = el('table', 'admin-wa-performance-table');
        var head = el('tr'); ['Date', 'Revenue', 'Expenses', 'Job Count'].forEach(function (label) { head.appendChild(el('th', '', label)); }); table.appendChild(head);
        rows.forEach(function (r) { var tr = el('tr'); [r.date, '$' + r.revenue.toFixed(2), '$' + r.expenses.toFixed(2), r.jobs].forEach(function (v) { tr.appendChild(el('td', '', v)); }); table.appendChild(tr); }); details.appendChild(table); draw();
      } catch (error) { if (current === request) { rows = null; plot.replaceChildren(); status.textContent = error.message || 'Business performance is unavailable.'; } }
    }
    if (typeof ResizeObserver !== 'undefined') {
      var lastWidth = 0;
      new ResizeObserver(function () {
        if (plot.clientWidth !== lastWidth) { lastWidth = plot.clientWidth; draw(); }
      }).observe(plot);
    }
    load();
  }
  return {aggregate: aggregate, addDays: addDays, mount: mount};
})();
document.addEventListener('DOMContentLoaded', function () { var root = document.getElementById('wa-business-performance'); if (root) window.AdminBusinessPerformance.mount(root); });
