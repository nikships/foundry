/**
 * Build config for the Pipelines redesign review surface.
 *
 * Separate from `vite.web.config.ts` so the showcase can never be mistaken for
 * the app: different root, different output, its own seeded backend. Nothing
 * here is packaged by electron-builder.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer'),
};

export default defineConfig({
  root: resolve(__dirname, 'src/renderer/showcase'),
  resolve: { alias },
  css: {
    modules: {
      // Match electron.vite.config.ts: `.stage-head` → `styles.stageHead`.
      localsConvention: 'camelCase',
    },
  },
  plugins: [react()],
  server: { port: 5175, host: 'localhost' },
  preview: { port: 4175, host: 'localhost' },
  build: {
    outDir: resolve(__dirname, 'out/showcase'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'src/renderer/showcase/index.html') },
  },
});
