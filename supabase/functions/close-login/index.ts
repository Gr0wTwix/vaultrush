// Edge Function: finishes account deletion. The database function delete_account() has already anonymised the profile and zeroed the
// wallet (it runs as the caller). This part needs the service role: it scrambles the login email and bans the login so it can never
// sign in again. The auth.users row is kept (not deleted) because bets and the ledger are financial records that reference the profile.
// NOT TESTED against a live Supabase project.
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async req => {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return new Response('Unauthorized', { status: 401 });
  const profile = await admin.from('profiles').select('deleted_at').eq('id', data.user.id).maybeSingle();
  if (!profile.data?.deleted_at) return new Response('Run delete_account() first', { status: 409 });   // never close a login that was not anonymised
  const r = await admin.auth.admin.updateUserById(data.user.id, { email: `deleted-${data.user.id}@deleted.vaultrush.invalid`, ban_duration: '876000h', user_metadata: {} });
  return r.error ? new Response('Failed', { status: 500 }) : new Response('ok');
});
