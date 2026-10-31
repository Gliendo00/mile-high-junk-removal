// Presentation adapter: booking scripts retain the original HH:mm input.
window.AdminTimeSelector = function (input) {
  var root = document.createElement('div');
  root.className = 'admin-time-selector';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Exact appointment time');
  root.hidden = true;
  input.after(root);
  function select(label, values) {
    var wrap = document.createElement('label');
    wrap.textContent = label;
    var node = document.createElement('select');
    node.setAttribute('aria-label', label);
    values.forEach(function (value) {
      var option = document.createElement('option');
      option.value = value; option.textContent = value || '—'; node.appendChild(option);
    });
    wrap.appendChild(node); root.appendChild(wrap);
    node.addEventListener('change', update);
    return node;
  }
  var hour = select('Hour', [''].concat(Array.from({length: 12}, function (_, i) { return String(i + 1); })));
  // Common minutes first; every stored minute remains selectable.
  var minute = select('Minute', ['00', '15', '30', '45'].concat(Array.from({length: 60}, function (_, i) { return String(i).padStart(2, '0'); }).filter(function (m) { return Number(m) % 15 !== 0; })));
  var period = select('AM / PM', ['AM', 'PM']);
  function update() {
    input.value = hour.value ? String(Number(hour.value) % 12 + (period.value === 'PM' ? 12 : 0)).padStart(2, '0') + ':' + minute.value : '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { show: function (visible) {
    root.hidden = !visible;
    var match = /^(\d{2}):(\d{2})/.exec(input.value);
    hour.value = match ? String(Number(match[1]) % 12 || 12) : '';
    minute.value = match ? match[2] : '00';
    period.value = match && Number(match[1]) >= 12 ? 'PM' : 'AM';
  }};
};
