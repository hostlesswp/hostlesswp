<?php
/**
 * DNS lookups over DNS-over-HTTPS (Cloudflare's resolver, through the Worker's fetch()). PHP.wasm answers every
 * name with a placeholder address and every record query with nothing, which makes email validators reject
 * every address and private-address checks reject every host. The runtime disables the built-in functions
 * (runtime/src/index.js, disable_functions), so PHP lets these take their names.
 */

// Answers for one or more [name, type] queries, in order; each is a list of [type, ttl, data], or null on failure.
function hostlesswp_dns_query( array $queries ) {
	static $cache = array();
	$todo = array();
	foreach ( $queries as $i => $q ) {
		$key = strtolower( rtrim( $q[0], '.' ) ) . '|' . $q[1];
		if ( ! array_key_exists( $key, $cache ) ) {
			$todo[ $key ] = array(
				'url'     => 'https://cloudflare-dns.com/dns-query?name=' . rawurlencode( rtrim( $q[0], '.' ) ) . '&type=' . $q[1],
				'headers' => array( array( 'Accept', 'application/dns-json' ) ),
				'timeout' => 5,
			);
		}
	}
	if ( $todo ) {
		foreach ( hostlesswp_fetch( $todo ) as $key => $res ) {
			$json          = isset( $res['body'] ) && 200 === $res['status'] ? json_decode( $res['body'], true ) : null;
			$cache[ $key ] = is_array( $json ) && 0 === ( $json['Status'] ?? -1 )
				? array_map(
					function ( $a ) {
						return array( (int) $a['type'], (int) $a['TTL'], (string) $a['data'] );
					},
					$json['Answer'] ?? array()
				)
				: ( is_array( $json ) && 3 === ( $json['Status'] ?? -1 ) ? array() : null );
		}
	}
	$out = array();
	foreach ( $queries as $i => $q ) {
		$out[ $i ] = $cache[ strtolower( rtrim( $q[0], '.' ) ) . '|' . $q[1] ];
	}
	return $out;
}

function hostlesswp_dns_answers( $host, $type, $code ) {
	$answers = hostlesswp_dns_query( array( array( $host, $type ) ) )[0];
	return null === $answers ? null : array_values(
		array_filter(
			$answers,
			function ( $a ) use ( $code ) {
				return $a[0] === $code;
			}
		)
	);
}

function gethostbyname( $hostname ) {
	if ( filter_var( $hostname, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4 ) ) {
		return $hostname;
	}
	$a = hostlesswp_dns_answers( $hostname, 'A', 1 );
	return $a ? $a[0][2] : $hostname;
}

function gethostbynamel( $hostname ) {
	if ( filter_var( $hostname, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4 ) ) {
		return array( $hostname );
	}
	$a = hostlesswp_dns_answers( $hostname, 'A', 1 );
	return $a ? array_column( $a, 2 ) : false;
}

function gethostbyaddr( $ip ) {
	if ( filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4 ) ) {
		$name = implode( '.', array_reverse( explode( '.', $ip ) ) ) . '.in-addr.arpa';
	} elseif ( filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6 ) ) {
		$name = implode( '.', array_reverse( str_split( bin2hex( inet_pton( $ip ) ) ) ) ) . '.ip6.arpa';
	} else {
		trigger_error( 'gethostbyaddr(): Address is not a valid IPv4 or IPv6 address', E_USER_WARNING );
		return false;
	}
	$a = hostlesswp_dns_answers( $name, 'PTR', 12 );
	return $a ? rtrim( $a[0][2], '.' ) : $ip;
}

function checkdnsrr( $hostname, $type = 'MX' ) {
	$type = strtoupper( (string) $type );
	if ( 'ANY' === $type ) {
		foreach ( hostlesswp_dns_query( array( array( $hostname, 'A' ), array( $hostname, 'AAAA' ), array( $hostname, 'MX' ) ) ) as $answers ) {
			if ( $answers ) {
				return true;
			}
		}
		return false;
	}
	$codes = array( 'A' => 1, 'NS' => 2, 'CNAME' => 5, 'SOA' => 6, 'PTR' => 12, 'MX' => 15, 'TXT' => 16, 'AAAA' => 28, 'SRV' => 33, 'NAPTR' => 35, 'A6' => 38, 'CAA' => 257 );
	if ( ! isset( $codes[ $type ] ) ) {
		throw new ValueError( 'checkdnsrr(): Argument #2 ($type) must be a valid DNS record type' );
	}
	return (bool) hostlesswp_dns_answers( $hostname, $type, $codes[ $type ] );
}

