import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_KEY, activeAccount, activeId, adoptGuestProgress, emailTaken, fairKeyFor, hashPassword, listAccounts, loginLocal, registerLocal, safeEqual, setActive, stateKeyFor, usernameTaken,
} from '../src/accounts.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
beforeEach(() => { localStorage.clear(); });

describe('hashing', () => {
  it('is deterministic for the same salt and different for another salt or password', async () => {
    const salt = new Uint8Array(16).fill(7);
    const a = await hashPassword('correct horse', salt, 1000);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashPassword('correct horse', salt, 1000)).toBe(a);
    expect(await hashPassword('correct horsf', salt, 1000)).not.toBe(a);
    expect(await hashPassword('correct horse', new Uint8Array(16).fill(8), 1000)).not.toBe(a);
  });
  it('matches the PBKDF2 test vector from RFC 7914 (SHA-256, c = 1)', async () => {
    // PBKDF2-HMAC-SHA256("passwd", "salt", c = 1, dkLen = 64) starts with 55ac046e56e3089fec1691c22544b605
    const h = await hashPassword('passwd', new TextEncoder().encode('salt'), 1);
    expect(h.slice(0, 32)).toBe('55ac046e56e3089fec1691c22544b605');
  });
  it('compares strings without early exit and handles length differences', () => {
    expect(safeEqual('abc', 'abc')).toBe(true); expect(safeEqual('abc', 'abd')).toBe(false); expect(safeEqual('abc', 'ab')).toBe(false); expect(safeEqual('', '')).toBe(true);
  });
});

describe('registering', () => {
  it('stores a salted hash, never the password, and lower-cases the email', async () => {
    const r = await registerLocal({ email: 'Sky@Example.com', username: 'Skyline', password: 'correct horse battery' }, T0);
    expect(r.ok).toBe(true);
    const raw = localStorage.getItem('vaultrush.accounts.v1') as string;
    expect(raw).not.toContain('correct horse battery');
    const [a] = listAccounts();
    expect(a).toMatchObject({ email: 'sky@example.com', username: 'Skyline', iterations: 200000, createdAt: T0 });
    expect(a?.hash).toMatch(/^[0-9a-f]{64}$/); expect(a?.salt).toMatch(/^[0-9a-f]{32}$/);
  });
  it('gives two accounts with the same password different hashes', async () => {
    await registerLocal({ email: 'a@x.co', username: 'Aaa', password: 'same password 1' });
    await registerLocal({ email: 'b@x.co', username: 'Bbb', password: 'same password 1' });
    const [a, b] = listAccounts();
    expect(a?.hash).not.toBe(b?.hash);
  });
  it('refuses a duplicate email or username, ignoring case', async () => {
    await registerLocal({ email: 'a@x.co', username: 'Skyline', password: 'correct horse battery' });
    expect(await registerLocal({ email: 'A@X.CO', username: 'Other', password: 'correct horse battery' })).toEqual({ ok: false, error: 'An account with that email already exists.' });
    expect(await registerLocal({ email: 'new@x.co', username: 'SKYLINE', password: 'correct horse battery' })).toEqual({ ok: false, error: 'That username is already taken.' });
    expect(emailTaken('a@x.co')).toBe(true); expect(usernameTaken('skyline')).toBe(true); expect(usernameTaken('nobody')).toBe(false);
    expect(listAccounts()).toHaveLength(1);
  });
});

describe('logging in', () => {
  beforeEach(async () => { await registerLocal({ email: 'sky@example.com', username: 'Skyline', password: 'correct horse battery' }, T0); });
  it('works with the email or the username, in any letter case', async () => {
    for (const who of ['sky@example.com', 'SKY@EXAMPLE.COM', 'skyline', 'SkyLine', '  skyline ']) expect((await loginLocal(who, 'correct horse battery', T0)).ok, who).toBe(true);
  });
  it('gives the same message for a wrong password and an unknown account', async () => {
    const wrong = await loginLocal('skyline', 'nope nope nope', T0), unknown = await loginLocal('ghost', 'correct horse battery', T0);
    expect(wrong).toEqual(unknown);
    expect(wrong).toEqual({ ok: false, error: 'Wrong email, username or password.' });
  });
  it('locks the account for 30 seconds after five wrong passwords, even for the right one', async () => {
    for (let i = 0; i < 5; i++) await loginLocal('skyline', 'bad password ' + i, T0 + i);
    const locked = await loginLocal('skyline', 'correct horse battery', T0 + 1000);
    expect(locked).toMatchObject({ ok: false }); expect((locked as { error: string }).error).toMatch(/Too many attempts/);
    expect((await loginLocal('skyline', 'correct horse battery', T0 + 31_000)).ok).toBe(true);
  });
  it('a successful login resets the failure count', async () => {
    for (let i = 0; i < 4; i++) await loginLocal('skyline', 'bad', T0);
    await loginLocal('skyline', 'correct horse battery', T0);
    for (let i = 0; i < 4; i++) await loginLocal('skyline', 'bad', T0);
    expect((await loginLocal('skyline', 'correct horse battery', T0)).ok).toBe(true);
  });
});

describe('which account is active', () => {
  it('guests use the original storage keys; accounts get their own', () => {
    expect(stateKeyFor('')).toBe('vaultrush.state.v1'); expect(fairKeyFor('')).toBe('vaultrush.fair.v1');
    expect(stateKeyFor('abc')).toBe('vaultrush.state.v1.abc'); expect(fairKeyFor('abc')).toBe('vaultrush.fair.v1.abc');
    expect(activeId()).toBe('');
  });
  it('tracks and clears the active account', async () => {
    const r = await registerLocal({ email: 'a@x.co', username: 'Aaa', password: 'correct horse battery' });
    if (!r.ok) throw new Error('register failed');
    setActive(r.account.id);
    expect(activeId()).toBe(r.account.id); expect(activeAccount()?.username).toBe('Aaa');
    setActive(''); expect(localStorage.getItem(ACTIVE_KEY)).toBeNull(); expect(activeAccount()).toBeNull();
  });
  it('a new account starts from the guest progress without overwriting an existing account', () => {
    localStorage.setItem('vaultrush.state.v1', '{"balance":321}'); localStorage.setItem('vaultrush.fair.v1', '{"nonce":5}');
    adoptGuestProgress('new1');
    expect(localStorage.getItem('vaultrush.state.v1.new1')).toBe('{"balance":321}'); expect(localStorage.getItem('vaultrush.fair.v1.new1')).toBe('{"nonce":5}');
    localStorage.setItem('vaultrush.state.v1.new1', '{"balance":1}');
    adoptGuestProgress('new1');
    expect(localStorage.getItem('vaultrush.state.v1.new1')).toBe('{"balance":1}');
  });
});
