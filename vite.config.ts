import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  // IPv4 loopback: reachable as localhost from every browser, never exposed to the network
  // PORT is set per worktree by Hunkpad (basePort + worktree number)
  server: { host: '127.0.0.1', port: Number(process.env.PORT) || 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 700 }, // three.js chunk is lazy-loaded
});
