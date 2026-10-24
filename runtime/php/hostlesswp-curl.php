<?php
/**
 * Userland curl: the engine has no curl extension. curl_*() send their
 * requests with the Worker's fetch() through hostlesswp_fetch() (hostlesswp-http.php), so plugins and SDKs that
 * call curl directly work.
 *
 * Differences from libcurl: a response arrives whole before callbacks run; curl_multi_exec() sends every added
 * handle at once and returns when all are done; with CURLOPT_FOLLOWLOCATION only the last response's headers
 * are seen; proxy, TLS, DNS and cookie-engine options are accepted and ignored. Requests time out after 30 s.
 * Loaded by wp-config.php only when the extension is missing.
 */

foreach ( array(
	'CURLOPT_AUTOREFERER'=>58, 'CURLOPT_BINARYTRANSFER'=>19914, 'CURLOPT_BUFFERSIZE'=>98, 'CURLOPT_CAINFO'=>10065,
	'CURLOPT_CAPATH'=>10097, 'CURLOPT_CONNECTTIMEOUT'=>78, 'CURLOPT_COOKIE'=>10022, 'CURLOPT_COOKIEFILE'=>10031,
	'CURLOPT_COOKIEJAR'=>10082, 'CURLOPT_COOKIESESSION'=>96, 'CURLOPT_CRLF'=>27, 'CURLOPT_CUSTOMREQUEST'=>10036,
	'CURLOPT_DNS_CACHE_TIMEOUT'=>92, 'CURLOPT_DNS_USE_GLOBAL_CACHE'=>91, 'CURLOPT_EGDSOCKET'=>10077,
	'CURLOPT_ENCODING'=>10102, 'CURLOPT_FAILONERROR'=>45, 'CURLOPT_FILE'=>10001, 'CURLOPT_FILETIME'=>69,
	'CURLOPT_FOLLOWLOCATION'=>52, 'CURLOPT_FORBID_REUSE'=>75, 'CURLOPT_FRESH_CONNECT'=>74, 'CURLOPT_FTPAPPEND'=>50,
	'CURLOPT_FTPLISTONLY'=>48, 'CURLOPT_FTPPORT'=>10017, 'CURLOPT_FTP_USE_EPRT'=>106, 'CURLOPT_FTP_USE_EPSV'=>85,
	'CURLOPT_HEADER'=>42, 'CURLOPT_HEADERFUNCTION'=>20079, 'CURLOPT_HTTP200ALIASES'=>10104, 'CURLOPT_HTTPGET'=>80,
	'CURLOPT_HTTPHEADER'=>10023, 'CURLOPT_HTTPPROXYTUNNEL'=>61, 'CURLOPT_HTTP_VERSION'=>84, 'CURLOPT_INFILE'=>10009,
	'CURLOPT_INFILESIZE'=>14, 'CURLOPT_INTERFACE'=>10062, 'CURLOPT_KRB4LEVEL'=>10063, 'CURLOPT_LOW_SPEED_LIMIT'=>19,
	'CURLOPT_LOW_SPEED_TIME'=>20, 'CURLOPT_MAXCONNECTS'=>71, 'CURLOPT_MAXREDIRS'=>68, 'CURLOPT_NETRC'=>51,
	'CURLOPT_NOBODY'=>44, 'CURLOPT_NOPROGRESS'=>43, 'CURLOPT_NOSIGNAL'=>99, 'CURLOPT_PORT'=>3, 'CURLOPT_POST'=>47,
	'CURLOPT_POSTFIELDS'=>10015, 'CURLOPT_POSTQUOTE'=>10039, 'CURLOPT_PREQUOTE'=>10093, 'CURLOPT_PRIVATE'=>10103,
	'CURLOPT_PROGRESSFUNCTION'=>20056, 'CURLOPT_PROXY'=>10004, 'CURLOPT_PROXYPORT'=>59, 'CURLOPT_PROXYTYPE'=>101,
	'CURLOPT_PROXYUSERPWD'=>10006, 'CURLOPT_PUT'=>54, 'CURLOPT_QUOTE'=>10028, 'CURLOPT_RANDOM_FILE'=>10076,
	'CURLOPT_RANGE'=>10007, 'CURLOPT_READDATA'=>10009, 'CURLOPT_READFUNCTION'=>20012, 'CURLOPT_REFERER'=>10016,
	'CURLOPT_RESUME_FROM'=>21, 'CURLOPT_RETURNTRANSFER'=>19913, 'CURLOPT_SHARE'=>10100, 'CURLOPT_SSLCERT'=>10025,
	'CURLOPT_SSLCERTPASSWD'=>10026, 'CURLOPT_SSLCERTTYPE'=>10086, 'CURLOPT_SSLENGINE'=>10089,
	'CURLOPT_SSLENGINE_DEFAULT'=>90, 'CURLOPT_SSLKEY'=>10087, 'CURLOPT_SSLKEYPASSWD'=>10026, 'CURLOPT_SSLKEYTYPE'=>10088,
	'CURLOPT_SSLVERSION'=>32, 'CURLOPT_SSL_CIPHER_LIST'=>10083, 'CURLOPT_SSL_VERIFYHOST'=>81,
	'CURLOPT_SSL_VERIFYPEER'=>64, 'CURLOPT_STDERR'=>10037, 'CURLOPT_TELNETOPTIONS'=>10070, 'CURLOPT_TIMECONDITION'=>33,
	'CURLOPT_TIMEOUT'=>13, 'CURLOPT_TIMEVALUE'=>34, 'CURLOPT_TRANSFERTEXT'=>53, 'CURLOPT_UNRESTRICTED_AUTH'=>105,
	'CURLOPT_UPLOAD'=>46, 'CURLOPT_URL'=>10002, 'CURLOPT_USERAGENT'=>10018, 'CURLOPT_USERPWD'=>10005,
	'CURLOPT_VERBOSE'=>41, 'CURLOPT_WRITEFUNCTION'=>20011, 'CURLOPT_WRITEHEADER'=>10029,
	'CURLOPT_XFERINFOFUNCTION'=>20219, 'CURLE_ABORTED_BY_CALLBACK'=>42, 'CURLE_BAD_CALLING_ORDER'=>44,
	'CURLE_BAD_CONTENT_ENCODING'=>61, 'CURLE_BAD_DOWNLOAD_RESUME'=>36, 'CURLE_BAD_FUNCTION_ARGUMENT'=>43,
	'CURLE_BAD_PASSWORD_ENTERED'=>46, 'CURLE_COULDNT_CONNECT'=>7, 'CURLE_COULDNT_RESOLVE_HOST'=>6,
	'CURLE_COULDNT_RESOLVE_PROXY'=>5, 'CURLE_FAILED_INIT'=>2, 'CURLE_FILE_COULDNT_READ_FILE'=>37,
	'CURLE_FTP_ACCESS_DENIED'=>9, 'CURLE_FTP_BAD_DOWNLOAD_RESUME'=>36, 'CURLE_FTP_CANT_GET_HOST'=>15,
	'CURLE_FTP_CANT_RECONNECT'=>16, 'CURLE_FTP_COULDNT_GET_SIZE'=>32, 'CURLE_FTP_COULDNT_RETR_FILE'=>19,
	'CURLE_FTP_COULDNT_SET_ASCII'=>29, 'CURLE_FTP_COULDNT_SET_BINARY'=>17, 'CURLE_FTP_COULDNT_STOR_FILE'=>25,
	'CURLE_FTP_COULDNT_USE_REST'=>31, 'CURLE_FTP_PARTIAL_FILE'=>18, 'CURLE_FTP_PORT_FAILED'=>30,
	'CURLE_FTP_QUOTE_ERROR'=>21, 'CURLE_FTP_USER_PASSWORD_INCORRECT'=>10, 'CURLE_FTP_WEIRD_227_FORMAT'=>14,
	'CURLE_FTP_WEIRD_PASS_REPLY'=>11, 'CURLE_FTP_WEIRD_PASV_REPLY'=>13, 'CURLE_FTP_WEIRD_SERVER_REPLY'=>8,
	'CURLE_FTP_WEIRD_USER_REPLY'=>12, 'CURLE_FTP_WRITE_ERROR'=>20, 'CURLE_FUNCTION_NOT_FOUND'=>41,
	'CURLE_GOT_NOTHING'=>52, 'CURLE_HTTP_NOT_FOUND'=>22, 'CURLE_HTTP_PORT_FAILED'=>45, 'CURLE_HTTP_POST_ERROR'=>34,
	'CURLE_HTTP_RANGE_ERROR'=>33, 'CURLE_HTTP_RETURNED_ERROR'=>22, 'CURLE_LDAP_CANNOT_BIND'=>38,
	'CURLE_LDAP_SEARCH_FAILED'=>39, 'CURLE_LIBRARY_NOT_FOUND'=>40, 'CURLE_MALFORMAT_USER'=>24, 'CURLE_OBSOLETE'=>50,
	'CURLE_OK'=>0, 'CURLE_OPERATION_TIMEDOUT'=>28, 'CURLE_OPERATION_TIMEOUTED'=>28, 'CURLE_OUT_OF_MEMORY'=>27,
	'CURLE_PARTIAL_FILE'=>18, 'CURLE_READ_ERROR'=>26, 'CURLE_RECV_ERROR'=>56, 'CURLE_SEND_ERROR'=>55,
	'CURLE_SHARE_IN_USE'=>57, 'CURLE_SSL_CACERT'=>60, 'CURLE_SSL_CERTPROBLEM'=>58, 'CURLE_SSL_CIPHER'=>59,
	'CURLE_SSL_CONNECT_ERROR'=>35, 'CURLE_SSL_ENGINE_NOTFOUND'=>53, 'CURLE_SSL_ENGINE_SETFAILED'=>54,
	'CURLE_SSL_PEER_CERTIFICATE'=>60, 'CURLE_SSL_PINNEDPUBKEYNOTMATCH'=>90, 'CURLE_TELNET_OPTION_SYNTAX'=>49,
	'CURLE_TOO_MANY_REDIRECTS'=>47, 'CURLE_UNKNOWN_TELNET_OPTION'=>48, 'CURLE_UNSUPPORTED_PROTOCOL'=>1,
	'CURLE_URL_MALFORMAT'=>3, 'CURLE_URL_MALFORMAT_USER'=>4, 'CURLE_WRITE_ERROR'=>23, 'CURLINFO_CONNECT_TIME'=>3145733,
	'CURLINFO_CONTENT_LENGTH_DOWNLOAD'=>3145743, 'CURLINFO_CONTENT_LENGTH_UPLOAD'=>3145744,
	'CURLINFO_CONTENT_TYPE'=>1048594, 'CURLINFO_EFFECTIVE_URL'=>1048577, 'CURLINFO_FILETIME'=>2097166,
	'CURLINFO_HEADER_OUT'=>2, 'CURLINFO_HEADER_SIZE'=>2097163, 'CURLINFO_HTTP_CODE'=>2097154, 'CURLINFO_LASTONE'=>70,
	'CURLINFO_NAMELOOKUP_TIME'=>3145732, 'CURLINFO_PRETRANSFER_TIME'=>3145734, 'CURLINFO_PRIVATE'=>1048597,
	'CURLINFO_REDIRECT_COUNT'=>2097172, 'CURLINFO_REDIRECT_TIME'=>3145747, 'CURLINFO_REQUEST_SIZE'=>2097164,
	'CURLINFO_SIZE_DOWNLOAD'=>3145736, 'CURLINFO_SIZE_UPLOAD'=>3145735, 'CURLINFO_SPEED_DOWNLOAD'=>3145737,
	'CURLINFO_SPEED_UPLOAD'=>3145738, 'CURLINFO_SSL_VERIFYRESULT'=>2097165, 'CURLINFO_STARTTRANSFER_TIME'=>3145745,
	'CURLINFO_TOTAL_TIME'=>3145731, 'CURLINFO_EFFECTIVE_METHOD'=>1048634, 'CURLINFO_CAPATH'=>1048638,
	'CURLINFO_CAINFO'=>1048637, 'CURLMSG_DONE'=>1, 'CURLM_BAD_EASY_HANDLE'=>2, 'CURLM_BAD_HANDLE'=>1,
	'CURLM_CALL_MULTI_PERFORM'=>-1, 'CURLM_INTERNAL_ERROR'=>4, 'CURLM_OK'=>0, 'CURLM_OUT_OF_MEMORY'=>3,
	'CURLM_ADDED_ALREADY'=>7, 'CURLPROXY_HTTP'=>0, 'CURLPROXY_SOCKS4'=>4, 'CURLPROXY_SOCKS5'=>5, 'CURLSHOPT_NONE'=>0,
	'CURLSHOPT_SHARE'=>1, 'CURLSHOPT_UNSHARE'=>2, 'CURL_HTTP_VERSION_1_0'=>1, 'CURL_HTTP_VERSION_1_1'=>2,
	'CURL_HTTP_VERSION_NONE'=>0, 'CURL_LOCK_DATA_COOKIE'=>2, 'CURL_LOCK_DATA_DNS'=>3, 'CURL_LOCK_DATA_SSL_SESSION'=>4,
	'CURL_SSLVERSION_DEFAULT'=>0, 'CURL_SSLVERSION_SSLv2'=>2, 'CURL_SSLVERSION_SSLv3'=>3, 'CURL_SSLVERSION_TLSv1'=>1,
	'CURL_TIMECOND_IFMODSINCE'=>1, 'CURL_TIMECOND_IFUNMODSINCE'=>2, 'CURL_TIMECOND_LASTMOD'=>3, 'CURL_TIMECOND_NONE'=>0,
	'CURL_VERSION_ASYNCHDNS'=>128, 'CURL_VERSION_CONV'=>4096, 'CURL_VERSION_DEBUG'=>64, 'CURL_VERSION_GSSNEGOTIATE'=>32,
	'CURL_VERSION_IDN'=>1024, 'CURL_VERSION_IPV6'=>1, 'CURL_VERSION_KERBEROS4'=>2, 'CURL_VERSION_LARGEFILE'=>512,
	'CURL_VERSION_LIBZ'=>8, 'CURL_VERSION_NTLM'=>16, 'CURL_VERSION_SPNEGO'=>256, 'CURL_VERSION_SSL'=>4,
	'CURL_VERSION_SSPI'=>2048, 'CURLOPT_HTTPAUTH'=>107, 'CURLAUTH_ANY'=>-17, 'CURLAUTH_ANYSAFE'=>-18, 'CURLAUTH_BASIC'=>1,
	'CURLAUTH_DIGEST'=>2, 'CURLAUTH_GSSNEGOTIATE'=>4, 'CURLAUTH_NONE'=>0, 'CURLAUTH_NTLM'=>8,
	'CURLINFO_HTTP_CONNECTCODE'=>2097174, 'CURLOPT_FTP_CREATE_MISSING_DIRS'=>110, 'CURLOPT_PROXYAUTH'=>111,
	'CURLE_FILESIZE_EXCEEDED'=>63, 'CURLE_LDAP_INVALID_URL'=>62, 'CURLINFO_HTTPAUTH_AVAIL'=>2097175,
	'CURLINFO_RESPONSE_CODE'=>2097154, 'CURLINFO_PROXYAUTH_AVAIL'=>2097176, 'CURLOPT_FTP_RESPONSE_TIMEOUT'=>112,
	'CURLOPT_IPRESOLVE'=>113, 'CURLOPT_MAXFILESIZE'=>114, 'CURL_IPRESOLVE_V4'=>1, 'CURL_IPRESOLVE_V6'=>2,
	'CURL_IPRESOLVE_WHATEVER'=>0, 'CURLE_FTP_SSL_FAILED'=>64, 'CURLOPT_FTP_SSL'=>119, 'CURLOPT_NETRC_FILE'=>10118,
	'CURLOPT_MAXFILESIZE_LARGE'=>30117, 'CURLOPT_TCP_NODELAY'=>121, 'CURLOPT_FTPSSLAUTH'=>129,
	'CURLOPT_FTP_ACCOUNT'=>10134, 'CURLINFO_OS_ERRNO'=>2097177, 'CURLINFO_NUM_CONNECTS'=>2097178,
	'CURLINFO_SSL_ENGINES'=>4194331, 'CURLINFO_COOKIELIST'=>4194332, 'CURLOPT_COOKIELIST'=>10135,
	'CURLOPT_IGNORE_CONTENT_LENGTH'=>136, 'CURLOPT_FTP_SKIP_PASV_IP'=>137, 'CURLOPT_FTP_FILEMETHOD'=>138,
	'CURLOPT_CONNECT_ONLY'=>141, 'CURLOPT_LOCALPORT'=>139, 'CURLOPT_LOCALPORTRANGE'=>140,
	'CURLINFO_FTP_ENTRY_PATH'=>1048606, 'CURLOPT_FTP_ALTERNATIVE_TO_USER'=>10147, 'CURLOPT_MAX_RECV_SPEED_LARGE'=>30146,
	'CURLOPT_MAX_SEND_SPEED_LARGE'=>30145, 'CURLE_SSL_CACERT_BADFILE'=>77, 'CURLOPT_SSL_SESSIONID_CACHE'=>150,
	'CURLMOPT_PIPELINING'=>3, 'CURLE_SSH'=>79, 'CURLOPT_FTP_SSL_CCC'=>154, 'CURLOPT_SSH_AUTH_TYPES'=>151,
	'CURLOPT_SSH_PRIVATE_KEYFILE'=>10153, 'CURLOPT_SSH_PUBLIC_KEYFILE'=>10152, 'CURLOPT_CONNECTTIMEOUT_MS'=>156,
	'CURLOPT_HTTP_CONTENT_DECODING'=>158, 'CURLOPT_HTTP_TRANSFER_DECODING'=>157, 'CURLOPT_TIMEOUT_MS'=>155,
	'CURLMOPT_MAXCONNECTS'=>6, 'CURLOPT_KRBLEVEL'=>10063, 'CURLOPT_NEW_DIRECTORY_PERMS'=>160,
	'CURLOPT_NEW_FILE_PERMS'=>159, 'CURLOPT_APPEND'=>50, 'CURLOPT_DIRLISTONLY'=>48, 'CURLOPT_USE_SSL'=>119,
	'CURLOPT_SSH_HOST_PUBLIC_KEY_MD5'=>10162, 'CURLOPT_PROXY_TRANSFER_MODE'=>166, 'CURLPAUSE_ALL'=>5, 'CURLPAUSE_CONT'=>0,
	'CURLPAUSE_RECV'=>1, 'CURLPAUSE_RECV_CONT'=>0, 'CURLPAUSE_SEND'=>4, 'CURLPAUSE_SEND_CONT'=>0, 'CURLPROXY_SOCKS4A'=>6,
	'CURLPROXY_SOCKS5_HOSTNAME'=>7, 'CURLINFO_REDIRECT_URL'=>1048607, 'CURLINFO_APPCONNECT_TIME'=>3145761,
	'CURLINFO_PRIMARY_IP'=>1048608, 'CURLOPT_ADDRESS_SCOPE'=>171, 'CURLOPT_CRLFILE'=>10169, 'CURLOPT_ISSUERCERT'=>10170,
	'CURLOPT_KEYPASSWD'=>10026, 'CURLINFO_CERTINFO'=>4194338, 'CURLOPT_CERTINFO'=>172, 'CURLOPT_PASSWORD'=>10174,
	'CURLOPT_POSTREDIR'=>161, 'CURLOPT_PROXYPASSWORD'=>10176, 'CURLOPT_PROXYUSERNAME'=>10175, 'CURLOPT_USERNAME'=>10173,
	'CURL_REDIR_POST_301'=>1, 'CURL_REDIR_POST_302'=>2, 'CURL_REDIR_POST_ALL'=>7, 'CURLAUTH_DIGEST_IE'=>16,
	'CURLINFO_CONDITION_UNMET'=>2097187, 'CURLOPT_NOPROXY'=>10177, 'CURLOPT_PROTOCOLS'=>181,
	'CURLOPT_REDIR_PROTOCOLS'=>182, 'CURLOPT_SOCKS5_GSSAPI_NEC'=>180, 'CURLOPT_SOCKS5_GSSAPI_SERVICE'=>10179,
	'CURLOPT_TFTP_BLKSIZE'=>178, 'CURLPROTO_ALL'=>-1, 'CURLPROTO_DICT'=>512, 'CURLPROTO_FILE'=>1024, 'CURLPROTO_FTP'=>4,
	'CURLPROTO_FTPS'=>8, 'CURLPROTO_HTTP'=>1, 'CURLPROTO_HTTPS'=>2, 'CURLPROTO_LDAP'=>128, 'CURLPROTO_LDAPS'=>256,
	'CURLPROTO_SCP'=>16, 'CURLPROTO_SFTP'=>32, 'CURLPROTO_TELNET'=>64, 'CURLPROTO_TFTP'=>2048, 'CURLPROXY_HTTP_1_0'=>1,
	'CURL_VERSION_CURLDEBUG'=>8192, 'CURLOPT_SSH_KNOWNHOSTS'=>10183, 'CURLINFO_RTSP_CLIENT_CSEQ'=>2097189,
	'CURLINFO_RTSP_CSEQ_RECV'=>2097191, 'CURLINFO_RTSP_SERVER_CSEQ'=>2097190, 'CURLINFO_RTSP_SESSION_ID'=>1048612,
	'CURLOPT_FTP_USE_PRET'=>188, 'CURLOPT_MAIL_FROM'=>10186, 'CURLOPT_MAIL_RCPT'=>10187, 'CURLOPT_RTSP_CLIENT_CSEQ'=>193,
	'CURLOPT_RTSP_REQUEST'=>189, 'CURLOPT_RTSP_SERVER_CSEQ'=>194, 'CURLOPT_RTSP_SESSION_ID'=>10190,
	'CURLOPT_RTSP_STREAM_URI'=>10191, 'CURLOPT_RTSP_TRANSPORT'=>10192, 'CURLPROTO_IMAP'=>4096, 'CURLPROTO_IMAPS'=>8192,
	'CURLPROTO_POP3'=>16384, 'CURLPROTO_POP3S'=>32768, 'CURLPROTO_RTSP'=>262144, 'CURLPROTO_SMTP'=>65536,
	'CURLPROTO_SMTPS'=>131072, 'CURLINFO_LOCAL_IP'=>1048617, 'CURLINFO_LOCAL_PORT'=>2097194,
	'CURLINFO_PRIMARY_PORT'=>2097192, 'CURLOPT_FNMATCH_FUNCTION'=>20200, 'CURLOPT_WILDCARDMATCH'=>197,
	'CURLPROTO_RTMP'=>524288, 'CURLPROTO_RTMPE'=>2097152, 'CURLPROTO_RTMPS'=>8388608, 'CURLPROTO_RTMPT'=>1048576,
	'CURLPROTO_RTMPTE'=>4194304, 'CURLPROTO_RTMPTS'=>16777216, 'CURLPROTO_GOPHER'=>33554432, 'CURLAUTH_ONLY'=>2147483648,
	'CURLOPT_RESOLVE'=>10203, 'CURLOPT_TLSAUTH_PASSWORD'=>10205, 'CURLOPT_TLSAUTH_TYPE'=>10206,
	'CURLOPT_TLSAUTH_USERNAME'=>10204, 'CURL_VERSION_TLSAUTH_SRP'=>16384, 'CURLOPT_ACCEPT_ENCODING'=>10102,
	'CURLOPT_TRANSFER_ENCODING'=>207, 'CURLAUTH_NTLM_WB'=>32, 'CURLOPT_GSSAPI_DELEGATION'=>210,
	'CURL_VERSION_NTLM_WB'=>32768, 'CURLOPT_ACCEPTTIMEOUT_MS'=>212, 'CURLOPT_DNS_SERVERS'=>10211,
	'CURLOPT_MAIL_AUTH'=>10217, 'CURLOPT_SSL_OPTIONS'=>216, 'CURLOPT_TCP_KEEPALIVE'=>213, 'CURLOPT_TCP_KEEPIDLE'=>214,
	'CURLOPT_TCP_KEEPINTVL'=>215, 'CURLSSLOPT_ALLOW_BEAST'=>1, 'CURL_REDIR_POST_303'=>4,
	'CURLMOPT_CHUNK_LENGTH_PENALTY_SIZE'=>30010, 'CURLMOPT_CONTENT_LENGTH_PENALTY_SIZE'=>30009,
	'CURLMOPT_MAX_HOST_CONNECTIONS'=>7, 'CURLMOPT_MAX_PIPELINE_LENGTH'=>8, 'CURLMOPT_MAX_TOTAL_CONNECTIONS'=>13,
	'CURLOPT_SASL_IR'=>218, 'CURLOPT_DNS_INTERFACE'=>10221, 'CURLOPT_DNS_LOCAL_IP4'=>10222,
	'CURLOPT_DNS_LOCAL_IP6'=>10223, 'CURLOPT_XOAUTH2_BEARER'=>10220, 'CURL_HTTP_VERSION_2_0'=>3,
	'CURL_VERSION_HTTP2'=>65536, 'CURLOPT_LOGIN_OPTIONS'=>10224, 'CURL_SSLVERSION_TLSv1_0'=>4,
	'CURL_SSLVERSION_TLSv1_1'=>5, 'CURL_SSLVERSION_TLSv1_2'=>6, 'CURLOPT_EXPECT_100_TIMEOUT_MS'=>227,
	'CURLOPT_SSL_ENABLE_ALPN'=>226, 'CURLOPT_SSL_ENABLE_NPN'=>225, 'CURLHEADER_SEPARATE'=>1, 'CURLHEADER_UNIFIED'=>0,
	'CURLOPT_HEADEROPT'=>229, 'CURLOPT_PROXYHEADER'=>10228, 'CURLAUTH_NEGOTIATE'=>4, 'CURL_VERSION_GSSAPI'=>131072,
	'CURLOPT_PINNEDPUBLICKEY'=>10230, 'CURLOPT_UNIX_SOCKET_PATH'=>10231, 'CURLPROTO_SMB'=>67108864,
	'CURLPROTO_SMBS'=>134217728, 'CURL_VERSION_KERBEROS5'=>262144, 'CURL_VERSION_UNIX_SOCKETS'=>524288,
	'CURLOPT_SSL_VERIFYSTATUS'=>232, 'CURLOPT_PATH_AS_IS'=>234, 'CURLOPT_SSL_FALSESTART'=>233, 'CURL_HTTP_VERSION_2'=>3,
	'CURLOPT_PIPEWAIT'=>237, 'CURLOPT_PROXY_SERVICE_NAME'=>10235, 'CURLOPT_SERVICE_NAME'=>10236,
	'CURLSSLOPT_NO_REVOKE'=>2, 'CURLOPT_DEFAULT_PROTOCOL'=>10238, 'CURLOPT_STREAM_WEIGHT'=>239,
	'CURLMOPT_PUSHFUNCTION'=>20014, 'CURL_PUSH_OK'=>0, 'CURL_PUSH_DENY'=>1, 'CURL_HTTP_VERSION_2TLS'=>4,
	'CURL_VERSION_PSL'=>1048576, 'CURLOPT_TFTP_NO_OPTIONS'=>242, 'CURL_HTTP_VERSION_2_PRIOR_KNOWLEDGE'=>5,
	'CURLOPT_CONNECT_TO'=>10243, 'CURLOPT_TCP_FASTOPEN'=>244, 'CURLINFO_HTTP_VERSION'=>2097198,
	'CURLE_WEIRD_SERVER_REPLY'=>8, 'CURLOPT_KEEP_SENDING_ON_ERROR'=>245, 'CURL_SSLVERSION_TLSv1_3'=>7,
	'CURL_VERSION_HTTPS_PROXY'=>2097152, 'CURLINFO_PROTOCOL'=>2097200, 'CURLINFO_PROXY_SSL_VERIFYRESULT'=>2097199,
	'CURLINFO_SCHEME'=>1048625, 'CURLOPT_PRE_PROXY'=>10262, 'CURLOPT_PROXY_CAINFO'=>10246, 'CURLOPT_PROXY_CAPATH'=>10247,
	'CURLOPT_PROXY_CRLFILE'=>10260, 'CURLOPT_PROXY_KEYPASSWD'=>10258, 'CURLOPT_PROXY_PINNEDPUBLICKEY'=>10263,
	'CURLOPT_PROXY_SSL_CIPHER_LIST'=>10259, 'CURLOPT_PROXY_SSL_OPTIONS'=>261, 'CURLOPT_PROXY_SSL_VERIFYHOST'=>249,
	'CURLOPT_PROXY_SSL_VERIFYPEER'=>248, 'CURLOPT_PROXY_SSLCERT'=>10254, 'CURLOPT_PROXY_SSLCERTTYPE'=>10255,
	'CURLOPT_PROXY_SSLKEY'=>10256, 'CURLOPT_PROXY_SSLKEYTYPE'=>10257, 'CURLOPT_PROXY_SSLVERSION'=>250,
	'CURLOPT_PROXY_TLSAUTH_PASSWORD'=>10252, 'CURLOPT_PROXY_TLSAUTH_TYPE'=>10253, 'CURLOPT_PROXY_TLSAUTH_USERNAME'=>10251,
	'CURLPROXY_HTTPS'=>2, 'CURLOPT_ABSTRACT_UNIX_SOCKET'=>10264, 'CURL_SSLVERSION_MAX_DEFAULT'=>65536,
	'CURL_SSLVERSION_MAX_NONE'=>0, 'CURL_SSLVERSION_MAX_TLSv1_0'=>262144, 'CURL_SSLVERSION_MAX_TLSv1_1'=>327680,
	'CURL_SSLVERSION_MAX_TLSv1_2'=>393216, 'CURL_SSLVERSION_MAX_TLSv1_3'=>458752, 'CURLOPT_SUPPRESS_CONNECT_HEADERS'=>265,
	'CURLAUTH_GSSAPI'=>4, 'CURLINFO_CONTENT_LENGTH_DOWNLOAD_T'=>6291471, 'CURLINFO_CONTENT_LENGTH_UPLOAD_T'=>6291472,
	'CURLINFO_SIZE_DOWNLOAD_T'=>6291464, 'CURLINFO_SIZE_UPLOAD_T'=>6291463, 'CURLINFO_SPEED_DOWNLOAD_T'=>6291465,
	'CURLINFO_SPEED_UPLOAD_T'=>6291466, 'CURLOPT_REQUEST_TARGET'=>10266, 'CURLOPT_SOCKS5_AUTH'=>267,
	'CURLOPT_SSH_COMPRESSION'=>268, 'CURL_VERSION_MULTI_SSL'=>4194304, 'CURL_VERSION_BROTLI'=>8388608,
	'CURL_LOCK_DATA_CONNECT'=>5, 'CURLINFO_FILETIME_T'=>6291470, 'CURLOPT_HAPPY_EYEBALLS_TIMEOUT_MS'=>271,
	'CURLOPT_TIMEVALUE_LARGE'=>30270, 'CURLOPT_DNS_SHUFFLE_ADDRESSES'=>275, 'CURLOPT_HAPROXYPROTOCOL'=>274,
	'CURL_LOCK_DATA_PSL'=>6, 'CURLAUTH_BEARER'=>64, 'CURLINFO_APPCONNECT_TIME_T'=>6291512,
	'CURLINFO_CONNECT_TIME_T'=>6291508, 'CURLINFO_NAMELOOKUP_TIME_T'=>6291507, 'CURLINFO_PRETRANSFER_TIME_T'=>6291509,
	'CURLINFO_REDIRECT_TIME_T'=>6291511, 'CURLINFO_STARTTRANSFER_TIME_T'=>6291510, 'CURLINFO_TOTAL_TIME_T'=>6291506,
	'CURLOPT_DISALLOW_USERNAME_IN_URL'=>278, 'CURLOPT_PROXY_TLS13_CIPHERS'=>10277, 'CURLOPT_TLS13_CIPHERS'=>10276,
	'CURLOPT_DOH_URL'=>10279, 'CURLOPT_UPKEEP_INTERVAL_MS'=>281, 'CURLOPT_UPLOAD_BUFFERSIZE'=>280,
	'CURLOPT_HTTP09_ALLOWED'=>285, 'CURLOPT_ALTSVC'=>10287, 'CURLOPT_ALTSVC_CTRL'=>286, 'CURL_VERSION_ALTSVC'=>16777216,
	'CURLOPT_MAXAGE_CONN'=>288, 'CURLOPT_SASL_AUTHZID'=>10289, 'CURL_VERSION_HTTP3'=>33554432,
	'CURLINFO_RETRY_AFTER'=>6291513, 'CURLMOPT_MAX_CONCURRENT_STREAMS'=>16, 'CURLSSLOPT_NO_PARTIALCHAIN'=>4,
	'CURLOPT_MAIL_RCPT_ALLLOWFAILS'=>290, 'CURLSSLOPT_REVOKE_BEST_EFFORT'=>8, 'CURLOPT_ISSUERCERT_BLOB'=>40295,
	'CURLOPT_PROXY_ISSUERCERT'=>10296, 'CURLOPT_PROXY_ISSUERCERT_BLOB'=>40297, 'CURLOPT_PROXY_SSLCERT_BLOB'=>40293,
	'CURLOPT_PROXY_SSLKEY_BLOB'=>40294, 'CURLOPT_SSLCERT_BLOB'=>40291, 'CURLOPT_SSLKEY_BLOB'=>40292,
	'CURLPROTO_MQTT'=>268435456, 'CURLSSLOPT_NATIVE_CA'=>16, 'CURL_VERSION_UNICODE'=>134217728,
	'CURL_VERSION_ZSTD'=>67108864, 'CURLE_PROXY'=>97, 'CURLINFO_PROXY_ERROR'=>2097211, 'CURLOPT_SSL_EC_CURVES'=>10298,
	'CURLOPT_HSTS'=>10300, 'CURLOPT_HSTS_CTRL'=>299, 'CURL_VERSION_HSTS'=>268435456, 'CURLAUTH_AWS_SIGV4'=>128,
	'CURLOPT_AWS_SIGV4'=>10305, 'CURLINFO_REFERER'=>1048636, 'CURLOPT_DOH_SSL_VERIFYHOST'=>307,
	'CURLOPT_DOH_SSL_VERIFYPEER'=>306, 'CURLOPT_DOH_SSL_VERIFYSTATUS'=>308, 'CURL_VERSION_GSASL'=>536870912,
	'CURLOPT_CAINFO_BLOB'=>40309, 'CURLOPT_PROXY_CAINFO_BLOB'=>40310, 'CURLSSLOPT_AUTO_CLIENT_CERT'=>32,
	'CURLOPT_MAXLIFETIME_CONN'=>314, 'CURLOPT_SSH_HOST_PUBLIC_KEY_SHA256'=>10311, 'CURLOPT_MIME_OPTIONS'=>315,
	'CURLOPT_SSH_HOSTKEYFUNCTION'=>20316, 'CURLOPT_PROTOCOLS_STR'=>10318, 'CURLOPT_REDIR_PROTOCOLS_STR'=>10319,
	'CURLOPT_WS_OPTIONS'=>320, 'CURLOPT_CA_CACHE_TIMEOUT'=>321, 'CURLOPT_QUICK_EXIT'=>322, 'CURLOPT_SAFE_UPLOAD'=>-1,
) as $hostlesswp_name => $hostlesswp_value ) {
	if ( ! defined( $hostlesswp_name ) ) {
		define( $hostlesswp_name, $hostlesswp_value );
	}
}
unset( $hostlesswp_name, $hostlesswp_value );

