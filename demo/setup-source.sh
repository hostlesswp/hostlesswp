#!/bin/sh
# Builds the source WordPress for the public demo: a fresh install with sample content, in its own table prefix.
# HostlessWP then deploys it like any other site (see demo/README.md).
# Needs: php (with mysqli and gd) and curl. Database credentials come from the environment:
#   DEMO_DB_HOST DEMO_DB_USER DEMO_DB_PASSWORD DEMO_DB_NAME [DEMO_DB_PREFIX=demo_] [DEMO_URL]
# Re-running reinstalls the demo tables from scratch (only tables with the demo prefix are touched).
set -eu
cd "$(dirname "$0")"
: "${DEMO_DB_HOST:?}" "${DEMO_DB_USER:?}" "${DEMO_DB_PASSWORD:?}" "${DEMO_DB_NAME:?}"
PREFIX="${DEMO_DB_PREFIX:-demo_}"
URL="${DEMO_URL:-https://hostlesswp-demo.example.workers.dev}"
WP_VERSION="${WP_VERSION:-7.1.3}"
SRC="$PWD/source"
CACHE="$PWD/.cache"
mkdir -p "$CACHE"

[ -f "$CACHE/wordpress-$WP_VERSION.zip" ] || curl -fsSL "https://wordpress.org/wordpress-$WP_VERSION.zip" -o "$CACHE/wordpress-$WP_VERSION.zip"
[ -f "$CACHE/wp-cli.phar" ] || curl -fsSL https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar -o "$CACHE/wp-cli.phar"
WP="php -d memory_limit=512M -d max_execution_time=0 -d error_reporting=24575 -d display_errors=0 $CACHE/wp-cli.phar --path=$SRC --skip-plugins --skip-themes"
# With plugins loaded, for steps that need their code (WooCommerce install, importer).
WPP="php -d memory_limit=1024M -d max_execution_time=0 -d error_reporting=24575 -d display_errors=0 $CACHE/wp-cli.phar --path=$SRC"
# Popular plugins from the tested list (data/compat.json) that work without an outside account. All active plugins
# share one Worker isolate (128 MB): WooCommerce with these fits (most requests still start a fresh isolate), while
# adding Elementor and WPForms as well needed ~180 MB for PHP alone and every request failed with "exceeded memory".
PLUGINS="${DEMO_PLUGINS:-woocommerce wordpress-seo contact-form-7 advanced-custom-fields duplicate-post redirection insert-headers-and-footers wordpress-importer}"

# The HostlessWP answers for this site (Worker name, media storage keys) survive a rebuild.
[ -f "$SRC/hostlesswp-config.php" ] && cp -p "$SRC/hostlesswp-config.php" "$CACHE/hostlesswp-config.php.keep"
rm -rf "$SRC" "$CACHE/unzip"
mkdir -p "$CACHE/unzip"
(cd "$CACHE/unzip" && unzip -q "../wordpress-$WP_VERSION.zip")
mv "$CACHE/unzip/wordpress" "$SRC"
rm -rf "$SRC/wp-content/plugins/akismet" "$SRC/wp-content/plugins/hello.php" "$SRC/wp-content/themes/twentytwentythree" "$SRC/wp-content/themes/twentytwentyfour"
mkdir -p "$SRC/wp-content/mu-plugins"
cp mu-plugins/hostlesswp-demo.php "$SRC/wp-content/mu-plugins/"
[ -f "$CACHE/hostlesswp-config.php.keep" ] && mv "$CACHE/hostlesswp-config.php.keep" "$SRC/hostlesswp-config.php"

$WP config create --dbname="$DEMO_DB_NAME" --dbuser="$DEMO_DB_USER" --dbpass="$DEMO_DB_PASSWORD" --dbhost="$DEMO_DB_HOST" --dbprefix="$PREFIX" --skip-check --quiet
# Start from empty demo tables, never touching anything outside the prefix.
php -r '
$db = new mysqli(getenv("DEMO_DB_HOST"), getenv("DEMO_DB_USER"), getenv("DEMO_DB_PASSWORD"), getenv("DEMO_DB_NAME"));
$p = $argv[1];
$r = $db->query("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE \"" . $db->real_escape_string(addcslashes($p, "_%")) . "%\"");
while ($t = $r->fetch_row()) { $db->query("DROP TABLE `" . $t[0] . "`"); echo "dropped ", $t[0], "\n"; }
' "$PREFIX"

ADMIN_PW="$(php -r 'echo bin2hex(random_bytes(12));')"
$WP core install --url="$URL" --title="HostlessWP Demo" --admin_user=hostlesswp-admin --admin_password="$ADMIN_PW" --admin_email=admin@example.com --skip-email --quiet
$WP option update blogdescription "WordPress on Cloudflare Workers, deployed with one command" --quiet
$WP option update permalink_structure '/%postname%/' --quiet
$WP option update comment_moderation 1 --quiet
$WP option update users_can_register 0 --quiet
$WP option update timezone_string UTC --quiet
$WP user create demo demo@example.com --role=administrator --user_pass=demo --display_name="Demo Visitor" --quiet
$WP post delete 1 2 3 --force --quiet 2>/dev/null || true

