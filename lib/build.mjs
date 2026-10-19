// Turns a WordPress installation into a deployable Worker project:
//   public/            static files served by Workers Assets (theme/plugin assets, wp-includes js/css)
//   public/__hostlesswp/  zips of the files PHP must read, mounted into the in-memory file system at cold start
//   src/               the hostlesswp runtime, the patched php-wasm build and site-manifest.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { zipSync } from 'fflate';
import { PKG_ROOT, packageDir } from './run.mjs';
import { PRIVATE_EXT, SKIP_NAMES } from '../runtime/src/s3.js';
import { CONFIG_FILE } from './config.mjs';

// Fixed entry timestamps keep bundle hashes reproducible.
const ZIP_OPTS = { mtime: new Date('2000-01-01T00:00:00Z') };
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.zip', '.gz', '.map', '.psd', '.pdf']);
// Translation sources and stylesheet/script sources: WordPress loads only compiled translations (.mo, .l10n.php)
// and nothing reads the sources at runtime. Leaving them out keeps the retained bundles smaller in Worker memory.
const SOURCE_EXT = new Set(['.po', '.pot', '.scss', '.sass', '.less', '.ts', '.tsx']);
const PHP_EXT = new Set(['.php', '.json', '.html', '.crt', '.txt', '.mo']);
// Root-level files that may be published (robots.txt and verification files are served by the web server today).
const ROOT_PUBLIC_EXT = new Set(['.ico', '.png', '.jpg', '.svg', '.webmanifest', '.xml']);

// Files PHP reads at runtime besides code: theme headers, block templates, styles inlined by core, translations.
function phpNeeds(rel, abs) {
  const ext = path.extname(rel);
  if (PHP_EXT.has(ext)) return true;
  if (rel.endsWith('.min.css') || ext === '.svg') return true;
  if (ext === '.css' && rel.startsWith('wp-content/')) return true;
  if (/^wp-includes\/js\/[^/]+\.min\.js$/.test(rel)) return true;
  if (rel.startsWith('wp-includes/js/tinymce/langs/')) return true;
  // Plugins and themes read arbitrary own files (schemas, templates, lists): everything except binary media;
  // large JS bundles are only ever served, never read.
  if (rel.startsWith('wp-content/plugins/') || rel.startsWith('wp-content/themes/') || rel.startsWith('wp-content/mu-plugins/')) {
    if (BINARY_EXT.has(ext) || SOURCE_EXT.has(ext)) return false;
    if (ext === '.js') return fs.statSync(abs).size <= 32 * 1024;
    return true;
  }
  return false;
}

function isPublic(rel) {
  const base = path.basename(rel);
  if (base.startsWith('.') || SKIP_NAMES.has(base)) return false;
  return !PRIVATE_EXT.has(path.extname(rel).toLowerCase());
}

export function* walk(root, rel = '') {
  const dir = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) yield* walk(root, r);
    else if (e.isFile()) yield r;
  }
}

function render(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => values[k] ?? '');
}

