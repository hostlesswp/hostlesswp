import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMediaStorage, probeS3, workerBindings } from '../lib/media-storage.mjs';
import { openSiteConfig, readSiteConfig } from '../lib/config.mjs';
import { createUI } from '../lib/ui.mjs';
import { s3FromEnv } from '../runtime/src/media.js';
import { createS3 } from '../runtime/src/s3.js';

const S3 = { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'media', accessKeyId: 'AKID', secretAccessKey: 'SECRET', prefix: 'site', publicUrl: '', forcePathStyle: true, maxUploadMb: 32 };

// The wizard prints through clack; keep that off stdout, which the test runner uses to talk to this process.
function silenceUi(t) {
  const orig = process.stdout.write;
  process.stdout.write = () => true;
  t.after(() => (process.stdout.write = orig));
}

function mockFetch(t, handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (req) => {
    calls.push(req);
    return handler(req, calls.length);
  };
  t.after(() => (globalThis.fetch = orig));
  return calls;
}
const okS3 = (req) => {
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '10' } });
  if (req.method === 'GET') return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
  return new Response('', { status: 200 });
};

test('worker bindings round-trip to the same client', () => {
  const { vars, secrets } = workerBindings(S3);
  assert.equal(vars.S3_MAX_UPLOAD_MB, '32');
  assert.equal(vars.S3_FORCE_PATH_STYLE, '1');
  assert.ok(!Object.values(vars).includes('SECRET'));
  assert.deepEqual(secrets, { S3_ACCESS_KEY_ID: 'AKID', S3_SECRET_ACCESS_KEY: 'SECRET' });
  assert.equal(s3FromEnv({ ...vars, ...secrets }).objectUrl('k.jpg'), createS3(S3).objectUrl('k.jpg'));
});

test('probe runs put, head, list, delete on the probe key', async (t) => {
  const calls = mockFetch(t, okS3);
  await probeS3(S3);
  assert.deepEqual(calls.map((c) => c.method), ['PUT', 'HEAD', 'GET', 'DELETE']);
  assert.equal(new URL(calls[0].url).pathname, '/media/site/.hostlesswp-probe');
});

test('probe failure names the step and a likely cause', async (t) => {
  mockFetch(t, () => new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 }));
  await assert.rejects(probeS3(S3), (e) => /write \(PutObject\)/.test(e.message) && /not found/.test(e.message));
});

test('non-interactive: env keys and flags fill the config, defaults are set, probe runs', async (t) => {
  silenceUi(t);
  const calls = mockFetch(t, okS3);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-ms-'));
  process.env.HOSTLESSWP_S3_ACCESS_KEY_ID = 'AKID';
  process.env.HOSTLESSWP_S3_SECRET_ACCESS_KEY = 'SECRET';
  t.after(() => {
    delete process.env.HOSTLESSWP_S3_ACCESS_KEY_ID;
    delete process.env.HOSTLESSWP_S3_SECRET_ACCESS_KEY;
  });
  const flags = { yes: true, 's3-endpoint': S3.endpoint, 's3-bucket': 'media' };
  const ui = createUI(flags);
  ui.useConfig(openSiteConfig(root));
  const s3 = await ensureMediaStorage(ui, flags);
  assert.equal(s3.region, 'auto');
  assert.equal(s3.prefix, '');
  assert.equal(s3.publicUrl, '');
  assert.equal(s3.forcePathStyle, true);
  assert.equal(s3.maxUploadMb, 32);
  assert.equal(readSiteConfig(root).s3.secretAccessKey, 'SECRET');
  assert.equal(calls.length, 4);
});

test('complete saved config: nothing asked, no probe unless requested', async (t) => {
  silenceUi(t);
  const calls = mockFetch(t, okS3);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-ms-'));
  const config = openSiteConfig(root);
  config.set('s3', S3);
  const ui = createUI({ yes: true });
  ui.useConfig(config);
  assert.deepEqual(await ensureMediaStorage(ui, { yes: true }), S3);
  assert.equal(calls.length, 0);
  await ensureMediaStorage(ui, { yes: true }, { probe: true });
  assert.equal(calls.length, 4);
});

test('missing secret without a terminal names the environment variable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-ms-'));
  const flags = { yes: true, 's3-endpoint': S3.endpoint, 's3-bucket': 'media' };
  const ui = createUI(flags);
  ui.useConfig(openSiteConfig(root));
  await assert.rejects(ensureMediaStorage(ui, flags), /HOSTLESSWP_S3_ACCESS_KEY_ID/);
});
