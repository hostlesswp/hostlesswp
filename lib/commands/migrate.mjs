// `npx hostlesswp` (default): guided move of a running WordPress site onto Cloudflare Workers.
import { p, pc, Abort, spinner } from '../ui.mjs';
import { inspectSite, reportSite } from '../site-context.mjs';
import { whoami, login, checkPermissions, findHyperdrive, createHyperdrivePublic, createTunnel, findTunnel, createVpcService, createHyperdriveVpc } from '../cloudflare.mjs';
import { locateDatabase, nearestRegion, isPrivateIp, REGION_NAMES } from '../geo.mjs';
import { ensureMediaStorage } from '../media-storage.mjs';
import { buildAndDeploy, loadState, saveState, startTunnelInBackground, siteDir, VERSION } from '../pipeline.mjs';

function suggestName(site) {
  let host = '';
  try {
    host = new URL(site.info.home).hostname.replace(/^www\./, '');
  } catch {}
  const base = (host || site.info.blogname || 'wordpress').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ('wp-' + base).slice(0, 50).replace(/-+$/, '');
}

async function chooseAccount(ui, flags) {
  let me = await whoami();
  if (!me) {
    p.note('hostlesswp uses your own Cloudflare account through Wrangler (Cloudflare\'s official CLI).\nA browser window opens; log in and allow access, then come back here.', 'Cloudflare login');
    if (!ui.interactive) throw new Abort('Not logged in to Cloudflare. Run `npx wrangler login` first, or set CLOUDFLARE_API_TOKEN.');
    await login();
    me = await whoami();
    if (!me) throw new Abort('Still not logged in to Cloudflare.');
  }
  const accounts = me.accounts || [];
  if (flags.account) return flags.account;
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  if (accounts.length <= 1) {
    p.log.info(`Cloudflare account: ${pc.bold(accounts[0]?.name || me.email)}`);
    return accounts[0]?.id;
  }
  return ui.select({ flag: 'account', remember: 'accountId', message: 'Which Cloudflare account?', options: accounts.map((a) => ({ value: a.id, label: a.name, hint: a.id })) });
}

async function chooseDatabaseAccess(ui, flags, site) {
  const host = site.cfg.db.socketPath ? 'localhost' : site.cfg.db.host;
  const local = host === 'localhost' || isPrivateIp(host) || !host.includes('.');
  if (flags['db-access'] === undefined && !ui.config.has('dbAccess')) {
    p.note(
      [
        'Your WordPress code will run on Cloudflare, but your database stays where it is.',
        'The Worker reaches it through Hyperdrive, Cloudflare\'s database connection pool. Two ways:',
        '',
        `${pc.bold('1. Over the internet')}   the database accepts remote connections with SSL`,
        `   (managed databases like RDS, Aliyun RDS, PlanetScale-compatible MySQL, DigitalOcean)`,
        `${pc.bold('2. Through a tunnel')}    the database stays private; a small connector (cloudflared)`,
        `   runs on this server and must keep running`,
      ].join('\n'),
      'Database access',
    );
  }
  const mode = await ui.select({
    flag: 'db-access',
    remember: 'dbAccess',
    message: 'How should Cloudflare reach your database?',
    initial: local ? 'tunnel' : 'public',
    options: [
      { value: 'public', label: 'Over the internet (SSL)', hint: local ? 'your DB_HOST looks private' : 'recommended for managed databases' },
      { value: 'tunnel', label: 'Through a Cloudflare Tunnel from this server', hint: local ? 'recommended: your DB_HOST is local' : '' },
    ],
  });
  if (mode === 'public' && local) {
    // WordPress talks to it locally, but Cloudflare needs the address the database answers on from outside.
    const pub = await ui.text({ flag: 'db-public-host', remember: 'dbPublicHost', message: 'Public hostname or IP of your database server (what Cloudflare should connect to)', validate: (v) => (v && !isPrivateIp(v) && v !== 'localhost' ? undefined : 'Needs a public address') });
    site.dbPublicHost = pub;
  }
  // Hyperdrive only speaks TLS to MySQL, in both modes (the tunnel does not remove that requirement).
  if (!site.info.ssl) {
    p.note(
      [
        `Your MySQL server has SSL turned off (have_ssl = ${pc.bold('DISABLED')}). Cloudflare Hyperdrive only connects over SSL.`,
        '',
        'How to turn it on:',
        '  • Managed database: enable SSL/TLS in the provider console (on Aliyun RDS: Data Security > SSL).',
        '  • MySQL 8 on your own server: it generates certificates by default; check that ssl is not disabled in my.cnf.',
        '  • MariaDB: set ssl_cert / ssl_key in my.cnf and restart (https://mariadb.com/kb/en/securing-connections-for-client-and-server/).',
      ].join('\n'),
      pc.yellow('SSL required'),
    );
    throw new Abort('Turn on SSL for MySQL, then run `npx hostlesswp` again. Nothing was created on Cloudflare.');
  }
  return mode;
}

