const { collect } = require('../lib/search-snapshots');
collect().then(results => { console.log(JSON.stringify(results)); if (results.some(r => r.status === 'failed')) process.exitCode = 1; }).catch(() => { console.error('Snapshot collector could not start: verify Supabase configuration'); process.exitCode = 1; });
