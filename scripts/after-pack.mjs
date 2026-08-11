/**
 * electron-builder `afterPack` hook.
 *
 * `out/main/foundry-cli.js` is asarUnpack'd (see electron-builder.yml)
 * because droid execs it directly as `$FOUNDRY_CLI`, and nothing inside an
 * asar archive can be exec'd by an external process. Unpacking preserves the
 * file's permission bits from `out/`, where electron-vite's bundler does not
 * mark it executable despite its `#!/usr/bin/env node` shebang — restore the
 * bit here so a packaged app can actually invoke it.
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
export default async function afterPack(context) {
  const { chmodSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  const cliPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'out',
    'main',
    'foundry-cli.js',
  );

  if (!existsSync(cliPath)) {
    throw new Error(`afterPack: expected unpacked helper CLI at ${cliPath}`);
  }
  chmodSync(cliPath, 0o755);
}
