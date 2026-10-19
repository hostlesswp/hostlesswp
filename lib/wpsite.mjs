// Reads a WordPress installation from disk: where it is, its wp-config.php settings and its version.
// wp-config.php is parsed, never executed.
import fs from 'node:fs';
import path from 'node:path';

const SALT_KEYS = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
export { SALT_KEYS };

export function isWordPressRoot(dir) {
  return fs.existsSync(path.join(dir, 'wp-includes', 'version.php')) && fs.existsSync(path.join(dir, 'wp-admin'));
}

// WordPress also looks for wp-config.php one directory above ABSPATH.
export function findConfig(root) {
  for (const p of [path.join(root, 'wp-config.php'), path.join(root, '..', 'wp-config.php')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function readVersion(root) {
  const src = fs.readFileSync(path.join(root, 'wp-includes', 'version.php'), 'utf8');
  const m = src.match(/\$wp_version\s*=\s*'([^']+)'/);
  return m ? m[1] : null;
}

// Decodes a PHP single- or double-quoted string literal body (the common escapes only).
function phpString(quote, body) {
  if (quote === "'") return body.replace(/\\(['\\])/g, '$1');
  return body.replace(/\\(["\\$nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
}

const LITERAL = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(true|false|TRUE|FALSE|-?\d+(?:\.\d+)?))`;

// Returns { defines: {NAME: value|{expr}}, tablePrefix, comments-stripped source }.
// Values that are not plain literals (getenv(), constants, concatenation) are kept as { expr } so the caller can ask.
// Removes PHP comments while respecting string literals (salts often contain "/*", "//" or "#").
export function stripPhpComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if ((c === '/' && text[i + 1] === '/') || c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function parseWpConfig(text) {
  const src = stripPhpComments(text);
  const defines = {};
  // Literal values first (a salt may contain ";" or ")"), then anything else as an expression to ask about.
  const lit = new RegExp(String.raw`define\s*\(\s*(['"])([A-Z0-9_]+)\1\s*,\s*` + LITERAL + String.raw`\s*\)\s*;`, 'g');
  for (const m of src.matchAll(lit)) {
    if (m[3] !== undefined) defines[m[2]] = phpString("'", m[3]);
    else if (m[4] !== undefined) defines[m[2]] = phpString('"', m[4]);
    else if (/^(true|false)$/i.test(m[5])) defines[m[2]] = m[5].toLowerCase() === 'true';
    else defines[m[2]] = Number(m[5]);
  }
  for (const m of src.matchAll(/define\s*\(\s*(['"])([A-Z0-9_]+)\1\s*,\s*([^;]*?)\s*\)\s*;/g)) {
    if (!(m[2] in defines)) defines[m[2]] = { expr: m[3].trim() };
  }
  const tp = src.match(new RegExp(String.raw`\$table_prefix\s*=\s*` + LITERAL + String.raw`\s*;`));
  const tablePrefix = tp ? phpString(tp[1] !== undefined ? "'" : '"', tp[1] ?? tp[2] ?? '') : null;
  return { defines, tablePrefix };
}

// DB_HOST may be "host", "host:port", "host:/path/to.sock", ":/path/to.sock", or "[ipv6]:port".
export function parseDbHost(value) {
  let host = String(value || 'localhost').trim();
  let port = 3306;
  let socketPath = null;
  const sock = host.match(/^(.*?):(\/.+)$/);
  if (sock) {
    host = sock[1] || 'localhost';
    socketPath = sock[2];
  } else {
    const v6 = host.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (v6) {
      host = v6[1];
      if (v6[2]) port = Number(v6[2]);
    } else {
      const hp = host.match(/^([^:]+):(\d+)$/);
      if (hp) {
        host = hp[1];
        port = Number(hp[2]);
      }
    }
  }
  return { host, port, socketPath };
}

// Minimal PHP unserialize for the option values hostlesswp reads (arrays of strings, strings, ints, bools).
export function phpUnserialize(s) {
  let i = 0;
  const readUntil = (ch) => {
    const j = s.indexOf(ch, i);
    if (j < 0) throw new Error('bad serialized data');
    const out = s.slice(i, j);
    i = j + 1;
    return out;
  };
  const value = () => {
    const t = s[i];
    i += 2;
    if (t === 'N') return null;
    if (t === 'b') return readUntil(';') === '1';
    if (t === 'i') return Number(readUntil(';'));
    if (t === 'd') return Number(readUntil(';'));
    if (t === 's') {
      const len = Number(readUntil(':'));
      // Length is in bytes.
      const buf = Buffer.from(s.slice(i), 'utf8');
      const str = buf.subarray(1, 1 + len).toString('utf8');
      i += 1 + str.length + 2;
      return str;
    }
    if (t === 'a') {
      const n = Number(readUntil(':'));
      i++; // {
      const out = {};
      for (let k = 0; k < n; k++) {
        const key = value();
        out[key] = value();
      }
      i++; // }
      return out;
    }
    throw new Error('unsupported serialized type ' + t);
  };
  return value();
}

// Plugin entries in active_plugins look like "akismet/akismet.php" or "hello.php" (single-file plugins).
export function pluginSlug(entry) {
  return entry.includes('/') ? entry.split('/')[0] : entry.replace(/\.php$/, '');
}

export function dirSize(dir, filter = () => true) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && filter(p)) {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  }
  return { files, bytes };
}

// The Worker keeps media in the bucket under wp-content/uploads, so a custom upload folder cannot carry over.
// Returns what to tell the user, or null when the site uses the default folder.
export function uploadFolderProblem({ defines, uploadPath, root }) {
  const fix = 'hostlesswp needs media in wp-content/uploads. Move the files back to wp-content/uploads first.';
  if (defines.UPLOADS !== undefined) {
    return `wp-config.php sets UPLOADS, so this site keeps media outside wp-content/uploads. ${fix} Then remove define('UPLOADS', ...) from wp-config.php and run again.`;
  }
  const value = String(uploadPath ?? '').trim().replace(/\/+$/, '');
  if (value === '' || value === 'wp-content/uploads' || value === path.join(root, 'wp-content', 'uploads')) return null;
  return `This site keeps media in ${value} (the upload_path option). ${fix} Then clear the option: Settings > Media no longer shows it since WordPress 3.5, so open /wp-admin/options.php and empty upload_path, or run \`wp option update upload_path ''\`.`;
}
