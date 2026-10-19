// Matches a site's active plugins and drop-ins against the tested compatibility list (data/compat.json).
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT } from './run.mjs';

export function loadCompat() {
  return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'data', 'compat.json'), 'utf8'));
}

// Drop-ins in wp-content that hostlesswp replaces or leaves out, with the reason shown to the user.
export const DROPINS = {
  'db.php': 'replaced by the hostlesswp database bridge (a custom db.php drop-in from another plugin is not used)',
  'object-cache.php': 'left out: a Redis/Memcached server is not reachable from Workers; WordPress uses its built-in cache',
  'advanced-cache.php': 'left out: page caches that write to disk do not persist on Workers',
};

export function assessPlugins(slugs) {
  const compat = loadCompat();
  const bySlug = new Map(compat.plugins.map((p) => [p.slug, p]));
  return slugs.map((slug) => {
    const c = bySlug.get(slug);
    if (!c) return { slug, status: 'untested', name: slug };
    return { slug, status: c.status, name: c.name, note: c.note, flow: c.flow };
  });
}

export function presentDropins(root) {
  return Object.keys(DROPINS).filter((f) => fs.existsSync(path.join(root, 'wp-content', f)));
}
