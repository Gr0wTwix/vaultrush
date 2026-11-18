// Steam sign-in uses OpenID 2.0. The browser is redirected to Steam, Steam redirects back with a signed assertion, and the SERVER must
// ask Steam to confirm that assertion ("check_authentication") before trusting the Steam ID in it. Pure Web-API code so it runs in a
// Supabase Edge Function (Deno) and in the unit tests.
export const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
export const NONCE_WINDOW_MS = 5 * 60_000;
/** Fields Steam must have signed. If any is missing from `openid.signed`, an attacker could swap it. */
const REQUIRED_SIGNED = ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle'];

export function buildAuthUrl(returnTo: string, realm: string): string {
  const p = new URLSearchParams({
    'openid.ns': NS, 'openid.mode': 'checkid_setup', 'openid.return_to': returnTo, 'openid.realm': realm,
    'openid.identity': IDENTIFIER_SELECT, 'openid.claimed_id': IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID}?${p.toString()}`;
}

export type SteamResult = { ok: true; steamId: string } | { ok: false; reason: string };
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; text(): Promise<string> }>;

/** `query` is the callback's query string; `returnTo` is the exact URL this server sent to Steam. */
export async function verifySteamAssertion(query: URLSearchParams, returnTo: string, fetchFn: Fetch, now: number = Date.now()): Promise<SteamResult> {
  const get = (k: string): string => query.get(`openid.${k}`) ?? '';
  if (get('ns') !== NS) return { ok: false, reason: 'wrong_namespace' };
  if (get('mode') !== 'id_res') return { ok: false, reason: get('mode') === 'cancel' ? 'cancelled' : 'wrong_mode' };
  if (get('op_endpoint') !== STEAM_OPENID) return { ok: false, reason: 'wrong_endpoint' };
  if (get('return_to') !== returnTo) return { ok: false, reason: 'wrong_return_to' };
  const m = CLAIMED_ID_RE.exec(get('claimed_id'));
  if (!m) return { ok: false, reason: 'bad_claimed_id' };
  if (get('identity') !== get('claimed_id')) return { ok: false, reason: 'identity_mismatch' };
  const signed = get('signed').split(',');
  if (!REQUIRED_SIGNED.every(f => signed.includes(f))) return { ok: false, reason: 'unsigned_fields' };
  const nonce = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z/.exec(get('response_nonce'));
  const issued = nonce ? Date.parse(`${nonce[1]}Z`) : NaN;
  if (!Number.isFinite(issued) || Math.abs(now - issued) > NONCE_WINDOW_MS) return { ok: false, reason: 'stale_nonce' };

  // Ask Steam to confirm its own signature. Every openid.* parameter is echoed back with the mode changed.
  const body = new URLSearchParams();
  for (const [k, v] of query) if (k.startsWith('openid.')) body.set(k, v);
  body.set('openid.mode', 'check_authentication');
  let text: string;
  try {
    const r = await fetchFn(STEAM_OPENID, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (!r.ok) return { ok: false, reason: 'steam_unreachable' };
    text = await r.text();
  } catch { return { ok: false, reason: 'steam_unreachable' }; }
  if (!/^is_valid:true\s*$/m.test(text)) return { ok: false, reason: 'steam_rejected' };
  return { ok: true, steamId: m[1] as string };
}

/** Steam players have no email. The login row needs one, so a reserved, undeliverable address is derived from the Steam ID. */
export const steamEmail = (steamId: string): string => `steam-${steamId}@steam.vaultrush.invalid`;

/** Only redirect back to origins the operator listed (SITE_URLS), never to a URL taken from the request. */
export function safeSite(candidate: string | null, allowed: string[]): string | null {
  if (!candidate) return null;
  try { const u = new URL(candidate); return allowed.includes(u.origin) && (u.protocol === 'https:' || u.hostname === 'localhost') ? u.origin + u.pathname : null; }
  catch { return null; }
}
