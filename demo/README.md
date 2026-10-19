# Public demo

The live demo (`hostlesswp-demo`) is an ordinary WordPress deployed with HostlessWP itself, plus a reset Worker that restores its database every 3 hours.

| Piece | What it is |
|---|---|
| `setup-source.sh` | Builds the source site in `demo/source/`: WordPress, Twenty Twenty-Five, sample posts and images, popular plugins from the tested list (WooCommerce with its sample products, Yoast SEO, Contact Form 7, Advanced Custom Fields, Duplicate Post, Redirection, WPCode, WordPress Importer; `DEMO_PLUGINS` overrides the list; Elementor and WPForms are left out because all active plugins together must fit the Worker's 128 MB), an Administrator account `demo` / `demo`. Installs into its own table prefix (`demo_`) and only ever drops tables with that prefix. |
| `mu-plugins/hostlesswp-demo.php` | Demo rules: reset banner, login hint, and an administrator demo account with only what would reach other visitors held back: no raw HTML or scripts in content, uploads up to 10 MB, the demo and owner accounts cannot be changed or deleted, and registration settings and the admin email stay fixed. |
| `dump-snapshot.sh` | Dumps the rows of every demo table to `reset-worker/src/snapshot.sql` (data only; contains password hashes, never commit it). |
| `reset-worker/` | Every 3 hours on the hour (UTC) it empties each demo table and inserts the snapshot rows again. The schedule is a Durable Object alarm that re-arms itself after each run; a Cron Trigger (`0 */3 * * *`) is kept as a second path and skips its run when the alarm already reset within the last 30 minutes (it can fire minutes late and would wipe changes made after the alarm's reset). `GET /` shows the next and last reset (and arms the alarm if missing); `POST /reset` resets now and `POST /arm?in=60` fires the alarm once in 60 seconds, both with the `RESET_TOKEN` secret. After each reset it bumps the demo's page cache version, so cached pages are rendered again (visible on the demo within about a minute, as KV changes spread). |
| `deploy-reset.sh` | Deploys the reset Worker with the demo's Hyperdrive config, page cache namespace and placement (read from `~/.hostlesswp/sites/hostlesswp-demo/state.json`). |

## Rebuild from scratch

```sh
export DEMO_DB_HOST=... DEMO_DB_USER=... DEMO_DB_PASSWORD=... DEMO_DB_NAME=...   # MySQL with SSL
./demo/setup-source.sh
(cd demo/source && npx hostlesswp --name hostlesswp-demo --db-access public)
./demo/dump-snapshot.sh            # set MYSQLDUMP="docker exec -i <container> mysqldump" if mysqldump is not installed
./demo/deploy-reset.sh
```

After changing the demo content, run `dump-snapshot.sh` and `deploy-reset.sh` again. After changing the mu-plugin, copy it into `demo/source/wp-content/mu-plugins/` and run `npx hostlesswp deploy` from `demo/source`.

## Why an alarm and not only a Cron Trigger

On 2026-10-14 the Cron Triggers of newly deployed Workers on our account did not fire for hours (the schedule was registered, Cloudflare's invocation analytics showed no runs, while older Workers on the same account ran normally). A Durable Object alarm is a separate mechanism and fired on time, so the demo relies on it.