final class CurlHandle {
	public $opt     = array();
	public $verb    = 'GET';
	public $write   = 'stdout';
	public $info    = array();
	public $errno   = 0;
	public $error   = '';
	public $content = null;
	public $done    = false;
}

final class CurlMultiHandle {
	public $handles  = array();
	public $messages = array();
}

final class CurlShareHandle {}

class CURLFile {
	public $name     = '';
	public $mime     = '';
	public $postname = '';

	public function __construct( $filename, $mime_type = '', $posted_filename = '' ) {
		$this->name     = (string) $filename;
		$this->mime     = (string) $mime_type;
		$this->postname = (string) $posted_filename;
	}

	public function getFilename() {
		return $this->name;
	}

	public function getMimeType() {
		return $this->mime;
	}

	public function setMimeType( $mime_type ) {
		$this->mime = (string) $mime_type;
	}

	public function getPostFilename() {
		return $this->postname;
	}

	public function setPostFilename( $posted_filename ) {
		$this->postname = (string) $posted_filename;
	}
}

class CURLStringFile {
	public $data;
	public $postname;
	public $mime;

	public function __construct( $data, $postname, $mime = 'application/octet-stream' ) {
		$this->data     = (string) $data;
		$this->postname = (string) $postname;
		$this->mime     = (string) $mime;
	}
}

