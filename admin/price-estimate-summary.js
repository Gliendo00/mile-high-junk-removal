// Job detail (/admin/booking/?id=) — read-only "Saved Estimate" row from
// the Interactive Pricing Calculator, plus the "Pricing Calculator" button
// that opens the calculator attached to this job. Kept as its own small
// script so admin/booking-detail.js is untouched. Purely informational:
// nothing here writes anything.
//
// Fails quiet by design: if the saved-estimate table doesn't exist yet
// (migration not applied), the job isn't a junk-removal job, or the
// request fails, the row simply stays hidden — the rest of the job page
// never depends on it. All text is written with textContent.
document.addEventListener('DOMContentLoaded', function () {
  var Core = window.PricingCalcCore;
  var id = (new URLSearchParams(window.location.search).get('id') || '').trim();
  if (!id || !Core || !window.adminFetch) return;

  var link = document.getElementById('d-pricing-calc-link');
  var row = document.getElementById('d-price-estimate-row');
  var mount = document.getElementById('d-price-estimate');
  if (!link || !row || !mount) return;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  window.adminFetch('/api/admin/booking?resource=price-estimate&bookingId=' + encodeURIComponent(id))
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.booking || !data.booking.priceable) return;
      link.href = '/admin/pricing-calculator/?bookingId=' + encodeURIComponent(id);
      link.style.display = 'inline-flex';
      var est = data.estimate;
      if (!est) return;

      mount.textContent = '';
      var head = el('div', 'admin-price-estimate-head');
      head.appendChild(el('strong', null, Core.formatCents(est.totalCents)));
      head.appendChild(el('span', 'admin-price-estimate-tag', est.confirmedOnSite ? ' · Confirmed on-site' : ' · Preliminary'));
      mount.appendChild(head);

      var list = el('ul', 'admin-price-estimate-lines');
      list.style.margin = '4px 0 6px';
      list.style.paddingLeft = '18px';
      (Array.isArray(est.lineItems) ? est.lineItems : []).forEach(function (line) {
        if (line.kind === 'labor_included') return;
        var qty = line.kind === 'disposal' ? ' × ' + line.quantity : line.kind === 'labor' ? ' · ' + (line.quantityLabel || '') : '';
        var amount = line.amountCents < 0 ? '−' + Core.formatCents(-line.amountCents) : Core.formatCents(line.amountCents);
        list.appendChild(el('li', null, String(line.description || '') + qty + ' — ' + amount));
      });
      mount.appendChild(list);
      if (est.staffNotes) mount.appendChild(el('div', 'admin-field-hint', 'Notes: ' + est.staffNotes));
      var when = est.updatedAt ? new Date(est.updatedAt) : null;
      mount.appendChild(el('div', 'admin-field-hint', 'Saved' + (when && !isNaN(when.getTime()) ? ' ' + when.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '') + (est.updatedBy ? ' by ' + est.updatedBy : '') + ' · estimate only, not an invoice'));
      row.style.display = 'block';
    })
    .catch(function () {});
});
