import test from 'node:test';
import assert from 'node:assert/strict';
import { s3FromEnv, serveUpload, flushUploads, mediaBridge, UPLOADS } from '../runtime/src/media.js';

const ENV = { S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', S3_REGION: 'auto', S3_BUCKET: 'media', S3_PREFIX: 'site', S3_FORCE_PATH_STYLE: '1', S3_ACCESS_KEY_ID: 'AKID', S3_SECRET_ACCESS_KEY: 'SECRET' };
const ctx = () => {
  const waits = [];
  return { waits, waitUntil: (p) => waits.push(p) };
};

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

// Minimal Emscripten-like FS: files in a Map, directories implied.
function fakeFS(files = {}) {
  const map = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? new TextEncoder().encode(v) : v]));
  const isDirPath = (d) => [...map.keys()].some((k) => k.startsWith(d + '/'));
  return {
    map,
    readdir(d) {
      if (!isDirPath(d)) throw new Error('ENOENT');
      return ['.', '..', ...new Set([...map.keys()].filter((k) => k.startsWith(d + '/')).map((k) => k.slice(d.length + 1).split('/')[0]))];
    },
    stat: (p) => ({ mode: map.has(p) ? 1 : 2 }),
    isDir: (mode) => mode === 2,
    readFile: (p) => map.get(p),
    writeFile: (p, data) => map.set(p, data),
    unlink: (p) => map.delete(p),
    mkdirTree() {},
  };
}

function fakeCache() {
  const store = new Map();
  return { store, match: async (req) => store.get(req.url)?.clone(), put: async (req, res) => store.set(req.url, res) };
}

test('s3FromEnv: null without credentials, keys use the prefix', () => {
  assert.equal(s3FromEnv({ S3_BUCKET: 'b' }), null);
  assert.equal(s3FromEnv(ENV).keyFor('2026/10/a.jpg'), 'site/2026/10/a.jpg');
});

test('serveUpload: 200 from the bucket, cached, then served from cache', async (t) => {
  const calls = mockFetch(t, () => new Response('IMG', { status: 200, headers: { etag: '"e1"', 'content-length': '3' } }));
  const cache = fakeCache();
  const c = ctx();
  const res = await serveUpload(new Request('https://site.test/wp-content/uploads/2026/10/a%20b.jpg'), ENV, c, { cache });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'IMG');
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(calls[0].url, 'https://acct.r2.cloudflarestorage.com/media/site/2026/10/a%20b.jpg');
  await Promise.all(c.waits);
  const again = await serveUpload(new Request('https://site.test/wp-content/uploads/2026/10/a%20b.jpg', { headers: { 'if-none-match': '"e1"' } }), ENV, ctx(), { cache });
  assert.equal(again.status, 304);
  assert.equal(calls.length, 1);
});

test('serveUpload: 404 and 403 from the bucket are 404; 5xx is 502', async (t) => {
  let status = 404;
  mockFetch(t, () => new Response('', { status }));
  const get = () => serveUpload(new Request('https://site.test/wp-content/uploads/x.jpg'), ENV, ctx(), { cache: null });
  assert.equal((await get()).status, 404);
  status = 403;
  assert.equal((await get()).status, 404);
  status = 503;
  assert.equal((await get()).status, 502);
});

test('serveUpload: range passes through, skips the cache', async (t) => {
  const calls = mockFetch(t, () => new Response('MG', { status: 206, headers: { 'content-range': 'bytes 1-2/3' } }));
  const cache = fakeCache();
  const c = ctx();
  const res = await serveUpload(new Request('https://site.test/wp-content/uploads/v.mp4', { headers: { range: 'bytes=1-2' } }), ENV, c, { cache });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 1-2/3');
  assert.equal(calls[0].headers.get('range'), 'bytes=1-2');
  assert.equal(c.waits.length, 0);
});

test('serveUpload: private paths and other methods never reach the bucket', async (t) => {
  const calls = mockFetch(t, () => new Response('x'));
  assert.equal((await serveUpload(new Request('https://site.test/wp-content/uploads/a.php'), ENV, ctx(), { cache: null })).status, 404);
  assert.equal((await serveUpload(new Request('https://site.test/wp-content/uploads/%2e%2e/x.jpg'), ENV, ctx(), { cache: null })).status, 404);
  assert.equal((await serveUpload(new Request('https://site.test/wp-content/uploads/a.jpg', { method: 'POST', body: 'x' }), ENV, ctx(), { cache: null })).status, 405);
  assert.equal(calls.length, 0);
});

