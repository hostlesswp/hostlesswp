<?php
/**
 * Userland mysqli: the engine has no mysqli extension.
 * Every query goes through the same Worker bridge as wpdb, so plugins that
 * call mysqli_* on $wpdb->dbh (backup/security plugins) keep working.
 */

/*
 * SQL for the Worker bridge, which carries queries as JSON text. String literals that are not valid UTF-8 (binary
 * values: raw hashes, packed IP addresses) cannot travel that way; they become hex literals, which MySQL reads as the
 * same bytes. Literals are as hostlesswp_escape() and wpdb write them: quoted, with backslash escapes.
 */
function hostlesswp_sql_for_bridge( $sql ) {
	$sql = (string) $sql;
	if ( preg_match( '//u', $sql ) ) {
		return $sql;
	}
	$unescape = array( '0' => "\0", 'b' => "\x08", 'n' => "\n", 'r' => "\r", 't' => "\t", 'Z' => "\x1a" );
	$out      = '';
	$len      = strlen( $sql );
	$i        = 0;
	while ( $i < $len ) {
		$plain = strcspn( $sql, "'\"", $i );
		$out  .= substr( $sql, $i, $plain );
		$i    += $plain;
		if ( $i >= $len ) {
			break;
		}
		$quote = $sql[ $i ];
		$value = '';
		$j     = $i + 1;
		while ( $j < $len ) {
			$c = $sql[ $j ];
			if ( '\\' === $c && $j + 1 < $len ) {
				$e      = $sql[ $j + 1 ];
				$value .= isset( $unescape[ $e ] ) ? $unescape[ $e ] : ( '%' === $e || '_' === $e ? '\\' . $e : $e );
				$j     += 2;
				continue;
			}
			if ( $c === $quote ) {
				if ( $j + 1 < $len && $sql[ $j + 1 ] === $quote ) {
					$value .= $quote;
					$j     += 2;
					continue;
				}
				break;
			}
			$value .= $c;
			++$j;
		}
		$out .= preg_match( '//u', $value ) ? substr( $sql, $i, $j + 1 - $i ) : "X'" . bin2hex( $value ) . "'";
		$i    = $j + 1;
	}
	return $out;
}

// Top-level classes are bound at compile time, so class_exists('mysqli') is already true here;
// only the real extension means the polyfill must step aside.
if ( extension_loaded( 'mysqli' ) ) {
	return;
}

foreach ( array(
	'MYSQLI_ASSOC' => 1, 'MYSQLI_NUM' => 2, 'MYSQLI_BOTH' => 3,
	'MYSQLI_STORE_RESULT' => 0, 'MYSQLI_USE_RESULT' => 1,
	'MYSQLI_CLIENT_SSL' => 2048, 'MYSQLI_CLIENT_COMPRESS' => 32,
	'MYSQLI_OPT_CONNECT_TIMEOUT' => 0, 'MYSQLI_REPORT_OFF' => 0, 'MYSQLI_REPORT_ERROR' => 1, 'MYSQLI_REPORT_STRICT' => 2,
	'MYSQLI_NOT_NULL_FLAG' => 1, 'MYSQLI_PRI_KEY_FLAG' => 2, 'MYSQLI_NUM_FLAG' => 32768,
) as $hostlesswp_name => $hostlesswp_value ) {
	if ( ! defined( $hostlesswp_name ) ) {
		define( $hostlesswp_name, $hostlesswp_value );
	}
}
unset( $hostlesswp_name, $hostlesswp_value );

function hostlesswp_bridge( $op, $sql = '' ) {
	$raw = post_message_to_js( json_encode( array( 'op' => $op, 'sql' => hostlesswp_sql_for_bridge( $sql ) ), JSON_INVALID_UTF8_SUBSTITUTE ) );
	$res = json_decode( (string) $raw, true );
	return is_array( $res ) ? $res : array( 'error' => 'bridge: invalid response', 'errno' => 2006 );
}

function hostlesswp_escape( $data ) {
	return strtr( (string) $data, array( '\\' => '\\\\', "\0" => '\\0', "\n" => '\\n', "\r" => '\\r', "'" => "\\'", '"' => '\\"', "\x1a" => '\\Z' ) );
}

