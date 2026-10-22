# HostlessWP PHP

`php_8_3.js` and `php_8_3.wasm` are HostlessWP PHP: PHP 8.3.36 compiled to WebAssembly (JSPI), built from php-wasm 3.1.57 of [WordPress Playground](https://github.com/WordPress/wordpress-playground), with lazily loaded function bodies, files fetched on first read and a smaller set of extensions.

## Lazily loaded function bodies

When OPcache writes its file cache, the opcodes, live ranges and try/catch table of every function with at least 8 opcodes are stored apart from the rest of the script, each one zlib compressed, in `<script>.bin.body` next to `<script>.bin`. Loading a script from the file cache puts only the rest into shared memory; a function's body is read, inflated and relocated the first time the function is called, and the copies of a method made by inheritance, traits and closures share it.

Code that reads a function's opcodes without calling it (named argument defaults, Reflection default values and closure variables, inheritance checks) loads the body first. Scripts compiled at run time are not affected.

The file cache format differs from stock OPcache, so the system id differs too: a cache written by another PHP build is never loaded.

## Files fetched on first read

PHP calls the JS imports `js_hostlesswp_fetch(path)` and `js_hostlesswp_fetch_fd(fd)` before it reads an OPcache file or the first bytes of a source file, and again when an open fails with ENOENT. The runtime fetches the zip part holding the file then (`hostlesswpFetchNode` in `runtime/src/index.js`), so parts no request needs are never downloaded.

## Smaller build

Workers count the compiled wasm against the isolate's memory, and its data segment is copied into the heap at start. The build leaves out:

- the side module ABI: php-wasm exports every libphp symbol so extensions built separately can be loaded at run time, which keeps all of libphp in the binary. HostlessWP loads no side modules, so only what PHP reaches is linked.
- sqlite3 and pdo_sqlite, curl, soap, fileinfo, the CLI SAPI and the WebSocket network proxy: WordPress runs on MySQL through the Worker, and with no network stack in a Worker the curl extension could not connect anyway. curl and fileinfo are provided in PHP instead (`runtime/php/hostlesswp-curl.php` sends with the Worker's fetch(), `runtime/php/hostlesswp-fileinfo.php` matches file signatures).
- the AV1 encoder: libavif is built with the dav1d decoder only, not libaom (about 2.7 MB of code). GD reads AVIF and cannot write it; the runtime saves the sizes of AVIF uploads as WebP. libgd converts AVIF to RGB a strip of rows at a time instead of into a full RGBA copy of the image, which is 48 MB less at the peak for a 12 megapixel photo.

The wasm is 11.5 MB (4.7 MB gzipped) instead of 18 MB.

`lib/build.mjs` applies the remaining patches when it copies the build into a site (see `vendorPhp()`).

The `@php-wasm/universal` version in `package.json` must stay at the version this build comes from.
