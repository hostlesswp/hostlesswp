import test from 'node:test';
import assert from 'node:assert/strict';
import { createS3, encodeKey, normalizePrefix, parseListXml, isServableUpload, contentTypeFor } from '../runtime/src/s3.js';

const CFG = { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'media', accessKeyId: 'AKID', secretAccessKey: 'SECRET' };

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

test('servable upload paths', () => {
  assert.ok(isServableUpload('2026/10/photo.jpg'));
  assert.ok(isServableUpload('2026/10/noext'));
  assert.ok(!isServableUpload('2026/10/shell.php'));
  assert.ok(!isServableUpload('2026/10/.htaccess'));
  assert.ok(!isServableUpload('../wp-config.jpg'));
  assert.ok(!isServableUpload('2026//a.jpg'));
  assert.ok(!isServableUpload('wc-logs/error_log'));
  assert.ok(!isServableUpload('2026/10/readme.TXT'));
});

test('content types by extension', () => {
  assert.equal(contentTypeFor('a/b.JPG'), 'image/jpeg');
  assert.equal(contentTypeFor('x.webp'), 'image/webp');
  assert.equal(contentTypeFor('x.unknown'), 'application/octet-stream');
});

test('prefix normalization', () => {
  assert.equal(normalizePrefix(''), '');
  assert.equal(normalizePrefix(undefined), '');
  assert.equal(normalizePrefix('/site-a/'), 'site-a/');
  assert.equal(normalizePrefix('site-a/uploads'), 'site-a/uploads/');
});

test('object urls: path-style, virtual-hosted, encoding', () => {
  const s3 = createS3({ ...CFG, prefix: 'site' });
  assert.equal(s3.keyFor('2026/10/a.jpg'), 'site/2026/10/a.jpg');
  assert.equal(s3.objectUrl("2026/10/a b(1)+é中!'*.jpg"), 'https://acct.r2.cloudflarestorage.com/media/2026/10/a%20b%281%29%2B%C3%A9%E4%B8%AD%21%27%2A.jpg');
  const vh = createS3({ ...CFG, endpoint: 'https://s3.us-east-1.amazonaws.com', forcePathStyle: false });
  assert.equal(vh.objectUrl('k.jpg'), 'https://media.s3.us-east-1.amazonaws.com/k.jpg');
  assert.equal(encodeKey('a/b c'), 'a/b%20c');
});

test('put signs with SigV4 for s3 and unsigned payload', async (t) => {
  const calls = mockFetch(t, () => new Response('', { status: 200 }));
  const s3 = createS3(CFG, { datetime: '20261014T000000Z' });
  await s3.put('2026/10/a b.jpg', new Uint8Array([1, 2, 3]), 'image/jpeg');
  const req = calls[0];
  assert.equal(req.method, 'PUT');
  assert.equal(req.url, 'https://acct.r2.cloudflarestorage.com/media/2026/10/a%20b.jpg');
  assert.equal(req.headers.get('content-type'), 'image/jpeg');
  assert.equal(req.headers.get('x-amz-content-sha256'), 'UNSIGNED-PAYLOAD');
  assert.equal(req.headers.get('x-amz-date'), '20261014T000000Z');
  assert.match(req.headers.get('authorization'), /^AWS4-HMAC-SHA256 Credential=AKID\/20261014\/auto\/s3\/aws4_request, SignedHeaders=[^,]*host[^,]*, Signature=[0-9a-f]{64}$/);
});

test('put failure carries status and S3 error code', async (t) => {
  mockFetch(t, () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
  const s3 = createS3(CFG);
  await assert.rejects(s3.put('k', new Uint8Array(1)), (e) => e.status === 403 && e.code === 'AccessDenied');
});

test('ListObjectsV2 parsing with entities and pagination', async (t) => {
  const page1 = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken>
<Contents><Key>p/a&amp;b.jpg</Key><Size>10</Size><ETag>&quot;abc&quot;</ETag></Contents>
<CommonPrefixes><Prefix>p/2026/</Prefix></CommonPrefixes></ListBucketResult>`;
  const page2 = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>p/c.png</Key><Size>5</Size><ETag>"d-2"</ETag></Contents></ListBucketResult>`;
  assert.deepEqual(parseListXml(page1), { keys: [{ key: 'p/a&b.jpg', size: 10, etag: 'abc' }], prefixes: ['p/2026/'], next: 'tok&1' });
  const calls = mockFetch(t, (req, n) => new Response(n === 1 ? page1 : page2));
  const s3 = createS3(CFG);
  const res = await s3.list('p/', { delimiter: '/' });
  assert.deepEqual(res.keys.map((k) => k.key), ['p/a&b.jpg', 'p/c.png']);
  assert.deepEqual(res.prefixes, ['p/2026/']);
  const u2 = new URL(calls[1].url);
  assert.equal(u2.searchParams.get('list-type'), '2');
  assert.equal(u2.searchParams.get('prefix'), 'p/');
  assert.equal(u2.searchParams.get('delimiter'), '/');
  assert.equal(u2.searchParams.get('continuation-token'), 'tok&1');
});

test('list with maxKeys stops after the first page', async (t) => {
  const calls = mockFetch(t, () => new Response('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>x</NextContinuationToken></ListBucketResult>'));
  await createS3(CFG).list('', { maxKeys: 1 });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get('max-keys'), '1');
});

test('head returns null on 404, size and etag otherwise', async (t) => {
  mockFetch(t, (req, n) => (n === 1 ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { 'content-length': '7', etag: '"e1"' } })));
  const s3 = createS3(CFG);
  assert.equal(await s3.head('missing'), null);
  assert.deepEqual(await s3.head('present'), { size: 7, etag: 'e1' });
});
