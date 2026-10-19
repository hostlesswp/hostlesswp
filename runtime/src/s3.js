// S3-compatible object storage, shared by the Worker runtime (media) and the hostlesswp CLI (uploads sync).
// Any S3 API works (R2, AWS S3, MinIO, B2); requests are signed with aws4fetch.
import { AwsClient } from 'aws4fetch';

// Never published as static files or media, wherever they are.
export const PRIVATE_EXT = new Set(['.php', '.phtml', '.php5', '.phar', '.inc', '.html', '.txt', '.crt', '.md', '.map', '.sql', '.log', '.sh', '.env', '.ini', '.bak', '.old', '.orig', '.swp', '.po', '.pot', '.mo', '.lock']);
export const SKIP_NAMES = new Set(['.git', '.svn', '.hg', '.DS_Store', 'node_modules', '.htaccess', '.user.ini', 'error_log', 'php_errorlog']);

// rel: path inside wp-content/uploads. Rejects traversal, empty segments, dotfiles and anything executable or private.
export function isServableUpload(rel) {
  const parts = String(rel).split('/');
  if (parts.some((s) => !s || s.startsWith('.') || SKIP_NAMES.has(s))) return false;
  const base = parts[parts.length - 1];
  const dot = base.lastIndexOf('.');
  return !PRIVATE_EXT.has(dot > 0 ? base.slice(dot).toLowerCase() : '');
}

const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
  pdf: 'application/pdf', zip: 'application/zip', json: 'application/json', xml: 'application/xml', csv: 'text/csv', css: 'text/css', js: 'text/javascript',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export function contentTypeFor(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && TYPES[m[1]]) || 'application/octet-stream';
}

export function normalizePrefix(prefix) {
  const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
  return p ? p + '/' : '';
}

// Matches the canonical path aws4fetch signs (RFC 3986: also escape !'()*).
export function encodeKey(key) {
  return key.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const xmlDecode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m));
const xmlTag = (s, name) => {
  const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? xmlDecode(m[1]) : null;
};

// Workers have no DOMParser; ListObjectsV2 responses are flat enough for patterns.
export function parseListXml(xml) {
  const keys = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, c]) => ({ key: xmlTag(c, 'Key'), size: Number(xmlTag(c, 'Size')), etag: (xmlTag(c, 'ETag') || '').replace(/"/g, '') }));
  const prefixes = [...xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)].map(([, c]) => xmlTag(c, 'Prefix'));
  return { keys, prefixes, next: xmlTag(xml, 'IsTruncated') === 'true' ? xmlTag(xml, 'NextContinuationToken') : null };
}

async function s3Error(op, key, res) {
  const body = await res.text().catch(() => '');
  const code = (body.match(/<Code>([^<]+)<\/Code>/) || [])[1];
  const e = new Error(`S3 ${op} ${key}: HTTP ${res.status}${code ? ' ' + code : ''}`);
  e.status = res.status;
  e.code = code;
  return e;
}

// datetime (YYYYMMDDTHHMMSSZ) pins the signature time; tests only.
export function createS3({ endpoint, region, bucket, accessKeyId, secretAccessKey, prefix, forcePathStyle = true }, { datetime } = {}) {
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: region || 'auto', retries: 2 });
  const base = new URL(endpoint);
  // Path-style by default: MinIO and most non-AWS services expect it.
  const bucketUrl = forcePathStyle === false ? `${base.protocol}//${bucket}.${base.host}` : `${base.origin}/${encodeKey(bucket)}`;
  const pre = normalizePrefix(prefix);
  const objectUrl = (key) => bucketUrl + '/' + encodeKey(key);
  const send = (url, init = {}) => client.fetch(url, datetime ? { ...init, aws: { datetime } } : init);
  return {
    prefix: pre,
    keyFor: (rel) => pre + rel,
    objectUrl,
    async put(key, body, contentType) {
      const res = await send(objectUrl(key), { method: 'PUT', body, headers: { 'content-type': contentType || contentTypeFor(key) } });
      if (!res.ok) throw await s3Error('PUT', key, res);
    },
    // Raw response: callers handle 404, 206 and 304 themselves.
    get(key, headers = {}, method = 'GET') {
      return send(objectUrl(key), { method, headers });
    },
    async head(key) {
      const res = await send(objectUrl(key), { method: 'HEAD' });
      if (res.status === 404) return null;
      if (!res.ok) throw await s3Error('HEAD', key, res);
      return { size: Number(res.headers.get('content-length')), etag: (res.headers.get('etag') || '').replace(/"/g, '') };
    },
    async del(key) {
      const res = await send(objectUrl(key), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw await s3Error('DELETE', key, res);
    },
    async list(listPrefix, { delimiter, maxKeys } = {}) {
      const keys = [];
      const prefixes = [];
      let token = null;
      do {
        const u = new URL(bucketUrl + '/');
        u.searchParams.set('list-type', '2');
        u.searchParams.set('prefix', listPrefix);
        if (delimiter) u.searchParams.set('delimiter', delimiter);
        if (maxKeys) u.searchParams.set('max-keys', String(maxKeys));
        if (token) u.searchParams.set('continuation-token', token);
        const res = await send(u.toString());
        if (!res.ok) throw await s3Error('LIST', listPrefix, res);
        const page = parseListXml(await res.text());
        keys.push(...page.keys);
        prefixes.push(...page.prefixes);
        token = maxKeys ? null : page.next;
      } while (token);
      return { keys, prefixes };
    },
  };
}
