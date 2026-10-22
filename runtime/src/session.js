// PHP sessions in the site's database. A Worker instance keeps files only in memory and a site runs on many
// instances, so the file handler would lose sessions between requests; runtime/php/hostlesswp-session.php hands
// each operation to this. The table is created on the first write.

const NO_SUCH_TABLE = 1146;

// query(sql, params) runs one statement and returns mysql2's result (rows, or { affectedRows }).
export async function sessionBridge(query, msg, now = Math.floor(Date.now() / 1000)) {
  const table = '`' + String(msg.prefix || 'wp_').replace(/[^A-Za-z0-9_]/g, '') + 'hostlesswp_sessions`';
  const expires = now + Math.max(60, Number(msg.ttl) || 1440);
  const run = async () => {
    switch (msg.action) {
      case 'read': {
        const rows = await query(`SELECT data FROM ${table} WHERE id = ? AND expires > ?`, [msg.id, now]);
        return { data: rows.length ? rows[0].data : null };
      }
      case 'write':
        await query(`INSERT INTO ${table} (id, data, expires) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), expires = VALUES(expires)`, [msg.id, msg.data, expires]);
        return {};
      case 'touch':
        await query(`UPDATE ${table} SET expires = ? WHERE id = ?`, [expires, msg.id]);
        return {};
      case 'destroy':
        await query(`DELETE FROM ${table} WHERE id = ?`, [msg.id]);
        return {};
      case 'gc':
        return { deleted: (await query(`DELETE FROM ${table} WHERE expires <= ?`, [now])).affectedRows || 0 };
      default:
        throw new Error('unknown session action ' + msg.action);
    }
  };
  try {
    return await run();
  } catch (e) {
    if (e.errno !== NO_SUCH_TABLE) return { error: e.message || String(e) };
    // No session was ever written: nothing to read, touch or delete.
    if (msg.action !== 'write') return msg.action === 'read' ? { data: null } : msg.action === 'gc' ? { deleted: 0 } : {};
    await query(`CREATE TABLE IF NOT EXISTS ${table} (id VARCHAR(128) NOT NULL, data LONGTEXT NOT NULL, expires INT UNSIGNED NOT NULL, PRIMARY KEY (id), KEY expires (expires))`, []);
    return run().catch((err) => ({ error: err.message || String(err) }));
  }
}
