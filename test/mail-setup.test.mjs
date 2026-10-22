import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { ensureMail, mailPluginOf, mailSecrets, smtpUrl, checkSmtp } from '../lib/mail-setup.mjs';
import { openSiteConfig, readSiteConfig } from '../lib/config.mjs';
import { createUI } from '../lib/ui.mjs';
import { parseSmtpUrl } from '../runtime/src/mail.js';

function silenceUi(t) {
  const orig = process.stdout.write;
  // Only the prompts' text: the test runner reports through stdout too.
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === 'string' && /[│◇◆▲■●○└┌]/.test(chunk)) return true;
    return orig.call(this, chunk, ...rest);
  };
  t.after(() => (process.stdout.write = orig));
}

// SMTP server without TLS that accepts any session; records the commands.
async function fakeSmtp(t) {
  const lines = [];
  const server = net.createServer((s) => {
    let buf = '';
    s.write('220 fake\r\n');
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        lines.push(line);
        if (line.startsWith('EHLO')) s.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (line === 'QUIT') s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { port: server.address().port, lines };
}

const site = (plugins = []) => ({ info: { activePlugins: plugins } });
const uiFor = (flags) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-mail-'));
  const ui = createUI(flags);
  ui.useConfig(openSiteConfig(root));
  return { ui, root };
};

test('SMTP URLs encode the login; mail plugins are recognised', () => {
  assert.equal(smtpUrl({ host: 'smtp.x.com', port: '465', user: 'me@x.com', pass: 'p@ss/w=rd' }), 'smtps://me%40x.com:p%40ss%2Fw%3Drd@smtp.x.com:465');
  assert.equal(smtpUrl({ host: 'smtp.x.com', port: 587, user: '' }), 'smtp://smtp.x.com:587');
  assert.deepEqual(parseSmtpUrl(smtpUrl({ host: 'h', port: 465, user: 'me@x.com', pass: 'p@ss/w=rd' })), { host: 'h', port: 465, secure: 'tls', user: 'me@x.com', pass: 'p@ss/w=rd' });
  assert.equal(mailPluginOf(['akismet/akismet.php', 'wp-mail-smtp/wp_mail_smtp.php']), 'WP Mail SMTP');
  assert.equal(mailPluginOf(['akismet/akismet.php']), null);
  assert.deepEqual(mailSecrets(''), { SMTP_URL: 'none' });
  assert.deepEqual(mailSecrets(undefined), { SMTP_URL: 'none' });
  assert.deepEqual(mailSecrets('smtp://h:587'), { SMTP_URL: 'smtp://h:587' });
});

test('an SMTP plugin, or no answer without a terminal, means no server of our own', async (t) => {
  silenceUi(t);
  const a = uiFor({ yes: true });
  assert.equal(await ensureMail(a.ui, { yes: true }, site(['wp-mail-smtp/wp_mail_smtp.php'])), '');
  assert.equal(readSiteConfig(a.root).smtp, undefined, 'nothing saved: removing the plugin asks again');
  const b = uiFor({ yes: true });
  assert.equal(await ensureMail(b.ui, { yes: true }, site()), '');
});

test('--smtp-url is checked against the server and saved; none turns mail off', async (t) => {
  silenceUi(t);
  const smtp = await fakeSmtp(t);
  const url = `smtp://127.0.0.1:${smtp.port}`;
  const flags = { yes: true, 'smtp-url': url };
  const { ui, root } = uiFor(flags);
  assert.equal(await ensureMail(ui, flags, site()), url);
  for (let i = 0; i < 50 && !smtp.lines.includes('QUIT'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(smtp.lines.includes('EHLO hostlesswp.local') && smtp.lines.includes('QUIT'), smtp.lines.join('|'));
  assert.ok(!smtp.lines.some((l) => l.startsWith('MAIL')), 'the check sends no mail');
  assert.equal(readSiteConfig(root).smtp.url, url);
  // A saved answer is used without asking or checking again.
  assert.equal(await ensureMail(ui, { yes: true }, site()), url);
  assert.equal(await ensureMail(ui, { yes: true, 'smtp-url': 'none' }, site()), '');
  assert.equal(readSiteConfig(root).smtp.url, '');
});

test('a login over a connection without TLS is refused before the password is sent', async (t) => {
  const smtp = await fakeSmtp(t);
  await assert.rejects(checkSmtp(`smtp://user:secret@127.0.0.1:${smtp.port}`), /STARTTLS/);
  assert.ok(!smtp.lines.some((l) => l.startsWith('AUTH')));
});
