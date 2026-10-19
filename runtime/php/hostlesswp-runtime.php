<?php
/**
 * Plugin Name: hostlesswp runtime
 * Description: Adapts WordPress to the Cloudflare Workers runtime (installed by hostlesswp).
 */

// All unknown paths are routed to index.php by the Worker.
add_filter( 'got_url_rewrite', '__return_true' );
add_filter( 'got_rewrite', '__return_true' );

/*
 * php-wasm has no network stack: sockets degrade into a busy-polling WebSocket shim.
 * Route every WP HTTP API call through the Worker's fetch(); loopback requests fail
 * fast because the single PHP instance is busy serving the caller.
 */
add_filter(
	'pre_http_request',
	function ( $pre, $args, $url ) {
		if ( false !== $pre ) {
			return $pre;
		}
		$host = wp_parse_url( $url, PHP_URL_HOST );
		$self = wp_parse_url( home_url(), PHP_URL_HOST );
		if ( ! $host || $host === $self || in_array( $host, array( 'localhost', '127.0.0.1' ), true ) ) {
			return new WP_Error( 'http_request_failed', 'Loopback requests are not available in the Worker runtime.' );
		}
		$body = $args['body'] ?? null;
		if ( is_array( $body ) || is_object( $body ) ) {
			$body = http_build_query( $body );
		}
		$headers = $args['headers'] ?? array();
		if ( is_string( $headers ) ) {
			$headers = WP_Http::processHeaders( $headers )['headers'];
		}
		if ( ! empty( $args['user-agent'] ) && empty( $headers['user-agent'] ) && empty( $headers['User-Agent'] ) ) {
			$headers['User-Agent'] = $args['user-agent'];
		}
		$raw = post_message_to_js(
			json_encode(
				array(
					'op'      => 'http',
					'url'     => $url,
					'method'  => $args['method'] ?? 'GET',
					'headers' => (object) $headers,
					'body'    => null === $body ? null : base64_encode( (string) $body ),
					'timeout' => (float) ( $args['timeout'] ?? 5 ),
					'follow'  => ( $args['redirection'] ?? 5 ) > 0,
				)
			)
		);
		$res = json_decode( $raw, true );
		if ( ! is_array( $res ) || ! empty( $res['error'] ) ) {
			return new WP_Error( 'http_request_failed', is_array( $res ) ? $res['error'] : 'bridge error' );
		}
		$data = base64_decode( $res['body'] );
		if ( ! empty( $args['stream'] ) && ! empty( $args['filename'] ) ) {
			file_put_contents( $args['filename'], $data );
			$data = '';
		}
		return array(
			'headers'  => new WpOrg\Requests\Utility\CaseInsensitiveDictionary( $res['headers'] ),
			'body'     => $data,
			'response' => array(
				'code'    => (int) $res['status'],
				'message' => get_status_header_desc( (int) $res['status'] ),
			),
			'cookies'  => array(),
			'filename' => $args['filename'] ?? null,
		);
	},
	1,
	3
);

/*
 * Media lives in an S3-compatible bucket (runtime/src/media.js). PHP keeps writing wp-content/uploads in memory and
 * the Worker copies new files to the bucket after the request; these hooks cover what needs the bucket itself.
 */
function hostlesswp_media( $msg ) {
	$res = json_decode( post_message_to_js( json_encode( $msg ) ), true );
	return is_array( $res ) ? $res : array( 'error' => 'bridge error' );
}

/*
 * Requests that read image bytes: editing, cropping and regenerating sizes. Core also calls
 * wp_get_original_image_path on media listings (media grid, REST fields), which must not download every file.
 */
