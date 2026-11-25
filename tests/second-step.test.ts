// The authenticator step after Google, Steam, a password or a restored session (2026-11-25).
// The Supabase project ends sessions that never enter the code ("Limit duration of AAL1 sessions"), so every sign-in path must ask for it.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  needs: true,
  authCb: null as null | ((event: string, on: boolean, uid: string) => void | Promise<void>),
  verify: vi.fn(async (code: string) => { if (code !== '123456') throw new Error('That code is not correct.'); fake.needs = false; }),
  signOut: vi.fn(async () => {}),
  checks: 0,
}));

vi.mock('../src/backend.js', async orig => ({
  ...(await orig<typeof import('../src/backend.js')>()),
  backendEnabled: () => true,
  finishSteamLogin: async () => null,
  currentUser: async () => ({ id: 'u1' }),
  profileName: async () => 'Tester',
  needs2fa: async () => { fake.checks++; return fake.needs; },
  verifyLogin2fa: fake.verify,
  signOut: fake.signOut,
  onAuthChange: async (cb: (event: string, on: boolean, uid: string) => void) => { fake.authCb = cb; },
}));
vi.mock('../src/wallet.js', () => ({ initWallet: async () => {}, stopWallet: () => {} }));
vi.mock('../src/live.js', () => ({ initLive: async () => {}, stopLive: () => {} }));
vi.mock('../src/fair.js', async orig => ({ ...(await orig<typeof import('../src/fair.js')>()), useFairFor: async () => ({}) }));

const { initAuth, openSecondStep } = await import('../src/auth.js');
const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const steps = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.modal-back:not(.out) [aria-label="Enter your authenticator code"]')];
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); };
const submit = async (code: string): Promise<void> => {
  (q('#au2fa') as HTMLInputElement).value = code;
  q<HTMLFormElement>('.modal-back:not(.out) #auForm')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
};

beforeAll(async () => {
  document.body.innerHTML = `<div class="app"><header id="topbar"><div class="me-wrap"><button id="meBtn">me</button></div></header><main id="view"></main></div><div id="toasts" role="status" aria-live="polite"></div>`;
  await initAuth();
  await flush();
});
beforeEach(() => { fake.verify.mockClear(); });

describe('second sign-in step', () => {
  it('asks for the code on a restored session of an account with an authenticator', () => {
    expect(fake.checks).toBeGreaterThan(0);
    expect(steps()).toHaveLength(1);
    expect(q('#au2fa')?.getAttribute('autocomplete')).toBe('one-time-code');
  });

  it('shows one window even when start-up and the sign-in event both ask', async () => {
    await fake.authCb!('INITIAL_SESSION', true, 'u1'); await flush();
    openSecondStep();
    expect(steps()).toHaveLength(1);
  });

  it('cannot be closed with Escape', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(steps()).toHaveLength(1);
  });

  it('rejects a code that is not 6 digits without asking the server', async () => {
    await submit('12a');
    expect(fake.verify).not.toHaveBeenCalled();
    expect(q('#auFormErr')?.textContent).toMatch(/6-digit/);
  });

  it('keeps the window open and says so on a wrong code', async () => {
    await submit('000000');
    expect(fake.verify).toHaveBeenCalledWith('000000');
    expect(steps()).toHaveLength(1);
    expect(q('#auFormErr')?.textContent).toMatch(/not correct/);
  });

  it('closes after the right code, and a later sign-in event at the full level does not ask again', async () => {
    await submit('123 456');
    expect(fake.verify).toHaveBeenCalledWith('123456');
    expect(steps()).toHaveLength(0);
    await fake.authCb!('SIGNED_IN', true, 'u1'); await flush();
    expect(steps()).toHaveLength(0);
  });

  it('asks again after a Google or Steam sign-in that has not entered the code', async () => {
    fake.needs = true;
    await fake.authCb!('SIGNED_IN', true, 'u1'); await flush();
    expect(steps()).toHaveLength(1);
  });

  it('is removed when the session ends', async () => {
    await fake.authCb!('SIGNED_OUT', false, ''); await flush();
    expect(steps()).toHaveLength(0);
  });

  it('does not ask accounts without an authenticator', async () => {
    fake.needs = false;
    await fake.authCb!('SIGNED_IN', true, 'u1'); await flush();
    expect(steps()).toHaveLength(0);
  });
});
