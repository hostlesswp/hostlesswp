import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionBridge } from '../runtime/src/session.js';
import { fakeSessionDb } from './helpers/fake-session-db.mjs';


test('sessions are stored in the database, the table made on the first write', async () => {
  const db = fakeSessionDb();
  const call = (msg, now = 1000) => sessionBridge(db.query, { prefix: 'wp_', ...msg }, now);
  assert.deepEqual(await call({ action: 'read', id: 'a' }), { data: null });
  assert.deepEqual(await call({ action: 'gc' }), { deleted: 0 });
  assert.deepEqual(await call({ action: 'write', id: 'a', data: 'eA==', ttl: 100 }), {});
  assert.ok(db.sql.some((q) => q.startsWith('CREATE TABLE IF NOT EXISTS `wp_hostlesswp_sessions`')));
  assert.deepEqual(await call({ action: 'read', id: 'a' }), { data: 'eA==' });
  assert.deepEqual(await call({ action: 'read', id: 'a' }, 1100), { data: null }, 'expired');
  await call({ action: 'touch', id: 'a', ttl: 500 }, 1050);
  assert.deepEqual(await call({ action: 'read', id: 'a' }, 1500), { data: 'eA==' }, 'touch extends the lifetime');
  assert.deepEqual(await call({ action: 'gc' }, 2000), { deleted: 1 });
  await call({ action: 'write', id: 'b', data: 'eQ==' });
  await call({ action: 'destroy', id: 'b' });
  assert.deepEqual(await call({ action: 'read', id: 'b' }), { data: null });
  await sessionBridge(db.query, { prefix: 'wp_`; DROP TABLE evil; --', action: 'read', id: 'x' });
  // Only letters, digits and _ of the prefix reach the SQL.
  assert.ok(db.sql.at(-1).includes('`wp_DROPTABLEevilhostlesswp_sessions`'));
});