function hostlesswp_media_reads_bytes() {
	if ( wp_doing_cron() ) {
		return true;
	}
	if ( wp_doing_ajax() ) {
		$action = isset( $_REQUEST['action'] ) && is_string( $_REQUEST['action'] ) ? $_REQUEST['action'] : ''; // phpcs:ignore WordPress.Security.NonceVerification
		return in_array( $action, array( 'image-editor', 'imgedit-preview', 'crop-image', 'media-create-image-subsizes' ), true );
	}
	// rest_api_loaded() dispatches from this query var, so it holds the route for both /wp-json/ and ?rest_route=.
	$route = $GLOBALS['wp']->query_vars['rest_route'] ?? '';
	if ( ! is_string( $route ) || '' === $route ) {
		// Before parse_request the query var is unset; fall back to the raw request URI.
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? rawurldecode( (string) $_SERVER['REQUEST_URI'] ) : '';
		if ( preg_match( '#/wp-json(/[^?]*)#', $uri, $m ) || preg_match( '#[?&]rest_route=([^&]*)#', $uri, $m ) ) {
			$route = $m[1];
		}
	}
	return is_string( $route ) && 1 === preg_match( '#^/wp/v2/media/\d+/(edit|post-process)$#', untrailingslashit( $route ) );
}

function hostlesswp_media_in_uploads( $file ) {
	return is_string( $file ) && '' !== $file && str_starts_with( $file, wp_get_upload_dir()['basedir'] . '/' );
}

function hostlesswp_media_fetch( $file ) {
	if ( ! is_string( $file ) || '' === $file || file_exists( $file ) || ! hostlesswp_media_in_uploads( $file ) ) {
		return $file;
	}
	$res = hostlesswp_media( array( 'op' => 's3get', 'path' => $file ) );
	if ( ! empty( $res['error'] ) ) {
		error_log( 'hostlesswp media: ' . $res['error'] );
	}
	return $file;
}
add_filter(
	'wp_get_original_image_path',
	function ( $file ) {
		return hostlesswp_media_reads_bytes() ? hostlesswp_media_fetch( $file ) : $file;
	}
);

// Image editing reads the file from disk; pull the original or the requested size from the bucket first.
// Core only calls this when it needs the bytes, so no request check here.
add_filter(
	'load_image_to_edit_path',
	function ( $filepath, $attachment_id, $size ) {
		$local = get_attached_file( $attachment_id, true );
		if ( ! $local ) {
			return $filepath;
		}
		if ( 'full' !== $size ) {
			$data = image_get_intermediate_size( $attachment_id, $size );
			if ( is_array( $data ) && ! empty( $data['file'] ) ) {
				$local = path_join( dirname( $local ), $data['file'] );
			}
		}
		hostlesswp_media_fetch( $local );
		return file_exists( $local ) ? $local : $filepath;
	},
	10,
	3
);

// Names already taken in a directory: the bucket listing plus whatever PHP wrote in this request.
function hostlesswp_media_names( $dir ) {
	static $names = array();
	if ( ! isset( $names[ $dir ] ) ) {
		$res = hostlesswp_media( array( 'op' => 's3list', 'dir' => $dir ) );
		if ( ! empty( $res['error'] ) ) {
			error_log( 'hostlesswp media: ' . $res['error'] );
			hostlesswp_media_list_failed( $dir, true );
		}
		$remote        = is_array( $res['files'] ?? null ) ? $res['files'] : array();
		$local         = is_dir( $dir ) ? scandir( $dir ) : array();
		$names[ $dir ] = array_values( array_diff( array_unique( array_merge( $remote, is_array( $local ) ? $local : array() ) ), array( '.', '..' ) ) );
	}
	return $names[ $dir ];
}

// Directories whose bucket listing failed in this request; names there cannot be trusted.
function hostlesswp_media_list_failed( $dir, $failed = null ) {
	static $dirs = array();
	if ( null !== $failed ) {
		$dirs[ $dir ] = $failed;
	}
	return ! empty( $dirs[ $dir ] );
}

add_filter(
	'pre_wp_unique_filename_file_list',
	function ( $files, $dir ) {
		$known = is_array( $files ) ? $files : array();
		return array_values( array_unique( array_merge( $known, hostlesswp_media_names( $dir ) ) ) );
	},
	10,
	2
);

