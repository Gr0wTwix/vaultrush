// Account > Verification, the part that counts (admin step F part 1, migration 0026): the verification level the database keeps (it sets the
// most one stake may be), and a request for the next level that staff approve or decline. No documents are collected in this demo.
import { call, explain } from './backend.js';
import { TIER_MAX_BET } from './kyc.js';
import { esc, fmt, toast } from './ui.js';

interface Mine { tier: number; request: null | { id: number; tier: number; status: 'pending' | 'approved' | 'declined' | 'withdrawn'; at: string; decided_at: string | null; note: string | null } }
const CAP = TIER_MAX_BET as Record<number, number>;
const STATUS: Record<string, string> = { pending: 'waiting for staff', approved: 'approved', declined: 'declined', withdrawn: 'withdrawn' };

/** Draws the card into `box` (and again after every action). Shows nothing before migration 0026. */
export async function renderServerVerification(box: HTMLElement): Promise<void> {
  let m: Mine;
  try { m = await call<Mine>('my_verification'); } catch { box.innerHTML = ''; return; }
  const r = m.request, pending = r?.status === 'pending', next = m.tier + 1;
  box.innerHTML = `<div class="ac-card kyc-server"><h3>Your verified level</h3>
    <p class="ac-note">This is the level the server uses: the most one stake may be is <b>${fmt(CAP[m.tier] ?? 0)}</b> at level ${m.tier}. Staff raise it on request. In this demo no documents are collected: it is a manual decision by staff.</p>
    ${r ? `<p class="ac-note">Your last request: level ${r.tier}, <b>${esc(STATUS[r.status] ?? r.status)}</b>${r.decided_at && r.note ? ` (${esc(r.note)})` : ''}.</p>` : ''}
    ${pending ? '<button class="btn btn-ghost" id="kvWithdraw" type="button">Withdraw my request</button>'
      : next <= 2 ? `<label class="small" for="kvNote">Anything staff should know (optional)</label><input id="kvNote" maxlength="300" placeholder="For example: I play high-stakes battles">
        <button class="btn btn-primary" id="kvAsk" type="button">Ask for level ${next} (up to ${fmt(CAP[next] ?? 0)} per stake)</button>` : '<p class="ac-note">You have the highest level.</p>'}</div>`;
  box.querySelector('#kvAsk')?.addEventListener('click', async () => {
    try { await call('request_verification', { p_tier: next, p_note: (box.querySelector('#kvNote') as HTMLInputElement | null)?.value ?? '' }); toast('Request sent to staff'); }
    catch (e) { toast(explain(e as { message?: string }), 'error'); }
    await renderServerVerification(box);
  });
  box.querySelector('#kvWithdraw')?.addEventListener('click', async () => {
    try { await call('withdraw_verification'); toast('Request withdrawn'); } catch (e) { toast(explain(e as { message?: string }), 'error'); }
    await renderServerVerification(box);
  });
}