function dns_check_record( $hostname, $type = 'MX' ) {
	return checkdnsrr( $hostname, $type );
}

function getmxrr( $hostname, &$hosts, &$weights = null ) {
	$hosts   = array();
	$weights = array();
	foreach ( (array) hostlesswp_dns_answers( $hostname, 'MX', 15 ) as $a ) {
		list( $pri, $target ) = array_pad( explode( ' ', $a[2], 2 ), 2, '' );
		$hosts[]               = rtrim( $target, '.' );
		$weights[]             = (int) $pri;
	}
	return (bool) $hosts;
}

function dns_get_mx( $hostname, &$hosts, &$weights = null ) {
	return getmxrr( $hostname, $hosts, $weights );
}

// The quoted strings of a TXT record's data.
function hostlesswp_dns_txt( $data ) {
	if ( ! preg_match_all( '/"((?:[^"\\\\]|\\\\.)*)"/', $data, $m ) ) {
		return array( $data );
	}
	return array_map( 'stripslashes', $m[1] );
}

function dns_get_record( $hostname, $type = DNS_ANY, &$authoritative_name_servers = null, &$additional_records = null, $raw = false ) {
	$authoritative_name_servers = array();
	$additional_records         = array();
	$types                      = array( DNS_A => 'A', DNS_NS => 'NS', DNS_CNAME => 'CNAME', DNS_SOA => 'SOA', DNS_PTR => 'PTR', DNS_MX => 'MX', DNS_TXT => 'TXT', DNS_AAAA => 'AAAA', DNS_SRV => 'SRV', DNS_CAA => 'CAA' );
	$codes                      = array( 'A' => 1, 'NS' => 2, 'CNAME' => 5, 'SOA' => 6, 'PTR' => 12, 'MX' => 15, 'TXT' => 16, 'AAAA' => 28, 'SRV' => 33, 'CAA' => 257 );
	$wanted                     = array();
	foreach ( $types as $bit => $name ) {
		if ( DNS_ANY === $type || DNS_ALL === $type ? in_array( $name, array( 'A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'SOA' ), true ) : ( $type & $bit ) ) {
			$wanted[] = $name;
		}
	}
	$queries = array_map(
		function ( $t ) use ( $hostname ) {
			return array( $hostname, $t );
		},
		$wanted
	);
	$records = array();
	foreach ( hostlesswp_dns_query( $queries ) as $i => $answers ) {
		if ( null === $answers ) {
			trigger_error( 'dns_get_record(): A temporary server error occurred.', E_USER_WARNING );
			return false;
		}
		foreach ( $answers as $a ) {
			if ( $a[0] !== $codes[ $wanted[ $i ] ] ) {
				continue;
			}
			$r     = array( 'host' => rtrim( $hostname, '.' ), 'class' => 'IN', 'ttl' => $a[1], 'type' => $wanted[ $i ] );
			$parts = explode( ' ', $a[2] );
			switch ( $wanted[ $i ] ) {
				case 'A':
					$r['ip'] = $a[2];
					break;
				case 'AAAA':
					$r['ipv6'] = $a[2];
					break;
				case 'MX':
					$r['pri']    = (int) $parts[0];
					$r['target'] = rtrim( $parts[1] ?? '', '.' );
					break;
				case 'NS':
				case 'CNAME':
				case 'PTR':
					$r['target'] = rtrim( $a[2], '.' );
					break;
				case 'TXT':
					$r['entries'] = hostlesswp_dns_txt( $a[2] );
					$r['txt']     = implode( '', $r['entries'] );
					break;
				case 'SRV':
					list( $r['pri'], $r['weight'], $r['port'] ) = array_map( 'intval', array_slice( $parts, 0, 3 ) );
					$r['target'] = rtrim( $parts[3] ?? '', '.' );
					break;
				case 'SOA':
					$r['mname'] = rtrim( $parts[0] ?? '', '.' );
					$r['rname'] = rtrim( $parts[1] ?? '', '.' );
					foreach ( array( 'serial', 'refresh', 'retry', 'expire', 'minimum-ttl' ) as $k => $field ) {
						$r[ $field ] = (int) ( $parts[ $k + 2 ] ?? 0 );
					}
					break;
				case 'CAA':
					$r['flags'] = (int) $parts[0];
					$r['tag']   = $parts[1] ?? '';
					$r['value'] = trim( implode( ' ', array_slice( $parts, 2 ) ), '"' );
					break;
			}
			$records[] = $r;
		}
	}
	return $records;
}