// WordPress detects exact name collisions with file_exists(), which never sees bucket objects.
add_filter(
	'wp_unique_filename',
	function ( $filename, $ext, $dir, $unique_filename_callback ) {
		if ( $unique_filename_callback ) {
			return $filename;
		}
		$names = hostlesswp_media_names( $dir );
		// Core lowercases the extension in $filename, so derive it from there rather than $ext.
		$ext  = strtolower( $ext );
		$base = substr( $filename, 0, strlen( $filename ) - strlen( $ext ) );
		if ( hostlesswp_media_list_failed( $dir ) ) {
			// Without a listing a bucket object may already use this name; a random suffix avoids overwriting it.
			return $base . '-' . strtolower( wp_generate_password( 6, false, false ) ) . $ext;
		}
		if ( ! in_array( $filename, $names, true ) ) {
			return $filename;
		}
		$number = 1;
		while ( in_array( $base . '-' . $number . $ext, $names, true ) ) {
			++$number;
		}
		return $base . '-' . $number . $ext;
	},
	10,
	6
);

function hostlesswp_media_delete( $file ) {
	if ( ! hostlesswp_media_in_uploads( $file ) ) {
		return;
	}
	$res = hostlesswp_media( array( 'op' => 's3delete', 'path' => $file ) );
	if ( ! empty( $res['error'] ) ) {
		error_log( 'hostlesswp media: ' . $res['error'] );
	}
}

// Runs last so plugins that keep shared files (returning '' from this filter) can veto the bucket delete too.
add_filter(
	'wp_delete_file',
	function ( $file ) {
		if ( is_string( $file ) && '' !== $file ) {
			hostlesswp_media_delete( $file );
		}
		return $file;
	},
	PHP_INT_MAX
);

// wp_delete_file never fires for files missing locally, which is every file here, so run it for each variant;
// the filter above does the bucket delete unless another filter vetoed it.
add_action(
	'delete_attachment',
	function ( $post_id ) {
		$main = get_attached_file( $post_id, true );
		if ( ! $main ) {
			return;
		}
		$dir   = dirname( $main );
		$files = array( $main );
		$meta  = wp_get_attachment_metadata( $post_id );
		if ( is_array( $meta ) ) {
			foreach ( (array) ( $meta['sizes'] ?? array() ) as $size ) {
				if ( ! empty( $size['file'] ) ) {
					$files[] = path_join( $dir, $size['file'] );
				}
			}
			if ( ! empty( $meta['original_image'] ) ) {
				$files[] = path_join( $dir, $meta['original_image'] );
			}
		}
		$backups = get_post_meta( $post_id, '_wp_attachment_backup_sizes', true );
		if ( is_array( $backups ) ) {
			foreach ( $backups as $backup ) {
				if ( ! empty( $backup['file'] ) ) {
					$files[] = path_join( $dir, $backup['file'] );
				}
			}
		}
		foreach ( array_unique( $files ) as $file ) {
			apply_filters( 'wp_delete_file', $file );
		}
	}
);

// Media lives in the bucket under the default wp-content/uploads folder, so ignore a custom upload folder or URL.
add_filter( 'pre_option_upload_path', '__return_empty_string' );
add_filter( 'pre_option_upload_url_path', '__return_empty_string' );

// With a public or CDN address for the bucket, media URLs point there; old URLs in content still work through the Worker.
add_filter(
	'upload_dir',
	function ( $dirs ) {
		$public = rtrim( (string) hostlesswp_env( 'S3_PUBLIC_URL' ), '/' );
		if ( '' === $public ) {
			return $dirs;
		}
		$prefix          = trim( (string) hostlesswp_env( 'S3_PREFIX' ), '/' );
		$dirs['baseurl'] = $public . ( '' === $prefix ? '' : '/' . $prefix );
		$dirs['url']     = $dirs['baseurl'] . $dirs['subdir'];
		return $dirs;
	}
);

/*
 * Admin screens fetch REST data after they load, often in two or three waves. On Workers nearly every one of those
 * requests starts a fresh isolate (seconds each), while answering the same GET inside the page request costs
 * milliseconds. So each user's REST GETs are remembered per admin screen, and once a path has been seen twice on a
 * screen it is answered in the page and handed to apiFetch's preloading middleware, which then skips the request.
 * Lists are per user, so one account never makes another run requests it did not make itself.
 */
