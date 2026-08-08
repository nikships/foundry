import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer'),
};

function copyDir(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

function assetsPlugin(): Plugin {
  return {
    name: 'foundry-web-assets',
    closeBundle() {
      const outAssets = resolve(__dirname, 'out/web/assets');
      copyDir(resolve(__dirname, 'assets'), outAssets);
    },
    configureServer(server) {
      const assetsRoot = resolve(__dirname, 'assets');
      server.middlewares.use((req, _res, next) => {
        // Map /assets/* to the real assets/ dir in dev so useBrandedAsset's
        // `/assets/scenes/...` URLs resolve without Electron's assetUrl.
        if (req.url?.startsWith('/assets/')) {
          const rel = req.url.replace(/^\/assets\//, '').split('?')[0] ?? '';
          req.url = `/@fs/${join(assetsRoot, rel ?? '')}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: { alias },
  plugins: [react(), assetsPlugin()],
  server: {
    port: 5174,
    host: 'localhost',
    open: true,
  },
  preview: {
    port: 4174,
    host: 'localhost',
    open: true,
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
    },
  },
});
