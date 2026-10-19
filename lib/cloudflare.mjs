// Everything hostlesswp does on Cloudflare goes through wrangler, using the user's own wrangler login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrangler, plain, wranglerError } from './run.mjs';
import { locationHint } from './geo.mjs';

export class CloudflareError extends Error {}
// The account is on the Workers Free plan, which rejects a configured CPU limit (API code 100328).
export class FreePlanError extends CloudflareError {}

const PERMISSION_HELP = [
  'Your Cloudflare login is missing a permission hostlesswp needs.',
  'Easiest fix: run `npx wrangler login` (it requests all permissions), then run hostlesswp again.',
  'Using an API token (CLOUDFLARE_API_TOKEN)? Give it these Account permissions: Workers Scripts: Edit, Hyperdrive: Edit,',
  'Workers KV Storage: Edit,',
  'Cloudflare Tunnel: Edit and Connectivity Directory: Edit (tunnel mode only), and Account Settings: Read.',
].join('\n');

// Checks the permissions the setup needs before anything is created. Returns null when fine, or a message.
export async function checkPermissions(accountId, { tunnel = false } = {}) {
  const probes = [['hyperdrive', 'list'], ...(tunnel ? [['tunnel', 'list']] : [])];
  for (const args of probes) {
    const res = await wrangler(args, { env: acct(accountId) });
    const text = plain(res.stdout + '\n' + res.stderr);
    if (res.code !== 0 && /Authentication error|code: 10000|code: 9109|Unauthorized/i.test(text)) return `${PERMISSION_HELP}\n(failed: wrangler ${args.join(' ')})`;
  }
  return null;
}

const acct = (accountId) => (accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {});

export async function whoami() {
  const res = await wrangler(['whoami', '--json']);
  try {
    const j = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    return j.loggedIn ? j : null;
  } catch {
    return null;
  }
}

export async function login() {
  const res = await wrangler(['login'], { inherit: true });
  if (res.code !== 0) throw new CloudflareError('wrangler login did not complete.');
}

// Rows of a wrangler box table whose first cell is a 32-hex or UUID id: [{ id, cells }].
function tableRows(text) {
  const rows = [];
  for (const line of plain(text).split('\n')) {
    const cells = line.split('│').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
    if (cells.length && /^([0-9a-f]{32}|[0-9a-f-]{36})$/.test(cells[0])) rows.push({ id: cells[0], cells });
  }
  return rows;
}

export async function findHyperdrive(name, accountId) {
  const res = await wrangler(['hyperdrive', 'list'], { env: acct(accountId) });
  const row = tableRows(res.stdout).find((r) => r.cells[1] === name);
  return row ? row.id : null;
}

function createdId(res, what) {
  const text = plain(res.stdout + '\n' + res.stderr);
  const id = (text.match(/\b([0-9a-f]{32})\b/) || text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/) || [])[1];
  if (res.code !== 0 && /Authentication error|code: 10000/i.test(text)) throw new CloudflareError(`Could not create ${what}: permission denied.\n${PERMISSION_HELP}`);
  if (res.code !== 0 || !id) throw new CloudflareError(`Could not create ${what}:\n${wranglerError(res)}`);
  return id;
}

// Hyperdrive to a database reachable on the public internet (TLS required by Hyperdrive).
// Caching must stay off: WordPress reads its own writes, and cached reads break that.
export async function createHyperdrivePublic({ name, db, accountId }) {
  const args = ['hyperdrive', 'create', name, '--origin-scheme', 'mysql', '--origin-host', db.host, '--origin-port', String(db.port), '--database', db.name, '--origin-user', db.user, '--origin-password', db.password, '--caching-disabled'];
  return createdId(await wrangler(args, { env: acct(accountId) }), 'the Hyperdrive config');
}

// Hyperdrive through a Cloudflare Tunnel running next to the database (database not reachable from the internet).
export async function createTunnel(name, accountId) {
  return createdId(await wrangler(['tunnel', 'create', name], { env: acct(accountId) }), 'the tunnel');
}

export async function findTunnel(name, accountId) {
  const res = await wrangler(['tunnel', 'list'], { env: acct(accountId) });
  const row = tableRows(res.stdout).find((r) => r.cells.includes(name));
  return row ? row.id : null;
}

export async function createVpcService({ name, tunnelId, host, port, accountId }) {
  const args = ['vpc', 'service', 'create', name, '--type', 'tcp', '--tcp-port', String(port), '--app-protocol', 'mysql', '--tunnel-id', tunnelId, ...(/^\d+\.\d+\.\d+\.\d+$/.test(host) ? ['--ipv4', host] : ['--hostname', host]), '--cert-verification-mode', 'disabled'];
  return createdId(await wrangler(args, { env: acct(accountId) }), 'the VPC service');
}

export async function createHyperdriveVpc({ name, serviceId, db, accountId }) {
  const args = ['hyperdrive', 'create', name, '--service-id', serviceId, '--origin-scheme', 'mysql', '--database', db.name, '--origin-user', db.user, '--origin-password', db.password, '--caching-disabled'];
  return createdId(await wrangler(args, { env: acct(accountId) }), 'the Hyperdrive config');
}

