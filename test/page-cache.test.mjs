import test from 'node:test';
import assert from 'node:assert/strict';
import { servePage, warmPage, bumpVersion, bypassReason, cacheUrl, storable, MAX_AGE_MS, NOCACHE_HEADER } from '../runtime/src/page-cache.js';

// Workers KV with the calls page-cache.js makes; values are kept as bytes.
function fakeKV() {
  const map = new Map();
  return {
    map,
    async get(key) {
      const e = map.get(key);
      return e ? new TextDecoder().decode(e.value) : null;
    },
    async getWithMetadata(key) {
      const e = map.get(key);
      return e ? { value: new Response(e.value).body, metadata: e.metadata } : { value: null, metadata: null };
    },
    async put(key, value, opts = {}) {
      map.set(key, { value: typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value), metadata: opts.metadata || null });
    },
  };
}

function setup() {
  const env = { PAGE_CACHE: fakeKV() };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const renders = [];
  let body = 'page 1';
  let headers = { 'content-type': 'text/html; charset=UTF-8' };
  const render = async (req) => {
    renders.push(req);
    return new Response(req.method === 'HEAD' ? null : body, { status: 200, headers });
  };
  return {
    env,
    ctx,
    renders,
    setBody: (b) => (body = b),
    setHeaders: (h) => (headers = h),
    serve: async (url, init) => {
      const res = await servePage(new Request(url, init), env, ctx, render, 'build1');
      const text = await res.text();
      await Promise.all(waits.splice(0));
      return { res, text, state: res.headers.get('x-hostlesswp-cache') };
    },
  };
}

test('anonymous page views are rendered once, then answered from the cache', async () => {
  const s = setup();
  const a = await s.serve('https://ex.com/hello/');
  assert.equal(a.state, 'miss');
  assert.equal(a.text, 'page 1');
  const b = await s.serve('https://ex.com/hello/');
  assert.equal(b.state, 'hit');
  assert.equal(b.text, 'page 1');
  assert.equal(b.res.headers.get('content-type'), 'text/html; charset=UTF-8');
  assert.equal(s.renders.length, 1);
  const head = await s.serve('https://ex.com/hello/', { method: 'HEAD' });
  assert.equal(head.state, 'hit');
  assert.equal(head.text, '');
  assert.equal(s.renders.length, 1);
});

test('tracking parameters share the entry, other parameters do not', async () => {
  assert.equal(cacheUrl(new Request('https://ex.com/a/?utm_source=x&b=2&a=1&fbclid=z')), 'ex.com/a/?a=1&b=2');
  const s = setup();
  await s.serve('https://ex.com/a/?utm_source=news');
  assert.equal((await s.serve('https://ex.com/a/')).state, 'hit');
  assert.equal((await s.serve('https://ex.com/a/?page=2')).state, 'miss');
});

test('logged-in users, carts, admin, searches and writes go to PHP', async () => {
  const cases = [
    [{ method: 'POST' }, 'https://ex.com/', 'method'],
    [{}, 'https://ex.com/wp-admin/', 'path'],
    [{}, 'https://ex.com/wp-login.php', 'path'],
    [{}, 'https://ex.com/wp-json/wp/v2/posts', 'path'],
    [{}, 'https://ex.com/?s=hello', 'query'],
    [{}, 'https://ex.com/shop/?add-to-cart=12', 'query'],
    [{}, 'https://ex.com/?rest_route=/wp/v2', 'query'],
    [{ headers: { cookie: 'a=1; wordpress_logged_in_abc=x' } }, 'https://ex.com/', 'cookie'],
    [{ headers: { cookie: 'woocommerce_items_in_cart=1' } }, 'https://ex.com/', 'cookie'],
    [{ headers: { cookie: 'wp-postpass_abc=x' } }, 'https://ex.com/', 'cookie'],
    [{ headers: { authorization: 'Basic x' } }, 'https://ex.com/', 'auth'],
  ];
  for (const [init, url, reason] of cases) assert.equal(bypassReason(new Request(url, init)), reason, url);
  // Analytics cookies alone do not personalize the page.
  assert.equal(bypassReason(new Request('https://ex.com/', { headers: { cookie: '_ga=1; wordpress_test_cookie=WP' } })), null);
  const s = setup();
  await s.serve('https://ex.com/');
  const r = await s.serve('https://ex.com/', { headers: { cookie: 'wordpress_logged_in_abc=x' } });
  assert.equal(r.state, 'bypass');
  assert.equal(s.renders.length, 2);
});

