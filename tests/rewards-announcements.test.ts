// Admin step E part 1 on the game site: the reward numbers come from the database (migration 0023), and announcements show as closable banners
// and one-time pop-ups.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => ({ status: {} as Record<string, unknown>, rewards: null as any, down: false }));
vi.mock('../src/backend.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/backend.js')>()),
  backendEnabled: () => true,
  call: async (fn: string) => {
    if (srv.down) throw new Error('offline');
    if (fn === 'site_status') return JSON.parse(JSON.stringify(srv.status));
    if (fn === 'reward_settings_public') return srv.rewards;
    throw new Error('unexpected ' + fn);
  },
}));

const state = await import('../src/state.js');
const { PRIZES } = await import('../src/race.js');
const { syncRewards } = await import('../src/rewards-sync.js');
const { refreshSite, resetSite } = await import('../src/site.js');

const OPEN = { maintenance: false, maintenance_message: '', notice: null, signups_open: true, games_off: [], country: null, country_blocked: false, staff: false, announcements: [] };
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('reward settings from the database', () => {
  it('a bad or missing answer keeps the built-in numbers', async () => {
    srv.rewards = { faucet_amount: 0, faucet_minutes: 10, rakeback: {}, calendar: [1], race_prizes: [] };
    expect(await syncRewards()).toBe(false);
    srv.down = true; expect(await syncRewards()).toBe(false); srv.down = false;
    expect(state.FREE_COINS).toBe(25); expect(state.CALENDAR).toEqual([1, 2, 3, 5, 8, 12, 25]); expect(PRIZES[0]).toBe(400);
  });
  it('applies the faucet, rakeback, calendar and race prizes, and every importer sees them', async () => {
    srv.rewards = { faucet_amount: 40, faucet_minutes: 30, rakeback: { instant: 0.01, daily: 0, weekly: 0.002 }, calendar: [9, 2, 3, 5, 8, 12, 50], race_prizes: [777, 5] };
    const cal = state.CALENDAR, prizes = PRIZES;
    expect(await syncRewards()).toBe(true);
    expect(state.FREE_COINS).toBe(40); expect(state.FREE_COINS_EVERY_MS).toBe(30 * 60_000);
    expect(state.RAKEBACK).toEqual({ instant: 0.01, daily: 0, weekly: 0.002 });
    expect(cal).toBe(state.CALENDAR); expect(state.CALENDAR).toEqual([9, 2, 3, 5, 8, 12, 50]);
    expect(prizes).toBe(PRIZES); expect(PRIZES).toEqual([777, 5]);
  });
});

describe('announcements', () => {
  beforeEach(() => {
    resetSite(); localStorage.clear(); srv.down = false;
    document.body.innerHTML = '<div class="app"><header id="topbar"></header><main id="view"></main></div><div id="toasts"></div>';
  });
  it('shows banners under the top bar, escaped, with their style', async () => {
    srv.status = { ...OPEN, announcements: [{ id: 1, kind: 'banner', style: 'win', body: 'Double <b>XP</b> weekend' }] };
    await refreshSite();
    const b = document.querySelector('[data-ann="1"]') as HTMLElement;
    expect(b.classList.contains('win')).toBe(true);
    expect(b.textContent).toContain('Double <b>XP</b> weekend');
    expect(b.querySelector('b')).toBeNull();
  });
  it('a closed banner stays closed in this browser; a new one still shows', async () => {
    srv.status = { ...OPEN, announcements: [{ id: 1, kind: 'banner', style: 'info', body: 'one' }] };
    await refreshSite();
    (document.querySelector('[data-ann="1"] .ann-x') as HTMLElement).click();
    expect(document.querySelector('[data-ann="1"]')).toBeNull();
    srv.status = { ...OPEN, announcements: [{ id: 1, kind: 'banner', style: 'info', body: 'one' }, { id: 2, kind: 'banner', style: 'warn', body: 'two' }] };
    await refreshSite();
    expect(document.querySelector('[data-ann="1"]')).toBeNull();
    expect(document.querySelector('[data-ann="2"]')).not.toBeNull();
  });
  it('a pop-up is shown once per browser', async () => {
    srv.status = { ...OPEN, announcements: [{ id: 5, kind: 'popup', style: 'info', body: 'Maintenance tonight at 22:00' }] };
    await refreshSite(); await flush();
    expect(document.querySelectorAll('.notice-text')).toHaveLength(1);
    expect(document.querySelector('.notice-text')?.textContent).toBe('Maintenance tonight at 22:00');
    (document.querySelector('[data-ok]') as HTMLElement).click();
    resetSite(); document.querySelectorAll('.modal-back').forEach(e => e.remove());
    srv.status = { ...OPEN, announcements: [{ id: 5, kind: 'popup', style: 'info', body: 'Maintenance tonight at 22:00' }], notice: { text: 'changed', kind: 'info' } };
    await refreshSite(); await flush();
    expect(document.querySelectorAll('.notice-text')).toHaveLength(0);
  });
  it('nothing is announced over the maintenance screen', async () => {
    srv.status = { ...OPEN, maintenance: true, announcements: [{ id: 9, kind: 'banner', style: 'info', body: 'hidden' }] };
    await refreshSite();
    expect(document.getElementById('siteBlock')).not.toBeNull();
    expect(document.querySelector('[data-ann]')).toBeNull();
  });
});
