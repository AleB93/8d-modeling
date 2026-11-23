/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig(({ command }) => ({
  // Relative asset paths in builds: the app works from any subpath (GitHub Pages serves it at /<repo>/)
  base: command === 'build' ? './' : '/',
  plugins: [solid()],
  // IPv4 loopback: reachable as localhost from every browser, never exposed to the network
  // PORT is set per worktree by Hunkpad (basePort + worktree number)
  server: { host: '127.0.0.1', port: Number(process.env.PORT) || 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 700 }, // three.js chunk is lazy-loaded
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // The *.hunt.test.ts files run hundreds of random scenes per test, and CI runners with coverage are
    // several times slower than a laptop: the 5s default made deploys fail on correct code.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // Every logic module (.ts) must stay at 100%. Rendering and UI get smoke tests instead:
      // Solid components (.tsx), the 2D canvas editor and the WebGL viewer.
      include: ['src/shared/**/*.ts', 'src/features/**/*.ts'],
      exclude: ['**/*.test.*', 'src/test/**', 'src/features/design/DesignCanvas.ts', 'src/features/play3d/Viewer3D.ts'],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
}));
