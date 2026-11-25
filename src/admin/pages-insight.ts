// Step F part 2 of the admin plan (migration 0027): the Fairness page (re-check seeds and results in bulk) and the Economy page (where coins come
// from and go, and what each game took against its maths). Both only read.
import type { Economy, FairnessRun } from './api.js';
import { errorText } from './api.js';
import { $, coins, esc, when } from './dom.js';
import type { Page } from './pages.js';

const KIND: Record<string, string> = { crash: 'Crash round', double: 'Double round', coinflip: 'Coinflip', battle: 'Battle', seed: 'Personal seed pair' };
const GAME: Record<string, string> = { cases: 'Cases', battles: 'Battles', upgrade: 'Upgrade', crash: 'Crash', double: 'Double', plinko: 'Plinko', mines: 'Mines', coinflip: 'Coinflip' };
const FLOW: Record<string, string> = { bonus: 'Starting and test bonuses', faucet: 'Free coins (faucet)', rakeback: 'Rakeback', calendar: 'Login calendar', promo: 'Promo codes', race: 'Race prizes',
  rain: 'Coin rain', giveaway: 'Giveaways', crate: 'Free crates', adjustment: 'Staff adjustments', bet: 'Stakes', win: 'Winnings', sell: 'Items sold', refund: 'Refunds' };
const FREE = ['bonus', 'faucet', 'rakeback', 'calendar', 'promo', 'race', 'rain', 'giveaway', 'crate'];
const pct = (x: number | null): string => (x === null ? '' : `${(x * 100).toFixed(1)}%`);