test('responses that set cookies, opt out or are not pages are never stored', async () => {
  const html = { 'content-type': 'text/html' };
  assert.equal(storable(new Response('x', { headers: html })), true);
  assert.equal(storable(new Response('x', { headers: { ...html, 'set-cookie': 'a=1' } })), false);
  assert.equal(storable(new Response('x', { headers: { ...html, 'cache-control': 'no-cache, must-revalidate, max-age=0' } })), false);
  assert.equal(storable(new Response('x', { headers: { ...html, [NOCACHE_HEADER]: '1' } })), false);
  assert.equal(storable(new Response('x', { status: 404, headers: html })), false);
  assert.equal(storable(new Response('{}', { headers: { 'content-type': 'application/json' } })), false);
  assert.equal(storable(new Response('<rss/>', { headers: { 'content-type': 'application/rss+xml; charset=UTF-8' } })), true);
  assert.equal(storable(new Response(null, { status: 301, headers: { location: 'https://ex.com/b/' } })), true);

  const s = setup();
  s.setHeaders({ 'content-type': 'text/html', [NOCACHE_HEADER]: '1' });
  const r = await s.serve('https://ex.com/cart/');
  assert.equal(r.state, 'skip');
  assert.equal(r.res.headers.has(NOCACHE_HEADER), false, 'the internal marker never reaches the visitor');
  assert.equal(s.env.PAGE_CACHE.map.size, 0);
});

test('after a version bump the old page is served once more while it renders again', async () => {
  const s = setup();
  await s.serve('https://ex.com/post/');
  s.setBody('page 2');
  await bumpVersion(s.env);
  const stale = await s.serve('https://ex.com/post/');
  assert.equal(stale.state, 'stale');
  assert.equal(stale.text, 'page 1');
  assert.equal(s.renders.length, 2, 'rendered again in the background');
  assert.equal(s.renders[1].headers.has('cookie'), false);
  const fresh = await s.serve('https://ex.com/post/');
  assert.equal(fresh.state, 'hit');
  assert.equal(fresh.text, 'page 2');
});

test('a new build outdates every page, and old pages expire', async (t) => {
  const s = setup();
  await s.serve('https://ex.com/');
  const kv = s.env.PAGE_CACHE;
  const other = await servePage(new Request('https://ex.com/'), s.env, s.ctx, async () => new Response('new', { headers: { 'content-type': 'text/html' } }), 'build2');
  assert.equal(other.headers.get('x-hostlesswp-cache'), 'stale');
  await other.text();

  const [entry] = [...kv.map.values()].filter((e) => e.metadata);
  entry.metadata.t = Date.now() - MAX_AGE_MS - 1000;
  const expired = await s.serve('https://ex.com/');
  assert.equal(expired.state, 'miss', 'pages older than the nonce lifetime are rendered again before answering');
});

test('a forced reload renders fresh and refreshes the cache', async () => {
  const s = setup();
  await s.serve('https://ex.com/');
  s.setBody('page 2');
  const r = await s.serve('https://ex.com/', { headers: { 'cache-control': 'no-cache' } });
  assert.equal(r.state, 'miss');
  assert.equal(r.text, 'page 2');
  assert.equal((await s.serve('https://ex.com/')).text, 'page 2');
});

test('without the KV binding every request goes to PHP', async () => {
  const res = await servePage(new Request('https://ex.com/'), {}, { waitUntil() {} }, async () => new Response('x', { headers: { [NOCACHE_HEADER]: '1' } }), 'b');
  assert.equal(res.headers.get('x-hostlesswp-cache'), 'off');
  assert.equal(res.headers.has(NOCACHE_HEADER), false);
  await bumpVersion({});
});

test('warming renders only when the cached front page is missing or outdated', async () => {
  const s = setup();
  const render = async () => new Response('home', { headers: { 'content-type': 'text/html' } });
  assert.equal(await warmPage('https://ex.com/', s.env, s.ctx, render, 'build1'), 'stored');
  assert.equal(await warmPage('https://ex.com/', s.env, s.ctx, render, 'build1'), 'fresh');
  await bumpVersion(s.env);
  assert.equal(await warmPage('https://ex.com/', s.env, s.ctx, render, 'build1'), 'stored');
  assert.equal((await s.serve('https://ex.com/')).state, 'hit');
  assert.equal(await warmPage('https://ex.com/', {}, s.ctx, render, 'build1'), 'off');
});
