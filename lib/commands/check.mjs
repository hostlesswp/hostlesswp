// `npx hostlesswp check`: read-only compatibility report. Touches nothing on Cloudflare.
import { p, pc } from '../ui.mjs';
import { inspectSite, reportSite } from '../site-context.mjs';
import { VERSION } from '../pipeline.mjs';
import { COMPAT_URL } from '../links.mjs';

export async function check(ui, flags) {
  p.intro(`${pc.bgCyan(pc.black(' hostlesswp check '))} ${pc.dim('v' + VERSION)}  Read-only compatibility check`);
  const site = await inspectSite(ui, flags, { saveAnswers: false, reportOnly: true });
  const plugins = reportSite(site);
  const counts = { works: 0, 'works-with-limits': 0, untested: 0 };
  for (const x of plugins) counts[x.status]++;
  const sslLine = site.info.ssl ? pc.green('SSL is enabled on MySQL') : pc.yellow('SSL is disabled on MySQL: Cloudflare Hyperdrive needs it (hostlesswp explains how to enable it)');
  p.note(
    [
      `${pc.green('✔')} ${counts.works} tested and working   ${pc.yellow('▲')} ${counts['works-with-limits']} working with limits   ${pc.dim('?')} ${counts.untested} not tested yet`,
      sslLine,
      ...(site.uploadProblem ? [pc.red(`Media folder: ${site.uploadProblem}`)] : []),
      '',
      `Full list: ${COMPAT_URL}`,
    ].join('\n'),
    'Summary',
  );
  if (site.uploadProblem) p.outro(`Fix the media folder first, then run ${pc.cyan('npx hostlesswp')} from this folder. Your current site is not changed.`);
  else p.outro(`Ready to try it? Run ${pc.cyan('npx hostlesswp')} from this folder. Your current site is not changed.`);
  if (flags.json) console.log(JSON.stringify({ site: { wordpress: site.wpVersion, theme: site.info.stylesheet, ssl: site.info.ssl }, plugins }, null, 1));
}
