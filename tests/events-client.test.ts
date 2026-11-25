// Admin step E part 2 on the game site (migration 0024): the giveaway draw check, the special races on the race board, and real coin rain in chat.
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ rain: null as any, joined: [] as number[], onRain: null as null | (() => void) }));
vi.mock('../src/live.js', async orig => ({
  ...(await orig<typeof import('../src/live.js')>()),
  isLive: () => true, recentChat: async () => [], watchChat: async () => () => {}, onOnline: () => () => {}, chatStatus: async () => null,
}));
vi.mock('../src/events.js', async orig => ({
  ...(await orig<typeof import('../src/events.js')>()),
  rainNow: async () => JSON.parse(JSON.stringify(fake.rain)),
  joinRain: async (id: number) => { fake.joined.push(id); return { joined: true, joiners: 4 }; },
  watchRains: async (cb: () => void) => { fake.onRain = cb; return () => {}; },
}));

const { drawOrder, sha256Hex } = await import('../src/events.js');
const { eventRaces } = await import('../src/views/leaderboard.js');
const { initChat } = await import('../src/chat.js');
const { setAuthed, state } = await import('../src/state.js');
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); };

describe('checking a giveaway draw', () => {
  it('orders entries exactly as the database does: lowest SHA-256 of "seed:entry number" first', async () => {
    const seed = 'ab'.repeat(32), nos = [1, 2, 3, 4, 5, 6, 7];
    const expected = [...nos].sort((a, b) => { const ha = createHash('sha256').update(`${seed}:${a}`).digest('hex'), hb = createHash('sha256').update(`${seed}:${b}`).digest('hex'); return ha < hb ? -1 : 1; });
    expect(await drawOrder(seed, nos)).toEqual(expected);
    expect(await sha256Hex(seed)).toBe(createHash('sha256').update(seed).digest('hex'));
  });
});

describe('special races on the race board', () => {
  it('shows each race with its pool, games, top players (escaped) and the player\'s own place', () => {
    const html = eventRaces([{ id: 3, name: 'Plinko <sprint>', starts_at: '2026-11-25T00:00:00Z', ends_at: new Date(Date.now() + 5 * 3600_000).toISOString(), prizes: [100, 50], games: ['plinko'], state: 'running', pool: 150,
      top: [{ rank: 1, name: 'Orion', wagered: 50, prize: 100 }, { rank: 2, name: 'Nova', wagered: 30, prize: 50 }], me: { rank: 14, wagered: 2 } }]);
    const box = document.createElement('div'); box.innerHTML = html;
    expect(box.textContent).toContain('Plinko <sprint>'); expect(box.querySelector('sprint')).toBeNull();
    expect(box.textContent).toContain('Plinko'); expect(box.textContent).toMatch(/[45]h \d+m left/);
    expect(box.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(box.textContent).toContain('You: #14');
    expect(eventRaces([])).toBe('');
  });
});

describe('real coin rain in the chat', () => {
  beforeAll(async () => {
    setAuthed(true, 'cloud-nova'); state.name = 'Nova';
    fake.rain = { open: { id: 7, pot: 30, ends_at: new Date(Date.now() + 45_000).toISOString(), min_level: 0, joiners: 3, joined: false }, last: null, now: Date.now() };
    document.body.innerHTML = '<aside id="chat"></aside><div id="toasts"></div>';
    initChat(document.getElementById('chat'));
    await flush();
  });
  it('shows the open rain with its pot, time left and joiners; joining asks the database', async () => {
    const bar = document.getElementById('rain') as HTMLElement;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toMatch(/30\.00?.*4[45]s.*3 joined/);
    (bar.querySelector('button') as HTMLButtonElement).click(); await flush();
    expect(fake.joined).toEqual([7]);
    expect(bar.textContent).toContain('4 joined'); expect(bar.querySelector('button')?.textContent).toBe('Joined');
  });
  it('when it has paid out, says how much this player got, once', async () => {
    fake.rain = { open: null, last: { id: 7, pot: 30, joiners: 4, share: 7.5, mine: true }, now: Date.now() };
    fake.onRain!(); await flush();
    expect((document.getElementById('rain') as HTMLElement).hidden).toBe(true);
    const lines = [...document.querySelectorAll('#chatMsgs .msg-sys')].map(m => m.textContent);
    expect(lines.filter(l => /Coin rain paid/.test(l ?? ''))).toHaveLength(1);
    expect(lines.join(' ')).toMatch(/You got 7\.5/);
    fake.onRain!(); await flush();
    expect([...document.querySelectorAll('#chatMsgs .msg-sys')].filter(m => /Coin rain paid/.test(m.textContent ?? ''))).toHaveLength(1);
  });
});