function curl_file_create( $filename, $mime_type = '', $posted_filename = '' ) {
	return new CURLFile( $filename, $mime_type, $posted_filename );
}

function curl_init( $url = null ) {
	$h = new CurlHandle();
	if ( null !== $url ) {
		$h->opt[ CURLOPT_URL ] = (string) $url;
	}
	return $h;
}

function curl_setopt( CurlHandle $handle, $option, $value ) {
	switch ( $option ) {
		case CURLOPT_POST:
			$handle->verb = $value ? 'POST' : ( 'POST' === $handle->verb ? 'GET' : $handle->verb );
			break;
		case CURLOPT_POSTFIELDS:
			$handle->verb = 'POST';
			break;
		case CURLOPT_HTTPGET:
			if ( $value ) {
				$handle->verb = 'GET';
			}
			break;
		case CURLOPT_PUT:
		case CURLOPT_UPLOAD:
			$handle->verb = $value ? 'PUT' : ( 'PUT' === $handle->verb ? 'GET' : $handle->verb );
			break;
		case CURLOPT_NOBODY:
			$handle->verb = $value ? 'HEAD' : ( 'HEAD' === $handle->verb ? 'GET' : $handle->verb );
			break;
		// As in PHP, the last of these decides where the body goes.
		case CURLOPT_RETURNTRANSFER:
			$handle->write = $value ? 'return' : 'stdout';
			break;
		case CURLOPT_WRITEFUNCTION:
			$handle->write = null === $value ? 'stdout' : 'func';
			break;
		case CURLOPT_FILE:
			$handle->write = is_resource( $value ) ? 'file' : 'stdout';
			break;
		case CURLOPT_HTTPHEADER:
		case CURLOPT_HTTP200ALIASES:
		case CURLOPT_POSTQUOTE:
		case CURLOPT_QUOTE:
			if ( ! is_array( $value ) && null !== $value ) {
				throw new TypeError( 'curl_setopt(): Argument #3 ($value) must be of type array' );
			}
			break;
	}
	$handle->opt[ $option ] = $value;
	return true;
}

