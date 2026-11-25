// @vitest-environment node
// The brand kit (2026-11-25): logo, V mark, menu icons, favicons, app manifest and link previews.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { siteOrigin } from '../vite.config.js';

const root = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');
const html = read('index.html');
const run = (host?: string): string => (siteOrigin(host).transformIndexHtml as (h: string) => string)(html);

describe('files the page points to', () => {
  it('exist in public/', () => {
    const refs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)" href="([^"]+)"/g)].map(m => m[1]!);
    expect(refs).toEqual(['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'site.webmanifest']);
    for (const f of [...refs, 'brand/logo-dark.svg', 'brand/wordmark-dark.svg', 'brand/mark.svg', 'brand/social-card.jpg', 'icon-192.png', 'icon-512.png']) expect(existsSync(resolve(root, 'public', f)), f).toBe(true);
  });
  it('the logos are plain shapes: no script, no event handler, no outside link', () => {
    for (const f of ['public/favicon.svg', 'public/brand/logo-dark.svg', 'public/brand/wordmark-dark.svg', 'public/brand/mark.svg']) {
      const svg = read(f);
      expect(svg).not.toMatch(/<script|\son\w+=|href=|<foreignObject|<image/i);
    }
  });
  it('the app manifest uses the site colours and plain (not maskable) icons, whose wings would be cut off', () => {
    const m = JSON.parse(read('public/site.webmanifest')) as { name: string; theme_color: string; background_color: string; icons: { src: string; purpose: string }[] };
    expect(m.name).toBe('Vaultrush');
    expect(m.theme_color).toBe('#090d15');
    expect(m.background_color).toBe('#090d15');
    for (const i of m.icons) { expect(i.purpose).toBe('any'); expect(existsSync(resolve(root, 'public', i.src))).toBe(true); }
    expect(html).toMatch(/<meta name="theme-color" content="#090d15">/);
  });
});

describe('link previews', () => {
  it('get the full address from the build host, and the repository never holds one', () => {
    expect(html).not.toMatch(/vercel\.app/);
    const out = run('vaultrush.example');
    expect(out).toContain('<meta property="og:image" content="https://vaultrush.example/brand/social-card.jpg">');
    expect(out).toContain('<meta name="twitter:image" content="https://vaultrush.example/brand/social-card.jpg">');
    expect(out).not.toContain('__SITE_ORIGIN__');
  });
  it('drop only the tags that need an address when the build has none', () => {
    const out = run(undefined);
    expect(out).not.toContain('__SITE_ORIGIN__');
    expect(out).not.toMatch(/og:image" |og:url|twitter:image/);
    expect(out).toContain('og:title');
    expect(out).toContain('twitter:card');
  });
  it('ignore a host value that is not a plain domain', () => {
    const out = run('x.example"><script>alert(1)</script>');
    expect(out).not.toContain('<script>alert');
    expect(out).not.toContain('__SITE_ORIGIN__');
  });
});

describe('logo and menu icons in the page', () => {
  const app = read('src/app.ts');
  it('the sidebar and phone header show the new logo inside a named home link', () => {
    expect(app).toMatch(/<a class="logo" href="#\/" aria-label="Vaultrush home"><img class="logo-img" src="brand\/logo-dark.svg" alt=""/);
    expect(app).toMatch(/<a class="logo logo-mobile" href="#\/" aria-label="Vaultrush home"><img src="brand\/mark.svg" alt=""/);
    expect(read('src/auth.ts')).toMatch(/<div class="au-brand"><img src="brand\/logo-dark.svg" alt="Vaultrush"/);
    expect(read('src/site.ts')).toMatch(/class="site-block-logo" src="brand\/logo-dark.svg" alt="Vaultrush"/);
  });
  it('every menu entry has its own icon, and coin and trophy keep their other meaning', () => {
    const nav = [...app.matchAll(/\['#\/[^']*', '(\w+)', '[^']+'\]/g)].map(m => m[1]!);
    expect(nav).toEqual(['home', 'cases', 'battles', 'upgrade', 'crash', 'double', 'plinko', 'mines', 'coinflip', 'gift', 'race', 'fair']);
    const block = read('src/ui.ts').split('export const ICONS = {')[1]!.split('\n};')[0]!;
    const icons = Object.fromEntries([...block.matchAll(/^ {2}(\w+): '(.*)',\r?$/gm)].map(m => [m[1]!, m[2]!])) as Record<string, string>;
    for (const k of nav) expect(icons[k], k).toBeTruthy();
    expect(new Set(nav.map(k => icons[k])).size).toBe(nav.length);
    expect(icons['coin']).toBeTruthy(); expect(icons['trophy']).toBeTruthy();
  });
  it('the loading screen shows the V mark once, in the dial, and the wordmark without its own V', () => {
    expect(html).toContain('M2 9 20 14 28 28 23 26 32 39 42 24 37 27 46 12 63 6 33 58 30 58Z');
    expect(html).toMatch(/<img class="splash-word" src="brand\/wordmark-dark.svg"/);
    expect(read('public/brand/wordmark-dark.svg')).not.toContain('M2 9 20 14');
  });
});