class mysqli_result {
	public $num_rows = 0;
	public $field_count = 0;
	public $current_field = 0;
	public $lengths = null;
	private $rows;
	private $fields;
	private $pos = 0;

	public function __construct( $rows, $fields ) {
		$this->rows        = $rows;
		$this->fields      = $fields;
		$this->num_rows    = count( $rows );
		$this->field_count = count( $fields );
	}
	public function fetch_assoc() {
		return $this->pos < $this->num_rows ? $this->rows[ $this->pos++ ] : null;
	}
	public function fetch_row() {
		$r = $this->fetch_assoc();
		return null === $r ? null : array_values( $r );
	}
	public function fetch_array( $mode = MYSQLI_BOTH ) {
		$r = $this->fetch_assoc();
		if ( null === $r ) {
			return null;
		}
		if ( MYSQLI_ASSOC === $mode ) {
			return $r;
		}
		if ( MYSQLI_NUM === $mode ) {
			return array_values( $r );
		}
		return array_merge( array_values( $r ), $r );
	}
	public function fetch_object( $class = 'stdClass' ) {
		$r = $this->fetch_assoc();
		if ( null === $r ) {
			return null;
		}
		$o = new $class();
		foreach ( $r as $k => $v ) {
			$o->$k = $v;
		}
		return $o;
	}
	public function fetch_all( $mode = MYSQLI_NUM ) {
		$out = array();
		while ( null !== ( $r = $this->fetch_array( $mode ) ) ) {
			$out[] = $r;
		}
		return $out;
	}
	public function fetch_field() {
		return $this->current_field < $this->field_count ? (object) $this->fields[ $this->current_field++ ] : false;
	}
	public function fetch_fields() {
		return array_map( function ( $f ) {
			return (object) $f;
		}, $this->fields );
	}
	public function data_seek( $offset ) {
		if ( $offset < 0 || $offset >= max( 1, $this->num_rows ) ) {
			return false;
		}
		$this->pos = $offset;
		return true;
	}
	public function free() {
		$this->rows = array();
	}
	public function close() {
		$this->free();
	}
}


/**
 * Prepared statements emulated client-side: parameters are escaped (blobs as hex
 * literals) and interpolated, then sent as one plain query through the bridge.
 */
class mysqli_stmt {
	public $errno = 0;
	public $error = '';
	public $affected_rows = 0;
	public $insert_id = 0;
	public $num_rows = 0;
	public $param_count = 0;
	private $conn;
	private $sql;
	private $types = '';
	private $params = array();
	private $long = array();
	private $result = null;

	public function __construct( $conn, $sql = null ) {
		$this->conn = $conn;
		if ( null !== $sql ) {
			$this->prepare( $sql );
		}
	}
	public function prepare( $sql ) {
		$this->sql         = $sql;
		$this->param_count = substr_count( preg_replace( "/'(?:[^'\\\\]|\\\\.)*'/", '', $sql ), '?' );
		return true;
	}
	public function bind_param( $types, &...$vars ) {
		$this->types  = $types;
		$this->params = array();
		foreach ( $vars as $i => &$v ) {
			$this->params[ $i ] = &$v;
		}
		return true;
	}
	public function send_long_data( $index, $data ) {
		$this->long[ $index ] = ( $this->long[ $index ] ?? '' ) . $data;
		return true;
	}
	private function literal( $i ) {
		$type = $this->types[ $i ] ?? 's';
		if ( isset( $this->long[ $i ] ) ) {
			return "X'" . bin2hex( $this->long[ $i ] ) . "'";
		}
		$v = $this->params[ $i ] ?? null;
		if ( null === $v ) {
			return 'NULL';
		}
		if ( 'i' === $type ) {
			return (string) (int) $v;
		}
		if ( 'd' === $type ) {
			return (string) (float) $v;
		}
		if ( 'b' === $type ) {
			return "X'" . bin2hex( (string) $v ) . "'";
		}
		return "'" . hostlesswp_escape( $v ) . "'";
	}
	public function execute( $params = null ) {
		if ( is_array( $params ) ) {
			$this->types  = str_repeat( 's', count( $params ) );
			$this->params = array_values( $params );
		}
		$i   = 0;
		$sql = preg_replace_callback(
			"/'(?:[^'\\\\]|\\\\.)*'|\\?/",
			function ( $m ) use ( &$i ) {
				return '?' === $m[0] ? $this->literal( $i++ ) : $m[0];
			},
			$this->sql
		);
		$this->long          = array();
		$r                   = $this->conn->query( $sql );
		$this->errno         = $this->conn->errno;
		$this->error         = $this->conn->error;
		$this->affected_rows = $this->conn->affected_rows;
		$this->insert_id     = $this->conn->insert_id;
		$this->result        = $r instanceof mysqli_result ? $r : null;
		$this->num_rows      = $this->result ? $this->result->num_rows : 0;
		return false !== $r;
	}
	public function get_result() {
		return $this->result ?: false;
	}
	public function store_result() {
		return true;
	}
	public function free_result() {
		$this->result = null;
	}
	public function reset() {
		$this->long = array();
		return true;
	}
	public function close() {
		return true;
	}
}