const phpQuote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// site: { root, wpVersion, pluginEntries (active_plugins values), themes: [stylesheet, template], db: { name, charset, collate },
//         tablePrefix, extraDefines: {NAME: value} }
export function buildSite(site, outDir, { log = () => {}, version = '0.0.0' } = {}) {
  const PUB = path.join(outDir, 'public');
  const SRC = path.join(outDir, 'src');
  fs.rmSync(PUB, { recursive: true, force: true });
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.mkdirSync(path.join(PUB, '__hostlesswp'), { recursive: true });
  fs.mkdirSync(path.join(SRC, 'vendor'), { recursive: true });

  const stats = { publicFiles: 0, publicBytes: 0, skippedLarge: [], bundles: [] };
  const publish = (abs, rel) => {
    const size = fs.statSync(abs).size;
    if (size > MAX_ASSET_BYTES) {
      stats.skippedLarge.push({ rel, size });
      return;
    }
    const dst = path.join(PUB, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(abs, dst);
    stats.publicFiles++;
    stats.publicBytes += size;
  };
  const bundles = [];
  const writeBundle = (name, entries) => {
    const zip = zipSync(entries, ZIP_OPTS);
    const hash = crypto.createHash('sha256').update(zip).digest('hex').slice(0, 12);
    const file = `__hostlesswp/${name}-${hash}.zip`;
    fs.writeFileSync(path.join(PUB, file), zip);
    bundles.push({ name, zip: '/' + file, files: Object.keys(entries).length, bytes: zip.length });
  };
  const addTree = (entries, root, relBase, prefix) => {
    for (const r of walk(root, relBase)) {
      const rel = prefix ? prefix + r.slice(relBase.length) : r;
      const abs = path.join(root, r);
      if (phpNeeds(rel, abs)) entries[rel] = [fs.readFileSync(abs), { level: 6 }];
      if (isPublic(rel)) publish(abs, rel);
    }
  };

  // Core bundle: WordPress itself, the active theme (and parent), mu-plugins, translations, single-file plugins.
  const core = {};
  for (const name of fs.readdirSync(site.root)) {
    const abs = path.join(site.root, name);
    // hostlesswp-config.php holds the setup answers, passwords included: never ship it.
    if (!fs.statSync(abs).isFile() || name.startsWith('wp-config') || name === CONFIG_FILE) continue;
    const ext = path.extname(name).toLowerCase();
    if (ext === '.php') core[name] = [fs.readFileSync(abs), { level: 6 }];
    else if (ROOT_PUBLIC_EXT.has(ext) || name === 'robots.txt' || /^google[0-9a-f]+\.html$/.test(name)) {
      // robots.txt and search-console verification files are plain files on the current host.
      const dst = path.join(PUB, name);
      fs.copyFileSync(abs, dst);
      stats.publicFiles++;
    }
  }
  addTree(core, site.root, 'wp-admin');
  addTree(core, site.root, 'wp-includes');
  const wc = path.join(site.root, 'wp-content');
  if (fs.existsSync(path.join(wc, 'index.php'))) core['wp-content/index.php'] = [fs.readFileSync(path.join(wc, 'index.php')), { level: 6 }];
  for (const theme of [...new Set(site.themes.filter(Boolean))]) {
    if (!fs.existsSync(path.join(wc, 'themes', theme))) throw new Error(`Active theme "${theme}" not found in wp-content/themes`);
    addTree(core, site.root, `wp-content/themes/${theme}`);
  }
  addTree(core, site.root, 'wp-content/mu-plugins');
  addTree(core, site.root, 'wp-content/languages');
  const pluginDirs = [];
  for (const entry of site.pluginEntries) {
    if (!entry.includes('/')) {
      const abs = path.join(wc, 'plugins', entry);
      if (fs.existsSync(abs)) core['wp-content/plugins/' + entry] = [fs.readFileSync(abs), { level: 6 }];
    } else {
      const slug = entry.split('/')[0];
      if (!pluginDirs.includes(slug)) pluginDirs.push(slug);
    }
  }
  const tpl = fs.readFileSync(path.join(PKG_ROOT, 'runtime', 'php', 'wp-config.php'), 'utf8');
  const extra = Object.entries(site.extraDefines || {})
    .map(([k, v]) => `define( '${k}', ${typeof v === 'string' ? `'${phpQuote(v)}'` : JSON.stringify(v)} );`)
    .join('\n');
  core['wp-config.php'] = [Buffer.from(render(tpl, { DB_NAME: phpQuote(site.db.name), DB_CHARSET: phpQuote(site.db.charset || 'utf8mb4'), DB_COLLATE: phpQuote(site.db.collate || ''), TABLE_PREFIX: phpQuote(site.tablePrefix), EXTRA_DEFINES: extra })), { level: 6 }];
  core['wp-content/db.php'] = [fs.readFileSync(path.join(PKG_ROOT, 'runtime', 'php', 'db.php')), { level: 6 }];
  core['wp-content/hostlesswp-mysqli.php'] = [fs.readFileSync(path.join(PKG_ROOT, 'runtime', 'php', 'hostlesswp-mysqli.php')), { level: 6 }];
  core['wp-content/mu-plugins/hostlesswp-runtime.php'] = [fs.readFileSync(path.join(PKG_ROOT, 'runtime', 'php', 'hostlesswp-runtime.php')), { level: 6 }];
  writeBundle('core', core);
  log(`core bundle: ${Object.keys(core).length} files`);

  for (const slug of pluginDirs) {
    const dir = path.join(wc, 'plugins', slug);
    if (!fs.existsSync(dir)) {
      log(`plugin folder missing, skipped: ${slug}`);
      continue;
    }
    const entries = {};
    addTree(entries, site.root, `wp-content/plugins/${slug}`);
    writeBundle('plugin-' + slug, entries);
  }

  // Media is not published here: it lives in the S3 bucket (lib/uploads-sync.mjs, runtime/src/media.js).

  // Runtime sources and the patched PHP build.
  for (const f of ['index.js', 'lazyfs.js', 'media.js', 's3.js', 'page-cache.js']) fs.copyFileSync(path.join(PKG_ROOT, 'runtime', 'src', f), path.join(SRC, f));
  vendorPhp(path.join(SRC, 'vendor'));
  // build changes with every build, so pages cached for an older deploy are rendered again (runtime/src/page-cache.js).
  const manifest = { hostlesswp: version, build: crypto.randomUUID(), wordpress: site.wpVersion, plugins: pluginDirs, bundles };
  fs.writeFileSync(path.join(SRC, 'site-manifest.json'), JSON.stringify(manifest, null, 1));
  linkNodeModules(outDir);
  // The runtime is ESM; Node (used for precompiling) needs to be told so.
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  stats.bundles = bundles;
  stats.plugins = pluginDirs;
  return stats;
}

// The Worker bundler resolves runtime imports (@php-wasm/universal, mysql2, fflate) from the build directory.
function linkNodeModules(outDir) {
  const pkg = packageDir('@php-wasm/universal');
  const nm = pkg.slice(0, pkg.lastIndexOf(path.sep + 'node_modules' + path.sep) + '/node_modules'.length);
  const link = path.join(outDir, 'node_modules');
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(nm, link, 'junction');
}

// php-wasm (PHP 8.3, JSPI build) with the patches WordPress needs on Workers.
function vendorPhp(dest) {
  const base = path.join(packageDir('@php-wasm/web-8-3'), 'jspi');
  const loaderName = fs.readdirSync(base).find((f) => f.endsWith('.js'));
  let loader = fs.readFileSync(path.join(base, loaderName), 'utf8');
  loader = replaceOnce(loader, /const dependencyFilename = new URL\([^)]*\)\s*\.href;/, "const dependencyFilename = 'php.wasm';", 'wasm url');
  // Heap views can go stale after memory growth inside a suspended call; refresh before decoding strings.
  loader = replaceOnce(
    loader,
    "var UTF8ToString = (ptr, maxBytesToRead, ignoreNul) =>\n\t\tptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead, ignoreNul) : '';",
    `var UTF8ToString = (ptr, maxBytesToRead, ignoreNul) => {
		if (!ptr) return '';
		if (HEAPU8.buffer !== wasmMemory.buffer) updateMemoryViews();
		return UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead, ignoreNul);
	};`,
    'UTF8ToString',
  );
  // Workers freeze Date.now()/performance.now() during CPU-bound execution. PHP code that polls the clock until it
  // changes (uniqid(), retry deadlines) would spin until the CPU limit, so make both clocks strictly monotonic.
  for (const [orig, src, slot, fn] of [
    ['var _emscripten_date_now = () => Date.now();', 'Date.now()', '__hostlesswpLastDate', '_emscripten_date_now'],
    ['var _emscripten_get_now = () => performance.now();', 'performance.now()', '__hostlesswpLastPerf', '_emscripten_get_now'],
  ]) {
    loader = replaceOnce(loader, orig, `var ${fn} = () => {
		var t = ${src};
		var last = globalThis.${slot} || 0;
		if (t <= last) t = last + 0.001;
		globalThis.${slot} = t;
		return t;
	};`, fn);
  }
  fs.writeFileSync(path.join(dest, 'php.js'), loader);
  const verDir = fs.readdirSync(base).find((f) => /^\d+_\d+_\d+$/.test(f));
  let wasm = fs.readFileSync(path.join(base, verDir, loaderName.replace('.js', '.wasm')));
  wasm = patchInitialMemory(wasm, 256);
  wasm = patchOpcacheSapi(wasm);
  fs.writeFileSync(path.join(dest, 'php.wasm'), wasm);
}

