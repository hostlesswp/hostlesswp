// `npx hostlesswp deploy`: rebuild from the site on disk and redeploy (after plugin, theme or core changes).
import { p, pc, Abort } from '../ui.mjs';
import { inspectSite, reportSite } from '../site-context.mjs';
import { buildAndDeploy, listStates, loadState, withInputs, VERSION } from '../pipeline.mjs';
import { ensureMediaStorage } from '../media-storage.mjs';
import { ensureMail } from '../mail-setup.mjs';
import { isWordPressRoot } from '../wpsite.mjs';
import { openSiteConfig } from '../config.mjs';
import path from 'node:path';

export async function deployCmd(ui, flags) {
  p.intro(`${pc.bgCyan(pc.black(' hostlesswp deploy '))} ${pc.dim('v' + VERSION)}`);
  const root = path.resolve(flags.path || process.cwd());
  const name = flags.name || (isWordPressRoot(root) ? openSiteConfig(root, { readOnly: true }).get('name') : undefined);
  let state = name ? loadState(name) : null;
  if (!state) {
    const matches = listStates().filter((s) => s.root === root);
    if (matches.length === 1) state = matches[0];
    else if (matches.length > 1) state = loadState(await ui.select({ flag: 'name', message: 'Which Worker?', options: matches.map((m) => ({ value: m.name, label: m.name, hint: m.url })) }));
  }
  if (!state || !state.hyperdriveId) throw new Abort('No hostlesswp setup found for this site. Run `npx hostlesswp` first (or pass --name).');
  p.log.info(`Updating ${pc.bold(state.name)} from ${state.root}`);
  const site = await inspectSite(ui, { ...flags, path: state.root });
  if (!ui.config.has('name')) ui.config.set('name', state.name);
  withInputs(state, ui.config);
  if (state.accountId === undefined || !ui.config.has('region')) {
    throw new Abort('Setup answers are missing (hostlesswp-config.php was removed?). Run `npx hostlesswp` again in this folder; it reuses the existing Cloudflare resources.');
  }
  reportSite(site);
  await ensureMediaStorage(ui, flags);
  await ensureMail(ui, flags, site);
  const result = await buildAndDeploy(ui, flags, site, state);
  p.outro(result.ok ? `Updated: ${state.url}` : `Deployed, but the check failed. Logs: npx wrangler tail ${state.name}`);
  if (!result.ok) process.exitCode = 1;
}
