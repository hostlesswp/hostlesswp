import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSite } from '../lib/build.mjs';
import { PKG_ROOT } from '../lib/run.mjs';
import { parseMessage, addressesOf, parseSmtpUrl, smtpFromPhpMailer } from '../runtime/src/mail.js';

// Runs PHP code (the real engine build) with the curl, URL stream, fileinfo, DNS, session and mail polyfills loaded, an HTTP
// server on [::1] (not refused as loopback) and a fake SMTP server behind mail(). Returns what the code printed
// as JSON and what the SMTP server received.
function runPhp(code) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-poly-site-'));
  fs.mkdirSync(path.join(root, 'wp-includes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wp-includes', 'version.php'), '<?php');
  fs.mkdirSync(path.join(root, 'wp-content', 'themes', 't'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wp-content', 'themes', 't', 'style.css'), '/* Theme Name: t */');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-poly-out-'));
  buildSite({ root, wpVersion: '6.8', pluginEntries: [], themes: ['t'], db: { name: 'db' }, tablePrefix: 'wp_' }, out);
  fs.writeFileSync(path.join(out, 'code.php'), code);
  fs.writeFileSync(
    path.join(out, 'run.mjs'),
    `import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
import createCore from './src/vendor/core.mjs';
import coreWasm from './src/vendor/core.wasm';
import { loadEngine } from './src/vendor/engine.mjs';
import { fetchOne } from './src/http.js';
import { mailBridge } from './src/mail.js';
import { sessionBridge } from './src/session.js';
import { fakeSessionDb } from '${PKG_ROOT}/test/helpers/fake-session-db.mjs';
const sessionDb = fakeSessionDb();
globalThis.require = createRequire(import.meta.url);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/redirect') return res.writeHead(302, { location: '/echo?from=redirect' }).end('moved');
    if (u.pathname === '/gzip') return res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }).end(zlib.gzipSync('inflated body'));
    if (u.pathname === '/missing') return res.writeHead(404, { 'content-type': 'text/plain' }).end('nope');
    if (u.pathname === '/slow') return setTimeout(() => res.end('late'), 3000);
    if (u.pathname === '/cookies') {
      res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
      return res.end('ok');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') }));
  });
});
await new Promise((r) => server.listen(0, '::1', r));

// Fake SMTP server: records the conversation.
const smtp = { lines: [], data: '' };
const smtpServer = net.createServer((s) => {
  let buf = '', inData = false;
  s.write('220 fake ESMTP\\r\\n');
  s.on('data', (d) => {
    buf += d.toString('latin1');
    let i;
    while ((i = buf.indexOf('\\r\\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          s.write('250 queued\\r\\n');
        } else smtp.data += line + '\\n';
        continue;
      }
      smtp.lines.push(line);
      if (/^EHLO/.test(line)) s.write('250-fake\\r\\n250 8BITMIME\\r\\n');
      else if (line === 'DATA') {
        inData = true;
        s.write('354 go\\r\\n');
      } else if (line === 'QUIT') s.end('221 bye\\r\\n');
      else s.write('250 ok\\r\\n');
    }
  });
});
await new Promise((r) => smtpServer.listen(0, '127.0.0.1', r));
// Workers' connect() over Node's net.
const connect = ({ hostname, port }) => {
  const sock = net.connect(port, hostname);
  const { readable, writable } = Duplex.toWeb(sock);
  const opened = new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  opened.catch(() => {});
  return { readable, writable, opened, close: async () => sock.end() };
};
// TCP server: answers each line with "echo: <line>", "bye" closes the connection.
const tcpServer = net.createServer((s) => {
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line === 'bye') return s.end('closing\\n');
      s.write('echo: ' + line + '\\n');
    }
  });
});
await new Promise((r) => tcpServer.listen(0, '127.0.0.1', r));
const closed = net.createServer();
await new Promise((r) => closed.listen(0, '127.0.0.1', r));
const closedPort = closed.address().port;
await new Promise((r) => closed.close(r));

let smtpOn = true;
const sendMail = mailBridge({ getSmtp: () => (smtpOn ? { host: '127.0.0.1', port: smtpServer.address().port, secure: 'none' } : null), helo: () => 'test.local', connect });
// DNS-over-HTTPS answers for hostlesswp-dns.php.
const zone = {
  'gmail.com|MX': [[15, 300, '5 gmail-smtp-in.l.google.com.'], [15, 300, '10 alt1.gmail-smtp-in.l.google.com.']],
  'gmail.com|A': [[1, 300, '142.250.1.1']],
  'gmail.com|TXT': [[16, 300, '"v=spf1 redirect=_spf.google.com"']],
  'www.x.com|A': [[5, 60, 'x.com.'], [1, 60, '1.2.3.4'], [1, 60, '1.2.3.5']],
  '8.8.8.8.in-addr.arpa|PTR': [[12, 60, 'dns.google.']],
};
const doh = (url) => {
  const u = new URL(url);
  const key = u.searchParams.get('name') + '|' + u.searchParams.get('type');
  const answers = zone[key];
  const body = JSON.stringify(answers ? { Status: 0, Answer: answers.map(([type, TTL, data]) => ({ name: u.searchParams.get('name'), type, TTL, data })) } : { Status: 3 });
  return { status: 200, reason: 'OK', url, headers: [['content-type', 'application/dns-json']], body: btoa(body) };
};
const onMessage = async (data) => {
  const msg = JSON.parse(data);
  if (msg.op === 'mail') return sendMail(msg);
  if (msg.op === 'fetch') return JSON.stringify(await Promise.all(msg.requests.map((q) => (q.url.startsWith('https://cloudflare-dns.com/') ? doh(q.url) : fetchOne(q)))));
  if (msg.op === 'smtp-off') smtpOn = false;
  if (msg.op === 'session') return JSON.stringify(await sessionBridge(sessionDb.query, msg));
  if (msg.op === 'session-reads') return String(sessionDb.sql.filter((q) => q.startsWith('SELECT')).length);
  return '{}';
};
const engine = await loadEngine(createCore, coreWasm, { env: { USE_ZEND_ALLOC: '0' }, connect, onMessage });
engine.FS.mkdirTree('/app');
engine.FS.mkdirTree('/tmp');
await engine.start({ display_errors: '1', error_reporting: 'E_ALL', disable_functions: 'gethostbyname,gethostbynamel,gethostbyaddr,checkdnsrr,dns_check_record,getmxrr,dns_get_mx,dns_get_record,mail' });
for (const f of ['hostlesswp-http.php', 'hostlesswp-curl.php', 'hostlesswp-fileinfo.php', 'hostlesswp-dns.php', 'hostlesswp-session.php', 'hostlesswp-mail.php', 'hostlesswp-mysqli.php']) engine.FS.writeFile('/app/' + f, fs.readFileSync('${PKG_ROOT}/runtime/php/' + f));
const prelude = "<?php require '/app/hostlesswp-http.php'; require '/app/hostlesswp-curl.php'; require '/app/hostlesswp-fileinfo.php'; require '/app/hostlesswp-dns.php'; require '/app/hostlesswp-session.php'; require '/app/hostlesswp-mail.php'; $base = 'http://[::1]:" + server.address().port + "'; $tcpPort = " + tcpServer.address().port + "; $closedPort = " + closedPort + "; ?>";
const r = await engine.run(prelude + fs.readFileSync('code.php', 'utf8'));
process.stdout.write(JSON.stringify({ out: r.text, errors: r.log.join('\\n'), smtp }));
process.exit(0);
`,
  );
  const res = execFileSync(process.execPath, ['--experimental-wasm-jspi', '--import', path.join(PKG_ROOT, 'lib', 'node', 'register.mjs'), 'run.mjs'], { cwd: out, encoding: 'utf8' });
  const parsed = JSON.parse(res);
  try {
    parsed.result = JSON.parse(parsed.out);
  } catch {
    assert.fail('PHP output is not JSON: ' + parsed.out + ' ' + parsed.errors);
  }
  return parsed;
}

