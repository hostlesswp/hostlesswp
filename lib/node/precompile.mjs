// Child process (started with --experimental-wasm-jspi and ./register.mjs): runs the built Worker in Node against
// the site's real database, requests a few front-end pages, compiles every other PHP file without running it, then
// packs the OPcache file cache PHP produced into zips next to the source bundles. Cold isolates mount these instead
// of compiling PHP, which is most of the cold-start CPU. Pages are only read, as by any visitor (WP-Cron is disabled).
// Input: path to a JSON file { outDir, db, salts, origin, pages }. Output: last stdout line is a JSON summary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { centralDirectoryOf, writeIndex } from '../build.mjs';

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
const FS = state.engine.FS;
const OPCACHE = '/internal/shared/opcache';
const DOCROOT = '/wordpress';

const listFiles = (dir, rel, out, skip = () => false) => {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = dir + '/' + name;
    const rp = rel ? rel + '/' + name : name;
    if (skip(rp)) continue;
    if (FS.isDir(FS.stat(full).mode)) listFiles(full, rp, out, skip);
    else out.push(rp);
  }
  return out;
};
const cacheFiles = () => {
  try {
    return listFiles(OPCACHE, '', []);
  } catch {
    return [];
  }
};

// Scripts the pages above loaded: every cold start needs these, so they are fetched with the source bundles.
const hot = new Set(cacheFiles());

// Then every other PHP file is compiled without running it (no database access), so code no page reached
// (payment callbacks, cron jobs, rarely used admin screens) is cached as well. Those caches are fetched only when
// PHP first asks for them (runtime/src/index.js, hostlesswpFetch). A batch that ends in a fatal error (a file
// declaring a function another file in the batch declared) is compiled again one file per request.
const sources = listFiles(DOCROOT, '', [], (rp) => rp === 'wp-content/uploads').filter((rp) => rp.endsWith('.php')).map((rp) => DOCROOT + '/' + rp);
const compile = async (files) => {
  FS.writeFile('/tmp/hostlesswp-compile.json', JSON.stringify(files));
  const res = await state.engine.run(`<?php
      $ok = 0;
      foreach (json_decode(file_get_contents('/tmp/hostlesswp-compile.json')) as $f) {
        try { if (@opcache_compile_file($f)) $ok++; } catch (Throwable $e) {}
      }
      echo $ok;`);
  if (res.exitStatus !== 0) throw new Error('compile batch failed');
  return Number(res.text) || 0;
};
let compiled = 0;
const BATCH = 200;
for (let i = 0; i < sources.length; i += BATCH) {
  const batch = sources.slice(i, i + BATCH);
  try {
    compiled += await compile(batch);
  } catch {
    for (const f of batch) compiled += await compile([f]).catch(() => 0);
  }
}

const groupOf = (rp) => {
  // <system id>/wordpress/<path>.bin (and .bin.body)
  const m = rp.match(/^[0-9a-f]+\/wordpress\/wp-content\/plugins\/([^/]+)\//);
  return m && manifest.plugins.includes(m[1]) ? 'plugin-' + m[1] : /^[0-9a-f]+\/wordpress\//.test(rp) ? 'core' : null;
};

// Packing. Each fetch at run time is a subrequest, and Workers limit those per request (50 on the Free plan), so
// files go to few zips:
// - hot scripts (.bin): parts of about HOT_PART_BYTES, fetched at every cold start. PHP reads a script once, when
//   it loads it into shared memory, so the Worker drops these zips after a request and fetches one again only if
//   PHP reads from it later;
// - their function bodies (.bin.body, read when a function is first called): zips fetched at cold start and kept;
// - cold scripts and their bodies together: parts of about COLD_PART_BYTES, fetched when PHP first reads one of
//   their files. Their central directories are appended to the index file (lib/build.mjs), from which the Worker
//   lists every file up front.
const HOT_PART_BYTES = 8 * 1024 * 1024;
const BODY_PART_BYTES = 20 * 1024 * 1024;
const COLD_PART_BYTES = 8 * 1024 * 1024;
const zipFile = (prefix, entries) => {
  const zip = zipSync(entries, { mtime: new Date('2000-01-01T00:00:00Z') });
  const name = `/__hostlesswp/${prefix}-${crypto.createHash('sha256').update(zip).digest('hex').slice(0, 12)}.zip`;
  fs.writeFileSync(path.join(OUT, 'public', name), zip);
  return { name, zip };
};
// Splits files (paths below OPCACHE) into lists of at most maxBytes, in path order.
const split = (files, maxBytes) => {
  const lists = [[]];
  let size = 0;
  for (const rp of files.sort()) {
    const len = FS.stat(OPCACHE + '/' + rp).size;
    if (size + len > maxBytes && lists[lists.length - 1].length) {
      lists.push([]);
      size = 0;
    }
    lists[lists.length - 1].push(rp);
    size += len;
  }
  return lists.filter((list) => list.length);
};
const entry = (rp) => [FS.readFile(OPCACHE + '/' + rp), { level: rp.endsWith('.body') ? 0 : 9 }];
const exists = (rp) => {
  try {
    FS.stat(OPCACHE + '/' + rp);
    return true;
  } catch {
    return false;
  }
};

const hotScripts = [];
const coldFiles = [];
for (const rp of cacheFiles()) {
  if (!groupOf(rp) || rp.endsWith('.body')) continue;
  if (hot.has(rp)) hotScripts.push(rp);
  else coldFiles.push(rp, ...(exists(rp + '.body') ? [rp + '.body'] : []));
}
const opcache = { hot: [], bodies: [], cold: [] };
for (const [n, list] of split(hotScripts, HOT_PART_BYTES).entries()) {
  opcache.hot.push(zipFile(`opcache-hot-${n}`, Object.fromEntries(list.map((rp) => [rp, entry(rp)]))).name);
}
const hotBodies = hotScripts.map((rp) => rp + '.body').filter(exists);
for (const [n, list] of split(hotBodies, BODY_PART_BYTES).entries()) {
  opcache.bodies.push(zipFile(`opcache-bodies-${n}`, Object.fromEntries(list.map((rp) => [rp, entry(rp)]))).name);
}
const indexPath = manifest.index && path.join(OUT, 'public', manifest.index);
const cds = indexPath ? [fs.readFileSync(indexPath)] : [];
let indexSize = cds.length ? cds[0].length : 0;
for (const [n, list] of split(coldFiles, COLD_PART_BYTES).entries()) {
  const { name, zip } = zipFile(`opcache-cold-${n}`, Object.fromEntries(list.map((rp) => [rp, entry(rp)])));
  const cd = centralDirectoryOf(zip);
  cds.push(cd);
  indexSize += cd.length;
  opcache.cold.push({ zip: name, cdAt: [indexSize - cd.length, cd.length] });
}
if (indexPath) fs.rmSync(indexPath);
manifest.index = writeIndex(path.join(OUT, 'public'), cds);
manifest.opcache = hotScripts.length || coldFiles.length ? opcache : undefined;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
const scripts = hotScripts.length + coldFiles.filter((rp) => rp.endsWith('.bin')).length;
console.log(JSON.stringify({ pages: results, scripts, compiled, sources: sources.length, hot: opcache.hot.length, bodies: opcache.bodies.length, cold: opcache.cold.length }));
process.exit(0);
