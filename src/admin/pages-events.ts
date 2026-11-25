// Step E part 2 of the admin plan (migration 0024): the Events page with races, coin rain and giveaways. The database checks, pays and logs.
import type { AdminGiveaway, AdminRace, AdminRain } from './api.js';
import { errorText } from './api.js';
import { $, $$, coins, esc, reasonDialog, when } from './dom.js';
import type { Page, PageCtx } from './pages.js';

const GAMES: [string, string][] = [['cases', 'Cases'], ['battles', 'Battles'], ['upgrade', 'Upgrade'], ['crash', 'Crash'], ['double', 'Double'], ['plinko', 'Plinko'], ['mines', 'Mines'], ['coinflip', 'Coinflip']];
const lockIf = (c: PageCtx, p: string): string => (c.perms.includes(p) ? '' : 'disabled title="You do not hold this permission"');
const isoOf = (v: string): string | null => (v ? new Date(v).toISOString() : null);
const nums = (s: string): number[] => s.split(/[\s,;]+/).filter(Boolean).map(Number);
const pill = (s: string): string => `<span class="pill ${s === 'running' || s === 'open' ? 'done' : s === 'upcoming' ? 'next' : s === 'ended' ? 'warn' : 'later'}">${esc(s)}</span>`;
async function act(c: PageCtx, title: string, detail: string, label: string, run: (r: string) => Promise<unknown>, done = 'Saved'): Promise<boolean> {
  const reason = await reasonDialog(title, detail, label); if (!reason) return false;
  try { await run(reason); c.toast(done, 'ok'); return true; } catch (e) { c.toast(errorText(e), 'error'); return false; }
}

