import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
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
  },
});