test('flushUploads: uploads new and changed files, skips untouched originals, clears memory', async (t) => {
  const calls = mockFetch(t, () => new Response('', { status: 200 }));
  const orig = new Uint8Array([1, 2, 3]);
  const FS = fakeFS({ [UPLOADS + '/2026/10/new.jpg']: 'N', [UPLOADS + '/2026/10/orig.jpg']: orig, [UPLOADS + '/2026/10/edited.jpg']: 'E2', [UPLOADS + '/wc-logs/.htaccess']: 'deny' });
  const fetched = new Map([[UPLOADS + '/2026/10/orig.jpg', orig.slice()], [UPLOADS + '/2026/10/edited.jpg', new TextEncoder().encode('E1')]]);
  const r = await flushUploads(FS, s3FromEnv(ENV), fetched);
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname).sort(), ['/media/site/2026/10/edited.jpg', '/media/site/2026/10/new.jpg']);
  assert.equal(r.uploaded, 2);
  assert.equal(FS.map.size, 0);
  assert.equal(fetched.size, 0);
});

test('flushUploads: a failed write throws and still clears memory', async (t) => {
  mockFetch(t, () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
  const FS = fakeFS({ [UPLOADS + '/a.jpg']: 'A' });
  const fetched = new Map();
  await assert.rejects(flushUploads(FS, s3FromEnv(ENV), fetched), /AccessDenied/);
  assert.equal(FS.map.size, 0);
});

test('flushUploads: without storage, files are dropped and counted', async () => {
  const FS = fakeFS({ [UPLOADS + '/a.jpg']: 'A' });
  assert.deepEqual(await flushUploads(FS, null, new Map()), { uploaded: 0, dropped: 1 });
  assert.equal(FS.map.size, 0);
});

test('mediaBridge: list, get, delete, and path checks', async (t) => {
  const calls = mockFetch(t, (req) => {
    if (req.method === 'GET' && new URL(req.url).searchParams.get('list-type')) return new Response('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>site/2026/10/a.jpg</Key><Size>1</Size><ETag>"x"</ETag></Contents></ListBucketResult>');
    if (req.method === 'GET') return req.url.endsWith('missing.jpg') ? new Response('', { status: 404 }) : new Response('DATA');
    return new Response(null, { status: 204 });
  });
  const FS = fakeFS();
  const fetched = new Map();
  const deps = { FS, s3: s3FromEnv(ENV), fetched };
  assert.deepEqual(JSON.parse(await mediaBridge({ op: 's3list', dir: UPLOADS + '/2026/10' }, deps)), { files: ['a.jpg'] });
  assert.equal(new URL(calls[0].url).searchParams.get('prefix'), 'site/2026/10/');
  assert.deepEqual(JSON.parse(await mediaBridge({ op: 's3get', path: UPLOADS + '/2026/10/a.jpg' }, deps)), { found: true });
  assert.equal(new TextDecoder().decode(FS.map.get(UPLOADS + '/2026/10/a.jpg')), 'DATA');
  assert.ok(fetched.has(UPLOADS + '/2026/10/a.jpg'));
  assert.deepEqual(JSON.parse(await mediaBridge({ op: 's3get', path: UPLOADS + '/2026/10/missing.jpg' }, deps)), { found: false });
  assert.deepEqual(JSON.parse(await mediaBridge({ op: 's3delete', path: UPLOADS + '/2026/10/a.jpg' }, deps)), { ok: true });
  assert.ok(JSON.parse(await mediaBridge({ op: 's3get', path: '/wordpress/wp-config.php' }, deps)).error);
  assert.ok(JSON.parse(await mediaBridge({ op: 's3list', dir: UPLOADS + '/../x' }, deps)).error);
  assert.ok(JSON.parse(await mediaBridge({ op: 's3get', path: UPLOADS + '/a.jpg' }, { ...deps, s3: null })).error);
});
