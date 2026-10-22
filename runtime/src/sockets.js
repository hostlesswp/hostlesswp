// TCP for PHP: Emscripten's socket layer opens each TCP connection as a WebSocket to ws://host:port (meant for a
// WebSocket-to-TCP proxy). With this class in place of WebSocket, the connection is a real TCP socket from Workers'
// connect(), so fsockopen(), stream_socket_client() and everything built on them (SMTP, Redis, APIs over raw TCP)
// work. TLS (ssl://, tls://, stream_socket_enable_crypto()) is done by PHP's OpenSSL over these bytes.
//
// Emscripten drives the object both ways: Node-style (on/once/removeListener, message as (data, isBinary)) and
// browser-style (onopen/onmessage/onclose/onerror, addEventListener). Both are served.

export function tcpWebSocket(connect) {
  return class TcpWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;

    #listeners = new Map();
    #sock = null;
    #writer = null;

    constructor(url) {
      this.url = url;
      this.binaryType = 'arraybuffer';
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      const m = /^wss?:\/\/(\[[^\]]+\]|[^:/]+):(\d+)/.exec(url);
      // Emscripten's handlers are attached right after the constructor returns: start on the next turn.
      queueMicrotask(() => this.#start(m && m[1].replace(/^\[|\]$/g, ''), m && Number(m[2])));
    }

    async #start(hostname, port) {
      try {
        if (!hostname) throw new Error('bad address ' + this.url);
        this.#sock = connect({ hostname, port }, { secureTransport: 'off', allowHalfOpen: false });
        this.#writer = this.#sock.writable.getWriter();
        await this.#sock.opened;
      } catch (e) {
        this.readyState = 3;
        this.#emit('error', e);
        this.#emit('close');
        return;
      }
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.#emit('open');
      const reader = this.#sock.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.byteLength) {
            const data = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            this.#emit('message', data);
          }
        }
      } catch (e) {
        if (this.readyState < 2) this.#emit('error', e);
      }
      this.readyState = 3;
      this.#emit('close');
    }

    send(data) {
      if (this.readyState !== 1) throw new Error('socket is not open');
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.#writer.write(bytes.slice()).catch((e) => this.#emit('error', e));
    }

    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      const sock = this.#sock;
      Promise.resolve(sock && sock.close())
        .catch(() => {})
        .finally(() => {
          if (this.readyState !== 3) {
            this.readyState = 3;
            this.#emit('close');
          }
        });
    }

    // TCP_NODELAY and SO_KEEPALIVE are for the proxy Emscripten expects; a direct socket has nothing to set.
    setSocketOpt() {}

    #emit(type, arg) {
      for (const fn of [...(this.#listeners.get(type) || [])]) {
        if (type === 'message') fn.call(this, arg, true);
        else fn.call(this, arg);
      }
      const prop = this['on' + type];
      if (typeof prop === 'function') prop.call(this, type === 'message' ? { data: arg } : { type, error: arg });
    }

    on(type, fn) {
      if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
      this.#listeners.get(type).add(fn);
      return this;
    }

    once(type, fn) {
      const wrapped = (...args) => {
        this.removeListener(type, wrapped);
        fn.apply(this, args);
      };
      wrapped.original = fn;
      return this.on(type, wrapped);
    }

    removeListener(type, fn) {
      const set = this.#listeners.get(type);
      if (set) for (const f of set) if (f === fn || f.original === fn) set.delete(f);
      return this;
    }

    off(type, fn) {
      return this.removeListener(type, fn);
    }

    addEventListener(type, fn) {
      this.on(type, fn);
    }

    removeEventListener(type, fn) {
      this.removeListener(type, fn);
    }
  };
}
