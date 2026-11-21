// The chat on the right. With a saved cloud sign-in the real chat is about to switch on, so a refresh must not flash the simulated room (bot messages and a made-up
// "412 online"): it shows a quiet "connecting" line, then the real chat; the simulated room is only for visitors who have no live chat to show.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => ({ live: false, stored: false, recent: [] as { id: number; display_name: string; body: string; created_at: string }[], online: [] as ((n: number) => void)[] }));
vi.mock('../src/backend.js', async importOriginal => ({ ...(await importOriginal<typeof import('../src/backend.js')>()), hasStoredSession: () => srv.stored }));
vi.mock('../src/live.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/live.js')>()),
  isLive: () => srv.live,
  recentChat: async () => srv.recent,
  watchChat: async () => () => {},
  sendChat: async () => {},
  onOnline: (fn: (n: number) => void) => { srv.online.push(fn); return () => {}; },
}));

import { emit } from '../src/state.js';
import { initChat } from '../src/chat.js';

let root: HTMLElement;
const names = (): string[] => [...root.querySelectorAll('.msg-name')].map(n => n.textContent ?? '');
const mount = (): void => { root = document.createElement('aside'); document.body.append(root); initChat(root); };

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ''; srv.live = false; srv.stored = false; srv.recent = []; srv.online = []; });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('a visitor with no saved sign-in', () => {
  it('sees the simulated room straight away', () => {
    mount();
    expect(names().length).toBe(8);
    expect(root.querySelector('#onlineCount')!.textContent).toMatch(/^\d{3}$/);
    expect(root.querySelector('.chat-connecting')).toBeNull();
  });
});

describe('a refresh with a saved cloud sign-in', () => {
  beforeEach(() => { srv.stored = true; });

  it('shows no bot messages and no made-up online count while it connects', async () => {
    mount();
    expect(names()).toEqual([]);
    expect(root.querySelector('.chat-connecting')!.textContent).toContain('Connecting');
    expect(root.querySelector('#onlineCount')!.textContent).toBe('…');
    await vi.advanceTimersByTimeAsync(5000);
    expect(names()).toEqual([]);                                                       // and no bot starts talking in the meantime
  });

  it('swaps straight to the real chat when live play switches on, with the real online count', async () => {
    mount();
    srv.recent = [{ id: 1, display_name: 'Nova', body: 'hello', created_at: '' }, { id: 2, display_name: 'Quill', body: 'gl', created_at: '' }];
    srv.live = true; emit('live', true);
    await vi.advanceTimersByTimeAsync(50);
    expect(names()).toEqual(['Nova', 'Quill']);
    expect(root.querySelector('.chat-connecting')).toBeNull();
    srv.online.forEach(f => f(7));
    expect(root.querySelector('#onlineCount')!.textContent).toBe('7');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(names()).toEqual(['Nova', 'Quill']);                                        // the simulated room never starts
  });

  it('falls back to the simulated room only if the live chat never comes (an old database, or the sign-in is gone)', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(6100);
    expect(names().length).toBe(8); expect(root.querySelector('.chat-connecting')).toBeNull();
  });

  it('falls back at once when the saved sign-in turns out to be gone', async () => {
    mount();
    emit('auth', false);
    expect(names().length).toBe(8);
  });
});
