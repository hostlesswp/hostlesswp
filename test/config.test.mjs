import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, readSiteConfig, writeSiteConfig, openSiteConfig } from '../lib/config.mjs';
import { createUI, Abort } from '../lib/ui.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-cfg-'));

test('missing file reads as empty', () => {
  assert.deepEqual(readSiteConfig(tmp()), {});
});

test('file starts with the exit guard, is 0600 and round-trips', () => {
  const root = tmp();
  writeSiteConfig(root, { name: 'wp-x', s3: { bucket: 'b' } });
  const file = path.join(root, CONFIG_FILE);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.split('\n')[0], '<?php exit; ?>');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readSiteConfig(root), { name: 'wp-x', s3: { bucket: 'b' } });
});

test('existing file with loose permissions is tightened on write', () => {
  const root = tmp();
  const file = path.join(root, CONFIG_FILE);
  fs.writeFileSync(file, '<?php exit; ?>\n{}\n', { mode: 0o644 });
  writeSiteConfig(root, { a: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a file without the guard is refused', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, CONFIG_FILE), '{"name":"x"}');
  assert.throws(() => readSiteConfig(root), /does not start with/);
});

test('dotted get/set writes through, undefined removes', () => {
  const root = tmp();
  const c = openSiteConfig(root);
  c.set('s3.bucket', 'media');
  c.set('region', null);
  assert.equal(c.get('s3.bucket'), 'media');
  assert.ok(c.has('region'));
  assert.equal(readSiteConfig(root).s3.bucket, 'media');
  c.set('s3', undefined);
  assert.ok(!c.has('s3.bucket'));
  assert.equal(readSiteConfig(root).s3, undefined);
});

test('read-only config keeps changes in memory', () => {
  const root = tmp();
  const c = openSiteConfig(root, { readOnly: true });
  c.set('name', 'x');
  assert.equal(c.get('name'), 'x');
  assert.ok(!fs.existsSync(path.join(root, CONFIG_FILE)));
});

test('ui: saved answers are used without asking, flags win and are saved', async () => {
  const root = tmp();
  const c = openSiteConfig(root);
  c.set('name', 'saved-name');
  const ui = createUI({ yes: true });
  ui.useConfig(c);
  assert.equal(await ui.text({ flag: 'name', remember: 'name', message: 'Name' }), 'saved-name');
  const ui2 = createUI({ yes: true, name: 'from-flag' });
  ui2.useConfig(c);
  assert.equal(await ui2.text({ flag: 'name', remember: 'name', message: 'Name' }), 'from-flag');
  assert.equal(readSiteConfig(root).name, 'from-flag');
});

test('ui: non-interactive default is saved; missing required answer names the flag or hint', async () => {
  const root = tmp();
  const ui = createUI({ yes: true });
  ui.useConfig(openSiteConfig(root));
  assert.equal(await ui.text({ remember: 's3.region', message: 'Region', initial: 'auto' }), 'auto');
  assert.equal(readSiteConfig(root).s3.region, 'auto');
  await assert.rejects(ui.text({ flag: 's3-bucket', remember: 's3.bucket', message: 'Bucket' }), /--s3-bucket/);
  await assert.rejects(ui.password({ remember: 's3.secretAccessKey', hint: 'HOSTLESSWP_S3_SECRET_ACCESS_KEY', message: 'Secret' }), /HOSTLESSWP_S3_SECRET_ACCESS_KEY/);
});

test('ui: a saved select value no longer offered falls back to the default', async () => {
  const root = tmp();
  const c = openSiteConfig(root);
  c.set('dbAccess', 'gone');
  const ui = createUI({ yes: true });
  ui.useConfig(c);
  const options = [{ value: 'public', label: 'p' }, { value: 'tunnel', label: 't' }];
  assert.equal(await ui.select({ flag: 'db-access', remember: 'dbAccess', message: 'm', options, initial: 'tunnel' }), 'tunnel');
  assert.equal(c.get('dbAccess'), 'tunnel');
  c.set('dbAccess', 'public');
  assert.equal(await ui.select({ flag: 'db-access', remember: 'dbAccess', message: 'm', options, initial: 'tunnel' }), 'public');
});

test('ui: saved confirm is reused', async () => {
  const c = openSiteConfig(tmp());
  c.set('newSalts', false);
  const ui = createUI({ yes: true });
  ui.useConfig(c);
  assert.equal(await ui.confirm({ flag: 'new-salts', remember: 'newSalts', message: 'm' }), false);
});

test('corrupt JSON is an Abort naming the file', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, CONFIG_FILE), '<?php exit; ?>\n{"name": ');
  assert.throws(() => readSiteConfig(root), (e) => e instanceof Abort && e.message.includes(path.join(root, CONFIG_FILE)));
});

test('writes are atomic: no temp files are left behind', () => {
  const root = tmp();
  writeSiteConfig(root, { a: 1 });
  writeSiteConfig(root, { a: 2 });
  assert.deepEqual(fs.readdirSync(root), [CONFIG_FILE]);
  assert.deepEqual(readSiteConfig(root), { a: 2 });
});

test('an unwritable folder is an Abort that explains where answers are saved', { skip: process.getuid?.() === 0 }, (t) => {
  const root = tmp();
  fs.chmodSync(root, 0o500);
  t.after(() => fs.chmodSync(root, 0o700));
  assert.throws(() => writeSiteConfig(root, { a: 1 }), /Cannot write .*hostlesswp saves your answers next to wp-config\.php/);
});