function curl_setopt_array( CurlHandle $handle, array $options ) {
	foreach ( $options as $option => $value ) {
		if ( ! curl_setopt( $handle, $option, $value ) ) {
			return false;
		}
	}
	return true;
}

function hostlesswp_curl_fail( CurlHandle $h, $errno, $error ) {
	$h->errno = $errno;
	$h->error = $error;
	return false;
}

// The request a handle describes, or false (with the handle's error set).
function hostlesswp_curl_request( CurlHandle $h ) {
	$o   = $h->opt;
	$url = trim( (string) ( $o[ CURLOPT_URL ] ?? '' ) );
	if ( '' === $url ) {
		return hostlesswp_curl_fail( $h, CURLE_URL_MALFORMAT, 'No URL set' );
	}
	// Like curl, a URL without a scheme is taken as http.
	if ( ! preg_match( '#^[a-z][a-z0-9+.-]*://#i', $url ) ) {
		$url = 'http://' . $url;
	}
	$method = empty( $o[ CURLOPT_CUSTOMREQUEST ] ) ? $h->verb : strtoupper( (string) $o[ CURLOPT_CUSTOMREQUEST ] );

	$headers = array();
	$named   = array();
	foreach ( (array) ( $o[ CURLOPT_HTTPHEADER ] ?? array() ) as $line ) {
		$line = (string) $line;
		// "Name;" sends an empty header; "Name:" removes one curl would add.
		if ( preg_match( '/^([^:;]+);\s*$/', $line, $m ) ) {
			$headers[]                            = array( trim( $m[1] ), '' );
			$named[ strtolower( trim( $m[1] ) ) ] = true;
			continue;
		}
		$p = strpos( $line, ':' );
		if ( false === $p ) {
			continue;
		}
		$k                       = trim( substr( $line, 0, $p ) );
		$v                       = trim( substr( $line, $p + 1 ) );
		$named[ strtolower( $k ) ] = true;
		if ( '' !== $v ) {
			$headers[] = array( $k, $v );
		}
	}
	$add = function ( $k, $v ) use ( &$headers, &$named ) {
		if ( empty( $named[ strtolower( $k ) ] ) ) {
			$headers[]                 = array( $k, (string) $v );
			$named[ strtolower( $k ) ] = true;
		}
	};
	if ( ! empty( $o[ CURLOPT_USERAGENT ] ) ) {
		$add( 'User-Agent', $o[ CURLOPT_USERAGENT ] );
	}
	if ( ! empty( $o[ CURLOPT_REFERER ] ) ) {
		$add( 'Referer', $o[ CURLOPT_REFERER ] );
	}
	if ( ! empty( $o[ CURLOPT_COOKIE ] ) ) {
		$add( 'Cookie', $o[ CURLOPT_COOKIE ] );
	}
	if ( ! empty( $o[ CURLOPT_XOAUTH2_BEARER ] ) ) {
		$add( 'Authorization', 'Bearer ' . $o[ CURLOPT_XOAUTH2_BEARER ] );
	}
	$userpwd = $o[ CURLOPT_USERPWD ] ?? ( isset( $o[ CURLOPT_USERNAME ] ) ? $o[ CURLOPT_USERNAME ] . ':' . ( $o[ CURLOPT_PASSWORD ] ?? '' ) : null );
	if ( null !== $userpwd && '' !== (string) $userpwd ) {
		$add( 'Authorization', 'Basic ' . base64_encode( (string) $userpwd ) );
	}

	$body = null;
	if ( 'GET' !== $method && 'HEAD' !== $method ) {
		if ( array_key_exists( CURLOPT_POSTFIELDS, $o ) ) {
			$fields = $o[ CURLOPT_POSTFIELDS ];
			if ( is_array( $fields ) || is_object( $fields ) ) {
				// An array is sent as multipart/form-data, as curl does.
				$boundary = '------------------------' . bin2hex( random_bytes( 12 ) );
				$body     = '';
				foreach ( (array) $fields as $name => $value ) {
					$disposition = 'Content-Disposition: form-data; name="' . $name . '"';
					if ( $value instanceof CURLFile ) {
						$data = @file_get_contents( $value->name );
						if ( false === $data ) {
							return hostlesswp_curl_fail( $h, CURLE_READ_ERROR, 'Failed to open/read local data from file/application' );
						}
						$filename = '' !== $value->postname ? $value->postname : basename( $value->name );
						$part     = $disposition . '; filename="' . $filename . "\"\r\nContent-Type: " . ( '' !== $value->mime ? $value->mime : 'application/octet-stream' ) . "\r\n\r\n" . $data;
					} elseif ( $value instanceof CURLStringFile ) {
						$part = $disposition . '; filename="' . $value->postname . "\"\r\nContent-Type: " . $value->mime . "\r\n\r\n" . $value->data;
					} else {
						$part = $disposition . "\r\n\r\n" . ( is_array( $value ) ? 'Array' : (string) $value );
					}
					$body .= '--' . $boundary . "\r\n" . $part . "\r\n";
				}
				$body .= '--' . $boundary . "--\r\n";
				$add( 'Content-Type', 'multipart/form-data; boundary=' . $boundary );
			} else {
				$body = (string) $fields;
				$add( 'Content-Type', 'application/x-www-form-urlencoded' );
			}
		} elseif ( isset( $o[ CURLOPT_READFUNCTION ] ) || isset( $o[ CURLOPT_INFILE ] ) ) {
			$in   = $o[ CURLOPT_INFILE ] ?? null;
			$size = (int) ( $o[ CURLOPT_INFILESIZE ] ?? -1 );
			$body = '';
			if ( isset( $o[ CURLOPT_READFUNCTION ] ) ) {
				for ( ;; ) {
					$chunk = call_user_func( $o[ CURLOPT_READFUNCTION ], $h, $in, 16384 );
					if ( ! is_string( $chunk ) || '' === $chunk ) {
						break;
					}
					$body .= $chunk;
					if ( $size >= 0 && strlen( $body ) >= $size ) {
						break;
					}
				}
			} elseif ( is_resource( $in ) ) {
				$body = (string) stream_get_contents( $in );
			}
			if ( $size >= 0 ) {
				$body = substr( $body, 0, $size );
			}
		}
	}

	$timeout = 30;
	if ( ! empty( $o[ CURLOPT_TIMEOUT_MS ] ) ) {
		$timeout = $o[ CURLOPT_TIMEOUT_MS ] / 1000;
	} elseif ( ! empty( $o[ CURLOPT_TIMEOUT ] ) ) {
		$timeout = $o[ CURLOPT_TIMEOUT ];
	}
	// fetch() sets these itself.
	$headers = array_values(
		array_filter(
			$headers,
			function ( $h ) {
				return ! in_array( strtolower( $h[0] ), array( 'host', 'content-length', 'expect', 'connection', 'keep-alive', 'transfer-encoding' ), true );
			}
		)
	);
	return array(
		'url'     => $url,
		'method'  => $method,
		'headers' => $headers,
		'body'    => $body,
		'timeout' => $timeout,
		'follow'  => ! empty( $o[ CURLOPT_FOLLOWLOCATION ] ) && 0 !== (int) ( $o[ CURLOPT_MAXREDIRS ] ?? -1 ),
	);
}

