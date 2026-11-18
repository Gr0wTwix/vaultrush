// Accessibility and signed-out behaviour from the UX review (docs/ux-review-2026-11-18.md).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initAuth, openAuth } from '../src/auth.js';
import { newGameState, state, setAuthed } from '../src/state.js';
import { SPEEDS, guestCard, modal, reelMs, toast, toastKeep } from '../src/ui.js';

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const press = (key: string, shift = false): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true })); };

let betRan = 0, verifyRan = 0;

beforeAll(async () => {
  document.body.innerHTML = `<div class="app"><header id="topbar"><div class="me-wrap"><button id="meBtn">me</button></div></header>
    <main id="view"><button id="verify" class="btn btn-primary">Verify</button><button id="bet" data-needs-auth="bet">Bet</button>
      <button id="claim" data-needs-auth="claim">Claim</button><button id="join" data-auth-open="register">Create free account</button></main>
    <aside id="chat"><form id="chatForm"><input id="chatInput"><button type="submit">Send</button></form></aside></div><div id="toasts" role="status" aria-live="polite"></div>`;
  q('#verify')!.addEventListener('click', () => { verifyRan++; });
  q('#bet')!.addEventListener('click', () => { betRan++; });
  await initAuth();                  // no backend and no active account in the test environment: signed out
});

beforeEach(() => { localStorage.clear(); state.ui.notify = true; });
/** Close dialogs through their own close button so the page's bookkeeping (open dialog, inert) is reset like a real visit. */
const closeAll = (): void => { document.querySelectorAll<HTMLElement>('.modal-back .modal-x').forEach(b => b.click()); document.querySelectorAll('.modal-back').forEach(e => e.remove()); };
afterEach(closeAll);

describe('signed-out click guard', () => {
  it('lets public tools work and blocks only buttons that opt in', () => {
    q('#verify')!.click();
    expect(verifyRan).toBe(1);
    expect(q('.auth-modal')).toBeNull();
    q('#bet')!.click();
    expect(betRan).toBe(0);
    expect(q('.au-reason')!.textContent).toMatch(/place bets/);
  });

  it('gives each kind of action its own reason', () => {
    q('#claim')!.click();
    expect(q('.au-reason')!.textContent).toMatch(/claim rewards/);
  });

  it('opens Register first for a browser that has never had an account, Log in for one that has', () => {
    q('#bet')!.click();
    expect(q('#auTab-register')!.getAttribute('aria-selected')).toBe('true');
    closeAll();
    localStorage.setItem('vaultrush.known', '1');
    q('#bet')!.click();
    expect(q('#auTab-login')!.getAttribute('aria-selected')).toBe('true');
  });

  it('opens the popup from a guest-card button on the tab it names', () => {
    q('#join')!.click();
    expect(q('#auTab-register')!.getAttribute('aria-selected')).toBe('true');
  });

  it('asks signed-out visitors to log in before they can chat', () => {
    q('#chatForm')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(q('.au-reason')!.textContent).toMatch(/chat/);
  });
});

