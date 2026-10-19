// hostlesswp runtime: WordPress on php-wasm inside a Cloudflare Worker; wpdb queries go to MySQL through Hyperdrive.
// Generated sites import this file unchanged; everything site-specific comes from env and site-manifest.json.
import { loadPHPRuntime, PHP, PHPRequestHandler, setPhpIniEntries, __private__dont__use } from '@php-wasm/universal';
import * as phpLoader from './vendor/php.js';
import phpWasm from './vendor/php.wasm';
import { mountLazyZip } from './lazyfs.js';
import { createConnection } from 'mysql2/promise';
import manifest from './site-manifest.json';
import { serveUpload, flushUploads, mediaBridge, s3FromEnv, UPLOADS_URL } from './media.js';
import { servePage, warmPage, bumpVersion, NOCACHE_HEADER } from './page-cache.js';

const DOCROOT = '/wordpress';
// A request cancelled mid-flight can leave PHP suspended on a promise that never settles; after this long the
// runtime is considered wedged and replaced.
const WEDGE_MS = 60000;
// PHP's memory grows in 20% steps (104, 124, 149 MB); requests at 124 MB work, growth to 149 MB fails on Workers.
// REBOOT_HEAP_MB=0 turns the reboot off (precompile runs with a large OPcache on purpose).
const REBOOT_HEAP_MB = 130;

let booted = null; // Promise<{ php, handler }>
let current = null; // per-request context used by the DB bridge
let queue = Promise.resolve(); // one PHP request at a time per isolate
let serverInfo = null;
let inflightSince = 0;
// Diagnostics: which isolate served a request and how many it served since PHP booted.
const isolateId = Math.random().toString(36).slice(2, 8);
let served = 0;

async function boot(env, origin) {
  const t0 = Date.now();
  const timing = {};
  // All bundles are fetched at once, while PHP starts; one after another they added up to seconds per cold start.
  const fetchAsset = async (p) => {
    const res = await env.ASSETS.fetch(new Request(origin + p));
    if (!res.ok) throw new Error('bundle fetch failed: ' + p + ' ' + res.status);
    return new Uint8Array(await res.arrayBuffer());
  };
  const bundleFetches = [...manifest.bundles.map((b) => b.zip), ...manifest.bundles.flatMap((b) => b.opcache || [])].map(fetchAsset);
  // A failed fetch is reported by Promise.all below; keep the others from surfacing as unhandled rejections.
  for (const f of bundleFetches) f.catch(() => {});
  // PHP reads settings and secrets from a JSON file in MEMFS (hostlesswp_env() in wp-config.php).
  const phpEnv = { WP_SALTS: env.WP_SALTS || '', WP_DEBUG: env.WP_DEBUG || '0', USE_ZEND_ALLOC: '0', S3_PUBLIC_URL: env.S3_PUBLIC_URL || '', S3_PREFIX: env.S3_PREFIX || '' };
  const runtimeId = await loadPHPRuntime(phpLoader, {
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(phpWasm, imports).then((inst) => done(inst, phpWasm));
      return {};
    },
    ENV: phpEnv,
  });
  const php = new PHP(runtimeId);
  const FS = php[__private__dont__use].FS;
  timing.php = Date.now() - t0;
  // Source bundles (core, theme, mu-plugins, one per plugin), then their precompiled OPcache file caches.
  const zips = await Promise.all(bundleFetches);
  timing.fetch = Date.now() - t0;
  let i = 0;
  for (const b of manifest.bundles) mountLazyZip(FS, DOCROOT, zips[i++]);
  // Read-only: scripts compiled at runtime (those precompile did not reach) stay in shared memory only. Otherwise
  // OPcache also writes them to its file cache, MEMFS in this isolate: 17 MB on a block editor page, enough to put a
  // Durable Object over its memory limit, and kept for an isolate that rarely serves another request.
  const readOnly = env.OPCACHE_WRITE !== '1';
  for (const b of manifest.bundles) {
    for (const z of b.opcache || []) mountLazyZip(FS, '/internal/shared/opcache', zips[i++], { retain: false, readOnly });
  }
  php.writeFile('/internal/shared/hostlesswp-env.json', JSON.stringify(phpEnv));
  php.mkdir(DOCROOT + '/wp-content/uploads');
  php.mkdir('/tmp');
  await setPhpIniEntries(php, {
    memory_limit: env.PHP_MEMORY_LIMIT || '256M',
    // PHP's defaults (2M) would cap WordPress uploads; the body still has to fit the Worker request limit.
    upload_max_filesize: (Number(env.S3_MAX_UPLOAD_MB) || 32) + 'M',
    post_max_size: (Number(env.S3_MAX_UPLOAD_MB) || 32) + 8 + 'M',
    max_execution_time: '0',
    // php-wasm cannot spawn processes: a call errors inside the runtime and leaves the request hanging, which
    // blocks the isolate's queue (Site Health > Info runs exec('gs --version')). Disabled, callers that check
    // function_exists() skip them.
    disable_functions: 'exec,shell_exec,system,passthru,popen,proc_open,pcntl_exec',
    display_errors: '0',
    error_reporting: 'E_ALL',
    'opcache.enable': '1',
    'opcache.enable_cli': '1',
    // Shared memory is allocated inside the wasm heap. Above ~64MB the platform recycled the isolate after nearly
    // every request; 40MB fits core, 56MB fits WooCommerce-sized sites.
    'opcache.memory_consumption': env.OPCACHE_MB || (manifest.plugins.length ? '56' : '40'),
    'opcache.interned_strings_buffer': '8',
    'opcache.max_accelerated_files': '20000',
    'opcache.validate_timestamps': '0',
    'opcache.file_cache_only': '0',
    'opcache.save_comments': '1',
    // MEMFS mtimes equal boot time; the default 2s guard would skip caching right after a cold start.
    'opcache.file_update_protection': '0',
  });
  php.onMessage(async (data) => bridge(JSON.parse(data)));
  const handler = new PHPRequestHandler({
    php,
    documentRoot: DOCROOT,
    absoluteUrl: origin,
    cookieStore: false,
    getFileNotFoundAction: () => ({ type: 'internal-redirect', uri: '/index.php' }),
  });
  timing.boot = Date.now() - t0;
  return { php, handler, FS, fetched: new Map(), timing };
}

