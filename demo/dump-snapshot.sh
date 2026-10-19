#!/bin/sh
# Dumps the data of every demo table (prefix DEMO_DB_PREFIX, default demo_) into reset-worker/src/snapshot.sql.
# Data only: the reset Worker empties each table and inserts these rows again; table structures are never changed.
# Uses mysqldump from PATH, or from Docker when MYSQLDUMP is set (e.g. MYSQLDUMP="docker exec -i some-mysql mysqldump").
set -eu
cd "$(dirname "$0")"
: "${DEMO_DB_HOST:?}" "${DEMO_DB_USER:?}" "${DEMO_DB_PASSWORD:?}" "${DEMO_DB_NAME:?}"
PREFIX="${DEMO_DB_PREFIX:-demo_}"
DUMP="${MYSQLDUMP:-mysqldump}"
TABLES=$(php -r '
$db = new mysqli(getenv("DEMO_DB_HOST"), getenv("DEMO_DB_USER"), getenv("DEMO_DB_PASSWORD"), getenv("DEMO_DB_NAME"));
$r = $db->query("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE \"" . $db->real_escape_string(addcslashes($argv[1], "_%")) . "%\" ORDER BY table_name");
$t = array(); while ($row = $r->fetch_row()) $t[] = $row[0]; echo implode(" ", $t);
' "$PREFIX")
[ -n "$TABLES" ] || { echo "no tables with prefix $PREFIX" >&2; exit 1; }
OUT=reset-worker/src/snapshot.sql
{
  echo "-- tables: $TABLES"
  # shellcheck disable=SC2086
  MYSQL_PWD="$DEMO_DB_PASSWORD" $DUMP -h"$DEMO_DB_HOST" -u"$DEMO_DB_USER" --no-create-info --compact --skip-add-locks --complete-insert --skip-tz-utc --set-gtid-purged=OFF --no-tablespaces --default-character-set=utf8mb4 "$DEMO_DB_NAME" $TABLES
} > "$OUT"
echo "snapshot: $(wc -c < "$OUT") bytes, tables: $TABLES"