function replaceOnce(src, pattern, replacement, label) {
  const found = typeof pattern === 'string' ? src.includes(pattern) : pattern.test(src);
  if (!found) throw new Error(`php-wasm loader patch failed (${label}); this php-wasm version is not supported`);
  return src.replace(pattern, replacement);
}

// OPcache only starts for SAPIs in a hardcoded whitelist; php-wasm registers as "wasm". Reuse the unused
// "fuzzer" entry so the check passes.
function patchOpcacheSapi(buf) {
  const needle = Buffer.from('\0fuzzer\0');
  const i = buf.indexOf(needle);
  if (i < 0 || buf.indexOf(needle, i + 1) >= 0) throw new Error('opcache SAPI whitelist entry not found exactly once');
  const out = Buffer.from(buf);
  Buffer.from('wasm\0\0').copy(out, i + 1);
  return out;
}

// The upstream build declares 64MB of initial memory although it needs ~14MB; a smaller floor leaves headroom
// under the Worker memory limit (memory still grows on demand).
function patchInitialMemory(buf, pages) {
  const leb = (i) => {
    let r = 0, s = 0, b;
    do {
      b = buf[i++];
      r |= (b & 0x7f) << s;
      s += 7;
    } while (b & 0x80);
    return [r, i];
  };
  const enc = (v, len) => {
    const out = [];
    for (let k = 0; k < len; k++) {
      out.push((v & 0x7f) | (k < len - 1 ? 0x80 : 0));
      v >>>= 7;
    }
    return out;
  };
  let i = 8;
  while (i < buf.length) {
    const id = buf[i++];
    const [size, body] = leb(i);
    if (id === 5) {
      let [, j] = leb(body);
      j++;
      const [min, after] = leb(j);
      const len = after - j;
      if (pages >= min) return buf;
      const out = Buffer.from(buf);
      Buffer.from(enc(pages, len)).copy(out, j);
      return out;
    }
    i = body + size;
  }
  throw new Error('wasm memory section not found');
}
