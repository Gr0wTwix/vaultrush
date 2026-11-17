import { defineConfig } from 'vitest/config';

// Relative base: the built site works from any path (Vercel root, GitHub Pages, a sub-folder).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 600,
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173 },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
  },
});
