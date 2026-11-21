// @vitest-environment node
// The admin site is deployed as its own Vercel project (vercel.admin.json). These tests keep that file honest: it builds the right thing, sends the security
// headers an admin login page needs (no framing, no referrer, no scripts from anywhere else, no search-engine indexing), and the admin code holds no service key.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const cfg = JSON.parse(read('vercel.admin.json')) as { framework: unknown; installCommand: string; buildCommand: string; outputDirectory: string; headers: { source: string; headers: { key: string; value: string }[] }[] };
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
const all = new Map(cfg.headers.find(h => h.source === '/(.*)')!.headers.map(h => [h.key.toLowerCase(), h.value]));
const csp = Object.fromEntries((all.get('content-security-policy') ?? '').split(';').map(d => d.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k, v]; })) as Record<string, string[]>;

describe('vercel.admin.json', () => {
  it('builds the admin site and publishes the folder the build writes', () => {
    expect(cfg.buildCommand).toBe('npm run build:admin');
    expect(pkg.scripts['build:admin']).toContain('vite.admin.config.ts');
    const outDir = /outDir:\s*'\.\.\/([^']+)'/.exec(read('vite.admin.config.ts'))?.[1];
    expect(cfg.outputDirectory).toBe(outDir);
    expect(cfg.installCommand).toBe('npm ci');
    expect(cfg.framework).toBeNull();
  });

  it('forbids framing, referrers, sniffing and search indexing', () => {
    expect(all.get('x-frame-options')).toBe('DENY');
    expect(all.get('referrer-policy')).toBe('no-referrer');
    expect(all.get('x-content-type-options')).toBe('nosniff');
    expect(all.get('x-robots-tag')).toMatch(/noindex/);
    expect(all.get('permissions-policy')).toMatch(/camera=\(\)/);
    expect(all.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('runs only its own scripts and talks only to itself and the database', () => {
    expect(csp['default-src']).toEqual(["'none'"]);
    expect(csp['script-src']).toEqual(["'self'"]);                                      // no inline script, no eval, no other host
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'none'"]);
    expect(csp['connect-src']).toEqual(["'self'", 'https://*.supabase.co']);
    for (const [k, v] of Object.entries(csp)) { expect(v.join(' '), k).not.toMatch(/unsafe-eval|\*\s|http:/); }
    expect(csp['style-src']).toContain("'unsafe-inline'");                                // the pages use style="" attributes
    expect(csp['script-src']!.join(' ')).not.toContain('unsafe-inline');
  });

  it('never caches the page itself', () => {
    const page = cfg.headers.find(h => h.source !== '/(.*)')!;
    expect(page.headers).toEqual([{ key: 'Cache-Control', value: 'no-store' }]);
    expect(new RegExp(`^${page.source}$`).test('/')).toBe(true);
    expect(new RegExp(`^${page.source}$`).test('/index.html')).toBe(true);
  });
});

describe('the admin page and code', () => {
  it('the page asks not to be indexed and sends no referrer', () => {
    const html = read('admin/index.html');
    expect(html).toMatch(/name="robots" content="noindex, nofollow"/); expect(html).toMatch(/name="referrer" content="no-referrer"/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);                                    // no inline script that the policy would block
  });

  it('holds no service key, secret or other host', () => {
    const files = [...readdirSync(new URL('../src/admin/', import.meta.url)).map(f => `src/admin/${f}`), 'admin/index.html', 'admin/main.ts', 'vite.admin.config.ts'];
    for (const f of files) {
      const text = read(f);
      expect(text, f).not.toMatch(/service_role|SERVICE_KEY|SERVICE_ROLE|sb_secret|eyJ[A-Za-z0-9_-]{20,}/);
      expect(text, f).not.toMatch(/https?:\/\/(?!localhost)[a-z0-9.-]+\.[a-z]{2,}/i);        // no hard-wired address: the database address comes from the environment
    }
  });
});
