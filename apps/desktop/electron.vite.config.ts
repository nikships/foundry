import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer'),
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
          main: resolve(__dirname, 'src/main/main.ts'),
          'foundry-cli': resolve(__dirname, 'src/cli/foundry-cli.ts'),
        },
      },
      rollupOptions: { output: { format: 'es' } },
    },
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'src/preload/bridge.ts') },
      // Sandboxed preload scripts cannot be ES modules.
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'bridge.cjs' } },
    },
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
    root: resolve(__dirname, 'src/renderer'),
    css: {
      modules: {
        // `.phase-edge` → `styles.phaseEdge`, so className refs stay clean.
        localsConvention: 'camelCase',
      },
    },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
