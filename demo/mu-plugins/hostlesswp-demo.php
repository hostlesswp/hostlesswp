<?php
/**
 * Plugin Name: HostlessWP public demo
 * Description: Demo-only rules for the public HostlessWP demo site. Not part of the HostlessWP runtime.
 */

// The database is restored from a snapshot every RESET_HOURS hours (UTC), by demo/reset-worker.
const HOSTLESSWP_DEMO_RESET_HOURS = 3;
const HOSTLESSWP_DEMO_USER        = 'demo';

function hostlesswp_demo_next_reset() {
	$step = HOSTLESSWP_DEMO_RESET_HOURS * HOUR_IN_SECONDS;
	return ( intdiv( time(), $step ) + 1 ) * $step;
}

function hostlesswp_demo_banner_text() {
	$mins = max( 1, (int) ceil( ( hostlesswp_demo_next_reset() - time() ) / 60 ) );
	$when = $mins >= 60 ? sprintf( '%dh %02dm', intdiv( $mins, 60 ), $mins % 60 ) : sprintf( '%d min', $mins );
	return sprintf(
		'Public demo of HostlessWP: this WordPress runs on Cloudflare Workers. Log in with demo / demo. Everything you change is reset in %s.',
		$when
	);
}

add_action(
	'wp_body_open',
	function () {
		echo '<div style="background:#1c1a17;color:#f6f2ea;font:14px/1.5 system-ui,sans-serif;padding:10px 16px;text-align:center">'
			. esc_html( hostlesswp_demo_banner_text() )
			. ' <a style="color:#ffb57a" href="' . esc_url( wp_login_url() ) . '">Log in</a></div>';
	}
);

add_action(
	'admin_notices',
	function () {
		echo '<div class="notice notice-info"><p>' . esc_html( hostlesswp_demo_banner_text() ) . '</p></div>';
	}
);

add_filter(
	'login_message',
	function ( $message ) {
		return $message . '<p class="message">Demo login: username <strong>demo</strong>, password <strong>demo</strong>. The site resets every ' . HOSTLESSWP_DEMO_RESET_HOURS . ' hours.</p>';
	}
);

function hostlesswp_demo_is_demo_user( $user_id = 0 ) {
	$user = $user_id ? get_userdata( $user_id ) : wp_get_current_user();
	return $user && $user->exists() && HOSTLESSWP_DEMO_USER === $user->user_login;
}

// The demo account is an administrator, so visitors can try every screen. Kept back only what would reach other
// visitors: raw HTML and scripts in content (front-end scripts would run for everyone).
add_filter(
	'user_has_cap',
	function ( $allcaps, $caps, $args, $user ) {
		if ( $user && HOSTLESSWP_DEMO_USER === $user->user_login ) {
			$allcaps['unfiltered_html'] = false;
		}
		return $allcaps;
	},
	10,
	4
);

// Accounts nobody may delete, demote or take over: the demo login itself and the site owner.
function hostlesswp_demo_protected_user( $user_id ) {
	$user = get_userdata( (int) $user_id );
	return $user && in_array( $user->user_login, array( HOSTLESSWP_DEMO_USER, 'hostlesswp-admin' ), true );
}
add_filter(
	'map_meta_cap',
	function ( $caps, $cap, $user_id, $args ) {
		if ( in_array( $cap, array( 'delete_user', 'remove_user', 'promote_user', 'edit_user' ), true ) && ! empty( $args[0] ) && hostlesswp_demo_protected_user( $args[0] ) && hostlesswp_demo_is_demo_user() ) {
			// The demo account may still open its own profile (it cannot save changes, see below).
			if ( ! ( 'edit_user' === $cap && (int) $args[0] === get_current_user_id() ) ) {
				return array( 'do_not_allow' );
			}
		}
		return $caps;
	},
	10,
	4
);

// Settings that would let one visitor open the site to everyone (registration as administrator) stay as they are.
foreach ( array( 'users_can_register', 'default_role', 'admin_email', 'new_admin_email' ) as $hostlesswp_demo_option ) {
	add_filter( 'pre_update_option_' . $hostlesswp_demo_option, fn( $value, $old ) => hostlesswp_demo_is_demo_user() ? $old : $value, 10, 2 );
}
unset( $hostlesswp_demo_option );

// Uploads go to the media bucket; keep demo files small.
add_filter( 'upload_size_limit', fn( $size ) => hostlesswp_demo_is_demo_user() ? min( $size, 10 * MB_IN_BYTES ) : $size );

// Nobody can lock the demo account by changing its password or email.
add_filter(
	'show_password_fields',
	function ( $show, $user ) {
		return hostlesswp_demo_is_demo_user( $user->ID ) ? false : $show;
	},
	10,
	2
);
add_action(
	'user_profile_update_errors',
	function ( $errors, $update, $user ) {
		if ( $update && hostlesswp_demo_is_demo_user( $user->ID ) ) {
			$errors->add( 'hostlesswp_demo', 'The demo account cannot be changed.' );
		}
	},
	10,
	3
);
// Same through the REST API (the block editor and apps use /wp/v2/users). Stopped before the handler runs:
// the users endpoint ignores an error returned from rest_pre_insert_user. The block editor saving its own
// preferences (meta.persisted_preferences on /users/me, sent as PUT through X-HTTP-Method-Override) is allowed.
add_filter(
	'rest_request_before_callbacks',
	function ( $response, $handler, $request ) {
		if ( 'GET' === $request->get_method() || ! hostlesswp_demo_is_demo_user() || ! preg_match( '#^/wp/v2/users/(me|\d+)(/|$)#', $request->get_route(), $m ) ) {
			return $response;
		}
		$target = 'me' === $m[1] ? get_current_user_id() : (int) $m[1];
		if ( ! hostlesswp_demo_protected_user( $target ) ) {
			return $response;
		}
		$params = $request->get_body_params() ?: (array) $request->get_json_params();
		unset( $params['_locale'] );
		$only_prefs = array( 'meta' ) === array_keys( $params ) && is_array( $params['meta'] ) && array( 'persisted_preferences' ) === array_keys( $params['meta'] );
		if ( '/wp/v2/users/' . $m[1] === $request->get_route() && in_array( $request->get_method(), array( 'POST', 'PUT', 'PATCH' ), true ) && $only_prefs ) {
			return $response;
		}
		return new WP_Error( 'hostlesswp_demo', 'The demo and owner accounts cannot be changed.', array( 'status' => 403 ) );
	},
	10,
	3
);
add_filter( 'allow_password_reset', fn( $allow, $user_id ) => hostlesswp_demo_is_demo_user( $user_id ) ? false : $allow, 10, 2 );

add_filter( 'xmlrpc_enabled', '__return_false' );
// Comments from visitors wait for moderation, so the public pages stay clean between resets.
add_filter( 'pre_comment_approved', fn( $approved ) => is_user_logged_in() ? $approved : 0 );
