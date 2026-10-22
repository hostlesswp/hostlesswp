<?php
/**
 * HTTP for code that does not go through the WordPress HTTP API. HostlessWP PHP has no network stack, so the
 * curl polyfill (hostlesswp-curl.php) and the http:// and https:// stream wrappers below (file_get_contents() or
 * fopen() of a URL, copy(), simplexml_load_file()) send their requests with the Worker's fetch().
 */

/**
 * Sends requests at once. Each one: url, method, headers (list of [name, value]), body (string or null),
 * timeout (seconds), follow (redirects). Returns, in the same order, either status, reason, url, redirected,
 * headers (list of [name, value]) and body, or error and timeout.
 */
function hostlesswp_fetch( array $requests ) {
	$out  = array();
	$send = array();
	$self = strtolower( preg_replace( '/:\d+$/', '', (string) ( $_SERVER['HTTP_HOST'] ?? '' ) ) );
	foreach ( $requests as $i => $r ) {
		$scheme = strtolower( (string) parse_url( (string) $r['url'], PHP_URL_SCHEME ) );
		$host   = strtolower( (string) parse_url( (string) $r['url'], PHP_URL_HOST ) );
		if ( ! in_array( $scheme, array( 'http', 'https' ), true ) || '' === $host ) {
			$out[ $i ] = array( 'error' => 'URL using bad/illegal format or missing URL', 'timeout' => false, 'malformed' => true );
			continue;
		}
		// This PHP instance is busy serving the caller, so a request to the site itself would never be answered.
		if ( $host === $self || 'localhost' === $host || '127.0.0.1' === $host ) {
			$out[ $i ] = array( 'error' => 'Loopback requests are not available in the Worker runtime.', 'timeout' => false );
			continue;
		}
		$send[ $i ] = array(
			'url'     => (string) $r['url'],
			'method'  => strtoupper( (string) ( $r['method'] ?? 'GET' ) ),
			'headers' => array_values( $r['headers'] ?? array() ),
			'body'    => isset( $r['body'] ) ? base64_encode( (string) $r['body'] ) : null,
			'timeout' => (float) ( $r['timeout'] ?? 30 ),
			'follow'  => ! empty( $r['follow'] ),
		);
	}
	if ( $send ) {
		$res  = json_decode( (string) post_message_to_js( json_encode( array( 'op' => 'fetch', 'requests' => array_values( $send ) ), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE ) ), true );
		$keys = array_keys( $send );
		foreach ( $keys as $n => $i ) {
			$r = is_array( $res ) && isset( $res[ $n ] ) ? $res[ $n ] : array( 'error' => 'bridge error', 'timeout' => false );
			if ( isset( $r['body'] ) ) {
				$r['body'] = base64_decode( $r['body'] );
			}
			$out[ $i ] = $r;
		}
	}
	ksort( $out );
	return $out;
}

// A Location header against the URL it came from.
function hostlesswp_absolute_url( $location, $base ) {
	if ( preg_match( '#^[a-z][a-z0-9+.-]*://#i', $location ) ) {
		return $location;
	}
	$b    = parse_url( $base );
	$root = $b['scheme'] . '://' . $b['host'] . ( isset( $b['port'] ) ? ':' . $b['port'] : '' );
	if ( 0 === strpos( $location, '//' ) ) {
		return $b['scheme'] . ':' . $location;
	}
	if ( '' === $location || '/' === $location[0] ) {
		return $root . $location;
	}
	$dir = preg_replace( '#/[^/]*$#', '/', $b['path'] ?? '/' );
	return $root . ( '' === $dir ? '/' : $dir ) . $location;
}

// HTTP/2 responses carry no reason phrase; status lines get the usual one.
function hostlesswp_http_reason( $code, $reason = '' ) {
	static $phrases = array(
		100 => 'Continue', 200 => 'OK', 201 => 'Created', 202 => 'Accepted', 204 => 'No Content', 206 => 'Partial Content',
		301 => 'Moved Permanently', 302 => 'Found', 303 => 'See Other', 304 => 'Not Modified', 307 => 'Temporary Redirect', 308 => 'Permanent Redirect',
		400 => 'Bad Request', 401 => 'Unauthorized', 403 => 'Forbidden', 404 => 'Not Found', 405 => 'Method Not Allowed', 409 => 'Conflict',
		410 => 'Gone', 413 => 'Payload Too Large', 415 => 'Unsupported Media Type', 422 => 'Unprocessable Entity', 429 => 'Too Many Requests',
		500 => 'Internal Server Error', 501 => 'Not Implemented', 502 => 'Bad Gateway', 503 => 'Service Unavailable', 504 => 'Gateway Timeout',
	);
	return '' !== (string) $reason ? (string) $reason : ( $phrases[ (int) $code ] ?? '' );
}

/**
 * http:// and https:// for fopen(), file_get_contents() and the like, honouring the "http" stream context options
 * (method, header, content, user_agent, timeout, follow_location, ignore_errors). Read-only, as PHP's own.
 * stream_get_meta_data()['wrapper_data'] is this object; it iterates over the response header lines like PHP's
 * array does. $http_response_header is not set: a stream wrapper cannot reach the caller's variables.
 */