test('curl polyfill sends requests with fetch()', () => {
  const { result: r } = runPhp(`<?php
$r = array();
$ch = curl_init("$base/echo?x=1");
curl_setopt_array($ch, array(CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => array('X-Test: a', 'Accept:'), CURLOPT_USERAGENT => 'ua/1'));
$j = json_decode(curl_exec($ch), true);
$r['get'] = array($j['method'], $j['path'], $j['headers']['x-test'], $j['headers']['user-agent'], curl_getinfo($ch, CURLINFO_HTTP_CODE), curl_getinfo($ch)['content_type']);

$ch = curl_init("$base/echo");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
curl_setopt($ch, CURLOPT_POSTFIELDS, 'a=1&b=2');
$j = json_decode(curl_exec($ch), true);
$r['post'] = array($j['method'], $j['headers']['content-type'], $j['body']);

$ch = curl_init("$base/echo");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
curl_setopt($ch, CURLOPT_POSTFIELDS, array('f' => 'v', 'up' => new CURLStringFile('DATA', 'x.txt', 'text/plain')));
$j = json_decode(curl_exec($ch), true);
$r['multipart'] = array(strpos($j['headers']['content-type'], 'multipart/form-data; boundary=') === 0, strpos($j['body'], 'filename="x.txt"') !== false, strpos($j['body'], "DATA") !== false);

$ch = curl_init("$base/echo");
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'PUT');
curl_setopt($ch, CURLOPT_POSTFIELDS, '{"k":1}');
curl_setopt($ch, CURLOPT_HTTPHEADER, array('Content-Type: application/json'));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$j = json_decode(curl_exec($ch), true);
$r['put'] = array($j['method'], $j['headers']['content-type'], $j['body']);

$heads = array(); $body = '';
$ch = curl_init("$base/cookies");
curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($h, $line) use (&$heads) { $heads[] = trim($line); return strlen($line); });
curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($h, $chunk) use (&$body) { $body .= $chunk; return strlen($chunk); });
$r['callbacks'] = array(curl_exec($ch), $heads[0], count(preg_grep('/^set-cookie: /', $heads)), end($heads), $body);

$ch = curl_init("$base/cookies");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, true);
$out = curl_exec($ch);
$r['header'] = array(substr($out, curl_getinfo($ch, CURLINFO_HEADER_SIZE)), strpos($out, 'HTTP/1.1 200 OK') === 0);

$ch = curl_init("$base/redirect");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_exec($ch);
$r['noFollow'] = array(curl_getinfo($ch, CURLINFO_HTTP_CODE), curl_getinfo($ch, CURLINFO_REDIRECT_URL) === "$base/echo?from=redirect");
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
$j = json_decode(curl_exec($ch), true);
$r['follow'] = array(curl_getinfo($ch, CURLINFO_HTTP_CODE), $j['path'], curl_getinfo($ch, CURLINFO_EFFECTIVE_URL) === "$base/echo?from=redirect");

$ch = curl_init("$base/gzip");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, true);
$out = curl_exec($ch);
$r['gzip'] = array(substr($out, curl_getinfo($ch, CURLINFO_HEADER_SIZE)), stripos($out, 'content-encoding') === false);

$ch = curl_init("$base/missing");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FAILONERROR, true);
$r['fail'] = array(curl_exec($ch), curl_errno($ch), curl_error($ch));

$ch = curl_init("$base/slow");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 1);
$r['timeout'] = array(curl_exec($ch), curl_errno($ch));

$ch = curl_init('http://localhost/');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$r['loopback'] = array(curl_exec($ch), curl_errno($ch));

$mh = curl_multi_init();
$hs = array();
foreach (array('a', 'b', 'c') as $k) {
  $hs[$k] = curl_init("$base/echo?k=$k");
  curl_setopt($hs[$k], CURLOPT_RETURNTRANSFER, true);
  curl_multi_add_handle($mh, $hs[$k]);
}
do { $st = curl_multi_exec($mh, $running); if ($running) curl_multi_select($mh); } while ($running && $st == CURLM_OK);
$done = 0;
while ($m = curl_multi_info_read($mh)) { $done += $m['msg'] === CURLMSG_DONE && $m['result'] === CURLE_OK; }
$r['multi'] = array($done, json_decode(curl_multi_getcontent($hs['b']), true)['path']);

$v = curl_version();
$r['version'] = array(($v['features'] & CURL_VERSION_SSL) > 0, function_exists('curl_init'), CURLOPT_URL);
echo json_encode($r);
`);
  assert.deepEqual(r.get, ['GET', '/echo?x=1', 'a', 'ua/1', 200, 'application/json']);
  assert.deepEqual(r.post, ['POST', 'application/x-www-form-urlencoded', 'a=1&b=2']);
  assert.deepEqual(r.multipart, [true, true, true]);
  assert.deepEqual(r.put, ['PUT', 'application/json', '{"k":1}']);
  assert.deepEqual(r.callbacks, [true, 'HTTP/1.1 200 OK', 2, '', 'ok']);
  assert.deepEqual(r.header, ['ok', true]);
  assert.deepEqual(r.noFollow, [302, true]);
  assert.deepEqual(r.follow, [200, '/echo?from=redirect', true]);
  assert.deepEqual(r.gzip, ['inflated body', true]);
  assert.deepEqual(r.fail, [false, 22, 'The requested URL returned error: 404']);
  assert.deepEqual(r.timeout, [false, 28]);
  assert.deepEqual(r.loopback, [false, 7]);
  assert.deepEqual(r.multi, [3, '/echo?k=b']);
  assert.deepEqual(r.version, [true, true, 10002]);
});

