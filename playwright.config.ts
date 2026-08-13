import { defineConfig } from '@playwright/test';

/**
 * Electron UI smoke. These specs launch the built app (`out/main/main.js`)
 * with an isolated `--user-data-dir`. They are not part of `npm run check`:
 * they need a macOS window server and would flake a headless gate.
 *
 *   npm run build && npm run test:e2e
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