// The page cache's KV namespace (one per site), found by title so a rerun reuses it.
export async function ensureKvNamespace(title, accountId) {
  const list = await wrangler(['kv', 'namespace', 'list'], { env: acct(accountId) });
  try {
    const found = JSON.parse(list.stdout.slice(list.stdout.indexOf('['))).find((n) => n.title === title);
    if (found) return found.id;
  } catch {}
  return createdId(await wrangler(['kv', 'namespace', 'create', title], { env: acct(accountId) }), 'the page cache (Workers KV namespace)');
}

// Writes wrangler.jsonc for the built site and deploys it. Returns the workers.dev URL (if enabled).
export async function deploy({ outDir, name, hyperdriveId, cacheKvId, region, salts, accountId, vars = {}, secrets = {}, routes, freePlan = false }) {
  const config = {
    name,
    main: 'src/index.js',
    compatibility_date: '2026-10-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    assets: { directory: 'public', binding: 'ASSETS', html_handling: 'none', not_found_handling: 'none' },
    hyperdrive: [{ binding: 'HYPERDRIVE', id: hyperdriveId }],
    // Full-page cache for anonymous visitors (runtime/src/page-cache.js).
    ...(cacheKvId ? { kv_namespaces: [{ binding: 'PAGE_CACHE', id: cacheKvId }] } : {}),
    // Run next to the database: a page makes dozens of sequential queries.
    ...(region ? { placement: { region: 'aws:' + region } } : {}),
    rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false }],
    // Workers Paid: allow long requests (admin pages, imports). The Free plan cannot set a CPU limit at all; its
    // Workers are stopped at about 2s of CPU, below a cold WordPress start, while Durable Objects get 30s.
    // There PHP runs in the PhpRuntime Durable Object (PHP_IN_DO) and the Worker only answers from the page
    // cache and forwards. The class is declared on every plan, so switching plans needs no migration.
    ...(freePlan ? {} : { limits: { cpu_ms: 300000 } }),
    durable_objects: { bindings: [{ name: 'PHP', class_name: 'PhpRuntime' }] },
    migrations: [{ tag: 'php-runtime-v1', new_sqlite_classes: ['PhpRuntime'] }],
    triggers: { crons: ['*/15 * * * *'] },
    vars: { WP_DEBUG: '0', PHP_IN_DO: freePlan ? '1' : '0', ...(freePlan && locationHint(region) ? { PHP_LOCATION: locationHint(region) } : {}), ...vars },
    observability: { enabled: true },
    ...(routes ? { routes } : {}),
  };
  fs.writeFileSync(path.join(outDir, 'wrangler.jsonc'), JSON.stringify(config, null, 2) + '\n');
  // Secrets go up with the version (never written into the project); the temp file is removed right away.
  // salts = null keeps the WP_SALTS secret already on the Worker.
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostlesswp-'));
  const secretsFile = path.join(secretsDir, 'secrets.json');
  fs.writeFileSync(secretsFile, JSON.stringify({ ...(salts ? { WP_SALTS: JSON.stringify(salts) } : {}), ...secrets }), { mode: 0o600 });
  let res;
  try {
    res = await wrangler(['deploy', '--config', path.join(outDir, 'wrangler.jsonc'), '--secrets-file', secretsFile], { env: acct(accountId), cwd: outDir });
  } finally {
    fs.rmSync(secretsDir, { recursive: true, force: true });
  }
  const text = plain(res.stdout + '\n' + res.stderr);
  if (res.code !== 0) {
    if (/code: 100328|CPU limits are not supported for the Free plan/i.test(text)) throw new FreePlanError('This Cloudflare account is on the Workers Free plan.');
    if (/Authentication error|code: 10000/i.test(text)) throw new CloudflareError('Deploy failed: permission denied.\n' + PERMISSION_HELP);
    if (/workers\.dev subdomain/i.test(text)) throw new CloudflareError('Your account has no workers.dev subdomain yet. Open https://dash.cloudflare.com/?to=/:account/workers once to create it, then run `npx hostlesswp deploy`.\n' + wranglerError(res));
    throw new CloudflareError('Deploy failed:\n' + wranglerError(res));
  }
  return (text.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0] || null;
}

// Secrets are set on the deployed Worker without rebuilding it.
export async function putSecret({ outDir, name, value, accountId }) {
  const res = await wrangler(['secret', 'put', name, '--config', path.join(outDir, 'wrangler.jsonc')], { input: value, env: acct(accountId), cwd: outDir });
  if (res.code !== 0) throw new CloudflareError(`Could not set ${name}:\n` + wranglerError(res));
}

// First request boots PHP (several seconds on a cold isolate); retry while the new version propagates.
export async function waitForSite(url, { tries = 12, expectTitle } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      // no-cache: render through PHP (and refresh the page cache) so the check sees the new version.
      const res = await fetch(url, { redirect: 'manual', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(90000) });
      const body = await res.text();
      const title = (body.match(/<title>([^<]*)/i) || [])[1] || '';
      const meta = res.headers.get('x-hostlesswp');
      last = { status: res.status, title, meta: meta ? JSON.parse(meta) : null, body: body.slice(0, 400) };
      if (res.status < 500 && meta && (!expectTitle || title.includes(expectTitle) || res.status !== 200)) return last;
    } catch (e) {
      last = { error: String(e.message || e) };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return last;
}
