import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

/** Link previews (og:image and friends) need the site's full address. Vercel's build sets VERCEL_PROJECT_PRODUCTION_URL to the
 *  production domain, so the address never has to be written into the repository. A build without it (local builds, tests)
 *  drops the tags that would otherwise hold the placeholder. */
export function siteOrigin(host: string | undefined = process.env['VERCEL_PROJECT_PRODUCTION_URL']): Plugin {
  return {
    name: 'site-origin',
    transformIndexHtml(html: string): string {
      const clean = (host ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (/^[a-z0-9.-]+(:\d+)?$/i.test(clean)) return html.split('__SITE_ORIGIN__').join(`https://${clean}`);
      return html.replace(/\n[ \t]*<meta [^>]*__SITE_ORIGIN__[^>]*>/g, '');
    },
  };
}

// Relative base: the built site works from any path (Vercel root, GitHub Pages, a sub-folder).
export default defineConfig({
  base: './',
  plugins: [siteOrigin()],
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
