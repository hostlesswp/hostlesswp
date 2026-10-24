<?php
/**
 * wpdb drop-in: every query is sent to the Worker via post_message_to_js(),
 * which runs it on MySQL through Hyperdrive (hostlesswp) and returns a JSON result.
 * Core WordPress code is untouched; only the mysqli transport is replaced.
 */

require_once __DIR__ . '/hostlesswp-mysqli.php';

class Worker_Bridge_DB extends wpdb {

	private $bridge_error = '';
	private $bridge_errno = 0;
	private $bridge_server_info = '8.0.0';
	private $bridge_fields = array();

	private function bridge( $op, $sql = '' ) {
		$raw = post_message_to_js( json_encode( array( 'op' => $op, 'sql' => hostlesswp_sql_for_bridge( $sql ) ), JSON_INVALID_UTF8_SUBSTITUTE ) );
		$res = json_decode( (string) $raw, true );
		if ( ! is_array( $res ) ) {
			return array( 'error' => 'bridge: invalid response', 'errno' => 2006 );
		}
		return $res;
	}

	public function db_connect( $allow_bail = true ) {
		$this->is_mysql = true;
		$res = $this->bridge( 'connect' );
		if ( ! empty( $res['error'] ) ) {
			$this->ready = false;
			$this->last_error = $res['error'];
			if ( $allow_bail ) {
				$this->bail( '<h1>Error establishing a database connection</h1><p>' . htmlspecialchars( $res['error'] ) . '</p>', 'db_connect_fail' );
			}
			return false;
		}
		$this->bridge_server_info = $res['server_info'];
		$this->dbh                = new mysqli();
		$this->dbh->server_info   = $res['server_info'];
		$this->has_connected      = true;
		$this->ready              = true;
		$this->set_charset( $this->dbh );
		$this->set_sql_mode();
		return true;
	}

	public function check_connection( $allow_bail = true ) {
		return $this->db_connect( $allow_bail );
	}

	public function set_charset( $dbh, $charset = null, $collate = null ) {
		$charset = $charset ?? $this->charset;
		$collate = $collate ?? $this->collate;
		if ( empty( $charset ) ) {
			return;
		}
		$query = $this->prepare( 'SET NAMES %s', $charset );
		if ( ! empty( $collate ) ) {
			$query .= $this->prepare( ' COLLATE %s', $collate );
		}
		$this->bridge( 'query', $query );
	}

	public function set_sql_mode( $modes = array() ) {
		if ( empty( $modes ) ) {
			$res = $this->bridge( 'query', 'SELECT @@SESSION.sql_mode AS m' );
			if ( empty( $res['rows'][0]['m'] ) ) {
				return;
			}
			$modes = explode( ',', $res['rows'][0]['m'] );
		}
		$modes      = array_change_key_case( $modes, CASE_UPPER );
		$incompat   = (array) apply_filters( 'incompatible_sql_modes', $this->incompatible_modes );
		$modes      = array_filter( $modes, function ( $m ) use ( $incompat ) {
			return ! in_array( $m, $incompat, true );
		} );
		$this->bridge( 'query', "SET SESSION sql_mode='" . implode( ',', $modes ) . "'" );
	}

	public function select( $db, $dbh = null ) {
		$res = $this->bridge( 'query', 'USE `' . str_replace( '`', '``', $db ) . '`' );
		if ( ! empty( $res['error'] ) ) {
			$this->ready = false;
		}
	}

	public function _real_escape( $data ) {
		if ( ! is_scalar( $data ) ) {
			return '';
		}
		$escaped = strtr(
			(string) $data,
			array(
				'\\'   => '\\\\',
				"\0"   => '\\0',
				"\n"   => '\\n',
				"\r"   => '\\r',
				"'"    => "\\'",
				'"'    => '\\"',
				"\x1a" => '\\Z',
			)
		);
		return $this->add_placeholder_escape( $escaped );
	}

	public function query( $query ) {
		if ( ! $this->ready ) {
			$this->check_current_query = true;
			return false;
		}
		$query = apply_filters( 'query', $query );
		if ( ! $query ) {
			$this->insert_id = 0;
			return false;
		}
		$this->flush();
		$this->func_call = "\$db->query(\"$query\")";

		if ( $this->check_current_query && ! $this->check_ascii( $query ) ) {
			$stripped_query = $this->strip_invalid_text_from_query( $query );
			$this->flush();
			if ( $stripped_query !== $query ) {
				$this->insert_id  = 0;
				$this->last_query = $query;
				$this->last_error = 'WordPress database error: Could not perform query because it contains invalid data.';
				return false;
			}
		}
		$this->check_current_query = true;
		$this->last_query          = $query;

		if ( defined( 'SAVEQUERIES' ) && SAVEQUERIES ) {
			$this->timer_start();
		}
		$res = $this->bridge( 'query', $query );
		++$this->num_queries;
		if ( defined( 'SAVEQUERIES' ) && SAVEQUERIES ) {
			$this->log_query( $query, $this->timer_stop(), $this->get_caller(), $this->time_start, array() );
		}

		$this->bridge_error  = $res['error'] ?? '';
		$this->bridge_errno  = $res['errno'] ?? 0;
		$this->bridge_fields = $res['fields'] ?? array();
		$this->last_error    = $this->bridge_error;

		if ( $this->last_error ) {
			if ( $this->insert_id && preg_match( '/^\s*(insert|replace)\s/i', $query ) ) {
				$this->insert_id = 0;
			}
			$this->print_error();
			return false;
		}

		if ( preg_match( '/^\s*(create|alter|truncate|drop)\s/i', $query ) ) {
			$this->result = true;
			return true;
		}
		if ( preg_match( '/^\s*(insert|delete|update|replace)\s/i', $query ) ) {
			$this->rows_affected = (int) $res['affected'];
			if ( preg_match( '/^\s*(insert|replace)\s/i', $query ) ) {
				$this->insert_id = (int) $res['insert_id'];
			}
			return $this->rows_affected;
		}

		$num_rows = 0;
		foreach ( $res['rows'] ?? array() as $row ) {
			$this->last_result[ $num_rows++ ] = (object) $row;
		}
		$this->num_rows = $num_rows;
		return $num_rows;
	}

	public function flush() {
		$this->last_result   = array();
		$this->col_info      = null;
		$this->last_query    = null;
		$this->rows_affected = 0;
		$this->num_rows      = 0;
		$this->last_error    = '';
		$this->result        = null;
	}

	protected function load_col_info() {
		if ( $this->col_info ) {
			return;
		}
		$this->col_info = array();
		foreach ( $this->bridge_fields as $i => $f ) {
			$this->col_info[ $i ] = (object) $f;
		}
	}

	public function print_error( $str = '' ) {
		if ( ! $str ) {
			$str = $this->bridge_error;
		}
		return parent::print_error( $str );
	}

	public function close() {
		$this->dbh           = null;
		$this->ready         = false;
		$this->has_connected = false;
		return true;
	}

	public function db_server_info() {
		return $this->bridge_server_info;
	}
}

$wpdb = new Worker_Bridge_DB( DB_USER, DB_PASSWORD, DB_NAME, DB_HOST );
