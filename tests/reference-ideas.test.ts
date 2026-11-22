// Ideas taken from reference sites on 2026-11-22: a risk label on every case (CSGOBig), the drop chance on each pulled battle item (Chicken.gg),
// and ½ / 2× / Max on the Upgrade coin stake (SkinRave).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CASE, CASES, caseRisk } from '../src/data.js';
import { riskBadge } from '../src/ui.js';

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('case risk', () => {
  it('is the chance that one opening returns at least the price, with fixed thresholds', () => {
    for (const c of CASES) {
      const r = caseRisk(c);
      const back = c.entries.filter(e => e.item.value >= c.price).reduce((s, e) => s + e.chance, 0);
      expect(r.back).toBeCloseTo(back, 9);
      expect(r.level).toBe(back >= 0.22 ? 'low' : back >= 0.12 ? 'medium' : 'high');
    }
  });
  it('gives the real cases a spread of levels, e.g. Flip low and Cosmic high', () => {
    const levels = new Set(CASES.map(c => caseRisk(c).level));
    expect([...levels].sort()).toEqual(['high', 'low', 'medium']);
    expect(caseRisk(CASE['flip']!).level).toBe('low'); expect(caseRisk(CASE['cosmic5']!).level).toBe('high');
  });
  it('the badge names the level and says the exact chance, also for screen readers', () => {
    const c = CASE['flip']!, html = riskBadge(c), pct = `${(caseRisk(c).back * 100).toFixed(1)}%`;
    expect(html).toContain('Low risk'); expect(html).toContain('risk-low');
    expect(html).toContain(`title="${pct} chance`); expect(html).toContain(`class="sr-only">: ${pct} chance`);
  });
});

describe('the Upgrade coin stake buttons', () => {
  it('Max stakes the whole balance, ½ halves it and 2× doubles it', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));             // the target list is not needed here
    const { state, resetAccount } = await import('../src/state.js');
    const { render } = await import('../src/views/upgrade.js');
    resetAccount(); state.balance = 80;
    document.body.innerHTML = '<div id="toasts"></div><main id="view"></main>';
    const el = document.getElementById('view')!;
    const stop = render(el);
    const input = el.querySelector('#coinStake') as HTMLInputElement;
    const press = (q: string): void => (el.querySelector(`.amount [data-amt="${q}"]`) as HTMLButtonElement).click();
    press('max'); expect(+input.value).toBe(80);
    press('half'); expect(+input.value).toBe(40);
    press('double'); expect(+input.value).toBe(80);
    expect(el.querySelector('[aria-label="Stake your whole balance"]')).not.toBeNull();
    if (typeof stop === 'function') stop();
    vi.unstubAllGlobals();
  });
});