// Hands a response to the handle's callbacks and outputs, as curl_exec() would; returns curl_exec()'s result.
function hostlesswp_curl_finish( CurlHandle $h, array $req, array $res, $started ) {
	$o       = $h->opt;
	$elapsed = microtime( true ) - $started;
	$h->info = array(
		'url'                     => $req['url'],
		'content_type'            => null,
		'http_code'               => 0,
		'header_size'             => 0,
		'request_size'            => 0,
		'filetime'                => -1,
		'ssl_verify_result'       => 0,
		'redirect_count'          => 0,
		'total_time'              => $elapsed,
		'namelookup_time'         => 0.0,
		'connect_time'            => 0.0,
		'pretransfer_time'        => 0.0,
		'size_upload'             => (float) strlen( (string) $req['body'] ),
		'size_download'           => 0.0,
		'speed_download'          => 0.0,
		'speed_upload'            => 0.0,
		'download_content_length' => -1.0,
		'upload_content_length'   => null === $req['body'] ? -1.0 : (float) strlen( $req['body'] ),
		'starttransfer_time'      => $elapsed,
		'redirect_time'           => 0.0,
		'redirect_url'            => '',
		'primary_ip'              => '',
		'certinfo'                => array(),
		'primary_port'            => 0,
		'local_ip'                => '',
		'local_port'              => 0,
		'http_version'            => 0,
		'protocol'                => 2,
		'ssl_verifyresult'        => 0,
		'scheme'                  => strtoupper( (string) parse_url( $req['url'], PHP_URL_SCHEME ) ),
		'appconnect_time_us'      => 0,
		'connect_time_us'         => 0,
		'namelookup_time_us'      => 0,
		'pretransfer_time_us'     => 0,
		'redirect_time_us'        => 0,
		'starttransfer_time_us'   => (int) ( $elapsed * 1e6 ),
		'total_time_us'           => (int) ( $elapsed * 1e6 ),
		'effective_method'        => $req['method'],
	);
	$path      = (string) parse_url( $req['url'], PHP_URL_PATH );
	$query     = (string) parse_url( $req['url'], PHP_URL_QUERY );
	$sent      = $req['method'] . ' ' . ( '' === $path ? '/' : $path ) . ( '' === $query ? '' : '?' . $query ) . " HTTP/1.1\r\nHost: " . parse_url( $req['url'], PHP_URL_HOST ) . "\r\n";
	foreach ( $req['headers'] as $hd ) {
		$sent .= $hd[0] . ': ' . $hd[1] . "\r\n";
	}
	$sent                    .= "\r\n";
	$h->info['request_size']  = strlen( $sent );
	if ( ! empty( $o[ CURLINFO_HEADER_OUT ] ) ) {
		$h->info['request_header'] = $sent;
	}
	if ( isset( $res['error'] ) ) {
		if ( ! empty( $res['malformed'] ) ) {
			return hostlesswp_curl_fail( $h, CURLE_URL_MALFORMAT, 'URL rejected: ' . $res['error'] );
		}
		if ( ! empty( $res['timeout'] ) ) {
			return hostlesswp_curl_fail( $h, CURLE_OPERATION_TIMEDOUT, sprintf( 'Operation timed out after %d milliseconds with 0 bytes received', $elapsed * 1000 ) );
		}
		return hostlesswp_curl_fail( $h, CURLE_COULDNT_CONNECT, 'Failed to connect to ' . parse_url( $req['url'], PHP_URL_HOST ) . ': ' . $res['error'] );
	}

	$status = (int) $res['status'];
	$lines  = array( rtrim( 'HTTP/1.1 ' . $status . ' ' . hostlesswp_http_reason( $status, $res['reason'] ?? '' ) ) . "\r\n" );
	$type   = null;
	$length = -1.0;
	$where  = '';
	foreach ( $res['headers'] as $hd ) {
		$lines[] = $hd[0] . ': ' . $hd[1] . "\r\n";
		$name    = strtolower( $hd[0] );
		if ( 'content-type' === $name ) {
			$type = $hd[1];
		} elseif ( 'content-length' === $name ) {
			$length = (float) $hd[1];
		} elseif ( 'location' === $name ) {
			$where = $hd[1];
		}
	}
	$lines[] = "\r\n";
	$head    = implode( '', $lines );
	$body    = 'HEAD' === $req['method'] ? '' : (string) $res['body'];
	$h->info = array_merge(
		$h->info,
		array(
			'url'                     => $res['url'] ?? $req['url'],
			'content_type'            => $type,
			'http_code'               => $status,
			'header_size'             => strlen( $head ),
			'redirect_count'          => empty( $res['redirected'] ) ? 0 : 1,
			'size_download'           => (float) strlen( $body ),
			'speed_download'          => $elapsed > 0 ? strlen( $body ) / $elapsed : 0.0,
			'download_content_length' => $length,
			'http_version'            => 2,
		)
	);
	if ( '' !== $where && $status >= 300 && $status < 400 && empty( $req['follow'] ) ) {
		$h->info['redirect_url'] = hostlesswp_absolute_url( $where, $req['url'] );
	}
	if ( ! empty( $o[ CURLOPT_FAILONERROR ] ) && $status >= 400 ) {
		return hostlesswp_curl_fail( $h, CURLE_HTTP_RETURNED_ERROR, 'The requested URL returned error: ' . $status );
	}

	foreach ( $lines as $line ) {
		if ( isset( $o[ CURLOPT_HEADERFUNCTION ] ) ) {
			if ( call_user_func( $o[ CURLOPT_HEADERFUNCTION ], $h, $line ) !== strlen( $line ) ) {
				return hostlesswp_curl_fail( $h, CURLE_WRITE_ERROR, 'Failed writing header' );
			}
		} elseif ( isset( $o[ CURLOPT_WRITEHEADER ] ) && is_resource( $o[ CURLOPT_WRITEHEADER ] ) ) {
			fwrite( $o[ CURLOPT_WRITEHEADER ], $line );
		}
	}
	$out = ( empty( $o[ CURLOPT_HEADER ] ) ? '' : $head ) . $body;

	$progress = $o[ CURLOPT_XFERINFOFUNCTION ] ?? ( $o[ CURLOPT_PROGRESSFUNCTION ] ?? null );
	if ( $progress && isset( $o[ CURLOPT_NOPROGRESS ] ) && ! $o[ CURLOPT_NOPROGRESS ] ) {
		$size = strlen( $body );
		$up   = strlen( (string) $req['body'] );
		if ( call_user_func( $progress, $h, $size, $size, $up, $up ) ) {
			return hostlesswp_curl_fail( $h, CURLE_ABORTED_BY_CALLBACK, 'Callback aborted' );
		}
	}

	if ( 'return' === $h->write ) {
		$h->content = $out;
		return $out;
	}
	if ( 'func' === $h->write ) {
		for ( $at = 0, $n = strlen( $out ); $at < $n; $at += 16384 ) {
			$chunk = substr( $out, $at, 16384 );
			$wrote = call_user_func( $o[ CURLOPT_WRITEFUNCTION ], $h, $chunk );
			if ( $wrote !== strlen( $chunk ) ) {
				return hostlesswp_curl_fail( $h, CURLE_WRITE_ERROR, 'Failure writing output to destination, passed ' . strlen( $chunk ) . ' returned ' . (int) $wrote );
			}
		}
	} elseif ( 'file' === $h->write ) {
		fwrite( $o[ CURLOPT_FILE ], $out );
	} else {
		echo $out;
	}
	return true;
}

