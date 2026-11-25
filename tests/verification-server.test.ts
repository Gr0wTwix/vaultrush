// Admin step F part 1 on the game site (migration 0026): the verified level the server uses, and asking staff for the next one.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => ({ mine: null as any, calls: [] as [string, any][], fail: '' }));
vi.mock('../src/backend.js', async orig => ({
  ...(await orig<typeof import('../src/backend.js')>()),
  call: async (fn: string, args: any) => {
    srv.calls.push([fn, args]);
    if (srv.fail && fn === 'request_verification') throw new Error(srv.fail);
    if (fn === 'request_verification') srv.mine = { tier: srv.mine.tier, request: { id: 1, tier: args.p_tier, status: 'pending', at: '2026-11-25T10:00:00Z', decided_at: null, note: null } };
    if (fn === 'withdraw_verification') srv.mine = { ...srv.mine, request: { ...srv.mine.request, status: 'withdrawn' } };
    if (srv.mine === 'missing') throw new Error('function my_verification does not exist');
    return JSON.parse(JSON.stringify(srv.mine));
  },
}));
const { renderServerVerification } = await import('../src/verification-server.js');
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
let box: HTMLElement;
beforeEach(() => { srv.calls = []; srv.fail = ''; document.body.innerHTML = '<div id="box"></div><div id="toasts"></div>'; box = document.getElementById('box') as HTMLElement; });

describe('verified level card', () => {
  it('shows nothing before the database knows about verification requests', async () => {
    srv.mine = 'missing';
    await renderServerVerification(box);
    expect(box.innerHTML).toBe('');
  });
  it('shows the level and its stake cap, and asks for the next level with the note', async () => {
    srv.mine = { tier: 0, request: null };
    await renderServerVerification(box);
    expect(box.textContent).toContain('10,000'); expect(box.textContent).toContain('no documents are collected');
    (box.querySelector('#kvNote') as HTMLInputElement).value = 'big battles';
    (box.querySelector('#kvAsk') as HTMLButtonElement).click(); await flush(); await flush();
    expect(srv.calls).toContainEqual(['request_verification', { p_tier: 1, p_note: 'big battles' }]);
    expect(box.textContent).toContain('waiting for staff');
    expect(box.querySelector('#kvWithdraw')).not.toBeNull();
  });
  it('withdrawing sends the request back; at the top level there is nothing to ask', async () => {
    srv.mine = { tier: 0, request: { id: 1, tier: 1, status: 'pending', at: '2026-11-25T10:00:00Z', decided_at: null, note: null } };
    await renderServerVerification(box);
    (box.querySelector('#kvWithdraw') as HTMLButtonElement).click(); await flush(); await flush();
    expect(srv.calls.map(c => c[0])).toContain('withdraw_verification');
    srv.mine = { tier: 2, request: { id: 2, tier: 2, status: 'approved', at: '2026-11-25T10:00:00Z', decided_at: '2026-11-25T11:00:00Z', note: 'looks <b>fine</b>' } };
    await renderServerVerification(box);
    expect(box.textContent).toContain('highest level');
    expect(box.textContent).toContain('looks <b>fine</b>'); expect(box.querySelector('b b')).toBeNull();
  });
});
