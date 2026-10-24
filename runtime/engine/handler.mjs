// HTTP front for the engine, in the role a web server plays for PHP-FPM: maps a request to a script under the
// document root, builds $_SERVER and returns PHP's response.
//
//   const handle = createHandler(engine, { documentRoot: '/wordpress', origin: 'https://example.com', fallback: '/index.php' });
//   const res = await handle({ method, url: '/path?query', headers: { name: value }, body });
//   // res: { status, headers: { lowercase name: [values] }, body: Uint8Array, exitStatus, log }

const MIME = {
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  pdf: 'application/pdf',
};

export function createHandler(engine, { documentRoot, origin, fallback = '/index.php', index = 'index.php', serverSoftware = 'HostlessWP' }) {
  const root = documentRoot.replace(/\/+$/, '');
  const base = new URL(origin);
  const FS = engine.FS;

  const stat = (p) => {
    try {
      return FS.stat(p);
    } catch {
      return null;
    }
  };
  const isFile = (p) => {
    const s = stat(p);
    return s && FS.isFile(s.mode);
  };
  const isDir = (p) => {
    const s = stat(p);
    return s && FS.isDir(s.mode);
  };

  // Finds the script for a decoded path: { script (URL path of the .php file), pathInfo } or a static file,
  // a directory redirect, or null.
  function resolve(path) {
    if (isDir(root + path)) {
      if (!path.endsWith('/')) return { redirect: path + '/' };
      if (isFile(root + path + index)) return { script: path + index, pathInfo: '' };
      return null;
    }
    if (isFile(root + path)) return path.endsWith('.php') ? { script: path, pathInfo: '' } : { file: path };
    // /script.php/extra: PATH_INFO after the first segment that is a PHP file.
    const segments = path.split('/');
    for (let i = 2; i < segments.length; i++) {
      const head = segments.slice(0, i).join('/');
      if (head.endsWith('.php') && isFile(root + head)) return { script: head, pathInfo: '/' + segments.slice(i).join('/') };
    }
    return null;
  }

  return async function handle({ method = 'GET', url, headers = {}, body }) {
    const target = new URL(url, base);
    let path;
    try {
      path = decodeURIComponent(target.pathname);
    } catch {
      path = target.pathname;
    }
    path = normalize(path);
    let found = resolve(path);
    if (found && found.redirect) {
      return { status: 301, headers: { location: [found.redirect + target.search] }, body: new Uint8Array(0), exitStatus: 0, log: [] };
    }
    if (found && found.file) {
      const ext = found.file.slice(found.file.lastIndexOf('.') + 1).toLowerCase();
      return { status: 200, headers: { 'content-type': [MIME[ext] || 'application/octet-stream'] }, body: FS.readFile(root + found.file), exitStatus: 0, log: [] };
    }
    if (!found) {
      if (!fallback || !isFile(root + fallback)) return { status: 404, headers: { 'content-type': ['text/plain'] }, body: new TextEncoder().encode('Not Found'), exitStatus: 0, log: [] };
      found = { script: fallback, pathInfo: '' };
    }

    const lower = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    const https = base.protocol === 'https:';
    const port = base.port || (https ? '443' : '80');
    const vars = {
      SERVER_SOFTWARE: serverSoftware,
      SERVER_NAME: base.hostname,
      SERVER_PORT: port,
      SERVER_PROTOCOL: 'HTTP/1.1',
      GATEWAY_INTERFACE: 'CGI/1.1',
      REQUEST_SCHEME: https ? 'https' : 'http',
      HTTPS: https ? 'on' : undefined,
      REMOTE_ADDR: lower['cf-connecting-ip'] || '127.0.0.1',
      REMOTE_PORT: '0',
      DOCUMENT_ROOT: root,
      REQUEST_METHOD: method.toUpperCase(),
      REQUEST_URI: target.pathname + target.search,
      QUERY_STRING: target.search.slice(1),
      SCRIPT_NAME: found.script,
      SCRIPT_FILENAME: root + found.script,
      PHP_SELF: found.script + found.pathInfo,
      PATH_INFO: found.pathInfo || undefined,
      PATH_TRANSLATED: found.pathInfo ? root + found.pathInfo : undefined,
      CONTENT_TYPE: lower['content-type'],
      CONTENT_LENGTH: body && body.length ? String(body.length) : lower['content-length'],
    };
    for (const [k, v] of Object.entries(lower)) {
      if (k === 'content-type' || k === 'content-length' || k === 'proxy') continue;
      vars['HTTP_' + k.toUpperCase().replace(/-/g, '_')] = v;
    }
    if (!vars.HTTP_HOST) vars.HTTP_HOST = base.host;

    const res = await engine.request(vars, body);
    const out = {};
    for (const [k, v] of res.headers) (out[k.toLowerCase()] ||= []).push(v);
    return { status: res.status, headers: out, body: res.body, exitStatus: res.exitStatus, log: res.log };
  };
}

// Resolves "." and ".." so a request cannot leave the document root.
function normalize(path) {
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return '/' + out.join('/') + (path.endsWith('/') && out.length ? '/' : '');
}
