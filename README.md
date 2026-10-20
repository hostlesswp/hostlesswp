# HostlessWP

Move a running WordPress site onto Cloudflare Workers with one command.

```sh
npx hostlesswp
```

HostlessWP takes the WordPress you already have (core, theme, plugins, media and your MySQL database) and runs it on Cloudflare Workers: PHP 8.3 compiled to WebAssembly, your database reached through Cloudflare Hyperdrive, your media library in S3-compatible storage (R2, AWS S3, B2, MinIO...). WordPress core is not modified. A guided setup walks you through each step and tells you up front what will not work.

**Live demo:** https://hostlesswp-demo.qc2uyes.workers.dev (log in with `demo` / `demo`; it resets every 3 hours, see [demo/](demo/README.md)).

**Website:** [hostlesswp.com](https://hostlesswp.com) · [Plugin compatibility](https://hostlesswp.com/compatibility) · [Can WordPress run on Cloudflare?](https://hostlesswp.com/can-wordpress-run-on-cloudflare) · [Migrate WordPress to Cloudflare](https://hostlesswp.com/migrate-wordpress-to-cloudflare) · [Cost](https://hostlesswp.com/cost) · [Benchmarks](https://hostlesswp.com/benchmarks) · [HostlessWP vs EmDash](https://hostlesswp.com/vs/emdash)

> **Status: early preview (v0.1).** It works on real sites in our tests, but expect rough edges. Your current site is never changed, so trying it is safe.

## Quick start

1. A Cloudflare account. The Workers Free plan runs a site in our tests; its daily limits are 100,000 requests, 100,000 database queries (Hyperdrive) and 1,000 page cache writes (KV). Pages for logged-out visitors come from the page cache and use no queries. For a busier site, the [Workers Paid plan](https://dash.cloudflare.com/?to=/:account/workers/plans) ($5/month) raises the limits and allows longer requests (imports).
2. Make sure your MySQL server has SSL enabled (Hyperdrive only connects over SSL; the wizard checks and explains how).
3. Create an S3-compatible bucket for your media library and an access key that can read and write it. On Cloudflare R2: R2 > Create bucket, then Manage API tokens > Object Read & Write on that bucket.
4. On the machine that has your site's files and can reach its database (usually the server itself, over SSH), go to the folder with `wp-config.php` and run:

   ```sh
   npx hostlesswp check   # read-only report, changes nothing
   npx hostlesswp         # guided setup and deploy
   ```

5. Open the `*.workers.dev` address it prints, log in with your usual account, click around.
6. When you are happy, add your domain to the Worker in the Cloudflare dashboard (Workers > your Worker > Settings > Domains & Routes). Until then your current host keeps serving it.

After changing plugins, themes or WordPress on the source site, run `npx hostlesswp deploy`.

## What the setup does

| Step | What happens | Changes anything? |
|---|---|---|
| Check | Reads `wp-config.php` (parsed, never executed), connects to MySQL, lists your active plugins against the [compatibility list](data/compat.json), flags drop-ins and unsupported features | No |
| Cloudflare | Logs in through Wrangler (opens a browser) and picks the account | No |
| Database access | Creates a Hyperdrive config to your MySQL, either over the internet with SSL or through a Cloudflare Tunnel run from your server. Caching is off, because WordPress reads its own writes | Creates resources in your Cloudflare account |
| Placement | Locates your database and runs the Worker next to it (`placement.region`) | No |
| Media storage | Asks for your S3-compatible bucket and checks the key can write, read, list and delete there | Writes and deletes one probe object in the bucket |
| Package | Bundles WordPress, the active theme (and parent), active plugins, mu-plugins and translations; copies new or changed media to your bucket (never deletes there) | Writes to `~/.hostlesswp/sites/<name>/` and your bucket |
| Precompile | Renders a few pages locally against your database and packs PHP's OPcache, so new Worker instances start faster | Same reads and writes any visitor causes |
| Deploy | Deploys the Worker with your site's own keys and salts as a secret, so existing logins stay valid; adds a Cron Trigger for WP-Cron | Deploys to `<name>.<subdomain>.workers.dev` |
| Verify | Requests the home page and reports status, PHP time and query count | No |

Your answers during setup (Cloudflare account, database access, region, media storage, and any database details hostlesswp had to ask for) are saved in `hostlesswp-config.php` next to `wp-config.php`, so `npx hostlesswp deploy` asks nothing again. It contains passwords and keys: it is created with permissions 0600, starts with `<?php exit; ?>` so your web server shows nothing if someone requests it, and is never uploaded to Cloudflare. Do not commit it to version control. Delete it to answer everything again. What hostlesswp created (Worker name, Hyperdrive id, tunnel) is in `~/.hostlesswp/sites/<name>/state.json`.

## How it runs

```
Visitor ──► Cloudflare edge ──► static files (theme/plugin assets, wp-includes)
                     │
                     └──────► Worker next to your database
                                php-wasm (PHP 8.3) + OPcache + precompiled scripts
                                WordPress core, your theme and plugins in memory
                                       │
                                       └──► Hyperdrive ──► your MySQL (SSL or Tunnel)
                                       └──► your S3 bucket (wp-content/uploads)
```

The runtime layer is small and lives in [`runtime/`](runtime):

- **Database bridge.** A `db.php` drop-in sends every `wpdb` query to the Worker, which runs it through Hyperdrive. A userland `mysqli` covers plugins that use it directly. Hyperdrive can run consecutive statements on different server connections, so session state is carried per statement (`SET_VAR` hints), `SELECT @@var` is answered from `SHOW VARIABLES`, and `SQL_CALC_FOUND_ROWS` paging runs as a parallel `COUNT`.
- **HTTP.** `wp_remote_*` calls go through the Worker's `fetch()`.
- **Clock.** Workers freeze the clock during CPU work; PHP functions that wait for the clock to move (`uniqid()`) would spin, so the clock is made strictly monotonic.
- **OPcache.** php-wasm's OPcache does not start by default (its SAPI is not on OPcache's whitelist); the build patches that, uses shared memory, and mounts precompiled scripts. The mounted file cache is read-only at runtime: scripts compiled on the Worker would otherwise be written to memory as well.
- **WP-Cron** runs from a Cloudflare Cron Trigger every 15 minutes instead of during page views.
- **Media.** `wp-content/uploads` lives in your S3-compatible bucket. PHP writes uploads to memory as usual; after each request the Worker copies new files to the bucket. Unique file names are checked against the bucket, originals are fetched when you edit an image, and deleting an attachment deletes its files. Media URLs stay `/wp-content/uploads/...` and are served from the bucket (cached at the edge) without starting PHP; set a public or CDN address for the bucket to serve new media from there instead.

## Commands

```
npx hostlesswp           guided setup: check, connect Cloudflare and your database, deploy
npx hostlesswp check     read-only compatibility report
npx hostlesswp deploy    rebuild and redeploy after changing plugins, themes or WordPress
```

| Option | Meaning |
|---|---|
| `--path <dir>` | WordPress folder (default: current folder) |
| `--name <worker>` | Worker name (default: derived from your domain) |
| `--db-access public\|tunnel` | how Cloudflare reaches MySQL |
| `--db-public-host <host>` | public address of MySQL when `DB_HOST` is local but access is public |
| `--region <aws-region>\|none` | where the Worker runs (default: next to your database) |
| `--account <id>` | Cloudflare account, when you have several |
| `--db-host`, `--db-port`, `--db-user`, `--db-password`, `--db-name` | override `wp-config.php` |
| `--s3-endpoint`, `--s3-region`, `--s3-bucket`, `--s3-prefix`, `--s3-public-url` | media storage; keys come from `HOSTLESSWP_S3_ACCESS_KEY_ID` and `HOSTLESSWP_S3_SECRET_ACCESS_KEY` |
| `--resync-uploads` | overwrite media in the bucket that differs from this server (size or checksum) |
| `--no-precompile` | skip precompiling (faster deploy, slower cold starts) |
| `--no-page-cache` | serve every page view through PHP (no page cache) |
| `--allow-free=false` | stop instead of deploying when the account is on the Workers Free plan |
| `--recheck-plan` | after upgrading to Workers Paid, deploy with the paid settings again |
| `--yes` | never prompt; use defaults and flags (CI) |
| `--json` | with `check`: also print the report as JSON |

## Database access: public or tunnel

**Over the internet** suits managed databases (Amazon RDS, Aliyun RDS, DigitalOcean, and the like). The database must accept remote connections with SSL from Cloudflare.

**Through a tunnel** keeps the database private. hostlesswp creates a Cloudflare Tunnel and a Workers VPC service, and starts the connector (`wrangler tunnel run`) in the background on your server. It must keep running; for production run it under systemd or pm2, or use the install command the Cloudflare dashboard shows for the tunnel.

Either way the database needs SSL turned on, because Hyperdrive requires it.

## Media storage

The Worker has no lasting disk, so `wp-content/uploads` is kept in S3-compatible storage. Any service with the S3 API works: Cloudflare R2, AWS S3, Backblaze B2, MinIO, and others.

- Every deploy copies files from your site's `wp-content/uploads` that the bucket does not have yet. A file whose bucket copy differs in size is left alone, because an upload made on the Worker may share its name; deploy warns about these, and `--resync-uploads` overwrites media in the bucket that differs from this server (size or checksum). Nothing is ever deleted there: after the move, uploads made on the Worker exist only in the bucket.
- Media must live in the default `wp-content/uploads` folder. A site that moved it (the `UPLOADS` constant in `wp-config.php` or the `upload_path` option) is stopped before deploying, with steps to move it back.
- The bucket can stay private. Media is served through the Worker at the usual `/wp-content/uploads/...` URLs and cached at the edge. Each media request counts as a Worker request; on image-heavy sites, give the bucket a public or CDN address (`--s3-public-url`, for R2 a custom domain on the bucket) and new media URLs point there directly.
- Use `--s3-prefix` to share one bucket between several sites.

## Page cache

Starting PHP on a fresh Worker takes seconds, so pages for visitors who are not logged in are cached in Workers KV (a namespace named `<worker>-page-cache`, created on deploy) and answered without starting PHP.

- Not cached: logged-in users, commenters, password-protected posts, shoppers with a cart (WooCommerce), searches, previews, the admin, the login page and the REST API, and any response that sets a cookie, sends `Cache-Control: no-cache` or `private`, or comes from a page a plugin marks with `DONOTCACHEPAGE` (WooCommerce cart, checkout and account pages).
- Publishing or editing content, approving comments, changing menus, widgets, the theme, plugins, settings or WooCommerce stock marks every cached page as outdated, as does each deploy. The next visitor of an outdated page still gets the cached copy while the page renders again in the background, so after an edit one visit can show the previous version. A page is never served older than 8 hours.
- The front page is rendered again every 15 minutes when needed, with WP-Cron.
- Responses carry `x-hostlesswp-cache` (`hit`, `stale`, `miss`, `bypass`, `skip`). A forced reload in the browser (`Cache-Control: no-cache`) renders the page fresh.
- Content changed outside WordPress (directly in the database) shows up on the next edit in WordPress or after 8 hours.
- On the Workers Free plan, KV allows 1,000 writes a day; once they are used up pages are no longer stored that day and are rendered by PHP.
- On the Workers Free plan a Worker is stopped at about 2 seconds of CPU, less than a cold WordPress start (2 to 3 seconds with WooCommerce), while a Durable Object may use 30 seconds. There PHP runs in a Durable Object (`PhpRuntime`, placed near the database) and the Worker answers from the page cache and forwards everything else to it. On Workers Paid PHP runs in the Worker itself.

## What works and what does not

The 30 most-installed plugins on WordPress.org load and work at page level, and WooCommerce checkout, the Elementor editor and Yoast sitemaps were tested end to end. Details per plugin: [`data/compat.json`](data/compat.json), also shown as a searchable table at [hostlesswp.com/compatibility](https://hostlesswp.com/compatibility).

Not supported yet:

- **Email through PHP `mail()`.** Use a mail plugin that sends over an HTTP API.
- **Installing or updating plugins and themes from the admin.** Change them on the source site and run `npx hostlesswp deploy`.
- **Multisite.** hostlesswp stops before deploying.
- **Object cache drop-ins** (Redis, Memcached) are left out; WordPress uses its built-in cache.
- Theme and plugin files larger than 25 MiB are left out of static assets (Workers limit). Media files under 2 GB are copied to your bucket.
- **Uploads over 32 MB** by default (`s3.maxUploadMb` in `hostlesswp-config.php`; the Worker request size limit still applies).
- **Plugins that cache generated files in `wp-content/uploads`** (Elementor CSS, for example) work, but rebuild those files on every request.
- **Imagick** is not available; images are processed with GD.
- **Thumbnail regeneration plugins** that read originals from disk do not see them (they are in the bucket); editing images in the media library works.

## Performance

Measured in October 2026 with the database in US East (details and method in [hostlesswp.com/benchmarks](https://hostlesswp.com/benchmarks)):

| Setup | Per query | Core home page | WooCommerce home page |
|---|---|---|---|
| Worker near the visitor (Singapore), database in Virginia | ~230 ms | 7.7 s | 19.6 s |
| Worker next to the database (hostlesswp default) | ~33 ms | ~1.2 s | ~3 s |
| Direct connection without Hyperdrive (experimental, not in hostlesswp yet) | ~2 ms | 0.07 s | 0.19 s |

Times are PHP processing per warm request including database waits. Placement is the biggest factor, which is why HostlessWP sets it automatically. Hyperdrive itself added about 30 ms per query in these tests.

## Troubleshooting

- **"Hyperdrive could not connect"**: the database firewall must allow Cloudflare on the MySQL port, the user must be allowed from remote hosts (`'user'@'%'`), and SSL must be on. Or choose the tunnel.
- **"Your Cloudflare account is on the Workers Free plan"**: not an error; the site deploys on the Free plan. After upgrading to Workers Paid, run `npx hostlesswp deploy --recheck-plan` to use the paid settings.
- **"Missing permissions"**: run `npx wrangler login`, or give your API token Workers Scripts, Hyperdrive (and for tunnels Cloudflare Tunnel and Connectivity Directory) Edit permissions.
- **Site shows "temporarily unavailable"**: run `npx wrangler tail <name>` and load a page to see the error.
- **Skipped precompile**: your Node.js cannot run PHP's WebAssembly build locally (JSPI). Use Node 24+; the site works either way.
- Set `HOSTLESSWP_DEBUG=1` for full stack traces.

## Development

```
bin/hostlesswp.mjs        CLI entry
lib/                   wizard steps, build, Cloudflare (via Wrangler), precompile
runtime/src/           the Worker (index.js) and lazy zip file system
runtime/php/           wp-config template, db.php drop-in, mysqli polyfill, runtime mu-plugin
data/compat.json       tested plugins and features (used by the CLI and the website)
demo/                  the public demo: source site setup, demo rules, reset Worker
test/                  unit tests (`npm test`)
```

Run from a checkout with `node bin/hostlesswp.mjs check --path /path/to/wordpress`.

Adding a plugin to the compatibility list: deploy a site with only that plugin active, activate it from the admin, open the front page, the dashboard and the plugin's admin pages, and record the result and any limits in `data/compat.json` with the plugin version you tested. Pull requests with results are welcome.

## Credits

- [WordPress Playground](https://github.com/WordPress/wordpress-playground) for php-wasm (`@php-wasm/*`), which makes PHP in WebAssembly possible
- [Cloudflare Workers](https://developers.cloudflare.com/workers/), [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) and [Wrangler](https://developers.cloudflare.com/workers/wrangler/)

HostlessWP is an independent project and is not affiliated with Cloudflare, Automattic or WordPress.org.

## License

GPL-2.0-or-later, the same as WordPress. See [LICENSE](LICENSE).
