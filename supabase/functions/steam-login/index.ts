// Edge Function: "Sign in through Steam".  GET /steam-login?action=start&site=<your site URL>  -> redirects to Steam.
// Steam returns to  /steam-login?action=cb&site=...  where the assertion is verified, a login is created or found for the Steam ID,
// and the browser is sent back to the site with a one-time token it exchanges for a session (supabase.auth.verifyOtp).
//
// Secrets (supabase secrets set ...): SITE_URLS (comma separated allowed site URLs). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase. The service-role key stays inside this function and is never sent to the browser.
// NOT TESTED against live Steam or Supabase: only the verification logic in _shared/steam-openid.ts has unit tests.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildAuthUrl, safeSite, steamEmail, verifySteamAssertion } from '../_shared/steam-openid.ts';

const allowed = (Deno.env.get('SITE_URLS') ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => { try { return new URL(s).origin; } catch { return ''; } }).filter(Boolean);

Deno.serve(async req => {
  const url = new URL(req.url);
  const site = safeSite(url.searchParams.get('site'), allowed);
  if (!site) return new Response('Unknown site', { status: 400 });
  // Behind Supabase's gateway the request URL is http and has lost the /functions/v1 prefix, so build the public address from SUPABASE_URL.
  const self = `${Deno.env.get('SUPABASE_URL')!.replace(/\/+$/, '')}/functions/v1/steam-login`;
  const returnTo = `${self}?action=cb&site=${encodeURIComponent(site)}`;

  if (url.searchParams.get('action') === 'start') return Response.redirect(buildAuthUrl(returnTo, new URL(self).origin), 302);

  const result = await verifySteamAssertion(url.searchParams, returnTo, (u, init) => fetch(u, init));
  if (!result.ok) return Response.redirect(`${site}#steam_error=${encodeURIComponent(result.reason)}`, 302);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const email = steamEmail(result.steamId);
  const created = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { provider: 'steam', steam_id: result.steamId } });
  if (created.error && !/already|registered|exists/i.test(created.error.message)) return Response.redirect(`${site}#steam_error=create_failed`, 302);
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const token = link.data?.properties?.hashed_token;
  if (link.error || !token) return Response.redirect(`${site}#steam_error=link_failed`, 302);
  return Response.redirect(`${site}#steam_token=${encodeURIComponent(token)}`, 302);
});