async function chooseRegion(ui, flags, site, mode) {
  if (flags.region) return flags.region === 'none' ? null : flags.region;
  if (ui.config.has('region')) return ui.config.get('region');
  const s = spinner();
  s.start('Finding where your database is, so the Worker can run next to it');
  const host = mode === 'tunnel' ? 'localhost' : site.dbPublicHost || (site.cfg.db.socketPath ? 'localhost' : site.cfg.db.host);
  const loc = await locateDatabase(host);
  if (!loc) {
    s.stop(pc.yellow('Could not locate the database'));
    return ui.select({ flag: 'region', message: 'Which cloud region is closest to your database?', options: [...REGION_NAMES.map((r) => ({ value: r, label: r })), { value: 'none', label: 'Do not set (Worker runs near each visitor; slow with a distant database)' }] }).then((r) => (r === 'none' ? null : r));
  }
  const near = nearestRegion(loc.latlon);
  s.stop(`Database is in ${[loc.city, loc.country].filter(Boolean).join(', ')}${loc.viaThisMachine ? ' (location of this server)' : ''}: the Worker will run near ${pc.bold('aws:' + near.region)}`);
  p.log.message(pc.dim('Why: each page runs dozens of database queries one after another. Next to the database each takes a few ms; across an ocean, 200+ ms.'));
  return near.region;
}

