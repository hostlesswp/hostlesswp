// Prompt layer over @clack/prompts. Every question can also be answered by a command-line flag or by the site's saved answers (hostlesswp-config.php), so the same flow runs non-interactively (CI, scripts, or `--yes`), and a missing answer in that mode is an error, not a hang.
import * as p from '@clack/prompts';
import pc from 'picocolors';

export { p, pc };

export class Abort extends Error {}

// Animated spinner in a terminal; plain step lines when output is piped or logged (no redraw noise).
export function spinner() {
  if (process.stdout.isTTY) {
    const s = p.spinner();
    return { start: (m) => s.start(m), message: (m) => s.message(m), stop: (m, code = 0) => (code ? s.error(m) : s.stop(m)) };
  }
  return {
    start: (msg) => p.log.step(msg),
    message: () => {},
    stop: (msg, code = 0) => (code ? p.log.error(msg) : p.log.success(msg)),
  };
}

export function createUI(flags) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !flags.yes;
  // The site's saved answers (hostlesswp-config.php), attached once the WordPress folder is known.
  let config = null;
  const guard = (v) => {
    if (p.isCancel(v)) {
      p.cancel('Cancelled. Nothing was changed on Cloudflare after the last completed step.');
      throw new Abort('cancelled');
    }
    return v;
  };
  const need = (name, message, hint) => {
    throw new Abort(`${message}\n${hint ? `Set ${hint}` : `Pass it with --${name}`} (running non-interactively).`);
  };
  // A command-line flag wins over a saved answer; both skip the question.
  const known = (flag, remember) => {
    if (flag && flags[flag] !== undefined) return { value: flags[flag] };
    if (remember && config && config.has(remember)) return { value: config.get(remember) };
    return null;
  };
  const keep = (remember, value) => {
    if (remember && config && config.get(remember) !== value) config.set(remember, value);
    return value;
  };
  return {
    interactive,
    get config() {
      return config;
    },
    useConfig(c) {
      config = c;
    },
    async text({ flag, remember, message, initial, placeholder, validate }) {
      const k = known(flag, remember);
      if (k) return keep(remember, String(k.value));
      if (!interactive) return initial !== undefined ? keep(remember, initial) : need(flag, message);
      return keep(remember, guard(await p.text({ message, initialValue: initial, placeholder, validate })) ?? '');
    },
    async password({ flag, remember, hint, message }) {
      const k = known(flag, remember);
      if (k) return keep(remember, String(k.value));
      if (!interactive) return need(flag, message, hint);
      return keep(remember, guard(await p.password({ message })));
    },
    async select({ flag, remember, message, options, initial }) {
      if (flag && flags[flag] !== undefined) {
        const v = String(flags[flag]);
        if (!options.some((o) => o.value === v)) throw new Abort(`--${flag} must be one of: ${options.map((o) => o.value).join(', ')}`);
        return keep(remember, v);
      }
      // A saved answer that is no longer offered (an account removed, say) is asked again.
      if (remember && config && options.some((o) => o.value === config.get(remember))) return config.get(remember);
      if (!interactive) return initial !== undefined ? keep(remember, initial) : need(flag, message);
      return keep(remember, guard(await p.select({ message, options, initialValue: initial })));
    },
    async confirm({ flag, remember, message, initial = true }) {
      if (flag && flags[flag] !== undefined) return keep(remember, flags[flag] !== 'false' && flags[flag] !== false);
      if (remember && config && typeof config.get(remember) === 'boolean') return config.get(remember);
      if (!interactive) return keep(remember, flags.yes ? true : initial);
      return keep(remember, guard(await p.confirm({ message, initialValue: initial })));
    },
    // Waits for the user to do something outside the terminal (e.g. click in the dashboard).
    async pause(message) {
      if (!interactive) return;
      guard(await p.confirm({ message, active: 'Done, continue', inactive: 'Stop here' })) || (() => { throw new Abort('stopped'); })();
    },
  };
}
