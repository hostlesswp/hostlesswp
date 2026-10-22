<?php
/**
 * Userland fileinfo: HostlessWP PHP leaves out the fileinfo extension (its magic database alone is megabytes of
 * memory). finfo, finfo_*() and mime_content_type() recognise the formats a WordPress site handles from their
 * first bytes: images, documents, archives, audio, video, fonts and text. Anything else is
 * application/octet-stream. Loaded by wp-config.php only when the extension is missing.
 */

foreach ( array(
	'FILEINFO_NONE' => 0, 'FILEINFO_SYMLINK' => 2, 'FILEINFO_MIME' => 1040, 'FILEINFO_MIME_TYPE' => 16, 'FILEINFO_MIME_ENCODING' => 1024,
	'FILEINFO_DEVICES' => 8, 'FILEINFO_CONTINUE' => 32, 'FILEINFO_PRESERVE_ATIME' => 128, 'FILEINFO_RAW' => 256, 'FILEINFO_APPLE' => 2048,
	'FILEINFO_EXTENSION' => 16777216,
) as $hostlesswp_name => $hostlesswp_value ) {
	if ( ! defined( $hostlesswp_name ) ) {
		define( $hostlesswp_name, $hostlesswp_value );
	}
}
unset( $hostlesswp_name, $hostlesswp_value );

// MIME type of the first bytes of a file.
function hostlesswp_sniff_mime( $head ) {
	if ( '' === $head ) {
		return 'application/x-empty';
	}
	$at = function ( $offset, $magic ) use ( $head ) {
		return substr( $head, $offset, strlen( $magic ) ) === $magic;
	};
	if ( $at( 0, "\xFF\xD8\xFF" ) ) {
		return 'image/jpeg';
	}
	if ( $at( 0, "\x89PNG\r\n\x1A\n" ) ) {
		return 'image/png';
	}
	if ( $at( 0, 'GIF87a' ) || $at( 0, 'GIF89a' ) ) {
		return 'image/gif';
	}
	if ( $at( 0, 'RIFF' ) ) {
		$kind = substr( $head, 8, 4 );
		return array( 'WEBP' => 'image/webp', 'WAVE' => 'audio/x-wav', 'AVI ' => 'video/x-msvideo' )[ $kind ] ?? 'application/octet-stream';
	}
	if ( $at( 4, 'ftyp' ) ) {
		$brand = substr( $head, 8, 4 );
		$map   = array(
			'avif' => 'image/avif', 'avis' => 'image/avif', 'heic' => 'image/heic', 'heix' => 'image/heic', 'mif1' => 'image/heif', 'msf1' => 'image/heif',
			'qt  ' => 'video/quicktime', 'M4A ' => 'audio/x-m4a', 'M4B ' => 'audio/x-m4a', '3gp4' => 'video/3gpp', '3gp5' => 'video/3gpp', '3g2a' => 'video/3gpp2',
		);
		return $map[ $brand ] ?? 'video/mp4';
	}
	if ( $at( 0, 'BM' ) && strlen( $head ) > 14 && in_array( ord( $head[14] ), array( 12, 40, 56, 64, 108, 124 ), true ) ) {
		return 'image/bmp';
	}
	if ( $at( 0, "II*\0" ) || $at( 0, "MM\0*" ) ) {
		return 'image/tiff';
	}
	if ( $at( 0, "\0\0\1\0" ) ) {
		return 'image/vnd.microsoft.icon';
	}
	if ( $at( 0, '8BPS' ) ) {
		return 'image/vnd.adobe.photoshop';
	}
	if ( $at( 0, '%PDF-' ) ) {
		return 'application/pdf';
	}
	if ( $at( 0, "PK\3\4" ) ) {
		if ( $at( 30, 'mimetype' ) ) {
			$type = substr( $head, 38, 64 );
			if ( preg_match( '#^application/[a-z0-9.+-]+#', $type, $m ) ) {
				return $m[0];
			}
		}
		foreach ( array( 'word/' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'xl/' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'ppt/' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ) as $dir => $type ) {
			if ( false !== strpos( $head, $dir ) && false !== strpos( $head, '[Content_Types].xml' ) ) {
				return $type;
			}
		}
		return 'application/zip';
	}
	if ( $at( 0, "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" ) ) {
		return 'application/vnd.ms-office';
	}
	if ( $at( 0, "\x1F\x8B" ) ) {
		return 'application/gzip';
	}
	if ( $at( 0, 'Rar!' ) ) {
		return 'application/x-rar';
	}
	if ( $at( 0, "7z\xBC\xAF\x27\x1C" ) ) {
		return 'application/x-7z-compressed';
	}
	if ( $at( 0, 'BZh' ) ) {
		return 'application/x-bzip2';
	}
	if ( $at( 0, 'ID3' ) || ( strlen( $head ) > 1 && "\xFF" === $head[0] && ( ord( $head[1] ) & 0xE0 ) === 0xE0 && ( ord( $head[1] ) & 0x06 ) ) ) {
		return 'audio/mpeg';
	}
	if ( $at( 0, 'OggS' ) ) {
		return false !== strpos( $head, 'theora' ) ? 'video/ogg' : 'audio/ogg';
	}
	if ( $at( 0, 'fLaC' ) ) {
		return 'audio/flac';
	}
	if ( $at( 0, "\x1A\x45\xDF\xA3" ) ) {
		return false !== strpos( $head, 'webm' ) ? 'video/webm' : 'video/x-matroska';
	}
	if ( $at( 0, 'wOFF' ) ) {
		return 'font/woff';
	}
	if ( $at( 0, 'wOF2' ) ) {
		return 'font/woff2';
	}
	if ( $at( 0, 'OTTO' ) ) {
		return 'font/otf';
	}
	if ( $at( 0, "\0\1\0\0\0" ) ) {
		return 'font/sfnt';
	}
	if ( false !== strpos( $head, "\0" ) ) {
		return 'application/octet-stream';
	}
	$text = ltrim( $head, "\xEF\xBB\xBF \t\r\n" );
	if ( preg_match( '/^(<\?xml[^>]*>\s*)?(<!--.*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/is', $text ) ) {
		return 'image/svg+xml';
	}
	if ( preg_match( '/^<!DOCTYPE html|^<html[\s>]|^<head[\s>]|^<body[\s>]/i', $text ) ) {
		return 'text/html';
	}
	if ( 0 === strpos( $text, '<?xml' ) ) {
		return 'text/xml';
	}
	if ( 0 === strpos( $text, '<?php' ) ) {
		return 'text/x-php';
	}
	if ( 0 === strpos( $text, '%!PS' ) ) {
		return 'application/postscript';
	}
	if ( 0 === strpos( $text, '{\\rtf' ) ) {
		return 'text/rtf';
	}
	if ( ( '{' === ( $text[0] ?? '' ) || '[' === ( $text[0] ?? '' ) ) && null !== json_decode( $head ) ) {
		return 'application/json';
	}
	return 'text/plain';
}

