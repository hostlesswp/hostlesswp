// Full-page cache for anonymous visitors, kept in Workers KV (binding PAGE_CACHE). A hit is answered without starting
// PHP, so it costs milliseconds even on a fresh isolate; a cold PHP start costs seconds.
//
// Invalidation is a site-wide version: the runtime mu-plugin bumps it (op `cache-bump`) when content changes, and a
// deploy changes the build id. Pages stored under another version are served once more while the new one renders in
// the background (stale-while-revalidate), so visitors never wait for PHP unless a page was never cached.

export const VERSION_KEY = 'v';
// WordPress nonces for visitors last 12 to 24 hours; older pages would carry forms that no longer submit.
export const MAX_AGE_MS = 8 * 3600e3;
const MAX_BYTES = 5 * 1048576;
// Internal marker set by the Worker when PHP asked not to cache (DONOTCACHEPAGE); never reaches the visitor.
export const NOCACHE_HEADER = 'x-hostlesswp-nocache';

const SKIP_PATHS = /^\/(wp-admin(\/|$)|wp-json(\/|$)|wp-login\.php|xmlrpc\.php|wp-cron\.php|wp-comments-post\.php|wp-signup\.php|wp-activate\.php|wp-trackback\.php)/;
// Requests that act or show something personal even without a cookie.
const SKIP_PARAMS = new Set(['s', 'preview', 'preview_id', 'preview_nonce', 'p_preview', 'rest_route', 'add-to-cart', 'remove_item', 'undo_item', 'wc-ajax', 'wc-api', 'customize_changeset_uuid', 'customize_theme', 'customize_messenger_channel', 'doing_wp_cron', 'action', '_wpnonce', 'nonce', 'key', 'unapproved', 'moderation-hash']);
// Logged-in users, commenters, password-protected posts and shoppers with a cart or session.
const SKIP_COOKIES = /(^|;\s*)(wordpress_logged_in_|wordpress_sec_|wp-postpass_|comment_author_|woocommerce_items_in_cart|woocommerce_cart_hash|wp_woocommerce_session_)/;
// Tracking parameters do not change the page; dropping them keeps one entry per page.
const IGNORED_PARAMS = /^(utm_\w+|fbclid|gclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_ga|_gl|ref)$/;
const CACHEABLE_TYPES = /^(text\/html|application\/(rss|atom|rdf)\+xml|application\/xml|text\/xml)\b/i;
const KEPT_HEADERS = ['content-type', 'location', 'x-robots-tag', 'content-language', 'link'];

// Why a request must go to PHP, or null when the cache may answer it.
export function bypassReason(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return 'method';
  const url = new URL(request.url);
  if (SKIP_PATHS.test(url.pathname)) return 'path';
  for (const k of url.searchParams.keys()) if (SKIP_PARAMS.has(k)) return 'query';
  if (SKIP_COOKIES.test(request.headers.get('cookie') || '')) return 'cookie';
  if (request.headers.has('authorization')) return 'auth';
  return null;
}

// "Reload without cache" in a browser, and hostlesswp's own deploy check: render fresh, then store the result.
const wantsRefresh = (request) => /no-cache/i.test(request.headers.get('cache-control') || '') || /no-cache/i.test(request.headers.get('pragma') || '');

export function cacheUrl(request) {
  const url = new URL(request.url);
  const params = [...url.searchParams].filter(([k]) => !IGNORED_PARAMS.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const q = new URLSearchParams(params).toString();
  return url.host + url.pathname + (q ? '?' + q : '');
}

async function keyFor(request) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cacheUrl(request)));
  return 'p:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function storable(res) {
  if (res.status !== 200 && res.status !== 301) return false;
  if (res.headers.has('set-cookie') || res.headers.has(NOCACHE_HEADER)) return false;
  if (/no-cache|no-store|private/i.test(res.headers.get('cache-control') || '')) return false;
  return res.status === 301 || CACHEABLE_TYPES.test(res.headers.get('content-type') || '');
}

async function currentVersion(kv, build) {
  return build + ':' + ((await kv.get(VERSION_KEY)) || '0');
}

export async function bumpVersion(env) {
  if (!env.PAGE_CACHE) return;
  // KV allows one write per second per key; a failed bump within that second is covered by the one that succeeded.
  await env.PAGE_CACHE.put(VERSION_KEY, Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).catch((e) => console.log('page cache bump failed', String(e.message || e)));
}