const fairness: Page = {
  title: 'Fairness', perm: 'fairness.view',
  async render(el, c) {
    const canRun = c.perms.includes('fairness.run');
    let runs: FairnessRun[] = await c.api.fairnessRuns();
    el.innerHTML = `<p class="muted">Re-checks what the games did. For every finished Crash and Double round and every coinflip, the revealed seed must match the fingerprint (SHA-256 hash) published before the game, and must give exactly the recorded result. Battles and personal seed pairs are checked against their fingerprints (a battle's pulls can be re-checked one by one on the game's Fairness page). Shared rounds are kept for 3 days.</p>
      <div class="row wrap"><label for="fDays">Check the last</label><select id="fDays" style="max-width:120px">${[1, 3, 7, 30].map(d => `<option value="${d}" ${d === 3 ? 'selected' : ''}>${d} day${d === 1 ? '' : 's'}</option>`).join('')}</select>
        <button class="btn primary" id="fRun" ${canRun ? '' : 'disabled title="You do not hold this permission"'}>Run the audit</button></div><div id="fResult"></div>
      <h2>Earlier runs</h2><div class="tablewrap"><table class="grid"><thead><tr><th>When</th><th>By</th><th>Window</th><th>Checked</th><th>Result</th></tr></thead><tbody id="fRuns"></tbody></table></div>`;
    const total = (r: FairnessRun): number => r.summary.rounds.checked + r.summary.coinflips.checked + r.summary.battles.checked + r.summary.seeds.checked;
    const drawRuns = (): void => {
      $('#fRuns', el).innerHTML = runs.map(r => `<tr><td class="small">${esc(when(r.at))}</td><td>${esc(r.by ?? '')}</td><td>${r.days} day${r.days === 1 ? '' : 's'}</td><td>${total(r)}</td>
        <td>${r.summary.all_ok ? '<span class="pill done">all match</span>' : `<span class="pill warn">${r.mismatches.length} problem${r.mismatches.length === 1 ? '' : 's'}</span>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No audit has been run yet.</td></tr>';
    };
    const drawResult = (r: FairnessRun): void => {
      const s = r.summary;
      $('#fResult', el).innerHTML = `<div class="cards">${([['Crash and Double rounds', s.rounds], ['Coinflips', s.coinflips], ['Battles (seed only)', s.battles], ['Personal seed pairs', s.seeds]] as const)
        .map(([l, x]) => `<div class="card"><span class="muted small">${l}</span><b class="${x.bad ? 'neg' : 'pos'}">${x.checked - x.bad} of ${x.checked}</b><span class="muted small">${x.bad ? `${x.bad} do not match` : 'all match'}</span></div>`).join('')}</div>
        ${r.mismatches.length ? `<p class="err" role="alert">These did not check out. A mismatch means the recorded result or the published fingerprint was changed after the game, or a bug: look at each before telling players.</p>
          <div class="tablewrap"><table class="grid"><thead><tr><th>What</th><th>Id</th><th>Seed matches fingerprint</th><th>Seed gives the recorded result</th></tr></thead><tbody>${r.mismatches.map(m => `<tr><td>${esc(KIND[m.kind] ?? m.kind)}</td><td><code>${esc(m.id)}</code></td><td>${m.hash_ok ? 'yes' : '<b class="neg">no</b>'}</td><td>${m.result_ok === null ? '<span class="muted">not checked</span>' : m.result_ok ? 'yes' : '<b class="neg">no</b>'}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="pos">Every seed matches its fingerprint and gives the recorded result.</p>'}`;
    };
    drawRuns();
    if (runs[0]) drawResult(runs[0]);
    $('#fRun', el).addEventListener('click', async () => {
      const b = $<HTMLButtonElement>('#fRun', el); b.disabled = true; b.textContent = 'Checking…';
      try { const r = await c.api.fairnessRun(Number($<HTMLSelectElement>('#fDays', el).value)); drawResult(r); runs = await c.api.fairnessRuns(); drawRuns(); c.toast(r.summary.all_ok ? 'All match' : 'Problems found', r.summary.all_ok ? 'ok' : 'error'); }
      catch (e) { c.toast(errorText(e), 'error'); }
      finally { b.disabled = false; b.textContent = 'Run the audit'; }
    });
  },
};

const economy: Page = {
  title: 'Economy', perm: 'economy.view',
  async render(el, c) {
    let days = 30;
    el.innerHTML = `<p class="muted">Where coins come from and where they go. Free coins (faucet, rewards, events, bonuses) enter the economy; the games' edge takes coins out. Play money only: nothing here is real money.</p>
      <div class="row wrap"><label for="eDays">Period</label><select id="eDays" style="max-width:140px">${[7, 30, 90].map(d => `<option value="${d}" ${d === days ? 'selected' : ''}>${d} days</option>`).join('')}</select></div><div id="eBody"><p class="muted">Loading…</p></div>`;
    const draw = (e: Economy): void => {
      const free = e.flows.filter(f => FREE.includes(f.kind)), adj = e.flows.filter(f => f.kind === 'adjustment'), game = e.flows.filter(f => ['bet', 'win', 'sell', 'refund'].includes(f.kind));
      const sum = (xs: { sum: number }[]): number => xs.reduce((s, x) => s + Number(x.sum), 0);
      const maxDay = Math.max(1, ...e.daily.map(d => Math.max(Math.abs(d.free + d.adjust), Math.abs(d.games))));
      $('#eBody', el).innerHTML = `<div class="cards">
          <div class="card"><span class="muted small">Coins in wallets now</span><b>${coins(e.now.coins)}</b><span class="muted small">${e.now.wallets_with_coins} wallets hold coins; median ${coins(e.now.median_balance)}</span></div>
          <div class="card"><span class="muted small">Items held</span><b>${e.now.items}</b><span class="muted small">worth ${coins(e.now.items_value)}</span></div>
          <div class="card"><span class="muted small">Free coins given, ${e.days} days</span><b>${coins(sum(free))}</b><span class="muted small">plus ${coins(sum(adj))} by staff adjustments</span></div>
          <div class="card"><span class="muted small">Games' net, ${e.days} days</span><b class="${sum(game) < 0 ? 'pos' : 'neg'}">${coins(sum(game))}</b><span class="muted small">${sum(game) < 0 ? 'taken out of wallets by the games' : 'paid out more than staked'}</span></div></div>
        <section class="block"><h2>Each game against its maths</h2><p class="muted small">"Returned" is what players got back for each coin staked; "Maths says" is what the game's rules give on average (Cases and Battles from the cases that were played). With few bets the two can differ a lot by chance.</p>
          <div class="tablewrap"><table class="grid"><thead><tr><th>Game</th><th>Bets</th><th>Staked</th><th>Paid back</th><th>House took</th><th>Returned</th><th>Maths says</th></tr></thead><tbody>${e.games.map(g => `<tr><td>${esc(GAME[g.game] ?? g.game)}</td><td>${g.bets}</td><td>${coins(g.staked)}</td><td>${coins(g.paid)}</td>
            <td class="${g.take < 0 ? 'neg' : ''}">${coins(g.take)}</td><td>${pct(g.return)}</td><td class="muted">${pct(g.expected)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No bets in this period.</td></tr>'}</tbody></table></div></section>
        <section class="block"><h2>Day by day</h2><p class="muted small">Green: free coins and staff adjustments added. Red: the games' net (below zero means the games took coins out).</p>
          <div class="econ-days">${e.daily.map(d => `<div class="econ-day" title="${esc(d.day)}: +${coins(d.free + d.adjust)} free, games ${coins(d.games)}"><span class="half top"><i class="up" style="height:${Math.round((Math.max(0, d.free + d.adjust) / maxDay) * 100)}%"></i></span><span class="half bot"><i class="down" style="height:${Math.round((Math.max(0, -d.games) / maxDay) * 100)}%"></i></span></div>`).join('')}</div></section>
        <div class="two"><section class="block"><h2>Where coins moved</h2><div class="tablewrap"><table class="grid"><thead><tr><th>Kind</th><th>Times</th><th>Coins</th></tr></thead><tbody>${e.flows.map(f => `<tr><td>${esc(FLOW[f.kind] ?? f.kind)}</td><td>${f.count}</td><td class="${f.sum < 0 ? 'neg' : 'pos'}">${f.sum > 0 ? '+' : ''}${coins(f.sum)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing moved.</td></tr>'}</tbody></table></div></section>
          <section class="block"><h2>Biggest balances</h2><div class="tablewrap"><table class="grid"><tbody>${e.now.top.map(t => `<tr><td><a href="#/players?id=${esc(t.id)}">${esc(t.name)}</a></td><td>${coins(t.balance)}</td></tr>`).join('') || '<tr><td class="muted">No wallets.</td></tr>'}</tbody></table></div>
            <h2>Biggest wins</h2><div class="tablewrap"><table class="grid"><tbody>${e.big_wins.map(w => `<tr><td>${esc(w.name)}</td><td>${esc(GAME[w.game] ?? w.game)}</td><td class="pos">+${coins(w.payout - w.amount)}</td><td class="muted small">${esc(when(w.at))}</td></tr>`).join('') || '<tr><td class="muted">No wins.</td></tr>'}</tbody></table></div></section></div>`;
    };
    const load = async (): Promise<void> => { try { draw(await c.api.economy(days)); } catch (e) { $('#eBody', el).innerHTML = `<p class="err" role="alert">${esc(errorText(e))}</p>`; } };
    $<HTMLSelectElement>('#eDays', el).onchange = () => { days = Number($<HTMLSelectElement>('#eDays', el).value); void load(); };
    await load();
  },
};

export const INSIGHT_PAGES: Record<string, Page> = { fairness, economy };
