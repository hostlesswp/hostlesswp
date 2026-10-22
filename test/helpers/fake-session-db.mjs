// A MySQL stand-in for the statements session.js sends; fails with ER_NO_SUCH_TABLE until the table is created.
export function fakeSessionDb() {
  let rows = null;
  const sql = [];
  const query = async (q, p) => {
    sql.push(q);
    if (/^CREATE TABLE/.test(q)) {
      rows = rows || new Map();
      return { affectedRows: 0 };
    }
    if (!rows) throw Object.assign(new Error("Table 'db.wp_hostlesswp_sessions' doesn't exist"), { errno: 1146 });
    if (/^SELECT/.test(q)) return [...rows].filter(([id, r]) => id === p[0] && r.expires > p[1]).map(([, r]) => ({ data: r.data }));
    if (/^INSERT/.test(q)) return rows.set(p[0], { data: p[1], expires: p[2] }) && { affectedRows: 1 };
    if (/^UPDATE/.test(q)) return rows.has(p[1]) ? (rows.get(p[1]).expires = p[0]) && { affectedRows: 1 } : { affectedRows: 0 };
    if (/^DELETE .* WHERE id/.test(q)) return { affectedRows: rows.delete(p[0]) ? 1 : 0 };
    if (/^DELETE .* WHERE expires/.test(q)) {
      let n = 0;
      for (const [id, r] of rows) if (r.expires <= p[0] && rows.delete(id)) n++;
      return { affectedRows: n };
    }
    throw new Error('unexpected ' + q);
  };
  return { query, sql };
}
