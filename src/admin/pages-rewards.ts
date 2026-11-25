// Step E part 1 of the admin plan (migration 0023): the Rewards page (reward settings, what the free rewards cost, promo codes) and the
// Announcements page (banners and one-time pop-ups on the game site). The database checks and logs every change.
import type { AnnouncementRow, Promo, RewardSettings } from './api.js';
import { errorText } from './api.js';
import { $, $$, coins, esc, reasonDialog, when } from './dom.js';
import type { Page, PageCtx } from './pages.js';

const lockIf = (c: PageCtx, p: string): string => (c.perms.includes(p) ? '' : 'disabled title="You do not hold this permission"');
const nums = (s: string): number[] => s.split(/[\s,;]+/).filter(Boolean).map(Number);
/** A local date-time input value (yyyy-mm-ddThh:mm) to an ISO string, or null when empty. */
const isoOf = (v: string): string | null => (v ? new Date(v).toISOString() : null);
const localOf = (iso: string | null): string => { if (!iso) return ''; const d = new Date(iso); const p = (n: number): string => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const KIND_LABEL: Record<string, string> = { faucet: 'Free coins (faucet)', rakeback: 'Rakeback', calendar: 'Login calendar', promo: 'Promo codes', race: 'Daily race prizes' };

const rewards: Page = {
  title: 'Rewards', perm: 'rewards.view',
  async render(el, c) {
    const canEdit = c.perms.includes('rewards.edit'), canPromo = c.perms.includes('promos.manage');
    const [s, stats, promos] = await Promise.all([c.api.rewardSettings(), c.api.rewardStats(), c.api.promos()]);
    let list: Promo[] = promos;
    const dis = canEdit ? '' : 'disabled';
    el.innerHTML = `<p class="muted">The free rewards the game hands out. The database pays exactly these numbers, and the game site shows them, from the next visit on. Every change asks for a reason and is logged.</p>
      <div class="cards">${stats.kinds.map(k => `<div class="card"><span class="muted small">${esc(KIND_LABEL[k.kind] ?? k.kind)}</span><b>${coins(k.week_sum)}</b><span class="muted small">7 days, ${k.week_count} payouts; today ${coins(k.today_sum)}</span></div>`).join('')}
        ${stats.crates.map(k => `<div class="card"><span class="muted small">Free crates: ${esc(k.kind === 'daily_case' ? 'daily' : k.kind)}</span><b>${k.week}</b><span class="muted small">opened in 7 days</span></div>`).join('')}</div>
      <section class="block"><h2>Settings</h2>${s.updated_by ? `<p class="muted small">Last changed by ${esc(s.updated_by)}, ${esc(when(s.updated_at))}.</p>` : ''}
        <div class="row wrap"><label for="rFa">Free coins per claim</label><input id="rFa" type="number" min="0.01" step="0.01" value="${s.faucet_amount}" ${dis} style="max-width:110px">
          <label for="rFm">every (minutes)</label><input id="rFm" type="number" min="1" max="1440" value="${s.faucet_minutes}" ${dis} style="max-width:90px"></div>
        <div class="row wrap"><label for="rRi">Rakeback % instant</label><input id="rRi" type="number" min="0" max="5" step="0.01" value="${+(s.rakeback.instant * 100).toFixed(3)}" ${dis} style="max-width:90px">
          <label for="rRd">daily</label><input id="rRd" type="number" min="0" max="5" step="0.01" value="${+(s.rakeback.daily * 100).toFixed(3)}" ${dis} style="max-width:90px">
          <label for="rRw">weekly</label><input id="rRw" type="number" min="0" max="5" step="0.01" value="${+(s.rakeback.weekly * 100).toFixed(3)}" ${dis} style="max-width:90px"><span class="muted small">of every stake; at most 5% together</span></div>
        <label for="rCal">Login calendar, days 1 to 7 (coins, separated by commas)</label><input id="rCal" value="${esc(s.calendar.join(', '))}" ${dis}>
        <label for="rRace">Daily race prizes, rank 1 first (coins, separated by commas; 1 to 50 places)</label><input id="rRace" value="${esc(s.race_prizes.join(', '))}" ${dis}>
        <p class="muted small" id="rSum"></p>
        ${canEdit ? '<div class="row"><button class="btn primary" id="rSave">Save settings…</button></div>' : ''}</section>
      <section class="block"><h2>Promo codes</h2><p class="muted small">Each player can use a code once. A code that is off, expired or used up answers like a wrong code. The code itself cannot be renamed; switch it off and make a new one.</p>
        ${canPromo ? `<form id="pNew" class="row wrap"><label for="pCode">Code</label><input id="pCode" maxlength="20" placeholder="SPRING25" style="max-width:150px;text-transform:uppercase">
          <label for="pAmt">Coins</label><input id="pAmt" type="number" min="0.01" step="0.01" style="max-width:100px"><label for="pMax">Uses (empty = no limit)</label><input id="pMax" type="number" min="1" style="max-width:100px">
          <label for="pExp">Ends</label><input id="pExp" type="datetime-local" style="max-width:210px"><label for="pNote">Note</label><input id="pNote" maxlength="200" placeholder="Where it was shared" style="max-width:220px">
          <button class="btn">Create…</button></form>` : ''}
        <div class="tablewrap"><table class="grid"><thead><tr><th>Code</th><th>Coins</th><th>Used</th><th>Ends</th><th>State</th><th></th></tr></thead><tbody id="pRows"></tbody></table></div><div id="pUsers"></div></section>`;

    const read = (): RewardSettings => ({ faucet_amount: Number($<HTMLInputElement>('#rFa', el).value), faucet_minutes: Math.round(Number($<HTMLInputElement>('#rFm', el).value)),
      rakeback: { instant: Number($<HTMLInputElement>('#rRi', el).value) / 100, daily: Number($<HTMLInputElement>('#rRd', el).value) / 100, weekly: Number($<HTMLInputElement>('#rRw', el).value) / 100 },
      calendar: nums($<HTMLInputElement>('#rCal', el).value), race_prizes: nums($<HTMLInputElement>('#rRace', el).value) });
    const check = (n: RewardSettings): string[] => {
      const out: string[] = [], rb = n.rakeback.instant + n.rakeback.daily + n.rakeback.weekly;
      if (!(n.faucet_amount >= 0.01 && n.faucet_amount <= 10000)) out.push('Free coins: 0.01 to 10,000.');
      if (!(n.faucet_minutes >= 1 && n.faucet_minutes <= 1440)) out.push('Minutes: 1 to 1,440.');
      if (![n.rakeback.instant, n.rakeback.daily, n.rakeback.weekly].every(x => x >= 0) || rb > 0.05 + 1e-9) out.push('Rakeback: each at least 0, together at most 5%.');
      if (n.calendar.length !== 7 || n.calendar.some(x => !(x >= 0))) out.push('The calendar needs exactly 7 amounts.');
      if (!n.race_prizes.length || n.race_prizes.length > 50 || n.race_prizes.some(x => !(x >= 0))) out.push('The race needs 1 to 50 prizes.');
      return out;
    };
    const drawSum = (): void => {
      const n = read(), bad = check(n);
      $('#rSum', el).innerHTML = bad.length ? `<span class="neg">${bad.map(esc).join(' ')}</span>`
        : `Per hour a player can take up to ${coins((60 / n.faucet_minutes) * n.faucet_amount)} free coins; a full calendar week pays ${coins(n.calendar.reduce((a, b) => a + b, 0))}; the race pays ${coins(n.race_prizes.reduce((a, b) => a + b, 0))} a day; rakeback returns ${((n.rakeback.instant + n.rakeback.daily + n.rakeback.weekly) * 100).toFixed(2)}% of every stake.`;
      const b = $<HTMLButtonElement>('#rSave', el); if (b) b.disabled = bad.length > 0;
    };
    $$('#rFa, #rFm, #rRi, #rRd, #rRw, #rCal, #rRace', el).forEach(i => i.addEventListener('input', drawSum));
    drawSum();
    $('#rSave', el)?.addEventListener('click', async () => {
      const n = read(); if (check(n).length) return;
      const reason = await reasonDialog('Save the reward settings?', 'The database pays the new numbers at once; players see them on their next visit.', 'Save');
      if (!reason) return;
      try { await c.api.saveRewardSettings(n, reason); c.toast('Saved', 'ok'); c.reload(); } catch (e) { c.toast(errorText(e), 'error'); }
    });

    const drawPromos = (): void => {
      $('#pRows', el).innerHTML = list.map(p => `<tr data-code="${esc(p.code)}"><td><code>${esc(p.code)}</code>${p.note ? `<br><span class="muted small">${esc(p.note)}</span>` : ''}</td><td>${coins(p.amount)}</td>
        <td>${p.uses}${p.max_uses ? ` of ${p.max_uses}` : ''}</td><td class="muted small">${p.expires_at ? esc(when(p.expires_at)) : 'never'}</td>
        <td><span class="pill ${p.live ? 'done' : 'later'}">${p.live ? 'working' : !p.active ? 'off' : p.max_uses !== null && p.uses >= p.max_uses ? 'used up' : 'expired'}</span></td>
        <td class="nowrap"><button class="btn ghost" data-users>Who used it</button>${canPromo ? ` <button class="btn ghost" data-toggle>${p.active ? 'Switch off' : 'Switch on'}</button> <button class="btn ghost" data-edit>Change…</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No codes yet.</td></tr>';
      $$('tr[data-code]', el).forEach(tr => {
        const p = list.find(x => x.code === tr.dataset['code']) as Promo;
        const save = async (next: Partial<Promo>, title: string, label: string): Promise<void> => {
          const reason = await reasonDialog(title, `Code ${p.code}.`, label); if (!reason) return;
          try { await c.api.savePromo({ code: p.code, amount: next.amount ?? p.amount, max_uses: next.max_uses !== undefined ? next.max_uses : p.max_uses, expires_at: next.expires_at !== undefined ? next.expires_at : p.expires_at, active: next.active ?? p.active, note: p.note }, reason); c.toast('Saved', 'ok'); list = await c.api.promos(); drawPromos(); }
          catch (e) { c.toast(errorText(e), 'error'); }
        };
        $('[data-toggle]', tr)?.addEventListener('click', () => void save({ active: !p.active }, `${p.active ? 'Switch off' : 'Switch on'} ${p.code}?`, p.active ? 'Switch off' : 'Switch on'));
        $('[data-edit]', tr)?.addEventListener('click', () => {
          const amt = window.prompt(`Coins for ${p.code}`, String(p.amount)); if (amt === null) return;
          const max = window.prompt('Most uses in total (empty for no limit)', p.max_uses === null ? '' : String(p.max_uses)); if (max === null) return;
          const exp = window.prompt('Ends at (yyyy-mm-dd hh:mm, empty for never)', p.expires_at ? localOf(p.expires_at).replace('T', ' ') : ''); if (exp === null) return;
          void save({ amount: Number(amt), max_uses: max.trim() ? Math.round(Number(max)) : null, expires_at: exp.trim() ? new Date(exp.trim().replace(' ', 'T')).toISOString() : null }, `Change ${p.code}?`, 'Save');
        });
        $('[data-users]', tr).addEventListener('click', async () => {
          const users = await c.api.promoUsers(p.code).catch(e => { c.toast(errorText(e), 'error'); return []; });
          $('#pUsers', el).innerHTML = `<p class="muted small"><b>${esc(p.code)}</b> was used by ${users.length ? users.map(u => `<a href="#/players?id=${esc(u.id)}">${esc(u.name)}</a>`).join(', ') : 'nobody yet'}.</p>`;
        });
      });
    };
    drawPromos();
    const nf = $<HTMLFormElement>('#pNew', el);
    if (nf) nf.onsubmit = async e => {
      e.preventDefault();
      const code = $<HTMLInputElement>('#pCode', el).value.trim().toUpperCase(), amount = Number($<HTMLInputElement>('#pAmt', el).value), maxS = $<HTMLInputElement>('#pMax', el).value;
      if (!/^[A-Z0-9_-]{3,20}$/.test(code)) { c.toast(errorText('invalid_code_format'), 'error'); return; }
      if (list.some(p => p.code === code)) { c.toast('That code already exists: change it in the list instead.', 'error'); return; }
      if (!(amount > 0)) { c.toast('Enter the coins the code gives.', 'error'); return; }
      const reason = await reasonDialog(`Create ${code}?`, `${coins(amount)} coins, once per player${maxS ? `, ${maxS} uses in total` : ''}.`, 'Create'); if (!reason) return;
      try {
        await c.api.savePromo({ code, amount, max_uses: maxS ? Math.round(Number(maxS)) : null, expires_at: isoOf($<HTMLInputElement>('#pExp', el).value), active: true, note: $<HTMLInputElement>('#pNote', el).value.trim() || null }, reason);
        c.toast('Created', 'ok'); nf.reset(); list = await c.api.promos(); drawPromos();
      } catch (er) { c.toast(errorText(er), 'error'); }
    };
  },
};

const announcements: Page = {
  title: 'Announcements', perm: 'announcements.manage',
  async render(el, c) {
    let list: AnnouncementRow[] = [];
    el.innerHTML = `<p class="muted">Messages for everyone on the game site. A <b>banner</b> sits under the top bar until it ends (each player can close it). A <b>pop-up</b> appears once per player. They reach open pages within 30 seconds. For a message to one player, use a warning on the Players page.</p>
      <section class="block"><h2>New announcement</h2><form id="aNew"><div class="row wrap"><label for="aKind">Kind</label><select id="aKind" style="max-width:150px"><option value="banner">Banner</option><option value="popup">Pop-up</option></select>
        <label for="aStyle">Style</label><select id="aStyle" style="max-width:150px"><option value="info">Information</option><option value="win">Good news</option><option value="warn">Warning</option></select>
        <label for="aStart">Starts</label><input id="aStart" type="datetime-local" style="max-width:210px"><label for="aEnd">Ends</label><input id="aEnd" type="datetime-local" style="max-width:210px"></div>
        <label for="aBody">Text (up to 300 characters)</label><textarea id="aBody" rows="2" maxlength="300"></textarea><p class="muted small">Empty start: now. Empty end: until you end it.</p>
        <div class="row"><button class="btn primary">Publish…</button></div></form></section>
      <div class="tablewrap"><table class="grid"><thead><tr><th>Text</th><th>Kind</th><th>Shows</th><th>State</th><th></th></tr></thead><tbody id="aRows"></tbody></table></div>`;
    const draw = (): void => {
      $('#aRows', el).innerHTML = list.map(a => `<tr data-a="${a.id}"><td>${esc(a.body)}<br><span class="muted small">by ${esc(a.by ?? 'staff')}</span></td><td>${a.kind === 'banner' ? 'Banner' : 'Pop-up'}, ${esc(a.style)}</td>
        <td class="muted small">${esc(when(a.starts_at))}<br>${a.ends_at ? `until ${esc(when(a.ends_at))}` : 'until ended'}</td>
        <td><span class="pill ${a.state === 'showing' ? 'done' : a.state === 'scheduled' ? 'next' : 'later'}">${esc(a.state)}</span></td>
        <td>${a.state === 'ended' ? '' : '<button class="btn ghost" data-end>End now…</button>'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No announcements yet.</td></tr>';
      $$('tr[data-a]', el).forEach(tr => $('[data-end]', tr)?.addEventListener('click', async () => {
        const id = +(tr.dataset['a'] as string), reason = await reasonDialog('End this announcement?', 'It disappears from the site within 30 seconds.', 'End'); if (!reason) return;
        try { await c.api.endAnnouncement(id, reason); c.toast('Ended', 'ok'); await load(); } catch (e) { c.toast(errorText(e), 'error'); }
      }));
    };
    const load = async (): Promise<void> => { list = await c.api.announcements(); draw(); };
    $<HTMLFormElement>('#aNew', el).onsubmit = async e => {
      e.preventDefault();
      const body = $<HTMLTextAreaElement>('#aBody', el).value.trim(); if (!body) { c.toast(errorText('text_required'), 'error'); return; }
      const a = { kind: $<HTMLSelectElement>('#aKind', el).value as 'banner' | 'popup', style: $<HTMLSelectElement>('#aStyle', el).value as 'info' | 'warn' | 'win', body,
        starts_at: isoOf($<HTMLInputElement>('#aStart', el).value), ends_at: isoOf($<HTMLInputElement>('#aEnd', el).value) };
      const reason = await reasonDialog(`Publish this ${a.kind === 'banner' ? 'banner' : 'pop-up'}?`, `"${body}" ${a.starts_at ? `from ${when(a.starts_at)}` : 'from now'}.`, 'Publish'); if (!reason) return;
      try { await c.api.announce(a, reason); c.toast('Published', 'ok'); ($<HTMLFormElement>('#aNew', el)).reset(); await load(); } catch (er) { c.toast(errorText(er), 'error'); }
    };
    await load();
  },
};

export const REWARD_PAGES: Record<string, Page> = { rewards, announcements };
