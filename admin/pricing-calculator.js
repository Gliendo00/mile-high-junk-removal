// /admin/pricing-calculator/ — Interactive Pricing Calculator.
//
// ONE shared screen the crew builds the estimate on while the customer
// watches: every tap (load size, item quantity, labor, custom charge,
// discount) re-renders the itemized breakdown and total immediately. There
// is no separate "edit, then present" step. Customer View is the same
// screen with the CRM chrome and staff tray hidden — still fully
// interactive.
//
// All price math lives in admin/pricing-calculator-core.js (shared with
// the server, which re-computes every save). Every dynamic value is written
// with textContent — custom-charge/discount descriptions and staff notes
// are user-typed text and are never interpreted as HTML.
//
// Save to Job (api/admin/booking.js ?resource=price-estimate) stores the
// breakdown on a job and, only when the user ticks it, the job's Quoted
// Amount. It never creates an invoice, payment, or charge, and never
// contacts the customer.
document.addEventListener('DOMContentLoaded', function () {
  var Core = window.PricingCalcCore;
  var LIMITS = Core.LIMITS;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var errorBanner = $('error-banner');
  var toastEl = $('admin-toast');
  var logoutBtn = $('logout-btn');

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  function emptyState() {
    return { loadTier: null, disposal: {}, laborQuarterHours: 0, customCharges: [], discounts: [], notes: '', confirmedOnSite: false };
  }
  var state = emptyState();

  // Save binding — which job this calculator is attached to, and which
  // saved revision (if any) it was loaded from.
  var binding = { bookingId: null, booking: null, revision: null };
  var savedSnapshot = snapshot(); // what's persisted (or the blank start)
  var saveInFlight = false;
  var pendingSave = null; // { payloadKey, requestKey } — reused only for an identical retry

  function snapshot() {
    return JSON.stringify(Core.normalizeInput(state).value);
  }
  function isDirty() { return snapshot() !== savedSnapshot; }
  function isBlank() { return snapshot() === JSON.stringify(Core.normalizeInput(emptyState()).value); }

  function randomKey() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var a = new Uint8Array(16);
    window.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // ------------------------------------------------------------------
  // Feedback helpers
  // ------------------------------------------------------------------
  var toastTimer = null;
  function showToast(msg, kind) {
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = 'admin-toast is-visible' + (kind ? ' is-' + kind : '');
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-visible'); }, 3600);
  }
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = msg ? 'block' : 'none';
  }

  // ------------------------------------------------------------------
  // Build controls (static catalog — built once)
  // ------------------------------------------------------------------
  var tierGrid = $('pc-tier-grid');
  var tierButtons = {};
  Core.LOAD_TIERS.forEach(function (tier) {
    var btn = el('button', 'pc-tier');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.setAttribute('aria-label', tier.label + ', ' + Core.formatCents(tier.cents));
    btn.dataset.tier = tier.key;
    btn.appendChild(el('span', 'pc-tier-name', tier.shortLabel === 'Min' ? 'Minimum' : tier.shortLabel));
    btn.appendChild(el('span', 'pc-tier-price', Core.formatCents(tier.cents).replace(/\.00$/, '')));
    var fill = el('span', 'pc-tier-fill');
    var fillInner = el('span', 'pc-tier-fill-inner');
    fillInner.style.width = Math.round(tier.fraction * 100) + '%';
    fill.appendChild(fillInner);
    btn.appendChild(fill);
    btn.addEventListener('click', function () { setTier(tier.key); });
    tierGrid.appendChild(btn);
    tierButtons[tier.key] = btn;
  });
  // Arrow-key navigation within the radiogroup.
  tierGrid.addEventListener('keydown', function (e) {
    var keys = Core.LOAD_TIERS.map(function (t) { return t.key; });
    var idx = keys.indexOf(document.activeElement && document.activeElement.dataset.tier);
    if (idx === -1) return;
    var next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(keys.length - 1, idx + 1);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, idx - 1);
    if (next === null) return;
    e.preventDefault();
    tierButtons[keys[next]].focus();
    setTier(keys[next]);
  });

  var disposalList = $('pc-disposal-list');
  var disposalInputs = {};
  Core.DISPOSAL_ITEMS.forEach(function (item) {
    var row = el('div', 'pc-stepper-row');
    var label = el('div', 'pc-stepper-label');
    var inputId = 'pc-qty-' + item.key;
    var name = el('label', 'pc-stepper-name', item.label);
    name.htmlFor = inputId;
    label.appendChild(name);
    label.appendChild(el('span', 'pc-stepper-price', Core.formatCents(item.cents) + ' / ' + item.unit + (item.hint ? ' · ' + item.hint : '')));
    row.appendChild(label);

    var stepper = el('div', 'pc-stepper');
    stepper.setAttribute('role', 'group');
    stepper.setAttribute('aria-label', item.label + ' quantity');
    var minus = el('button', 'pc-step-btn', '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Remove one ' + item.label);
    var input = el('input', 'pc-step-value');
    input.type = 'text';
    input.id = inputId;
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.value = '0';
    input.setAttribute('aria-label', item.label + ' quantity');
    var plus = el('button', 'pc-step-btn', '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', 'Add one ' + item.label);
    minus.addEventListener('click', function () { setQty(item.key, (state.disposal[item.key] || 0) - 1); });
    plus.addEventListener('click', function () { setQty(item.key, (state.disposal[item.key] || 0) + 1); });
    input.addEventListener('focus', function () { input.select(); });
    input.addEventListener('input', function () {
      var digits = input.value.replace(/\D/g, '').slice(0, 2);
      if (digits !== input.value) input.value = digits;
      if (digits !== '') setQty(item.key, parseInt(digits, 10), { fromInput: true });
    });
    input.addEventListener('blur', function () {
      if (input.value === '') setQty(item.key, 0);
      input.value = String(state.disposal[item.key] || 0);
    });
    stepper.appendChild(minus);
    stepper.appendChild(input);
    stepper.appendChild(plus);
    row.appendChild(stepper);
    disposalList.appendChild(row);
    disposalInputs[item.key] = { row: row, input: input, minus: minus, plus: plus };
  });

  var laborValue = $('pc-labor-value');
  var laborAmount = $('pc-labor-amount');
  var laborMinus = $('pc-labor-minus');
  var laborPlus = $('pc-labor-plus');
  laborMinus.addEventListener('click', function () { setLabor(state.laborQuarterHours - 1); });
  laborPlus.addEventListener('click', function () { setLabor(state.laborQuarterHours + 1); });
  var laborChips = $('pc-labor-chips');
  var laborChipButtons = [];
  [0, 2, 4, 8].forEach(function (q) {
    var chip = el('button', 'pc-chip', q === 0 ? 'None' : Core.formatLaborHours(q));
    chip.type = 'button';
    chip.addEventListener('click', function () { setLabor(q); });
    chip.dataset.q = String(q);
    laborChips.appendChild(chip);
    laborChipButtons.push(chip);
  });

  // ------------------------------------------------------------------
  // Mutations — every one ends in render()
  // ------------------------------------------------------------------
  function setTier(key) {
    if (!Core.tierByKey(key)) return;
    state.loadTier = key;
    render({ changedKey: key });
  }
  function setQty(key, qty, opts) {
    qty = Math.max(0, Math.min(LIMITS.disposalQty, Math.trunc(qty) || 0));
    if (qty === 0) delete state.disposal[key]; else state.disposal[key] = qty;
    render({ changedKey: key, keepInput: opts && opts.fromInput ? key : null });
  }
  function setLabor(q) {
    state.laborQuarterHours = Math.max(0, Math.min(LIMITS.laborQuarterHours, q));
    render({ changedKey: 'labor_additional' });
  }

  // ---- Custom charge / discount form ----
  var adjustForm = $('pc-adjust-form');
  var adjustTitle = $('pc-adjust-title');
  var adjustDesc = $('pc-adjust-desc');
  var adjustAmount = $('pc-adjust-amount');
  var adjustError = $('pc-adjust-error');
  var addCustomBtn = $('pc-add-custom-btn');
  var addDiscountBtn = $('pc-add-discount-btn');
  var adjustKind = null;

  function openAdjust(kind) {
    adjustKind = kind;
    adjustTitle.textContent = kind === 'discount' ? 'Discount' : 'Custom charge';
    adjustDesc.placeholder = kind === 'discount' ? 'e.g. Repeat customer' : 'e.g. Hot tub cut-up';
    $('pc-adjust-submit').textContent = kind === 'discount' ? 'Add discount' : 'Add charge';
    adjustDesc.value = '';
    adjustAmount.value = '';
    adjustError.hidden = true;
    adjustForm.hidden = false;
    addCustomBtn.setAttribute('aria-expanded', String(kind === 'custom'));
    addDiscountBtn.setAttribute('aria-expanded', String(kind === 'discount'));
    adjustDesc.focus();
  }
  function closeAdjust() {
    adjustForm.hidden = true;
    adjustKind = null;
    addCustomBtn.setAttribute('aria-expanded', 'false');
    addDiscountBtn.setAttribute('aria-expanded', 'false');
  }
  addCustomBtn.addEventListener('click', function () { openAdjust('custom'); });
  addDiscountBtn.addEventListener('click', function () { openAdjust('discount'); });
  $('pc-adjust-cancel').addEventListener('click', closeAdjust);
  adjustForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var description = adjustDesc.value.replace(/\s+/g, ' ').trim();
    var cents = Core.parseDollarsToCents(adjustAmount.value);
    var err = null;
    if (!description) err = 'Add a short description the customer will see.';
    else if (cents === null || cents <= 0) err = 'Enter an amount like 25 or 25.50.';
    else if (cents > LIMITS.lineCents) err = 'Amounts are limited to ' + Core.formatCents(LIMITS.lineCents) + ' per line.';
    var list = adjustKind === 'discount' ? state.discounts : state.customCharges;
    var max = adjustKind === 'discount' ? LIMITS.discountCount : LIMITS.customCount;
    if (!err && list.length >= max) err = 'You can add up to ' + max + (adjustKind === 'discount' ? ' discounts.' : ' custom charges.');
    if (!err) {
      var trial = JSON.parse(JSON.stringify(state));
      (adjustKind === 'discount' ? trial.discounts : trial.customCharges).push({ description: description, amountCents: cents });
      var check = Core.normalizeInput(trial);
      if (!check.ok) err = check.errors[0];
    }
    if (err) {
      adjustError.textContent = err;
      adjustError.hidden = false;
      return;
    }
    list.push({ description: description.slice(0, LIMITS.descriptionLength), amountCents: cents });
    var kind = adjustKind;
    closeAdjust();
    render({ changedKey: (kind === 'discount' ? 'discount_' : 'custom_') + (list.length - 1) });
  });

  // ------------------------------------------------------------------
  // Render — the single place the screen is drawn from `state`
  // ------------------------------------------------------------------
  var linesEl = $('pc-lines');
  var prevLines = {};
  var prevSummaries = {};

  // Quantity and unit price are shown under every counted line ("2 ×
  // $25.00 each"), so the customer can check each total themselves.
  function lineQtyText(line) {
    if (line.kind === 'disposal') return line.quantity + ' ×';
    if (line.kind === 'labor') return line.quantityLabel + ' ×';
    if (line.kind === 'labor_included') return '1 hr';
    return '';
  }
  function lineUnitText(line) {
    if (line.kind === 'disposal') return Core.formatCents(line.unitCents) + ' each';
    if (line.kind === 'labor') return Core.formatCents(line.unitCents) + '/hr';
    if (line.kind === 'labor_included') return 'included with every load';
    return '';
  }
  function lineAmountText(line) {
    if (line.kind === 'discount') return '−' + Core.formatCents(-line.amountCents);
    return Core.formatCents(line.amountCents);
  }
  function lineSummary(line) {
    if (line.kind === 'disposal') return line.description.replace(/ disposal$/, '') + ' × ' + line.quantity + ' · ' + lineAmountText(line);
    if (line.kind === 'labor') return 'Additional labor ' + line.quantityLabel + ' · ' + lineAmountText(line);
    return line.description + ' · ' + lineAmountText(line);
  }

  function render(opts) {
    opts = opts || {};
    var normalized = Core.normalizeInput(state);
    var est = Core.computeEstimate(normalized.value);

    // Controls
    Core.LOAD_TIERS.forEach(function (t) {
      var on = state.loadTier === t.key;
      tierButtons[t.key].classList.toggle('is-selected', on);
      tierButtons[t.key].setAttribute('aria-checked', on ? 'true' : 'false');
      tierButtons[t.key].tabIndex = on || (!state.loadTier && t.key === 'minimum') ? 0 : -1;
    });
    Core.DISPOSAL_ITEMS.forEach(function (item) {
      var qty = state.disposal[item.key] || 0;
      var d = disposalInputs[item.key];
      if (opts.keepInput !== item.key) d.input.value = String(qty);
      d.minus.disabled = qty <= 0;
      d.plus.disabled = qty >= LIMITS.disposalQty;
      d.row.classList.toggle('is-active', qty > 0);
    });
    laborValue.textContent = Core.formatLaborHours(state.laborQuarterHours);
    laborAmount.textContent = Core.formatCents(Core.LABOR_QUARTER_CENTS * state.laborQuarterHours);
    laborMinus.disabled = state.laborQuarterHours <= 0;
    laborPlus.disabled = state.laborQuarterHours >= LIMITS.laborQuarterHours;
    laborChipButtons.forEach(function (c) { c.classList.toggle('is-selected', Number(c.dataset.q) === state.laborQuarterHours); });
    renderAdjustList();

    // Receipt
    linesEl.textContent = '';
    var nextLines = {};
    var nextSummaries = {};
    var changedLine = null;
    est.lines.forEach(function (line) {
      var li = el('li', 'pc-line pc-line-' + line.kind);
      var desc = el('span', 'pc-line-desc');
      desc.appendChild(el('span', 'pc-line-name', line.description));
      var metaText = [lineQtyText(line), lineUnitText(line)].filter(Boolean).join(' ');
      if (metaText) desc.appendChild(el('span', 'pc-line-meta', metaText));
      li.appendChild(desc);
      li.appendChild(el('span', 'pc-num pc-line-amount', lineAmountText(line)));
      var sig = line.key + '|' + line.amountCents;
      nextLines[line.key] = sig;
      nextSummaries[line.key] = lineSummary(line);
      if (opts.changedKey !== undefined && line.key === opts.changedKey && prevLines[line.key] !== sig) {
        li.classList.add('is-changed');
        changedLine = line;
      }
      linesEl.appendChild(li);
    });
    var removedSummary = opts.changedKey !== undefined && !nextLines[opts.changedKey] ? prevSummaries[opts.changedKey] : null;
    prevLines = nextLines;
    prevSummaries = nextSummaries;

    var hasLines = est.lines.length > 0;
    $('pc-receipt-empty').hidden = hasLines;
    $('pc-sums').hidden = !hasLines || est.discountCents === 0;
    $('pc-subtotal').textContent = Core.formatCents(est.subtotalCents);
    $('pc-discount-row').hidden = est.discountCents === 0;
    $('pc-discount-total').textContent = '−' + Core.formatCents(est.discountCents);
    $('pc-total').textContent = Core.formatCents(est.totalCents);

    var pill = $('pc-status-pill');
    pill.textContent = state.confirmedOnSite ? 'Confirmed on-site' : 'Preliminary estimate';
    pill.classList.toggle('is-confirmed', state.confirmedOnSite);
    $('pc-disclaimer').textContent = state.confirmedOnSite
      ? 'This price was confirmed on-site before loading. Pricing includes taxes. Any change in scope will be discussed with you before additional charges apply.'
      : 'Final pricing is confirmed on-site before loading. Additional charges may apply if the scope changes. Pricing includes taxes.';

    // Mobile sticky bar
    var billable = est.lines.filter(function (l) { return l.kind !== 'labor_included'; }).length;
    $('pc-totalbar-total').textContent = Core.formatCents(est.totalCents);
    $('pc-totalbar-count').textContent = billable ? '· ' + billable + (billable === 1 ? ' item' : ' items') : '';
    var changeEl = $('pc-totalbar-change');
    if (changedLine) {
      changeEl.textContent = (changedLine.kind === 'discount' ? '' : '+ ') + lineSummary(changedLine);
      changeEl.classList.remove('is-shown');
      void changeEl.offsetWidth; // restart the highlight
      changeEl.classList.add('is-shown');
    } else if (removedSummary) {
      changeEl.textContent = 'Removed: ' + removedSummary.replace(/ · .*$/, '');
      changeEl.classList.remove('is-shown');
      void changeEl.offsetWidth;
      changeEl.classList.add('is-shown');
    }

    updateSaveUi();
  }

  function renderAdjustList() {
    var list = $('pc-adjust-list');
    list.textContent = '';
    function addRows(arr, kind) {
      arr.forEach(function (line, idx) {
        var li = el('li', 'pc-adjust-item pc-adjust-' + kind);
        li.appendChild(el('span', 'pc-adjust-item-desc', line.description));
        li.appendChild(el('span', 'pc-num pc-adjust-item-amount', (kind === 'discount' ? '−' : '') + Core.formatCents(line.amountCents)));
        var rm = el('button', 'pc-adjust-remove', 'Remove');
        rm.type = 'button';
        rm.setAttribute('aria-label', 'Remove ' + (kind === 'discount' ? 'discount' : 'charge') + ': ' + line.description);
        rm.addEventListener('click', function () {
          arr.splice(idx, 1);
          render({ changedKey: (kind === 'discount' ? 'discount_' : 'custom_') + idx });
        });
        li.appendChild(rm);
        list.appendChild(li);
      });
    }
    addRows(state.customCharges, 'custom');
    addRows(state.discounts, 'discount');
  }

  // Staff tray inputs
  var notesInput = $('pc-notes');
  var confirmedInput = $('pc-confirmed');
  notesInput.addEventListener('input', function () { state.notes = notesInput.value; updateSaveUi(); });
  confirmedInput.addEventListener('change', function () { state.confirmedOnSite = confirmedInput.checked; render(); });

  function syncStaffInputs() {
    notesInput.value = state.notes || '';
    confirmedInput.checked = !!state.confirmedOnSite;
  }

  // Mobile total bar: only shown while the receipt's own total is
  // scrolled out of view, so the total is always on screen exactly once.
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      document.body.classList.toggle('pc-total-visible', entries[0].isIntersecting);
    }, { threshold: 0.6 });
    io.observe(document.querySelector('.pc-total'));
  }
  // Mobile total bar jumps to the breakdown.
  $('pc-totalbar-btn').addEventListener('click', function () {
    $('pc-receipt').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ------------------------------------------------------------------
  // Customer View (focus mode) — same live screen, no CRM chrome.
  // ------------------------------------------------------------------
  var focusBtn = $('pc-focus-btn');
  var exitFocusBtn = $('pc-exit-focus');
  var enteredFullscreen = false;
  function setFocus(on) {
    document.body.classList.toggle('pc-focus', on);
    focusBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    exitFocusBtn.hidden = !on;
    closeAdjust();
    if (on && !sheetOverlay.hidden && !saveInFlight) closeSheet();
    if (on) {
      var root = document.documentElement;
      if (root.requestFullscreen && !document.fullscreenElement) {
        root.requestFullscreen().then(function () { enteredFullscreen = true; }).catch(function () {});
      }
      window.scrollTo(0, 0);
    } else if (enteredFullscreen && document.fullscreenElement && document.exitFullscreen) {
      enteredFullscreen = false;
      document.exitFullscreen().catch(function () {});
    }
  }
  focusBtn.addEventListener('click', function () { setFocus(true); });
  exitFocusBtn.addEventListener('click', function () { setFocus(false); });
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement && enteredFullscreen) {
      enteredFullscreen = false;
      setFocus(false);
    }
  });

  // ------------------------------------------------------------------
  // Sheet (confirmations + Save to Job) — same .admin-sheet chrome the
  // rest of the CRM uses; never window.confirm().
  // ------------------------------------------------------------------
  var sheetOverlay = $('pc-sheet-overlay');
  var sheetTitle = $('pc-sheet-title');
  var sheetBody = $('pc-sheet-body');
  var sheetReturnFocus = null;
  function openSheet(title, buildBody) {
    sheetReturnFocus = document.activeElement;
    sheetTitle.textContent = title;
    sheetBody.textContent = '';
    buildBody(sheetBody);
    sheetOverlay.hidden = false;
    var first = sheetBody.querySelector('button, input, select, textarea, a[href]');
    if (first) first.focus();
  }
  function closeSheet() {
    sheetOverlay.hidden = true;
    sheetBody.textContent = '';
    if (sheetReturnFocus && sheetReturnFocus.focus) sheetReturnFocus.focus();
  }
  sheetOverlay.addEventListener('click', function (e) { if (e.target === sheetOverlay && !saveInFlight) closeSheet(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!sheetOverlay.hidden && !saveInFlight) closeSheet();
    else if (!adjustForm.hidden) closeAdjust();
  });
  function sheetText(parent, text, cls) { parent.appendChild(el('p', cls || 'pc-sheet-text', text)); }
  function sheetButtons(parent, buttons) {
    var row = el('div', 'pc-sheet-actions');
    buttons.forEach(function (b) {
      var btn = el('button', 'admin-btn ' + (b.primary ? 'admin-btn-primary' : b.danger ? 'admin-btn-danger' : 'admin-btn-outline'), b.label);
      btn.type = 'button';
      btn.addEventListener('click', b.onClick);
      if (b.id) btn.id = b.id;
      row.appendChild(btn);
    });
    parent.appendChild(row);
    return row;
  }
  function confirmSheet(title, message, confirmLabel, onConfirm, danger) {
    openSheet(title, function (body) {
      sheetText(body, message);
      sheetButtons(body, [
        { label: 'Cancel', onClick: closeSheet },
        { label: confirmLabel, primary: !danger, danger: !!danger, onClick: function () { closeSheet(); onConfirm(); } },
      ]);
    });
  }

  // ------------------------------------------------------------------
  // Reset / new estimate
  // ------------------------------------------------------------------
  function doReset() {
    state = emptyState();
    binding = { bookingId: null, booking: null, revision: null };
    savedSnapshot = snapshot();
    pendingSave = null;
    prevLines = {}; prevSummaries = {};
    syncStaffInputs();
    closeAdjust();
    renderJobChip();
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', window.location.pathname);
    $('pc-save-status').textContent = '';
    $('pc-totalbar-change').textContent = '';
    render();
  }
  $('pc-reset-btn').addEventListener('click', function () {
    if (isBlank() && !binding.bookingId) return doReset();
    if (!isDirty() && binding.bookingId) return doReset();
    confirmSheet('Start a new estimate?', 'This clears every charge on screen. Unsaved changes will be lost.', 'Clear estimate', doReset, true);
  });

  window.addEventListener('beforeunload', function (e) {
    if (isDirty() && !isBlank()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ------------------------------------------------------------------
  // Job binding
  // ------------------------------------------------------------------
  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function quoteText(booking) {
    if (!booking || booking.estimatedPrice === null || booking.estimatedPrice === undefined || booking.estimatedPrice === '') return null;
    var min = Core.parseDollarsToCents(Number(booking.estimatedPrice).toFixed(2));
    var text = Core.formatCents(min);
    if (booking.estimatedPriceMax !== null && booking.estimatedPriceMax !== undefined && booking.estimatedPriceMax !== '') {
      text += '–' + Core.formatCents(Core.parseDollarsToCents(Number(booking.estimatedPriceMax).toFixed(2)));
    }
    return text;
  }
  function jobLabel(booking) {
    return [booking.customerName || 'Unnamed client', booking.serviceLabel, formatDate(booking.appointmentDate), booking.statusLabel].filter(Boolean).join(' · ');
  }
  function renderJobChip() {
    var chip = $('pc-job-chip');
    if (!binding.booking) { chip.hidden = true; return; }
    chip.hidden = false;
    var link = $('pc-job-chip-link');
    link.textContent = jobLabel(binding.booking);
    link.href = '/admin/booking/?id=' + encodeURIComponent(binding.booking.id);
  }

  function stateFromSaved(estimate) {
    var input = estimate.input || {};
    var s = emptyState();
    s.loadTier = input.loadTier || estimate.loadTier || null;
    s.disposal = input.disposal && typeof input.disposal === 'object' ? JSON.parse(JSON.stringify(input.disposal)) : {};
    s.laborQuarterHours = Number.isInteger(input.laborQuarterHours) ? input.laborQuarterHours : 0;
    s.customCharges = Array.isArray(input.customCharges) ? input.customCharges.map(function (c) { return { description: c.description, amountCents: c.amountCents }; }) : [];
    s.discounts = Array.isArray(input.discounts) ? input.discounts.map(function (c) { return { description: c.description, amountCents: c.amountCents }; }) : [];
    s.confirmedOnSite = !!estimate.confirmedOnSite;
    s.notes = estimate.staffNotes || '';
    return s;
  }

  function fetchJson(url, opts) {
    return adminFetch(url, opts).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/admin/login/';
        return new Promise(function () {});
      }
      return res.json().catch(function () { return null; }).then(function (body) {
        return { status: res.status, ok: res.ok, body: body || {} };
      });
    });
  }

  function loadJob(bookingId) {
    return fetchJson('/api/admin/booking?resource=price-estimate&bookingId=' + encodeURIComponent(bookingId)).then(function (r) {
      if (!r.ok) throw new Error(r.body.error || 'Could not load that job.');
      return r.body;
    });
  }

  // Attach this calculator to a job. If the job already has a saved
  // breakdown and the screen is blank (opened from the job), load it.
  // If the screen already has work on it, keep the work and let the save
  // flow ask before replacing what's stored.
  function bindJob(data, opts) {
    opts = opts || {};
    binding.bookingId = data.booking.id;
    binding.booking = data.booking;
    binding.revision = data.estimate ? data.estimate.revision : null;
    binding.existing = data.estimate || null;
    binding.storageReady = data.storageReady !== false;
    binding.save = data.save || { allowed: false, reason: 'Saving estimates to jobs isn’t turned on yet.' };
    if (data.estimate && opts.loadSaved) {
      state = stateFromSaved(data.estimate);
      syncStaffInputs();
      savedSnapshot = snapshot();
      prevLines = {}; prevSummaries = {};
    }
    renderJobChip();
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + '?bookingId=' + encodeURIComponent(data.booking.id));
    }
    render();
  }

  // ------------------------------------------------------------------
  // Save to Job
  // ------------------------------------------------------------------
  var saveBtn = $('pc-save-btn');
  var saveStatus = $('pc-save-status');

  function updateSaveUi() {
    if (saveInFlight) return;
    var hasTier = !!state.loadTier;
    saveBtn.disabled = !hasTier;
    if (binding.bookingId && !isDirty() && binding.revision !== null) {
      saveBtn.textContent = 'Saved to Job ✓';
      saveBtn.classList.add('is-saved');
    } else {
      saveBtn.textContent = 'Save to Job';
      saveBtn.classList.remove('is-saved');
    }
  }

  saveBtn.addEventListener('click', function () {
    if (saveInFlight) return;
    showError('');
    var check = Core.normalizeInput(state, { requireLoadTier: true });
    if (!check.ok) { showToast(check.errors[0], 'error'); return; }
    if (binding.bookingId && !isDirty() && binding.revision !== null) { showToast('Already saved — no changes since the last save.'); return; }
    if (binding.booking) openConfirmSave();
    else openJobPicker();
  });

  function openJobPicker() {
    openSheet('Save to Job — choose a job', function (body) {
      sheetText(body, 'Find the client, then pick the job this estimate is for.');
      var mount = el('div', 'pc-picker-mount');
      body.appendChild(mount);
      var jobsWrap = el('div', 'pc-job-list');
      body.appendChild(jobsWrap);
      sheetButtons(body, [{ label: 'Cancel', onClick: closeSheet }]);
      window.AdminClientPicker.mount(mount, {
        onSelect: function (client) {
          jobsWrap.textContent = '';
          if (!client) return;
          jobsWrap.appendChild(el('p', 'pc-sheet-text', 'Loading jobs…'));
          fetchJson('/api/admin/client?id=' + encodeURIComponent(client.id)).then(function (r) {
            jobsWrap.textContent = '';
            if (!r.ok) { jobsWrap.appendChild(el('p', 'pc-field-error', r.body.error || 'Could not load this client’s jobs.')); return; }
            var jobs = (r.body.bookings || []).filter(function (b) { return b.serviceType === 'junk_removal' || b.serviceType === 'light_demo'; });
            if (!jobs.length) {
              jobsWrap.appendChild(el('p', 'pc-sheet-text', 'No junk removal jobs for this client yet. Create the job first, then save the estimate to it.'));
              var link = el('a', 'admin-tap-link', 'New Job →');
              link.href = '/admin/booking-new/';
              link.target = '_blank';
              link.rel = 'noopener';
              jobsWrap.appendChild(link);
              return;
            }
            var name = [client.firstName, client.lastName].filter(Boolean).join(' ');
            jobs.forEach(function (job) {
              var btn = el('button', 'admin-sheet-option pc-job-option');
              btn.type = 'button';
              var label = el('span', 'admin-sheet-option-label');
              label.appendChild(el('span', 'pc-job-option-main', [job.serviceLabel, formatDate(job.appointmentDate)].filter(Boolean).join(' · ')));
              var q = quoteText(job);
              label.appendChild(el('span', 'pc-job-option-sub', job.statusLabel + (q ? ' · Quoted ' + q : '')));
              btn.appendChild(label);
              btn.addEventListener('click', function () {
                btn.disabled = true;
                loadJob(job.id).then(function (data) {
                  data.booking.customerName = data.booking.customerName || name;
                  bindJob(data, { loadSaved: false });
                  openConfirmSave();
                }).catch(function (err) {
                  btn.disabled = false;
                  showToast(err.message, 'error');
                });
              });
              jobsWrap.appendChild(btn);
            });
          }).catch(function () {
            jobsWrap.textContent = '';
            jobsWrap.appendChild(el('p', 'pc-field-error', 'Could not load this client’s jobs. Check your connection and try again.'));
          });
        },
      });
    });
  }

  // The explicit confirmation step: what will be saved, where, and what
  // (if anything) it replaces.
  function openConfirmSave(opts) {
    opts = opts || {};
    var booking = binding.booking;
    var est = Core.computeEstimate(Core.normalizeInput(state).value);
    var totalText = Core.formatCents(est.totalCents);
    var existing = binding.existing;
    var replacingSaved = !!existing && (binding.revision === null || opts.forceReplace);
    var currentQuote = quoteText(booking);
    var currentQuoteCents = booking.estimatedPrice === null || booking.estimatedPrice === undefined || booking.estimatedPrice === '' ? null : Core.parseDollarsToCents(Number(booking.estimatedPrice).toFixed(2));
    var quoteDiffers = currentQuote !== null && (currentQuoteCents !== est.totalCents || (booking.estimatedPriceMax !== null && booking.estimatedPriceMax !== undefined));

    openSheet('Save to Job', function (body) {
      var summary = el('div', 'pc-save-summary');
      summary.appendChild(el('div', 'pc-save-summary-job', jobLabel(booking)));
      summary.appendChild(el('div', 'pc-save-summary-total', totalText));
      body.appendChild(summary);

      if (!booking.priceable) {
        sheetText(body, 'This is a ' + booking.serviceLabel + ' job, which has its own pricing. Choose a junk removal job instead.', 'pc-field-error');
        sheetButtons(body, [{ label: 'Close', onClick: closeSheet }, { label: 'Choose another job', primary: true, onClick: function () { binding.booking = null; binding.bookingId = null; renderJobChip(); openJobPicker(); } }]);
        return;
      }
      if (binding.save && !binding.save.allowed) {
        sheetText(body, (binding.save.reason || 'Saving estimates to jobs isn’t turned on yet.') + ' You can keep using the calculator.', 'pc-field-error');
        sheetButtons(body, [{ label: 'Close', onClick: closeSheet }]);
        return;
      }
      if (binding.storageReady === false) {
        sheetText(body, 'Saving estimates to jobs isn’t set up yet (the database migration hasn’t been applied). Nothing will be saved.', 'pc-field-error');
        sheetButtons(body, [{ label: 'Close', onClick: closeSheet }]);
        return;
      }

      if (replacingSaved) {
        var warn = el('div', 'pc-save-warn');
        warn.appendChild(el('strong', null, 'This job already has a saved estimate'));
        warn.appendChild(el('span', null, ' (' + Core.formatCents(existing.totalCents) + ', saved ' + formatDate(existing.updatedAt) + '). Saving replaces it.'));
        body.appendChild(warn);
      }

      // Quoted Amount — opt-in, never automatic when it would replace a
      // different existing quote.
      var quoteRow = el('label', 'admin-checkbox-row pc-quote-row');
      var quoteBox = el('input');
      quoteBox.type = 'checkbox';
      quoteBox.id = 'pc-apply-quote';
      var quoteLabel = el('span');
      quoteRow.appendChild(quoteBox);
      quoteRow.appendChild(quoteLabel);
      if (!booking.quoteWritable) {
        quoteBox.disabled = true;
        quoteLabel.textContent = 'Quoted amount stays ' + (currentQuote || 'unset') + '. ' + (booking.quoteWritableReason || '');
      } else if (currentQuote === null) {
        // Never pre-checked: changing the job's quote is always an
        // explicit choice, even when there is no quote to replace.
        quoteBox.checked = false;
        quoteLabel.textContent = 'Also set the job’s Quoted amount to ' + totalText;
      } else if (!quoteDiffers) {
        quoteBox.disabled = true;
        quoteLabel.textContent = 'Job’s Quoted amount already matches (' + currentQuote + ')';
      } else {
        quoteBox.checked = false;
        quoteLabel.textContent = 'Replace the job’s Quoted amount (' + currentQuote + ') with ' + totalText;
      }
      body.appendChild(quoteRow);
      sheetText(body, 'This saves the breakdown on the job only. No invoice, charge, payment, or customer message is created.', 'admin-field-hint');

      var errorEl = el('p', 'pc-field-error');
      errorEl.hidden = true;
      errorEl.setAttribute('role', 'alert');
      body.appendChild(errorEl);

      var actions = sheetButtons(body, [
        { label: 'Cancel', onClick: closeSheet },
        { label: replacingSaved ? 'Replace saved estimate' : 'Save estimate', primary: true, id: 'pc-confirm-save', onClick: function () {
          var applyQuote = quoteBox.checked && !quoteBox.disabled;
          submitSave({
            expectedRevision: replacingSaved ? existing.revision : binding.revision,
            applyToQuotedAmount: applyQuote,
            confirmQuotedOverwrite: applyQuote && quoteDiffers,
          }, errorEl, actions);
        } },
      ]);
      // The confirming tap names exactly what it will overwrite.
      var confirmBtnEl = actions.querySelector('#pc-confirm-save');
      var baseLabel = confirmBtnEl.textContent;
      quoteBox.addEventListener('change', function () {
        confirmBtnEl.textContent = quoteBox.checked && quoteDiffers ? baseLabel + ' & replace quote' : baseLabel;
      });
      if (binding.bookingId) {
        var change = el('button', 'pc-link-btn', 'Save to a different job');
        change.type = 'button';
        change.addEventListener('click', function () { openJobPicker(); });
        body.appendChild(change);
      }
    });
  }

  function submitSave(flags, errorEl, actionsRow) {
    if (saveInFlight) return;
    var normalized = Core.normalizeInput(state, { requireLoadTier: true });
    if (!normalized.ok) { errorEl.textContent = normalized.errors[0]; errorEl.hidden = false; return; }
    var est = Core.computeEstimate(normalized.value);
    var input = normalized.value;
    var payload = {
      bookingId: binding.bookingId,
      input: input,
      clientTotalCents: est.totalCents,
      expectedRevision: flags.expectedRevision === undefined ? null : flags.expectedRevision,
      applyToQuotedAmount: !!flags.applyToQuotedAmount,
      confirmQuotedOverwrite: !!flags.confirmQuotedOverwrite,
    };
    // Same key for an identical retry (lost response, network blip) so the
    // server can recognize it; a new key for anything different.
    var payloadKey = JSON.stringify(payload);
    if (!pendingSave || pendingSave.payloadKey !== payloadKey) pendingSave = { payloadKey: payloadKey, requestKey: randomKey() };
    payload.requestKey = pendingSave.requestKey;

    saveInFlight = true;
    var buttons = actionsRow.querySelectorAll('button');
    Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    var confirmBtn = actionsRow.querySelector('#pc-confirm-save');
    var confirmLabel = confirmBtn ? confirmBtn.textContent : '';
    if (confirmBtn) confirmBtn.textContent = 'Saving…';
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    errorEl.hidden = true;

    fetchJson('/api/admin/booking?resource=price-estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      saveInFlight = false;
      if (r.ok) {
        pendingSave = null;
        binding.revision = r.body.estimate.revision;
        binding.existing = r.body.estimate;
        if (r.body.booking) {
          r.body.booking.customerName = r.body.booking.customerName || (binding.booking && binding.booking.customerName);
          binding.booking = r.body.booking;
        }
        savedSnapshot = payloadSnapshot(input);
        renderJobChip();
        closeSheet();
        var msg = r.body.duplicate ? 'Already saved — nothing changed.' : 'Estimate saved to the job.';
        if (r.body.quotedAmountUpdated) msg += ' Quoted amount updated.';
        if (r.body.warning) { showError(r.body.warning); }
        showToast(msg + ' No invoice or charge was created.', 'success');
        saveStatus.textContent = 'Saved ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' · revision ' + r.body.estimate.revision;
        updateSaveUi();
        return;
      }
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; });
      if (confirmBtn) confirmBtn.textContent = confirmLabel;
      updateSaveUi();
      var code = r.body.code;
      if (code === 'estimate_exists' && r.body.existing) {
        binding.existing = r.body.existing;
        binding.revision = null;
        openConfirmSave({ forceReplace: true });
        return;
      }
      if (code === 'quote_overwrite_required') {
        // The job's quote changed since it was loaded — refresh it, then
        // ask again with the real current figure on screen.
        loadJob(binding.bookingId).then(function (data) {
          data.booking.customerName = data.booking.customerName || (binding.booking && binding.booking.customerName);
          binding.booking = data.booking;
          openConfirmSave();
        }).catch(function (err) { errorEl.textContent = err.message; errorEl.hidden = false; });
        return;
      }
      if (code === 'revision_conflict') {
        openSheet('Saved estimate changed', function (body) {
          sheetText(body, r.body.error || 'This job’s saved estimate was changed somewhere else.');
          sheetButtons(body, [
            { label: 'Keep my screen', onClick: closeSheet },
            { label: 'Load the saved version', primary: true, onClick: function () {
              closeSheet();
              loadJob(binding.bookingId).then(function (data) { bindJob(data, { loadSaved: true }); showToast('Loaded the latest saved estimate.'); })
                .catch(function (err) { showError(err.message); });
            } },
          ]);
        });
        return;
      }
      if (code === 'estimate_missing') {
        binding.revision = null;
        binding.existing = null;
      }
      errorEl.textContent = r.body.error || 'Could not save this estimate. Try again.';
      errorEl.hidden = false;
    }).catch(function () {
      saveInFlight = false;
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; });
      if (confirmBtn) confirmBtn.textContent = 'Try again';
      updateSaveUi();
      errorEl.textContent = 'Network problem — the estimate may not have saved. Tap “Try again”; a repeat tap will never save it twice.';
      errorEl.hidden = false;
    });
  }

  function payloadSnapshot(normalizedInput) {
    return JSON.stringify(Core.normalizeInput(normalizedInput).value);
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      logoutBtn.disabled = true;
      fetch('/api/admin/logout', { method: 'POST' }).catch(function () {}).then(function () { window.location.href = '/admin/login/'; });
    });
  }

  render();

  var params = new URLSearchParams(window.location.search);
  var initialBookingId = (params.get('bookingId') || '').trim();
  if (initialBookingId) {
    loadJob(initialBookingId).then(function (data) {
      bindJob(data, { loadSaved: true });
      if (!data.booking.priceable) showError('This is a ' + data.booking.serviceLabel + ' job, which has its own pricing. You can still use the calculator, but it can’t be saved to this job.');
      else if (data.estimate) saveStatus.textContent = 'Loaded saved estimate · revision ' + data.estimate.revision;
    }).catch(function (err) { showError(err.message); });
  } else {
    // Session check — this page has nothing to fetch without a job, so
    // there would otherwise be no natural 401 (same reasoning as
    // admin/estimate-new.js's identical check).
    adminFetch('/api/admin/bookings?countsOnly=1').then(function (res) {
      if (res.status === 401) window.location.href = '/admin/login/';
    }).catch(function () {});
  }

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  });
});