export async function migrate(ui, flags) {
  p.intro(`${pc.bgCyan(pc.black(' hostlesswp '))} ${pc.dim('v' + VERSION)}  Move your WordPress site to Cloudflare Workers`);
  p.log.message(
    [
      'What happens:',
      `  1. Check your site and plugins ${pc.dim('(read-only)')}`,
      `  2. Connect your Cloudflare account`,
      `  3. Connect Cloudflare to your database ${pc.dim('(it stays where it is)')}`,
      `  4. Connect S3-compatible storage for your media library`,
      `  5. Package and deploy a copy of the site to a workers.dev address`,
      '',
      `Your current site keeps running untouched. Switching your domain is a separate, later step.`,
    ].join('\n'),
  );

  const site = await inspectSite(ui, flags);
  const plugins = reportSite(site);
  const untested = plugins.filter((x) => x.status === 'untested').length;
  if (!(await ui.confirm({ flag: 'continue', message: untested ? `${untested} plugin(s) are not in the tested list. They often work; continue and try?` : 'Continue to Cloudflare?' }))) {
    p.outro('Stopped before touching Cloudflare.');
    return;
  }

  const accountId = await chooseAccount(ui, flags);
  if (accountId) ui.config.set('accountId', accountId);
  p.log.info(`The Workers Free plan runs a site; ${pc.bold('Workers Paid')} ($5/month) raises its daily limits for busier sites.`);

  const name = await ui.text({
    flag: 'name',
    remember: 'name',
    message: 'Name for the Worker (also your test address: <name>.<your-subdomain>.workers.dev)',
    initial: suggestName(site),
    validate: (v) => (/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(v || '') ? undefined : 'Lowercase letters, digits and dashes, 2 to 63 characters'),
  });
  const prev = loadState(name);
  if (prev && prev.root !== site.root && !(await ui.confirm({ flag: 'overwrite', message: `A Worker named ${name} was already set up from ${prev.root}. Replace it with this site?`, initial: false }))) {
    throw new Abort('Pick another name with --name.');
  }
  const state = { ...(prev || {}), name, root: site.root, accountId, hostlesswp: VERSION };

  const mode = await chooseDatabaseAccess(ui, flags, site);
  {
    const s0 = spinner();
    s0.start('Checking your Cloudflare permissions');
    const problem = await checkPermissions(accountId, { tunnel: mode === 'tunnel' });
    if (problem) {
      s0.stop(pc.red('Missing permissions'), 1);
      throw new Abort(problem);
    }
    s0.stop('Cloudflare permissions OK');
  }
  state.dbAccess = mode;
  if (site.dbPublicHost) state.dbPublicHost = site.dbPublicHost;
  state.region = await chooseRegion(ui, flags, site, mode);
  ui.config.set('region', state.region);
  await ensureMediaStorage(ui, flags, { probe: true });

  const hdName = `hostlesswp-${name}`;
  let s = spinner();
  if (mode === 'public') {
    s.start('Creating the Hyperdrive connection to your database');
    state.hyperdriveId = (await findHyperdrive(hdName, accountId)) || (await createHyperdrivePublic({ name: hdName, db: { ...site.cfg.db, host: site.dbPublicHost || site.cfg.db.host }, accountId }).catch((e) => {
      s.stop(pc.red('Hyperdrive could not connect to your database'), 1);
      p.note(['Cloudflare tried to connect to ' + (site.dbPublicHost || site.cfg.db.host) + ':' + site.cfg.db.port + ' from the internet. Common causes:', '  • the database firewall / security group does not allow Cloudflare (allow 0.0.0.0/0 or Cloudflare IPs on port ' + site.cfg.db.port + ')', '  • the user is limited to localhost (create it for host %)', '  • SSL is not enabled', '', 'If the database is not meant to be public, run again and choose the tunnel.'].join('\n'), 'Hint');
      throw e;
    }));
    s.stop(`Hyperdrive ready (${state.hyperdriveId})`);
  } else {
    p.note(['A Cloudflare Tunnel connector will run on this server and carry database traffic to Cloudflare.', 'It must keep running for the site to work. hostlesswp starts it in the background now;', 'see the end of this setup for how to make it start on boot.'].join('\n'), 'Tunnel');
    s.start('Creating the tunnel');
    state.tunnelId = state.tunnelId || (await findTunnel(hdName, accountId)) || (await createTunnel(hdName, accountId));
    s.stop(`Tunnel ready (${state.tunnelId})`);
    saveState(state);
    const bg = startTunnelInBackground(state);
    p.log.info(`Tunnel connector started in the background (pid ${bg.pid}, log ${bg.log})`);
    s = spinner();
    s.start('Connecting Hyperdrive to your database through the tunnel');
    const target = site.cfg.db.socketPath || site.cfg.db.host === 'localhost' ? '127.0.0.1' : site.cfg.db.host;
    state.serviceId = state.serviceId || (await createVpcService({ name: hdName, tunnelId: state.tunnelId, host: target, port: site.cfg.db.port, accountId }));
    state.hyperdriveId = (await findHyperdrive(hdName, accountId)) || (await createHyperdriveVpc({ name: hdName, serviceId: state.serviceId, db: site.cfg.db, accountId }));
    s.stop(`Hyperdrive ready (${state.hyperdriveId})`);
  }
  saveState(state);

  const result = await buildAndDeploy(ui, flags, site, state);

  const next = [
    `Test it:        ${pc.cyan(state.url || '(see Cloudflare dashboard)')}`,
    `Log in:         ${pc.cyan((state.url || '') + '/wp-admin/')} with your usual username and password`,
    `Update later:   ${pc.cyan(`npx hostlesswp deploy --name ${name}`)} ${pc.dim('(after changing plugins, themes or WordPress on this server)')}`,
    `Use your domain: Cloudflare dashboard > Workers > ${name} > Settings > Domains & Routes > Add custom domain.`,
    pc.dim('                Do this only when the test address works for you; your current host keeps serving until then.'),
  ];
  if (mode === 'tunnel') {
    next.push('', `${pc.yellow('Keep the tunnel running:')} it was started in the background, but stops on reboot. To make it permanent:`, `  install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)`, `  then: ${pc.cyan(`npx wrangler tunnel run ${state.tunnelId}`)} under systemd/pm2, or use the dashboard's install command for tunnel ${hdName}.`);
  }
  p.note(next.join('\n'), result.ok ? pc.green('Done') : pc.yellow('Deployed, needs a look'));
  p.outro(result.ok ? 'Your WordPress is running on Cloudflare Workers.' : `Check logs with: npx wrangler tail ${name}`);
  if (!result.ok) process.exitCode = 1;
  return state;
}

export { siteDir };