async function getConn(slot = 'conn') {
  if (!current[slot]) {
    const h = current.env.HYPERDRIVE;
    current[slot] = await createConnection({
      host: h.host,
      user: h.user,
      password: h.password,
      database: h.database,
      port: h.port,
      // Only set when hostlesswp precompiles the site locally against a database on a Unix socket.
      ...(h.socketPath ? { socketPath: h.socketPath } : {}),
      disableEval: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      // mysqli (no mysqlnd int conversion) hands WordPress strings; mirror that.
      typeCast: (field) => field.string(),
    });
  }
  return current[slot];
}

// Hyperdrive may run consecutive statements of one client connection on different server connections:
// session SETs outside a transaction are lost and SELECT @@var returns no rows. These shims restore the
// semantics wpdb relies on.
const RE_SET = /^\s*SET\s+(SESSION\s+|NAMES\s+|@@SESSION\.|sql_mode|CHARACTER\s+SET\s+)/i;
const RE_WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME)\s/i;
const RE_SYSVAR_SELECT = /^\s*SELECT\s+((?:@@(?:SESSION\.|GLOBAL\.|LOCAL\.)?\w+(?:\s+AS\s+\w+)?\s*,?\s*)+)\s*;?\s*$/i;
const RE_FOUND_ROWS = /^\s*SELECT\s+FOUND_ROWS\(\)\s*(AS\s+\w+)?\s*;?\s*$/i;
const RE_TRAILING_LIMIT = /\sLIMIT\s+\d+(\s*,\s*\d+)?(\s+OFFSET\s+\d+)?\s*;?\s*$/i;
const RE_HINTABLE = /^(\s*)(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i;

async function inTx(conn, sqls) {
  await conn.query('START TRANSACTION');
  try {
    const out = [];
    for (const s of sqls) out.push(await conn.query(s));
    await conn.query('COMMIT');
    return out;
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

// sql_mode travels with each statement as an optimizer hint, so it survives connection switching.
function addSqlModeHint(sql, mode) {
  if (sql.includes('/*+')) return null;
  const m = sql.match(RE_HINTABLE);
  if (!m) return null;
  return sql.slice(0, m[0].length) + ` /*+ SET_VAR(sql_mode='${mode.replace(/[^A-Z_,]/gi, '')}') */` + sql.slice(m[0].length);
}

function splitFoundRows(sql) {
  if (!RE_TRAILING_LIMIT.test(sql) || /\bUNION\b|\bFOR\s+UPDATE\b|\bINTO\b/i.test(sql)) return null;
  const page = sql.replace(/SQL_CALC_FOUND_ROWS\s*/i, '');
  const count = 'SELECT COUNT(*) AS n FROM (' + page.replace(RE_TRAILING_LIMIT, '') + ') AS hostlesswp_found';
  return { page, count };
}

async function runCompat(conn, sql) {
  const c = current;
  if (RE_SET.test(sql)) {
    const m = sql.match(/sql_mode\s*=\s*'([^']*)'/i);
    if (m) c.sqlMode = m[1];
    // Hyperdrive connections already run utf8mb4; only foreign charsets need replaying.
    else if (!/^\s*SET\s+NAMES\s+'?utf8mb4'?(\s+COLLATE\s+'?utf8mb4_\w+'?)?\s*$/i.test(sql)) c.prelude.push(sql);
    return [{ affectedRows: 0, insertId: 0 }, []];
  }
  const sysvar = sql.match(RE_SYSVAR_SELECT);
  if (sysvar) {
    const row = {};
    const fields = [];
    for (const part of sysvar[1].split(',').map((p) => p.trim()).filter(Boolean)) {
      const [, scope, name, alias] = part.match(/@@(SESSION\.|GLOBAL\.|LOCAL\.)?(\w+)(?:\s+AS\s+(\w+))?/i);
      const key = alias || part.replace(/\s+AS\s+\w+$/i, '');
      let val = null;
      if (name.toLowerCase() === 'sql_mode' && c.sqlMode !== null && !/GLOBAL/i.test(scope || '')) val = c.sqlMode;
      else {
        const [rows] = await conn.query(`SHOW ${/GLOBAL/i.test(scope || '') ? 'GLOBAL' : 'SESSION'} VARIABLES LIKE ?`, [name]);
        val = rows[0] ? rows[0].Value : null;
      }
      row[key] = val;
      fields.push({ name: key });
    }
    return [[row], fields];
  }
  if (RE_FOUND_ROWS.test(sql) && c.foundRows !== null) return [[{ 'FOUND_ROWS()': String(c.foundRows) }], [{ name: 'FOUND_ROWS()' }]];
  const setup = [...c.prelude];
  if (c.sqlMode !== null) setup.push(`SET SESSION sql_mode='${c.sqlMode.replace(/'/g, '')}'`);
  if (/SQL_CALC_FOUND_ROWS/i.test(sql)) {
    // One round trip instead of five: the page query and a COUNT over the same query without its trailing
    // LIMIT run on two connections at once (same value as FOUND_ROWS()); anything unusual uses a transaction.
    const split = c.sqlMode !== null && c.prelude.length === 0 ? splitFoundRows(sql) : null;
    if (split) {
      try {
        const conn2 = await getConn('conn2');
        const [page, count] = await Promise.all([
          conn.query(addSqlModeHint(split.page, c.sqlMode) || split.page),
          conn2.query(addSqlModeHint(split.count, c.sqlMode) || split.count),
        ]);
        c.foundRows = Number(count[0][0].n);
        return page;
      } catch {}
    }
    const res = await inTx(conn, [...setup, sql, 'SELECT FOUND_ROWS() AS n']);
    c.foundRows = Number(res[res.length - 1][0][0].n);
    return res[res.length - 2];
  }
  const hinted = c.sqlMode !== null && c.prelude.length === 0 ? addSqlModeHint(sql, c.sqlMode) : null;
  if (hinted) return conn.query(hinted);
  if (setup.length && RE_WRITE.test(sql)) {
    const res = await inTx(conn, [...setup, sql]);
    return res[res.length - 1];
  }
  return conn.query(sql);
}

async function httpBridge(msg) {
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(msg.headers || {})) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    const method = (msg.method || 'GET').toUpperCase();
    const body = msg.body && !['GET', 'HEAD'].includes(method) ? Uint8Array.from(atob(msg.body), (c) => c.charCodeAt(0)) : undefined;
    const res = await fetch(msg.url, {
      method,
      headers,
      body,
      redirect: msg.follow ? 'follow' : 'manual',
      signal: AbortSignal.timeout(Math.min(30, Math.max(1, msg.timeout || 5)) * 1000),
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    const outHeaders = {};
    res.headers.forEach((v, k) => (outHeaders[k] = v));
    return JSON.stringify({ status: res.status, headers: outHeaders, body: btoa(bin) });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
}

async function bridge(msg) {
  if (msg.op === 'http') return httpBridge(msg);
  // Size of PHP's linear memory, for code that trades memory for fewer requests (admin REST preloading).
  if (msg.op === 'heap') return JSON.stringify({ mb: Math.round(current.php[__private__dont__use].HEAPU8.buffer.byteLength / 1048576) });
  if (msg.op === 'cache-bump') {
    await bumpVersion(current.env);
    return '{}';
  }
  if (msg.op === 'nocache') {
    current.noCache = true;
    return '{}';
  }
  if (msg.op === 's3list' || msg.op === 's3get' || msg.op === 's3delete') return mediaBridge(msg, { FS: current.FS, s3: s3FromEnv(current.env), fetched: current.fetched });
  try {
    const conn = await getConn();
    if (msg.op === 'connect') {
      if (!serverInfo) {
        const [rows] = await conn.query('SELECT VERSION() AS v');
        serverInfo = rows[0].v;
      }
      return JSON.stringify({ server_info: serverInfo });
    }
    const t = Date.now();
    const [result, fields] = await runCompat(conn, msg.sql);
    current.stats.queries++;
    current.stats.dbMs += Date.now() - t;
    if (Array.isArray(result)) {
      return JSON.stringify({
        rows: result,
        fields: (fields || []).map((f) => ({ name: f.name, table: f.table, orgname: f.orgName, type: f.columnType, flags: f.flags, max_length: f.columnLength })),
      });
    }
    return JSON.stringify({ affected: result.affectedRows, insert_id: result.insertId });
  } catch (e) {
    if (current.env.WP_DEBUG === '1') console.log('sql error', e.errno, e.message, msg.sql?.slice(0, 300));
    return JSON.stringify({ error: e.message || String(e), errno: e.errno || 2006 });
  }
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const cold = !booted;
  if (!booted) {
    booted = boot(env, url.origin).catch((e) => {
      booted = null;
      throw e;
    });
  }
  const state = await booted;
  if (cold) served = 0;
  served++;
  current = { env, php: state.php, FS: state.FS, fetched: state.fetched, conn: null, conn2: null, noCache: false, sqlMode: null, prelude: [], foundRows: null, stats: { queries: 0, dbMs: 0 } };
  const t0 = Date.now();
  const headers = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  headers['x-forwarded-proto'] = url.protocol.replace(':', '');
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer());
  let res;
  // Files PHP wrote under uploads must reach the bucket before the response says they exist, even if the request threw.
  let mediaError = null;
  try {
    res = await state.handler.request({ method: request.method, url: url.pathname + url.search, headers, body });
  } catch (e) {
    // PHP errors come back as responses; a throw means the runtime itself broke (a failed memory growth), so the
    // next request starts a fresh PHP.
    if (booted) booted = null;
    throw e;
  } finally {
    for (const slot of ['conn', 'conn2']) if (current[slot]) ctx.waitUntil(current[slot].end().catch(() => {}));
    try {
      await flushUploads(state.FS, s3FromEnv(env), state.fetched);
    } catch (e) {
      mediaError = e;
      console.log('media storage write failed', url.pathname, String(e && e.message ? e.message : e));
    }
  }
  const { stats, noCache } = current;
  current = null;
  try {
    if (state.php.fileExists('/tmp/php-errors.log')) {
      const lines = state.php.readFileAsText('/tmp/php-errors.log').split('\n').filter(Boolean);
      state.php.unlink('/tmp/php-errors.log');
      if (lines.length) console.log('php errors', url.pathname, JSON.stringify(lines.slice(0, 40)));
    }
  } catch {}
  if (mediaError) {
    return new Response('The file could not be saved to media storage. Check `wrangler tail` for details.', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const out = new Headers();
  for (const [k, vals] of Object.entries(res.headers)) for (const v of vals) out.append(k, v);
  // Timing for `hostlesswp` diagnostics; harmless to expose (no data, only counts and milliseconds).
  const heap = state.php[__private__dont__use].HEAPU8;
  // PHP memory never shrinks. Once it has grown past the last size that is known to work, the next growth fails
  // ("Invalid array buffer length"), so the next request starts a fresh PHP instead.
  const rebootMb = env.REBOOT_HEAP_MB === undefined ? REBOOT_HEAP_MB : Number(env.REBOOT_HEAP_MB);
  if (rebootMb && heap && heap.buffer.byteLength > rebootMb * 1048576 && booted) {
    console.log('php heap too large; rebooting', JSON.stringify({ mb: Math.round(heap.buffer.byteLength / 1048576) }));
    booted = null;
  }
  if (noCache) out.set(NOCACHE_HEADER, '1');
  out.set('x-hostlesswp', JSON.stringify({ cold, phpMs: Date.now() - t0, queries: stats.queries, dbMs: stats.dbMs, isolate: isolateId, served, ...(cold ? { boot: state.timing } : {}), wasmMB: heap ? Math.round(heap.buffer.byteLength / 1048576) : 0 }));
  return new Response(request.method === 'HEAD' ? null : res.bytes, { status: res.httpStatusCode, headers: out });
}

function enqueue(request, env, ctx) {
  if (inflightSince && Date.now() - inflightSince > WEDGE_MS) {
    console.log('php runtime wedged; rebooting', JSON.stringify({ stuckMs: Date.now() - inflightSince }));
    booted = null;
    current = null;
    queue = Promise.resolve();
    inflightSince = 0;
  }
  const run = queue.then(() => {
    inflightSince = Date.now();
    return handle(request, env, ctx).finally(() => (inflightSince = 0));
  });
  queue = run.catch(() => {});
  // Keep PHP running even if the client disconnects, so the queue never stays blocked.
  ctx.waitUntil(queue);
  return run;
}

// Runs a PHP request here, or on the Free plan in a PhpRuntime Durable Object (see PHP_IN_DO in lib/cloudflare.mjs).
// A small pool of objects lets a few PHP requests run at once; each one boots its own PHP when it starts.
const DO_POOL = 2;
function render(request, env, ctx) {
  if (env.PHP_IN_DO !== '1' || !env.PHP) return enqueue(request, env, ctx);
  const name = 'php-' + Math.floor(Math.random() * DO_POOL);
  return env.PHP.get(env.PHP.idFromName(name), env.PHP_LOCATION ? { locationHint: env.PHP_LOCATION } : {}).fetch(request);
}

// A plain class rather than one extending cloudflare:workers' DurableObject, so Node (precompile) can import this file.
export class PhpRuntime {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  fetch(request) {
    // Durable Objects stay alive while work is pending; waitUntil only keeps the Worker-style signature.
    return enqueue(request, this.env, { waitUntil: (p) => this.state.waitUntil?.(p), passThroughOnException() {} });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__hostlesswp/health') {
      return Response.json({ ok: true, version: manifest.hostlesswp, wordpress: manifest.wordpress, plugins: manifest.plugins.length, booted: !!booted });
    }
    // Uploads are not static assets (they live in the bucket); serve them without starting PHP.
    if (url.pathname.startsWith(UPLOADS_URL)) {
      try {
        return await serveUpload(request, env, ctx);
      } catch (e) {
        console.log('media error', e && e.stack ? e.stack : String(e));
        return new Response('Media storage unavailable', { status: 502 });
      }
    }
    try {
      return await servePage(request, env, ctx, (req) => render(req, env, ctx), manifest.build || '');
    } catch (e) {
      console.log('runtime error', e && e.stack ? e.stack : String(e));
      return new Response('This site is temporarily unavailable (runtime error). Check `wrangler tail` for details.', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  },
  // WP-Cron is disabled inside requests (DISABLE_WP_CRON); a Cron Trigger runs due events instead.
  async scheduled(event, env, ctx) {
    // SITE_ORIGIN is set by hostlesswp right after the first deploy; without it WordPress would build wrong URLs.
    if (!env.SITE_ORIGIN) return console.log('wp-cron skipped: SITE_ORIGIN is not set yet');
    const origin = env.SITE_ORIGIN.replace(/\/$/, '');
    // No doing_wp_cron parameter: that mode only proceeds when it matches an existing lock; without it wp-cron.php
    // takes the lock itself, as for any external cron job.
    const res = await render(new Request(origin + '/wp-cron.php'), env, ctx);
    console.log('wp-cron', res.status);
    // Keep the front page in the page cache, so a visitor after a quiet hour does not wait for PHP to start.
    const warm = await warmPage(origin + '/', env, ctx, (req) => render(req, env, ctx), manifest.build || '').catch((e) => 'failed: ' + (e.message || e));
    if (warm !== 'fresh' && warm !== 'off') console.log('page cache warm', warm);
  },
};

// Build-time tooling (lib/precompile.mjs) runs this module in Node and reads the booted runtime through this.
globalThis.__hostlesswpBooted = () => booted;
