// Steps shared by `check`, `migrate` and `deploy`: find the site, read wp-config.php, connect to its database,
// and report what will and will not work on Workers.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { p, pc, Abort, spinner } from './ui.mjs';
import { isWordPressRoot, findConfig, readVersion, parseWpConfig, parseDbHost, SALT_KEYS, dirSize, uploadFolderProblem } from './wpsite.mjs';
import { connect, inspect } from './db.mjs';
import { openSiteConfig } from './config.mjs';
import { assessPlugins, presentDropins, DROPINS, loadCompat } from './compat.mjs';

const fmtBytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB');
export { fmtBytes };

export async function locateSite(ui, flags) {
  let root = path.resolve(flags.path || process.cwd());
  while (!isWordPressRoot(root)) {
    if (!ui.interactive) throw new Abort(`No WordPress installation found at ${root}. Pass --path /path/to/wordpress.`);
    const answer = await ui.text({
      message: `No WordPress found in ${pc.dim(root)}. Where is your site? (the folder that contains wp-config.php and wp-admin)`,
      placeholder: '/var/www/html',
      validate: (v) => (v && isWordPressRoot(path.resolve(v)) ? undefined : 'That folder does not contain wp-admin and wp-includes/version.php'),
    });
    root = path.resolve(answer);
  }
  return root;
}

// Reads DB credentials and salts. Values that wp-config.php computes (getenv(), constants) are asked for.
export async function readConfig(ui, root, flags) {
  const configPath = findConfig(root);
  if (!configPath) throw new Abort('wp-config.php not found next to WordPress or one folder above it.');
  const { defines, tablePrefix } = parseWpConfig(fs.readFileSync(configPath, 'utf8'));
  if (defines.MULTISITE === true) {
    throw new Abort('This is a WordPress Multisite network. hostlesswp does not support Multisite yet.');
  }
  const literal = (k) => (typeof defines[k] === 'string' ? defines[k] : undefined);
  const DB_FIELD = { DB_NAME: 'name', DB_USER: 'user', DB_PASSWORD: 'password', DB_HOST: 'host' };
  // --db-* flags are one-off overrides and are not saved; values wp-config.php computes are asked once and saved.
  const ask = async (k, flag, secret = false) => {
    if (flags[flag] !== undefined) return String(flags[flag]);
    if (literal(k) !== undefined) return literal(k);
    const how = defines[k] && defines[k].expr ? ` (wp-config.php computes it: ${pc.dim(defines[k].expr)})` : '';
    const q = { flag, remember: 'db.' + DB_FIELD[k], message: `${k}${how}` };
    return secret ? ui.password(q) : ui.text(q);
  };
  const db = {
    name: await ask('DB_NAME', 'db-name'),
    user: await ask('DB_USER', 'db-user'),
    password: await ask('DB_PASSWORD', 'db-password', true),
    ...parseDbHost(await ask('DB_HOST', 'db-host')),
    charset: literal('DB_CHARSET') || 'utf8mb4',
    collate: literal('DB_COLLATE') || '',
  };
  // Connection details entered after a failed connection replace what wp-config.php says (flags still win).
  const saved = ui.config?.get('dbConnect');
  if (saved) {
    for (const [f, flag] of [['host', 'db-host'], ['port', 'db-port'], ['user', 'db-user'], ['password', 'db-password']]) {
      if (saved[f] !== undefined && flags[flag] === undefined) db[f] = saved[f];
    }
    if (saved.host !== undefined && flags['db-host'] === undefined) db.socketPath = null;
  }
  if (flags['db-port']) db.port = Number(flags['db-port']);
  const salts = {};
  const missing = SALT_KEYS.filter((k) => literal(k) === undefined);
  if (missing.length) {
    // Keys computed at runtime (getenv(), hashes) cannot be read without executing wp-config.php.
    const ok = await ui.confirm({
      flag: 'new-salts',
      remember: 'newSalts',
      message: `wp-config.php does not set ${missing.length === SALT_KEYS.length ? 'its security keys' : missing.join(', ')} as plain text. Generate new keys for the Worker? (everyone will need to log in again there; your current site is not affected)`,
      initial: true,
    });
    if (!ok) throw new Abort('Put the keys in wp-config.php as plain define() values (https://api.wordpress.org/secret-key/1.1/salt/), then run again.');
  }
  for (const k of SALT_KEYS) salts[k] = literal(k) ?? crypto.randomBytes(48).toString('base64');
  // A few settings worth carrying over when they are plain values.
  const extraDefines = {};
  for (const k of ['WPLANG', 'WP_POST_REVISIONS', 'EMPTY_TRASH_DAYS', 'WP_DEFAULT_THEME', 'FORCE_SSL_ADMIN', 'DISALLOW_FILE_EDIT', 'WP_ENVIRONMENT_TYPE']) {
    if (defines[k] !== undefined && typeof defines[k] !== 'object') extraDefines[k] = defines[k];
  }
  return { configPath, defines, db, salts, saltsGenerated: missing.length > 0, tablePrefix: tablePrefix ?? 'wp_', extraDefines };
}

