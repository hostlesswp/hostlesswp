# Contributing

Thanks for helping. The most useful contributions right now:

1. **Compatibility results.** Ran hostlesswp on a site with a plugin that is not on the list? Open an issue or pull request with the plugin, its version, what you tested (activation, front page, admin pages, its main feature) and what happened. Add it to `data/compat.json` in the same shape as the existing entries.
2. **Bug reports.** Include the command you ran, the hostlesswp version, your Node.js version, the error output with `HOSTLESSWP_DEBUG=1`, and for runtime errors the output of `npx wrangler tail <name>` while loading the failing page. Never paste database passwords or the contents of `wp-config.php`.
3. **Code.** Keep WordPress core untouched: fixes belong in `runtime/` (Worker and PHP adapters) or `lib/` (the CLI). Run `npm test` before sending a pull request.

By contributing you agree that your contributions are licensed under GPL-2.0-or-later.
