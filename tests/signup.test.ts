import { describe, expect, it } from 'vitest';
import { passwordStrength, validateEmail, validatePassword, validateRegistration, validateUsername } from '../src/signup.js';

const good = { username: 'Skyline_9', email: 'sky@example.com', password: 'correct horse battery', confirm: 'correct horse battery', terms: true, adult: true };

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

describe('the registration form', () => {
  it('accepts a complete form', () => {
    expect(validateRegistration(good, true)).toEqual({ ok: true, errors: {} });
  });
  it('reports every problem at once', () => {
    const bad = validateRegistration({ username: 'a', email: 'nope', password: 'short', confirm: 'x', terms: false, adult: false }, true);
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.errors).sort()).toEqual(['age', 'email', 'password', 'terms', 'username']);
  });
  it('needs the two passwords to match, and says so only once the password itself is fine', () => {
    expect(validateRegistration({ ...good, confirm: 'correct horse battery' + '!' }, true).errors).toEqual({ confirm: 'The passwords do not match.' });
    expect(validateRegistration({ ...good, password: 'short', confirm: 'other' }, true).errors.confirm).toBeUndefined();
  });
  it('requires the age confirmation and the terms, but not a date of birth or a region statement', () => {
    expect(validateRegistration({ ...good, adult: false }, true).errors).toEqual({ age: 'Confirm that you are at least 18 years old.' });
    expect(validateRegistration({ ...good, terms: false }, true).errors.terms).toMatch(/Terms/);
    expect(Object.keys(validateRegistration(good, true).errors)).not.toContain('dob');
  });
  it('the finish-profile step after Google or Steam needs no email or password', () => {
    expect(validateRegistration({ username: 'Skyline_9', terms: true, adult: true }, false).ok).toBe(true);
    expect(validateRegistration({ username: 'Skyline_9', terms: true, adult: true }, true).ok).toBe(false);
  });
});
