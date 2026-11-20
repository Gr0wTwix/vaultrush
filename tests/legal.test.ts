// The footer and the legal pages: every page renders, every footer link goes somewhere real, and the company details stay
// clearly fictional (the repository is public and nothing here may be mistaken for a real firm or a real licence).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMPANY } from '../src/company.js';
import { FOOTER_COLUMNS, footerHtml } from '../src/footer.js';
import { DOCS, LEGAL_ORDER, render } from '../src/views/legal.js';

const appSource = readFileSync('src/app.ts', 'utf8');
const routes: RegExp[] = [...appSource.matchAll(/^\s*\[(\/\^.*\$\/),\s*[\w.]+,\s*'\w+'\],?$/gm)].map(m => new Function(`return ${m[1]}`)() as RegExp);
const hasRoute = (hash: string): boolean => routes.some(r => r.test(hash));

describe('routes', () => {
  it('finds the app routes (sanity check for the tests below)', () => {
    expect(routes.length).toBeGreaterThan(15);
    expect(hasRoute('#/terms')).toBe(true);
    expect(hasRoute('#/definitely-not-a-page')).toBe(false);
  });
});

describe('legal pages', () => {
  it('has the pages a comparable site publishes, each reachable by its own route', () => {
    expect([...LEGAL_ORDER].sort()).toEqual(['about', 'aml', 'contact', 'cookies', 'disclaimer', 'ethics', 'privacy', 'refunds', 'rules', 'terms']);
    for (const k of LEGAL_ORDER) expect(hasRoute(`#/${k}`), k).toBe(true);
  });

  it.each([...LEGAL_ORDER])('renders %s with a title, numbered or named sections and the side index', (k) => {
    const el = document.createElement('div');
    render(el, k);
    expect(el.querySelector('h1')!.textContent).toBe(DOCS[k]!.title);
    expect(el.querySelectorAll('.legal h2').length).toBeGreaterThanOrEqual(3);
    expect(el.querySelectorAll('.legal-nav a').length).toBeGreaterThanOrEqual(LEGAL_ORDER.length);
    expect(el.querySelector('.legal-nav a[aria-current="page"]')!.getAttribute('href')).toBe(`#/${k}`);
    expect(el.textContent).toContain('not legal advice');
  });

  it('names the fictional operator on every policy page and never claims a licence', () => {
    for (const k of LEGAL_ORDER.filter(k => DOCS[k]!.legal)) {
      const el = document.createElement('div'); render(el, k);
      const t = el.textContent!;
      expect(t, k).toContain(COMPANY.name);
      expect(t, k).toMatch(/fictional|placeholder/i);
      expect(t, k).not.toMatch(/licensed by|regulated by the|we are licensed/i);
    }
  });

  it('says the key honest things: play money, no withdrawals, 18+, not affiliated', () => {
    const text = (k: string): string => { const el = document.createElement('div'); render(el, k); return el.textContent!; };
    expect(text('terms')).toMatch(/cannot be bought, sold, transferred to another person or withdrawn/);
    expect(text('terms')).toMatch(/18 or older/);
    expect(text('terms')).toMatch(/not affiliated with, endorsed by or associated with Valve/);
    expect(text('refunds')).toMatch(/Coins cannot be bought/);
    expect(text('disclaimer')).toMatch(/holds no gambling licence/);
    expect(text('privacy')).toMatch(/Vercel/);
    expect(text('privacy')).toMatch(/Supabase/);
    expect(text('cookies')).toMatch(/No advertising cookies, no analytics/);
    expect(text('aml')).toMatch(/simulat/);
  });

  it('falls back to the terms for an unknown page and escapes text', () => {
    const el = document.createElement('div'); render(el, 'nope');
    expect(el.querySelector('h1')!.textContent).toBe('Terms of Service');
    expect(el.querySelector('script')).toBeNull();
  });
});

describe('footer', () => {
  const html = (): string => footerHtml();
  const box = (): HTMLElement => { const el = document.createElement('div'); el.innerHTML = html(); return el; };

  it('names the operator, registration number and address, marked as fictional', () => {
    const t = box().textContent!;
    expect(t).toContain(COMPANY.name);
    expect(t).toContain(COMPANY.regNo);
    for (const line of COMPANY.address) expect(t).toContain(line);
    expect(t).toMatch(/fictional placeholders/);
  });

  it('carries the non-affiliation notice, the 18+ strip and the help link', () => {
    const t = box().textContent!;
    expect(t).toMatch(/not affiliated with, endorsed by or associated with Valve, Steam, Counter-Strike, Facepunch, Rust/);
    expect(t).toMatch(/18\+/);
    expect(t).toMatch(/Have a gaming problem\?/);
    expect(t).toMatch(/cannot be bought, sold or withdrawn/);
    expect(box().querySelector('.ft-note a')!.getAttribute('href')).toBe('#/responsible');
  });

  it('every internal link points at a real route and external links open safely', () => {
    for (const col of FOOTER_COLUMNS) for (const [href] of col.links) if (href.startsWith('#')) expect(hasRoute(href), href).toBe(true);
    for (const a of box().querySelectorAll<HTMLAnchorElement>('a[href^="http"]')) {
      expect(a.getAttribute('rel')).toContain('noopener');
      expect(a.getAttribute('target')).toBe('_blank');
    }
    const hrefs = [...box().querySelectorAll('a')].map(a => a.getAttribute('href'));
    for (const k of LEGAL_ORDER) expect(hrefs, k).toContain(`#/${k}`);
  });

  it('every page of the games column exists', () => {
    const games = FOOTER_COLUMNS.find(c => c.title === 'Games')!;
    expect(games.links.length).toBeGreaterThanOrEqual(8);
    for (const [href] of games.links) expect(hasRoute(href), href).toBe(true);
  });
});

describe('company details', () => {
  it('are fictional: reserved .example addresses, a DEMO registration number and a demo flag', () => {
    expect(COMPANY.demo).toBe(true);
    expect(COMPANY.regNo).toMatch(/^DEMO/);
    for (const e of [COMPANY.email, COMPANY.privacyEmail, COMPANY.complianceEmail]) expect(e).toMatch(/@[\w.-]+\.example$/);
    expect(COMPANY.address.join(' ')).toMatch(/Demo/);
    expect(COMPANY.phone).toMatch(/^\+00 /);
  });
});
