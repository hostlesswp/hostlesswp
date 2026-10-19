import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWpConfig, parseDbHost, phpUnserialize, pluginSlug, stripPhpComments, uploadFolderProblem } from '../lib/wpsite.mjs';
import { nearestRegion, isPrivateIp } from '../lib/geo.mjs';

test('wp-config literals, including salts with ; ) /* // # inside', () => {
  const src = `<?php
/* block comment define('X', 'no'); */
define( 'DB_NAME', 'site' );
define("DB_HOST", "db.example.com:3307");
define('AUTH_KEY', 'a;b)c/*d//e#f');
define('NONCE_SALT', "q\\"w");
define('DB_PASSWORD', getenv('DB_PASS'));
define('WP_DEBUG', false);
define('WP_POST_REVISIONS', 5);
// define('DB_USER', 'commented');
# define('DB_USER', 'hash-commented');
$table_prefix  = 'abc_';`;
  const { defines, tablePrefix } = parseWpConfig(src);
  assert.equal(defines.DB_NAME, 'site');
  assert.equal(defines.DB_HOST, 'db.example.com:3307');
  assert.equal(defines.AUTH_KEY, 'a;b)c/*d//e#f');
  assert.equal(defines.NONCE_SALT, 'q"w');
  assert.deepEqual(defines.DB_PASSWORD, { expr: "getenv('DB_PASS')" });
  assert.equal(defines.WP_DEBUG, false);
  assert.equal(defines.WP_POST_REVISIONS, 5);
  assert.equal(defines.DB_USER, undefined);
  assert.equal(defines.X, undefined);
  assert.equal(tablePrefix, 'abc_');
});

test('comment stripping keeps strings intact', () => {
  assert.equal(stripPhpComments(`a('x//y') // z\nb`), `a('x//y') \nb`);
});

test('DB_HOST forms', () => {
  assert.deepEqual(parseDbHost('localhost'), { host: 'localhost', port: 3306, socketPath: null });
  assert.deepEqual(parseDbHost('10.0.0.5:3307'), { host: '10.0.0.5', port: 3307, socketPath: null });
  assert.deepEqual(parseDbHost('localhost:/var/run/mysqld/mysqld.sock'), { host: 'localhost', port: 3306, socketPath: '/var/run/mysqld/mysqld.sock' });
  assert.deepEqual(parseDbHost(':/tmp/mysql.sock'), { host: 'localhost', port: 3306, socketPath: '/tmp/mysql.sock' });
  assert.deepEqual(parseDbHost('[::1]:3308'), { host: '::1', port: 3308, socketPath: null });
});

test('active_plugins unserialize, multibyte lengths', () => {
  const v = phpUnserialize('a:3:{i:0;s:9:"hello.php";i:1;s:27:"woocommerce/woocommerce.php";i:2;s:13:"é/plugin.php";}');
  assert.deepEqual(Object.values(v), ['hello.php', 'woocommerce/woocommerce.php', 'é/plugin.php']);
  assert.deepEqual(Object.values(v).map(pluginSlug), ['hello', 'woocommerce', 'é']);
  assert.deepEqual(phpUnserialize('a:0:{}'), {});
});

test('placement region and private addresses', () => {
  assert.equal(nearestRegion([36.85, -75.98]).region, 'us-east-1'); // Virginia Beach
  assert.match(nearestRegion([52.37, 4.9]).region, /^eu-/); // Amsterdam
  assert.equal(nearestRegion([1.29, 103.85]).region, 'ap-southeast-1');
  assert.ok(isPrivateIp('192.168.1.2') && isPrivateIp('10.1.1.1') && isPrivateIp('127.0.0.1') && isPrivateIp('172.20.0.3'));
  assert.ok(!isPrivateIp('47.88.1.1') && !isPrivateIp('example.com'));
});

test('custom upload folder is reported; the default folder is fine', () => {
  const root = '/var/www/html';
  assert.equal(uploadFolderProblem({ defines: {}, uploadPath: null, root }), null);
  assert.equal(uploadFolderProblem({ defines: {}, uploadPath: '', root }), null);
  assert.equal(uploadFolderProblem({ defines: {}, uploadPath: 'wp-content/uploads', root }), null);
  assert.equal(uploadFolderProblem({ defines: {}, uploadPath: 'wp-content/uploads/', root }), null);
  assert.equal(uploadFolderProblem({ defines: {}, uploadPath: '/var/www/html/wp-content/uploads', root }), null);
  assert.match(uploadFolderProblem({ defines: {}, uploadPath: 'files', root }), /upload_path/);
  assert.match(uploadFolderProblem({ defines: {}, uploadPath: '/srv/media', root }), /\/srv\/media/);
  assert.match(uploadFolderProblem({ defines: { UPLOADS: 'media' }, uploadPath: '', root }), /UPLOADS/);
  assert.match(uploadFolderProblem({ defines: { UPLOADS: { expr: "getenv('X')" } }, uploadPath: '', root }), /UPLOADS/);
});
