// mail() for PHP: runtime/php/hostlesswp-mail.php hands each message, as PHP would pipe it to `sendmail -t -i`, to
// the Worker, which delivers it over SMTP with Workers TCP sockets. The server comes from the site's own SMTP plugin
// settings when one configured PHPMailer for SMTP (runtime/php/hostlesswp-runtime.php), otherwise from the SMTP_URL
// secret.

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
};
const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// smtp://user:pass@host:587 (STARTTLS) or smtps://user:pass@host:465 (TLS from the start).
export function parseSmtpUrl(url) {
  const u = new URL(url);
  const tls = u.protocol === 'smtps:';
  if (!tls && u.protocol !== 'smtp:') throw new Error('SMTP_URL must start with smtp:// or smtps://');
  return {
    host: u.hostname,
    port: Number(u.port) || (tls ? 465 : 587),
    secure: tls ? 'tls' : 'starttls',
    user: decodeURIComponent(u.username),
    pass: decodeURIComponent(u.password),
  };
}

// Settings a PHPMailer SMTP plugin chose (Host may be "tls://smtp.example.com:587;backup.example.com").
export function smtpFromPhpMailer(m) {
  let host = String(m.host || '').split(';')[0].trim();
  let secure = String(m.secure || '').toLowerCase();
  const prefix = host.match(/^(ssl|tls):\/\//i);
  if (prefix) {
    secure = prefix[1].toLowerCase();
    host = host.slice(prefix[0].length);
  }
  let port = Number(m.port) || 0;
  const hp = host.match(/^(.*):(\d+)$/);
  if (hp) {
    host = hp[1];
    port = Number(hp[2]);
  }
  port = port || (secure === 'ssl' ? 465 : 587);
  return {
    host,
    port,
    // PHPMailer upgrades with STARTTLS when the server offers it (SMTPAutoTLS), so does this client.
    secure: secure === 'ssl' ? 'tls' : 'starttls',
    user: m.auth ? String(m.user || '') : '',
    pass: m.auth ? String(m.pass || '') : '',
  };
}

// Addresses in a header value: "A <a@x>, \"B, C\" <b@x>, c@x" -> [a@x, b@x, c@x].
export function addressesOf(value) {
  const out = [];
  for (const part of String(value).match(/(?:"[^"]*"|<[^>]*>|\([^)]*\)|[^,])+/g) || []) {
    const angle = part.match(/<([^>]+)>/);
    const addr = (angle ? angle[1] : part.replace(/\([^)]*\)/g, '')).trim();
    if (addr.includes('@')) out.push(addr);
  }
  return out;
}

// sendmail -t: recipients are read from To, Cc and Bcc, and Bcc is removed from what is sent.
export function parseMessage(raw) {
  const text = raw.replace(/\r?\n/g, '\r\n');
  const split = text.indexOf('\r\n\r\n');
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? '' : text.slice(split + 4);
  const headers = [];
  for (const line of head.split('\r\n')) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1] += '\r\n' + line;
    else if (line) headers.push(line);
  }
  const values = (name) => headers.filter((h) => h.toLowerCase().startsWith(name + ':')).map((h) => h.slice(name.length + 1).replace(/\r\n[ \t]+/g, ' ').trim());
  const rcpt = [...new Set(['to', 'cc', 'bcc'].flatMap((n) => values(n).flatMap(addressesOf)))];
  const from = addressesOf(values('from')[0] || '')[0] || '';
  const kept = headers.filter((h) => !h.toLowerCase().startsWith('bcc:'));
  return { from, rcpt, data: kept.join('\r\n') + '\r\n\r\n' + body };
}

class Replies {
  constructor(socket) {
    this.reader = socket.readable.getReader();
    this.buf = '';
  }
  async next() {
    const lines = [];
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl >= 0) {
        const line = this.buf.slice(0, nl).replace(/\r$/, '');
        this.buf = this.buf.slice(nl + 1);
        lines.push(line);
        if (/^\d{3}(?: |$)/.test(line)) return { code: Number(line.slice(0, 3)), lines };
        continue;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('SMTP server closed the connection');
      this.buf += latin1(value);
    }
  }
  release() {
    this.reader.releaseLock();
  }
}

