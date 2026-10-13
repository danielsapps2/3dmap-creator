import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { engineLibrary } from './server/engine.js';

// The playtest lists rigged characters from a running tinyimgen server. Proxying it under /tinyimgen keeps it
// same-origin (no CORS changes needed in tinyimgen). Override the address with TINYIMGEN_URL.
const tinyimgen = {
  '/tinyimgen': {
    target: process.env.TINYIMGEN_URL ?? 'http://127.0.0.1:7860',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/tinyimgen/, ''),
  },
};

export default defineConfig({
  // The engine's shared models and animation clips (engine/), used by every project. Override the folder with ENGINE_DIR.
  plugins: [engineLibrary(process.env.ENGINE_DIR ?? fileURLToPath(new URL('./engine', import.meta.url)))],
  server: { open: true, proxy: tinyimgen, watch: { ignored: ['**/engine/**'] } },
  preview: { proxy: tinyimgen },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        editor: fileURLToPath(new URL('./index.html', import.meta.url)),
        game: fileURLToPath(new URL('./game.html', import.meta.url)),
      },
    },
  },
});
