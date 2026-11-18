import { describe, expect, it } from 'vitest';
import { passwordStrength, validateDob, validateEmail, validatePassword, validateRegistration, validateUsername } from '../src/signup.js';

const T0 = Date.UTC(2026, 10, 18);
const good = { username: 'Skyline_9', email: 'sky@example.com', password: 'correct horse battery', dob: '1994-05-20', terms: true, adult: true, region: true };

describe('usernames', () => {
  it('accepts normal names', () => { for (const n of ['Sky', 'sky_line-9', 'Two Words', 'ab']) expect(validateUsername(n)).toBeNull(); });
  it('rejects bad characters, bad length, reserved and taken names', () => {
    for (const n of ['a', 'x'.repeat(21), 'bad<name>', 'emoji😀', '', '   ']) expect(validateUsername(n), n).not.toBeNull();
    for (const n of ['Admin', 'SUPPORT', 'VaultRush', 'deleted-1234', 'player-abc123']) expect(validateUsername(n), n).toMatch(/reserved/);
    expect(validateUsername('FROSTBYTE')).toMatch(/another player/);
    expect(validateUsername('Mine', ['mine'])).toMatch(/another player/);
  });
});

describe('emails', () => {
  it('validates the shape', () => {
    for (const e of ['a@b.co', 'first.last+tag@sub.example.org']) expect(validateEmail(e)).toBeNull();
    for (const e of ['', 'plain', 'a@b', 'a b@c.com', '@x.com', `${'a'.repeat(250)}@x.com`]) expect(validateEmail(e), e).not.toBeNull();
  });
});

describe('passwords', () => {
  it('requires length, rejects common, simple and personal passwords', () => {
    expect(validatePassword('short1')).toMatch(/at least 10/);
    expect(validatePassword('password123')).toMatch(/common/);
    expect(validatePassword('aaaaaaaaaaaa')).toMatch(/common|simple/);
    expect(validatePassword('0123456789')).toMatch(/common|simple/);
    expect(validatePassword('x'.repeat(73))).toMatch(/at most 72/);
    expect(validatePassword('ilove-forever-2026', { username: 'Sky_9' })).toBeNull();
    expect(validatePassword('mySky_9password', { username: 'Sky_9' })).toMatch(/username/);
    expect(validatePassword('sky.fan-club-2026', { email: 'sky.fan@example.com' })).toMatch(/email/);
    expect(validatePassword('correct horse battery')).toBeNull();
  });
  it('counts bytes, not characters, against the 72-byte limit', () => {
    expect(validatePassword('éa'.repeat(24))).toBeNull();                       // 72 bytes
    expect(validatePassword('éa'.repeat(25))).toMatch(/at most 72/);            // 75 bytes, only 50 characters
  });
  it('scores strength from 0 to 4 in a sensible order', () => {
    const s = ['', 'abc', 'password123', 'abcdefghij', 'abcdefghijklmn', 'Tr0ub4dor&3-horse-staple'].map(passwordStrength);
    expect(s[0]).toBe(0); expect(s[1]).toBe(1); expect(s[2]).toBe(1);
    expect(s[5]).toBe(4);
    expect(s[3]).toBeLessThanOrEqual(s[4] as number); expect(s[4]).toBeLessThanOrEqual(s[5] as number);
  });
});

describe('date of birth and the registration form', () => {
  it('requires an adult, on the exact birthday', () => {
    expect(validateDob('2008-11-18', T0)).toBeNull();
    expect(validateDob('2008-11-19', T0)).toMatch(/18 or older/);
    expect(validateDob('', T0)).toMatch(/Enter/);
    expect(validateDob('1850-01-01', T0)).not.toBeNull();
  });
  it('accepts a complete form and reports every problem at once otherwise', () => {
    expect(validateRegistration(good, true, T0)).toEqual({ ok: true, errors: {} });
    const bad = validateRegistration({ username: 'a', email: 'nope', password: 'short', dob: '2015-01-01', terms: false, adult: false, region: false }, true, T0);
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.errors).sort()).toEqual(['age', 'dob', 'email', 'password', 'region', 'terms', 'username']);
  });
  it('a local profile needs no email or password', () => {
    expect(validateRegistration({ ...good, email: '', password: '' }, false, T0).ok).toBe(true);
    expect(validateRegistration({ ...good, email: '', password: '' }, true, T0).ok).toBe(false);
  });
});
