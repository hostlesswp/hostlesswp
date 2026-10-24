<?php
/**
 * mail() through the Worker. The built-in mail() pipes the message to a sendmail process, which a Worker cannot
 * start; the runtime disables it (runtime/src/index.js, disable_functions) so this one takes its name. The message
 * is built as PHP builds it for sendmail -t and the Worker delivers it over SMTP (runtime/src/mail.js).
 */
function mail( $to, $subject, $message, $additional_headers = array(), $additional_params = '' ) {
	// As PHP does: no control characters in To and Subject.
	$clean = function ( $value ) {
		return preg_replace( '/[\x00-\x1f\x7f]+/', ' ', rtrim( (string) $value ) );
	};
	if ( is_array( $additional_headers ) ) {
		$lines = array();
		foreach ( $additional_headers as $name => $value ) {
			foreach ( (array) $value as $one ) {
				$lines[] = $name . ': ' . $one;
			}
		}
		$additional_headers = implode( "\r\n", $lines );
	}
	$raw     = 'To: ' . $clean( $to ) . "\r\n" . 'Subject: ' . $clean( $subject ) . "\r\n";
	$headers = trim( (string) $additional_headers );
	if ( '' !== $headers ) {
		$raw .= $headers . "\r\n";
	}
	$raw .= "\r\n" . $message;

	$res = json_decode(
		(string) post_message_to_js(
			json_encode(
				array(
					'op'     => 'mail',
					'raw'    => base64_encode( $raw ),
					'params' => (string) $additional_params,
				)
			)
		),
		true
	);
	if ( empty( $res['ok'] ) ) {
		// Like the built-in mail() when sendmail fails: false and no warning; the reason goes to the log.
		error_log( 'mail(): ' . ( isset( $res['error'] ) ? $res['error'] : 'the message could not be sent' ) );
		return false;
	}
	return true;
}
