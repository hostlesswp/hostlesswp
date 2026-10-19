// Restores the public demo's database every few hours (Cron Trigger), or on POST /reset with the RESET_TOKEN secret.
// snapshot.sql (from demo/dump-snapshot.sh) holds the rows of every demo table; each table is emptied and refilled.
// Table structures are never touched, and only the tables listed in the snapshot header are affected.
import { DurableObject } from 'cloudflare:workers';
import { createConnection } from 'mysql2/promise';
import snapshot from './snapshot.sql';

// Every RESET_HOURS hours on the hour (UTC); keep in sync with HOSTLESSWP_DEMO_RESET_HOURS in the demo mu-plugin.
const RESET_HOURS = 3;
const nextBoundary = (now = Date.now()) => (Math.floor(now / (RESET_HOURS * 3600e3)) + 1) * RESET_HOURS * 3600e3;

const header = snapshot.match(/^-- tables: (.+)$/m);
const TABLES = header ? header[1].trim().split(/\s+/) : [];
// mysqldump escapes newlines inside strings, so a statement always ends at ";" + newline.
const body = snapshot.split(/\r?\n/).filter((l) => !l.startsWith('-- ')).join('\n');
const INSERTS = body.split(/;\r?\n/).map((s) => s.trim().replace(/;$/, '')).filter((s) => /^INSERT INTO `/.test(s));
// Fail loudly at deploy time rather than restoring half a site.
const EXPECTED = (body.match(/^INSERT INTO `/gm) || []).length;
if (INSERTS.length !== EXPECTED) throw new Error(`snapshot parse mismatch: ${INSERTS.length} of ${EXPECTED} INSERT statements`);

async function reset(env) {
  if (!TABLES.length || !INSERTS.length) throw new Error('empty snapshot');
  const h = env.HYPERDRIVE;
  const db = await createConnection({ host: h.host, user: h.user, password: h.password, database: h.database, port: h.port, disableEval: true });
  const t0 = Date.now();
  try {
    // One transaction (DELETE, not TRUNCATE, which commits on its own): visitors keep seeing the old rows until the
    // new ones are in. Without it, a request between emptying and refilling (wp-cron fires on the hour, like the
    // reset) wrote options such as `cron` into the empty tables, the snapshot INSERT then hit a duplicate key, and
    // the demo stayed empty until the next reset. On any error the old data stays.
    await db.query('START TRANSACTION');
    try {
      for (const t of TABLES) await db.query('DELETE FROM `' + t.replace(/`/g, '') + '`');
      // Zero dates and explicit ids must be accepted whatever the server's sql_mode is. Hyperdrive does not keep
      // session SETs between statements, so the mode travels with each statement as an optimizer hint.
      for (const s of INSERTS) await db.query(s.replace(/^INSERT INTO/, "INSERT /*+ SET_VAR(sql_mode='NO_AUTO_VALUE_ON_ZERO') */ INTO"));
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      throw e;
    }
  } finally {
    await db.end().catch(() => {});
  }
  // Cached demo pages show the visitors' changes; mark them outdated (same key and format as runtime/src/page-cache.js).
  if (env.PAGE_CACHE) await env.PAGE_CACHE.put('v', Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).catch((e) => console.log('page cache bump failed', String(e)));
  return { tables: TABLES.length, statements: INSERTS.length, ms: Date.now() - t0, at: new Date().toISOString() };
}

// The schedule lives in a Durable Object alarm: it is stored with the object and re-armed after every run, so it
// does not depend on Cron Trigger propagation (which, on this account, did not fire for new Workers for hours).
// The Cron Trigger below stays as a second, independent path; a reset is idempotent, so running twice is harmless.
export class ResetSchedule extends DurableObject {
  async alarm() {
    try {
      const r = await reset(this.env);
      await this.ctx.storage.put('last', r);
      console.log('demo reset (alarm)', JSON.stringify(r));
    } catch (e) {
      console.log('demo reset failed (alarm)', String(e && e.stack ? e.stack : e));
    } finally {
      await this.ctx.storage.setAlarm(nextBoundary());
    }
  }
  // Test hook: fire once in `seconds`, after which the alarm returns to the normal schedule.
  async armIn(seconds) {
    await this.ctx.storage.setAlarm(Date.now() + seconds * 1000);
    return this.arm();
  }
  // Arms the alarm if it is missing; returns the schedule state.
  async arm() {
    let at = await this.ctx.storage.getAlarm();
    if (!at) {
      at = nextBoundary();
      await this.ctx.storage.setAlarm(at);
    }
    return { nextReset: new Date(at).toISOString(), last: (await this.ctx.storage.get('last')) || null };
  }
}

const schedule = (env) => env.SCHEDULE.get(env.SCHEDULE.idFromName('demo'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const authed = env.RESET_TOKEN && request.headers.get('authorization') === 'Bearer ' + env.RESET_TOKEN;
    if (request.method === 'POST' && (url.pathname === '/reset' || url.pathname === '/arm')) {
      if (!authed) return new Response('unauthorized', { status: 401 });
      if (url.pathname === '/reset') return Response.json(await reset(env));
      return Response.json(await schedule(env).armIn(Math.max(10, Math.min(3600, Number(url.searchParams.get('in')) || 60))));
    }
    // Any status request also makes sure the alarm is armed.
    return Response.json({ demo: env.DEMO_URL || null, tables: TABLES.length, everyHours: RESET_HOURS, ...(await schedule(env).arm()) });
  },
  async scheduled(event, env, ctx) {
    // The Cron Trigger is only a second path for the alarm, and it can fire minutes late: resetting again then would
    // wipe whatever changed since the alarm's reset, so skip when the alarm already ran for this slot.
    const state = await schedule(env).arm();
    if (state.last && Date.now() - Date.parse(state.last.at) < 30 * 60 * 1000) {
      return console.log('demo reset skipped (alarm already ran)', state.last.at);
    }
    ctx.waitUntil(reset(env).then((r) => console.log('demo reset', JSON.stringify(r)), (e) => console.log('demo reset failed', String(e && e.stack ? e.stack : e))));
  },
};
