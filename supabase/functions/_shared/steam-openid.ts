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
type Fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>;

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

/** Steam's profile name -> a username the site accepts: 2 to 20 letters, digits, spaces, _ or -. Falls back to "Steam" + the last digits of the Steam ID. */
export function usernameFromSteam(raw: string | null | undefined, steamId: string): string {
  const cleaned = (raw ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^A-Za-z0-9_ -]+/g, '_').replace(/_{2,}/g, '_').replace(/ {2,}/g, ' ')
    .replace(/^[\s_-]+|[\s_-]+$/g, '').slice(0, 20).replace(/[\s_-]+$/g, '');
  return cleaned.length >= 2 ? cleaned : `Steam${steamId.slice(-6)}`;
}

/** Reads the profile name from Steam's public XML profile (`?xml=1`), which needs no API key. Null when the profile is private or the reply is odd. */
export function parsePersonaName(xml: string): string | null {
  const m = /<steamID>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/steamID>/.exec(xml);
  const name = (m?.[1] ?? m?.[2] ?? '').trim();
  return name || null;
}

/** The large profile picture from the same XML. Only https URLs on Steam's image hosts are accepted. */
export function parseAvatarUrl(xml: string): string | null {
  const m = /<avatarFull>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/avatarFull>/.exec(xml);
  const url = (m?.[1] ?? m?.[2] ?? '').trim();
  return /^https:\/\/[a-z0-9.-]+\.steamstatic\.com\/[\w./-]+$/i.test(url) ? url : null;
}

export async function fetchSteamProfile(steamId: string, fetchFn: Fetch, timeoutMs = 4000): Promise<{ name: string | null; avatar: string | null }> {
  if (!/^\d{17}$/.test(steamId)) return { name: null, avatar: null };
  try {
    const res = await fetchFn(`https://steamcommunity.com/profiles/${steamId}?xml=1`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { name: null, avatar: null };
    const xml = await res.text();
    return { name: parsePersonaName(xml), avatar: parseAvatarUrl(xml) };
  } catch { return { name: null, avatar: null }; }
}
