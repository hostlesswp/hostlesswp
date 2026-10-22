// Build, precompile, deploy and verify: shared by `migrate` (first time) and `deploy` (updates).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { p, pc, spinner, Abort } from './ui.mjs';
import { buildSite } from './build.mjs';
import { deploy, waitForSite, putSecret, ensureKvNamespace, FreePlanError } from './cloudflare.mjs';
import { PKG_ROOT, WRANGLER, run } from './run.mjs';
import { fmtBytes } from './site-context.mjs';
import { syncUploads } from './uploads-sync.mjs';
import { workerBindings } from './media-storage.mjs';
import { mailSecrets } from './mail-setup.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
export { VERSION };

// Per-site state lives outside the web root (a build directory inside it could be served by the current host).
// It never contains answers or passwords: those are in the site's hostlesswp-config.php.
export const HOME = process.env.HOSTLESSWP_HOME || path.join(os.homedir(), '.hostlesswp');
export function siteDir(name) {
  return path.join(HOME, 'sites', name);
}
export function loadState(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(siteDir(name), 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}
// User answers (account, database access, region) live in the site's hostlesswp-config.php; state.json only keeps
// what hostlesswp created and found.
export const INPUT_KEYS = ['accountId', 'dbAccess', 'dbPublicHost', 'region'];

export function saveState(state) {
  const out = { ...state };
  for (const k of INPUT_KEYS) delete out[k];
  fs.mkdirSync(siteDir(state.name), { recursive: true });
  fs.writeFileSync(path.join(siteDir(state.name), 'state.json'), JSON.stringify(out, null, 2) + '\n');
}

// state.json files written before hostlesswp-config.php existed kept the answers; move them over once.
export function withInputs(state, config) {
  for (const k of INPUT_KEYS) {
    if (!config.has(k) && state[k] !== undefined) config.set(k, state[k]);
    if (config.has(k)) state[k] = config.get(k);
  }
  return state;
}
export function listStates() {
  try {
    return fs.readdirSync(path.join(HOME, 'sites')).map(loadState).filter(Boolean);
  } catch {
    return [];
  }
}

// JSPI (needed to run HostlessWP PHP in Node for precompiling) is behind a flag before Node 25.
async function jspiWorks() {
  const res = await run(process.execPath, ['--experimental-wasm-jspi', '-e', "process.exit('Suspending' in WebAssembly ? 0 : 3)"]);
  return res.code === 0;
}

async function precompile(site, outDir) {
  const origin = (site.info.home || 'https://example.com').replace(/\/$/, '');
  const pages = ['/', '/wp-login.php', '/feed/', '/?s=a', '/wp-json/'];
  if (site.samplePosts.post) pages.push('/?p=' + site.samplePosts.post);
  if (site.samplePosts.page) pages.push('/?page_id=' + site.samplePosts.page);
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostlesswp-'));
  const jobFile = path.join(jobDir, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify({ outDir, db: site.cfg.db, salts: site.cfg.salts, origin, pages }), { mode: 0o600 });
  try {
    const res = await run(process.execPath, ['--experimental-wasm-jspi', '--import', path.join(PKG_ROOT, 'lib', 'node', 'register.mjs'), path.join(PKG_ROOT, 'lib', 'node', 'precompile.mjs'), jobFile], { cwd: outDir });
    const last = res.stdout.trim().split('\n').pop();
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split('\n').slice(-6).join('\n'));
    return JSON.parse(last);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

// Keeps a tunnel connector running in the background on this machine (tunnel mode).
export function startTunnelInBackground(state) {
  const log = path.join(siteDir(state.name), 'tunnel.log');
  const out = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [WRANGLER, 'tunnel', 'run', state.tunnelId], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...(state.accountId ? { CLOUDFLARE_ACCOUNT_ID: state.accountId } : {}) } });
  child.unref();
  return { pid: child.pid, log };
}

