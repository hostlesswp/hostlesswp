// Answers given during setup, saved next to wp-config.php so later runs (deploy, a rerun of the setup) do not ask
// again. The file is PHP that exits on its first line: if the current web server is asked for it, PHP runs it and
// returns nothing, where a .json file would be served as-is. It holds passwords and keys, so it is kept at 0600.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Abort } from './ui.mjs';

export const CONFIG_FILE = 'hostlesswp-config.php';
const GUARD = '<?php exit; ?>';

export function readSiteConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  const nl = raw.indexOf('\n');
  if ((nl < 0 ? raw : raw.slice(0, nl)).trim() !== GUARD) throw new Abort(`${file} does not start with ${GUARD}; refusing to use it. Fix or delete it.`);
  const body = raw.slice(nl + 1).trim();
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Abort(`${file} is not valid JSON after its first line (${e.message}). Fix or delete it.`);
  }
}

// Written to a new 0600 file in the same folder and renamed over the target: never half-written, never readable
// by others even briefly.
export function writeSiteConfig(root, data) {
  const file = path.join(root, CONFIG_FILE);
  const tmp = path.join(root, `.${CONFIG_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, GUARD + '\n' + JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    // mode is subject to the umask, which can only remove bits; make it exact.
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      throw new Abort(`Cannot write ${file}: hostlesswp saves your answers next to wp-config.php. Run it as a user that can write there.`);
    }
    throw e;
  }
}

const getPath = (obj, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  let o = obj;
  for (const k of parts) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
  if (value === undefined) delete o[last];
  else o[last] = value;
}

// Every set() is written immediately, so an interrupted setup keeps what was already answered.
// readOnly (used by `check`, which promises to change nothing): changes stay in memory.
export function openSiteConfig(root, { readOnly = false } = {}) {
  const data = readSiteConfig(root);
  return {
    root,
    data,
    get: (key) => getPath(data, key),
    has: (key) => getPath(data, key) !== undefined,
    set(key, value) {
      setPath(data, key, value);
      if (!readOnly) writeSiteConfig(root, { version: 1, ...data });
    },
  };
}
