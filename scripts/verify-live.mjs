import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Compare production bytes with this checkout, bypassing browser/CDN caches.
const origin = new URL(process.argv[2] || 'https://www.milehighjunkremoval.net');
if (origin.protocol !== 'https:' && origin.hostname !== 'localhost') {
  throw new Error('Use HTTPS for a remote verification target.');
}
const files = process.argv.slice(3);
if (!files.length) files.push('index.html', 'styles.css');
const hash = data => createHash('sha256').update(data).digest('hex');
let failed = false;
for (const file of files) {
  if (file.includes('..') || file.startsWith('/') || file.includes('\\')) {
    throw new Error(`Expected a repository-relative public file: ${file}`);
  }
  const local = await readFile(fileURLToPath(new URL(`../${file}`, import.meta.url)));
  const url = new URL(file === 'index.html' ? '/' : file, origin);
  url.searchParams.set('verify', `${Date.now()}`);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const remote = Buffer.from(await response.arrayBuffer());
    if (hash(local) !== hash(remote)) throw new Error('Live content differs from this checkout');
    console.log(`PASS ${file}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${file}: ${error.message}`);
  }
}
if (failed) process.exitCode = 1;