const events: Page = {
  title: 'Events', perm: 'rewards.view',
  async render(el, c) {
    let tab: 'races' | 'rain' | 'giveaways' = 'races';
    el.innerHTML = `<p class="muted">Events that hand out coins: races with their own prizes, coin rain in the chat, and giveaways with a draw anyone can check. Coins paid here show in the ledger as race, rain or giveaway, and on the Rewards page's cost cards.</p>
      <div class="row wrap"><button class="btn" data-t="races">Races</button><button class="btn ghost" data-t="rain">Coin rain</button><button class="btn ghost" data-t="giveaways">Giveaways</button></div><div id="evBody"></div>`;
    const body = (): HTMLElement => $('#evBody', el);

    const showRaces = async (): Promise<void> => {
      const list: AdminRace[] = await c.api.races();
      body().innerHTML = `<section class="block"><h2>New race</h2><p class="muted small">Players climb the board by the coins they wager in the chosen games between the start and the end. When it has ended, press <b>Pay prizes</b>. The daily race keeps running on its own (its prizes are on the Rewards page).</p>
        <form id="rNew"><div class="row wrap"><label for="rName">Name</label><input id="rName" maxlength="40" placeholder="Weekend Plinko sprint" style="max-width:240px">
          <label for="rStart">Starts</label><input id="rStart" type="datetime-local" style="max-width:210px"><label for="rEnd">Ends</label><input id="rEnd" type="datetime-local" style="max-width:210px"></div>
          <label for="rPrizes">Prizes, place 1 first (coins, separated by commas)</label><input id="rPrizes" placeholder="500, 250, 100">
          <div class="row wrap"><span class="muted small">Games that count (none ticked: every game):</span>${GAMES.map(([k, l]) => `<label class="chk"><input type="checkbox" data-g="${k}"> ${l}</label>`).join('')}</div>
          <div class="row"><button class="btn primary" ${lockIf(c, 'races.manage')}>Create race…</button></div></form></section>
        <div class="tablewrap"><table class="grid"><thead><tr><th>Race</th><th>When</th><th>Prizes</th><th>Leaders</th><th>State</th><th></th></tr></thead><tbody>${list.map(r => `<tr data-r="${r.id}">
          <td><b>${esc(r.name)}</b><br><span class="muted small">${r.games.length ? esc(r.games.join(', ')) : 'every game'}${r.by ? ` · by ${esc(r.by)}` : ''}</span></td>
          <td class="muted small">${esc(when(r.starts_at))}<br>to ${esc(when(r.ends_at))}</td><td>${coins(r.pool)}<br><span class="muted small">${r.prizes.length} place${r.prizes.length === 1 ? '' : 's'}</span></td>
          <td class="small">${(r.state === 'paid' ? r.payouts.map(p => `#${p.rank} ${esc(p.name)} ${coins(p.prize)}`) : r.top.slice(0, 3).map(t => `#${t.rank} ${esc(t.name)} (${coins(t.wagered)})`)).join('<br>') || '<span class="muted">nobody yet</span>'}</td>
          <td>${pill(r.state)}</td>
          <td class="nowrap">${r.state === 'ended' ? `<button class="btn primary" data-pay ${lockIf(c, 'races.manage')}>Pay prizes…</button> ` : ''}${['upcoming', 'running', 'ended'].includes(r.state) ? `<button class="btn ghost" data-cancel ${lockIf(c, 'races.manage')}>Cancel…</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No races yet.</td></tr>'}</tbody></table></div>`;
      $<HTMLFormElement>('#rNew', el).onsubmit = async e => {
        e.preventDefault();
        const name = $<HTMLInputElement>('#rName', el).value.trim(), starts = isoOf($<HTMLInputElement>('#rStart', el).value) ?? new Date().toISOString(), ends = isoOf($<HTMLInputElement>('#rEnd', el).value);
        const prizes = nums($<HTMLInputElement>('#rPrizes', el).value), games = $$<HTMLInputElement>('[data-g]', el).filter(x => x.checked).map(x => x.dataset['g'] as string);
        if (name.length < 2) return c.toast('Give the race a name.', 'error');
        if (!ends) return c.toast('Choose when the race ends.', 'error');
        if (!prizes.length || prizes.some(p => !(p >= 0))) return c.toast('Enter the prizes, place 1 first.', 'error');
        if (await act(c, `Create ${name}?`, `${prizes.length} prizes, ${coins(prizes.reduce((a, b) => a + b, 0))} coins in all, ${games.length ? games.join(', ') : 'every game'}.`, 'Create', r => c.api.saveRace({ id: null, name, starts_at: starts, ends_at: ends, prizes, games }, r), 'Race created')) await showRaces();
      };
      $$('tr[data-r]', el).forEach(tr => {
        const r = list.find(x => x.id === +(tr.dataset['r'] as string)) as AdminRace;
        $('[data-pay]', tr)?.addEventListener('click', async () => { if (await act(c, `Pay the prizes of ${r.name}?`, `Up to ${coins(r.pool)} coins to the top ${r.prizes.length}. This happens once.`, 'Pay', x => c.api.payRace(r.id, x), 'Prizes paid')) await showRaces(); });
        $('[data-cancel]', tr)?.addEventListener('click', async () => { if (await act(c, `Cancel ${r.name}?`, 'It disappears from the site and pays nothing.', 'Cancel race', x => c.api.cancelRace(r.id, x), 'Cancelled')) await showRaces(); });
      });
    };

    const showRain = async (): Promise<void> => {
      const list: AdminRain[] = await c.api.rains();
      const live = list.find(r => !r.settled_at && !r.cancelled_at && Date.parse(r.ends_at) > Date.now());
      body().innerHTML = `<section class="block"><h2>Start a coin rain</h2><p class="muted small">Players see it in the chat and join with one click. When the time is up the pot is split equally between everyone who joined and paid at once. You announce it in the chat automatically. One rain at a time.</p>
        ${live ? `<p class="warn-t">A rain of ${coins(live.pot)} is running until ${esc(when(live.ends_at))} (${live.joiners} joined).</p>` : ''}
        <form id="rnNew" class="row wrap"><label for="rnPot">Pot (coins)</label><input id="rnPot" type="number" min="1" max="100000" step="0.01" value="50" style="max-width:110px">
          <label for="rnSec">Join time</label><select id="rnSec" style="max-width:140px">${[30, 60, 120, 300, 600].map(s => `<option value="${s}" ${s === 60 ? 'selected' : ''}>${s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`}</option>`).join('')}</select>
          <label for="rnLvl">Minimum level</label><input id="rnLvl" type="number" min="0" max="100" value="0" style="max-width:90px">
          <button class="btn primary" ${live ? 'disabled' : ''} ${lockIf(c, 'rain.manage')}>Start rain…</button></form></section>
        <div class="tablewrap"><table class="grid"><thead><tr><th>Started</th><th>Pot</th><th>Joined</th><th>Each got</th><th>State</th><th></th></tr></thead><tbody>${list.map(r => {
          const st = r.cancelled_at ? 'cancelled' : r.settled_at ? 'paid' : Date.parse(r.ends_at) > Date.now() ? 'running' : 'ended';
          return `<tr data-rn="${r.id}"><td class="muted small">${esc(when(r.starts_at))}${r.by ? `<br>by ${esc(r.by)}` : ''}</td><td>${coins(r.pot)}${r.min_level ? `<br><span class="muted small">level ${r.min_level}+</span>` : ''}</td><td>${r.joiners}</td>
            <td>${r.share === null ? '' : coins(r.share)}</td><td>${pill(st)}</td><td>${st === 'running' ? `<button class="btn ghost" data-cancel ${lockIf(c, 'rain.manage')}>Cancel…</button>` : ''}</td></tr>`;
        }).join('') || '<tr><td colspan="6" class="muted">No rain yet.</td></tr>'}</tbody></table></div>`;
      $<HTMLFormElement>('#rnNew', el).onsubmit = async e => {
        e.preventDefault();
        const pot = Number($<HTMLInputElement>('#rnPot', el).value), secs = Number($<HTMLSelectElement>('#rnSec', el).value), lvl = Math.round(Number($<HTMLInputElement>('#rnLvl', el).value) || 0);
        if (!(pot >= 1 && pot <= 100000)) return c.toast('The pot is 1 to 100,000 coins.', 'error');
        if (await act(c, `Start a ${coins(pot)} coin rain?`, `Players can join for ${secs} seconds${lvl ? ` from level ${lvl}` : ''}. It is announced in the chat in your name.`, 'Start', r => c.api.startRain(pot, secs, lvl, r), 'Rain started')) await showRain();
      };
      $$('tr[data-rn]', el).forEach(tr => $('[data-cancel]', tr)?.addEventListener('click', async () => {
        if (await act(c, 'Cancel this rain?', 'Nobody is paid.', 'Cancel rain', r => c.api.cancelRain(+(tr.dataset['rn'] as string), r), 'Cancelled')) await showRain();
      }));
    };

    const showGiveaways = async (): Promise<void> => {
      const list: AdminGiveaway[] = await c.api.giveaways();
      body().innerHTML = `<section class="block"><h2>New giveaway</h2><p class="muted small">Players enter on the Rewards page while it is open. When it closes, press <b>Draw</b>: the winners are picked from a secret seed whose fingerprint was published when the giveaway was created, and each winner gets the prize. After the draw the seed is shown so anyone can check it.</p>
        <form id="gNew"><div class="row wrap"><label for="gTitle">Title</label><input id="gTitle" maxlength="60" placeholder="1,000 coin Friday giveaway" style="max-width:260px">
          <label for="gPrize">Prize per winner</label><input id="gPrize" type="number" min="0.01" step="0.01" style="max-width:110px"><label for="gWin">Winners</label><input id="gWin" type="number" min="1" max="100" value="1" style="max-width:80px">
          <label for="gLvl">Minimum level</label><input id="gLvl" type="number" min="0" max="100" value="0" style="max-width:80px"></div>
          <div class="row wrap"><label for="gStart">Opens</label><input id="gStart" type="datetime-local" style="max-width:210px"><label for="gEnd">Closes</label><input id="gEnd" type="datetime-local" style="max-width:210px">
          <button class="btn primary" ${lockIf(c, 'giveaways.manage')}>Create giveaway…</button></div></form></section>
        <div class="tablewrap"><table class="grid"><thead><tr><th>Giveaway</th><th>Prize</th><th>Entries</th><th>When</th><th>State</th><th></th></tr></thead><tbody>${list.map(g => `<tr data-g="${g.id}">
          <td><b>${esc(g.title)}</b><br><span class="muted small">fingerprint <code>${esc(g.server_hash.slice(0, 16))}…</code>${g.seed ? `<br>seed <code>${esc(g.seed.slice(0, 16))}…</code>` : ''}</span>${g.drawn ? `<br><span class="small">Winners: ${g.drawn.map(w => `${esc(w.name)} (#${w.entry_no})`).join(', ') || 'nobody entered'}</span>` : ''}</td>
          <td>${coins(g.prize)} × ${g.winners}${g.min_level ? `<br><span class="muted small">level ${g.min_level}+</span>` : ''}</td><td>${g.entries}</td>
          <td class="muted small">${esc(when(g.starts_at))}<br>to ${esc(when(g.ends_at))}</td><td>${pill(g.state)}</td>
          <td class="nowrap">${g.state === 'ended' ? `<button class="btn primary" data-draw ${lockIf(c, 'giveaways.manage')}>Draw…</button> ` : ''}${['upcoming', 'open', 'ended'].includes(g.state) ? `<button class="btn ghost" data-cancel ${lockIf(c, 'giveaways.manage')}>Cancel…</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No giveaways yet.</td></tr>'}</tbody></table></div>`;
      $<HTMLFormElement>('#gNew', el).onsubmit = async e => {
        e.preventDefault();
        const title = $<HTMLInputElement>('#gTitle', el).value.trim(), prize = Number($<HTMLInputElement>('#gPrize', el).value), winners = Math.round(Number($<HTMLInputElement>('#gWin', el).value));
        const lvl = Math.round(Number($<HTMLInputElement>('#gLvl', el).value) || 0), starts = isoOf($<HTMLInputElement>('#gStart', el).value), ends = isoOf($<HTMLInputElement>('#gEnd', el).value);
        if (title.length < 2) return c.toast('Give the giveaway a title.', 'error');
        if (!(prize > 0)) return c.toast('Enter the prize per winner.', 'error');
        if (!(winners >= 1 && winners <= 100)) return c.toast('1 to 100 winners.', 'error');
        if (!ends) return c.toast('Choose when entries close.', 'error');
        if (await act(c, `Create ${title}?`, `${winners} × ${coins(prize)} coins (${coins(prize * winners)} in all).`, 'Create', r => c.api.createGiveaway({ title, prize, winners, min_level: lvl, starts_at: starts, ends_at: ends }, r), 'Giveaway created')) await showGiveaways();
      };
      $$('tr[data-g]', el).forEach(tr => {
        const g = list.find(x => x.id === +(tr.dataset['g'] as string)) as AdminGiveaway;
        $('[data-draw]', tr)?.addEventListener('click', async () => { if (await act(c, `Draw ${g.title}?`, `${g.entries} entries, ${g.winners} winner${g.winners === 1 ? '' : 's'} of ${coins(g.prize)}. The seed is revealed.`, 'Draw', r => c.api.drawGiveaway(g.id, r), 'Drawn and paid')) await showGiveaways(); });
        $('[data-cancel]', tr)?.addEventListener('click', async () => { if (await act(c, `Cancel ${g.title}?`, 'Nobody is paid.', 'Cancel giveaway', r => c.api.cancelGiveaway(g.id, r), 'Cancelled')) await showGiveaways(); });
      });
    };

    const show = async (): Promise<void> => {
      $$('[data-t]', el).forEach(b => b.classList.toggle('ghost', b.dataset['t'] !== tab));
      body().innerHTML = '<p class="muted">Loading…</p>';
      try { await (tab === 'races' ? showRaces() : tab === 'rain' ? showRain() : showGiveaways()); } catch (e) { body().innerHTML = `<p class="err" role="alert">${esc(errorText(e))}</p>`; }
    };
    $$('[data-t]', el).forEach(b => b.addEventListener('click', () => { tab = b.dataset['t'] as typeof tab; void show(); }));
    await show();
  },
};

export const EVENT_PAGES: Record<string, Page> = { events };
