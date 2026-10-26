const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { periods, normalizeGsc, normalizeGa4, failure, collect, collectSource, latestSnapshots } = require('../agent/lib/search-snapshots');
const metrics = ['totalUsers', 'sessions', 'engagedSessions', 'engagementRate', 'keyEvents'];
const gaReport = { metricHeaders: metrics.map(name => ({ name })), rows: [{ dimensionValues: [{ value: '/book/' }], metricValues: ['12','20','10','.5','2'].map(value => ({ value })) }] };
function database() {
  const tables = { search_snapshots: [], search_console_queries: [], ga4_landing_pages: [], search_collection_attempts: [] };
  return { tables, rpc: async (_, { payload: p }) => {
    let row = tables.search_snapshots.find(s => s.source === p.source && s.property === p.property && s.period_start === p.period_start && s.period_end === p.period_end);
    // Mirror the real publish_search_snapshot's guard: an older collected_at
    // can never overwrite an already-published, newer collection of the same
    // exact period — the function returns null rather than stomping it.
    if (row && row.collected_at > p.collected_at) return { data: null };
    if (!row) { row = { id: String(tables.search_snapshots.length + 1) }; tables.search_snapshots.push(row); }
    Object.assign(row, p);
    const table = p.source === 'gsc' ? 'search_console_queries' : 'ga4_landing_pages';
    tables[table] = tables[table].filter(r => r.snapshot_id !== row.id).concat(p.rows.map(r => ({ ...r, snapshot_id: row.id })));
    tables.search_collection_attempts.push({ ...p, status: p.rows.length ? 'success' : 'zero_rows' });
    return { data: row.id };
  }, from(table) {
    let rows = tables[table].slice(); const orders = [];
    const q = { select() { return q; }, eq(k,v) { rows = rows.filter(r => r[k] === v); return q; }, order(k,o) { orders.push([k,o]); return q; }, limit(n) { rows.sort((a,b) => { for (const [k,o] of orders) { if (a[k] !== b[k]) return (a[k] < b[k] ? -1 : 1) * (o.ascending ? 1 : -1); } return 0; }); return Promise.resolve({ data: rows.slice(0,n) }); }, insert(r) { tables[table].push(r); return Promise.resolve({}); } }; return q;
  } };
}
async function main() {
  const ranges = periods(new Date('2026-10-22T02:00:00Z'));
  assert.deepEqual(ranges[0], { startDate: '2026-09-21', endDate: '2026-10-18' });
  assert.equal((Date.parse(ranges[0].endDate)-Date.parse(ranges[0].startDate))/86400000,27);
  assert.deepEqual(normalizeGsc([{ keys: ['junk','https://example.test/'], clicks: 1, impressions: 10, ctr: .1, position: 5 }])[0].query,'junk');
  assert.throws(() => normalizeGsc([{ keys: ['bad'] }]));
  assert.equal(normalizeGa4(gaReport)[0].engagement_rate,.5);
  assert.throws(() => normalizeGa4({ ...gaReport, metricHeaders: [] }));
  for (const [result,category] of [[{ skipped:true, status:401 },'authentication_failure'],[{ skipped:true,status:403 },'property_configuration'],[{ skipped:true,reason:'credentials not configured' },'missing_credentials'],[{ skipped:true,status:500 },'api_error']]) assert.throws(() => failure(result),e => e.category === category);
  process.env.GSC_SITE_URL='sc-domain:example.test'; process.env.GA4_PROPERTY_ID='123';
  const clients = { gsc: { querySearchAnalytics: async args => ({ rows: args.dimensions.length ? [{ keys:['junk','/'],clicks:1,impressions:10,ctr:.1,position:5 }] : [{ clicks:4,impressions:30,ctr:4/30,position:6 }] }) }, ga4: { runReport: async args => args.metrics[0] === 'eventCount' ? { rows: [] } : gaReport } };
  const collected = await collectSource('gsc',ranges[0],clients); assert.equal(collected.totals.clicks,4); assert.equal(collected.rows[0].clicks,1);
  const ga = await collectSource('ga4',ranges[0],clients); assert.equal(ga.metadata.conversionMapping,'unresolved'); assert.equal(ga.totals.organic_users,12);
  const offsets = [];
  const paginated = { ...clients, ga4: { runReport: async args => {
    if (args.metrics[0] === 'eventCount') throw new Error('event report unavailable');
    if (!args.dimensions.length) return gaReport;
    offsets.push(args.offset);
    return { ...gaReport, rowCount: 25001, rows: args.offset ? gaReport.rows : Array(25000).fill(gaReport.rows[0]) };
  } } };
  const pages = await collectSource('ga4', ranges[0], paginated);
  assert.deepEqual(offsets, [0, 25000]); assert.equal(pages.rows.length, 25001);
  assert.equal(pages.metadata.eventStatus, 'collection_failed', 'optional event failure must preserve core metrics');
  await assert.rejects(() => collectSource('ga4', ranges[0], { ...clients, ga4: { runReport: async () => ({ ...gaReport, rowCount: 2 }) } }), /incomplete/);
  const starts = [];
  const gscPages = await collectSource('gsc', ranges[0], { ...clients, gsc: { querySearchAnalytics: async args => {
    if (!args.dimensions.length) return clients.gsc.querySearchAnalytics(args);
    starts.push(args.startRow);
    const first = await clients.gsc.querySearchAnalytics(args);
    return { rows: args.startRow ? first.rows : Array(25000).fill(first.rows[0]) };
  } } });
  assert.deepEqual(starts, [0, 25000]); assert.equal(gscPages.rows.length, 25001);
  const db=database(); const now=new Date('2026-10-22T12:00:00Z');
  await collect({ db,now,clients }); await collect({ db,now,clients });
  assert.equal(db.tables.search_snapshots.length,4); assert.equal(db.tables.search_console_queries.length,2);
  const bad = { ...clients, ga4: { runReport: async () => ({ skipped:true,status:401 }) } };
  await collect({ db,now:new Date('2026-10-23T12:00:00Z'),clients:bad });
  const latest=await latestSnapshots(db); assert.equal(latest.ga4.state,'failed'); assert.equal(latest.ga4.available,true); assert.equal(latest.searchConsole.state,'success');
  assert.equal(latest.ga4.snapshot.period_end,'2026-10-19');
  const zero = { gsc: { querySearchAnalytics: async () => ({ rows:[] }) }, ga4: { runReport:async () => ({ metricHeaders:metrics.map(name => ({name})),rows:[] }) } };
  const empty=database(); const outcomes=await collect({db:empty,now,clients:zero}); assert(outcomes.every(r=>r.status==='zero_rows')); assert.equal((await latestSnapshots(empty)).ga4.available,true);
  const noData=await latestSnapshots(database()); assert.equal(noData.ga4.state,'not_collected');

  // Property scoping — a dashboard must never read "the latest snapshot
  // across every property" just because its own property env var happens
  // to be unset. It must fail closed, source by source, independently.
  const savedSite = process.env.GSC_SITE_URL, savedProp = process.env.GA4_PROPERTY_ID;
  delete process.env.GSC_SITE_URL;
  const noGscSite = await latestSnapshots(db);
  assert.equal(noGscSite.searchConsole.state, 'property_not_configured');
  assert.equal(noGscSite.searchConsole.available, false);
  assert.equal(noGscSite.ga4.available, true, 'an unconfigured GSC property must not affect the independently-configured GA4 read');
  process.env.GSC_SITE_URL = savedSite;
  delete process.env.GA4_PROPERTY_ID;
  const noGa4Prop = await latestSnapshots(db);
  assert.equal(noGa4Prop.ga4.state, 'property_not_configured');
  assert.equal(noGa4Prop.ga4.available, false);
  assert.equal(noGa4Prop.searchConsole.available, true, 'an unconfigured GA4 property must not affect the independently-configured GSC read');
  process.env.GA4_PROPERTY_ID = savedProp;

  // Multiple stored properties — even when another, objectively more recent
  // property's data exists in the same tables, the dashboard must only ever
  // surface the one property this runtime is actually configured for.
  const multiProperty = database();
  await collect({ db: multiProperty, now, clients });
  process.env.GSC_SITE_URL = 'sc-domain:other-property.test';
  process.env.GA4_PROPERTY_ID = '999';
  await collect({ db: multiProperty, now: new Date('2026-10-23T12:00:00Z'), clients });
  process.env.GSC_SITE_URL = savedSite;
  process.env.GA4_PROPERTY_ID = savedProp;
  const scopedToConfigured = await latestSnapshots(multiProperty);
  assert.equal(scopedToConfigured.searchConsole.snapshot.property, savedSite);
  assert.equal(scopedToConfigured.ga4.snapshot.property, savedProp);
  assert.notEqual(scopedToConfigured.searchConsole.snapshot.property, 'sc-domain:other-property.test');
  assert.notEqual(scopedToConfigured.ga4.snapshot.property, '999');

  // Stale/no-op publication (a newer snapshot for this exact period already
  // won) must be its own outcome — never reported as 'success', and never
  // as 'failed' (it is not a collection failure).
  const staleDb = database();
  await collect({ db: staleDb, now: new Date('2026-10-22T20:00:00Z'), clients });
  const staleOutcomes = await collect({ db: staleDb, now: new Date('2026-10-22T12:00:00Z'), clients });
  assert(staleOutcomes.every(r => r.status === 'stale_skipped'), 'an older collected_at for an already-published period must be skipped, not treated as success or failure');
  assert.equal(staleDb.tables.search_snapshots.length, 4, 'a stale publish must not create duplicate rows or corrupt the existing ones');

  const brokenStorage = { rpc: async () => { throw new Error('offline'); }, from: () => ({ insert: async () => { throw new Error('offline'); } }) };
  const storageFailures = await collect({ db: brokenStorage, now, clients });
  assert.equal(storageFailures.length, 4, 'attempt logging failure must not abort independent collections');
  assert(storageFailures.every(r => r.status === 'failed' && !r.failureRecorded));
  const savedUrl = process.env.SUPABASE_URL, savedKey = process.env.SUPABASE_SECRET_KEY;
  try {
    process.env.SUPABASE_URL = 'invalid-url'; process.env.SUPABASE_SECRET_KEY = 'test';
    assert.equal((await latestSnapshots()).ga4.state, 'storage_error');
  } finally {
    if (savedUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = savedKey;
  }
  const sql=fs.readFileSync('sql/2026-10-22_search-intelligence-snapshots.sql','utf8'); assert(sql.includes('UNIQUE(source,property,period_start,period_end)')); assert(sql.includes('ON CONFLICT(source,property,period_start,period_end) DO UPDATE')); assert(sql.includes('REVOKE ALL ON FUNCTION'));
  // Execute the actual UI renderer with a minimal DOM. No source-string assertions for rendering behavior.
  const script=fs.readFileSync('admin/website-agent.js','utf8');
  const start=script.indexOf('  function renderSnapshot('),end=script.indexOf('  function buildActivityRow(');
  function el(tag,cls,text) { return {tag,cls,text:text==null?'':String(text),children:[],appendChild(n){this.children.push(n);} }; }
  const context={ el,Date,Number,String }; vm.createContext(context); vm.runInContext(script.slice(start,end)+';this.render=renderSnapshot;',context);
  const text=n=>n.text+' '+n.children.map(text).join(' ');
  const panel=el('div'); context.render(panel,latest.searchConsole,false); assert(text(panel).includes('Ranking landing page')); assert(text(panel).includes('4 clicks')); assert(text(panel).includes('junk'));
  const failedPanel=el('div');context.render(failedPanel,latest.ga4,true);assert(text(failedPanel).includes('Latest collection failed'));assert(text(failedPanel).includes('12 organic users'));assert(text(failedPanel).includes('Conversion mapping unresolved'));
  const emptyPanel=el('div');context.render(emptyPanel,{available:false,state:'failed',attempt:{error_category:'authentication_failure'}},true);assert(!text(emptyPanel).includes('zero rows'));assert(text(emptyPanel).includes('authentication_failure'));
  const noGscPanel=el('div');context.render(noGscPanel,{available:false,state:'property_not_configured'},false);assert(text(noGscPanel).includes('GSC_SITE_URL'));
  const noGa4Panel=el('div');context.render(noGa4Panel,{available:false,state:'property_not_configured'},true);assert(text(noGa4Panel).includes('GA4_PROPERTY_ID'));
  console.log('PASS: normalization, periods, totals, idempotent storage contract, failure vs zero, latest success, partial failure, property scoping, stale publication, actual DOM rendering and SQL guards');
}
main().catch(e=>{ console.error(e);process.exitCode=1; });
