import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import { buildSite } from '../lib/build.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-site-'));
  const put = (rel, body = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  put('index.php', '<?php');
  put('wp-config.php', '<?php');
  put('hostlesswp-config.php', '<?php exit; ?>\n{"s3":{"secretAccessKey":"TOPSECRET"}}');
  put('wp-admin/index.php', '<?php');
  put('wp-includes/version.php', "<?php $wp_version = '6.8';");
  put('wp-content/themes/t/style.css', '/* Theme Name: t */');
  put('wp-content/uploads/2024/01/a.jpg', 'JPG');
  return root;
}

test('build leaves out the saved answers and the media library, ships the media runtime', () => {
  const root = fixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-out-'));
  buildSite({ root, wpVersion: '6.8', pluginEntries: [], themes: ['t', 't'], db: { name: 'db', charset: 'utf8mb4', collate: '' }, tablePrefix: 'wp_', extraDefines: {} }, out);
  const all = [];
  const walkAll = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== 'node_modules') walkAll(p);
      else if (e.isFile()) all.push(p);
    }
  };
  walkAll(out);
  assert.ok(!all.some((p) => p.endsWith('hostlesswp-config.php')), 'config file must not be copied');
  assert.ok(!fs.existsSync(path.join(out, 'public', 'wp-content', 'uploads')), 'uploads are not static assets');
  for (const zip of all.filter((p) => p.endsWith('.zip'))) {
    const names = Object.keys(unzipSync(fs.readFileSync(zip)));
    assert.ok(!names.some((n) => n.endsWith('hostlesswp-config.php')), 'config file must not be bundled: ' + zip);
  }
  for (const p of all.filter((p) => !p.endsWith('.wasm'))) assert.ok(!fs.readFileSync(p, 'latin1').includes('TOPSECRET'), 'secret leaked into ' + p);
  assert.ok(fs.existsSync(path.join(out, 'src', 'media.js')));
  assert.ok(fs.existsSync(path.join(out, 'src', 's3.js')));
});

test('plugin bundles leave out translation and stylesheet sources but keep what PHP reads', () => {
  const root = fixture();
  const put = (rel, body = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  for (const f of ['p.php', 'languages/p-de_DE.mo', 'languages/p-de_DE.po', 'languages/p.pot', 'src/a.scss', 'src/a.ts', 'build/a.css', 'schema.json']) put('wp-content/plugins/p/' + f);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-out-'));
  const stats = buildSite({ root, wpVersion: '6.8', pluginEntries: ['p/p.php'], themes: ['t'], db: { name: 'db' }, tablePrefix: 'wp_' }, out);
  const bundle = stats.bundles.find((b) => b.name === 'plugin-p');
  const read = (file) => fs.readFileSync(path.join(out, 'public', file));
  const names = [...stats.data, ...bundle.php.map((part) => part.zip)].flatMap((zip) => Object.keys(unzipSync(read(zip)))).filter((n) => n.startsWith('wp-content/plugins/p/')).map((n) => n.replace('wp-content/plugins/p/', '')).sort();
  assert.deepEqual(names, ['build/a.css', 'languages/p-de_DE.mo', 'p.php', 'schema.json']);
});

test('PHP sources go to parts whose central directories are in the index file', () => {
  const root = fixture();
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  // Over the part size, so the sources take two parts.
  for (let i = 0; i < 5; i++) put(`wp-content/plugins/big/inc/f${i}.php`, '<?php //' + crypto.randomBytes(1024 * 1024).toString('hex'));
  put('wp-content/plugins/big/big.php', '<?php /* Plugin Name: Big */');
  put('wp-content/plugins/big/data.json', '{}');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-out-'));
  const stats = buildSite({ root, wpVersion: '6.8', pluginEntries: ['big/big.php'], themes: ['t'], db: { name: 'db' }, tablePrefix: 'wp_' }, out);
  const bundle = stats.bundles.find((b) => b.name === 'plugin-big');
  const read = (file) => fs.readFileSync(path.join(out, 'public', file));
  // The main plugin file is read for its header as well, so it stays with the data files.
  const data = stats.data.flatMap((zip) => Object.keys(unzipSync(read(zip)))).filter((n) => n.startsWith('wp-content/plugins/big/')).sort();
  assert.deepEqual(data, ['wp-content/plugins/big/big.php', 'wp-content/plugins/big/data.json']);
  const index = read(stats.index);
  assert.ok(bundle.php.length >= 2, 'sources split into parts');
  for (const part of bundle.php) {
    const zip = read(part.zip);
    const cd = index.subarray(part.cdAt[0], part.cdAt[0] + part.cdAt[1]);
    // The part's slice of the index is the tail of the zip: its central directory and end record.
    assert.deepEqual(cd, zip.subarray(zip.length - cd.length));
    assert.equal(cd.readUInt32LE(cd.length - 22), 0x06054b50);
    assert.equal(cd.readUInt16LE(cd.length - 22 + 10), Object.keys(unzipSync(zip)).length);
  }
});

test('doc comments are kept only when some PHP code reads them', () => {
  const site = (root) => ({ root, wpVersion: '6.8', pluginEntries: ['p/p.php'], themes: ['t'], db: { name: 'db' }, tablePrefix: 'wp_' });
  const manifest = (out) => JSON.parse(fs.readFileSync(path.join(out, 'src', 'site-manifest.json'), 'utf8'));
  const plain = fixture();
  fs.mkdirSync(path.join(plain, 'wp-content/plugins/p'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'wp-content/plugins/p/p.php'), '<?php');
  const out1 = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-out-'));
  buildSite(site(plain), out1);
  assert.equal(manifest(out1).docComments, false);
  fs.mkdirSync(path.join(plain, 'wp-content/plugins/p/src'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'wp-content/plugins/p/src/m.php'), '<?php $r->getDocComment();');
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-out-'));
  buildSite(site(plain), out2);
  assert.equal(manifest(out2).docComments, true);
});
