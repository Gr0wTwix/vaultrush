import { standings, msToReset, PRIZES, setRealRace } from '../race.js';
import { dailyRace, dailyRacePrev } from '../backend.js';
import { serverWallet } from '../wallet.js';
import { todayKey, DAY, isAuthed, state } from '../state.js';
import { $, esc, fmt, money, icon, avatar, guestCard } from '../ui.js';
import { races, type Race } from '../events.js';

const pad = n => String(n).padStart(2, '0');
const GAME_NAME: Record<string, string> = { cases: 'Cases', battles: 'Battles', upgrade: 'Upgrade', crash: 'Crash', double: 'Double', plinko: 'Plinko', mines: 'Mines', coinflip: 'Coinflip' };
const timeLeft = (iso: string): string => {
  const ms = Date.parse(iso) - Date.now(); if (ms <= 0) return 'ended';
  const h = Math.floor(ms / 3600000), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h left` : `${h}h ${Math.floor((ms % 3600000) / 60000)}m left`;
};
/** Races run by staff (migration 0024): their own window, prizes and games. Shown under the daily race. */
export function eventRaces(list: Race[]): string {
  if (!list.length) return '';
  const when = (r: Race): string => (r.state === 'upcoming' ? `starts ${new Date(r.starts_at).toLocaleString()}` : r.state === 'running' ? timeLeft(r.ends_at) : r.state === 'paid' ? 'prizes paid' : 'ended, prizes coming');
  return `<div class="panel ev-races"><div class="panel-head"><h2>${icon('race')} Special races</h2></div>${list.map(r => `<section class="ev-race" data-race="${Number(r.id)}">
    <div class="ev-race-head"><div><b>${esc(r.name)}</b><span class="muted small">${esc(when(r))} · ${r.games.length ? esc(r.games.map(g => GAME_NAME[g] ?? g).join(', ')) : 'every game counts'}</span></div>
      <div class="ev-pool"><span class="muted small">Prize pool</span>${money(r.pool)}</div></div>
    <table class="bets"><tbody>${r.top.slice(0, 10).map(t => `<tr class="${isAuthed() && t.name === state.name ? 'mine' : ''}"><td>${t.rank}</td><td class="user-cell">${avatar(t.name, 22)}<span>${esc(t.name)}</span></td><td>${money(t.wagered)}</td><td>${t.prize ? money(t.prize) : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nobody has played yet. Be the first.</td></tr>'}</tbody></table>
    ${r.me && r.me.rank > 10 ? `<p class="muted small">You: #${r.me.rank}, ${fmt(r.me.wagered)} wagered.</p>` : ''}</section>`).join('')}</div>`;
}

export function render(el) {
  let evs: Race[] = [];
  const draw = () => {
    const list = standings();
    const top3 = list.slice(0, 3), rest = list.slice(3, 10), me = list.find(p => p.me);
    const prev = standings(todayKey(Date.now() - DAY), Date.parse(`${todayKey()}T00:00:00Z`) - 1).slice(0, 3);
    el.innerHTML = `
      <div class="page-head"><h1>${icon('trophy')} Daily race</h1><p class="muted">Every coin you wager today counts. The top 10 share a ${fmt(PRIZES.reduce((a, b) => a + b, 0))} coin prize pool when the day ends (00:00 UTC). Prizes are paid the next time you visit.</p></div>
      ${isAuthed() ? '' : guestCard('Sign in to enter today\'s race', 'Every coin you wager today counts. Create a free account to appear on the board.')}
      ${serverWallet() ? '<p class="muted small race-demo">Real players: every coin staked in any game counts.</p>' : '<p class="muted small race-demo"><span class="tag">Demo</span> The other players on this board are simulated.</p>'}
      <section class="race-head panel"><div><span class="muted small">Prize pool</span>${money(PRIZES.reduce((a, b) => a + b, 0), 'big')}</div><div class="countdown" id="cd"></div></section>
      <section class="podium">${[1, 0, 2].map(i => { const p = top3[i]; return p ? `<div class="pod pod-${i + 1} ${p.me ? 'mine' : ''}">${avatar(p.name, 46)}<b>${esc(p.name)}</b><span class="muted small">${money(p.wagered)} wagered</span><div class="pod-prize">${money(p.prize)}</div><div class="pod-rank">${i + 1}</div></div>` : ''; }).join('')}</section>
      <div class="panel"><div class="table-wrap"><table class="bets"><thead><tr><th>#</th><th>Player</th><th>Wagered</th><th>Prize</th></tr></thead><tbody>
        ${rest.map(p => `<tr class="${p.me ? 'mine' : ''}"><td>${p.rank}</td><td class="user-cell">${avatar(p.name, 22)}<span>${esc(p.name)}</span></td><td>${money(p.wagered)}</td><td>${money(p.prize)}</td></tr>`).join('')}
        ${me && me.rank > 10 ? `<tr class="mine"><td>${me.rank}</td><td class="user-cell">${avatar(me.name, 22)}<span>${esc(me.name)} (you)</span></td><td>${money(me.wagered)}</td><td class="muted">wager ${fmt(Math.max(0, list[9].wagered - me.wagered + 0.01))} more for top 10</td></tr>` : ''}
      </tbody></table></div></div>
      <div class="panel"><div class="panel-head"><h2>Yesterday's winners</h2></div><div class="prev-winners">${prev.map(p => `<div class="prev">${avatar(p.name, 30)}<div><b>${esc(p.name)}</b><span class="muted small">#${p.rank} · ${money(p.prize)}</span></div></div>`).join('')}</div></div>${eventRaces(evs)}`;
  };
  const tick = () => {
    const ms = msToReset(), cd = $('#cd', el);
    if (!cd) return;
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
    cd.innerHTML = `<span class="muted small">Ends in</span><b>${pad(h)}<small>h</small> ${pad(m)}<small>m</small> ${pad(s)}<small>s</small></b>`;
  };
  let alive = true;
  const load = async (): Promise<void> => {
    if (!serverWallet()) return;
    try {
      const [today, prev, special] = await Promise.all([dailyRace(), dailyRacePrev(), races()]);
      evs = special;
      setRealRace({ today: today.map(r => ({ name: r.display_name, wagered: r.wagered })), prev: prev.map(r => ({ name: r.display_name, wagered: r.wagered })) });
      if (alive) draw();
    } catch { /* keep showing what we have */ }
  };
  draw(); tick(); void load();
  const t1 = setInterval(tick, 1000), t2 = setInterval(() => { draw(); tick(); void load(); }, 20000);
  return () => { alive = false; clearInterval(t1); clearInterval(t2); };
}
