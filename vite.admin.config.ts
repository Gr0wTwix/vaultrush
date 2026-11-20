import { defineConfig } from 'vite';

// The separate admin site. Same repository and database as the game, its own page, its own build and its own address.
//   npm run dev:admin     http://localhost:5174
//   npm run build:admin   -> dist-admin/   (deploy this folder as its own site)
// It reads the same .env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_STEAM_LOGIN). Never put a service key here.
export default defineConfig({
  root: 'admin',
  envDir: '..',
  base: './',
  build: { outDir: '../dist-admin', emptyOutDir: true, target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 600 },
  server: { port: 5174, strictPort: true, fs: { allow: ['..'] } },
  preview: { port: 4174 },
});
