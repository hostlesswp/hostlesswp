// Media for the Worker: wp-content/uploads lives in an S3-compatible bucket, because the Worker file system does not
// persist. PHP keeps using the usual folder in memory; after each request new files go to the bucket and are dropped
// from memory, originals PHP needs (image editing, regenerating sizes) are fetched on demand, and media URLs are
// served straight from the bucket without starting PHP.
import { createS3, isServableUpload, contentTypeFor } from './s3.js';

export const UPLOADS = '/wordpress/wp-content/uploads';
export const UPLOADS_URL = '/wp-content/uploads/';

let cached = null;
export function s3FromEnv(env) {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return null;
  const sig = [env.S3_ENDPOINT, env.S3_REGION, env.S3_BUCKET, env.S3_PREFIX, env.S3_FORCE_PATH_STYLE, env.S3_ACCESS_KEY_ID].join('|');
  if (cached?.sig !== sig) {
    cached = {
      sig,
      s3: createS3({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, prefix: env.S3_PREFIX, forcePathStyle: env.S3_FORCE_PATH_STYLE !== '0' }),
    };
  }
  return cached.s3;
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const PASS_REQUEST = ['range', 'if-none-match', 'if-modified-since'];
const PASS_RESPONSE = ['content-length', 'content-range', 'etag', 'last-modified', 'accept-ranges'];

export async function serveUpload(request, env, ctx, { cache = globalThis.caches?.default } = {}) {
  const url = new URL(request.url);
  let rel;
  try {
    rel = decodeURIComponent(url.pathname.slice(UPLOADS_URL.length));
  } catch {
    return notFound();
  }
  const s3 = s3FromEnv(env);
  if (!s3 || !isServableUpload(rel)) return notFound();
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  const ranged = request.headers.has('range');
  const cacheKey = new Request(url.origin + url.pathname);
  if (cache && !ranged) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const inm = request.headers.get('if-none-match');
      if (inm && inm === hit.headers.get('etag')) return new Response(null, { status: 304, headers: hit.headers });
      return request.method === 'HEAD' ? new Response(null, hit) : hit;
    }
  }
  const headers = {};
  for (const h of PASS_REQUEST) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  const res = await s3.get(s3.keyFor(rel), headers, request.method);
  // Without ListBucket permission S3 answers 403 for a missing key.
  if (res.status === 404 || res.status === 403) {
    if (res.status === 403) console.log('media 403 from storage', rel);
    return notFound();
  }
  if (![200, 206, 304].includes(res.status)) {
    console.log('media storage error', res.status, rel);
    return new Response('Media storage unavailable', { status: 502 });
  }
  const out = new Headers();
  for (const h of PASS_RESPONSE) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set('content-type', contentTypeFor(rel));
  out.set('x-content-type-options', 'nosniff');
  // Not immutable: plugins rewrite their own files under the same name (CSS caches).
  out.set('cache-control', 'public, max-age=86400');
  const response = new Response(request.method === 'HEAD' || res.status === 304 ? null : res.body, { status: res.status, headers: out });
  if (cache && request.method === 'GET' && res.status === 200) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function listFiles(FS, dir, rel = '', out = []) {
  let names;
  try {
    names = FS.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const full = dir + '/' + name;
    const r = rel ? rel + '/' + name : name;
    if (FS.isDir(FS.stat(full).mode)) listFiles(FS, full, r, out);
    else out.push({ path: full, rel: r });
  }
  return out;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// fetched: originals pulled in by s3get, by path, with their bytes. Compared by content, not mtime: the Worker clock
// stands still during CPU work, so an edit can keep the same mtime.
export async function flushUploads(FS, s3, fetched) {
  const files = listFiles(FS, UPLOADS);
  try {
    const changed = files.filter((f) => isServableUpload(f.rel) && !(fetched.has(f.path) && sameBytes(fetched.get(f.path), FS.readFile(f.path))));
    if (!changed.length) return { uploaded: 0, dropped: 0 };
    if (!s3) {
      console.log('media storage is not configured; dropped', changed.length, 'file(s)');
      return { uploaded: 0, dropped: changed.length };
    }
    await Promise.all(changed.map((f) => s3.put(s3.keyFor(f.rel), FS.readFile(f.path), contentTypeFor(f.rel))));
    return { uploaded: changed.length, dropped: 0 };
  } finally {
    for (const f of files) FS.unlink(f.path);
    fetched.clear();
  }
}

const relOf = (p) => {
  const s = String(p || '').replace(/\/+$/, '');
  if (s === UPLOADS) return '';
  return s.startsWith(UPLOADS + '/') ? s.slice(UPLOADS.length + 1) : null;
};

// Requests from hostlesswp-runtime.php (post_message_to_js); paths are absolute in the in-memory file system.
export async function mediaBridge(msg, { FS, s3, fetched }) {
  if (!s3) return JSON.stringify({ error: 'media storage is not configured' });
  try {
    if (msg.op === 's3list') {
      const rel = relOf(msg.dir);
      if (rel === null || rel.split('/').includes('..')) return JSON.stringify({ error: 'not an uploads folder: ' + msg.dir });
      const { keys } = await s3.list(s3.keyFor(rel ? rel + '/' : ''), { delimiter: '/' });
      return JSON.stringify({ files: keys.map((k) => k.key.slice(k.key.lastIndexOf('/') + 1)) });
    }
    const rel = relOf(msg.path);
    if (!rel || !isServableUpload(rel)) return JSON.stringify({ error: 'not a media file: ' + msg.path });
    if (msg.op === 's3get') {
      const res = await s3.get(s3.keyFor(rel));
      if (res.status === 404 || res.status === 403) return JSON.stringify({ found: false });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = new Uint8Array(await res.arrayBuffer());
      FS.mkdirTree(msg.path.slice(0, msg.path.lastIndexOf('/')));
      FS.writeFile(msg.path, data);
      fetched.set(msg.path, data.slice());
      return JSON.stringify({ found: true });
    }
    if (msg.op === 's3delete') {
      await s3.del(s3.keyFor(rel));
      return JSON.stringify({ ok: true });
    }
    return JSON.stringify({ error: 'unknown media op ' + msg.op });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
}
