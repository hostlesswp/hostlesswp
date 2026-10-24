// hostlesswp runtime: WordPress on the HostlessWP engine (PHP 8.3 in WebAssembly) inside a Cloudflare Worker; wpdb
// queries go to MySQL through Hyperdrive.
// Generated sites import this file unchanged; everything site-specific comes from env and site-manifest.json.
import createCore from './vendor/core.mjs';
import coreWasm from './vendor/core.wasm';
import { loadEngine } from './vendor/engine.mjs';
import { createHandler } from './vendor/handler.mjs';
import { mountLazyZip, unloadLazyZip, nextEpoch, mountRemoteZip, fetchLazyNode } from './lazyfs.js';
import { createConnection } from 'mysql2/promise';
import manifest from './site-manifest.json';
import { serveUpload, flushUploads, mediaBridge, s3FromEnv, UPLOADS_URL } from './media.js';
import { servePage, warmPage, bumpVersion, NOCACHE_HEADER } from './page-cache.js';
import { mailBridge, parseSmtpUrl, smtpFromPhpMailer } from './mail.js';
import { fetchCached } from './http.js';
import { sessionBridge } from './session.js';

const DOCROOT = '/wordpress';
// A request cancelled mid-flight can leave PHP suspended on a promise that never settles; after this long the
// runtime is considered wedged and replaced.
const WEDGE_MS = 60000;
// PHP's memory grows in 20% steps (104, 124, 149 MB); requests at 124 MB work, growth to 149 MB fails on Workers.
// REBOOT_HEAP_MB=0 turns the reboot off (precompile runs with a large OPcache on purpose).
const REBOOT_HEAP_MB = 130;

let booted = null; // Promise<{ engine, handler, FS, ... }>
let current = null; // per-request context used by the DB bridge
let queue = Promise.resolve(); // one PHP request at a time per isolate
let serverInfo = null;
let inflightSince = 0;
// Diagnostics: which isolate served a request and how many it served since PHP booted.
const isolateId = Math.random().toString(36).slice(2, 8);
let served = 0;
// Static asset fetches (bundles) since the isolate started: each is a subrequest, which Workers limit per request.
let assetFetches = 0;