describe('first-visit tips (idea from CSGOBig)', () => {
  it('shows once, walks through every tip, and is not shown again once closed', async () => {
    localStorage.removeItem('vaultrush.tips.v1');
    const { maybeShowTips, TIPS } = await import('../src/tips.js');
    maybeShowTips();
    const titles: string[] = [];
    for (let i = 0; i < TIPS.length; i++) {
      titles.push(document.querySelector('.tips h2')!.textContent!);
      (document.querySelector('.tips [data-t="next"], .tips [data-t="done"]') as HTMLButtonElement).click();
    }
    expect(titles).toEqual(TIPS.map(t => t[1]));
    expect(localStorage.getItem('vaultrush.tips.v1')).toBeTruthy();
    await new Promise(r => setTimeout(r, 250));
    document.body.innerHTML = '';
    maybeShowTips();
    expect(document.querySelector('.tips')).toBeNull();
  });
  it('never covers another window (the 18+ question): it waits for the next visit', async () => {
    localStorage.removeItem('vaultrush.tips.v1');
    const { maybeShowTips } = await import('../src/tips.js');
    document.body.innerHTML = '<div class="rg-overlay"></div>';
    maybeShowTips();
    expect(document.querySelector('.tips')).toBeNull();
    expect(localStorage.getItem('vaultrush.tips.v1')).toBeNull();
  });
  it('the footer link opens it again, and Back and Skip work', async () => {
    localStorage.setItem('vaultrush.tips.v1', '1');
    const { wireTipsLink, TIPS } = await import('../src/tips.js');
    wireTipsLink();
    document.body.insertAdjacentHTML('beforeend', '<button id="ftTips">Show the site tips</button>');
    (document.getElementById('ftTips') as HTMLButtonElement).click();
    (document.querySelector('.tips [data-t="next"]') as HTMLButtonElement).click();
    expect(document.querySelector('.tips h2')!.textContent).toBe(TIPS[1]![1]);
    (document.querySelector('.tips [data-t="back"]') as HTMLButtonElement).click();
    expect(document.querySelector('.tips h2')!.textContent).toBe(TIPS[0]![1]);
    (document.querySelector('.tips [data-t="skip"]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 250));
    expect(document.querySelector('.tips')).toBeNull();
  });
});

describe('quick open on the case list (idea from CSGOBig)', () => {
  it('turns the card over, picks how many, and hands the choice to the case page, which selects it', async () => {
    const { renderList, renderCase } = await import('../src/views/cases.js');
    const { handoff } = await import('../src/state.js');
    document.body.innerHTML = '<div id="toasts"></div><main id="view"></main>';
    const el = document.getElementById('view')!;
    renderList(el);
    const card = el.querySelector('.case-card[data-case="starter"]') as HTMLElement;
    const back = card.querySelector('.qo-back') as HTMLElement;
    expect(back.hidden).toBe(true);
    (card.querySelector('.qo-btn') as HTMLButtonElement).click();
    expect(back.hidden).toBe(false); expect(card.classList.contains('flipped')).toBe(true);
    (back.querySelector('[data-qn="3"]') as HTMLButtonElement).click();
    expect(back.querySelector('.qo-open')!.textContent).toMatch(/Open 3× for/);
    (back.querySelector('.qo-open') as HTMLButtonElement).click();
    expect(handoff.quickOpen).toEqual({ id: 'starter', count: 3 });
    expect(location.hash).toBe('#/case/starter');
    el.innerHTML = '';
    const stop = renderCase(el, 'starter');
    expect(el.querySelector('#count button.active')!.textContent).toBe('3');
    expect(handoff.quickOpen).toBeUndefined();
    if (typeof stop === 'function') stop();                                 // leave before the automatic Open fires
    location.hash = '';
  });
  it('closes again with its close button without following the card link', async () => {
    const { renderList } = await import('../src/views/cases.js');
    document.body.innerHTML = '<main id="view"></main>';
    const el = document.getElementById('view')!;
    renderList(el);
    const card = el.querySelector('.case-card') as HTMLElement, back = card.querySelector('.qo-back') as HTMLElement;
    (card.querySelector('.qo-btn') as HTMLButtonElement).click();
    const before = location.hash;
    (back.querySelector('.qo-close') as HTMLButtonElement).click();
    expect(back.hidden).toBe(true); expect(location.hash).toBe(before);
  });
});

describe('Upgrade: price slider and Auto (ideas from SkinRave)', () => {
  const open = async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    const { state, resetAccount } = await import('../src/state.js');
    const { render } = await import('../src/views/upgrade.js');
    resetAccount(); state.balance = 50;
    document.body.innerHTML = '<div id="toasts"></div><main id="view"></main>';
    const el = document.getElementById('view')!;
    return { el, stop: render(el) };
  };
  it('the price slider runs from about 1 to 100,000 coins and its far right means any price', async () => {
    const { el, stop } = await open();
    const s = el.querySelector('#tMax') as HTMLInputElement, lbl = () => el.querySelector('#tMaxLbl')!.textContent;
    const move = (v: number): void => { s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true })); };
    move(20); expect(lbl()).toBe('10.00');
    move(60); expect(lbl()).toBe('1,000.00');
    move(100); expect(lbl()).toBe('any price');
    if (typeof stop === 'function') stop(); vi.unstubAllGlobals();
  });
  it('Auto offers at most 25 rounds, stops on a win by default, and needs a stake and a target', async () => {
    const { el, stop } = await open();
    const n = el.querySelector('#autoN') as HTMLSelectElement; n.value = '5'; n.dispatchEvent(new Event('change', { bubbles: true }));
    expect((el.querySelector('#upBtn') as HTMLButtonElement).disabled).toBe(true);
    expect([...n.options].map(o => o.value)).toEqual(['0', '5', '10', '25']);
    expect((el.querySelector('#autoStopWin') as HTMLInputElement).checked).toBe(true);
    if (typeof stop === 'function') stop(); vi.unstubAllGlobals();
  });
});
