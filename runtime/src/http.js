// Requests from the curl and http:// stream polyfills (runtime/php/hostlesswp-http.php), all sent at once.
export async function fetchOne(req) {
  try {
    const headers = new Headers();
    for (const [k, v] of req.headers || []) headers.append(k, v);
    const method = (req.method || 'GET').toUpperCase();
    const res = await fetch(req.url, {
      method,
      headers,
      body: req.body != null && !['GET', 'HEAD'].includes(method) ? Uint8Array.from(atob(req.body), (c) => c.charCodeAt(0)) : undefined,
      redirect: req.follow ? 'follow' : 'manual',
      signal: AbortSignal.timeout(Math.min(30, Math.max(1, req.timeout || 30)) * 1000),
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    // fetch() already inflated a compressed body: report it as sent without the encoding.
    const decoded = res.headers.has('content-encoding');
    const out = [];
    res.headers.forEach((v, k) => {
      if (k === 'set-cookie' || (decoded && k === 'content-encoding')) return;
      out.push([k, decoded && k === 'content-length' ? String(buf.length) : v]);
    });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) out.push(['set-cookie', c]);
    return { status: res.status, reason: res.statusText, url: res.url || req.url, redirected: res.redirected, headers: out, body: btoa(bin) };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e), timeout: !!e && e.name === 'TimeoutError' };
  }
}

// DNS-over-HTTPS answers (runtime/php/hostlesswp-dns.php) are kept for their TTL, so a lookup is not repeated on
// every request this instance serves.
const DOH = 'https://cloudflare-dns.com/dns-query?';
const dohCache = new Map();

export async function fetchCached(req, fetcher = fetchOne, now = Date.now()) {
  if (!req.url.startsWith(DOH) || (req.method && req.method.toUpperCase() !== 'GET')) return fetcher(req);
  const hit = dohCache.get(req.url);
  if (hit && hit.until > now) return hit.res;
  const res = await fetcher(req);
  let ttl = 0;
  try {
    const json = res.status === 200 ? JSON.parse(atob(res.body)) : null;
    // A name that does not exist is kept for a minute; failed lookups are not kept.
    if (json && json.Status === 0) ttl = Math.min(3600, ...(json.Answer || []).map((a) => a.TTL), json.Answer && json.Answer.length ? 3600 : 60);
    else if (json && json.Status === 3) ttl = 60;
  } catch {}
  if (ttl > 0) {
    dohCache.delete(req.url);
    if (dohCache.size >= 500) dohCache.delete(dohCache.keys().next().value);
    dohCache.set(req.url, { res, until: now + ttl * 1000 });
  } else dohCache.delete(req.url);
  return res;
}
