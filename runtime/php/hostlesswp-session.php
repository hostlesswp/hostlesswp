<?php
/**
 * PHP sessions ($_SESSION) are kept in the site's database, table <prefix>hostlesswp_sessions, through the Worker
 * (runtime/src/session.js): a Worker instance has only memory for files, and a site runs on several instances.
 * Session data is stored base64-encoded, so binary serializers work.
 */
class HostlessWP_Session_Handler implements SessionHandlerInterface, SessionUpdateTimestampHandlerInterface {
	private $prefix;
	// What validateId() read, for the read() PHP makes right after it.
	private $validated = null;

	public function __construct( $prefix ) {
		$this->prefix = (string) $prefix;
	}

	private function call( $action, array $args = array() ) {
		$res = json_decode( (string) post_message_to_js( json_encode( array( 'op' => 'session', 'action' => $action, 'prefix' => $this->prefix ) + $args ) ), true );
		if ( ! is_array( $res ) ) {
			$res = array( 'error' => 'bridge error' );
		}
		if ( ! empty( $res['error'] ) ) {
			error_log( 'hostlesswp session ' . $action . ': ' . $res['error'] );
		}
		return $res;
	}

	private function ttl() {
		return (int) ini_get( 'session.gc_maxlifetime' );
	}

	public function open( $path, $name ): bool {
		return true;
	}

	public function close(): bool {
		return true;
	}

	#[\ReturnTypeWillChange]
	public function read( $id ) {
		if ( $this->validated && $this->validated[0] === $id ) {
			$res             = $this->validated[1];
			$this->validated = null;
		} else {
			$res = $this->call( 'read', array( 'id' => $id ) );
		}
		return isset( $res['data'] ) ? (string) base64_decode( $res['data'] ) : '';
	}

	public function write( $id, $data ): bool {
		return empty( $this->call( 'write', array( 'id' => $id, 'data' => base64_encode( $data ), 'ttl' => $this->ttl() ) )['error'] );
	}

	public function destroy( $id ): bool {
		return empty( $this->call( 'destroy', array( 'id' => $id ) )['error'] );
	}

	#[\ReturnTypeWillChange]
	public function gc( $max_lifetime ) {
		$res = $this->call( 'gc' );
		return empty( $res['error'] ) ? (int) $res['deleted'] : false;
	}

	public function validateId( $id ): bool {
		$res             = $this->call( 'read', array( 'id' => $id ) );
		$this->validated = array( $id, $res );
		return isset( $res['data'] );
	}

	public function updateTimestamp( $id, $data ): bool {
		return empty( $this->call( 'touch', array( 'id' => $id, 'ttl' => $this->ttl() ) )['error'] );
	}
}