export async function buildAndDeploy(ui, flags, site, state) {
  const outDir = path.join(siteDir(state.name), 'build');
  fs.mkdirSync(outDir, { recursive: true });

  let s = spinner();
  s.start('Packaging WordPress, your theme and plugins');
  const stats = buildSite(
    {
      root: site.root,
      wpVersion: site.wpVersion,
      pluginEntries: site.info.activePlugins,
      themes: [site.info.stylesheet, site.info.template],
      db: site.cfg.db,
      tablePrefix: site.cfg.tablePrefix,
      extraDefines: site.cfg.extraDefines,
    },
    outDir,
    { version: VERSION },
  );
  s.stop(`Packaged: ${stats.bundles.length} code bundles, ${stats.publicFiles} static files (${fmtBytes(stats.publicBytes)})`);
  if (stats.skippedLarge.length) {
    p.log.warn(`${stats.skippedLarge.length} files are larger than 25 MiB and were left out (Workers static asset limit):\n` + stats.skippedLarge.slice(0, 5).map((f) => '  ' + f.rel + ' ' + fmtBytes(f.size)).join('\n'));
  }

  if (flags.precompile !== false && flags['no-precompile'] === undefined) {
    if (await jspiWorks()) {
      s = spinner();
      s.start('Precompiling PHP for faster cold starts (renders a few pages locally against your database)');
      try {
        const r = await precompile(site, outDir);
        const failed = r.pages.filter((x) => x.error || x.status >= 500);
        s.stop(`Precompiled ${r.scripts} PHP scripts` + (failed.length ? pc.yellow(`, ${failed.length} page(s) failed locally: ${failed.map((x) => x.path).join(' ')}`) : ''));
      } catch (e) {
        s.stop(pc.yellow('Precompiling failed; the site still works, cold starts are just slower.'), 1);
        p.log.message(pc.dim(String(e.message).slice(0, 800)));
      }
    } else {
      p.log.warn(`Skipping precompile: this Node.js (${process.version}) cannot run PHP's WebAssembly build. The site still works; use Node 24+ for faster cold starts.`);
    }
  }

  const s3 = ui.config.get('s3');
  s = spinner();
  s.start(`Copying your media library to ${s3.bucket}`);
  let synced;
  try {
    synced = await syncUploads({ root: site.root, s3, resync: Boolean(flags['resync-uploads']), onProgress: (done, total) => s.message(`Copying your media library to ${s3.bucket} (${done}/${total})`) });
  } catch (e) {
    s.stop(pc.red('Copying the media library failed'), 1);
    throw new Abort(`${e.message}\nNothing was deployed. Check the bucket settings in hostlesswp-config.php and run again.`);
  }
  s.stop(`Media library in ${s3.bucket}: ${synced.uploaded} copied (${fmtBytes(synced.bytes)}), ${synced.unchanged} already there`);
  if (synced.tooLarge.length) {
    p.log.warn(`${synced.tooLarge.length} media files are 2 GB or larger and were not copied; upload them to the bucket yourself:\n` + synced.tooLarge.slice(0, 5).map((f) => '  ' + f.rel + ' ' + fmtBytes(f.size)).join('\n'));
  }
  if (synced.changed > 0) {
    p.log.warn(`${synced.changed} media files differ from the bucket copy and were left alone; run with --resync-uploads to overwrite them from this server`);
  }
  const media = workerBindings(s3);

  // Page cache for anonymous visitors (Workers KV). Without it every page view runs PHP, so a failure here only warns.
  let cacheKvId = null;
  if (flags['page-cache'] !== false) {
    s = spinner();
    s.start('Setting up the page cache');
    try {
      cacheKvId = await ensureKvNamespace(state.name + '-page-cache', state.accountId);
      s.stop('Page cache ready: visitors who are not logged in get cached pages, updated when content changes');
    } catch (e) {
      s.stop(pc.yellow('The page cache could not be set up; every page view will run PHP'), 1);
      p.log.message(pc.dim(String(e.message).slice(0, 800)));
    }
  }
  if (cacheKvId) state.cacheKvId = cacheKvId;
  else delete state.cacheKvId;

  const deployOnce = (freePlan) =>
    deploy({ outDir, name: state.name, hyperdriveId: state.hyperdriveId, cacheKvId, region: state.region, salts: site.cfg.saltsGenerated && state.generatedSaltsUploaded ? null : site.cfg.salts, accountId: state.accountId, vars: media.vars, secrets: { ...media.secrets, ...mailSecrets(ui.config.get('smtp.url')) }, freePlan });
  s = spinner();
  s.start(`Deploying ${state.name} to Cloudflare (the first upload can take several minutes)`);
  let url;
  try {
    url = await deployOnce(Boolean(state.freePlan) && !flags['recheck-plan']);
  } catch (e) {
    if (!(e instanceof FreePlanError)) {
      s.stop(pc.red('Deploy failed'), 1);
      throw e;
    }
    s.stop('Your Cloudflare account is on the Workers Free plan');
    p.note(
      [
        'The site runs on the Free plan. Its daily limits: 100,000 requests, 100,000 database queries (Hyperdrive)',
        'and 1,000 page cache writes (KV). Pages for logged-out visitors come from the page cache and use no queries.',
        '',
        `For a busier site, ${pc.bold('Workers Paid')} ($5/month) raises the limits and allows longer requests (imports):`,
        'https://dash.cloudflare.com/?to=/:account/workers/plans  then run `npx hostlesswp deploy --recheck-plan`.',
      ].join('\n'),
      'Free plan',
    );
    if (flags['allow-free'] === false || flags['allow-free'] === 'false') throw new Abort('Stopped (--allow-free=false). Upgrade to Workers Paid and run again.');
    s = spinner();
    s.start('Deploying on the Free plan');
    url = await deployOnce(true).catch((err) => {
      s.stop(pc.red('Deploy failed'), 1);
      throw err;
    });
    state.freePlan = true;
  }
  if (flags['recheck-plan'] && !state.freePlan) delete state.freePlan;
  s.stop(state.freePlan ? 'Deployed (Free plan)' : 'Deployed');
  if (url) state.url = url;
  // Generated keys stay on the Worker as a secret (secrets survive deploys); uploading new ones would log everyone out.
  if (site.cfg.saltsGenerated) state.generatedSaltsUploaded = true;
  else delete state.generatedSaltsUploaded;
  // WP-Cron runs from a Cron Trigger, which has no request URL; tell the Worker which origin the site lives on.
  const origin = state.domain ? 'https://' + state.domain : state.url;
  if (origin && state.cronOrigin !== origin) {
    await putSecret({ outDir, name: 'SITE_ORIGIN', value: origin, accountId: state.accountId });
    state.cronOrigin = origin;
  }
  saveState(state);

  if (!state.url) return { ok: false };
  s = spinner();
  s.start(`Opening ${state.url} (the first request starts PHP, give it a few seconds)`);
  const check = await waitForSite(state.url + '/', { expectTitle: site.info.blogname || undefined });
  if (check && check.meta && check.status < 500) {
    s.stop(`${pc.green('Your site is live on Workers')}: HTTP ${check.status}${check.title ? `, "${check.title}"` : ''} (PHP ${check.meta.phpMs}ms, ${check.meta.queries} queries)`);
    return { ok: true, check };
  }
  s.stop(pc.red('The site did not answer correctly yet'), 1);
  p.log.message(pc.dim(JSON.stringify(check).slice(0, 600)));
  return { ok: false, check };
}