function hostlesswp_finfo( $data, $flags ) {
	$mime = hostlesswp_sniff_mime( (string) $data );
	if ( $flags & FILEINFO_EXTENSION ) {
		$ext = array( 'image/jpeg' => 'jpeg/jpg/jpe/jfif', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp', 'image/avif' => 'avif', 'image/heic' => 'heic', 'image/tiff' => 'tiff/tif', 'image/bmp' => 'bmp', 'application/pdf' => 'pdf', 'application/zip' => 'zip', 'audio/mpeg' => 'mp3', 'video/mp4' => 'mp4', 'video/quicktime' => 'mov', 'image/svg+xml' => 'svg' );
		return $ext[ $mime ] ?? '???';
	}
	$binary   = 0 !== strpos( $mime, 'text/' ) && 'image/svg+xml' !== $mime && 'application/json' !== $mime;
	$encoding = 'application/x-empty' === $mime ? 'binary' : ( $binary ? 'binary' : ( preg_match( '/[\x80-\xFF]/', (string) $data ) ? ( mb_check_encoding( (string) $data, 'UTF-8' ) ? 'utf-8' : 'unknown-8bit' ) : 'us-ascii' ) );
	if ( ( $flags & FILEINFO_MIME ) === FILEINFO_MIME ) {
		return $mime . '; charset=' . $encoding;
	}
	if ( $flags & FILEINFO_MIME_ENCODING ) {
		return $encoding;
	}
	return $mime;
}

class finfo {
	private $flags;

	public function __construct( $flags = FILEINFO_NONE, $magic_database = null ) {
		$this->flags = (int) $flags;
	}

	public function file( $filename, $flags = FILEINFO_NONE, $context = null ) {
		$head = @file_get_contents( $filename, false, $context, 0, 8192 );
		if ( false === $head ) {
			return false;
		}
		return hostlesswp_finfo( $head, $flags ? $flags : $this->flags );
	}

	public function buffer( $string, $flags = FILEINFO_NONE, $context = null ) {
		return hostlesswp_finfo( substr( (string) $string, 0, 8192 ), $flags ? $flags : $this->flags );
	}

	public function set_flags( $flags ) {
		$this->flags = (int) $flags;
		return true;
	}
}

function finfo_open( $flags = FILEINFO_NONE, $magic_database = null ) {
	return new finfo( $flags, $magic_database );
}

function finfo_close( finfo $finfo ) {
	return true;
}

function finfo_set_flags( finfo $finfo, $flags ) {
	return $finfo->set_flags( $flags );
}

function finfo_file( finfo $finfo, $filename, $flags = FILEINFO_NONE, $context = null ) {
	return $finfo->file( $filename, $flags, $context );
}

function finfo_buffer( finfo $finfo, $string, $flags = FILEINFO_NONE, $context = null ) {
	return $finfo->buffer( $string, $flags, $context );
}

function mime_content_type( $filename ) {
	if ( is_resource( $filename ) ) {
		$pos  = ftell( $filename );
		$head = (string) fread( $filename, 8192 );
		if ( false !== $pos ) {
			fseek( $filename, $pos );
		}
		return hostlesswp_sniff_mime( $head );
	}
	if ( is_dir( $filename ) ) {
		return 'directory';
	}
	$head = @file_get_contents( $filename, false, null, 0, 8192 );
	return false === $head ? false : hostlesswp_sniff_mime( $head );
}
