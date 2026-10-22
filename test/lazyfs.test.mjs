import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipSync } from 'fflate';
import { buildSite } from '../lib/build.mjs';
import { PKG_ROOT } from '../lib/run.mjs';

// Runs PHP (the real HostlessWP PHP build and its Emscripten MEMFS) against lazily mounted zips.
function runPhp(code) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-lazy-site-'));
  fs.mkdirSync(path.join(root, 'wp-includes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wp-includes', 'version.php'), '<?php');
  fs.mkdirSync(path.join(root, 'wp-content', 'themes', 't'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wp-content', 'themes', 't', 'style.css'), '/* Theme Name: t */');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-lazy-out-'));
  buildSite({ root, wpVersion: '6.8', pluginEntries: [], themes: ['t'], db: { name: 'db' }, tablePrefix: 'wp_' }, out);
  const enc = (s) => new TextEncoder().encode(s);
  fs.writeFileSync(
    path.join(out, 'a.zip'),
    zipSync({ 'app/inc/one.php': enc('<?php return "one";'), 'app/inc/deep/two.txt': enc('two'), 'app/shared.txt': enc('from a'), 'app/keep/k.txt': enc('k') }),
  );
  fs.writeFileSync(path.join(out, 'b.zip'), zipSync({ 'app/shared.txt': enc('from b'), 'app/inc/three.txt': enc('three') }));
  fs.writeFileSync(path.join(out, 'code.php'), code);
  fs.writeFileSync(
    path.join(out, 'run.mjs'),
    `import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadPHPRuntime, PHP, __private__dont__use } from '@php-wasm/universal';
import * as phpLoader from './src/vendor/php.js';
import phpWasm from './src/vendor/php.wasm';
import { mountLazyZip, lazyStats } from './src/lazyfs.js';
// The Emscripten loader expects a CommonJS require when it detects Node.
globalThis.require = createRequire(import.meta.url);
const id = await loadPHPRuntime(phpLoader, { instantiateWasm(imports, done) { WebAssembly.instantiate(phpWasm, imports).then((i) => done(i, phpWasm)); return {}; } });
const php = new PHP(id);
const FS = php[__private__dont__use].FS;
mountLazyZip(FS, '/srv', new Uint8Array(fs.readFileSync('a.zip')));
mountLazyZip(FS, '/srv', new Uint8Array(fs.readFileSync('b.zip')));
mountLazyZip(FS, '/ro', new Uint8Array(fs.readFileSync('a.zip')), { retain: false, readOnly: true });
const before = lazyStats.nodes;
const r = await php.run({ code: fs.readFileSync('code.php', 'utf8') });
process.stdout.write(JSON.stringify({ before, out: r.text, errors: r.errors }));
process.exit(0);
`,
  );
  const res = execFileSync(process.execPath, ['--experimental-wasm-jspi', '--import', path.join(PKG_ROOT, 'lib', 'node', 'register.mjs'), 'run.mjs'], { cwd: out, encoding: 'utf8' });
  return JSON.parse(res);
}

test('lazily mounted zips behave like files on disk', () => {
  const r = runPhp(`<?php
$o = array();
$o[] = include '/srv/app/inc/one.php';
$o[] = file_get_contents('/srv/app/inc/deep/two.txt');
$o[] = file_get_contents('/srv/app/shared.txt');
$o[] = filesize('/srv/app/inc/three.txt');
$o[] = var_export(file_exists('/srv/app/missing.txt'), true);
$l = scandir('/srv/app/inc'); $o[] = implode(',', $l);
$o[] = var_export(@rmdir('/srv/app/keep'), true);
unlink('/srv/app/keep/k.txt');
$o[] = var_export(rmdir('/srv/app/keep'), true);
$o[] = var_export(file_exists('/srv/app/keep'), true);
mkdir('/srv/app/inc/new');
file_put_contents('/srv/app/inc/new/n.txt', 'n');
$o[] = file_get_contents('/srv/app/inc/new/n.txt');
echo implode('|', $o);`);
  assert.equal(r.before, 0, 'no node is created before PHP looks a path up');
  assert.equal(r.out, 'one|two|from b|5|false|.,..,deep,one.php,three.txt|false|true|false|n', r.errors);
});

test('a read-only mount refuses new files and directories', () => {
  const r = runPhp(`<?php
$o = array();
$o[] = file_get_contents('/ro/app/inc/deep/two.txt');
$o[] = var_export(@file_put_contents('/ro/app/inc/new.txt', 'x'), true);
$o[] = var_export(@mkdir('/ro/app/inc/sub/dir', 0777, true), true);
$o[] = var_export(@file_put_contents('/ro/fresh.txt', 'x'), true);
$o[] = var_export(file_exists('/ro/app/inc/new.txt'), true);
$o[] = var_export(file_put_contents('/srv/app/inc/new.txt', 'x'), true);
echo implode('|', $o);
`);
  assert.equal(r.out, 'two|false|false|false|false|1');
});