function hostlesswp_curl_start( CurlHandle $h ) {
	$h->errno   = 0;
	$h->error   = '';
	$h->content = null;
	return hostlesswp_curl_request( $h );
}

function curl_exec( CurlHandle $handle ) {
	$req = hostlesswp_curl_start( $handle );
	if ( false === $req ) {
		return false;
	}
	$started = microtime( true );
	return hostlesswp_curl_finish( $handle, $req, hostlesswp_fetch( array( $req ) )[0], $started );
}

function curl_getinfo( CurlHandle $handle, $option = null ) {
	if ( null === $option ) {
		return $handle->info ? $handle->info : array( 'url' => (string) ( $handle->opt[ CURLOPT_URL ] ?? '' ) ) + array_fill_keys( array( 'content_type', 'http_code', 'header_size', 'request_size' ), 0 );
	}
	if ( CURLINFO_PRIVATE === $option ) {
		return $handle->opt[ CURLOPT_PRIVATE ] ?? false;
	}
	static $keys = null;
	if ( null === $keys ) {
		$keys = array();
		foreach ( array(
			'EFFECTIVE_URL' => 'url', 'CONTENT_TYPE' => 'content_type', 'HTTP_CODE' => 'http_code', 'RESPONSE_CODE' => 'http_code',
			'HEADER_SIZE' => 'header_size', 'REQUEST_SIZE' => 'request_size', 'FILETIME' => 'filetime', 'SSL_VERIFYRESULT' => 'ssl_verify_result',
			'REDIRECT_COUNT' => 'redirect_count', 'TOTAL_TIME' => 'total_time', 'NAMELOOKUP_TIME' => 'namelookup_time', 'CONNECT_TIME' => 'connect_time',
			'PRETRANSFER_TIME' => 'pretransfer_time', 'SIZE_UPLOAD' => 'size_upload', 'SIZE_DOWNLOAD' => 'size_download', 'SPEED_DOWNLOAD' => 'speed_download',
			'SPEED_UPLOAD' => 'speed_upload', 'CONTENT_LENGTH_DOWNLOAD' => 'download_content_length', 'CONTENT_LENGTH_UPLOAD' => 'upload_content_length',
			'STARTTRANSFER_TIME' => 'starttransfer_time', 'REDIRECT_TIME' => 'redirect_time', 'REDIRECT_URL' => 'redirect_url', 'PRIMARY_IP' => 'primary_ip',
			'PRIMARY_PORT' => 'primary_port', 'LOCAL_IP' => 'local_ip', 'LOCAL_PORT' => 'local_port', 'HTTP_VERSION' => 'http_version', 'PROTOCOL' => 'protocol',
			'SCHEME' => 'scheme', 'EFFECTIVE_METHOD' => 'effective_method', 'CERTINFO' => 'certinfo', 'HEADER_OUT' => 'request_header',
			'TOTAL_TIME_T' => 'total_time_us', 'STARTTRANSFER_TIME_T' => 'starttransfer_time_us', 'CONNECT_TIME_T' => 'connect_time_us',
			'NAMELOOKUP_TIME_T' => 'namelookup_time_us', 'PRETRANSFER_TIME_T' => 'pretransfer_time_us', 'REDIRECT_TIME_T' => 'redirect_time_us',
			'APPCONNECT_TIME_T' => 'appconnect_time_us',
		) as $name => $key ) {
			if ( defined( 'CURLINFO_' . $name ) ) {
				$keys[ constant( 'CURLINFO_' . $name ) ] = $key;
			}
		}
		foreach ( array( 'SIZE_DOWNLOAD_T' => 'size_download', 'SIZE_UPLOAD_T' => 'size_upload', 'SPEED_DOWNLOAD_T' => 'speed_download', 'SPEED_UPLOAD_T' => 'speed_upload', 'CONTENT_LENGTH_DOWNLOAD_T' => 'download_content_length', 'CONTENT_LENGTH_UPLOAD_T' => 'upload_content_length' ) as $name => $key ) {
			if ( defined( 'CURLINFO_' . $name ) ) {
				$keys[ constant( 'CURLINFO_' . $name ) ] = array( $key );
			}
		}
	}
	if ( ! isset( $keys[ $option ] ) ) {
		return CURLINFO_OS_ERRNO === $option || CURLINFO_NUM_CONNECTS === $option ? ( CURLINFO_NUM_CONNECTS === $option ? 1 : 0 ) : false;
	}
	$key = $keys[ $option ];
	// The *_T variants are integers.
	if ( is_array( $key ) ) {
		return (int) ( $handle->info[ $key[0] ] ?? 0 );
	}
	return $handle->info[ $key ] ?? ( 'url' === $key ? (string) ( $handle->opt[ CURLOPT_URL ] ?? '' ) : false );
}