class mysqli {
	public $errno = 0;
	public $error = '';
	public $affected_rows = 0;
	public $insert_id = 0;
	public $field_count = 0;
	public $server_info = '8.0.0';
	public $client_info = 'mysqlnd (worker bridge)';
	public $thread_id = 0;
	public $connect_errno = 0;
	public $connect_error = null;
	private $last;

	public function __construct( $host = null, $user = null, $pass = null, $db = null, $port = null, $socket = null ) {
		if ( null !== $host ) {
			$this->real_connect( $host, $user, $pass, $db, $port, $socket );
		}
	}
	public function real_connect( $host = null, $user = null, $pass = null, $db = null, $port = null, $socket = null, $flags = 0 ) {
		$res = hostlesswp_bridge( 'connect' );
		if ( ! empty( $res['error'] ) ) {
			$this->connect_errno = 2002;
			$this->connect_error = $res['error'];
			return false;
		}
		$this->server_info = $res['server_info'];
		return true;
	}
	public function query( $sql, $mode = MYSQLI_STORE_RESULT ) {
		$this->last  = null;
		$res         = hostlesswp_bridge( 'query', $sql );
		$this->errno = (int) ( $res['errno'] ?? 0 );
		$this->error = (string) ( $res['error'] ?? '' );
		if ( $this->error ) {
			$this->errno = $this->errno ?: 1064;
			return false;
		}
		if ( array_key_exists( 'rows', $res ) ) {
			$this->field_count = count( $res['fields'] ?? array() );
			return $this->last = new mysqli_result( $res['rows'], $res['fields'] ?? array() );
		}
		$this->field_count   = 0;
		$this->affected_rows = (int) ( $res['affected'] ?? 0 );
		$this->insert_id     = (int) ( $res['insert_id'] ?? 0 );
		return true;
	}
	public function prepare( $sql ) {
		return new mysqli_stmt( $this, $sql );
	}
	public function stmt_init() {
		return new mysqli_stmt( $this );
	}
	public function real_query( $sql ) {
		return false !== $this->query( $sql );
	}
	public function store_result( $mode = 0 ) {
		$r          = $this->last;
		$this->last = null;
		return $r instanceof mysqli_result ? $r : false;
	}
	public function use_result() {
		return $this->store_result();
	}
	public function real_escape_string( $s ) {
		return hostlesswp_escape( $s );
	}
	public function escape_string( $s ) {
		return hostlesswp_escape( $s );
	}
	public function set_charset( $cs ) {
		return true;
	}
	public function character_set_name() {
		return 'utf8mb4';
	}
	public function select_db( $db ) {
		return false !== $this->query( 'USE `' . str_replace( '`', '``', $db ) . '`' );
	}
	public function ping() {
		return true;
	}
	public function more_results() {
		return false;
	}
	public function next_result() {
		return false;
	}
	public function options( $opt, $val ) {
		return true;
	}
	public function ssl_set( $key, $cert, $ca, $capath, $cipher ) {
		return true;
	}
	public function get_server_info() {
		return $this->server_info;
	}
	public function close() {
		return true;
	}
}

