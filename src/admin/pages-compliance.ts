// Step F part 1 of the admin plan (migration 0026): the Compliance page. Verification requests (staff approve or decline a higher level; no
// documents in this demo) and the responsible-play console (who is excluded or on a break, loosenings waiting their 24 hours, the biggest
// losses and the busiest players), with tools that can only make things safer for a player.
import type { KycRequest, PlayerRow, RgKind, RgOverview } from './api.js';
import { errorText } from './api.js';
import { $, $$, coins, esc, reasonDialog, when } from './dom.js';
import type { Page, PageCtx } from './pages.js';

const CAPS = ['10,000', '25,000', '50,000'];
const LIMIT_LABEL: Record<string, string> = { max_bet: 'Largest single stake', loss_daily: 'Daily loss', loss_weekly: 'Weekly loss', loss_monthly: 'Monthly loss', wager_daily: 'Daily wager', time_daily_min: 'Daily play time (minutes)' };
const lockIf = (c: PageCtx, p: string): string => (c.perms.includes(p) ? '' : 'disabled title="You do not hold this permission"');
const who = (id: string, name: string): string => `<a href="#/players?id=${esc(id)}">${esc(name)}</a>`;

const compliance: Page = {
  title: 'Compliance', perm: 'compliance.view',
  async render(el, c) {
    let tab: 'kyc' | 'rg' = 'kyc', status = 'pending';
    const canRg = c.perms.includes('rg.view');
    el.innerHTML = `<p class="muted">Verification levels and responsible play. This is a play-money demo: verification is a manual staff decision with no documents. Every decision asks for a reason and is logged.</p>
      <div class="row wrap"><button class="btn" data-t="kyc">Verification requests</button>${canRg ? '<button class="btn ghost" data-t="rg">Responsible play</button>' : ''}</div><div id="cBody"></div>`;
    const body = (): HTMLElement => $('#cBody', el);

    const showKyc = async (): Promise<void> => {
      const list: KycRequest[] = await c.api.kycQueue(status || null);
      body().innerHTML = `<p class="muted small">A player's level sets the most one stake may be: level 0 up to ${CAPS[0]}, level 1 up to ${CAPS[1]}, level 2 up to ${CAPS[2]}. Approving raises it at once.</p>
        <div class="row wrap"><label for="kSt">Show</label><select id="kSt" style="max-width:200px">${[['pending', 'Waiting'], ['approved', 'Approved'], ['declined', 'Declined'], ['withdrawn', 'Withdrawn'], ['', 'All']].map(([v, l]) => `<option value="${v}" ${v === status ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="tablewrap"><table class="grid"><thead><tr><th>Player</th><th>Asks for</th><th>Now</th><th>Wagered</th><th>Note</th><th>State</th><th></th></tr></thead><tbody>${list.map(r => `<tr data-k="${r.id}">
          <td>${who(r.user_id, r.name)}<br><span class="muted small">joined ${esc(when(r.joined))}</span>${r.flags.length ? `<br>${r.flags.map(f => `<span class="pill warn">${esc(f)}</span>`).join(' ')}` : ''}</td>
          <td>level ${r.tier}<br><span class="muted small">up to ${CAPS[r.tier] ?? ''}</span></td><td>level ${r.current_tier}</td><td>${r.wagered === null ? '' : coins(r.wagered)}</td><td class="small">${esc(r.note)}</td>
          <td><span class="pill ${r.status === 'pending' ? 'next' : r.status === 'approved' ? 'done' : 'later'}">${esc(r.status)}</span>${r.decided_at ? `<br><span class="muted small">${esc(r.by ?? '')} ${esc(when(r.decided_at))}${r.decision_note ? `: ${esc(r.decision_note)}` : ''}</span>` : ''}</td>
          <td class="nowrap">${r.status === 'pending' ? `<button class="btn primary" data-ok ${lockIf(c, 'compliance.review')}>Approve…</button> <button class="btn ghost" data-no ${lockIf(c, 'compliance.review')}>Decline…</button>` : `<button class="btn ghost" data-set ${lockIf(c, 'compliance.review')}>Set level…</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nothing here.</td></tr>'}</tbody></table></div>`;
      $<HTMLSelectElement>('#kSt', el).onchange = () => { status = $<HTMLSelectElement>('#kSt', el).value; void showKyc(); };
      $$('tr[data-k]', el).forEach(tr => {
        const r = list.find(x => x.id === +(tr.dataset['k'] as string)) as KycRequest;
        const decide = async (ok: boolean): Promise<void> => {
          const reason = await reasonDialog(`${ok ? 'Approve' : 'Decline'} level ${r.tier} for ${r.name}?`, ok ? `Their largest stake becomes ${CAPS[r.tier]}. They see your reason.` : 'Their level stays. They see your reason.', ok ? 'Approve' : 'Decline');
          if (!reason) return;
          try { await c.api.kycDecide(r.id, ok, reason); c.toast(ok ? 'Approved' : 'Declined', 'ok'); await showKyc(); } catch (e) { c.toast(errorText(e), 'error'); }
        };
        $('[data-ok]', tr)?.addEventListener('click', () => void decide(true));
        $('[data-no]', tr)?.addEventListener('click', () => void decide(false));
        $('[data-set]', tr)?.addEventListener('click', async () => {
          const v = window.prompt(`New level for ${r.name} (0, 1 or 2)`, String(r.current_tier)); if (v === null) return;
          const tier = Math.round(Number(v)); if (![0, 1, 2].includes(tier)) { c.toast(errorText('invalid_tier'), 'error'); return; }
          const reason = await reasonDialog(`Set ${r.name} to level ${tier}?`, `Their largest stake becomes ${CAPS[tier]}.`, 'Set level'); if (!reason) return;
          try { await c.api.kycSetTier(r.user_id, tier, reason); c.toast('Saved', 'ok'); await showKyc(); } catch (e) { c.toast(errorText(e), 'error'); }
        });
      });
    };

    const showRg = async (): Promise<void> => {
      const o: RgOverview = await c.api.rgOverview();
      const table = (head: string, rows: string): string => `<div class="tablewrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
      body().innerHTML = `<section class="block"><h2>Make things safer for a player</h2><p class="muted small">Staff can start or extend a break or a self-exclusion and tighten a limit, never shorten or loosen anything. Tightening also cancels a loosening the player was waiting for. The player can see the change in their Responsible Play settings.</p>
          <form id="rgFind" class="row wrap"><label class="sr" for="rgQ">Player</label><input id="rgQ" placeholder="Player name or id" style="max-width:240px"><button class="btn ghost">Find</button></form><div id="rgPick"></div>
          <form id="rgForm" class="row wrap" hidden><b id="rgWho"></b><label for="rgKind">Action</label><select id="rgKind" style="max-width:240px">
            <option value="cool_off">Break (hours)</option><option value="exclude">Self-exclusion (days)</option>${Object.entries(LIMIT_LABEL).map(([k, l]) => `<option value="${k}">Limit: ${esc(l)}</option>`).join('')}</select>
            <label for="rgVal">Value</label><input id="rgVal" type="number" min="0" step="0.01" style="max-width:130px"><button class="btn danger" ${lockIf(c, 'rg.apply')}>Apply…</button></form></section>
        <div class="two"><section class="block"><h2>Self-excluded</h2>${table('<th>Player</th><th>Until</th>', o.excluded.map(x => `<tr><td>${who(x.id, x.name)}</td><td class="small">${esc(when(x.until))}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">Nobody.</td></tr>')}</section>
          <section class="block"><h2>On a break</h2>${table('<th>Player</th><th>Until</th>', o.cool_off.map(x => `<tr><td>${who(x.id, x.name)}</td><td class="small">${esc(when(x.until))}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">Nobody.</td></tr>')}</section></div>
        <section class="block"><h2>Loosened limits waiting their 24 hours</h2>${table('<th>Player</th><th>Limit</th><th>New value</th><th>Applies</th>', o.pending.map(x => `<tr><td>${who(x.id, x.name)}</td><td>${esc(LIMIT_LABEL[x.key] ?? x.key)}</td><td>${x.value === null ? 'removed' : coins(x.value)}</td><td class="small">${esc(when(x.effective_at))}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None.</td></tr>')}</section>
        <div class="two"><section class="block"><h2>Biggest losses, 7 days</h2>${table('<th>Player</th><th>Lost</th><th>Staked</th><th>Bets</th>', o.losses_7d.map(x => `<tr><td>${who(x.id, x.name)}</td><td class="neg">${coins(x.net_loss)}</td><td>${coins(x.staked)}</td><td>${x.bets}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No losses.</td></tr>')}</section>
          <section class="block"><h2>Busiest today</h2>${table('<th>Player</th><th>Bets</th><th>Staked</th><th>Minutes</th>', o.busy_today.map(x => `<tr><td>${who(x.id, x.name)}</td><td>${x.bets}</td><td>${coins(x.staked)}</td><td>${x.minutes}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No bets today.</td></tr>')}</section></div>
        <p class="muted small">Play time is estimated from bets (the server cannot see an open page).</p>`;
      let target: PlayerRow | null = null;
      $<HTMLFormElement>('#rgFind', el).onsubmit = async e => {
        e.preventDefault();
        const found = await c.api.players($<HTMLInputElement>('#rgQ', el).value.trim(), '').catch(er => { c.toast(errorText(er), 'error'); return [] as PlayerRow[]; });
        $('#rgPick', el).innerHTML = found.slice(0, 10).map(p => `<button class="btn ghost" data-p="${esc(p.id)}">${esc(p.name)}</button>`).join(' ') || '<p class="muted small">Nobody found.</p>';
        $$('[data-p]', el).forEach(b => b.addEventListener('click', () => { target = found.find(p => p.id === b.dataset['p']) ?? null; if (!target) return; $('#rgWho', el).textContent = target.name; $<HTMLFormElement>('#rgForm', el).hidden = false; }));
      };
      $<HTMLFormElement>('#rgForm', el).onsubmit = async e => {
        e.preventDefault(); if (!target) return;
        const kind = $<HTMLSelectElement>('#rgKind', el).value as RgKind, value = Number($<HTMLInputElement>('#rgVal', el).value);
        if (!(value >= 0) || $<HTMLInputElement>('#rgVal', el).value === '') { c.toast('Enter a value.', 'error'); return; }
        const what = kind === 'cool_off' ? `a break of ${value} hours` : kind === 'exclude' ? `a self-exclusion of ${value} days` : `${LIMIT_LABEL[kind]} at ${value}`;
        const reason = await reasonDialog(`Apply ${what} to ${target.name}?`, 'This can only be extended or tightened later, not undone by staff.', 'Apply'); if (!reason) return;
        try { await c.api.rgApply(target.id, kind, value, reason); c.toast('Applied', 'ok'); await showRg(); } catch (er) { c.toast(errorText(er), 'error'); }
      };
    };

    const show = async (): Promise<void> => {
      $$('[data-t]', el).forEach(b => b.classList.toggle('ghost', b.dataset['t'] !== tab));
      body().innerHTML = '<p class="muted">Loading…</p>';
      try { await (tab === 'kyc' ? showKyc() : showRg()); } catch (e) { body().innerHTML = `<p class="err" role="alert">${esc(errorText(e))}</p>`; }
    };
    $$('[data-t]', el).forEach(b => b.addEventListener('click', () => { tab = b.dataset['t'] as typeof tab; void show(); }));
    await show();
  },
};

export const COMPLIANCE_PAGES: Record<string, Page> = { compliance };
