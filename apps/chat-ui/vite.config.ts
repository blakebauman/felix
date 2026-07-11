import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Local-dev config. `vite dev` serves the SPA on :5173 and proxies every
 * `/api/*` call to a locally-running Felix (`pnpm dev` → :8787), stripping the
 * `/api` prefix. This mirrors what the proxy Worker (worker/index.ts) does in
 * production, so the front-end code is identical in both environments.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