async function boot(env, origin) {
  const t0 = Date.now();
  const timing = {};
  // All bundles are fetched at once, while PHP starts; one after another they added up to seconds per cold start.
  const fetchAsset = async (p) => {
    assetFetches++;
    const res = await env.ASSETS.fetch(new Request(origin + p));
    if (!res.ok) throw new Error('bundle fetch failed: ' + p + ' ' + res.status);
    return new Uint8Array(await res.arrayBuffer());
  };
  // What a cold start fetches (lib/build.mjs, lib/node/precompile.mjs): the files PHP reads as data, the index of
  // the zips fetched later (their central directories), the compiled scripts of the pages precompile visited and
  // their function bodies. PHP sources and the other compiled scripts come in parts when PHP first reads one of
  // their files. Few zips: every fetch is a subrequest, and Workers limit those per request.
  // Without precompiled OPcache files every script compiles from source, so then all source parts come now.
  const opcache = manifest.opcache;
  const phpParts = manifest.bundles.flatMap((b) => b.php || []);
  const OPCACHE = '/internal/shared/opcache';
  const bundleFetches = [
    ...manifest.data,
    ...(manifest.index ? [manifest.index] : []),
    ...(opcache ? [...opcache.hot, ...opcache.bodies] : phpParts.map((part) => part.zip)),
  ].map(fetchAsset);
  const scriptZips = [];
  const dropScripts = () => {
    for (const src of scriptZips) if (!src.reread) unloadLazyZip(src);
    nextEpoch();
  };
  // PHP reads settings and secrets from a JSON file in MEMFS (hostlesswp_env() in wp-config.php), not from getenv().
  const phpEnv = { WP_SALTS: env.WP_SALTS || '', WP_DEBUG: env.WP_DEBUG || '0', S3_PUBLIC_URL: env.S3_PUBLIC_URL || '', S3_PREFIX: env.S3_PREFIX || '' };
  // Workers' TCP sockets, for PHP's own. Elsewhere (Node, while precompiling) PHP has none.
  let tcpConnect = null;
  try {
    tcpConnect = (await import('cloudflare:sockets')).connect;
  } catch {}
  const engine = await loadEngine(createCore, coreWasm, {
    // PHP's own allocator on top of the wasm one only costs memory here. curl and fileinfo come from
    // runtime/php/hostlesswp-curl.php and hostlesswp-fileinfo.php; the engine reports them as loaded extensions, as
    // plugins that check before using them expect (WPForms does not start without curl).
    env: { USE_ZEND_ALLOC: '0', HOSTLESSWP_PROVIDED_EXTENSIONS: 'curl,fileinfo' },
    connect: tcpConnect,
    onMessage: async (data) => bridge(JSON.parse(data)),
    // PHP is about to read a file: fetch its zip (PHP sources, OPcache parts) if it is not here.
    fetchNode: (node) => {
      const pending = fetchLazyNode(node);
      if (pending && current) current.stats[FS.getPath(node).startsWith(OPCACHE + '/') ? 'opcacheParts' : 'phpParts']++;
      return pending;
    },
  });
  const FS = engine.FS;
  FS.mkdirTree('/internal/shared');
  FS.mkdirTree('/tmp');
  timing.php = Date.now() - t0;
  const zips = await Promise.all(bundleFetches);
  timing.fetch = Date.now() - t0;
  let i = 0;
  for (const _ of manifest.data) mountLazyZip(FS, DOCROOT, zips[i++]);
  const index = manifest.index ? zips[i++] : null;
  const indexed = ([at, len]) => index.subarray(at, at + len);
  for (const part of phpParts) {
    if (opcache) mountRemoteZip(FS, DOCROOT, indexed(part.cdAt), () => fetchAsset(part.zip));
  }
  // Read-only: scripts compiled at runtime (those precompile did not reach) stay in shared memory only. Otherwise
  // OPcache also writes them to its file cache, MEMFS in this isolate: 17 MB on a block editor page, enough to put a
  // Durable Object over its memory limit, and kept for an isolate that rarely serves another request.
  const readOnly = env.OPCACHE_WRITE !== '1';
  if (opcache) {
    // Compiled scripts are read once (when PHP loads them into shared memory): their zips are dropped after each
    // request and fetched again only if PHP reads one of them later. A zip PHP reads from in two requests (scripts
    // that did not fit in shared memory) is kept from then on.
    for (const name of opcache.hot) scriptZips.push(mountLazyZip(FS, OPCACHE, zips[i++], { retain: false, readOnly, load: () => fetchAsset(name) }));
    for (const _ of opcache.bodies) mountLazyZip(FS, OPCACHE, zips[i++], { retain: false, readOnly });
    for (const part of opcache.cold) scriptZips.push(mountRemoteZip(FS, OPCACHE, indexed(part.cdAt), () => fetchAsset(part.zip), { retain: false, readOnly }));
  } else {
    for (const _ of phpParts) mountLazyZip(FS, DOCROOT, zips[i++]);
  }
  // The closures made in boot() keep its scope alive for the isolate's life: let go of the fetched zips here, or
  // the script zips dropped after a request (unloadLazyZip) would stay in memory through these arrays.
  zips.length = 0;
  bundleFetches.length = 0;
  FS.writeFile('/internal/shared/hostlesswp-env.json', JSON.stringify(phpEnv));
  FS.mkdirTree(DOCROOT + '/wp-content/uploads');
  FS.mkdirTree(OPCACHE);
  await engine.start({
    memory_limit: env.PHP_MEMORY_LIMIT || '256M',
    // PHP's defaults (2M) would cap WordPress uploads; the body still has to fit the Worker request limit.
    upload_max_filesize: (Number(env.S3_MAX_UPLOAD_MB) || 32) + 'M',
    post_max_size: (Number(env.S3_MAX_UPLOAD_MB) || 32) + 8 + 'M',
    max_execution_time: '0',
    // PHP cannot start processes here. Disabled, callers that check function_exists() skip them instead of
    // reporting failures (Site Health > Info runs exec('gs --version')).
    // The DNS functions are disabled so runtime/php/hostlesswp-dns.php can stand in for them (the built-in ones
    // answer every lookup with a placeholder), mail() so hostlesswp-mail.php can (it needs a sendmail process),
    // imageavif() so wp-config.php can (it writes empty files).
    disable_functions: 'exec,shell_exec,system,passthru,popen,proc_open,pcntl_exec,gethostbyname,gethostbynamel,gethostbyaddr,checkdnsrr,dns_check_record,getmxrr,dns_get_mx,dns_get_record,mail,imageavif',
    // TLS over PHP's sockets (ssl://, stream_socket_enable_crypto()) verifies peers against WordPress's CA bundle.
    'openssl.cafile': DOCROOT + '/wp-includes/certificates/ca-bundle.crt',
    // Unknown session ids are replaced, not adopted (session fixation). The id check is the same lookup as the read
    // (runtime/php/hostlesswp-session.php), so it costs no extra query.
    'session.use_strict_mode': '1',
    display_errors: '0',
    error_reporting: 'E_ALL',
    // Errors go to the Worker log (see handle()), each repeated one once per request.
    log_errors: '1',
    ignore_repeated_errors: '1',
    'opcache.enable': '1',
    'opcache.enable_cli': '1',
    // Shared memory is allocated inside the wasm heap, all of it up front. Function bodies stay out of it until
    // first called, so 40MB holds the scripts of a WooCommerce page; scripts that do not fit load into request memory.
    'opcache.memory_consumption': env.OPCACHE_MB || '40',
    'opcache.interned_strings_buffer': '8',
    'opcache.max_accelerated_files': '20000',
    'opcache.validate_timestamps': '0',
    'opcache.file_cache': OPCACHE,
    'opcache.file_cache_only': '0',
    'opcache.file_cache_consistency_checks': '1',
    'opcache.save_comments': manifest.docComments === false ? '0' : '1',
    // MEMFS mtimes equal boot time; the default 2s guard would skip caching right after a cold start.
    'opcache.file_update_protection': '0',
  });
  // Paths that are not files run WordPress's index.php (pretty permalinks).
  const handler = createHandler(engine, { documentRoot: DOCROOT, origin, fallback: '/index.php' });
  timing.boot = Date.now() - t0;
  return { engine, handler, FS, fetched: new Map(), timing, dropScripts };
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

// mail() (runtime/php/hostlesswp-mail.php) goes to the server an SMTP plugin chose for this message (smtp-next), or
// to the SMTP_URL secret.
const sendMail = mailBridge({
  getSmtp: () => {
    if (!current) return null;
    const plugin = current.smtpNext;
    current.smtpNext = null;
    if (plugin) return smtpFromPhpMailer(plugin);
    // "none": hostlesswp deploy was told not to send mail.
    return current.env.SMTP_URL && current.env.SMTP_URL !== 'none' ? parseSmtpUrl(current.env.SMTP_URL) : null;
  },
  helo: () => (current && current.env.SITE_ORIGIN ? new URL(current.env.SITE_ORIGIN).hostname : 'localhost'),
});

async function bridge(msg) {
  if (msg.op === 'http') return httpBridge(msg);
  if (msg.op === 'fetch') return JSON.stringify(await Promise.all(msg.requests.map((r) => fetchCached(r))));
  // A PHPMailer SMTP plugin's settings, for the message mail() is about to hand over (runtime/src/mail.js).
  if (msg.op === 'smtp-next') {
    current.smtpNext = msg;
    return '{}';
  }
  if (msg.op === 'mail') return sendMail(msg);
  // Size of PHP's linear memory, for code that trades memory for fewer requests (admin REST preloading).
  if (msg.op === 'heap') {
    // mb: the wasm memory; usedMb: how much of it PHP has taken (the allocator's break).
    const { size, used } = current.engine.memory();
    return JSON.stringify({ mb: Math.round(size / 1048576), usedMb: Math.round(used / 1048576) });
  }
  if (msg.op === 'cache-bump') {
    await bumpVersion(current.env);
    return '{}';
  }
  if (msg.op === 'nocache') {
    current.noCache = true;
    return '{}';
  }
  if (msg.op === 'session') {
    try {
      const conn = await getConn();
      return JSON.stringify(
        await sessionBridge(async (sql, params) => {
          current.stats.queries++;
          return (await conn.query(sql, params))[0];
        }, msg),
      );
    } catch (e) {
      return JSON.stringify({ error: e.message || String(e) });
    }
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
  const fetches0 = assetFetches;
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
  current = { env, engine: state.engine, FS: state.FS, fetched: state.fetched, conn: null, conn2: null, noCache: false, smtpNext: null, sqlMode: null, prelude: [], foundRows: null, stats: { queries: 0, dbMs: 0, opcacheParts: 0, phpParts: 0 } };
  const t0 = Date.now();
  const headers = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  headers['x-forwarded-proto'] = url.protocol.replace(':', '');
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer());
  let res;
  // Files PHP wrote under uploads must reach the bucket before the response says they exist, even if the request threw.
  let mediaError = null;
  try {
    res = await state.handler({ method: request.method, url: url.pathname + url.search, headers, body });
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
  if (res.log.length) console.log('php errors', url.pathname, JSON.stringify(res.log.slice(0, 40)));
  if (mediaError) {
    return new Response('The file could not be saved to media storage. Check `wrangler tail` for details.', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  // The scripts PHP loaded are in shared memory now; their file cache copies are not needed any more.
  state.dropScripts();
  const out = new Headers();
  for (const [k, vals] of Object.entries(res.headers)) for (const v of vals) out.append(k, v);
  // Timing for `hostlesswp` diagnostics; harmless to expose (no data, only counts and milliseconds).
  const heapBytes = state.engine.memory().size;
  // PHP memory never shrinks. Once it has grown past the last size that is known to work, the next growth fails
  // ("Invalid array buffer length"), so the next request starts a fresh PHP instead.
  const rebootMb = env.REBOOT_HEAP_MB === undefined ? REBOOT_HEAP_MB : Number(env.REBOOT_HEAP_MB);
  if (rebootMb && heapBytes > rebootMb * 1048576 && booted) {
    console.log('php heap too large; rebooting', JSON.stringify({ mb: Math.round(heapBytes / 1048576) }));
    booted = null;
  }
  if (noCache) out.set(NOCACHE_HEADER, '1');
  out.set('x-hostlesswp', JSON.stringify({ cold, phpMs: Date.now() - t0, queries: stats.queries, dbMs: stats.dbMs, isolate: isolateId, served, ...(cold ? { boot: state.timing } : {}), fetches: assetFetches - fetches0, ...(stats.opcacheParts ? { opcacheParts: stats.opcacheParts } : {}), ...(stats.phpParts ? { phpParts: stats.phpParts } : {}), wasmMB: Math.round(heapBytes / 1048576) }));
  return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, headers: out });
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