// One user meta row per screen and path (concurrent requests of a page each write only their own row).
const HOSTLESSWP_PRELOAD_PREFIX = 'hostlesswp_preload_';
const HOSTLESSWP_PRELOAD_PATHS  = 30;
const HOSTLESSWP_PRELOAD_TOTAL  = 300;
// Answering in the page starts the REST server there, which costs memory (with WooCommerce every admin page grew by a
// full step and failed with "exceeded memory"). PHP memory grows in 20% steps; up to ~124 MB requests succeed, from
// ~149 MB on they start failing, so preload only while the page has stayed at or below 104 MB.
const HOSTLESSWP_PRELOAD_MAX_HEAP_MB = 104;

// Whether the page may still start the REST server (see HOSTLESSWP_PRELOAD_MAX_HEAP_MB).
function hostlesswp_heap_allows_rest() {
	$heap = json_decode( (string) post_message_to_js( wp_json_encode( array( 'op' => 'heap' ) ) ), true );
	return ! empty( $heap['mb'] ) && $heap['mb'] <= HOSTLESSWP_PRELOAD_MAX_HEAP_MB;
}

// The block editor preloads its REST data in the page, which starts the REST server: past the limit the editor
// fetches the same paths itself once it has loaded.
add_filter(
	'block_editor_rest_api_preload_paths',
	function ( $paths ) {
		return hostlesswp_heap_allows_rest() ? $paths : array();
	},
	PHP_INT_MAX
);

// WooCommerce blocks list the Store API routes for the editor. In the admin WooCommerce asks the REST server, which
// it starts for that (about 12 MB, enough to push the block editor over the memory limit) and which has no Store API
// routes there anyway; on the front end it answers from its route table. Do the same in the admin.
add_filter(
	'woocommerce_blocks_pre_get_routes_from_namespace',
	function ( $routes, $ns ) {
		if ( 'wc/store/v1' !== $ns || ! empty( $routes ) || ! is_admin() || ! class_exists( '\Automattic\WooCommerce\StoreApi\RoutesController' ) ) {
			return $routes;
		}
		try {
			return \Automattic\WooCommerce\StoreApi\StoreApi::container()->get( \Automattic\WooCommerce\StoreApi\RoutesController::class )->get_all_routes( 'v1' );
		} catch ( Throwable $e ) {
			return $routes;
		}
	},
	20,
	2
);

// Learned entries of a user: [screen, path, times seen (capped at 2), last seen], keyed by meta key.
function hostlesswp_preload_entries( $user ) {
	$out = array();
	foreach ( (array) get_user_meta( $user ) as $key => $values ) {
		if ( str_starts_with( $key, HOSTLESSWP_PRELOAD_PREFIX ) ) {
			$entry = maybe_unserialize( $values[0] );
			if ( is_array( $entry ) && 4 === count( $entry ) ) {
				$out[ $key ] = $entry;
			}
		}
	}
	return $out;
}

// Identifies an admin screen by its file and the query arguments that select what it shows.
function hostlesswp_preload_screen( $file, $args ) {
	$file = '' === $file ? 'index.php' : $file;
	$keep = array();
	foreach ( array( 'page', 'post_type', 'taxonomy', 'tab', 'path' ) as $k ) {
		if ( isset( $args[ $k ] ) && is_string( $args[ $k ] ) ) {
			$keep[ $k ] = $args[ $k ];
		}
	}
	return $keep ? $file . '?' . http_build_query( $keep ) : $file;
}

