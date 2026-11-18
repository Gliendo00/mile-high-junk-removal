// Returning-client address prefill — shared by admin/booking-new.js
// ("+ New Job"), admin/booking-past.js ("+ Past Job") and
// admin/estimate-new.js ("+ New Estimate").
//
// The client picker's search results only carry name/phone/email/city
// (never the street address), so picking a returning client used to leave
// the Service Address blank every time. When a client is selected, this
// loads that client's record (existing GET /api/admin/client?id=, which
// already returns the address on file plus every job's service address,
// newest first) and fills the form's address fields with:
//   1. the client's address on file, if they have one, otherwise
//   2. the service address of their most recent job/estimate that has one.
//
// It only ever fills fields that are still empty (State is ignored, since
// it defaults to "CO") — anything already typed, or prefilled from a Lead
// or Estimate, is never overwritten. A short hint under the Street Address
// says where the address came from so it's obvious it can be edited.
// Every dynamic value is written with textContent / .value only.
window.AdminClientAddressPrefill = (function () {
  function pickAddress(body) {
    var c = body && body.client;
    if (c && c.address) {
      return { address: c.address, city: c.city || '', state: c.state || '', zip: c.zip || '', source: 'file' };
    }
    var bookings = (body && body.bookings) || [];
    for (var i = 0; i < bookings.length; i++) {
      var sa = bookings[i].serviceAddress;
      if (sa && sa.address) {
        return { address: sa.address, city: sa.city || '', state: sa.state || '', zip: sa.zip || '', source: 'lastJob' };
      }
    }
    return null;
  }

  // fields: { address, city, state, zip } inputs.
  // opts.onLoaded(addr|null): called with the chosen address (or null)
  //   once a selected client's record has loaded — booking-new.js uses it
  //   to enable its "Same as client's address on file" checkbox.
  // Returns a function to call with the selected client (or null).
  function attach(fields, opts) {
    opts = opts || {};
    var requestSeq = 0;
    var hint = document.createElement('div');
    hint.className = 'admin-field-hint';
    hint.setAttribute('hidden', '');
    var addressField = fields.address.closest('.admin-field') || fields.address.parentNode;
    addressField.appendChild(hint);

    function setHint(text) {
      hint.textContent = text || '';
      if (text) hint.removeAttribute('hidden');
      else hint.setAttribute('hidden', '');
    }

    function fieldsEmpty() {
      return !fields.address.value.trim() && !fields.city.value.trim() && !fields.zip.value.trim();
    }

    // Typing in the address clears the "filled from..." hint — it no
    // longer describes what's in the field.
    fields.address.addEventListener('input', function () { setHint(''); });

    return function onClient(client) {
      var seq = ++requestSeq;
      setHint('');
      if (!client || !client.id) {
        if (opts.onLoaded) opts.onLoaded(null);
        return;
      }
      adminFetch('/api/admin/client?id=' + encodeURIComponent(client.id))
        .then(function (res) {
          if (!res.ok) return null;
          return res.json().catch(function () { return null; });
        })
        .then(function (body) {
          if (seq !== requestSeq) return; // a different client was picked since
          var addr = pickAddress(body);
          if (opts.onLoaded) opts.onLoaded(addr);
          if (!addr || !fieldsEmpty()) return;
          fields.address.value = addr.address;
          fields.city.value = addr.city;
          if (addr.state) fields.state.value = addr.state;
          fields.zip.value = addr.zip;
          setHint(addr.source === 'file'
            ? 'Filled from this client’s address on file. Edit if this job is somewhere else.'
            : 'Filled from this client’s last job. Edit if this job is somewhere else.');
        })
        .catch(function () {
          // Best-effort convenience only: on any failure the address
          // fields simply stay as they are, fully manual.
        });
    };
  }

  return { attach: attach, pickAddress: pickAddress };
})();