class HostlessWP_Http_Stream implements IteratorAggregate, ArrayAccess, Countable {
	public $context;
	public $headers = array();
	private $data   = '';
	private $pos    = 0;

	public function stream_open( $path, $mode, $options, &$opened_path ) {
		// PHP hides STREAM_REPORT_ERRORS from stream wrappers written in PHP, so the reason is always given (@ still
		// silences it); PHP adds its own generic warning after it.
		if ( 'r' !== str_replace( array( 'b', 't' ), '', $mode ) ) {
			trigger_error( 'HTTP wrapper does not support writeable connections', E_USER_WARNING );
			return false;
		}
		$ctx     = stream_context_get_options( $this->context ? $this->context : stream_context_get_default() );
		$http    = $ctx['http'] ?? array();
		$headers = array();
		$has     = array();
		foreach ( (array) ( $http['header'] ?? array() ) as $block ) {
			foreach ( preg_split( "/\r?\n/", (string) $block ) as $line ) {
				if ( false !== strpos( $line, ':' ) ) {
					list( $k, $v )            = explode( ':', $line, 2 );
					$headers[]                = array( trim( $k ), trim( $v ) );
					$has[ strtolower( trim( $k ) ) ] = true;
				}
			}
		}
		$ua = $http['user_agent'] ?? ini_get( 'user_agent' );
		if ( $ua && empty( $has['user-agent'] ) ) {
			$headers[] = array( 'User-Agent', (string) $ua );
		}
		$method  = strtoupper( (string) ( $http['method'] ?? 'GET' ) );
		$content = isset( $http['content'] ) ? (string) $http['content'] : null;
		if ( null !== $content && 'POST' === $method && empty( $has['content-type'] ) ) {
			$headers[] = array( 'Content-Type', 'application/x-www-form-urlencoded' );
		}
		$res = hostlesswp_fetch(
			array(
				array(
					'url'     => $path,
					'method'  => $method,
					'headers' => $headers,
					'body'    => $content,
					'timeout' => (float) ( $http['timeout'] ?? ini_get( 'default_socket_timeout' ) ),
					'follow'  => ! empty( $http['follow_location'] ?? 1 ) && (int) ( $http['max_redirects'] ?? 20 ) > 1,
				),
			)
		)[0];
		if ( isset( $res['error'] ) ) {
			trigger_error( $path . ': ' . $res['error'], E_USER_WARNING );
			return false;
		}
		$status        = 'HTTP/1.1 ' . $res['status'] . ' ' . hostlesswp_http_reason( $res['status'], $res['reason'] ?? '' );
		$this->headers = array( rtrim( $status ) );
		foreach ( $res['headers'] as $h ) {
			$this->headers[] = $h[0] . ': ' . $h[1];
		}
		if ( $res['status'] >= 400 && empty( $http['ignore_errors'] ) ) {
			trigger_error( $path . ': HTTP request failed! ' . $status, E_USER_WARNING );
			return false;
		}
		$this->data = (string) $res['body'];
		return true;
	}

	public function stream_read( $count ) {
		$chunk      = (string) substr( $this->data, $this->pos, $count );
		$this->pos += strlen( $chunk );
		return $chunk;
	}

	public function stream_eof() {
		return $this->pos >= strlen( $this->data );
	}

	public function stream_tell() {
		return $this->pos;
	}

	public function stream_seek( $offset, $whence ) {
		$to = SEEK_SET === $whence ? $offset : ( SEEK_CUR === $whence ? $this->pos + $offset : strlen( $this->data ) + $offset );
		if ( $to < 0 ) {
			return false;
		}
		$this->pos = $to;
		return true;
	}

	public function stream_stat() {
		return array( 'size' => strlen( $this->data ) );
	}

	public function url_stat( $path, $flags ) {
		return false;
	}

	public function stream_close() {
		$this->data = '';
	}

	public function stream_set_option( $option, $arg1, $arg2 ) {
		return false;
	}

	public function getIterator(): Iterator {
		return new ArrayIterator( $this->headers );
	}

	public function offsetExists( $offset ): bool {
		return isset( $this->headers[ $offset ] );
	}

	#[\ReturnTypeWillChange]
	public function offsetGet( $offset ) {
		return $this->headers[ $offset ] ?? null;
	}

	public function offsetSet( $offset, $value ): void {}

	public function offsetUnset( $offset ): void {}

	public function count(): int {
		return count( $this->headers );
	}
}

foreach ( array( 'http', 'https' ) as $hostlesswp_scheme ) {
	if ( in_array( $hostlesswp_scheme, stream_get_wrappers(), true ) ) {
		stream_wrapper_unregister( $hostlesswp_scheme );
	}
	stream_wrapper_register( $hostlesswp_scheme, 'HostlessWP_Http_Stream', STREAM_IS_URL );
}
unset( $hostlesswp_scheme );
