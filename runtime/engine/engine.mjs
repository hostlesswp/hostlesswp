// HostlessWP engine runtime: instantiates the engine wasm and runs PHP requests in it, one at a time.
//
//   const engine = await loadEngine(createEngineModule, wasmModule, { env, onMessage, fetchPath, fetchNode, connect });
//   // mount files with engine.FS, then:
//   await engine.start({ 'memory_limit': '256M', ... });
//   const res = await engine.request({ SCRIPT_FILENAME: '/www/index.php', REQUEST_METHOD: 'GET', ... }, body);
//
// The request is described by its $_SERVER variables, as a FastCGI server would pass them (see handler.mjs).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function loadEngine(createEngineModule, wasmModule, options = {}) {
  // Per-request sinks for what PHP sends back; the imports in library.js call these.
  let sink = null;
  const host = {
    write(bytes) {
      if (sink) sink.chunks.push(bytes);
    },
    status(code) {
      if (sink) sink.status = code;
    },
    header(line) {
      if (sink) sink.headers.push(line);
    },
    log(message, type) {
      if (sink) sink.log.push(message);
      if (options.onLog) options.onLog(message, type);
    },
    message: options.onMessage || null,
    fetchPath: options.fetchPath || null,
    fetchNode: options.fetchNode || null,
    // TCP for PHP's sockets: Workers' connect() from cloudflare:sockets, or one like it (see library.js).
    connect: options.connect || null,
  };
  const mod = await createEngineModule({
    hostlesswp: host,
    // Environment variables of the process, before PHP reads any (USE_ZEND_ALLOC is read at startup).
    preRun: [(m) => Object.assign(m.ENV, options.env || {})],
    instantiateWasm:
      options.instantiateWasmWith ||
      ((imports, done) => {
        WebAssembly.instantiate(wasmModule, imports).then((instance) => done(instance, wasmModule));
        return {};
      }),
    print: options.print || (() => {}),
    printErr: options.printErr || (() => {}),
  });

  let started = false;
  let busy = false;
  let broken = null;

  const engine = {
    module: mod,
    FS: mod.FS,
    // The callbacks PHP reaches (message, fetchPath, fetchNode) can be replaced here after loading.
    hooks: host,

    // Starts PHP with these php.ini settings ({ name: value }). Once per engine.
    async start(ini = {}) {
      if (started) throw new Error('engine already started');
      const text = Object.entries(ini)
        .map(([k, v]) => `${k}=${iniValue(v)}\n`)
        .join('');
      const ptr = allocBytes(mod, encoder.encode(text + '\0'));
      try {
        const rc = await mod._hwp_startup(ptr);
        if (rc !== 0) throw new Error('PHP did not start');
      } finally {
        mod._free(ptr);
      }
      started = true;
    },

    // Runs one request. vars: $_SERVER (SCRIPT_FILENAME required), body: Uint8Array or undefined.
    // Resolves to { status, headers: [[name, value]], body: Uint8Array, exitStatus, log }.
    async request(vars, body) {
      if (!started) throw new Error('engine not started');
      if (broken) throw broken;
      if (busy) throw new Error('engine is running another request');
      busy = true;
      const out = (sink = { status: 200, headers: [], chunks: [], log: [] });
      try {
        const parts = [];
        for (const [k, v] of Object.entries(vars)) {
          if (v === undefined || v === null) continue;
          parts.push(String(k).replace(/\0/g, ''), String(v).replace(/\0/g, ''));
        }
        const varBytes = encoder.encode(parts.join('\0') + '\0\0');
        const varsPtr = allocBytes(mod, varBytes);
        const bodyPtr = body && body.length ? allocBytes(mod, body) : 0;
        // hwp_request owns both buffers from here on.
        let exitStatus;
        try {
          exitStatus = await mod._hwp_request(varsPtr, varBytes.length, bodyPtr, bodyPtr ? body.length : 0);
        } catch (e) {
          // A trap leaves PHP's state undefined: this engine must not run another request.
          broken = e;
          throw e;
        }
        if (exitStatus === -1) throw new Error('PHP could not start the request');
        return {
          status: out.status,
          headers: out.headers.map(splitHeader).filter(Boolean),
          body: concat(out.chunks),
          exitStatus,
          log: out.log,
        };
      } finally {
        sink = null;
        busy = false;
      }
    },

    // Runs a piece of PHP code as a script (tooling, not requests). Resolves to { text, exitStatus, log }.
    async run(code) {
      const file = '/tmp/hostlesswp-run-' + Math.random().toString(36).slice(2) + '.php';
      mod.FS.mkdirTree('/tmp');
      mod.FS.writeFile(file, code);
      try {
        const res = await engine.request({ SCRIPT_FILENAME: file, SCRIPT_NAME: file, REQUEST_METHOD: 'GET', REQUEST_URI: file, PHP_SELF: file });
        return { text: decoder.decode(res.body), exitStatus: res.exitStatus, log: res.log };
      } finally {
        try {
          mod.FS.unlink(file);
        } catch {}
      }
    },

    // Bytes of linear memory, and how much of it PHP's allocator has taken.
    memory() {
      const buf = mod.wasmExports.memory.buffer;
      const sbrk = new Uint32Array(buf)[mod._emscripten_get_sbrk_ptr() >> 2];
      return { size: buf.byteLength, used: sbrk };
    },

    get broken() {
      return broken;
    },
  };
  return engine;
}

function iniValue(v) {
  const s = String(v);
  return /^[\w.\/:-]*$/.test(s) ? s : '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function allocBytes(mod, bytes) {
  const ptr = mod._malloc(bytes.length || 1);
  if (!ptr) throw new Error('out of memory');
  new Uint8Array(mod.wasmExports.memory.buffer).set(bytes, ptr);
  return ptr;
}

function splitHeader(line) {
  const i = line.indexOf(':');
  if (i <= 0) return null;
  return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
}

function concat(chunks) {
  if (chunks.length === 1) return chunks[0];
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
