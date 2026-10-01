import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.TEAMBOT_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  // es2022: noVNC uses top-level await.
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, ws: true, changeOrigin: true },
    },
  },
});
