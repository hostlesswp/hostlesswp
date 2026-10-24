// Turns a WordPress installation into a deployable Worker project:
//   public/            static files served by Workers Assets (theme/plugin assets, wp-includes js/css)
//   public/__hostlesswp/  zips of the files PHP must read, mounted into the in-memory file system at cold start
//   src/               the hostlesswp runtime, the engine and site-manifest.json
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
  const writeZip = (base, entries) => {
    const zip = zipSync(entries, ZIP_OPTS);
    const file = `__hostlesswp/${base}-${crypto.createHash('sha256').update(zip).digest('hex').slice(0, 12)}`;
    fs.writeFileSync(path.join(PUB, file + '.zip'), zip);
    return { file: '/' + file, zip };
  };
  // The files PHP reads as data, of every bundle, go to a few zips fetched at every cold start (few: each fetch is a
  // subrequest, and Workers limit those per request). A bundle's PHP sources go to parts: with precompiled OPcache
  // files PHP hardly reads sources, so a part is fetched only when PHP first reads one of its files. The central
  // directories of all parts are in one index file, from which their files are listed up front.
  const data = {};
  const index = [];
  let indexSize = 0;
  // OPcache keeps doc comments only when some code reads them back (Reflection); otherwise they take shared memory
  // for nothing.
  let docComments = false;
  const writeBundle = (name, entries) => {
    const php = [{}];
    let size = 0;
    for (const rel of Object.keys(entries).sort()) {
      if (rel.endsWith('.php') && !docComments && entries[rel][0].includes('getDocComment')) docComments = true;
      if (!rel.endsWith('.php') || readAsData(rel)) {
        data[rel] = entries[rel];
        continue;
      }
      const len = entries[rel][0].length;
      if (size + len > PHP_PART_BYTES && Object.keys(php[php.length - 1]).length) {
        php.push({});
        size = 0;
      }
      php[php.length - 1][rel] = entries[rel];
      size += len;
    }
    const parts = php.filter((part) => Object.keys(part).length).map((part, i) => {
      const { file, zip } = writeZip(`${name}-php-${i}`, part);
      const cd = centralDirectoryOf(zip);
      index.push(cd);
      indexSize += cd.length;
      // cdAt: [offset, length] of the part's central directory in the index file.
      return { zip: file + '.zip', cdAt: [indexSize - cd.length, cd.length], bytes: zip.length };
    });
    bundles.push({ name, php: parts, files: Object.keys(entries).length, bytes: parts.reduce((n, p) => n + p.bytes, 0) });
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
  for (const f of ['hostlesswp-mysqli.php', 'hostlesswp-http.php', 'hostlesswp-curl.php', 'hostlesswp-fileinfo.php', 'hostlesswp-dns.php', 'hostlesswp-session.php', 'hostlesswp-mail.php']) core['wp-content/' + f] = [fs.readFileSync(path.join(PKG_ROOT, 'runtime', 'php', f)), { level: 6 }];
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
  for (const f of ['index.js', 'lazyfs.js', 'media.js', 's3.js', 'page-cache.js', 'mail.js', 'http.js', 'session.js']) fs.copyFileSync(path.join(PKG_ROOT, 'runtime', 'src', f), path.join(SRC, f));
  vendorEngine(path.join(SRC, 'vendor'));
  // build changes with every build, so pages cached for an older deploy are rendered again (runtime/src/page-cache.js).
  // Data zips stay well under the 25 MiB static asset limit.
  const dataParts = [{}];
  let dataSize = 0;
  for (const rel of Object.keys(data).sort()) {
    const len = data[rel][0].length;
    if (dataSize + len > DATA_PART_BYTES && Object.keys(dataParts[dataParts.length - 1]).length) {
      dataParts.push({});
      dataSize = 0;
    }
    dataParts[dataParts.length - 1][rel] = data[rel];
    dataSize += len;
  }
  const dataZips = dataParts.map((part, i) => writeZip(`data-${i}`, part).file + '.zip');
  const manifest = { hostlesswp: version, build: crypto.randomUUID(), wordpress: site.wpVersion, plugins: pluginDirs, data: dataZips, index: writeIndex(PUB, index), bundles, docComments };
  fs.writeFileSync(path.join(SRC, 'site-manifest.json'), JSON.stringify(manifest, null, 1));
  linkNodeModules(outDir);
  // The runtime is ESM; Node (used for precompiling) needs to be told so.
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  stats.bundles = bundles;
  stats.data = manifest.data;
  stats.index = manifest.index;
  stats.plugins = pluginDirs;
  return stats;
}

// The Worker bundler resolves runtime imports (mysql2, fflate, aws4fetch) from the build directory.
function linkNodeModules(outDir) {
  const pkg = packageDir('mysql2');
  const nm = pkg.slice(0, pkg.lastIndexOf(path.sep + 'node_modules' + path.sep) + '/node_modules'.length);
  const link = path.join(outDir, 'node_modules');
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(nm, link, 'junction');
}

// The engine (runtime/engine): PHP 8.3 compiled to WebAssembly and its JS runtime, used by runtime/src/index.js.
function vendorEngine(dest) {
  const base = path.join(PKG_ROOT, 'runtime', 'engine');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['core.mjs', 'core.wasm', 'engine.mjs', 'handler.mjs']) fs.copyFileSync(path.join(base, f), path.join(dest, f));
}

// PHP files WordPress also reads as text, for their headers: get_plugins() scans the top level of every plugin
// folder, themes are scanned for page templates, mu-plugins for their names. They stay with the data files.
function readAsData(rel) {
  return /^wp-content\/plugins\/([^/]+\/)?[^/]+\.php$/.test(rel) || rel.startsWith('wp-content/themes/') || /^wp-content\/mu-plugins\/[^/]+\.php$/.test(rel);
}

// PHP sources per part (uncompressed): a request that reads one source fetches no more than this.
const PHP_PART_BYTES = 4 * 1024 * 1024;
const DATA_PART_BYTES = 20 * 1024 * 1024;

// Writes the central directories of remote zips as one file; returns its published path (null if none).
export function writeIndex(publicDir, cds) {
  if (!cds.length) return null;
  const buf = Buffer.concat(cds);
  const file = `/__hostlesswp/index-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12)}.cd`;
  fs.writeFileSync(path.join(publicDir, file), buf);
  return file;
}

// The central directory and end record of a zip written by fflate (no archive comment).
export function centralDirectoryOf(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.length);
  const end = zip.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error('zip end record not found');
  return zip.subarray(view.getUint32(end + 16, true));
}
