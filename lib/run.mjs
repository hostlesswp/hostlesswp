// Child-process helpers. Wrangler is a dependency of hostlesswp, so it is always run from our own node_modules.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Finds an installed package's folder by walking up node_modules (npx hoists dependencies next to hostlesswp,
// and wrangler's package exports do not expose its bin path to require.resolve).
export function packageDir(name) {
  for (let dir = PKG_ROOT; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`${name} is not installed next to hostlesswp`);
  }
}
export const WRANGLER = path.join(packageDir('wrangler'), 'bin', 'wrangler.js');

// Runs a command and resolves { code, stdout, stderr }. input: string written to stdin.
// inherit: true hands the terminal to the child (used for `wrangler login`).
export function run(cmd, args, { input, inherit = false, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (!inherit) {
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.stdin.end(input ?? '');
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export function wrangler(args, opts = {}) {
  // Wrangler prompts are not answerable here; fail instead of hanging, and keep its output plain.
  return run(process.execPath, [WRANGLER, ...args], { ...opts, env: { CI: opts.inherit ? '' : '1', WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0', ...opts.env } });
}

// Strips ANSI colors and box drawing so wrangler output can be shown or matched.
export function plain(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

// Last meaningful error line(s) of a wrangler run, for error messages.
export function wranglerError(res) {
  const text = plain(res.stderr + '\n' + res.stdout);
  const err = text.split('\n').filter((l) => /ERROR|✘|error/i.test(l) || /^\s{2}\S/.test(l)).slice(0, 8).join('\n').trim();
  return err || text.trim().split('\n').slice(-8).join('\n');
}