function curl_errno( CurlHandle $handle ) {
	return $handle->errno;
}

function curl_error( CurlHandle $handle ) {
	return $handle->error;
}

function curl_strerror( $code ) {
	static $text = array(
		0 => 'No error', 1 => 'Unsupported protocol', 3 => 'URL using bad/illegal format or missing URL', 5 => "Couldn't resolve proxy name",
		6 => "Couldn't resolve host name", 7 => "Couldn't connect to server", 22 => 'HTTP response code said error',
		23 => 'Failed writing received data to disk/application', 26 => 'Failed to open/read local data from file/application',
		28 => 'Timeout was reached', 35 => 'SSL connect error', 42 => 'Operation was aborted by an application callback',
		47 => 'Number of redirects hit maximum amount', 52 => 'Server returned nothing (no headers, no data)', 56 => 'Failure when receiving data from the peer',
	);
	return $text[ $code ] ?? 'Unknown error';
}

function curl_close( CurlHandle $handle ) {
}

function curl_reset( CurlHandle $handle ) {
	$handle->opt   = array();
	$handle->verb  = 'GET';
	$handle->write = 'stdout';
	$handle->info  = array();
	$handle->errno = 0;
	$handle->error = '';
}

function curl_copy_handle( CurlHandle $handle ) {
	return clone $handle;
}

