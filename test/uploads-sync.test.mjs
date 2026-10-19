import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { planSync, syncUploads, MAX_SYNC_BYTES } from '../lib/uploads-sync.mjs';

test('plan: missing files upload, resized ones are left alone, same size is unchanged, private and huge files are left out', () => {
  const local = [
    { rel: '2024/01/new.jpg', size: 3 },
    { rel: '2024/01/same.jpg', size: 5 },
    { rel: '2024/01/resized.jpg', size: 6 },
    { rel: '2024/01/shell.php', size: 1 },
    { rel: '2024/01/huge.mp4', size: MAX_SYNC_BYTES + 1 },
  ];
  const remote = new Map([
    ['p/2024/01/same.jpg', { size: 5, etag: 'abc' }],
    ['p/2024/01/resized.jpg', { size: 4, etag: 'def' }],
  ]);
  const plan = planSync(local, remote, { prefix: 'p/' });
  assert.deepEqual(plan.upload.map((f) => f.rel), ['2024/01/new.jpg']);
  assert.deepEqual(plan.changed.map((f) => f.rel), ['2024/01/resized.jpg']);
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.tooLarge.map((f) => f.rel), ['2024/01/huge.mp4']);
  assert.deepEqual(plan.check, []);
});

test('plan with resync: resized files upload, same-size files are checked unless the ETag is multipart', () => {
  const local = [{ rel: 'a.jpg', size: 5 }, { rel: 'b.jpg', size: 5 }, { rel: 'c.jpg', size: 7 }];
  const remote = new Map([['a.jpg', { size: 5, etag: 'abc' }], ['b.jpg', { size: 5, etag: 'abc-3' }], ['c.jpg', { size: 2, etag: 'x' }]]);
  const plan = planSync(local, remote, { resync: true });
  assert.deepEqual(plan.check.map((f) => [f.rel, f.etag]), [['a.jpg', 'abc']]);
  assert.deepEqual(plan.upload.map((f) => f.rel), ['c.jpg']);
  assert.deepEqual(plan.changed, []);
  assert.equal(plan.unchanged, 1);
});

test('plan: a file of exactly MAX_SYNC_BYTES is too large (it cannot be read whole)', () => {
  const plan = planSync([{ rel: 'big.mp4', size: MAX_SYNC_BYTES }, { rel: 'ok.mp4', size: MAX_SYNC_BYTES - 1 }], new Map());
  assert.deepEqual(plan.tooLarge.map((f) => f.rel), ['big.mp4']);
  assert.deepEqual(plan.upload.map((f) => f.rel), ['ok.mp4']);
});

test('sync lists the bucket, uploads what is missing or changed, never deletes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-sync-'));
  const up = path.join(root, 'wp-content', 'uploads', '2024', '01');
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, 'same.jpg'), 'SAME!');
  fs.writeFileSync(path.join(up, 'edited.jpg'), 'NEW!!');
  fs.writeFileSync(path.join(up, 'new.png'), 'PNG');
  fs.writeFileSync(path.join(up, 'resized.jpg'), 'LONGER');
  fs.writeFileSync(path.join(up, 'x.php'), '<?php');
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const listing = `<ListBucketResult><IsTruncated>false</IsTruncated>
<Contents><Key>s/2024/01/same.jpg</Key><Size>5</Size><ETag>"${md5('SAME!')}"</ETag></Contents>
<Contents><Key>s/2024/01/edited.jpg</Key><Size>5</Size><ETag>"${md5('OLD!!')}"</ETag></Contents>
<Contents><Key>s/2024/01/resized.jpg</Key><Size>2</Size><ETag>"x"</ETag></Contents>
<Contents><Key>s/2023/12/only-remote.jpg</Key><Size>1</Size><ETag>"x"</ETag></Contents></ListBucketResult>`;
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (req) => {
    calls.push({ method: req.method, path: new URL(req.url).pathname, type: req.headers.get('content-type') });
    return req.method === 'GET' ? new Response(listing) : new Response('', { status: 200 });
  };
  t.after(() => (globalThis.fetch = orig));
  const s3 = { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'media', accessKeyId: 'A', secretAccessKey: 'S', prefix: 's' };
  const progress = [];
  const plain = await syncUploads({ root, s3 });
  let puts = calls.filter((c) => c.method === 'PUT');
  assert.deepEqual(puts.map((c) => c.path), ['/media/s/2024/01/new.png']);
  assert.equal(puts[0].type, 'image/png');
  assert.deepEqual(plain, { uploaded: 1, unchanged: 2, changed: 1, bytes: 3, tooLarge: [] });
  calls.length = 0;
  const r = await syncUploads({ root, s3, resync: true, onProgress: (done, total) => progress.push([done, total]) });
  puts = calls.filter((c) => c.method === 'PUT');
  assert.deepEqual(puts.map((c) => c.path).sort(), ['/media/s/2024/01/edited.jpg', '/media/s/2024/01/new.png', '/media/s/2024/01/resized.jpg']);
  assert.ok(!calls.some((c) => c.method === 'DELETE'));
  assert.deepEqual(r, { uploaded: 3, unchanged: 1, changed: 0, bytes: 14, tooLarge: [] });
  assert.deepEqual(progress.at(-1), [3, 3]);
});

test('sync of a site without an uploads folder does nothing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-sync-'));
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
  t.after(() => (globalThis.fetch = orig));
  const r = await syncUploads({ root, s3: { endpoint: 'https://e.test', region: 'auto', bucket: 'b', accessKeyId: 'A', secretAccessKey: 'S' } });
  assert.deepEqual(r, { uploaded: 0, unchanged: 0, changed: 0, bytes: 0, tooLarge: [] });
});
