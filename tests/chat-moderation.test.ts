// The game site's side of chat moderation and staff warnings (migration 0021): staff badge, removed messages (also when removed later),
// the report button, the pinned message and room state, and the one-time warning popup.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  rows: [] as any[],
  insert: null as null | ((m: any) => void),
  update: null as null | ((m: any) => void),
  status: { slow_seconds: 0, locked: false, links_allowed: true, pinned: { id: 5, display_name: 'Mirage', body: 'Be nice <3', is_staff: true } } as any,
  reported: [] as number[],
  calls: [] as [string, any][],
  notices: [] as any[],
}));

vi.mock('../src/live.js', async orig => ({
  ...(await orig<typeof import('../src/live.js')>()),
  isLive: () => true,
  recentChat: async () => fake.rows,
  watchChat: async (onInsert: (m: any) => void, onUpdate: (m: any) => void) => { fake.insert = onInsert; fake.update = onUpdate; return () => {}; },
  onOnline: () => () => {},
  chatStatus: async () => fake.status,
  reportChat: async (id: number) => { fake.reported.push(id); },
}));
vi.mock('../src/backend.js', async orig => ({
  ...(await orig<typeof import('../src/backend.js')>()),
  call: async (fn: string, args: any) => { fake.calls.push([fn, args]); return fn === 'my_notices' ? fake.notices : null; },
}));

const { initChat } = await import('../src/chat.js');
const { state, setAuthed } = await import('../src/state.js');
const { showNotices } = await import('../src/notices.js');
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); };
const msg = (id: number): HTMLElement | null => document.querySelector(`.msg[data-id="${id}"]`);

beforeAll(async () => {
  setAuthed(true, 'cloud-nova'); state.name = 'Nova';
  (window as any).confirm = () => true;                                         // happy-dom has no confirm(); each test sets the answer it needs
  fake.rows = [
    { id: 1, display_name: 'Orion', body: '<img src=x onerror=alert(1)>hi', created_at: '2026-11-25T09:00:00Z', is_staff: false, removed_at: null },
    { id: 2, display_name: 'Mirage', body: 'Welcome all', created_at: '2026-11-25T09:00:01Z', is_staff: true, removed_at: null },
    { id: 3, display_name: 'Lyra', body: 'spam spam', created_at: '2026-11-25T09:00:02Z', is_staff: false, removed_at: '2026-11-25T09:01:00Z' },
    { id: 4, display_name: 'Nova', body: 'my own', created_at: '2026-11-25T09:00:03Z' },
  ];
  document.body.innerHTML = '<aside id="chat"></aside><div id="toasts"></div>';
  initChat(document.getElementById('chat'));
  await flush();
});
beforeEach(() => { fake.calls = []; });

describe('live chat with moderation', () => {
  it('shows player text as text, staff with a badge, and removed messages as removed', () => {
    expect(msg(1)?.querySelector('.msg-text img')).toBeNull();
    expect(msg(1)?.querySelector('.msg-text')?.textContent).toContain('<img');
    expect(msg(2)?.querySelector('.staff-badge')?.textContent).toBe('STAFF');
    expect(msg(3)?.querySelector('.msg-text')?.textContent).toBe('Message removed by a moderator');
    expect(msg(3)?.textContent).not.toContain('spam');
  });
  it('offers a report button on other players\' messages only (not staff, not removed, not your own)', () => {
    expect(msg(1)?.querySelector('.msg-report')).not.toBeNull();
    expect(msg(2)?.querySelector('.msg-report')).toBeNull();
    expect(msg(3)?.querySelector('.msg-report')).toBeNull();
    expect(msg(4)?.querySelector('.msg-report')).toBeNull();
  });
  it('a message removed while on screen changes at once for this player', async () => {
    fake.insert!({ id: 9, display_name: 'Orion', body: 'buy coins at my site', created_at: '2026-11-25T09:05:00Z', is_staff: false, removed_at: null });
    expect(msg(9)?.querySelector('.msg-text')?.textContent).toBe('buy coins at my site');
    fake.update!({ id: 9, display_name: 'Orion', body: 'removed', created_at: '2026-11-25T09:05:00Z', is_staff: false, removed_at: '2026-11-25T09:06:00Z' });
    await flush();
    expect(msg(9)?.querySelector('.msg-text')?.textContent).toBe('Message removed by a moderator');
    expect(msg(9)?.querySelector('.msg-report')).toBeNull();
  });
  it('reporting asks first, then sends the message id once', async () => {
    (window as any).confirm = () => false;
    (msg(1)?.querySelector('.msg-report') as HTMLElement).click();
    expect(fake.reported).toEqual([]);
    (window as any).confirm = () => true;
    (msg(1)?.querySelector('.msg-report') as HTMLElement).click();
    await flush();
    expect(fake.reported).toEqual([1]);
    expect(msg(1)?.querySelector('.msg-report')).toBeNull();
  });
  it('shows the pinned message (escaped) and the room state above the chat', async () => {
    const pin = document.getElementById('chatPin') as HTMLElement;
    expect(pin.hidden).toBe(false);
    expect(pin.textContent).toContain('Be nice <3');
    expect(pin.querySelector('.staff-badge')).not.toBeNull();
    fake.status = { slow_seconds: 30, locked: false, links_allowed: true, pinned: null };
    fake.update!({ id: 9, removed_at: '2026-11-25T09:06:00Z' });                 // any removal also refreshes the pin
    await flush();
    expect(pin.textContent).toContain('one message every 30 seconds');
  });
});

describe('a warning from staff', () => {
  it('is shown once, and marked read when the player confirms it', async () => {
    fake.notices = [{ id: 7, message: 'Please keep the chat <b>friendly</b>.', at: '2026-11-25T09:00:00Z' }];
    const done = showNotices();
    await flush();
    const box = document.querySelector('.notice-text') as HTMLElement;
    expect(box.textContent).toBe('Please keep the chat <b>friendly</b>.');
    expect(box.querySelector('b')).toBeNull();
    void showNotices();                                                        // a second call while one is open shows nothing more
    await flush();
    expect(document.querySelectorAll('.notice-text')).toHaveLength(1);
    (document.getElementById('noticeOk') as HTMLButtonElement).click();
    await done;
    expect(fake.calls).toContainEqual(['ack_notice', { p_id: 7 }]);
  });
  it('does nothing when there is no warning, or before the database knows about warnings', async () => {
    fake.notices = [];
    const open = document.querySelectorAll('.modal-back:not(.out)').length;
    await showNotices();
    expect(fake.calls).toContainEqual(['my_notices', undefined]);
    expect(document.querySelectorAll('.modal-back:not(.out)').length).toBe(open);
  });
});
