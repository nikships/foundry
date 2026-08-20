/* Temporary onboarding preview harness. Not part of the app; delete when done. */
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(import.meta.dirname, 'apps/desktop/src/renderer/__preview__'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'apps/desktop/src/shared'),
      '@main': resolve(import.meta.dirname, 'apps/desktop/src/main'),
      '@renderer': resolve(import.meta.dirname, 'apps/desktop/src/renderer'),
    },
  },
  server: { port: 5199, strictPort: true },
});
