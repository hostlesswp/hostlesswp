// Copies the site's wp-content/uploads into the S3 bucket at every deploy, so the bucket is the one place media
// lives. Only missing files are sent; a bucket object of a different size is left alone (an upload made on the
// Worker may share its name) unless --resync-uploads asks to overwrite it. Nothing is ever deleted there: after
// the move, uploads made on the Worker exist only in the bucket.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createS3, isServableUpload, contentTypeFor } from '../runtime/src/s3.js';
import { walk } from './build.mjs';

// Files are read whole and sent in one PUT (no multipart); Node cannot read a 2 GiB file whole, so those are left out.
export const MAX_SYNC_BYTES = 2 * 1024 ** 3;
// Files up to this size upload in parallel; larger ones go one at a time so at most one is held in memory.
export const SMALL_SYNC_BYTES = 16 * 1024 ** 2;

// changed: size differs from the bucket copy; uploaded only with resync.
// resync: same-size files are compared by MD5 too (multipart ETags are not MD5s and count as unchanged).
export function planSync(local, remote, { prefix = '', resync = false } = {}) {
  const plan = { upload: [], check: [], changed: [], unchanged: 0, tooLarge: [] };
  for (const f of local) {
    if (!isServableUpload(f.rel)) continue;
    if (f.size >= MAX_SYNC_BYTES) {
      plan.tooLarge.push(f);
      continue;
    }
    const r = remote.get(prefix + f.rel);
    if (!r) plan.upload.push(f);
    else if (r.size !== f.size) (resync ? plan.upload : plan.changed).push(f);
    else if (resync && r.etag && !r.etag.includes('-')) plan.check.push({ ...f, etag: r.etag });
    else plan.unchanged++;
  }
  return plan;
}

async function md5File(file) {
  const hash = crypto.createHash('md5');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function syncUploads({ root, s3, resync = false, concurrency = 8, onProgress = () => {} }) {
  const client = createS3(s3);
  const dir = path.join(root, 'wp-content', 'uploads');
  const local = [...walk(dir)].map((rel) => ({ rel, size: fs.statSync(path.join(dir, rel)).size }));
  const { keys } = await client.list(client.prefix);
  const plan = planSync(local, new Map(keys.map((k) => [k.key, k])), { prefix: client.prefix, resync });
  let unchanged = plan.unchanged;
  for (const f of plan.check) {
    if ((await md5File(path.join(dir, f.rel))) === f.etag) unchanged++;
    else plan.upload.push(f);
  }
  const small = plan.upload.filter((f) => f.size <= SMALL_SYNC_BYTES);
  const large = plan.upload.filter((f) => f.size > SMALL_SYNC_BYTES);
  const total = plan.upload.length;
  let done = 0;
  let bytes = 0;
  const lane = (queue) => async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      await client.put(client.keyFor(f.rel), fs.readFileSync(path.join(dir, f.rel)), contentTypeFor(f.rel));
      bytes += f.size;
      onProgress(++done, total);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, small.length) }, () => lane(small));
  if (large.length) workers.push(lane(large));
  await Promise.all(workers.map((w) => w()));
  return { uploaded: done, unchanged, changed: plan.changed.length, bytes, tooLarge: plan.tooLarge };
}
