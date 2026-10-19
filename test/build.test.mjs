import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  const zip = stats.bundles.find((b) => b.name === 'plugin-p').zip;
  const names = Object.keys(unzipSync(fs.readFileSync(path.join(out, 'public', zip)))).map((n) => n.replace('wp-content/plugins/p/', '')).sort();
  assert.deepEqual(names, ['build/a.css', 'languages/p-de_DE.mo', 'p.php', 'schema.json']);
});
