import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'apps/desktop/src/shared'),
      '@main': resolve(import.meta.dirname, 'apps/desktop/src/main'),
      '@renderer': resolve(import.meta.dirname, 'apps/desktop/src/renderer'),
    },
  },
  test: {
    include: ['apps/desktop/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
    // Sweeps the scratch directories handed out by `apps/desktop/tests/helpers/tmp.ts`.
    // Suites build real git repos on disk, and an abandoned repo also strands a
    // `git fsmonitor--daemon` for anyone with `core.fsmonitor` enabled.
    setupFiles: ['apps/desktop/tests/helpers/setup-tmp.ts'],
    server: {
      // @lobehub/icons ships bare directory specifiers, which the bundler
      // resolves and node's ESM loader refuses. Inlining hands them to vite,
      // so the icon registry is testable without a browser environment.
      deps: { inline: [/@lobehub\/icons/] },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'html'],
      reportsDirectory: 'coverage',
      // Scope: the privileged, headless core. These are the modules a coding
      // agent can break silently and that Vitest can actually execute in `node`.
      include: [
        'apps/desktop/src/main/**/*.ts',
        'apps/desktop/src/shared/**/*.ts',
        'apps/desktop/src/cli/**/*.ts',
      ],
      exclude: [
        // React UI: not reachable from `environment: 'node'` suites. UI
        // verification is `npm run test:e2e` (Playwright + Electron), not this gate.
        'apps/desktop/src/renderer/**',
        // Sandboxed CJS bridge; only meaningful inside a live Electron preload.
        'apps/desktop/src/preload/**',
        // Electron app bootstrap: creates BrowserWindows and wires the app
        // lifecycle, so it only executes in a packaged/dev Electron process.
        'apps/desktop/src/main/main.ts',
        // Type-only modules contribute no statements to instrument.
        '**/*.d.ts',
      ],
      // `all` keeps unreferenced files in the denominator, so deleting a test
      // or adding an untested module lowers the number instead of hiding.
      all: true,
      thresholds: {
        statements: 62,
        branches: 54,
        functions: 61,
        lines: 65,
      },
    },
  },
});
