// Email: the Worker sends mail() over SMTP (runtime/src/mail.js). This step asks for the server unless an SMTP
// plugin already brings its own, checks the login from here, and keeps the answer in hostlesswp-config.php; the
// Worker gets it as the SMTP_URL secret.
import net from 'node:net';
import tls from 'node:tls';
import { p, pc, Abort, spinner } from './ui.mjs';
import { parseSmtpUrl, smtpCheck } from '../runtime/src/mail.js';

const ENV_KEY = 'HOSTLESSWP_SMTP_URL';
// Plugins that configure WordPress's PHPMailer for SMTP (or send through an API): the Worker uses their settings.
const MAIL_PLUGINS = {
  'wp-mail-smtp': 'WP Mail SMTP',
  'easy-wp-smtp': 'Easy WP SMTP',
  'post-smtp': 'Post SMTP',
  'fluent-smtp': 'FluentSMTP',
  'smtp-mailer': 'SMTP Mailer',
  'wp-smtp': 'WP SMTP',
  'gmail-smtp': 'Gmail SMTP',
  'mailgun': 'Mailgun',
  'wp-ses': 'WP Offload SES',
  'sendgrid-email-delivery-simplified': 'SendGrid',
  'mailin': 'Brevo',
  'postmark-approved-wordpress-plugin': 'Postmark',
  'suremails': 'SureMail',
};

export function mailPluginOf(activePlugins = []) {
  for (const entry of activePlugins) {
    const slug = String(entry).split('/')[0];
    if (MAIL_PLUGINS[slug]) return MAIL_PLUGINS[slug];
  }
  return null;
}

export function smtpUrl({ host, port, user, pass }) {
  const scheme = Number(port) === 465 ? 'smtps' : 'smtp';
  const auth = user ? encodeURIComponent(user) + ':' + encodeURIComponent(pass || '') + '@' : '';
  return `${scheme}://${auth}${host}:${port}`;
}

// Workers' connect() over Node's net and tls, for checking the login from this machine.
export function nodeConnect({ hostname, port }, { secureTransport } = {}) {
  const wrap = (sock) => {
    let ctrl;
    const readable = new ReadableStream({
      start(c) {
        ctrl = c;
      },
    });
    const onData = (d) => ctrl.enqueue(new Uint8Array(d));
    const onEnd = () => {
      try {
        ctrl.close();
      } catch {}
    };
    const onError = (e) => {
      try {
        ctrl.error(e);
      } catch {}
    };
    sock.on('data', onData);
    sock.on('end', onEnd);
    sock.on('error', onError);
    // Servers stall a failed login on purpose, Outlook for half a minute or more.
    sock.setTimeout(60000, () => sock.destroy(new Error('timed out')));
    const writable = new WritableStream({
      write: (chunk) => new Promise((resolve, reject) => sock.write(chunk, (e) => (e ? reject(e) : resolve()))),
    });
    return {
      readable,
      writable,
      close: async () => sock.end(),
      startTls() {
        sock.off('data', onData);
        sock.off('end', onEnd);
        sock.off('error', onError);
        // From here the TLS socket carries the traffic; the raw one would look idle.
        sock.setTimeout(0);
        return wrap(tls.connect({ socket: sock, servername: hostname }));
      },
    };
  };
  return wrap(secureTransport === 'on' ? tls.connect({ host: hostname, port, servername: hostname }) : net.connect(port, hostname));
}

export async function checkSmtp(url, connect = nodeConnect) {
  try {
    await smtpCheck(connect, parseSmtpUrl(url), 'hostlesswp.local');
  } catch (e) {
    const hint = /AUTH/.test(e.message)
      ? 'The server refused the login. Gmail and Outlook need an app password, not your account password.'
      : 'Could not talk to the server. Check the host and port (465 or 587; port 25 is closed on Workers).';
    throw new Abort(`SMTP check failed: ${e.message}\n${hint}`);
  }
}

async function ask(ui, previous = {}) {
  const host = await ui.text({ message: 'SMTP server', placeholder: 'smtp.gmail.com', initial: previous.host, validate: (v) => (v && !/[\s/:@]/.test(v) ? undefined : 'A host name, like smtp.example.com') });
  const port = await ui.select({
    message: 'Port',
    options: [
      { value: '465', label: '465', hint: 'TLS' },
      { value: '587', label: '587', hint: 'STARTTLS' },
    ],
    initial: String(previous.port || 465),
  });
  const user = await ui.text({ message: 'Username (usually the email address; empty: no login)', initial: previous.user ?? '' });
  const pass = user ? await ui.password({ message: 'Password (Gmail, Outlook: an app password)' }) : '';
  return smtpUrl({ host, port, user, pass });
}

// Returns the SMTP URL the Worker uses ('' when it sends no mail of its own).
export async function ensureMail(ui, flags, site) {
  const config = ui.config;
  const given = flags['smtp-url'] !== undefined ? String(flags['smtp-url']) : process.env[ENV_KEY];
  if (given !== undefined) {
    const url = given === 'none' ? '' : given;
    if (url && url !== config.get('smtp.url')) {
      const s = spinner();
      s.start('Checking the SMTP login');
      try {
        await checkSmtp(url);
      } catch (e) {
        s.stop(pc.red('SMTP check failed'), 1);
        throw e;
      }
      s.stop('SMTP login works');
    }
    config.set('smtp.url', url);
    return url;
  }
  if (config.has('smtp.url')) return config.get('smtp.url');

  const plugin = mailPluginOf(site.info.activePlugins);
  if (plugin) {
    p.log.info(`Email: sent with the settings of ${plugin} (an SMTP server or an email API).`);
    return '';
  }
  if (!ui.interactive) {
    p.log.warn(`Email: no SMTP server set, so WordPress cannot send email (password resets, notifications). Pass --smtp-url or set ${ENV_KEY}.`);
    return '';
  }
  p.note(
    [
      'WordPress sends email for password resets, new users, comments and',
      'orders. On Workers it goes out through an SMTP server: your email',
      'provider (Gmail, Outlook, your host), or a sending service (Amazon SES,',
      'Mailgun, Brevo, Postmark). Ports 465 and 587 work; port 25 is closed.',
      '',
      'Or install an SMTP plugin such as WP Mail SMTP on the site and skip this.',
    ].join('\n'),
    'Email',
  );
  const choice = await ui.select({
    message: 'How should WordPress send email?',
    options: [
      { value: 'smtp', label: 'Through an SMTP server' },
      { value: 'none', label: 'Not now', hint: 'emails fail until set up; run deploy with --smtp-url later' },
    ],
    initial: 'smtp',
  });
  if (choice === 'none') {
    config.set('smtp.url', '');
    return '';
  }
  let previous = {};
  for (;;) {
    const url = await ask(ui, previous);
    const s = spinner();
    s.start('Checking the SMTP login');
    try {
      await checkSmtp(url);
      s.stop('SMTP login works');
      config.set('smtp.url', url);
      return url;
    } catch (e) {
      s.stop(pc.red('SMTP check failed'), 1);
      p.log.error(e.message);
      if (!(await ui.confirm({ message: 'Enter the SMTP details again?', initial: true }))) throw new Abort('Stopped. Run again to set up email, or pass --smtp-url none to skip it.');
      const u = parseSmtpUrl(url);
      previous = { host: u.host, port: u.port, user: u.user };
    }
  }
}

// The Worker secret: "none" clears a server set by an earlier deploy (secrets outlive deploys).
export function mailSecrets(url) {
  return { SMTP_URL: url || 'none' };
}
