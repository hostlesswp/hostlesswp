#!/usr/bin/env node
// hostlesswp: move a running WordPress site onto Cloudflare Workers.
import { createUI, Abort, p, pc } from '../lib/ui.mjs';
import { migrate } from '../lib/commands/migrate.mjs';
import { check } from '../lib/commands/check.mjs';
import { deployCmd } from '../lib/commands/deploy.mjs';
import { VERSION } from '../lib/pipeline.mjs';
import { HOMEPAGE, COMPAT_URL, ISSUES } from '../lib/links.mjs';
import { CloudflareError } from '../lib/cloudflare.mjs';

const HELP = `
${pc.bold('hostlesswp')} ${VERSION}  Move a running WordPress site onto Cloudflare Workers.

${pc.bold('Usage')}  (run in the folder that contains wp-config.php, on the server or on a copy of the site)
  npx hostlesswp           guided setup: check, connect Cloudflare and your database, deploy
  npx hostlesswp check     read-only compatibility report (nothing is changed anywhere)
  npx hostlesswp deploy    rebuild and redeploy after changing plugins, themes or WordPress
  Answers are saved in hostlesswp-config.php next to wp-config.php, so later runs do not ask again.

${pc.bold('Options')}
  --path <dir>                WordPress folder (default: current folder)
  --name <worker>             Worker name (default: derived from your domain)
  --db-access public|tunnel   how Cloudflare reaches MySQL (default: asked)
  --db-public-host <host>     public address of MySQL when DB_HOST is local and access is public
  --region <aws-region>|none  where the Worker runs (default: next to your database)
  --account <id>              Cloudflare account id (when you have several)
  --db-host, --db-port, --db-user, --db-password, --db-name
                              override values from wp-config.php
  --s3-endpoint <url>         S3-compatible storage for the media library (R2, AWS S3, B2, MinIO...)
  --s3-region <region>        bucket region (R2: auto)
  --s3-bucket <name>          bucket for wp-content/uploads
  --s3-prefix <path>          key prefix inside the bucket (default: none)
  --s3-public-url <url>       public or CDN address of the bucket (default: media is served through the Worker)
                              keys: HOSTLESSWP_S3_ACCESS_KEY_ID, HOSTLESSWP_S3_SECRET_ACCESS_KEY
  --smtp-url <url>|none       SMTP server for email: smtps://user:pass@host:465 or smtp://...:587 (default: asked)
                              or HOSTLESSWP_SMTP_URL
  --resync-uploads            overwrite media in the bucket that differs from this server (size or checksum)
  --no-precompile             skip precompiling PHP (faster deploy, slower cold starts)
  --no-page-cache             serve every page view through PHP (no page cache)
  --allow-free=false          stop instead of deploying when the account is on the Workers Free plan
  --recheck-plan              after upgrading to Workers Paid, deploy with the paid settings again
  --yes                       accept defaults, never prompt (for scripts and CI)
  --json                      with check: also print the report as JSON
  -h, --help / -v, --version

${pc.bold('Docs')}  ${HOMEPAGE}
${pc.bold('Compatibility')}  ${COMPAT_URL}
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '-v' || a === '--version') flags.version = true;
    else if (a.startsWith('--no-')) flags[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      // Split at the first "=" only: values (URLs, passwords) may contain more.
      const eq = a.indexOf('=');
      const [k, v] = eq < 0 ? [a.slice(2), undefined] : [a.slice(2, eq), a.slice(eq + 1)];
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { command: positional[0] || 'migrate', flags };
}

const { command, flags } = parseArgs(process.argv.slice(2));
if (flags.version) {
  console.log(VERSION);
  process.exit(0);
}
if (flags.help || command === 'help') {
  console.log(HELP);
  process.exit(0);
}
const commands = { migrate, check, deploy: deployCmd };
if (!commands[command]) {
  console.error(`Unknown command: ${command}\n${HELP}`);
  process.exit(2);
}
const ui = createUI(flags);
try {
  await commands[command](ui, flags);
} catch (e) {
  // Expected problems (cancel, missing plan or permission, bad input) are explained, not reported as bugs.
  if (e instanceof Abort || e instanceof CloudflareError) {
    if (e.message !== 'cancelled') p.log.error(e.message);
    process.exitCode = 1;
  } else {
    p.log.error(e && e.message ? e.message : String(e));
    if (process.env.HOSTLESSWP_DEBUG) console.error(e);
    p.log.message(pc.dim(`Report it at ${ISSUES} (set HOSTLESSWP_DEBUG=1 for the full trace).`));
    process.exitCode = 1;
  }
}