function mysqli_init() { return new mysqli(); }
function mysqli_connect( $h = null, $u = null, $p = null, $d = null, $port = null, $s = null ) { $m = new mysqli(); return $m->real_connect( $h, $u, $p, $d, $port, $s ) ? $m : false; }
function mysqli_real_connect( $m, $h = null, $u = null, $p = null, $d = null, $port = null, $s = null, $f = 0 ) { return $m->real_connect( $h, $u, $p, $d, $port, $s, $f ); }
function mysqli_connect_errno() { return 0; }
function mysqli_connect_error() { return null; }
function mysqli_query( $m, $sql, $mode = MYSQLI_STORE_RESULT ) { return $m->query( $sql, $mode ); }
function mysqli_real_query( $m, $sql ) { return $m->real_query( $sql ); }
function mysqli_store_result( $m, $mode = 0 ) { return $m->store_result(); }
function mysqli_use_result( $m ) { return $m->use_result(); }
function mysqli_more_results( $m ) { return false; }
function mysqli_next_result( $m ) { return false; }
function mysqli_errno( $m ) { return $m instanceof mysqli ? $m->errno : 0; }
function mysqli_error( $m ) { return $m instanceof mysqli ? $m->error : ''; }
function mysqli_affected_rows( $m ) { return $m->affected_rows; }
function mysqli_insert_id( $m ) { return $m->insert_id; }
function mysqli_field_count( $m ) { return $m->field_count; }
function mysqli_real_escape_string( $m, $s ) { return hostlesswp_escape( $s ); }
function mysqli_escape_string( $m, $s ) { return hostlesswp_escape( $s ); }
function mysqli_set_charset( $m, $cs ) { return true; }
function mysqli_character_set_name( $m ) { return 'utf8mb4'; }
function mysqli_select_db( $m, $db ) { return $m->select_db( $db ); }
function mysqli_ping( $m ) { return true; }
function mysqli_close( $m ) { return true; }
function mysqli_options( $m, $o, $v ) { return true; }
function mysqli_ssl_set( $m, $k, $c, $ca, $cp, $ci ) { return true; }
function mysqli_get_server_info( $m = null ) { return $m instanceof mysqli ? $m->server_info : '8.0.0'; }
function mysqli_get_client_info( $m = null ) { return 'mysqlnd (worker bridge)'; }
function mysqli_get_server_version( $m ) { $p = explode( '.', preg_replace( '/[^0-9.].*/', '', $m->server_info ) ); return (int) $p[0] * 10000 + (int) ( $p[1] ?? 0 ) * 100 + (int) ( $p[2] ?? 0 ); }
function mysqli_thread_id( $m ) { return 0; }
function mysqli_report( $flags ) { return true; }
function mysqli_prepare( $m, $sql ) { return $m->prepare( $sql ); }
function mysqli_stmt_init( $m ) { return $m->stmt_init(); }
function mysqli_stmt_prepare( $st, $sql ) { return $st->prepare( $sql ); }
function mysqli_stmt_bind_param( $st, $types, &...$vars ) { return $st->bind_param( $types, ...$vars ); }
function mysqli_stmt_send_long_data( $st, $i, $d ) { return $st->send_long_data( $i, $d ); }
function mysqli_stmt_execute( $st, $params = null ) { return $st->execute( $params ); }
function mysqli_stmt_get_result( $st ) { return $st->get_result(); }
function mysqli_stmt_affected_rows( $st ) { return $st->affected_rows; }
function mysqli_stmt_insert_id( $st ) { return $st->insert_id; }
function mysqli_stmt_errno( $st ) { return $st->errno; }
function mysqli_stmt_error( $st ) { return $st->error; }
function mysqli_stmt_close( $st ) { return true; }
function mysqli_num_rows( $r ) { return $r->num_rows; }
function mysqli_num_fields( $r ) { return $r->field_count; }
function mysqli_fetch_assoc( $r ) { return $r->fetch_assoc(); }
function mysqli_fetch_row( $r ) { return $r->fetch_row(); }
function mysqli_fetch_array( $r, $mode = MYSQLI_BOTH ) { return $r->fetch_array( $mode ); }
function mysqli_fetch_object( $r, $class = 'stdClass' ) { return $r->fetch_object( $class ); }
function mysqli_fetch_all( $r, $mode = MYSQLI_NUM ) { return $r->fetch_all( $mode ); }
function mysqli_fetch_field( $r ) { return $r->fetch_field(); }
function mysqli_fetch_fields( $r ) { return $r->fetch_fields(); }
function mysqli_data_seek( $r, $o ) { return $r->data_seek( $o ); }
function mysqli_free_result( $r ) { if ( $r instanceof mysqli_result ) { $r->free(); } }