function withCacheHeader(res, state, extra = {}) {
  const headers = new Headers(res.headers);
  headers.delete(NOCACHE_HEADER);
  headers.set('x-hostlesswp-cache', state);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function store(kv, key, version, res) {
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return;
  const h = {};
  for (const name of KEPT_HEADERS) if (res.headers.has(name)) h[name] = res.headers.get(name);
  let meta = { v: version, t: Date.now(), s: res.status, h };
  // KV metadata is limited to 1024 bytes; Link headers are the only long ones and are not needed to show the page.
  if (JSON.stringify(meta).length > 1000) delete h.link;
  if (JSON.stringify(meta).length > 1000) return;
  await kv.put(key, body, { metadata: meta, expirationTtl: Math.ceil(MAX_AGE_MS / 1000) + 3600 });
}

// Renders the page and stores it when it is cacheable; the visitor gets the response right away.
async function renderAndStore(request, render, kv, key, version, ctx) {
  const res = await render(request);
  if (request.method !== 'GET' || !storable(res)) return withCacheHeader(res, request.method === 'GET' ? 'skip' : 'miss');
  const [toVisitor, toCache] = res.body ? res.body.tee() : [null, null];
  const out = new Response(toVisitor, res);
  ctx.waitUntil(store(kv, key, version, new Response(toCache, res)).catch((e) => console.log('page cache store failed', String(e.message || e))));
  return withCacheHeader(out, 'miss');
}

const refreshing = new Set();

// Answers from the cache when it can; otherwise calls render(request) (the PHP runtime) and fills the cache.
export async function servePage(request, env, ctx, render, build) {
  const kv = env.PAGE_CACHE;
  if (!kv) return withCacheHeader(await render(request), 'off');
  const reason = bypassReason(request);
  if (reason) return withCacheHeader(await render(request), 'bypass');
  const key = await keyFor(request);
  let version;
  let entry;
  try {
    [version, entry] = await Promise.all([currentVersion(kv, build), wantsRefresh(request) ? null : kv.getWithMetadata(key, 'stream')]);
  } catch (e) {
    console.log('page cache read failed', String(e.message || e));
    return withCacheHeader(await render(request), 'error');
  }
  const meta = entry && entry.value ? entry.metadata : null;
  if (!meta || Date.now() - meta.t > MAX_AGE_MS) {
    if (entry && entry.value) entry.value.cancel().catch(() => {});
    return renderAndStore(request, render, kv, key, version, ctx);
  }
  const state = meta.v === version ? 'hit' : 'stale';
  if (state === 'stale' && !refreshing.has(key)) {
    // One background render per page and isolate; it uses the same PHP queue as visitors' requests.
    refreshing.add(key);
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    const anon = new Request(request.url, { method: 'GET', headers });
    ctx.waitUntil(
      render(anon)
        .then((res) => (storable(res) ? store(kv, key, version, res) : res.body && res.body.cancel()))
        .catch((e) => console.log('page cache refresh failed', String(e.message || e)))
        .finally(() => refreshing.delete(key)),
    );
  }
  const headers = new Headers(meta.h);
  headers.set('x-hostlesswp-cache', state);
  headers.set('age', String(Math.max(0, Math.round((Date.now() - meta.t) / 1000))));
  if (request.method === 'HEAD') entry.value.cancel().catch(() => {});
  return new Response(request.method === 'HEAD' ? null : entry.value, { status: meta.s, headers });
}

// Renders url into the cache unless a current copy is there (the Cron Trigger keeps the front page warm).
export async function warmPage(url, env, ctx, render, build) {
  const kv = env.PAGE_CACHE;
  if (!kv) return 'off';
  const request = new Request(url);
  const key = await keyFor(request);
  const [version, entry] = await Promise.all([currentVersion(kv, build), kv.getWithMetadata(key, 'stream')]);
  if (entry && entry.value) entry.value.cancel().catch(() => {});
  if (entry && entry.metadata && entry.metadata.v === version && Date.now() - entry.metadata.t < MAX_AGE_MS / 2) return 'fresh';
  const res = await render(request);
  if (!storable(res)) {
    if (res.body) await res.body.cancel();
    return 'skip';
  }
  await store(kv, key, version, res);
  return 'stored';
}