test('http:// and https:// streams go through fetch(), fileinfo is matched in PHP', () => {
  const { result: r } = runPhp(`<?php
$r = array();
$j = json_decode(file_get_contents("$base/echo?s=1"), true);
$r['get'] = array($j['method'], $j['path']);
$ctx = stream_context_create(array('http' => array('method' => 'POST', 'header' => "X-A: 1\\r\\nContent-Type: text/plain", 'content' => 'hello')));
$j = json_decode(file_get_contents("$base/echo", false, $ctx), true);
$r['post'] = array($j['method'], $j['headers']['x-a'], $j['headers']['content-type'], $j['body']);
$r['missing'] = @file_get_contents("$base/missing");
$r['ignoreErrors'] = file_get_contents("$base/missing", false, stream_context_create(array('http' => array('ignore_errors' => true))));
$fp = fopen("$base/cookies", 'r');
$lines = array();
foreach (stream_get_meta_data($fp)['wrapper_data'] as $line) $lines[] = $line;
$r['meta'] = array($lines[0], count(preg_grep('/^set-cookie: /', $lines)), stream_get_contents($fp));
fclose($fp);
$r['write'] = @fopen("$base/echo", 'w');

$png = "\\x89PNG\\r\\n\\x1A\\n" . str_repeat("\\0", 20);
file_put_contents('/tmp/x.png', $png);
file_put_contents('/tmp/x.svg', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
$fi = new finfo(FILEINFO_MIME_TYPE);
$r['finfo'] = array(
  $fi->file('/tmp/x.png'), mime_content_type('/tmp/x.svg'), finfo_buffer(finfo_open(FILEINFO_MIME), "plain text"),
  $fi->buffer('%PDF-1.7'), $fi->buffer("GIF89a"), $fi->buffer("\\0\\0\\0\\x18ftypheic"), $fi->buffer(''),
);
echo json_encode($r);
`);
  assert.deepEqual(r.get, ['GET', '/echo?s=1']);
  assert.deepEqual(r.post, ['POST', '1', 'text/plain', 'hello']);
  assert.equal(r.missing, false);
  assert.equal(r.ignoreErrors, 'nope');
  assert.deepEqual(r.meta, ['HTTP/1.1 200 OK', 2, 'ok']);
  assert.equal(r.write, false);
  assert.deepEqual(r.finfo, ['image/png', 'image/svg+xml', 'text/plain; charset=us-ascii', 'application/pdf', 'image/gif', 'image/heic', 'application/x-empty']);
});

