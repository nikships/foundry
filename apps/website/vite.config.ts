import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Standalone marketing site. Emits a plain static bundle into website/dist —
// nothing here is wired into the desktop app's electron-vite build.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
