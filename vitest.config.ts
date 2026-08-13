import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
      '@renderer': resolve(import.meta.dirname, 'src/renderer'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
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
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts', 'src/cli/**/*.ts'],
      exclude: [
        // React UI: not reachable from `environment: 'node'` suites. UI
        // verification is `npm run test:e2e` (Playwright + Electron), not this gate.
        'src/renderer/**',
        // Sandboxed CJS bridge; only meaningful inside a live Electron preload.
        'src/preload/**',
        // Electron app bootstrap: creates BrowserWindows and wires the app
        // lifecycle, so it only executes in a packaged/dev Electron process.
        'src/main/main.ts',
        // Type-only modules contribute no statements to instrument.
        '**/*.d.ts',
      ],
      // `all` keeps unreferenced files in the denominator, so deleting a test
      // or adding an untested module lowers the number instead of hiding.
      all: true,
      // A ratchet floor, not an aspiration. Measured on the scope above at
      // 64.45% statements / 56.76% branches / 63.62% functions / 67.71% lines
      // (48 suites, 699 tests). Each floor sits a few points under its
      // measurement: enough slack that an ordinary refactor does not trip the
      // gate, tight enough that dropping a suite or landing a sizeable untested
      // module does. Raise these as coverage climbs; do not lower them to make
      // a red run green.
      //
      // Note the scope is deliberately unflattering — it includes the thin IPC
      // routers and app wiring that pull the average down, rather than excluding
      // them to inflate the figure.
      thresholds: {
        statements: 62,
        branches: 54,
        functions: 61,
        lines: 65,
      },
    },
  },
});