describe('modal', () => {
  it('is named, takes focus, traps Tab, hides the page and gives focus back', () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    const m = modal('<h2>Settings</h2><input id="a"><button id="b">B</button>');
    const box = q('.modal')!;
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(box.getAttribute('aria-labelledby')!)!.textContent).toBe('Settings');
    expect(document.activeElement!.id).toBe('a');
    expect(q('.app')!.hasAttribute('inert')).toBe(true);
    (q('#b') as HTMLElement).focus(); press('Tab');          // from the last control, Tab wraps to the first
    expect(box.contains(document.activeElement)).toBe(true);
    m.close();
    expect(q('.app')!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('can be locked against Escape and the backdrop, or only against the backdrop', () => {
    const locked = modal('<h2>Locked</h2>', { locked: true });
    press('Escape'); q('.modal-back')!.click();
    expect(q('.modal-back')).not.toBeNull();
    locked.close();
    const keep = modal('<h2>Form</h2>', { backdropClose: false });
    q('.modal-back')!.click();
    expect(q('.modal-back')).not.toBeNull();
    press('Escape');
    expect(q('.modal-back.out')).not.toBeNull();
    keep.close();
  });
});

describe('toasts', () => {
  it('can be switched off in Settings, except errors and messages that must always show', () => {
    state.ui.notify = false;
    const count = (): number => document.querySelectorAll('#toasts .toast').length;
    const before = count();
    toast('plain'); expect(count()).toBe(before);
    toast('oops', 'error'); expect(count()).toBe(before + 1);
    toastKeep('Limit saved'); expect(count()).toBe(before + 2);
  });
});

describe('login popup form', () => {
  const type = (id: string, value: string): void => { const el = q<HTMLInputElement>('#' + id)!; el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };

  it('keeps the typed email when switching tabs and uses real tab semantics', () => {
    openAuth();
    expect(q('[role=tablist]')).not.toBeNull();
    type('auEmail', 'me@example.com');
    q('#auTab-register')!.click();
    expect(q<HTMLInputElement>('#auEmail')!.value).toBe('me@example.com');
    expect(q('#auPanel')!.getAttribute('role')).toBe('tabpanel');
    expect(q('#auTab-register')!.getAttribute('tabindex')).toBe('0');
    expect(q('#auTab-login')!.getAttribute('tabindex')).toBe('-1');
  });

  it('links each error to its field, marks it invalid and summarises it once', () => {
    openAuth({ tab: 'register' });
    q<HTMLFormElement>('#auForm')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(q('#auEmail')!.getAttribute('aria-invalid')).toBe('true');
    expect(q('#auEmail')!.getAttribute('aria-describedby')).toBe('auEmailErr');
    expect(q('#auEmailErr')!.textContent).not.toBe('');
    expect(q('#auFormErr')!.textContent).toMatch(/fix \d+ things/);
    expect(q('.au-err[role=alert]')).toBeNull();            // only the summary is announced
  });

  it('shows the password rule up front and a readable strength label', () => {
    openAuth({ tab: 'register' });
    expect(q('label[for=auPass]')!.textContent).toMatch(/at least 10 characters/);
    type('auPass', 'short');
    expect(q('#auMeterT')!.textContent).toMatch(/Too short/);
    type('auPass', 'a-very-long-passphrase-123');
    expect(q('#auMeterT')!.textContent).toMatch(/Strength: (Good|Strong)/);
  });

  it('labels the Show button and keeps its state in aria-pressed', () => {
    openAuth();
    const b = q('[data-show=auPass]')!;
    expect(b.getAttribute('aria-label')).toBe('Show password');
    b.click();
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(q<HTMLInputElement>('#auPass')!.type).toBe('text');
  });

  it('turns Google and Steam off with a plain explanation when there is no backend', () => {
    openAuth();
    expect(q<HTMLButtonElement>('[data-prov=google]')!.disabled).toBe(true);
    expect(q('#auNote')!.textContent).toMatch(/not available in this demo/);
    expect(q('#auNote')!.textContent).not.toMatch(/supabase/i);
  });

  it('shows the play-money notice for phones and an accessible dialog name', () => {
    openAuth();
    expect(q('.au-playmoney')!.textContent).toMatch(/Play money only/);
    expect(q('.auth-modal')!.getAttribute('aria-label')).toBe('Log in or register');
  });

  it('does not close a half-filled form when the backdrop is clicked', () => {
    openAuth();
    q('.modal-back')!.click();
    expect(q('.auth-modal')).not.toBeNull();
  });
});

describe('guest card and motion defaults', () => {
  it('guest cards carry buttons that open Register and Log in', () => {
    const html = guestCard('Your items live in your account', 'Create one.');
    expect(html).toContain('data-auth-open="register"');
    expect(html).toContain('data-auth-open="login"');
  });

  it('starts visual effects off and reels at turbo for people who ask for reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: /reduce/.test(query), media: query }));
    const fresh = newGameState();
    expect(fresh.ui.fx).toBe(false);
    expect(fresh.speed).toBe('turbo');
    state.speed = 'normal';
    expect(reelMs()).toBe(SPEEDS.turbo);
    vi.unstubAllGlobals();
    expect(newGameState().ui.fx).toBe(true);
    expect(reelMs()).toBe(SPEEDS.normal);
  });
});

describe('signed-in visitors are not guarded', () => {
  it('lets a signed-in player through', () => {
    setAuthed(true);
    betRan = 0; q('#bet')!.click();
    expect(betRan).toBe(1);
    setAuthed(false);
  });
});
