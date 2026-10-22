// Mount zip bundles into Emscripten MEMFS without inflating or even creating them up front.
// A mounted directory keeps an index of what the zips hold below it; MEMFS nodes are created only when a
// path is first looked up (or the directory is listed), and a file's bytes are inflated from the retained
// (compressed) zip only when PHP first touches node.contents. A request reads ~2000 of a site's ~16000 files,
// and every MEMFS node costs close to 1 KB of heap, which counts against the Worker memory limit.
// A remote zip is mounted from its central directory alone and fetched when PHP first reads one of its files.
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

// Reads one central directory entry (at p in cd, the zip itself or only its central directory): where its data
// starts in the zip and how it is stored.
function entryAt(cd, p, zip) {
  const local = u32(cd, p + 42);
  return {
    method: u16(cd, p + 10),
    csize: u32(cd, p + 20),
    usize: u32(cd, p + 24),
    start: local + 30 + u16(zip, local + 26) + u16(zip, local + 28),
  };
}

export const lazyStats = { files: 0, nodes: 0, inflated: 0, inflatedBytes: 0, retainedBytes: 0, remoteLoads: 0 };

// A directory index: { parts: [{ cd, src, retain, files: Map<name, offset in cd> }], dirs: Map<name, index> }.
// One part per zip that has files directly in the directory; a later zip wins when two hold the same name.
// src holds the zip bytes ({ zip }), or for a remote zip { zip: null, load } until the zip is fetched.
const newIndex = () => ({ parts: [], dirs: new Map() });

function mergeIndex(into, from) {
  into.parts.push(...from.parts);
  for (const [name, sub] of from.dirs) {
    const have = into.dirs.get(name);
    if (have) mergeIndex(have, sub);
    else into.dirs.set(name, sub);
  }
}

// zip: a whole zip, or (cdOnly) only its central directory and end record.
function zipIndex(zip, retain, src, cdOnly = false) {
  const cd = centralDirectory(zip);
  const dec = new TextDecoder();
  const root = newIndex();
  const partOf = new Map(); // index -> its part for this zip
  for (let n = 0, p = cdOnly ? 0 : cd.offset; n < cd.count; n++) {
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
        part = { cd: zip, src, retain, files: new Map() };
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

function makeLazyFile(FS, node, part, p) {
  const { cd, src, retain } = part;
  let e = null;
  node.usedBytes = u32(cd, p + 24);
  // A remote or unloaded zip is fetched when PHP first reads one of its files (fetchLazyNode).
  if (src.load) node.lazyRemote = src;
  const materialize = (value) => {
    Object.defineProperty(node, 'contents', { value, writable: true, configurable: true, enumerable: true });
    return value;
  };
  Object.defineProperty(node, 'contents', {
    configurable: true,
    enumerable: true,
    get() {
      const zip = src.zip;
      if (!zip) throw new FS.ErrnoError(29); // EIO: read before the zip was fetched
      e ||= entryAt(cd, p, zip);
      // Read again in a later request: whatever read it did not keep it (OPcache could not fit the script into
      // shared memory), so the zip is worth keeping.
      if (node.lazyEpoch !== undefined && node.lazyEpoch !== epoch) src.reread = true;
      node.lazyEpoch = epoch;
      if (!retain && lastInflated && lastInflated.e === e) return lastInflated.data;
      const raw = zip.subarray(e.start, e.start + e.csize);
      // A stored entry read once (the OPcache function bodies, read at an offset each time) is used in place.
      const data = e.method === 0 ? (retain ? raw.slice() : raw) : inflateSync(raw, { out: new Uint8Array(e.usize) });
      lazyStats.inflated++;
      lazyStats.inflatedBytes += e.usize;
      if (!retain) {
        lastInflated = { e, data, src };
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
        makeLazyFile(FS, node, part, p);
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
// A zip's bytes and how to fetch them again: { zip, load, reread }. load is optional for mountLazyZip; with it
// the zip can be unloaded (unloadLazyZip) and is fetched again when PHP next reads one of its files.
function makeSrc(zip, load) {
  const src = {
    zip,
    reread: false,
    loading: null,
    load:
      load &&
      (() =>
        (src.loading ||= load().then(
          (bytes) => {
            src.zip = bytes;
            src.loading = null;
            lazyStats.retainedBytes += bytes.length;
            lazyStats.remoteLoads++;
          },
          (e) => {
            src.loading = null;
            throw e;
          },
        ))),
  };
  return src;
}

// Requests are numbered so that a file read in more than one request can be told apart (see src.reread).
let epoch = 0;
export function nextEpoch() {
  epoch++;
}

export function mountLazyZip(FS, root, zip, { retain = true, readOnly = false, load = null } = {}) {
  lazyStats.retainedBytes += zip.length;
  const src = makeSrc(zip, load);
  // An unloadable zip is indexed from a copy of its central directory, so the zip itself can be freed.
  if (load) attachIndex(FS, root, zipIndex(zip.slice(centralDirectory(zip).offset), retain, src, true), readOnly);
  else attachIndex(FS, root, zipIndex(zip, retain, src), readOnly);
  return src;
}

// Like mountLazyZip, but only the zip's central directory is here: its files exist with their sizes, and load()
// fetches the zip when PHP first reads one of them (see fetchLazyNode).
export function mountRemoteZip(FS, root, cd, load, { retain = true, readOnly = false } = {}) {
  lazyStats.retainedBytes += cd.length;
  const src = makeSrc(null, load);
  attachIndex(FS, root, zipIndex(cd, retain, src, true), readOnly);
  return src;
}

// Frees a zip's bytes; its files stay listed and are fetched again when read (needs load).
export function unloadLazyZip(src) {
  if (!src.zip || !src.load) return;
  lazyStats.retainedBytes -= src.zip.length;
  src.zip = null;
  if (lastInflated && lastInflated.src === src) lastInflated = null;
}

// For PHP's hook before reading a file: false if the node's contents are here, else a promise of true once fetched.
export function fetchLazyNode(node) {
  const src = node.lazyRemote;
  if (!src || src.zip) return false;
  return src.load().then(() => true);
}

function attachIndex(FS, root, index, readOnly) {
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
  attach(FS.lookupPath(root).node, index);
}
