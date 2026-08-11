import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@main': resolve(import.meta.dirname, 'src/main'),
  '@renderer': resolve(import.meta.dirname, 'src/renderer'),
};

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      // The Smith helper binary builds alongside main so droid can invoke it as
      // `$FOUNDRY_CLI` from a spawned session. It lands at out/main/foundry-cli.js.
      lib: {
        entry: {
          main: resolve(import.meta.dirname, 'src/main/main.ts'),
          'foundry-cli': resolve(import.meta.dirname, 'src/cli/foundry-cli.ts'),
        },
      },
      rollupOptions: { output: { format: 'es' } },
      // electron-vite leaves main unminified by default. The main bundle is
      // plain app code (native deps are externalized), so esbuild minify is
      // safe and meaningfully shrinks the shipped file.
      minify: 'esbuild',
    },
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(import.meta.dirname, 'src/preload/bridge.ts') },
      // Sandboxed preload scripts cannot be ES modules.
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'bridge.cjs' } },
      minify: 'esbuild',
    },
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
    root: resolve(import.meta.dirname, 'src/renderer'),
    css: {
      modules: {
        // `.phase-edge` → `styles.phaseEdge`, so className refs stay clean.
        localsConvention: 'camelCase',
      },
    },
    build: {
      minify: 'esbuild',
      chunkSizeWarningLimit: 1000,
      rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') },
      // electron-vite maps `rolldownOptions` onto `rollupOptions` after merge,
      // so chunking must live here to survive the preset (a bare `rollupOptions`
      // would be overwritten by the preset's discovered input).
      rolldownOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (id.includes('react-dom') || id.includes('/scheduler/')) return 'react-vendor';
            if (id.includes('/react/')) return 'react-vendor';
            if (id.includes('@dnd-kit')) return 'dnd';
            if (id.includes('lucide-react') || id.includes('@lobehub/icons')) return 'icons';
          },
        },
      },
    },
  },
});
