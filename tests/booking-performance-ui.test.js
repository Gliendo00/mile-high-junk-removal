const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.value = ''; this.attrs = {}; this.events = {}; }
  appendChild(n) { this.children.push(n); n.parent = this; return n; }
  after(n) { this.sibling = n; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.events[k] = fn; }
  dispatchEvent(event) { if (this.events[event.type]) this.events[event.type](event); }
  replaceChildren() { this.children = []; }
  querySelectorAll(tag) { return this.children.flatMap(n => (n.tag === tag ? [n] : []).concat(n.querySelectorAll(tag))); }
  remove() { this.parent.children = this.parent.children.filter(n => n !== this); }
}
const document = {createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag), addEventListener() {}};
const context = vm.createContext({window: {}, document, Event: class { constructor(type) { this.type = type; } }, console});
vm.runInContext(fs.readFileSync('admin/time-selector.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('admin/business-performance.js', 'utf8'), context);
const input = new Node('input');
const control = context.window.AdminTimeSelector(input);
const selects = input.sibling.querySelectorAll('select');
for (let hour = 0; hour < 24; hour++) for (let minute = 0; minute < 60; minute++) {
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  input.value = time; control.show(true);
  selects[0].events.change();
  assert.equal(input.value, time, `Stored time round trip ${time}`);
}
control.show(false); assert.equal(input.sibling.hidden, true);
input.value = ''; control.show(true); assert.equal(selects[0].value, '');
selects[0].value = '12'; selects[1].value = '30'; selects[2].value = 'AM'; selects[0].events.change(); assert.equal(input.value, '00:30');
selects[2].value = 'PM'; selects[2].events.change(); assert.equal(input.value, '12:30');
const api = context.window.AdminBusinessPerformance;
const rows = api.aggregate('2026-10-01', '2026-10-03', [
  {appointmentDate: '2026-10-01', status: 'completed', revenueAmount: 125, finalPrice: 999},
  {appointmentDate: '2026-10-01', status: 'completed', isComplimentary: true, revenueAmount: 999},
  {appointmentDate: '2026-10-01', status: 'completed', serviceType: 'dumpster_pickup', revenueAmount: 999},
  {appointmentDate: '2026-10-02', status: 'booked', revenueAmount: 999},
  {appointmentDate: '2026-10-02', status: 'completed', finalPrice: 0, estimatedPrice: 999},
  {appointmentDate: '2026-10-02', status: 'completed', finalPrice: null, estimatedPrice: 50},
  {appointmentDate: '2026-09-30', status: 'completed', revenueAmount: 999}
], [{expenseDate: '2026-10-01', amount: 25}, {expenseDate: '2026-10-01', amount: 999, voidedAt: 'yes'}],
[{revenueDate: '2026-10-01', amount: 40}, {revenueDate: '2026-10-01', amount: 999, voidedAt: 'yes'}]);
assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
  {date:'2026-10-01', revenue:165, expenses:25, jobs:2},
  {date:'2026-10-02', revenue:50, expenses:0, jobs:3},
  {date:'2026-10-03', revenue:0, expenses:0, jobs:0}
]);
assert.equal(api.addDays('2026-03-08', 1), '2026-03-09');
assert.equal(api.addDays('2026-12-31', 1), '2027-01-01');
// Ledger-aware response: a $400 payment minus a $50 refund is $350.
const economicRows = api.aggregate('2026-10-01', '2026-10-01', [
  {appointmentDate:'2026-10-01',serviceType:'junk_removal',status:'completed',revenueAmount:350,finalPrice:400},
  {appointmentDate:'2026-10-01',serviceType:'dumpster_rental',status:'completed',revenueAmount:500},
  {appointmentDate:'2026-10-01',serviceType:'dumpster_pickup',status:'completed',revenueAmount:500},
  {appointmentDate:'2026-10-01',serviceType:'junk_removal',status:'completed',isComplimentary:true,revenueAmount:200}
], [{expenseDate:'2026-10-01',amount:25},{expenseDate:'2026-10-01',amount:999,voidedAt:'yes'}], []);
assert.deepEqual(JSON.parse(JSON.stringify(economicRows)), [{date:'2026-10-01',revenue:850,expenses:25,jobs:3}]);
assert.equal(api.aggregate('2026-10-01','2026-10-01',[{appointmentDate:'2026-10-01',status:'completed',revenueAmount:-50}],[],[])[0].revenue,-50,'Net refunds remain negative');
async function main() {
  const calls = [];
  context.adminFetch = async url => {
    calls.push(url); const u = new URL(url, 'http://localhost');
    const view = u.searchParams.get('view'); const offset = Number(u.searchParams.get('offset'));
    const body = view === 'schedule' ? {ok:true,jobs:[]} : view === 'expenses' ? {ok:true,expenses:[{expenseDate:'2026-10-01',amount:1}],hasMore:offset === 0} : {ok:true,otherRevenue:[],hasMore:false};
    return {ok:true,status:200,json:async () => body};
  };
  const root = new Node('section'); api.mount(root);
  await new Promise(resolve => setImmediate(resolve));
  assert(calls.some(url => url.includes('offset=1')), 'Loads all expense pages');
  const buttons = root.querySelectorAll('button');
  assert.equal(buttons[1].attrs['aria-pressed'], 'true', 'Defaults to 30D');
  buttons.slice(3).forEach(button => button.onclick());
  assert(root.children.some(n => n.textContent === 'Select a metric to show the chart.'));
  buttons[3].onclick(); assert.equal(root.querySelectorAll('polyline').length, 1);
  const paragraphs = root.querySelectorAll('p').map(n => n.textContent);
  assert(paragraphs.includes('Revenue · green'), 'Legend contains only the enabled metric');
  assert(paragraphs.includes('Dollars (left)'), 'Disabled job count has no count-axis caption');
  buttons[3].onclick(); buttons[5].onclick();
  assert(root.querySelectorAll('p').some(n => n.textContent === 'Jobs (right)'));
  assert(!root.querySelectorAll('text').some(n => n.textContent.startsWith('$')), 'Job-only view has no misleading dollar axis');
  buttons[0].onclick(); buttons[2].onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(root.querySelectorAll('table').length, 1, 'Stale range response ignored');
  context.adminFetch = async () => { throw new Error('Offline'); };
  buttons[1].onclick(); await new Promise(resolve => setImmediate(resolve));
  assert(root.children.some(n => n.textContent === 'Offline'));
  assert.equal(root.querySelectorAll('polyline').length, 0, 'Failure never shown as zero data');
  context.window.location = {href: ''};
  context.adminFetch = async () => ({status:403});
  buttons[0].onclick(); await new Promise(resolve => setImmediate(resolve));
  assert(root.children.some(n => n.textContent === 'Access denied.'));
  assert.equal(context.window.location.href, '', '403 stays on the dashboard instead of redirecting to a nonexistent page');
  for (const page of ['booking-new','booking-edit','booking-past']) {
    const html = fs.readFileSync(`admin/${page}/index.html`, 'utf8');
    assert(html.includes('type="hidden" id="exact-time"'));
    assert(html.indexOf('../time-selector.js') < html.indexOf(`../${page}.js`));
  }
  console.log('PASS: 1,440 stored-time round trips, AM/PM, visibility, financial rules, dates, pagination, toggles, range races, failures, and page wiring.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
