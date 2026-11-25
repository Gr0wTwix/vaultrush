// @vitest-environment node
// The game site's security headers (vercel.json) and the rule that makes a strict script policy possible: no inline event handlers in the page code.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const cfg = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8')) as { buildCommand: string; outputDirectory: string; headers: { source: string; headers: { key: string; value: string }[] }[] };
const h = new Map(cfg.headers[0]!.headers.map(x => [x.key.toLowerCase(), x.value]));
const csp = Object.fromEntries((h.get('content-security-policy') ?? '').split(';').map(d => d.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k, v]; })) as Record<string, string[]>;

describe('vercel.json (the game site)', () => {
  it('still builds the game and sends headers for every path', () => {
    expect(cfg.buildCommand).toBe('npm run build'); expect(cfg.outputDirectory).toBe('dist');
    expect(cfg.headers[0]!.source).toBe('/(.*)');
  });
  it('forbids framing, sniffing and needless browser features', () => {
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(h.get('permissions-policy')).toMatch(/camera=\(\)/);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
  });
  it('runs only its own scripts, and talks only to itself and the database (https and realtime)', () => {
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['connect-src']).toEqual(["'self'", 'https://*.supabase.co', 'wss://*.supabase.co']);
    expect(csp['font-src']).toContain('https://fonts.gstatic.com');
    expect(csp['style-src']).toContain('https://fonts.googleapis.com');
    for (const [k, v] of Object.entries(csp)) expect(v.join(' '), k).not.toMatch(/unsafe-eval|http:/);
  });
});

describe('the page code', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });
  it('has no inline event handlers (they would need unsafe-inline scripts)', () => {
    const src = new URL('src/', root).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    for (const f of files(src)) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/\son(error|load|click|input|change|submit|mouse\w*|key\w*)\s*=\s*["']/);
    }
  });
  it('index.html loads only module scripts from the site itself', () => {
    const html = readFileSync(new URL('index.html', root), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc="\/)/);
  });
});
