import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

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
  server: { open: true, proxy: tinyimgen },
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