// Learn: a successful REST GET made from an admin screen of this site by a logged-in user.
add_filter(
	'rest_pre_echo_response',
	function ( $result, $server, $request ) {
		if ( 'GET' !== $request->get_method() || ! is_user_logged_in() || 200 !== http_response_code() || ! is_array( $result ) ) {
			return $result;
		}
		$ref   = wp_parse_url( (string) ( $_SERVER['HTTP_REFERER'] ?? '' ) );
		$admin = wp_parse_url( admin_url() );
		if ( empty( $ref['host'] ) || $ref['host'] !== $admin['host'] || ! str_starts_with( $ref['path'] ?? '', $admin['path'] ) ) {
			return $result;
		}
		// Large answers would weigh down every page load of the screen more than the request they save.
		if ( strlen( (string) wp_json_encode( $result ) ) > 100000 ) {
			return $result;
		}
		parse_str( $ref['query'] ?? '', $ref_args );
		$screen = hostlesswp_preload_screen( substr( $ref['path'], strlen( $admin['path'] ) ), $ref_args );
		// The path as the client asked for it (apiFetch adds _locale itself, after the preloading middleware).
		$query = array();
		foreach ( explode( '&', (string) wp_parse_url( $_SERVER['REQUEST_URI'] ?? '', PHP_URL_QUERY ) ) as $pair ) {
			$name = urldecode( explode( '=', $pair, 2 )[0] );
			if ( '' !== $pair && ! in_array( $name, array( '_locale', 'rest_route', '_wpnonce', '_' ), true ) ) {
				$query[] = $pair;
			}
		}
		$path = $request->get_route() . ( $query ? '?' . implode( '&', $query ) : '' );

		$user = get_current_user_id();
		$key  = HOSTLESSWP_PRELOAD_PREFIX . md5( $screen . "\n" . $path );
		$seen = get_user_meta( $user, $key, true );
		$seen = is_array( $seen ) ? $seen : array( $screen, $path, 0, 0 );
		// Write only while a path is still being learned, and refresh its age once a day.
		if ( $seen[2] >= 2 && time() - $seen[3] < DAY_IN_SECONDS ) {
			return $result;
		}
		update_user_meta( $user, $key, array( $screen, $path, min( $seen[2] + 1, 2 ), time() ) );
		if ( 0 === $seen[2] ) {
			$entries = hostlesswp_preload_entries( $user );
			if ( count( $entries ) > HOSTLESSWP_PRELOAD_TOTAL ) {
				uasort( $entries, fn( $a, $b ) => $a[3] <=> $b[3] );
				foreach ( array_slice( array_keys( $entries ), 0, count( $entries ) - HOSTLESSWP_PRELOAD_TOTAL ) as $old ) {
					delete_user_meta( $user, $old );
				}
			}
		}
		return $result;
	},
	PHP_INT_MAX,
	3
);

// Preload: answer the learned paths of this screen while rendering it. This runs after the page body, so the memory
// the body used is free again: answering first made the two add up and pushed pages over the Worker memory limit.
add_action(
	'admin_footer',
	function () {
		if ( ! wp_script_is( 'wp-api-fetch', 'enqueued' ) && ! wp_script_is( 'wp-api-fetch', 'done' ) ) {
			return;
		}
		if ( ! hostlesswp_heap_allows_rest() ) {
			return;
		}
		$screen = hostlesswp_preload_screen( $GLOBALS['pagenow'] ?? '', $_GET );
		$paths  = array();
		foreach ( hostlesswp_preload_entries( get_current_user_id() ) as $entry ) {
			if ( $entry[0] === $screen && $entry[2] >= 2 ) {
				$paths[ $entry[1] ] = $entry[3];
			}
		}
		if ( ! $paths ) {
			return;
		}
		arsort( $paths );
		$server = rest_get_server();
		$memo   = array();
		foreach ( array_slice( array_keys( $paths ), 0, HOSTLESSWP_PRELOAD_PATHS ) as $path ) {
			// Same as core's rest_preload_api_request(), without its (array) cast that turns {} into [].
			$parts   = wp_parse_url( $path );
			$request = new WP_REST_Request( 'GET', $parts['path'] ?? '/' );
			if ( ! empty( $parts['query'] ) ) {
				parse_str( $parts['query'], $params );
				$request->set_query_params( $params );
			}
			try {
				$response = rest_do_request( $request );
				if ( 200 !== $response->get_status() ) {
					continue;
				}
				$response      = apply_filters( 'rest_post_dispatch', rest_ensure_response( $response ), $server, $request );
				$embed         = $request->has_param( '_embed' ) ? rest_parse_embed_param( $request['_embed'] ) : false;
				$memo[ $path ] = array(
					'body'    => $server->response_to_data( $response, $embed ),
					'headers' => $response->get_headers(),
				);
			} catch ( Throwable $e ) {
				continue;
			}
		}
		if ( ! $memo ) {
			return;
		}
		$js = sprintf( 'wp.apiFetch.use( wp.apiFetch.createPreloadingMiddleware( %s ) );', wp_json_encode( $memo ) );
		// apiFetch usually prints with the footer scripts, right after this; if the head already printed it, the
		// scripts that fetch on load still come later in the footer.
		if ( wp_script_is( 'wp-api-fetch', 'done' ) ) {
			wp_print_inline_script_tag( $js );
		} else {
			wp_add_inline_script( 'wp-api-fetch', $js, 'after' );
		}
	},
	1
);