// Opens an SMTP session up to a successful login (EHLO, STARTTLS, AUTH). connect({ hostname, port },
// { secureTransport }) is Workers' connect() or one like it, returning { readable, writable, startTls(), close() }.
async function smtpSession(connect, cfg, helo) {
  if (!cfg.host) throw new Error('no SMTP server configured');
  let socket = connect({ hostname: cfg.host, port: cfg.port }, { secureTransport: cfg.secure === 'tls' ? 'on' : cfg.secure === 'starttls' ? 'starttls' : 'off', allowHalfOpen: false });
  let replies = new Replies(socket);
  let writer = socket.writable.getWriter();
  const session = {
    send: (line) => writer.write(bytesOf(line + '\r\n')),
    write: (bytes) => writer.write(bytes),
    async expect(codes, what) {
      const r = await replies.next();
      if (!codes.includes(r.code)) throw new Error(`SMTP ${what}: ${r.lines.join(' ').slice(0, 300)}`);
      return r;
    },
    async close() {
      await session.send('QUIT').catch(() => {});
      try {
        await socket.close();
      } catch {}
    },
  };
  const { send, expect } = session;
  try {
    await expect([220], 'greeting');
    await send('EHLO ' + helo);
    let caps = (await expect([250], 'EHLO')).lines.map((l) => l.slice(4).toUpperCase());
    if (cfg.secure === 'starttls') {
      if (caps.includes('STARTTLS')) {
        await send('STARTTLS');
        await expect([220], 'STARTTLS');
        replies.release();
        writer.releaseLock();
        socket = socket.startTls();
        replies = new Replies(socket);
        writer = socket.writable.getWriter();
        await send('EHLO ' + helo);
        caps = (await expect([250], 'EHLO')).lines.map((l) => l.slice(4).toUpperCase());
      } else if (cfg.user) {
        // Never send a password in clear text.
        throw new Error('SMTP server does not offer STARTTLS');
      }
    }
    if (cfg.user) {
      const auth = caps.find((c) => c.startsWith('AUTH')) || '';
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
        await send('AUTH PLAIN ' + btoa(latin1(new TextEncoder().encode('\0' + cfg.user + '\0' + cfg.pass))));
        await expect([235], 'AUTH');
      } else {
        await send('AUTH LOGIN');
        await expect([334], 'AUTH');
        await send(btoa(latin1(new TextEncoder().encode(cfg.user))));
        await expect([334], 'AUTH');
        await send(btoa(latin1(new TextEncoder().encode(cfg.pass))));
        await expect([235], 'AUTH');
      }
    }
    return session;
  } catch (e) {
    try {
      await socket.close();
    } catch {}
    throw e;
  }
}

// Checks that the server accepts the login, without sending anything.
export async function smtpCheck(connect, cfg, helo = 'localhost') {
  await (await smtpSession(connect, cfg, helo)).close();
}

// Delivers one message.
export async function smtpSend(connect, cfg, { from, rcpt, data, helo = 'localhost' }) {
  if (!rcpt.length) throw new Error('no recipients');
  const session = await smtpSession(connect, cfg, helo);
  const { send, expect } = session;
  try {
    await send(`MAIL FROM:<${from}>`);
    await expect([250], 'MAIL FROM');
    for (const r of rcpt) {
      await send(`RCPT TO:<${r}>`);
      await expect([250, 251], 'RCPT TO ' + r);
    }
    await send('DATA');
    await expect([354], 'DATA');
    // Dot-stuffing: a line starting with "." gets another one.
    const body = data.replace(/(^|\r\n)\./g, '$1..');
    await session.write(bytesOf(body + (body.endsWith('\r\n') ? '' : '\r\n') + '.\r\n'));
    await expect([250], 'message');
  } finally {
    await session.close();
  }
}

async function workersConnect() {
  // Only Workers have this module; elsewhere (Node, while precompiling) mail is not sent.
  const { connect } = await import('cloudflare:sockets');
  return connect;
}

// The bridge op 'mail' ({ raw: base64 message, params: mail()'s additional_params }); getSmtp() returns the server
// for this message (or null), connect defaults to Workers sockets.
export function mailBridge({ getSmtp, helo, connect }) {
  return async (msg) => {
    try {
      const parsed = parseMessage(latin1(Uint8Array.from(atob(msg.raw || ''), (c) => c.charCodeAt(0))));
      // -f sets the envelope sender, as with sendmail.
      const argv = String(msg.params || '').trim().split(/\s+/).filter(Boolean);
      const fi = argv.findIndex((a) => a.startsWith('-f'));
      if (fi >= 0) parsed.from = argv[fi].length > 2 ? argv[fi].slice(2) : argv[fi + 1] || parsed.from;
      const smtp = getSmtp();
      if (!smtp) throw new Error('no SMTP server: set the SMTP_URL secret (smtps://user:password@smtp.example.com:465) or configure an SMTP plugin');
      await smtpSend(connect || (await workersConnect()), smtp, { ...parsed, helo: helo() });
      return JSON.stringify({ ok: true });
    } catch (e) {
      console.error('mail failed:', e.message || e);
      return JSON.stringify({ ok: false, error: String(e.message || e) });
    }
  };
}
