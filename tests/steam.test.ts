// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NONCE_WINDOW_MS, STEAM_OPENID, buildAuthUrl, fetchPersonaName, parsePersonaName, safeSite, steamEmail, usernameFromSteam, verifySteamAssertion } from '../supabase/functions/_shared/steam-openid.js';

const RETURN_TO = 'https://abc.functions.supabase.co/steam-login?action=cb&site=https%3A%2F%2Fvaultrush.example';
const ID = 'https://steamcommunity.com/openid/id/76561198000000000';
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const nonce = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z') + 'AbCdEf';

function assertion(over: Record<string, string> = {}): URLSearchParams {
  const base: Record<string, string> = {
    'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res', 'openid.op_endpoint': STEAM_OPENID, 'openid.claimed_id': ID, 'openid.identity': ID,
    'openid.return_to': RETURN_TO, 'openid.response_nonce': nonce(NOW - 1000), 'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle', 'openid.sig': 'c2lnbmF0dXJl', ...over,
  };
  return new URLSearchParams(base);
}
const steam = (reply: string, ok = true) => { const calls: { url: string; body: string }[] = []; return { calls, fn: async (url: string, init: { body: string }) => { calls.push({ url, body: init.body }); return { ok, text: async () => reply }; } }; };

describe('building the Steam redirect', () => {
  it('asks Steam for an identity with the right return URL and realm', () => {
    const u = new URL(buildAuthUrl(RETURN_TO, 'https://abc.functions.supabase.co'));
    expect(`${u.origin}${u.pathname}`).toBe(STEAM_OPENID);
    expect(u.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(u.searchParams.get('openid.return_to')).toBe(RETURN_TO);
    expect(u.searchParams.get('openid.identity')).toMatch(/identifier_select$/);
  });
});

describe('verifying the assertion', () => {
  it('accepts a genuine assertion and returns the 17-digit Steam ID', async () => {
    const s = steam('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n');
    expect(await verifySteamAssertion(assertion(), RETURN_TO, s.fn, NOW)).toEqual({ ok: true, steamId: '76561198000000000' });
    const sent = new URLSearchParams(s.calls[0]!.body);
    expect(s.calls[0]!.url).toBe(STEAM_OPENID);
    expect(sent.get('openid.mode')).toBe('check_authentication');           // echoed back to Steam for confirmation
    expect(sent.get('openid.sig')).toBe('c2lnbmF0dXJl');
  });
  it('rejects when Steam does not confirm it, or cannot be reached', async () => {
    expect(await verifySteamAssertion(assertion(), RETURN_TO, steam('is_valid:false').fn, NOW)).toEqual({ ok: false, reason: 'steam_rejected' });
    expect(await verifySteamAssertion(assertion(), RETURN_TO, steam('', false).fn, NOW)).toEqual({ ok: false, reason: 'steam_unreachable' });
    expect(await verifySteamAssertion(assertion(), RETURN_TO, async () => { throw new Error('network'); }, NOW)).toEqual({ ok: false, reason: 'steam_unreachable' });
  });
  const never = steam('is_valid:true');
  it.each([
    ['openid.ns', 'http://evil', 'wrong_namespace'], ['openid.mode', 'cancel', 'cancelled'], ['openid.mode', 'setup_needed', 'wrong_mode'],
    ['openid.op_endpoint', 'https://evil.example/openid/login', 'wrong_endpoint'], ['openid.return_to', 'https://evil.example/cb', 'wrong_return_to'],
    ['openid.claimed_id', 'https://steamcommunity.com/openid/id/123', 'bad_claimed_id'], ['openid.claimed_id', 'https://evil.example/openid/id/76561198000000000', 'bad_claimed_id'],
    ['openid.identity', 'https://steamcommunity.com/openid/id/76561198999999999', 'identity_mismatch'],
    ['openid.signed', 'signed,op_endpoint,claimed_id,identity,return_to', 'unsigned_fields'],
    ['openid.response_nonce', nonce(NOW - NONCE_WINDOW_MS - 5000), 'stale_nonce'], ['openid.response_nonce', nonce(NOW + NONCE_WINDOW_MS + 5000), 'stale_nonce'], ['openid.response_nonce', 'garbage', 'stale_nonce'],
  ])('rejects a bad %s (%s) without even calling Steam', async (key, value, reason) => {
    never.calls.length = 0;
    expect(await verifySteamAssertion(assertion({ [key]: value }), RETURN_TO, never.fn, NOW)).toEqual({ ok: false, reason });
    expect(never.calls).toHaveLength(0);
  });
  it('rejects an assertion with no parameters at all', async () => {
    expect((await verifySteamAssertion(new URLSearchParams(), RETURN_TO, never.fn, NOW)).ok).toBe(false);
  });
});

describe('helpers', () => {
  it('derives an undeliverable email from the Steam ID', () => { expect(steamEmail('76561198000000000')).toBe('steam-76561198000000000@steam.vaultrush.invalid'); });
  it('only redirects back to listed origins', () => {
    const ok = ['https://vaultrush.example', 'http://localhost:5173'];
    expect(safeSite('https://vaultrush.example/app', ok)).toBe('https://vaultrush.example/app');
    expect(safeSite('http://localhost:5173/', ok)).toBe('http://localhost:5173/');
    for (const bad of ['https://evil.example', 'https://vaultrush.example.evil.example', 'javascript:alert(1)', 'not a url', '', null, 'http://vaultrush.example']) expect(safeSite(bad as string | null, ok), String(bad)).toBeNull();
  });
});

describe('steam username', () => {
  const id = '76561198000123456';
  it('keeps a plain name and trims it to 20 characters', () => {
    expect(usernameFromSteam('Rush Pilot', id)).toBe('Rush Pilot');
    expect(usernameFromSteam('A'.repeat(40), id)).toBe('A'.repeat(20));
  });
  it('removes accents and unsupported characters', () => {
    expect(usernameFromSteam('Zoë★Gamer', id)).toBe('Zoe_Gamer');
    expect(usernameFromSteam('  __cool__  ', id)).toBe('cool');
  });
  it('falls back to the Steam ID when nothing usable is left', () => {
    expect(usernameFromSteam('★★★', id)).toBe('Steam123456');
    expect(usernameFromSteam('', id)).toBe('Steam123456');
    expect(usernameFromSteam(null, id)).toBe('Steam123456');
  });
  it('always satisfies the site username rule', () => {
    for (const raw of ['x', '日本語', 'a'.repeat(19) + '--', 'ok name!!', '🔥🔥Fire🔥🔥']) expect(usernameFromSteam(raw, id)).toMatch(/^[A-Za-z0-9_ -]{2,20}$/);
  });
  it('parses the public profile XML', () => {
    expect(parsePersonaName('<profile><steamID><![CDATA[Rush Pilot]]></steamID></profile>')).toBe('Rush Pilot');
    expect(parsePersonaName('<profile><steamID>Plain</steamID></profile>')).toBe('Plain');
    expect(parsePersonaName('<response><error><![CDATA[The specified profile could not be found.]]></error></response>')).toBeNull();
  });
  it('asks Steam for the name and tolerates failures', async () => {
    const ok = async () => new Response('<profile><steamID><![CDATA[Rush Pilot]]></steamID></profile>');
    expect(await fetchPersonaName(id, ok as never)).toBe('Rush Pilot');
    expect(await fetchPersonaName(id, (async () => { throw new Error('down'); }) as never)).toBeNull();
    expect(await fetchPersonaName('not-an-id', ok as never)).toBeNull();
  });
});
