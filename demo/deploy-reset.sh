#!/bin/sh
# Deploys reset-worker next to the demo Worker, reusing the demo's Hyperdrive config and placement from the
# HostlessWP state file. Run dump-snapshot.sh first. A random RESET_TOKEN is uploaded on the first deploy.
set -eu
cd "$(dirname "$0")"
NAME="${DEMO_NAME:-hostlesswp-demo}"
STATE="${HOSTLESSWP_HOME:-$HOME/.hostlesswp}/sites/$NAME/state.json"
[ -f reset-worker/src/snapshot.sql ] || { echo "run dump-snapshot.sh first" >&2; exit 1; }
node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const cfg = {
  name: s.name + "-reset",
  main: "src/index.js",
  compatibility_date: "2026-10-01",
  compatibility_flags: ["nodejs_compat"],
  hyperdrive: [{ binding: "HYPERDRIVE", id: s.hyperdriveId }],
  // Page cache of the demo: a reset changes content behind WordPress, so it bumps the cache version too.
  ...(s.cacheKvId ? { kv_namespaces: [{ binding: "PAGE_CACHE", id: s.cacheKvId }] } : {}),
  ...(s.region ? { placement: { region: "aws:" + s.region } } : {}),
  rules: [{ type: "Text", globs: ["**/*.sql"], fallthrough: false }],
  durable_objects: { bindings: [{ name: "SCHEDULE", class_name: "ResetSchedule" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["ResetSchedule"] }],
  // Backup path only; the main schedule is the Durable Object alarm in src/index.js (RESET_HOURS).
  triggers: { crons: [process.env.RESET_CRON || "0 */3 * * *"] },
  vars: { DEMO_URL: s.url || "" },
  observability: { enabled: true },
};
fs.writeFileSync("reset-worker/wrangler.jsonc", JSON.stringify(cfg, null, 2) + "\n");
' "$STATE"
WRANGLER="node $(cd .. && pwd)/node_modules/wrangler/bin/wrangler.js"
(cd reset-worker && $WRANGLER deploy)
if [ ! -f .reset-token ]; then
  node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))' > .reset-token
  chmod 600 .reset-token
  (cd reset-worker && $WRANGLER secret put RESET_TOKEN < ../.reset-token)
fi
URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)' reset-worker/wrangler.jsonc)
# Arm the alarm right away (a GET does it) and show the schedule.
curl -s "https://$URL.$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(new URL(s.url).hostname.split(".").slice(1).join("."))' "$STATE")/" ; echo
echo "manual reset: curl -X POST -H \"authorization: Bearer \$(cat demo/.reset-token)\" <reset-worker-url>/reset"
