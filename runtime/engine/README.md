# HostlessWP engine

PHP 8.3 compiled to WebAssembly and its JavaScript runtime, which the Worker runs (`runtime/src/index.js`). Distributed in binary form only.

- `core.mjs`, `core.wasm`: PHP and the WebAssembly loader.
- `engine.mjs`: starts PHP and runs one request at a time.
- `handler.mjs`: maps HTTP requests to PHP scripts.

This product includes PHP software, freely available from <http://www.php.net/software/>.
