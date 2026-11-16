// Interactive Pricing Calculator — the ONE shared price engine.
//
// Loaded two ways, deliberately the same file both times:
//   - in the browser by /admin/pricing-calculator/ (window.PricingCalcCore),
//     so every tap re-renders the live breakdown instantly with no network
//     round trip;
//   - on the server by api/_lib/price-estimate.js (require()), which
//     RE-COMPUTES every saved estimate from the raw selections and never
//     trusts a browser-submitted total.
// One file means the two can never drift apart — a second, hand-copied
// price table is exactly how a "the screen said $375 but the job says
// $350" bug happens.
//
// Prices are the published junk-removal prices on /pricing.html (nine
// trailer-volume tiers, special-item disposal fees, $125/hour additional
// labor with the first hour included). tests/pricing-calculator.test.js
// asserts every value here still matches pricing.html, so a future price
// change on the public site that forgets this file fails the suite.
//
// Money is integer cents end to end. Dollar strings typed by staff are
// parsed with the same strict string/BigInt-free rule as
// api/_lib/money.js's decimalDollarsToCents() (digits, optional 1-2
// decimals — no floats multiplied by 100, ever). pricing.html states
// "Pricing includes taxes", so no tax line is ever added here.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PricingCalcCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LOAD_TIERS = [
    { key: 'minimum', label: 'Minimum Pickup', shortLabel: 'Min', fraction: 0.0625, cents: 10000 },
    { key: 'eighth', label: '1/8 Trailer Load', shortLabel: '1/8', fraction: 0.125, cents: 15000 },
    { key: 'quarter', label: '1/4 Trailer Load', shortLabel: '1/4', fraction: 0.25, cents: 20000 },
    { key: 'three_eighths', label: '3/8 Trailer Load', shortLabel: '3/8', fraction: 0.375, cents: 27500 },
    { key: 'half', label: '1/2 Trailer Load', shortLabel: '1/2', fraction: 0.5, cents: 35000 },
    { key: 'five_eighths', label: '5/8 Trailer Load', shortLabel: '5/8', fraction: 0.625, cents: 42500 },
    { key: 'three_quarters', label: '3/4 Trailer Load', shortLabel: '3/4', fraction: 0.75, cents: 47500 },
    { key: 'seven_eighths', label: '7/8 Trailer Load', shortLabel: '7/8', fraction: 0.875, cents: 55000 },
    { key: 'full', label: 'Full Trailer Load', shortLabel: 'Full', fraction: 1, cents: 60000 },
  ];

  var DISPOSAL_ITEMS = [
    { key: 'tire_no_rim', label: 'Tire (no rim)', unit: 'tire', cents: 500 },
    { key: 'tire_with_rim', label: 'Tire (with rim)', unit: 'tire', cents: 1000 },
    { key: 'paint_can', label: 'Paint can', unit: 'can', cents: 1500 },
    { key: 'freon_item', label: 'Freon item', hint: 'Fridge, freezer, AC unit', unit: 'item', cents: 2500 },
    { key: 'tv_under_48', label: 'TV under 48"', unit: 'TV', cents: 2500 },
    { key: 'tv_48_plus', label: 'TV 48" or larger', unit: 'TV', cents: 5000 },
  ];

  // Labor: the first hour is included in every load price, so the only
  // labor input is ADDITIONAL time, in quarter-hour steps. $125/hour is
  // exactly 3125 cents per quarter hour, so every labor amount is an exact
  // integer — no rounding ever happens anywhere in this engine.
  var LABOR_RATE_CENTS = 12500;
  var LABOR_QUARTER_CENTS = 3125;

  var LIMITS = {
    disposalQty: 99,
    laborQuarterHours: 96, // 24 additional hours — far past any real job
    customCount: 10,
    discountCount: 5,
    descriptionLength: 80,
    notesLength: 2000,
    lineCents: 1000000, // $10,000 per custom/discount line
  };

  var TIER_BY_KEY = {};
  LOAD_TIERS.forEach(function (t) { TIER_BY_KEY[t.key] = t; });
  var ITEM_BY_KEY = {};
  DISPOSAL_ITEMS.forEach(function (i) { ITEM_BY_KEY[i.key] = i; });

  // Strict dollars -> cents, mirroring api/_lib/money.js (kept local so
  // this file has no require() and can load in the browser as-is).
  // Accepts "25", "25.5", "25.50", "$25.50", "1,250.00". Rejects
  // negatives, 3+ decimals, exponents, blanks. Returns int cents or null.
  function parseDollarsToCents(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
      if (!isFinite(value)) return null;
      value = String(value);
    }
    if (typeof value !== 'string') return null;
    var str = value.trim().replace(/^\$/, '');
    if (/,/.test(str)) {
      if (!/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(str)) return null;
      str = str.replace(/,/g, '');
    }
    var m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(str);
    if (!m) return null;
    if (m[1].length > 9) return null;
    var cents = parseInt(m[1], 10) * 100 + parseInt((m[2] || '').padEnd(2, '0') || '0', 10);
    return isFinite(cents) ? cents : null;
  }

  function formatCents(cents) {
    var n = Math.trunc(Number(cents)) || 0;
    var sign = n < 0 ? '-' : '';
    var abs = Math.abs(n);
    var whole = Math.floor(abs / 100);
    var frac = String(abs % 100).padStart(2, '0');
    return sign + '$' + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac;
  }

  function formatLaborHours(quarters) {
    var q = Math.trunc(Number(quarters)) || 0;
    var hours = q / 4; // quarter multiples are exact in binary floating point
    var label = String(hours);
    return label + (hours === 1 ? ' hr' : ' hrs');
  }

  // Text is shown to the customer and stored, so: collapse whitespace,
  // strip control characters, cap length. Rendering is always textContent
  // (never parsed as markup), so HTML in a description is inert — this
  // is about tidy data, not the XSS defense itself.
  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }
  function cleanNotes(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max);
  }

  function isWholeNumber(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  }

  // Validates and normalizes a raw selection object — the exact same shape
  // the browser builds and the server receives:
  //   { loadTier, disposal: {key: qty}, laborQuarterHours,
  //     customCharges: [{description, amount}], discounts: [{description, amount}],
  //     notes, confirmedOnSite }
  // `amount` on custom/discount lines may be a dollar string or int cents
  // via `amountCents`. Returns { ok, value, errors[] }. Never throws.
  function normalizeInput(raw, opts) {
    opts = opts || {};
    var errors = [];
    var input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var out = { loadTier: null, disposal: {}, laborQuarterHours: 0, customCharges: [], discounts: [], notes: '', confirmedOnSite: false };

    if (input.loadTier !== null && input.loadTier !== undefined && input.loadTier !== '') {
      if (typeof input.loadTier === 'string' && TIER_BY_KEY[input.loadTier]) out.loadTier = input.loadTier;
      else errors.push('Unknown load size.');
    }
    if (opts.requireLoadTier && !out.loadTier) errors.push('Choose a load size first.');

    var disposal = input.disposal && typeof input.disposal === 'object' && !Array.isArray(input.disposal) ? input.disposal : {};
    Object.keys(disposal).forEach(function (key) {
      var qty = disposal[key];
      if (!ITEM_BY_KEY[key]) { errors.push('Unknown disposal item.'); return; }
      if (!isWholeNumber(qty) || qty < 0 || qty > LIMITS.disposalQty) { errors.push('Quantity for ' + ITEM_BY_KEY[key].label + ' must be a whole number from 0 to ' + LIMITS.disposalQty + '.'); return; }
      if (qty > 0) out.disposal[key] = qty;
    });

    if (input.laborQuarterHours !== undefined && input.laborQuarterHours !== null) {
      var lq = input.laborQuarterHours;
      if (!isWholeNumber(lq) || lq < 0 || lq > LIMITS.laborQuarterHours) errors.push('Additional labor must be between 0 and ' + (LIMITS.laborQuarterHours / 4) + ' hours, in 15-minute steps.');
      else out.laborQuarterHours = lq;
    }

    function readLines(list, kind, maxCount, outList) {
      if (list === undefined || list === null) return;
      if (!Array.isArray(list)) { errors.push('Invalid ' + kind + ' list.'); return; }
      if (list.length > maxCount) { errors.push('No more than ' + maxCount + ' ' + kind + 's per estimate.'); return; }
      list.forEach(function (line) {
        var l = line && typeof line === 'object' ? line : {};
        var description = cleanText(l.description, LIMITS.descriptionLength);
        var cents = isWholeNumber(l.amountCents) ? l.amountCents : parseDollarsToCents(l.amount);
        if (!description) { errors.push('Each ' + kind + ' needs a description.'); return; }
        if (cents === null || cents <= 0 || cents > LIMITS.lineCents) { errors.push('Enter a valid ' + kind + ' amount (more than $0, up to ' + formatCents(LIMITS.lineCents) + ').'); return; }
        outList.push({ description: description, amountCents: cents });
      });
    }
    readLines(input.customCharges, 'custom charge', LIMITS.customCount, out.customCharges);
    readLines(input.discounts, 'discount', LIMITS.discountCount, out.discounts);

    out.notes = cleanNotes(input.notes, LIMITS.notesLength);
    out.confirmedOnSite = input.confirmedOnSite === true;

    if (!errors.length) {
      var totals = computeEstimate(out);
      if (totals.discountCents > totals.subtotalCents) errors.push('Discounts can’t be more than the charges (' + formatCents(totals.subtotalCents) + ').');
    }
    return { ok: errors.length === 0, value: out, errors: errors };
  }

  // Pure function of a NORMALIZED input. Every line the customer pays for
  // is listed — including the included first labor hour at $0.00, so the
  // labor math is visible rather than implied. Line order is fixed (load,
  // disposal in catalog order, labor, custom, discounts), so the same
  // selections always produce the identical breakdown.
  function computeEstimate(input) {
    var lines = [];
    var subtotal = 0;
    var discount = 0;
    var tier = input.loadTier ? TIER_BY_KEY[input.loadTier] : null;

    if (tier) {
      lines.push({ kind: 'load', key: tier.key, description: tier.label, quantity: 1, unitCents: tier.cents, amountCents: tier.cents });
      lines.push({ kind: 'labor_included', key: 'labor_included', description: 'First hour of labor', note: 'Included', quantity: 1, unitCents: 0, amountCents: 0 });
      subtotal += tier.cents;
    }
    DISPOSAL_ITEMS.forEach(function (item) {
      var qty = (input.disposal && input.disposal[item.key]) || 0;
      if (!qty) return;
      var amount = item.cents * qty;
      lines.push({ kind: 'disposal', key: item.key, description: item.label + ' disposal', quantity: qty, unit: item.unit, unitCents: item.cents, amountCents: amount });
      subtotal += amount;
    });
    if (input.laborQuarterHours > 0) {
      var laborCents = LABOR_QUARTER_CENTS * input.laborQuarterHours;
      lines.push({ kind: 'labor', key: 'labor_additional', description: 'Additional labor', quantity: input.laborQuarterHours / 4, quantityLabel: formatLaborHours(input.laborQuarterHours), unit: 'hr', unitCents: LABOR_RATE_CENTS, amountCents: laborCents });
      subtotal += laborCents;
    }
    (input.customCharges || []).forEach(function (c, idx) {
      lines.push({ kind: 'custom', key: 'custom_' + idx, description: c.description, quantity: 1, unitCents: c.amountCents, amountCents: c.amountCents });
      subtotal += c.amountCents;
    });
    (input.discounts || []).forEach(function (d, idx) {
      lines.push({ kind: 'discount', key: 'discount_' + idx, description: d.description, quantity: 1, unitCents: -d.amountCents, amountCents: -d.amountCents });
      discount += d.amountCents;
    });

    return {
      lines: lines,
      subtotalCents: subtotal,
      discountCents: discount,
      // Never negative: normalizeInput() rejects discounts above the
      // subtotal outright (no silent clamping — the customer must never
      // see an unexplained adjustment); Math.max is a last-resort guard.
      totalCents: Math.max(0, subtotal - discount),
    };
  }

  return {
    LOAD_TIERS: LOAD_TIERS,
    DISPOSAL_ITEMS: DISPOSAL_ITEMS,
    LABOR_RATE_CENTS: LABOR_RATE_CENTS,
    LABOR_QUARTER_CENTS: LABOR_QUARTER_CENTS,
    LIMITS: LIMITS,
    parseDollarsToCents: parseDollarsToCents,
    formatCents: formatCents,
    formatLaborHours: formatLaborHours,
    normalizeInput: normalizeInput,
    computeEstimate: computeEstimate,
    tierByKey: function (k) { return TIER_BY_KEY[k] || null; },
    itemByKey: function (k) { return ITEM_BY_KEY[k] || null; },
  };
});