test('mail() is delivered over SMTP, recipients from the headers, Bcc hidden', () => {
  const { result: r, smtp } = runPhp(`<?php
$ok = mail('a@x.com, "B, C" <b@y.com>', 'Hi there', "line one\\n.dot line\\n", "From: Sender <s@z.com>\\r\\nBcc: hidden@q.com");
post_message_to_js(json_encode(array('op' => 'smtp-off')));
$off = mail('a@x.com', 'nope', 'body');
echo json_encode(array('ok' => $ok, 'off' => $off));
`);
  assert.deepEqual(r, { ok: true, off: false });
  assert.ok(smtp.lines.includes('MAIL FROM:<s@z.com>'), smtp.lines.join('|'));
  assert.deepEqual(smtp.lines.filter((l) => l.startsWith('RCPT')), ['RCPT TO:<a@x.com>', 'RCPT TO:<b@y.com>', 'RCPT TO:<hidden@q.com>']);
  assert.match(smtp.data, /^Subject: Hi there$/m);
  assert.doesNotMatch(smtp.data, /hidden@q\.com/);
  // The dot-stuffed line arrives as "..dot line" on the wire.
  assert.match(smtp.data, /^\.\.dot line$/m);
});

test('binary values in SQL reach the bridge as hex literals', () => {
  const { result: r } = runPhp(`<?php
require '/app/hostlesswp-mysqli.php';
$bin = hash('sha256', 'ua', true) . "'\\\\\\0";
$sql = "SELECT 1 FROM t WHERE id = '" . hostlesswp_escape($bin) . "' AND name = 'it\\'s' AND x = X'00ff'";
$out = hostlesswp_sql_for_bridge($sql);
echo json_encode(array('utf8' => (bool) preg_match('//u', $out), 'hex' => strpos($out, "X'" . bin2hex($bin) . "'") !== false, 'rest' => strpos($out, "name = 'it\\'s' AND x = X'00ff'") !== false, 'plain' => hostlesswp_sql_for_bridge("SELECT 'h\u{e9}llo'") === "SELECT 'h\u{e9}llo'"));
`);
  assert.deepEqual(r, { utf8: true, hex: true, rest: true, plain: true });
});

