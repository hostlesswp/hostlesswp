// Child process (started with --experimental-wasm-jspi and ./register.mjs): runs the built Worker in Node against
// the site's real database, requests a few front-end pages, then packs the OPcache file cache PHP produced into
// zips next to the source bundles. Cold isolates mount these instead of compiling PHP, which is most of the
// cold-start CPU. Pages are only read, as by any visitor (WP-Cron is disabled).
// Input: path to a JSON file { outDir, db, salts, origin, pages }. Output: last stdout line is a JSON summary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const OUT = job.outDir;
globalThis.require = createRequire(path.join(OUT, 'src', 'index.js'));
const worker = (await import(pathToFileURL(path.join(OUT, 'src', 'index.js')).href)).default;
const manifestPath = path.join(OUT, 'src', 'site-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const env = {
  WP_SALTS: JSON.stringify(job.salts),
  // Large enough that nothing is evicted while collecting; the deployed Worker uses its normal size.
  OPCACHE_MB: '1024',
  // Keep this one PHP instance even though its memory is far above what a Worker allows.
  REBOOT_HEAP_MB: '0',
  // Collecting the file cache is the point here.
  OPCACHE_WRITE: '1',
  HYPERDRIVE: { host: job.db.host, port: job.db.port, socketPath: job.db.socketPath || undefined, user: job.db.user, password: job.db.password, database: job.db.name },
  ASSETS: {
    async fetch(req) {
      const p = path.join(OUT, 'public', decodeURIComponent(new URL(req.url).pathname));
      return fs.existsSync(p) ? new Response(fs.readFileSync(p)) : new Response('not found', { status: 404 });
    },
  },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const results = [];
for (const p of job.pages) {
  try {
    const res = await worker.fetch(new Request(job.origin + p, { redirect: 'manual', headers: { 'user-agent': 'hostlesswp-precompile' } }), env, ctx);
    await res.arrayBuffer();
    results.push({ path: p, status: res.status });
  } catch (e) {
    results.push({ path: p, error: String(e && e.message ? e.message : e).slice(0, 300) });
  }
}

const state = await globalThis.__hostlesswpBooted();
const priv = Object.getOwnPropertySymbols(state.php).find((s) => String(s).includes('private'));
const FS = state.php[priv].FS;
const groups = {};
const walk = (dir, rel) => {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = dir + '/' + name;
    const rp = rel ? rel + '/' + name : name;
    if (FS.isDir(FS.stat(full).mode)) walk(full, rp);
    else {
      // <system id>/wordpress/<path>.bin
      const m = rp.match(/^[0-9a-f]+\/wordpress\/wp-content\/plugins\/([^/]+)\//);
      const g = m && manifest.plugins.includes(m[1]) ? 'plugin-' + m[1] : /^[0-9a-f]+\/wordpress\//.test(rp) ? 'core' : null;
      if (g) (groups[g] ||= {})[rp] = FS.readFile(full);
    }
  }
};
try {
  walk('/internal/shared/opcache', '');
} catch {}

// Parts stay well under the 25 MiB static asset limit.
const PART_BYTES = 20 * 1024 * 1024;
let scripts = 0;
for (const b of manifest.bundles) {
  const files = groups[b.name];
  b.opcache = [];
  if (!files) continue;
  const parts = [{}];
  let size = 0;
  for (const [rp, buf] of Object.entries(files).sort(([a], [c]) => a.localeCompare(c))) {
    if (size + buf.length > PART_BYTES && Object.keys(parts[parts.length - 1]).length) {
      parts.push({});
      size = 0;
    }
    parts[parts.length - 1][rp] = [buf, { level: 9 }];
    size += buf.length;
    scripts++;
  }
  parts.forEach((part, i) => {
    const zip = zipSync(part, { mtime: new Date('2000-01-01T00:00:00Z') });
    const name = `/__hostlesswp/opcache-${b.name}-${i}-${crypto.createHash('sha256').update(zip).digest('hex').slice(0, 12)}.zip`;
    fs.writeFileSync(path.join(OUT, 'public', name), zip);
    b.opcache.push(name);
  });
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log(JSON.stringify({ pages: results, scripts }));
process.exit(0);