# Sample images (generated, no third-party content).
for n in 1 2 3; do
  php -r '
  $n = (int) $argv[1]; $w = 1200; $h = 630; $im = imagecreatetruecolor($w, $h);
  $pal = [[243,128,32,255,190,120],[34,90,160,120,190,255],[30,130,90,140,220,170]][$n - 1];
  for ($y = 0; $y < $h; $y++) { $t = $y / $h; imageline($im, 0, $y, $w, $y, imagecolorallocate($im, (int)($pal[0]*(1-$t)+$pal[3]*$t), (int)($pal[1]*(1-$t)+$pal[4]*$t), (int)($pal[2]*(1-$t)+$pal[5]*$t))); }
  imagepng($im, $argv[2]);
  ' "$n" "$CACHE/sample-$n.png"
done
IMG1=$($WP media import "$CACHE/sample-1.png" --title="Sunrise gradient" --porcelain)
IMG2=$($WP media import "$CACHE/sample-2.png" --title="Ocean gradient" --porcelain)
IMG3=$($WP media import "$CACHE/sample-3.png" --title="Forest gradient" --porcelain)
U1=$($WP post get "$IMG1" --field=guid); U2=$($WP post get "$IMG2" --field=guid); U3=$($WP post get "$IMG3" --field=guid)
# Media URLs must be relative to the site, so they work on whatever host the demo is served from.
rel() { echo "$1" | sed -E 's#^https?://[^/]+##'; }
U1=$(rel "$U1"); U2=$(rel "$U2"); U3=$(rel "$U3")

post() { # title, content, [featured image id], [type]
  $WP post create --post_type="${4:-post}" --post_status=publish --post_title="$1" --post_content="$2" --porcelain | {
    read -r id
    [ -n "${3:-}" ] && $WP post meta set "$id" _thumbnail_id "$3" --quiet
    echo "$id"
  }
}

post "Try editing this post" "<!-- wp:paragraph --><p>Log in with <strong>demo</strong> / <strong>demo</strong> and open this post in the block editor. Change the text, add a heading, publish. Your change is saved in MySQL through Cloudflare Hyperdrive and every visitor sees it right away.</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>The whole site is restored to this state every three hours, so feel free to experiment.</p><!-- /wp:paragraph -->" "$IMG3" >/dev/null
post "What works on Workers, and what does not yet" "<!-- wp:paragraph --><p>Pages, posts, comments, search, feeds, the REST API, the block editor and logins all work. The 30 most-installed plugins load and work at page level.</p><!-- /wp:paragraph --><!-- wp:list --><ul><li>Media uploads go to S3-compatible storage (R2, S3, OSS...), since a Worker has no lasting disk.</li><li>Email through PHP mail() is not available; mail plugins that use an HTTP API are the way.</li><li>Plugins and themes are installed on the source site and deployed again, not from this admin.</li></ul><!-- /wp:list -->" "$IMG2" >/dev/null
post "How this page reached you" "<!-- wp:paragraph --><p>This page was rendered by PHP 8.3 compiled to WebAssembly, running inside a Cloudflare Worker. The Worker runs next to the MySQL database, because a page makes dozens of queries one after another. Images, CSS and JavaScript come straight from Cloudflare's edge.</p><!-- /wp:paragraph --><!-- wp:image --><figure class=\"wp-block-image\"><img src=\"$U1\" alt=\"Sunrise gradient\"/></figure><!-- /wp:image -->" "$IMG1" >/dev/null
post "Welcome to the HostlessWP demo" "<!-- wp:paragraph --><p>This is an ordinary WordPress site: standard core, the Twenty Twenty-Five theme and a MySQL database. It was moved onto Cloudflare Workers with a single command: <code>npx hostlesswp</code>.</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>Browse around, search, leave a comment (it waits for moderation), or log in and edit something.</p><!-- /wp:paragraph -->" "$IMG1" >/dev/null
post "About this demo" "<!-- wp:paragraph --><p>HostlessWP is an open-source tool that moves a running WordPress site onto Cloudflare Workers. This demo shows the result. Its source code, the compatibility list and the measurements behind the numbers on the website are public.</p><!-- /wp:paragraph --><!-- wp:image --><figure class=\"wp-block-image\"><img src=\"$U2\" alt=\"Ocean gradient\"/></figure><!-- /wp:image -->" "" page >/dev/null
for p in $PLUGINS; do $WP plugin install "$p" --activate --quiet; done
# Loading the site once with plugins runs their install routines (WooCommerce creates its tables and pages).
$WPP option get blogname >/dev/null
if echo " $PLUGINS " | grep -q " woocommerce "; then
  $WPP option update woocommerce_coming_soon no --quiet
  $WPP option update woocommerce_onboarding_profile '{"skipped":true}' --format=json --quiet
  $WPP option update woocommerce_default_country 'US:CA' --quiet
  $WPP option update woocommerce_currency USD --quiet
  # A store past its setup checklist: while the checklist shows, every WooCommerce admin page carries ~400 KB of
  # per-country locale data for it, which takes ~20 MB more PHP memory and pushed those pages over the Worker limit.
  $WPP option update woocommerce_task_list_hidden_lists '["setup","extended"]' --format=json --quiet
  # Cash on delivery needs no outside account, so visitors can place an order from start to finish.
  $WPP option update woocommerce_cod_settings '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' --format=json --quiet
  $WPP import "$SRC/wp-content/plugins/woocommerce/sample-data/sample_products.xml" --authors=create --quiet
fi
$WP rewrite flush --quiet
echo "demo source ready in $SRC (admin user hostlesswp-admin, password not kept; demo user demo/demo)"