test('DNS functions answer over DNS-over-HTTPS', () => {
  const { result: r } = runPhp(`<?php
$r = array(
  'byname' => array(gethostbyname('www.x.com'), gethostbyname('nx.example'), gethostbyname('9.9.9.9'), gethostbynamel('www.x.com'), gethostbynamel('nx.example')),
  'check' => array(checkdnsrr('gmail.com'), checkdnsrr('gmail.com', 'A'), checkdnsrr('nx.example', 'MX'), checkdnsrr('gmail.com', 'ANY')),
  'mx' => array(getmxrr('gmail.com', $hosts, $weights), $hosts, $weights, getmxrr('nx.example', $none), $none),
  'addr' => gethostbyaddr('8.8.8.8'),
  'records' => dns_get_record('gmail.com', DNS_MX | DNS_TXT),
);
echo json_encode($r);
`);
  assert.deepEqual(r.byname, ['1.2.3.4', 'nx.example', '9.9.9.9', ['1.2.3.4', '1.2.3.5'], false]);
  assert.deepEqual(r.check, [true, true, false, true]);
  assert.deepEqual(r.mx, [true, ['gmail-smtp-in.l.google.com', 'alt1.gmail-smtp-in.l.google.com'], [5, 10], false, []]);
  assert.equal(r.addr, 'dns.google');
  assert.deepEqual(
    r.records.map((x) => [x.type, x.pri ?? null, x.target ?? x.txt]),
    [['MX', 5, 'gmail-smtp-in.l.google.com'], ['MX', 10, 'alt1.gmail-smtp-in.l.google.com'], ['TXT', null, 'v=spf1 redirect=_spf.google.com']],
  );
});