/*
 * Page cache: the Worker answers anonymous page views from a cache without starting PHP (runtime/src/page-cache.js).
 * Anything that can change what visitors see bumps the site-wide cache version; cached pages are then rendered again
 * in the background on their next view. Bumps are collected and sent once, when the request ends.
 */
function hostlesswp_cache_bump() {
	static $hooked = false;
	if ( ! $hooked ) {
		$hooked = true;
		add_action(
			'shutdown',
			function () {
				post_message_to_js( wp_json_encode( array( 'op' => 'cache-bump' ) ) );
			},
			0
		);
	}
}

// Changes of published content (including a post leaving or entering the published state).
add_action(
	'transition_post_status',
	function ( $new_status, $old_status, $post ) {
		if ( ( 'publish' === $new_status || 'publish' === $old_status ) && ! wp_is_post_revision( $post ) && ! wp_is_post_autosave( $post ) ) {
			hostlesswp_cache_bump();
		}
	},
	10,
	3
);
foreach ( array( 'deleted_post', 'trashed_post', 'untrashed_post' ) as $hook ) {
	add_action( $hook, 'hostlesswp_cache_bump' );
}
add_action(
	'save_post',
	function ( $post_id, $post ) {
		if ( 'publish' === $post->post_status && ! wp_is_post_revision( $post ) && ! wp_is_post_autosave( $post ) ) {
			hostlesswp_cache_bump();
		}
	},
	10,
	2
);
add_action(
	'comment_post',
	function ( $id, $approved ) {
		if ( 1 === $approved || '1' === $approved ) {
			hostlesswp_cache_bump();
		}
	},
	10,
	2
);
foreach ( array(
	'transition_comment_status',
	'edit_comment',
	'deleted_comment',
	'created_term',
	'edited_term',
	'delete_term',
	'wp_update_nav_menu',
	'wp_delete_nav_menu',
	'customize_save_after',
	'switch_theme',
	'activated_plugin',
	'deactivated_plugin',
	'upgrader_process_complete',
	'woocommerce_product_set_stock',
	'woocommerce_variation_set_stock',
	'woocommerce_product_set_stock_status',
	'woocommerce_variation_set_stock_status',
) as $hook ) {
	add_action( $hook, 'hostlesswp_cache_bump' );
}

// Settings saved by a user (settings screens, the Customizer, plugin settings). Background requests and admin page views
// update options all the time without changing what visitors see, so only writes made by a logged-in user's form or
// API request count.
function hostlesswp_cache_bump_option( $option ) {
	if ( 'GET' === ( $_SERVER['REQUEST_METHOD'] ?? 'GET' ) || wp_doing_cron() || ! is_user_logged_in() ) {
		return;
	}
	if ( str_starts_with( $option, '_transient' ) || str_starts_with( $option, '_site_transient' ) || in_array( $option, array( 'cron', 'rewrite_rules', 'recently_activated', 'recently_edited', 'active_plugins' ), true ) ) {
		return;
	}
	if ( wp_doing_ajax() && 'heartbeat' === ( $_POST['action'] ?? '' ) ) {
		return;
	}
	hostlesswp_cache_bump();
}
add_action( 'updated_option', 'hostlesswp_cache_bump_option' );
add_action( 'added_option', 'hostlesswp_cache_bump_option' );
add_action( 'deleted_option', 'hostlesswp_cache_bump_option' );

// Pages a plugin marks as not cacheable (WooCommerce does this for the cart, checkout and account pages).
add_action(
	'shutdown',
	function () {
		if ( defined( 'DONOTCACHEPAGE' ) && DONOTCACHEPAGE ) {
			post_message_to_js( wp_json_encode( array( 'op' => 'nocache' ) ) );
		}
	},
	0
);
