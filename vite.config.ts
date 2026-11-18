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
    // Tests always run without a backend, whatever is in the developer's local .env.
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '', VITE_STEAM_LOGIN: '' },
  },
});