test('PHP sockets are TCP connections', () => {
  const { result: r } = runPhp(`<?php
$r = array();
$fp = fsockopen('127.0.0.1', $tcpPort, $errno, $errstr, 5);
fwrite($fp, "hello\\n");
$r['fsockopen'] = trim(fgets($fp));
fwrite($fp, "again\\nbye\\n");
$r['lines'] = array(trim(fgets($fp)), trim(fgets($fp)));
$r['eof'] = array(fgets($fp), feof($fp));
fclose($fp);
$s = stream_socket_client("tcp://localhost:$tcpPort", $errno, $errstr, 5);
fwrite($s, str_repeat('x', 100000) . "\\n");
$r['big'] = strlen(trim(fgets($s, 200000)));
fclose($s);
$r['refused'] = array((bool) @fsockopen('127.0.0.1', $closedPort, $errno, $errstr, 2), $errno > 0);
echo json_encode($r);
`);
  assert.equal(r.fsockopen, 'echo: hello');
  assert.deepEqual(r.lines, ['echo: again', 'closing']);
  assert.deepEqual(r.eof, [false, true]);
  assert.equal(r.big, 'echo: '.length + 100000);
  assert.deepEqual(r.refused, [false, true]);
});

test('PHP sessions go to the database', () => {
  const { result: r } = runPhp(`<?php
session_set_save_handler(new HostlessWP_Session_Handler('wp_'), true);
session_id('s1');
session_start();
$_SESSION['n'] = 41;
$_SESSION['bin'] = "\\x00\\xff";
session_write_close();
$_SESSION = array();
session_start();
$r = array('n' => $_SESSION['n'], 'bin' => bin2hex($_SESSION['bin']));
$_SESSION['n']++;
session_write_close();
session_start();
$r['again'] = $_SESSION['n'];
session_destroy();
session_id('s1');
session_start();
$r['destroyed'] = $_SESSION;
session_write_close();
session_id('s2');
session_start();
$_SESSION['k'] = 'v';
session_write_close();
// Strict mode checks the id first; that lookup also serves the read.
ini_set('session.use_strict_mode', '1');
$before = (int) post_message_to_js(json_encode(array('op' => 'session-reads')));
session_id('s2');
session_start();
$r['strict'] = array($_SESSION['k'], (int) post_message_to_js(json_encode(array('op' => 'session-reads'))) - $before);
echo json_encode($r);
`);
  assert.deepEqual(r, { n: 41, bin: '00ff', again: 42, destroyed: [], strict: ['v', 1] });
});

// 400x300 red at half opacity (8 bit, alpha) and 64x48 at 10 bit, made with avifenc.
const AVIF_ALPHA = 'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUEAAAGGbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAACxpbG9jAAAAAEQAAAIAAQAAAAEAAAHiAAAAWwACAAAAAQAAAa4AAAA0AAAAQmlpbmYAAAAAAAIAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAABppbmZlAgAAAAACAABhdjAxQWxwaGEAAAAAGmlyZWYAAAAAAAAADmF1eGwAAgABAAEAAADDaXBycAAAAJ1pcGNvAAAAFGlzcGUAAAAAAAABkAAAASwAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBIAAAAAAAE2NvbHJuY2x4AAEADQAGgAAAAA5waXhpAAAAAAEIAAAADGF2MUOBABwAAAAAOGF1eEMAAAAAdXJuOm1wZWc6bXBlZ0I6Y2ljcDpzeXN0ZW1zOmF1eGlsaWFyeTphbHBoYQAAAAAeaXBtYQAAAAAAAAACAAEEAQKDBAACBAEFhgcAAACXbWRhdBIACgYYIjHythUyKBGQBhhAtMdV/qvalZreZLeU08ldn0wIraQgmxl3pTgxU9hrjKG0zcASAAoJOCIx8raQENBpMkwR4JjBMJJJJMoAAAAAwhApoio8PR/v/BGHlURcHs6XCNV/K8fwcXIuSI+ihzmvsNMkQ5w+HskFCq7eEKTuEPlRYtZRy6pudSib35OA';
const AVIF_10BIT = 'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUEAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAB8gAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAQAAAADAAAAAQcGl4aQAAAAADCgoKAAAADGF2MUOBIEAAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAB+m1kYXQSAAoJOBV/vawENBpAMuIDRrCYuQ8888KFQYDchYJobsrrFTyDE3Melpf2wSZYew31agueVWL5WFH8KLB8oPoHpyMsEyEunZiq5udLeKxsUVjOp9wsArpRdO7rDRwWdebmw24CpilUdzZoaS3Sytk2DbW6MHpRtl8BiyeWXgLbS8ZVgLoho0XRp6fusuQgE/XdiJXi5DFt5+AXvcTy6fnjUjOs6LrK+pnEXwm0YbLmov8SqJREdStelGlBBykcrHJ8FbRB0qQ6fC4RGp8M0T0hn7ry2pL4R7W4Q296vJU0y5xPVzNT/UI0poGYMYj0Clit7DslWsKKDRfB2LS+VelYW9CPXEeclYVrmSNtHfzD8cSisB9JhUekJtUvsw4pCXMJ3u7EOOvHnu8vk3fhDHcW9TsDRkd0Y1xHuuZEvycb0ccJktfZTTo75fcIomNfOQXk8PiXEzNC9fyjJTOMbZWUcCH+fi3nUCOoFQXMzhNJ57aiG6daWow53031WbI7qOjY1u1+K5isKjzrRx54+w0jFUezkkzlH2dd5H69iod37i8gBbF71QlpPWCBDf5SDoy8t0kRilkqJKqUFsmXQcgmwDToPduh7e78x6koYILfq38uHET3gY5as++5QfVSlkCVvyb0LZPMLb/pBCtXfdzkzug=';

