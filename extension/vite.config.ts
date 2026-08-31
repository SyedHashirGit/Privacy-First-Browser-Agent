import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath, URL } from 'node:url';
import manifest from './manifest.json';

// The offscreen document, side panel, and popup are all plain HTML pages
// bundled as extra Rollup inputs. CRXJS handles background/content scripts
// and rewrites the manifest paths to the built output automatically.
export default defineConfig({
  plugins: [
    react(),
    crx({ manifest: manifest as any }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        offscreen: 'offscreen.html',
        sidepanel: 'sidepanel.html',
        popup: 'popup.html',
      },
    },
    target: 'esnext',
    minify: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
