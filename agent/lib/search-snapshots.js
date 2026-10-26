// Server-only snapshot ingestion. Evidence only; never creates findings or priorities.
const gsc = require('./search-console-client');
const ga4 = require('./ga4-client');
const { getServiceClient } = require('../../api/_lib/supabase-admin');
const EVENTS = ['phone_click', 'sms_click', 'booking_started', 'booking_service_selected', 'booking_date_selected', 'booking_form_completed'];
const METRICS = ['totalUsers', 'sessions', 'engagedSessions', 'engagementRate', 'keyEvents'];
function periods(now = new Date()) {
  // Three-day lag avoids incomplete Google processing days; same dates for both sources.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const day = Date.parse(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
  const date = n => new Date(day - n * 86400000).toISOString().slice(0, 10);
  return [{ startDate: date(30), endDate: date(3) }, { startDate: date(58), endDate: date(31) }];
}
function failure(result) {
  if (!result.skipped) return;
  const reason = result.reason || 'Google API failed';
  const status = result.status;
  const category = status === 401 ? 'authentication_failure' : status === 403 || status === 404 ? 'property_configuration' : /not configured|no.*credential|missing.*credential/i.test(reason) ? 'missing_credentials' : /auth|token|credential|impersonat/i.test(reason) ? 'authentication_failure' : 'api_error';
  throw Object.assign(new Error(reason), { category });
}
function number(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n) || n < 0) throw new Error('Invalid Google numeric metric');
  return n;
}
function normalizeGsc(rows) {
  return rows.map(r => {
    if (!Array.isArray(r.keys) || r.keys.length !== 2) throw new Error('Expected GSC query/page dimensions');
    return { query: r.keys[0], landing_page: r.keys[1], clicks: number(r.clicks), impressions: number(r.impressions), ctr: number(r.ctr), position: number(r.position) };
  });
}
function normalizeGa4(report) {
  const names = (report.metricHeaders || []).map(h => h.name);
  return (report.rows || []).map(r => {
    const metrics = Object.fromEntries(names.map((name, i) => [name, number(r.metricValues[i].value)]));
    if (METRICS.some(name => metrics[name] == null)) throw new Error('Missing GA4 metric headers');
    return { landing_page: r.dimensionValues?.[0]?.value || '(not set)', organic_users: metrics.totalUsers, organic_sessions: metrics.sessions, engaged_sessions: metrics.engagedSessions, engagement_rate: metrics.engagementRate, key_events: metrics.keyEvents };
  });
}
const timedFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
async function paged(call, args, kind) {
  const rows = []; let first;
  for (let offset = 0; offset < 1000000; offset += 25000) {
    const result = await call({ ...args, fetchImpl: timedFetch, rowLimit: 25000, limit: 25000, startRow: offset, offset });
    failure(result); first ||= result;
    if (!Array.isArray(result.rows)) throw new Error("Malformed Google rows");
    rows.push(...result.rows);
    if (result.rows.length < 25000) {
      if (result.rowCount > rows.length) throw new Error('GA4 response incomplete');
      return { ...first, rows };
    }
  }
  throw new Error(`${kind} pagination safety limit exceeded; snapshot not published`);
}
async function collectSource(source, window, clients = { gsc, ga4 }) {
  if (source === 'gsc') {
    const report = await paged(clients.gsc.querySearchAnalytics, { ...window, dimensions: ['query', 'page'], dataState: 'final' }, source);
    const totals = await clients.gsc.querySearchAnalytics({ ...window, fetchImpl: timedFetch, dimensions: [], dataState: 'final', aggregationType: 'byProperty' });
    failure(totals);
    const t = totals.rows[0];
    return { rows: normalizeGsc(report.rows), totals: t ? { clicks: number(t.clicks), impressions: number(t.impressions), ctr: number(t.ctr), position: number(t.position) } : { clicks: 0, impressions: 0, ctr: 0, position: 0 }, metadata: { limitations: 'Google omits anonymized queries and can return top rows only; query/page sums need not equal property totals.', timezone: 'America/Los_Angeles' } };
  }
  const dimensionFilter = { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' } } };
  const args = { ...window, metrics: METRICS, dimensionFilter };
  const report = await paged(clients.ga4.runReport, { ...args, dimensions: ['landingPage'] }, source);
  const total = await clients.ga4.runReport({ ...args, fetchImpl: timedFetch, dimensions: [] }); failure(total);
  const totals = normalizeGa4(total)[0] || { organic_users: 0, organic_sessions: 0, engaged_sessions: 0, engagement_rate: 0, key_events: 0 };
  delete totals.landing_page;
  // Event counts are observations, not assumed key-event mappings.
  let events = [], eventStatus = 'available';
  try {
    const eventReport = await paged(clients.ga4.runReport, { ...window, dimensions: ['eventName'], metrics: ['eventCount'], dimensionFilter: { andGroup: { expressions: [dimensionFilter, { filter: { fieldName: 'eventName', inListFilter: { values: EVENTS } } }] } } }, source);
    events = eventReport.rows.map(r => ({ event: r.dimensionValues[0].value, count: number(r.metricValues[0].value) }));
  } catch (_) { eventStatus = 'collection_failed'; }
  return { rows: normalizeGa4(report), totals, metadata: { ...report.metadata, events, eventStatus, conversionMapping: 'unresolved', limitations: 'Key events are property-configured totals, not verified booking conversions. Users are distinct at report scope; do not sum landing-page users. GA4 uses its property timezone.' } };
}
async function collect({ db = getServiceClient(), now = new Date(), clients } = {}) {
  if (!db) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY missing');
  const outcomes = [];
  for (const source of ['gsc', 'ga4']) for (const window of periods(now)) {
    const property = process.env[source === 'gsc' ? 'GSC_SITE_URL' : 'GA4_PROPERTY_ID'] || '(unconfigured)';
    const base = { source, property, period_start: window.startDate, period_end: window.endDate, collected_at: now.toISOString() };
    try {
      if (property === '(unconfigured)') throw Object.assign(new Error(`${source} property not configured`), { category: 'property_configuration' });
      const data = await collectSource(source, window, clients);
      const result = await db.rpc('publish_search_snapshot', { payload: { ...base, ...data } });
      if (result.error) throw Object.assign(new Error('Supabase snapshot publication failed'), { category: 'storage_error' });
      // A newer snapshot for this exact period already won — publish_search_snapshot
      // returns null rather than overwriting it. That's neither a failure nor a
      // fresh success; record it as its own outcome so collector logs stay honest.
      outcomes.push({ ...base, status: result.data ? (data.rows.length ? 'success' : 'zero_rows') : 'stale_skipped' });
    } catch (e) {
      const attempt = { ...base, status: 'failed', error_category: e.category || 'api_error' };
      // Store safe categories, never raw auth responses or tokens.
      let failureRecorded = false;
      try {
        const recorded = await db.from('search_collection_attempts').insert(attempt);
        failureRecorded = !recorded.error;
      } catch (_) { /* A storage outage must not prevent the other source's collection. */ }
      console.error(`Search ingestion ${source} ${window.startDate}: ${attempt.error_category}`);
      outcomes.push({ ...attempt, failureRecorded });
    }
  }
  return outcomes;
}
async function latestSource(db, source) {
  // Never read "the latest snapshot across every property" — a dashboard for one
  // property must not silently surface another property's analytics because this
  // runtime's env var happens to be unset. Fail closed instead.
  const property = process.env[source === 'gsc' ? 'GSC_SITE_URL' : 'GA4_PROPERTY_ID'];
  if (!property) return { available: false, state: 'property_not_configured' };
  try {
    const scoped = table => db.from(table).select('*').eq('source', source).eq('property', property);
    const latestAttempt = await scoped('search_collection_attempts').order('collected_at', { ascending: false }).order('period_end', { ascending: false }).limit(1);
    if (latestAttempt.error) throw latestAttempt.error;
    const latest = await scoped('search_snapshots').order('period_end', { ascending: false }).limit(1);
    if (latest.error) throw latest.error;
    const snapshot = latest.data[0];
    if (!snapshot) return { available: false, state: latestAttempt.data[0]?.status === 'failed' ? 'failed' : 'not_collected', attempt: latestAttempt.data[0] || null };
    const table = source === 'gsc' ? 'search_console_queries' : 'ga4_landing_pages';
    const rows = await db.from(table).select('*').eq('snapshot_id', snapshot.id).order(source === 'gsc' ? 'impressions' : 'organic_sessions', { ascending: false }).limit(20);
    if (rows.error) throw rows.error;
    return { available: true, snapshot, rows: rows.data, attempt: latestAttempt.data[0] || null, state: latestAttempt.data[0]?.status === 'failed' ? 'failed' : 'success' };
  } catch (_) { return { available: false, state: 'storage_error' }; }
}
async function latestSnapshots(db) {
  try { if (db === undefined) db = getServiceClient(); }
  catch (_) { db = null; }
  if (!db) return { searchConsole: { available: false, state: 'storage_error' }, ga4: { available: false, state: 'storage_error' } };
  const [searchConsole, ga4] = await Promise.all([latestSource(db, 'gsc'), latestSource(db, 'ga4')]);
  return { searchConsole, ga4 };
}
module.exports = { periods, normalizeGsc, normalizeGa4, failure, collectSource, collect, latestSource, latestSnapshots, EVENTS };