test('GD decodes AVIF, it cannot encode it', () => {
  const { result: r } = runPhp(`<?php
$r = array('types' => (bool) (imagetypes() & IMG_AVIF));
file_put_contents('/tmp/a.avif', base64_decode('${AVIF_ALPHA}'));
$im = imagecreatefromavif('/tmp/a.avif');
$c = imagecolorsforindex($im, imagecolorat($im, 10, 10));
$r['alpha'] = array(imagesx($im), imagesy($im), $c['red'], $c['green'], $c['alpha']);
$im = imagecreatefromstring(base64_decode('${AVIF_10BIT}'));
$r['10bit'] = array(imagesx($im), imagesy($im));
ob_start();
$r['webp'] = imagewebp($im);
$r['webpBytes'] = strlen(ob_get_clean()) > 0;
// The built-in reports success after writing an empty file; the runtime swaps it for one that fails (wp-config.php).
$r['avif'] = array(@imageavif($im, '/tmp/b.avif'), filesize('/tmp/b.avif'));
echo json_encode($r);
`);
  assert.deepEqual(r, { types: true, alpha: [400, 300, 254, 0, 64], '10bit': [64, 48], webp: true, webpBytes: true, avif: [true, 0] });
});

test('mail helpers parse addresses, messages and SMTP settings', () => {
  assert.deepEqual(addressesOf('"Doe, J" <j@x.com>, k@y.com (Kay), bad'), ['j@x.com', 'k@y.com']);
  const m = parseMessage('To: a@x.com\nCc: b@x.com\nBcc: c@x.com\nFrom: F <f@x.com>\nSubject: s\n folded\n\nbody\n');
  assert.deepEqual([m.from, m.rcpt], ['f@x.com', ['a@x.com', 'b@x.com', 'c@x.com']]);
  assert.ok(m.data.includes('Subject: s\r\n folded') && !m.data.includes('Bcc'));
  assert.deepEqual(parseSmtpUrl('smtps://me%40x.com:p%2Fw@smtp.x.com'), { host: 'smtp.x.com', port: 465, secure: 'tls', user: 'me@x.com', pass: 'p/w' });
  assert.deepEqual(parseSmtpUrl('smtp://smtp.x.com'), { host: 'smtp.x.com', port: 587, secure: 'starttls', user: '', pass: '' });
  assert.deepEqual(smtpFromPhpMailer({ host: 'ssl://smtp.gmail.com:465;backup', auth: true, user: 'u', pass: 'p' }), { host: 'smtp.gmail.com', port: 465, secure: 'tls', user: 'u', pass: 'p' });
  assert.deepEqual(smtpFromPhpMailer({ host: 'smtp.x.com', port: 587, secure: 'tls', auth: false }), { host: 'smtp.x.com', port: 587, secure: 'starttls', user: '', pass: '' });
});
