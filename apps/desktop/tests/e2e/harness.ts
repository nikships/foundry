/**
 * Launch the built Electron app against an isolated user-data dir.
 *
 * Playwright drives the window over CDP — the same channel the foundry-ui
 * skill uses via `--remote-debugging-port` + agent-browser. Do not point a
 * spec at the developer's `~/Library/Application Support/foundry/`.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

export function electronExecutable(): string {
  const resolved = require('electron') as unknown;
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new Error(
      'The electron package did not resolve to an executable path. Run `node node_modules/electron/install.js`.',
    );
  }
  return resolved;
}

export function assertBuiltApp(): void {
  const mainJs = join(repoRoot, 'out/main/main.js');
  if (!existsSync(mainJs)) {
    throw new Error(
      `Missing ${mainJs}. The Electron UI smoke harness drives the built app, not \`npm run dev\`.\n` +
        'Run `npm run build` first, then `npm run test:e2e`.',
    );
  }
}

export async function launchFoundry(userDataDir: string): Promise<{
  app: ElectronApplication;
  window: Page;
}> {
  assertBuiltApp();
  const app = await electron.launch({
    executablePath: electronExecutable(),
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: {
      ...process.env,
      // A leftover electron-vite session must not pull the window onto HMR.
      ELECTRON_RENDERER_URL: '',
    },
    timeout: 30_000,
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}
