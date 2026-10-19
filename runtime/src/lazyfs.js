// Mount zip bundles into Emscripten MEMFS without inflating or even creating them up front.
// A mounted directory keeps an index of what the zips hold below it; MEMFS nodes are created only when a
// path is first looked up (or the directory is listed), and a file's bytes are inflated from the retained
// (compressed) zip only when PHP first touches node.contents. A request reads ~2000 of a site's ~16000 files,
// and every MEMFS node costs close to 1 KB of heap, which counts against the Worker memory limit.
import { inflateSync } from 'fflate';

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function centralDirectory(zip) {
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (u32(zip, i) === 0x06054b50) return { count: u16(zip, i + 10), offset: u32(zip, i + 16) };
  }
  throw new Error('zip: end of central directory not found');
}

// Reads one central directory entry: where its data starts and how it is stored.
function entryAt(zip, p) {
  const local = u32(zip, p + 42);
  return {
    method: u16(zip, p + 10),
    csize: u32(zip, p + 20),
    usize: u32(zip, p + 24),
    start: local + 30 + u16(zip, local + 26) + u16(zip, local + 28),
  };
}

export const lazyStats = { files: 0, nodes: 0, inflated: 0, inflatedBytes: 0, retainedBytes: 0 };

// A directory index: { parts: [{ zip, retain, files: Map<name, central directory offset> }], dirs: Map<name, index> }.
// One part per zip that has files directly in the directory; a later zip wins when two hold the same name.
const newIndex = () => ({ parts: [], dirs: new Map() });

function mergeIndex(into, from) {
  into.parts.push(...from.parts);
  for (const [name, sub] of from.dirs) {
    const have = into.dirs.get(name);
    if (have) mergeIndex(have, sub);
    else into.dirs.set(name, sub);
  }
}

function zipIndex(zip, retain) {
  const cd = centralDirectory(zip);
  const dec = new TextDecoder();
  const root = newIndex();
  const partOf = new Map(); // index -> its part for this zip
  for (let n = 0, p = cd.offset; n < cd.count; n++) {
    if (u32(zip, p) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const nameLen = u16(zip, p + 28);
    const segs = dec.decode(zip.subarray(p + 46, p + 46 + nameLen)).split('/');
    const file = segs.pop();
    let idx = root;
    for (const s of segs) {
      let sub = idx.dirs.get(s);
      if (!sub) idx.dirs.set(s, (sub = newIndex()));
      idx = sub;
    }
    if (file) {
      let part = partOf.get(idx);
      if (!part) {
        part = { zip, retain, files: new Map() };
        partOf.set(idx, part);
        idx.parts.push(part);
      }
      part.files.set(file, p);
      lazyStats.files++;
    }
    p += 46 + nameLen + u16(zip, p + 30) + u16(zip, p + 32);
  }
  return root;
}

// retain=false: never keep inflated bytes on the node (for files read once, e.g. the OPcache file cache
// feeding shared memory); only the most recently inflated entry is kept, since a read() sequence touches it repeatedly.
let lastInflated = null;

function makeLazyFile(node, zip, e, retain) {
  node.usedBytes = e.usize;
  const materialize = (value) => {
    Object.defineProperty(node, 'contents', { value, writable: true, configurable: true, enumerable: true });
    return value;
  };
  Object.defineProperty(node, 'contents', {
    configurable: true,
    enumerable: true,
    get() {
      if (!retain && lastInflated && lastInflated.e === e) return lastInflated.data;
      const raw = zip.subarray(e.start, e.start + e.csize);
      const data = e.method === 0 ? raw.slice() : inflateSync(raw, { out: new Uint8Array(e.usize) });
      lazyStats.inflated++;
      lazyStats.inflatedBytes += e.usize;
      if (!retain) {
        lastInflated = { e, data };
        return data;
      }
      return materialize(data);
    },
    set(v) {
      materialize(v);
    },
  });
}

// node_ops for directories with an index: the MEMFS ones (base), plus creating children from the index.
const lazyOps = new WeakMap();
function lazyOpsFor(base, FS) {
  let ops = lazyOps.get(base);
  if (ops) return ops;
  const child = (parent, name) => {
    const idx = parent.lazyIndex;
    if (!idx) return null;
    let node = null;
    const sub = idx.dirs.get(name);
    if (sub) {
      idx.dirs.delete(name);
      node = base.mknod(parent, name, 0o40755, 0);
      if (parent.lazyReadOnly) node.lazyReadOnly = true;
      makeLazyDir(FS, node, sub);
    } else {
      for (let i = idx.parts.length - 1; i >= 0 && !node; i--) {
        const part = idx.parts[i];
        const p = part.files.get(name);
        if (p === undefined) continue;
        node = base.mknod(parent, name, 0o100644, 0);
        makeLazyFile(node, part.zip, entryAt(part.zip, p), part.retain);
      }
      if (node) for (const part of idx.parts) part.files.delete(name);
    }
    if (node) lazyStats.nodes++;
    if (!idx.dirs.size && idx.parts.every((part) => !part.files.size)) parent.lazyIndex = null;
    return node;
  };
  // Creates every remaining child, for operations that need the full listing.
  const all = (node) => {
    const idx = node.lazyIndex;
    if (!idx) return;
    const names = new Set(idx.dirs.keys());
    for (const part of idx.parts) for (const name of part.files.keys()) names.add(name);
    for (const name of names) child(node, name);
  };
  ops = {
    ...base,
    lookup(parent, name) {
      return child(parent, name) || base.lookup(parent, name);
    },
    // EACCES for new files and directories below a read-only mount.
    mknod(parent, name, mode, dev) {
      if (parent.lazyReadOnly) throw new FS.ErrnoError(2);
      return base.mknod(parent, name, mode, dev);
    },
    readdir(node) {
      all(node);
      return base.readdir(node);
    },
    // MEMFS checks that a directory is empty by looking at its created children only.
    rmdir(parent, name) {
      all(FS.lookupNode(parent, name));
      return base.rmdir(parent, name);
    },
    rename(oldNode, newDir, newName) {
      try {
        all(FS.lookupNode(newDir, newName));
      } catch {}
      return base.rename(oldNode, newDir, newName);
    },
  };
  lazyOps.set(base, ops);
  isLazyOps.add(ops);
  return ops;
}

const isLazyOps = new WeakSet();
function makeLazyDir(FS, node, index) {
  if (node.lazyIndex) mergeIndex(node.lazyIndex, index);
  else node.lazyIndex = index;
  if (isLazyOps.has(node.node_ops)) return;
  node.node_ops = lazyOpsFor(node.node_ops, FS);
}

// Adds a zip's files below root. Directories created earlier (by a previous mount or at runtime) are
// extended in place, so several zips can share a directory. readOnly: nothing new can be created below root
// (existing files stay writable).
export function mountLazyZip(FS, root, zip, { retain = true, readOnly = false } = {}) {
  lazyStats.retainedBytes += zip.length;
  FS.mkdirTree(root);
  const attach = (node, index) => {
    if (readOnly) node.lazyReadOnly = true;
    for (const [name, sub] of [...index.dirs]) {
      const existing = node.contents[name];
      if (existing && FS.isDir(existing.mode)) {
        index.dirs.delete(name);
        attach(existing, sub);
      }
    }
    makeLazyDir(FS, node, index);
  };
  attach(FS.lookupPath(root).node, zipIndex(zip, retain));
}