export async function connectDb(ui, cfg) {
  for (;;) {
    const s = spinner();
    s.start(`Connecting to MySQL ${cfg.db.socketPath || cfg.db.host + ':' + cfg.db.port} as ${cfg.db.user}`);
    try {
      const { conn, via } = await connect(cfg.db);
      if (via.socketPath) cfg.db.socketPath = via.socketPath;
      s.stop('Connected to the database');
      return conn;
    } catch (e) {
      s.stop(pc.red(`Could not connect: ${e.code || ''} ${e.message}`), 1);
      if (!ui.interactive) throw new Abort('Database connection failed. Check DB_* in wp-config.php or pass --db-host/--db-user/--db-password.');
      p.note('hostlesswp reads your database from this machine, the same way WordPress does.\nIf WordPress uses a different address from here (Docker, a remote host), enter it below.', 'Database');
      const host = await ui.text({ message: 'Database host', initial: cfg.db.host });
      const port = await ui.text({ message: 'Port', initial: String(cfg.db.port) });
      cfg.db.host = host;
      cfg.db.port = Number(port) || 3306;
      cfg.db.socketPath = null;
      cfg.db.user = await ui.text({ message: 'User', initial: cfg.db.user });
      cfg.db.password = await ui.password({ message: 'Password' });
      ui.config?.set('dbConnect', { host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password });
    }
  }
}

// `check` passes reportOnly so problems that block a move are listed instead of stopping the report.
export async function inspectSite(ui, flags, { saveAnswers = true, reportOnly = false } = {}) {
  const root = await locateSite(ui, flags);
  ui.useConfig(openSiteConfig(root, { readOnly: !saveAnswers }));
  const cfg = await readConfig(ui, root, flags);
  const conn = await connectDb(ui, cfg);
  let info;
  try {
    info = await inspect(conn, cfg.tablePrefix);
  } catch (e) {
    await conn.end();
    if (e.code === 'ER_NO_SUCH_TABLE') throw new Abort(`No ${cfg.tablePrefix}options table in ${cfg.db.name}. Is $table_prefix right?`);
    throw e;
  }
  // A recent post and page give the precompile step representative templates.
  const [posts] = await conn.query(`SELECT ID, post_type FROM \`${cfg.tablePrefix}posts\` WHERE post_status = 'publish' AND post_type IN ('post','page') ORDER BY post_date DESC LIMIT 20`);
  await conn.end();
  if (info.multisite) throw new Abort('This database belongs to a Multisite network. hostlesswp does not support Multisite yet.');
  const uploadProblem = uploadFolderProblem({ defines: cfg.defines, uploadPath: info.uploadPath, root });
  if (uploadProblem && !reportOnly) throw new Abort(uploadProblem);
  const uploads = dirSize(path.join(root, 'wp-content', 'uploads'), (f) => !/\.(php|phtml)$/i.test(f));
  return {
    root,
    cfg,
    info,
    wpVersion: readVersion(root),
    uploads,
    uploadProblem,
    samplePosts: { post: posts.find((r) => r.post_type === 'post')?.ID, page: posts.find((r) => r.post_type === 'page')?.ID },
    dropins: presentDropins(root),
  };
}

const ICON = { works: pc.green('✔'), 'works-with-limits': pc.yellow('▲'), untested: pc.dim('?') };

export function reportSite(site) {
  const { info, cfg } = site;
  p.note(
    [
      `${pc.bold(info.blogname || '(no title)')}  ${pc.dim(info.home || '')}`,
      `WordPress ${site.wpVersion}, theme ${info.stylesheet}${info.template !== info.stylesheet ? ` (child of ${info.template})` : ''}`,
      `Database ${cfg.db.name} on ${info.server}${info.mariadb ? ' (MariaDB)' : ''}: ${info.tables} tables, ${fmtBytes(info.bytes)}`,
      `Media library: ${site.uploads.files} files, ${fmtBytes(site.uploads.bytes)}`,
    ].join('\n'),
    'Your site',
  );
  const plugins = assessPlugins(info.pluginSlugs);
  const lines = plugins.map((x) => `${ICON[x.status]} ${x.name}${x.status === 'untested' ? pc.dim('  not in the tested list yet') : ''}${x.note ? pc.dim('\n   ' + x.note) : ''}`);
  for (const d of site.dropins) lines.push(`${pc.yellow('▲')} wp-content/${d}${pc.dim('\n   ' + DROPINS[d])}`);
  if (lines.length) p.note(lines.join('\n'), `Active plugins (${info.pluginSlugs.length})`);
  const compat = loadCompat();
  const limits = compat.features.filter((f) => f.status !== 'works').map((f) => `${pc.yellow('•')} ${f.feature}: ${pc.dim(f.note)}`);
  p.note(limits.join('\n'), 'Not supported on Workers yet');
  return plugins;
}