function curl_escape( CurlHandle $handle, $string ) {
	return rawurlencode( (string) $string );
}

function curl_unescape( CurlHandle $handle, $string ) {
	return rawurldecode( (string) $string );
}

function curl_pause( CurlHandle $handle, $flags ) {
	return CURLE_OK;
}

function curl_upkeep( CurlHandle $handle ) {
	return true;
}

function curl_version() {
	return array(
		'version_number'     => 0x080e01,
		'age'                => 11,
		'features'           => CURL_VERSION_IPV6 | CURL_VERSION_SSL | CURL_VERSION_LIBZ | CURL_VERSION_HTTP2 | CURL_VERSION_BROTLI,
		'ssl_version_number' => 0,
		'version'            => '8.14.1',
		'host'               => 'wasm32-hostlesswp-fetch',
		'ssl_version'        => 'BoringSSL',
		'libz_version'       => '1.3.1',
		'protocols'          => array( 'http', 'https' ),
		'ares'               => '',
		'ares_num'           => 0,
		'libidn'             => '',
		'iconv_ver_num'      => 0,
		'libssh_version'     => '',
		'brotli_ver_num'     => 0,
		'brotli_version'     => '',
	);
}

function curl_share_init() {
	return new CurlShareHandle();
}

function curl_share_setopt( CurlShareHandle $share_handle, $option, $value ) {
	return true;
}

function curl_share_close( CurlShareHandle $share_handle ) {
}

function curl_share_errno( CurlShareHandle $share_handle ) {
	return 0;
}

function curl_share_strerror( $error_code ) {
	return 0 === $error_code ? 'No error' : 'Unknown error';
}

function curl_multi_init() {
	return new CurlMultiHandle();
}

function curl_multi_add_handle( CurlMultiHandle $multi_handle, CurlHandle $handle ) {
	$id = spl_object_id( $handle );
	if ( isset( $multi_handle->handles[ $id ] ) ) {
		return CURLM_ADDED_ALREADY;
	}
	$handle->done                  = false;
	$multi_handle->handles[ $id ] = $handle;
	return CURLM_OK;
}

function curl_multi_remove_handle( CurlMultiHandle $multi_handle, CurlHandle $handle ) {
	unset( $multi_handle->handles[ spl_object_id( $handle ) ] );
	return CURLM_OK;
}

// Sends every handle not yet done, all at once, and returns when all have answered.
function curl_multi_exec( CurlMultiHandle $multi_handle, &$still_running ) {
	$requests = array();
	foreach ( $multi_handle->handles as $id => $h ) {
		if ( $h->done ) {
			continue;
		}
		$h->done = true;
		$req     = hostlesswp_curl_start( $h );
		if ( false === $req ) {
			$multi_handle->messages[] = array( 'msg' => CURLMSG_DONE, 'result' => $h->errno, 'handle' => $h );
			continue;
		}
		$requests[ $id ] = $req;
	}
	if ( $requests ) {
		$started = microtime( true );
		foreach ( hostlesswp_fetch( $requests ) as $id => $res ) {
			$h = $multi_handle->handles[ $id ];
			hostlesswp_curl_finish( $h, $requests[ $id ], $res, $started );
			$multi_handle->messages[] = array( 'msg' => CURLMSG_DONE, 'result' => $h->errno, 'handle' => $h );
		}
	}
	$still_running = 0;
	return CURLM_OK;
}

function curl_multi_select( CurlMultiHandle $multi_handle, $timeout = 1.0 ) {
	foreach ( $multi_handle->handles as $h ) {
		if ( ! $h->done ) {
			return 1;
		}
	}
	return 0;
}

function curl_multi_info_read( CurlMultiHandle $multi_handle, &$queued_messages = null ) {
	$message         = array_shift( $multi_handle->messages );
	$queued_messages = count( $multi_handle->messages );
	return null === $message ? false : $message;
}

function curl_multi_getcontent( CurlHandle $handle ) {
	return $handle->content;
}

function curl_multi_close( CurlMultiHandle $multi_handle ) {
}

function curl_multi_errno( CurlMultiHandle $multi_handle ) {
	return 0;
}

function curl_multi_strerror( $error_code ) {
	return 0 === $error_code ? 'No error' : 'Unknown error';
}

function curl_multi_setopt( CurlMultiHandle $multi_handle, $option, $value ) {
	return true;
}
