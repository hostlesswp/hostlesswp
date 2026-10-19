// Read-only inspection of the site's MySQL database from the machine running hostlesswp.
import mysql from 'mysql2/promise';
import { phpUnserialize, pluginSlug } from './wpsite.mjs';

const COMMON_SOCKETS = ['/var/run/mysqld/mysqld.sock', '/tmp/mysql.sock', '/var/lib/mysql/mysql.sock', '/run/mysqld/mysqld.sock', '/opt/homebrew/var/mysql/mysql.sock'];

// Tries TCP first, then the configured or common Unix sockets ("localhost" in PHP usually means a socket).
export async function connect(db) {
  const base = { user: db.user, password: db.password, database: db.name, connectTimeout: 8000, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true };
  const attempts = [];
  if (db.socketPath) attempts.push({ socketPath: db.socketPath });
  attempts.push({ host: db.host === 'localhost' ? '127.0.0.1' : db.host, port: db.port });
  if (!db.socketPath && ['localhost', '127.0.0.1'].includes(db.host)) for (const s of COMMON_SOCKETS) attempts.push({ socketPath: s });
  let lastErr;
  for (const a of attempts) {
    try {
      const conn = await mysql.createConnection({ ...base, ...a });
      return { conn, via: a };
    } catch (e) {
      lastErr = e;
      // Wrong password or unknown database will not get better on another transport.
      if (['ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(e.code)) break;
    }
  }
  throw lastErr;
}

async function option(conn, prefix, name) {
  const [rows] = await conn.query(`SELECT option_value FROM \`${prefix}options\` WHERE option_name = ? LIMIT 1`, [name]);
  return rows[0] ? rows[0].option_value : null;
}

export async function inspect(conn, prefix) {
  const [[v]] = await conn.query('SELECT VERSION() AS v');
  const vars = Object.fromEntries((await conn.query("SHOW VARIABLES WHERE Variable_name IN ('have_ssl','require_secure_transport','character_set_database','version_comment')"))[0].map((r) => [r.Variable_name, r.Value]));
  const [tables] = await conn.query('SELECT COUNT(*) AS n, COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE()');
  const activeRaw = await option(conn, prefix, 'active_plugins');
  let active = [];
  try {
    active = Object.values(phpUnserialize(activeRaw || 'a:0:{}'));
  } catch {}
  const multisite = (await conn.query(`SHOW TABLES LIKE '${prefix}blogs'`))[0].length > 0;
  return {
    server: v.v,
    mariadb: /mariadb/i.test(v.v + ' ' + (vars.version_comment || '')),
    ssl: vars.have_ssl === 'YES',
    requireSsl: vars.require_secure_transport === 'ON',
    tables: Number(tables[0].n),
    bytes: Number(tables[0].bytes),
    siteurl: await option(conn, prefix, 'siteurl'),
    home: await option(conn, prefix, 'home'),
    blogname: await option(conn, prefix, 'blogname'),
    template: await option(conn, prefix, 'template'),
    stylesheet: await option(conn, prefix, 'stylesheet'),
    uploadPath: await option(conn, prefix, 'upload_path'),
    activePlugins: active,
    pluginSlugs: [...new Set(active.map(pluginSlug))],
    multisite,
  };
}
